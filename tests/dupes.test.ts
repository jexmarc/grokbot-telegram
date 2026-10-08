import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoNamespace } from "../src/adapters/cloudflare/backend.js";
import { handleDoAlarm } from "../src/adapters/cloudflare/do-storage.js";
import { ChatSession } from "../src/adapters/cloudflare/session.js";
import worker from "../src/adapters/cloudflare/worker.js";
import { buildDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import { MemoryStore, scopeKey, type Store } from "../src/core/store.js";
import type { TelegramUpdate } from "../src/core/types.js";
import {
  createFetchMock,
  defaultResponse,
  dmUpdate,
  groupUpdate,
  memoryStorage,
  NOW,
  postUpdate,
  settle,
  testEnv,
  webhookRequest,
  type RecordedCall,
} from "./helpers.js";

interface Reply {
  token: string;
  wake_id: string;
  chat_id: string;
}

function app(options: {
  store?: Store;
  handler?: (call: RecordedCall) => Response | Promise<Response | undefined> | undefined;
  typingMode?: "interval" | "once";
} = {}) {
  const mock = createFetchMock(async (call) => {
    const custom = await options.handler?.(call);
    return custom ?? defaultResponse(call, mock.calls.length);
  });
  const tasks: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps = buildDeps({
    env: testEnv(),
    ...(options.store ? { store: options.store } : {}),
    fetchImpl: mock.fetchImpl,
    now: () => NOW,
    sleep: async () => undefined,
    waitUntil: (promise) => tasks.push(promise),
    typingMode: options.typingMode ?? "once",
    log: (event) => logs.push(event),
  });
  const calls = mock.calls;
  return {
    deps,
    tasks,
    calls,
    logs,
    forwards: () => calls.filter((call) => call.url.startsWith("https://grok.example/hook")),
    replies: () => calls
      .filter((call) => call.url.startsWith("https://grok.example/hook"))
      .map((call) => (call.body as { reply: Reply }).reply),
    sendMessages: () => calls.filter((call) => call.url.endsWith("/sendMessage")),
    async send(reply: Reply, body: Record<string, unknown>): Promise<Response> {
      return handleRequest(new Request("https://bridge.example/send", {
        method: "POST",
        headers: { authorization: `Bearer ${reply.token}`, "content-type": "application/json" },
        body: JSON.stringify({ chat_id: reply.chat_id, ...body }),
      }), deps);
    },
  };
}

function mention(text: string, updateId: number, edited = false): TelegramUpdate {
  return groupUpdate({ text, updateId, edited, entities: text.startsWith("@testbot") ? [{ type: "mention", offset: 0, length: 8 }] : [] });
}

/** The same Telegram message (id 31 in chat -500), delivered under another update_id. */
function sameGroupMessage(update: TelegramUpdate, updateId: number, edited: boolean): TelegramUpdate {
  const message = { ...(update.message ?? update.edited_message)!, message_id: 31 };
  return edited ? { update_id: updateId, edited_message: message } : { update_id: updateId, message };
}

describe("one Telegram message starts at most one wake", () => {
  it("forwards once when Telegram redelivers the same update concurrently", async () => {
    const bridge = app();
    const responses = await Promise.all([1, 2, 3].map(() => handleRequest(webhookRequest(dmUpdate("hello", 1)), bridge.deps)));
    await settle(bridge.tasks);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(bridge.forwards()).toHaveLength(1);
  });

  it("forwards once when the same message arrives under a different update_id", async () => {
    const bridge = app();
    const first = dmUpdate("hello", 1);
    const again = { update_id: 7, message: first.message };
    await Promise.all([
      handleRequest(webhookRequest(first), bridge.deps),
      handleRequest(webhookRequest(again), bridge.deps),
    ]);
    await settle(bridge.tasks);
    expect(bridge.forwards()).toHaveLength(1);
    expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "update_dropped", reason: "duplicate_message", message_id: 11 }));
  });

  it("keeps the same message id in different chats apart", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    const other = mention("@testbot hello", 2);
    await postUpdate(bridge.deps, bridge.tasks, { update_id: 2, message: { ...other.message!, message_id: 11 } });
    expect(bridge.forwards()).toHaveLength(2);
  });
});

