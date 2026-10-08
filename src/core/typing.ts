import { safeErrorMessage, type Logger } from "./log.js";
import type { Store } from "./store.js";
import type { TelegramClient } from "./telegram.js";
import type { TypingScope, TypingStart, TypingWake } from "./types.js";

/** sendMessageDraft is "a temporary 30-second preview", so re-send well inside that. */
export const DRAFT_REFRESH_MS = 20_000;

export type TypingStopReason = "stopped" | "none";

export interface TypingController {
  /** Add a wake to its chat (and topic), set its reaction, and send one typing action. */
  start(input: TypingStart): Promise<void>;
  /** End one wake: clear its reaction. Other wakes in the scope keep typing. */
  stop(scopeKey: string, wakeId: string): Promise<{ stopped: boolean; reason: TypingStopReason }>;
  /**
   * After a bot message (which clears typing on Telegram clients): renew the
   * wake's lease when `wakeId` is given, and re-pulse typing right away.
   */
  touch(scopeKey: string, wakeId: string | null): Promise<{ active: boolean; extended: boolean }>;
}

/** Telegram side effects. Implementations log and swallow failures; none of them throws. */
export interface ProgressEffects {
  typing(chatId: string, threadId: number | null): Promise<void>;
  /** Set `emoji`, or clear the bot's reaction when `emoji` is null. Returns whether Telegram accepted it. */
  reaction(chatId: string, messageId: number, emoji: string | null): Promise<boolean>;
  draft(chatId: string, threadId: number | null, draftId: number): Promise<void>;
  log: Logger;
}

export interface ScopeStore {
  get(scopeKey: string): Promise<unknown>;
  set(scopeKey: string, scope: TypingScope | null): Promise<void>;
}

export function telegramEffects(telegram: TelegramClient, log: Logger): ProgressEffects {
  return {
    log,
    async typing(chatId, threadId) {
      let ok = false;
      try {
        ok = await telegram.sendChatAction({
          chat_id: chatId,
          ...(threadId !== null ? { message_thread_id: threadId } : {}),
        });
      } catch {
        ok = false;
      }
      log({ event: ok ? "typing_refresh" : "typing_failed", chat_id: chatId });
    },
    async reaction(chatId, messageId, emoji) {
      try {
        const result = await telegram.setMessageReaction({ chat_id: chatId, message_id: messageId, emoji });
        if (result.ok) {
          log({ event: emoji === null ? "reaction_cleared" : "reaction_set", chat_id: chatId, message_id: messageId });
          return true;
        }
        // Reactions can be off in a chat, or restricted to a set without this emoji. Carry on without one.
        log({
          event: emoji === null ? "reaction_clear_failed" : "reaction_failed",
          chat_id: chatId,
          message_id: messageId,
          status: result.status,
          description: result.description,
        });
      } catch (err) {
        log({ event: "reaction_failed", chat_id: chatId, error: safeErrorMessage(err, []) });
      }
      return false;
    },
    async draft(chatId, threadId, draftId) {
      try {
        const result = await telegram.sendMessageDraft({
          chat_id: chatId,
          draft_id: draftId,
          ...(threadId !== null ? { message_thread_id: threadId } : {}),
        });
        if (!result.ok) {
          log({ event: "draft_failed", chat_id: chatId, status: result.status, description: result.description });
        }
      } catch (err) {
        log({ event: "draft_failed", chat_id: chatId, error: safeErrorMessage(err, []) });
      }
    },
  };
}

/** Read a stored scope, including the one-session-per-scope shape written by earlier versions. */
export function normalizeScope(value: unknown): TypingScope | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.wakes && typeof record.wakes === "object") {
    const scope = value as TypingScope;
    return Object.keys(scope.wakes).length > 0 ? scope : null;
  }
  if (typeof record.wakeId === "string" && typeof record.startedAt === "number") {
    const maxMs = typeof record.maxMs === "number" ? record.maxMs : 600_000;
    const end = record.startedAt + maxMs;
    return {
      scopeKey: String(record.scopeKey ?? ""),
      chatId: String(record.chatId ?? ""),
      threadId: typeof record.threadId === "number" ? record.threadId : null,
      refreshMs: typeof record.refreshMs === "number" ? record.refreshMs : 3000,
      wakes: {
        [record.wakeId]: {
          wakeId: record.wakeId,
          messageId: null,
          reaction: null,
          draft: false,
          draftAt: null,
          startedAt: record.startedAt,
          leaseMs: maxMs,
          leaseUntil: end,
          deadline: end,
        },
      },
    };
  }
  return null;
}

export function isLive(wake: TypingWake, now: number): boolean {
  return now < wake.leaseUntil && now < wake.deadline;
}

export function expiredWakeIds(scope: TypingScope, now: number): string[] {
  return Object.values(scope.wakes).filter((wake) => !isLive(wake, now)).map((wake) => wake.wakeId);
}

/** Latest instant any wake in the scope could still be running. */
export function scopeDeadline(scope: TypingScope): number {
  return Math.max(0, ...Object.values(scope.wakes).map((wake) => wake.deadline));
}

