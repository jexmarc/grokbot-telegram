import { waitUntil } from "@vercel/functions";
import { buildDeps, type AppDeps } from "../../core/deps.js";
import { handleRequest } from "../../core/handler.js";
import { MemoryStore, type Store } from "../../core/store.js";
import { createTelegramClient, type TelegramClient } from "../../core/telegram.js";
import { createLogger } from "../../core/log.js";
import { createStoreTyping, telegramEffects, type TypingController } from "../../core/typing.js";

interface Shared {
  store?: Store;
  typing?: TypingController;
}

const shared: Shared = {};

/** Test hook. Production instances keep the store for the life of the isolate. */
export function resetVercelShared(): void {
  shared.store = undefined;
  shared.typing = undefined;
}

function vercelWaitUntil(promise: Promise<unknown>): void {
  try {
    waitUntil(promise);
  } catch {
    promise.catch(() => undefined);
  }
}

export function createVercelDeps(
  env: Record<string, string | undefined>,
  state: Shared = shared,
  fetchImpl?: typeof fetch,
): AppDeps {
  if (!state.store) {
    state.store = new MemoryStore();
  }
  if (!state.typing) {
    const store = state.store;
    const telegram: TelegramClient = createTelegramClient({
      token: env.TELEGRAM_BOT_TOKEN ?? "",
      fetchImpl,
    });
    // No timer survives the response here: each start, interim send, or heartbeat pulses typing once.
    state.typing = createStoreTyping({
      store,
      mode: "once",
      now: () => Date.now(),
      effects: telegramEffects(telegram, createLogger([env.TELEGRAM_BOT_TOKEN ?? ""])),
    });
  }
  return buildDeps({
    env,
    store: state.store,
    typing: state.typing,
    typingMode: "once",
    fetchImpl,
    waitUntil: vercelWaitUntil,
  });
}

/**
 * vercel.json rewrites every route to this one function, with the public path in `?path=`.
 * One function means the webhook and the later `/send` or `/typing/*` calls share one store.
 */
export async function vercelFetch(
  request: Request,
  env: Record<string, string | undefined> = envRecord(process.env),
  state: Shared = shared,
  fetchImpl?: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.searchParams.get("path") ?? url.pathname;
  return handleRequest(new Request(url, request), createVercelDeps(env, state, fetchImpl));
}

function envRecord(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) out[key] = value;
  return out;
}
