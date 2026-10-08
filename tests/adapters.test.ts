import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/adapters/cloudflare/session.js";
import { handleDoAlarm, handleDoFetch } from "../src/adapters/cloudflare/do-storage.js";
import type { DoNamespace } from "../src/adapters/cloudflare/backend.js";
import worker, { handleCloudflare } from "../src/adapters/cloudflare/worker.js";
import { nodeRequestToWeb, startNodeServer } from "../src/adapters/node/server.js";
import { resetVercelShared, vercelFetch } from "../src/adapters/vercel/handler.js";
import vercelApi from "../api/index.js";
import { scopeKey } from "../src/core/store.js";
import type { TypingStart } from "../src/core/types.js";
import { createFetchMock, dmUpdate, memoryStorage, testEnv, webhookRequest } from "./helpers.js";

function fakeNamespace(env: Record<string, unknown>): DoNamespace {
  const sessions = new Map<string, ChatSession>();
  return {
    idFromName(name: string) {
      return { toString: () => name };
    },
    get(id) {
      const name = id.toString();
      let session = sessions.get(name);
      if (!session) {
        session = new ChatSession({ storage: memoryStorage() }, env);
        sessions.set(name, session);
      }
      return {
        fetch(input: Request | string | URL, init?: RequestInit) {
          const request = input instanceof Request ? input : new Request(input, init);
          return session.fetch(request);
        },
      };
    },
  };
}

describe("cloudflare adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves health and rejects a webhook when the secret header is wrong", async () => {
    const tasks: Promise<unknown>[] = [];
    const env = { ...testEnv(), CHAT_SESSION: fakeNamespace(testEnv()) };
    const ctx = { waitUntil: (promise: Promise<unknown>) => tasks.push(promise) };
    const health = await worker.fetch(new Request("https://bridge.example/healthz"), env, ctx);
    expect(health.status).toBe(200);
    const denied = await handleCloudflare(webhookRequest(dmUpdate("hi"), "wrong"), env, ctx);
    expect(denied.status).toBe(401);
  });

  it("acks a webhook before the grok forward finishes and dedupes in the durable object", async () => {
    let releaseGrok: () => void = () => undefined;
    const grokGate = new Promise<void>((resolve) => {
      releaseGrok = resolve;
    });
    let grokFinished = false;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://grok.example/hook")) {
        await grokGate;
        grokFinished = true;
        return new Response("accepted", { status: 202 });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    };
    vi.stubGlobal("fetch", fetchImpl);
    const tasks: Promise<unknown>[] = [];
    const env = { ...testEnv(), CHAT_SESSION: fakeNamespace(testEnv()) };
    const ctx = { waitUntil: (promise: Promise<unknown>) => tasks.push(promise) };
    const response = await worker.fetch(webhookRequest(dmUpdate("hi", 4)), env, ctx);
    expect(response.status).toBe(200);
    expect(grokFinished).toBe(false);
    releaseGrok();
    await Promise.all(tasks);
    expect(grokFinished).toBe(true);
    const retry = await worker.fetch(webhookRequest(dmUpdate("hi", 4)), env, ctx);
    await Promise.all(tasks);
    expect(retry.status).toBe(200);
    expect(grokFinished).toBe(true);
  });

  it("keeps typing on an alarm until the wake is stopped or it expires", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (async (input: Request | string | URL) => {
      calls.push(String(input));
      return Response.json({ ok: true, result: true });
    }) as typeof fetch);
    const storage = memoryStorage();
    const env = testEnv();
    const session: TypingStart = {
      scopeKey: scopeKey("-500", 15),
      chatId: "-500",
      threadId: 15,
      refreshMs: 3000,
      wakeId: "wake-a",
      messageId: 31,
      reaction: null,
      draft: false,
      startedAt: Date.now(),
      leaseMs: 600_000,
      deadline: Date.now() + 1_800_000,
    };
    await handleDoFetch(storage, env, new Request("https://do/op", {
      method: "POST",
      body: JSON.stringify({ op: "typing.start", start: session }),
    }));
    expect(calls.some((url) => url.endsWith("/sendChatAction"))).toBe(true);
    expect(storage.alarm).not.toBeNull();
    const started = calls.length;
    await handleDoAlarm(storage, env);
    expect(calls.length).toBeGreaterThan(started);

    const stopped = await handleDoFetch(storage, env, new Request("https://do/op", {
      method: "POST",
      body: JSON.stringify({ op: "typing.stop", scopeKey: session.scopeKey, wakeId: "wake-other" }),
    }));
    expect(await stopped.json()).toMatchObject({ stopped: false, reason: "none" });

    // Past the lease: the next alarm drops the wake without another typing action, and stops the alarm.
    const before = calls.length;
    await handleDoAlarm(storage, env, Date.now() + 600_001);
    expect(calls.slice(before).some((url) => url.endsWith("/sendChatAction"))).toBe(false);
    expect(storage.alarm).toBeNull();
  });

  it("reports that the durable object binding is required", async () => {
    const response = await handleCloudflare(
      webhookRequest(dmUpdate("hi")),
      testEnv(),
      { waitUntil: () => undefined },
    );
    expect(response.status).toBe(503);
  });
});