export interface ReactionClear {
  chatId: string;
  messageId: number;
}

/**
 * Remove wakes from a scope. A removed wake's reaction passes to another
 * remaining wake on the same message (an edit of a message still being worked
 * on) instead of being cleared; otherwise it is returned in `clear`.
 */
export function removeWakes(
  scope: TypingScope,
  wakeIds: readonly string[],
): { scope: TypingScope | null; removed: TypingWake[]; clear: ReactionClear[] } {
  const wakes: Record<string, TypingWake> = { ...scope.wakes };
  const removed: TypingWake[] = [];
  for (const id of wakeIds) {
    const wake = wakes[id];
    if (!wake) continue;
    removed.push(wake);
    delete wakes[id];
  }
  const clear: ReactionClear[] = [];
  for (const wake of removed) {
    if (wake.reaction === null || wake.messageId === null) continue;
    const heir = Object.values(wakes).find((other) => other.messageId === wake.messageId && other.reaction === null);
    if (heir) wakes[heir.wakeId] = { ...heir, reaction: wake.reaction };
    else clear.push({ chatId: scope.chatId, messageId: wake.messageId });
  }
  return {
    scope: Object.keys(wakes).length > 0 ? { ...scope, wakes } : null,
    removed,
    clear,
  };
}

function draftId(wake: TypingWake): number {
  // Must be non-zero. The user's message id is, and edits of it reuse the same draft.
  return wake.messageId !== null && wake.messageId > 0 ? wake.messageId : 1;
}

async function finishRemoved(
  effects: ProgressEffects,
  scope: TypingScope,
  removed: TypingWake[],
  clear: ReactionClear[],
  now: number,
): Promise<void> {
  for (const wake of removed) {
    effects.log({
      event: "typing_lease_expired",
      chat_id: scope.chatId,
      wake_id: wake.wakeId,
      reason: now >= wake.deadline ? "ceiling" : "lease",
    });
  }
  for (const item of clear) await effects.reaction(item.chatId, item.messageId, null);
}

export async function startWake(
  store: ScopeStore,
  effects: ProgressEffects,
  input: TypingStart,
  now: number,
): Promise<void> {
  const before = normalizeScope(await store.get(input.scopeKey));
  let reaction: string | null = null;
  if (input.reaction && input.messageId !== null) {
    // An edit of a message that another wake already reacted to: that wake keeps the reaction,
    // and hands it over here if it finishes first.
    const owned = before !== null && Object.values(before.wakes).some((wake) =>
      wake.messageId === input.messageId && wake.reaction !== null);
    if (!owned && await effects.reaction(input.chatId, input.messageId, input.reaction)) reaction = input.reaction;
  }
  const wake: TypingWake = {
    wakeId: input.wakeId,
    messageId: input.messageId,
    reaction,
    draft: input.draft,
    draftAt: input.draft ? now : null,
    startedAt: input.startedAt,
    leaseMs: input.leaseMs,
    leaseUntil: Math.min(input.startedAt + input.leaseMs, input.deadline),
    deadline: input.deadline,
  };
  // Re-read: a stop or another start may have run while the reaction call was in flight.
  const current = normalizeScope(await store.get(input.scopeKey));
  const base: TypingScope = current
    ? { ...current, refreshMs: input.refreshMs }
    : { scopeKey: input.scopeKey, chatId: input.chatId, threadId: input.threadId, refreshMs: input.refreshMs, wakes: {} };
  const withWake: TypingScope = { ...base, wakes: { ...base.wakes, [wake.wakeId]: wake } };
  // Nothing ticks in "once" mode, so this is also where expired wakes get cleaned up there.
  const pruned = removeWakes(withWake, expiredWakeIds(withWake, now));
  await store.set(input.scopeKey, pruned.scope);
  await finishRemoved(effects, withWake, pruned.removed, pruned.clear, now);
  await effects.typing(input.chatId, input.threadId);
  if (wake.draft) await effects.draft(input.chatId, input.threadId, draftId(wake));
}

export async function stopWake(
  store: ScopeStore,
  effects: ProgressEffects,
  scopeKey: string,
  wakeId: string,
): Promise<{ stopped: boolean; reason: TypingStopReason; remaining: boolean }> {
  const current = normalizeScope(await store.get(scopeKey));
  if (!current || !current.wakes[wakeId]) return { stopped: false, reason: "none", remaining: current !== null };
  const result = removeWakes(current, [wakeId]);
  await store.set(scopeKey, result.scope);
  for (const item of result.clear) await effects.reaction(item.chatId, item.messageId, null);
  // A final message just cleared typing on the clients; the other wakes are still working.
  if (result.scope) await effects.typing(current.chatId, current.threadId);
  return { stopped: true, reason: "stopped", remaining: result.scope !== null };
}

