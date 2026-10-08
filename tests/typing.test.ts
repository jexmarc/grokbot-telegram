import { describe, expect, it } from "vitest";
import { MemoryStore, scopeKey } from "../src/core/store.js";
import {
  createStoreTyping,
  DRAFT_REFRESH_MS,
  normalizeScope,
  removeWakes,
  type ProgressEffects,
} from "../src/core/typing.js";
import type { TypingStart } from "../src/core/types.js";

const SCOPE = scopeKey("42", null);
const MIN = 60_000;

function start(wakeId: string, overrides: Partial<TypingStart> = {}): TypingStart {
  return {
    scopeKey: SCOPE,
    chatId: "42",
    threadId: null,
    refreshMs: 3000,
    wakeId,
    messageId: 10,
    reaction: "👀",
    draft: false,
    startedAt: 0,
    leaseMs: 10 * MIN,
    deadline: 30 * MIN,
    ...overrides,
  };
}

function harness(options: { reactionOk?: boolean; store?: MemoryStore; mode?: "interval" | "once" } = {}) {
  const store = options.store ?? new MemoryStore();
  let now = 0;
  const events: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean; cancel(): void }[] = [];
  const effects: ProgressEffects = {
    log: (event) => logs.push(event),
    async typing(chatId) {
      events.push(`typing:${chatId}`);
    },
    async reaction(_chatId, messageId, emoji) {
      events.push(emoji === null ? `clear:${messageId}` : `react:${messageId}:${emoji}`);
      return options.reactionOk ?? true;
    },
    async draft(_chatId, _threadId, draftId) {
      events.push(`draft:${draftId}`);
    },
  };
  const typing = createStoreTyping({
    store,
    mode: options.mode ?? "interval",
    now: () => now,
    effects,
    schedule(fn, ms) {
      const timer = {
        fn,
        ms,
        cancelled: false,
        cancel() {
          timer.cancelled = true;
        },
      };
      timers.push(timer);
      return timer;
    },
  });
  async function tick(at: number): Promise<void> {
    now = at;
    for (const timer of timers.filter((item) => !item.cancelled)) timer.fn();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
  return {
    store,
    typing,
    events,
    logs,
    timers,
    tick,
    setNow(at: number) {
      now = at;
    },
    live: () => timers.filter((timer) => !timer.cancelled),
  };
}