describe("edited messages", () => {
  it("ignores an edit of a message that already woke the bot, and leaves the running wake alone", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("whats 2+2", 1));
    const editedMessage = { ...dmUpdate("what's 2+3", 2).message!, message_id: 11, edit_date: 1_700_000_100 };
    await postUpdate(bridge.deps, bridge.tasks, { update_id: 2, edited_message: editedMessage });

    expect(bridge.forwards()).toHaveLength(1);
    expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "edit_ignored", update_id: 2, message_id: 11 }));
    const original = bridge.replies()[0]!;
    expect(Object.keys((await bridge.deps.store.getTyping(scopeKey("42", null)))?.wakes ?? {})).toEqual([original.wake_id]);
    expect(bridge.calls.filter((call) => call.url.endsWith("/setMessageReaction"))).toHaveLength(1);

    const final = await bridge.send(original, { text: "4", final: true });
    expect(final.status).toBe(200);
    expect(bridge.sendMessages()).toHaveLength(1);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("lets an edit wake the bot once when the original never did", async () => {
    const bridge = app();
    // Plain group chatter: stored as context, no wake.
    await postUpdate(bridge.deps, bridge.tasks, sameGroupMessage(mention("what is 2+2", 1), 1, false));
    expect(bridge.forwards()).toHaveLength(0);

    // The person edits in a mention: one wake, marked edited.
    await postUpdate(bridge.deps, bridge.tasks, sameGroupMessage(mention("@testbot what is 2+2", 2), 2, true));
    expect(bridge.forwards()).toHaveLength(1);
    expect((bridge.forwards()[0]!.body as { edited: boolean; message: { message_id: number } }))
      .toMatchObject({ edited: true, message: { message_id: 31 } });

    // Editing it again, or Telegram redelivering the edit, does not wake it a second time.
    await postUpdate(bridge.deps, bridge.tasks, sameGroupMessage(mention("@testbot what is 2+3", 3), 3, true));
    await postUpdate(bridge.deps, bridge.tasks, sameGroupMessage(mention("@testbot what is 2+2", 2), 2, true));
    expect(bridge.forwards()).toHaveLength(1);
    expect(bridge.logs.filter((entry) => entry.event === "edit_ignored")).toHaveLength(1);
  });
});

/**
 * A Durable Object handles one event at a time while it waits on its own
 * storage (input gates). This fake serializes requests per object to match,
 * and keeps storage per object name so a "restart" can reuse it.
 */
function durableNamespace(env: Record<string, unknown>, storages = new Map<string, ReturnType<typeof memoryStorage>>()) {
  const sessions = new Map<string, { session: ChatSession; queue: Promise<unknown> }>();
  const namespace: DoNamespace = {
    idFromName: (name) => ({ toString: () => name }),
    get(id) {
      const name = id.toString();
      let entry = sessions.get(name);
      if (!entry) {
        let storage = storages.get(name);
        if (!storage) {
          storage = memoryStorage();
          storages.set(name, storage);
        }
        entry = { session: new ChatSession({ storage }, env), queue: Promise.resolve() };
        sessions.set(name, entry);
      }
      const current = entry;
      return {
        fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          const result = current.queue.then(() => current.session.fetch(request));
          current.queue = result.catch(() => undefined);
          return result;
        },
      };
    },
  };
  return { namespace, storages };
}