describe("vercel adapter", () => {
  afterEach(() => {
    resetVercelShared();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("routes webhook and health requests", async () => {
    const mock = createFetchMock();
    const state = {};
    const env = testEnv();
    const health = await vercelFetch(new Request("https://bridge.example/api?path=/healthz"), env, state, mock.fetchImpl);
    expect(health.status).toBe(200);
    const denied = await vercelFetch(
      webhookRequest(dmUpdate("hi"), "wrong", "/api?path=/webhook"),
      env,
      state,
      mock.fetchImpl,
    );
    expect(denied.status).toBe(401);
    const accepted = await vercelFetch(webhookRequest(dmUpdate("hi", 8), undefined, "/api?path=/webhook"), env, state, mock.fetchImpl);
    expect(accepted.status).toBe(200);
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(mock.calls.some((call) => call.url.startsWith("https://grok.example/hook"))).toBe(true);
  });

  it("exposes a fetch handler for the Vercel function file", async () => {
    const response = await vercelApi.fetch(new Request("https://bridge.example/api?path=/webhook", {
      method: "POST",
      body: "{}",
    }));
    expect(response.status).toBe(503);
  });

  it("clears the reaction when the final send reaches the function that took the webhook", async () => {
    const mock = createFetchMock();
    vi.stubGlobal("fetch", mock.fetchImpl);
    for (const [key, value] of Object.entries(testEnv())) vi.stubEnv(key, value);
    const accepted = await vercelApi.fetch(webhookRequest(dmUpdate("hi", 9), undefined, "/api?path=/webhook"));
    expect(accepted.status).toBe(200);
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
    const forwarded = mock.calls.find((call) => call.url.startsWith("https://grok.example/hook"));
    const token = (forwarded?.body as { reply: { token: string } }).reply.token;
    const sent = await vercelApi.fetch(new Request("https://bridge.example/api?path=/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", text: "reply", final: true }),
    }));
    expect(sent.status).toBe(200);
    const reactions = mock.calls
      .filter((call) => call.url.endsWith("/setMessageReaction"))
      .map((call) => call.body);
    expect(reactions).toEqual([
      { chat_id: "42", message_id: 19, reaction: [{ type: "emoji", emoji: "👀" }], is_big: false },
      { chat_id: "42", message_id: 19, reaction: [], is_big: false },
    ]);
  });
});

describe("node adapter", () => {
  it("preserves method, header, and body when converting a node request", async () => {
    const { Readable } = await import("node:stream");
    const req = Readable.from([JSON.stringify({ ok: 1 })]) as unknown as import("node:http").IncomingMessage;
    req.method = "POST";
    req.url = "/webhook";
    req.headers = { host: "bridge.example", "x-telegram-bot-api-secret-token": "sekrit" };
    const request = await nodeRequestToWeb(req);
    expect(request.method).toBe("POST");
    expect(request.headers.get("x-telegram-bot-api-secret-token")).toBe("sekrit");
    expect(await request.json()).toEqual({ ok: 1 });
    expect(request.url).toBe("http://bridge.example/webhook");
  });

  it("serves health, webhook, and send on a real port", async () => {
    const mock = createFetchMock();
    const server = await startNodeServer({
      env: testEnv(),
      port: 0,
      fetchImpl: mock.fetchImpl,
      typingMode: "once",
    });
    try {
      const health = await fetch(`${server.url}/healthz`);
      expect(health.status).toBe(200);
      const denied = await fetch(`${server.url}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "nope" },
        body: JSON.stringify(dmUpdate("hi")),
      });
      expect(denied.status).toBe(401);
      const accepted = await fetch(`${server.url}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "webhook-secret-value",
        },
        body: JSON.stringify(dmUpdate("hi", 6)),
      });
      expect(accepted.status).toBe(200);
      await server.drain();
      const forwarded = mock.calls.find((call) => call.url.startsWith("https://grok.example/hook"));
      const token = (forwarded?.body as { reply: { token: string } }).reply.token;
      const sent = await fetch(`${server.url}/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "42", text: "reply", final: true }),
      });
      expect(sent.status).toBe(200);
      expect(mock.calls.some((call) => String(call.body && (call.body as { text?: string }).text) === "reply")).toBe(true);
    } finally {
      await server.close();
    }
  });
});
