import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import { MemoryStore, scopeKey } from "../src/core/store.js";
import { createFetchMock, dmUpdate, NOW, postUpdate, testEnv } from "./helpers.js";

function depsWith(options: {
  grokStatus?: number;
  store?: MemoryStore;
  typingStart?: () => Promise<void>;
}) {
  const mock = createFetchMock((call) => {
    if (call.url.startsWith("https://grok.example/hook")) return new Response("down", { status: options.grokStatus ?? 202 });
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  const tasks: Promise<unknown>[] = [];
  const store = options.store ?? new MemoryStore();
  const logs: Record<string, unknown>[] = [];
  const base = buildDeps({
    env: testEnv(),
    store,
    fetchImpl: mock.fetchImpl,
    now: () => NOW,
    waitUntil: (promise) => tasks.push(promise),
    typingMode: "once",
    log: (event) => logs.push(event),
  });
  const deps = options.typingStart
    ? { ...base, typing: { ...base.typing, start: options.typingStart } }
    : base;
  return { deps, tasks, calls: mock.calls, store, logs };
}

describe("when Grok Bot or the store misbehaves", () => {
  it("stops the typing indicator when the forward fails", async () => {
    const app = depsWith({ grokStatus: 503 });
    await postUpdate(app.deps, app.tasks, dmUpdate("hello"));
    expect(app.logs).toContainEqual(expect.objectContaining({ event: "forward", ok: false, status: 503 }));
    expect(await app.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("keeps typing after a successful forward", async () => {
    const app = depsWith({});
    await postUpdate(app.deps, app.tasks, dmUpdate("hello"));
    expect(await app.store.getTyping(scopeKey("42", null))).not.toBeNull();
  });

  it("still forwards when the typing indicator cannot start", async () => {
    const app = depsWith({ typingStart: async () => { throw new Error("durable_object_500"); } });
    await postUpdate(app.deps, app.tasks, dmUpdate("hello"));
    expect(app.calls.some((call) => call.url.startsWith("https://grok.example/hook"))).toBe(true);
  });

  it("returns a generic 500 instead of throwing when the store fails during /send", async () => {
    const store = new MemoryStore();
    const app = depsWith({ store });
    await postUpdate(app.deps, app.tasks, dmUpdate("hello"));
    const token = (app.calls.find((call) => call.url.startsWith("https://grok.example/hook"))?.body as { reply: { token: string } }).reply.token;
    store.isWakeClosed = async () => {
      throw new Error("store_500 at https://secret.example/bot123:abc");
    };
    const response = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", text: "hi" }),
    }), app.deps);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe(JSON.stringify({ ok: false, error: "internal_error" }));
  });
});