describe("cloudflare durable dedupe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards once under concurrent redelivery, and never again after a restart or an alarm", async () => {
    const mock = createFetchMock();
    vi.stubGlobal("fetch", mock.fetchImpl);
    const forwards = () => mock.calls.filter((call) => call.url.startsWith("https://grok.example/hook"));
    const tasks: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => tasks.push(promise) };
    const first = durableNamespace(testEnv());
    const env = { ...testEnv(), CHAT_SESSION: first.namespace };

    const update = dmUpdate("hello", 4);
    await Promise.all([
      worker.fetch(webhookRequest(update), env, ctx),
      worker.fetch(webhookRequest(update), env, ctx),
      worker.fetch(webhookRequest({ update_id: 5, message: update.message }), env, ctx),
    ]);
    await settle(tasks);
    expect(forwards()).toHaveLength(1);

    // Isolate eviction: new objects over the same durable storage.
    const restarted = durableNamespace(testEnv(), first.storages);
    const env2 = { ...testEnv(), CHAT_SESSION: restarted.namespace };
    await worker.fetch(webhookRequest(update), env2, ctx);
    const edit = { update_id: 6, edited_message: { ...update.message!, text: "hello again" } };
    await worker.fetch(webhookRequest(edit), env2, ctx);
    await settle(tasks);
    expect(forwards()).toHaveLength(1);

    // The rehydrated typing alarm only pulses typing.
    const chatStorage = first.storages.get("chat:42")!;
    await handleDoAlarm(chatStorage, testEnv());
    expect(forwards()).toHaveLength(1);
    expect(mock.calls.some((call) => call.url.endsWith("/sendChatAction"))).toBe(true);
  });
});

describe("restart and rehydration", () => {
  it("a fresh process over the same durable store never re-forwards", async () => {
    const store = new MemoryStore();
    const before = app({ store, typingMode: "interval" });
    await postUpdate(before.deps, before.tasks, dmUpdate("hello", 1));
    expect(before.forwards()).toHaveLength(1);
    const reply = before.replies()[0]!;

    // A new process: its own typing controller, rehydrating from the shared store.
    const after = app({ store, typingMode: "interval" });
    await postUpdate(after.deps, after.tasks, dmUpdate("hello", 1));
    expect((await after.send(reply, { text: "Working on it, about a minute." })).status).toBe(200);
    expect((await after.send(reply, { text: "Hi.", final: true })).status).toBe(200);
    expect(after.forwards()).toHaveLength(0);
    expect(await store.getTyping(scopeKey("42", null))).toBeNull();
  });
});