describe("per-wake typing sessions", () => {
  it("keeps one refresher per chat, one action per tick, while any wake is active", async () => {
    const app = harness();
    await app.typing.start(start("a", { messageId: 10 }));
    await app.typing.start(start("b", { messageId: 11 }));
    expect(app.live()).toHaveLength(1);
    expect(app.live()[0]?.ms).toBe(3000);

    app.events.length = 0;
    await app.tick(3000);
    expect(app.events).toEqual(["typing:42"]);

    // Stopping one wake only removes that wake.
    expect(await app.typing.stop(SCOPE, "a")).toEqual({ stopped: true, reason: "stopped" });
    expect(Object.keys((await app.store.getTyping(SCOPE))?.wakes ?? {})).toEqual(["b"]);
    expect(app.live()).toHaveLength(1);
    app.events.length = 0;
    await app.tick(6000);
    expect(app.events).toEqual(["typing:42"]);

    await app.typing.stop(SCOPE, "b");
    expect(app.live()).toHaveLength(0);
    expect(await app.store.getTyping(SCOPE)).toBeNull();
    expect(await app.typing.stop(SCOPE, "b")).toEqual({ stopped: false, reason: "none" });
  });

  it("re-pulses after a stop when other wakes are still working (the final message cleared typing)", async () => {
    const app = harness();
    await app.typing.start(start("a", { messageId: 10 }));
    await app.typing.start(start("b", { messageId: 11 }));
    app.events.length = 0;
    await app.typing.stop(SCOPE, "a");
    expect(app.events).toEqual(["clear:10", "typing:42"]);
    app.events.length = 0;
    await app.typing.stop(SCOPE, "b");
    expect(app.events).toEqual(["clear:11"]);
  });

  it("re-pulses typing immediately on touch, and extends only the touched wake's lease", async () => {
    const app = harness();
    await app.typing.start(start("a"));
    await app.typing.start(start("b", { messageId: 11 }));
    app.events.length = 0;
    app.setNow(9 * MIN);
    expect(await app.typing.touch(SCOPE, "a")).toEqual({ active: true, extended: true });
    expect(app.events).toEqual(["typing:42"]);
    const scope = await app.store.getTyping(SCOPE);
    expect(scope?.wakes.a?.leaseUntil).toBe(19 * MIN);
    expect(scope?.wakes.b?.leaseUntil).toBe(10 * MIN);

    // b's lease runs out at 10 minutes; a keeps typing.
    await app.tick(10 * MIN);
    expect(Object.keys((await app.store.getTyping(SCOPE))?.wakes ?? {})).toEqual(["a"]);
    expect(app.events).toContain("clear:11");
    expect(app.logs).toContainEqual(expect.objectContaining({ event: "typing_lease_expired", wake_id: "b", reason: "lease" }));
  });

  it("never extends a lease past the hard ceiling, and clears the reaction when it is reached", async () => {
    const app = harness();
    await app.typing.start(start("a"));
    for (let minute = 9; minute < 30; minute += 9) {
      app.setNow(minute * MIN);
      await app.typing.touch(SCOPE, "a");
    }
    expect((await app.store.getTyping(SCOPE))?.wakes.a?.leaseUntil).toBe(30 * MIN);
    app.events.length = 0;
    await app.tick(30 * MIN - 1);
    expect(app.events).toEqual(["typing:42"]);
    app.events.length = 0;
    await app.tick(30 * MIN);
    expect(app.events).toEqual(["clear:10"]);
    expect(app.logs).toContainEqual(expect.objectContaining({ event: "typing_lease_expired", wake_id: "a", reason: "ceiling" }));
    expect(app.live()).toHaveLength(0);
    expect(await app.store.getTyping(SCOPE)).toBeNull();
  });

  it("clears the reaction when an untouched lease expires", async () => {
    const app = harness();
    await app.typing.start(start("a"));
    await app.tick(10 * MIN - 1);
    expect(app.events).not.toContain("clear:10");
    await app.tick(10 * MIN);
    expect(app.events).toContain("clear:10");
    expect(await app.typing.touch(SCOPE, "a")).toEqual({ active: false, extended: false });
  });

  it("keeps the reaction with whichever wake on that message is still running", async () => {
    const app = harness();
    await app.typing.start(start("original", { messageId: 10 }));
    // An edit of the same message: joins typing, does not react twice.
    await app.typing.start(start("edit", { messageId: 10 }));
    expect(app.events.filter((event) => event.startsWith("react:"))).toEqual(["react:10:👀"]);
    app.events.length = 0;
    await app.typing.stop(SCOPE, "original");
    expect(app.events).not.toContain("clear:10");
    expect((await app.store.getTyping(SCOPE))?.wakes.edit?.reaction).toBe("👀");
    await app.typing.stop(SCOPE, "edit");
    expect(app.events).toContain("clear:10");
  });

  it("does not try to clear a reaction Telegram refused to set", async () => {
    const app = harness({ reactionOk: false });
    await app.typing.start(start("a"));
    expect((await app.store.getTyping(SCOPE))?.wakes.a?.reaction).toBeNull();
    app.events.length = 0;
    await app.typing.stop(SCOPE, "a");
    expect(app.events).toEqual([]);
  });

  it("sets no reaction when none is configured", async () => {
    const app = harness();
    await app.typing.start(start("a", { reaction: null }));
    expect(app.events).toEqual(["typing:42"]);
  });

  it("re-arms the refresher on touch when the process restarted but the store kept the wake", async () => {
    const store = new MemoryStore();
    const before = harness({ store });
    await before.typing.start(start("a"));
    const after = harness({ store });
    expect(after.live()).toHaveLength(0);
    await after.typing.touch(SCOPE, "a");
    expect(after.live()).toHaveLength(1);
    after.events.length = 0;
    await after.tick(3000);
    expect(after.events).toEqual(["typing:42"]);
  });

  it("never schedules a timer in once mode, and prunes expired wakes on the next start", async () => {
    const app = harness({ mode: "once" });
    await app.typing.start(start("a", { messageId: 10 }));
    expect(app.timers).toHaveLength(0);
    app.setNow(11 * MIN);
    await app.typing.start(start("b", { messageId: 11, startedAt: 11 * MIN, deadline: 41 * MIN }));
    expect(app.events).toContain("clear:10");
    expect(Object.keys((await app.store.getTyping(SCOPE))?.wakes ?? {})).toEqual(["b"]);
  });

  it("refreshes a draft placeholder about every 20 seconds and after a touch", async () => {
    const app = harness();
    await app.typing.start(start("a", { draft: true }));
    expect(app.events).toContain("draft:10");
    app.events.length = 0;
    await app.tick(3000);
    expect(app.events).toEqual(["typing:42"]);
    app.events.length = 0;
    await app.tick(DRAFT_REFRESH_MS);
    expect(app.events).toEqual(["typing:42", "draft:10"]);
    app.events.length = 0;
    app.setNow(DRAFT_REFRESH_MS + 1000);
    await app.typing.touch(SCOPE, "a");
    expect(app.events).toEqual(["typing:42", "draft:10"]);
  });
});

describe("typing scope helpers", () => {
  it("reads a session stored by the previous single-wake version", () => {
    const scope = normalizeScope({
      scopeKey: SCOPE, chatId: "42", threadId: null, wakeId: "old", startedAt: 100, refreshMs: 4000, maxMs: 600_000,
    });
    expect(scope?.wakes.old).toMatchObject({ leaseUntil: 600_100, deadline: 600_100, reaction: null });
    expect(normalizeScope(null)).toBeNull();
    expect(normalizeScope({ wakes: {} })).toBeNull();
  });

  it("hands a reaction to a wake on the same message instead of clearing it", () => {
    const scope = normalizeScope({ scopeKey: SCOPE, chatId: "42", threadId: null, refreshMs: 3000, wakes: {} }) ?? {
      scopeKey: SCOPE, chatId: "42", threadId: null, refreshMs: 3000, wakes: {},
    };
    const wake = { messageId: 10, draft: false, draftAt: null, startedAt: 0, leaseMs: 1, leaseUntil: 1, deadline: 1 };
    const result = removeWakes({
      ...scope,
      wakes: {
        a: { ...wake, wakeId: "a", reaction: "👀" },
        b: { ...wake, wakeId: "b", reaction: null },
        c: { ...wake, wakeId: "c", messageId: 12, reaction: "👀" },
      },
    }, ["a", "c"]);
    expect(result.clear).toEqual([{ chatId: "42", messageId: 12 }]);
    expect(result.scope?.wakes.b?.reaction).toBe("👀");
  });
});