export async function touchWake(
  store: ScopeStore,
  effects: ProgressEffects,
  scopeKey: string,
  wakeId: string | null,
  now: number,
): Promise<{ active: boolean; extended: boolean; refreshMs: number }> {
  const current = normalizeScope(await store.get(scopeKey));
  if (!current) return { active: false, extended: false, refreshMs: 0 };
  const pruned = removeWakes(current, expiredWakeIds(current, now));
  let scope = pruned.scope;
  let extended = false;
  if (scope && wakeId && scope.wakes[wakeId]) {
    const wake = scope.wakes[wakeId];
    scope = { ...scope, wakes: { ...scope.wakes, [wakeId]: { ...wake, leaseUntil: Math.min(now + wake.leaseMs, wake.deadline) } } };
    extended = true;
  }
  // The bot's message also removed any draft placeholder; put it back.
  const drafts = scope ? Object.values(scope.wakes).filter((wake) => wake.draft) : [];
  if (scope && drafts.length > 0) scope = markDrafts(scope, drafts, now);
  if (extended || drafts.length > 0 || pruned.removed.length > 0) await store.set(scopeKey, scope);
  await finishRemoved(effects, current, pruned.removed, pruned.clear, now);
  if (scope) {
    await effects.typing(scope.chatId, scope.threadId);
    for (const wake of drafts) await effects.draft(scope.chatId, scope.threadId, draftId(wake));
  }
  return { active: scope !== null, extended, refreshMs: scope?.refreshMs ?? 0 };
}

/** One refresh: expire wakes past their lease or ceiling, then one typing action for the whole scope. */
export async function tickScope(
  store: ScopeStore,
  effects: ProgressEffects,
  scopeKey: string,
  now: number,
): Promise<TypingScope | null> {
  const current = normalizeScope(await store.get(scopeKey));
  if (!current) return null;
  const pruned = removeWakes(current, expiredWakeIds(current, now));
  let scope = pruned.scope;
  const due = scope
    ? Object.values(scope.wakes).filter((wake) => wake.draft && (wake.draftAt === null || now - wake.draftAt >= DRAFT_REFRESH_MS))
    : [];
  if (scope && due.length > 0) scope = markDrafts(scope, due, now);
  // Write before any network call, so a stop that lands meanwhile is never undone.
  if (pruned.removed.length > 0 || due.length > 0) await store.set(scopeKey, scope);
  await finishRemoved(effects, current, pruned.removed, pruned.clear, now);
  if (scope) {
    await effects.typing(scope.chatId, scope.threadId);
    for (const wake of due) await effects.draft(scope.chatId, scope.threadId, draftId(wake));
  }
  return scope;
}

function markDrafts(scope: TypingScope, wakes: TypingWake[], now: number): TypingScope {
  const next = { ...scope.wakes };
  for (const wake of wakes) next[wake.wakeId] = { ...wake, draftAt: now };
  return { ...scope, wakes: next };
}

export interface SchedulerHandle {
  cancel(): void;
}

/**
 * Typing driven by an in-process timer (Node), or a single action per event
 * ("once", Vercel). State lives in the store, so with a shared store another
 * instance can stop a wake, and an interim send re-arms the timer after a restart.
 */
export function createStoreTyping(options: {
  store: Pick<Store, "getTyping" | "setTyping">;
  mode: "interval" | "once";
  now: () => number;
  effects: ProgressEffects;
  schedule?: (fn: () => void, ms: number) => SchedulerHandle;
}): TypingController {
  const timers = new Map<string, SchedulerHandle>();
  const schedule = options.schedule ?? defaultSchedule;
  const scopes: ScopeStore = {
    get: (key) => options.store.getTyping(key),
    set: (key, scope) => options.store.setTyping(key, scope),
  };

  function cancel(key: string): void {
    timers.get(key)?.cancel();
    timers.delete(key);
  }

  function ensureTimer(key: string, refreshMs: number): void {
    if (options.mode === "once" || timers.has(key)) return;
    let running = false;
    const timer = schedule(() => {
      // One tick at a time per scope, even if Telegram is slow.
      if (running) return;
      running = true;
      tickScope(scopes, options.effects, key, options.now())
        .then((left) => {
          if (!left && timers.get(key) === timer) cancel(key);
        })
        .catch((err: unknown) => {
          options.effects.log({ event: "typing_tick_failed", error: safeErrorMessage(err, []) });
        })
        .finally(() => {
          running = false;
        });
    }, refreshMs);
    timers.set(key, timer);
  }

  return {
    async start(input) {
      await startWake(scopes, options.effects, input, options.now());
      ensureTimer(input.scopeKey, input.refreshMs);
    },
    async stop(scopeKey, wakeId) {
      const result = await stopWake(scopes, options.effects, scopeKey, wakeId);
      if (!result.remaining) cancel(scopeKey);
      return { stopped: result.stopped, reason: result.reason };
    },
    async touch(scopeKey, wakeId) {
      const result = await touchWake(scopes, options.effects, scopeKey, wakeId, options.now());
      if (result.active) ensureTimer(scopeKey, result.refreshMs);
      else cancel(scopeKey);
      return { active: result.active, extended: result.extended };
    },
  };
}

function defaultSchedule(fn: () => void, ms: number): SchedulerHandle {
  const timer = setInterval(fn, ms);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  return {
    cancel() {
      clearInterval(timer);
    },
  };
}