describe("/send idempotency", () => {
  async function woken(options: Parameters<typeof app>[0] = {}) {
    const bridge = app(options);
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    return { bridge, reply: bridge.replies()[0]! };
  }

  it("answers a second final for a delivered wake with already_sent, without resending", async () => {
    const { bridge, reply } = await woken();
    const first = await bridge.send(reply, { text: "Hi.", final: true });
    const firstBody = await first.json() as { message_ids: number[] };
    expect(first.status).toBe(200);

    const second = await bridge.send(reply, { text: "Hi.", final: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, already_sent: true, message_ids: firstBody.message_ids });
    expect(bridge.sendMessages()).toHaveLength(1);

    // A new progress line on the closed wake is still refused.
    const late = await bridge.send(reply, { text: "one more thing" });
    expect(late.status).toBe(401);
    expect(await late.json()).toMatchObject({ error: "wake_closed" });
    expect(bridge.sendMessages()).toHaveLength(1);
  });

  it("remembers a delivered final across a restart over the same store", async () => {
    const store = new MemoryStore();
    const { bridge, reply } = await woken({ store });
    expect((await bridge.send(reply, { text: "Hi.", final: true })).status).toBe(200);
    const after = app({ store });
    const again = await after.send(reply, { text: "Hi.", final: true });
    expect(await again.json()).toMatchObject({ ok: true, already_sent: true });
    expect(after.sendMessages()).toHaveLength(0);
  });

  it("sends once when two finals for one wake race", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bridge, reply } = await woken({
      handler: async (call) => {
        if (call.url.endsWith("/sendMessage")) await gate;
        return undefined;
      },
    });
    // The first send is held inside Telegram while the second arrives.
    const first = bridge.send(reply, { text: "Hi.", final: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await bridge.send(reply, { text: "Hi.", final: true });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, ambiguous: true, error: "send_in_progress" });
    release();
    expect((await first).status).toBe(200);
    expect(bridge.sendMessages()).toHaveLength(1);
  });

  const ambiguousTelegram: [string, () => Response][] = [
    ["a timeout", () => { throw new DOMException("timed out", "TimeoutError"); }],
    ["a 502", () => Response.json({ ok: false, error_code: 502, description: "Bad Gateway" }, { status: 502 })],
    ["an unreadable 200", () => new Response("<html>", { status: 200 })],
  ];
  for (const [label, telegram] of ambiguousTelegram) {
    it(`reports ${label} from Telegram as ambiguous and never sends it again`, async () => {
      let failSends = false;
      const { bridge, reply } = await woken({
        handler: (call) => failSends && call.url.endsWith("/sendMessage") ? telegram() : undefined,
      });
      failSends = true;
      const first = await bridge.send(reply, { text: "Hi.", final: true });
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({ ok: false, ambiguous: true, error: "telegram_send_ambiguous", sent_parts: 0 });
      expect(bridge.sendMessages()).toHaveLength(1);
      expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "send_ambiguous" }));

      failSends = false;
      const retry = await bridge.send(reply, { text: "Hi.", final: true });
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({ ok: false, ambiguous: true, error: "previous_send_ambiguous" });
      expect(bridge.sendMessages()).toHaveLength(1);
    });
  }

  it("frees the final after a definite Telegram failure so it can be sent once", async () => {
    let reject = false;
    const { bridge, reply } = await woken({
      handler: (call) => reject && call.url.endsWith("/sendMessage")
        ? Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 })
        : undefined,
    });
    reject = true;
    const failed = await bridge.send(reply, { text: "Hi.", final: true });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false, ambiguous: false, error: "telegram_send_failed" });
    reject = false;
    expect((await bridge.send(reply, { text: "Hi.", final: true })).status).toBe(200);
    expect(await (await bridge.send(reply, { text: "Hi.", final: true })).json()).toMatchObject({ already_sent: true });
    expect(bridge.sendMessages()).toHaveLength(2);
  });

  it("dedupes progress lines that carry an idempotency_key", async () => {
    const { bridge, reply } = await woken();
    const line = { text: "Pulling the numbers, about two minutes.", idempotency_key: "progress-1" };
    const first = await bridge.send(reply, line);
    const ids = (await first.json() as { message_ids: number[] }).message_ids;
    const again = await bridge.send(reply, line);
    expect(await again.json()).toEqual({ ok: true, already_sent: true, message_ids: ids });
    expect(bridge.sendMessages()).toHaveLength(1);

    // Another key, or none, is a new message.
    expect((await bridge.send(reply, { text: "Still going.", idempotency_key: "progress-2" })).status).toBe(200);
    expect(bridge.sendMessages()).toHaveLength(2);

    // Still answered after the final closed the wake.
    expect((await bridge.send(reply, { text: "Done.", final: true })).status).toBe(200);
    expect(await (await bridge.send(reply, line)).json()).toMatchObject({ already_sent: true, message_ids: ids });
    expect(bridge.sendMessages()).toHaveLength(3);
  });

  it("rejects a malformed idempotency_key before sending", async () => {
    const { bridge, reply } = await woken();
    for (const key of ["", "has space", 7, "x".repeat(129)]) {
      const response = await bridge.send(reply, { text: "Hi.", idempotency_key: key });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "bad_idempotency_key" });
    }
    expect(bridge.sendMessages()).toHaveLength(0);
  });
});

describe("reply guidance", () => {
  const read = async (path: string) => (await import("node:fs")).readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("tells the assistant to send once and to treat an ambiguous result as sent", async () => {
    const reply = await read(".grok/skills/telegram-reply/SKILL.md");
    const connect = await read(".grok/skills/telegram-connect/SKILL.md");
    for (const text of [reply, connect]) {
      expect(text).toMatch(/Send the final answer exactly once/);
      expect(text).toMatch(/Answer each `?reply\.wake_id`? once/);
      expect(text).toMatch(/After an ambiguous result, treat the message as sent/);
      expect(text).toMatch(/already_sent/);
      expect(text).toMatch(/Repeat a final at most once/);
    }
    expect(reply).not.toMatch(/forwarded as a correction/);
  });
});
