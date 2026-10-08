import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/adapters/cloudflare/session.js";
import { scopeKey } from "../src/core/store.js";
import type { TypingStart } from "../src/core/types.js";
import { memoryStorage, testEnv } from "./helpers.js";

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

function stubTelegram(): TelegramCall[] {
  const calls: TelegramCall[] = [];
  vi.stubGlobal("fetch", (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: url.slice(url.lastIndexOf("/") + 1), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return Response.json({ ok: true, result: true });
  }) as typeof fetch);
  return calls;
}

async function op(session: ChatSession, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await session.fetch(new Request("https://session.internal/op", { method: "POST", body: JSON.stringify(body) }));
  return await response.json() as Record<string, unknown>;
}

const T0 = 1_700_000_000_000;
const SCOPE = scopeKey("-500", null);

function start(wakeId: string, messageId: number): TypingStart {
  return {
    scopeKey: SCOPE,
    chatId: "-500",
    threadId: null,
    refreshMs: 3000,
    wakeId,
    messageId,
    reaction: "👀",
    draft: false,
    startedAt: T0,
    leaseMs: 600_000,
    deadline: T0 + 1_800_000,
  };
}

describe("durable object typing sessions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("persists wakes, leases and reaction targets so a fresh instance keeps typing and clears the right reaction", async () => {
    const calls = stubTelegram();
    const storage = memoryStorage();
    const env = testEnv();
    const first = new ChatSession({ storage }, env);
    await op(first, { op: "typing.start", start: start("a", 31), now: T0 });
    await op(first, { op: "typing.start", start: start("b", 32), now: T0 });
    expect(calls.filter((call) => call.method === "setMessageReaction")).toHaveLength(2);
    expect(storage.alarm).toBe(T0 + 3000);

    // The isolate is evicted. A new instance on the same storage takes over when the alarm fires.
    const second = new ChatSession({ storage }, env);
    calls.length = 0;
    vi.setSystemTime(T0 + 3000);
    await second.alarm();
    expect(calls.map((call) => call.method)).toEqual(["sendChatAction"]);
    expect(calls[0]?.body).toEqual({ chat_id: "-500", action: "typing" });
    expect(storage.alarm).toBe(T0 + 6000);

    // An interim send renews a's lease from the stored state.
    expect(await op(second, { op: "typing.touch", scopeKey: SCOPE, wakeId: "a", now: T0 + 540_000 }))
      .toEqual({ active: true, extended: true });
    const stored = await op(second, { op: "typing.get", scopeKey: SCOPE });
    const wakes = (stored.scope as { wakes: Record<string, { leaseUntil: number; reaction: string | null }> }).wakes;
    expect(wakes.a?.leaseUntil).toBe(T0 + 1_140_000);
    expect(wakes.b?.leaseUntil).toBe(T0 + 600_000);

    // b's lease runs out: its reaction is cleared, a keeps typing.
    calls.length = 0;
    vi.setSystemTime(T0 + 600_000);
    await second.alarm();
    expect(calls.map((call) => [call.method, call.body.message_id ?? null])).toEqual([
      ["setMessageReaction", 32],
      ["sendChatAction", null],
    ]);
    expect(calls[0]?.body.reaction).toEqual([]);

    // a's final answer ends the last wake: reaction cleared, alarm removed.
    calls.length = 0;
    expect(await op(second, { op: "typing.stop", scopeKey: SCOPE, wakeId: "a" })).toEqual({ stopped: true, reason: "stopped" });
    expect(calls.map((call) => [call.method, call.body.message_id ?? null])).toEqual([["setMessageReaction", 31]]);
    expect(storage.alarm).toBeNull();
    expect(await op(second, { op: "typing.get", scopeKey: SCOPE })).toEqual({ scope: null });
  });

  it("re-arms a lost alarm on the next interim send", async () => {
    stubTelegram();
    const storage = memoryStorage();
    const session = new ChatSession({ storage }, testEnv());
    await op(session, { op: "typing.start", start: start("a", 31), now: T0 });
    storage.alarm = null;
    await op(session, { op: "typing.touch", scopeKey: SCOPE, wakeId: "a", now: T0 + 1000 });
    expect(storage.alarm).toBe(T0 + 4000);
  });

  it("upgrades a session stored by the previous version and lets it expire normally", async () => {
    const calls = stubTelegram();
    const storage = memoryStorage();
    await storage.put("typing", {
      [SCOPE]: { scopeKey: SCOPE, chatId: "-500", threadId: null, wakeId: "old", startedAt: T0, refreshMs: 4000, maxMs: 600_000 },
    });
    const session = new ChatSession({ storage }, testEnv());
    vi.setSystemTime(T0 + 4000);
    await session.alarm();
    expect(calls.map((call) => call.method)).toEqual(["sendChatAction"]);
    calls.length = 0;
    vi.setSystemTime(T0 + 600_000);
    await session.alarm();
    expect(calls).toEqual([]);
    expect(storage.alarm).toBeNull();
  });
});
