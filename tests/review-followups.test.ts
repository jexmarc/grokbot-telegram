import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDoAlarm, handleDoFetch } from "../src/adapters/cloudflare/do-storage.js";
import { fatalConfigProblems, loadConfig } from "../src/core/config.js";
import { buildDeps } from "../src/core/deps.js";
import { MemoryStore, scopeKey } from "../src/core/store.js";
import { cleanText } from "../src/core/text.js";
import type { ContextMessage, TypingStart, WakeEvent } from "../src/core/types.js";
import { createFetchMock, dmUpdate, memoryStorage, NOW, postUpdate, testEnv } from "./helpers.js";

async function op(storage: ReturnType<typeof memoryStorage>, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await handleDoFetch(storage, testEnv(), new Request("https://do/op", { method: "POST", body: JSON.stringify(body) }));
  return await response.json() as Record<string, unknown>;
}

describe("durable object typing alarm", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not resurrect a session stopped while the alarm was sending", async () => {
    const storage = memoryStorage();
    const session: TypingStart = {
      scopeKey: scopeKey("42", null), chatId: "42", threadId: null, refreshMs: 3000, wakeId: "wake-a",
      messageId: 11, reaction: null, draft: false, startedAt: Date.now(), leaseMs: 600_000, deadline: Date.now() + 600_000,
    };
    vi.stubGlobal("fetch", (async () => Response.json({ ok: true, result: true })) as typeof fetch);
    await op(storage, { op: "typing.start", start: session });
    // During the alarm's sendChatAction, the final /send stops wake-a.
    vi.stubGlobal("fetch", (async () => {
      await op(storage, { op: "typing.stop", scopeKey: session.scopeKey, wakeId: "wake-a" });
      return Response.json({ ok: true, result: true });
    }) as typeof fetch);
    await handleDoAlarm(storage, testEnv());
    expect(await op(storage, { op: "typing.get", scopeKey: session.scopeKey })).toEqual({ scope: null });
  });
});

describe("startup checks", () => {
  it("treats a missing reply secret or public base url as fatal for a long-running process", () => {
    expect(fatalConfigProblems(loadConfig(testEnv({ REPLY_TOKEN_SECRET: "short", PUBLIC_BASE_URL: "" }))))
      .toEqual(["REPLY_TOKEN_SECRET", "PUBLIC_BASE_URL"]);
  });
});

describe("context on retries and from older versions", () => {
  it("does not list the current message as prior context when Telegram retries it", async () => {
    const store = new MemoryStore();
    const mock = createFetchMock();
    const tasks: Promise<unknown>[] = [];
    let failOnce = true;
    const realHit = store.hitRate.bind(store);
    store.hitRate = async (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("store down");
      }
      return realHit(...args);
    };
    const deps = buildDeps({
      env: testEnv(), store, fetchImpl: mock.fetchImpl, now: () => NOW,
      waitUntil: (promise) => tasks.push(promise), typingMode: "once", log: () => undefined,
    });
    const first = await postUpdate(deps, tasks, dmUpdate("hello", 5));
    expect(first.status).toBe(500);
    const retry = await postUpdate(deps, tasks, dmUpdate("hello", 5));
    expect(retry.status).toBe(200);
    const wake = mock.calls.find((call) => call.url.startsWith("https://grok.example/hook"))?.body as WakeEvent;
    expect(wake.short_term).toEqual([]);
  });

  it("re-cleans context stored before sanitizing existed", async () => {
    const store = new MemoryStore();
    const legacy: ContextMessage = {
      message_id: 1, text: `x‮y${"z".repeat(3000)}`, date: 1_700_000_000, message_thread_id: null,
      from: { id: "7", username: null, first_name: "A\u0007B", last_name: null, is_bot: false },
    };
    await store.pushContext(scopeKey("42", null), legacy, 10);
    const mock = createFetchMock();
    const tasks: Promise<unknown>[] = [];
    const deps = buildDeps({
      env: testEnv(), store, fetchImpl: mock.fetchImpl, now: () => NOW,
      waitUntil: (promise) => tasks.push(promise), typingMode: "once", log: () => undefined,
    });
    await postUpdate(deps, tasks, dmUpdate("hello", 6));
    const wake = mock.calls.find((call) => call.url.startsWith("https://grok.example/hook"))?.body as WakeEvent;
    expect(wake.short_term[0]?.text.startsWith("xyz")).toBe(true);
    expect(wake.short_term[0]?.text.length).toBe(1000);
    expect(wake.short_term[0]?.from?.first_name).toBe("AB");
  });
});

describe("invisible characters", () => {
  it("strips tag characters, zero-width space, and the Arabic letter mark but keeps ZWJ emoji", () => {
    const hidden = "hi\u{E0049}\u{E0047}​there؜";
    expect(cleanText(hidden)).toBe("hithere");
    const family = "👩‍👩‍👧";
    expect(cleanText(family)).toBe(family);
  });
});
