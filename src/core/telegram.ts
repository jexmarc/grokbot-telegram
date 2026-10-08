import { isPlausibleBotToken } from "./config.js";
import { mayHaveBeenReceived } from "./http.js";

export interface SendMessageInput {
  chat_id: string;
  text: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  /** Telegram: "Sends the message silently. Users will receive a notification with no sound." */
  disable_notification?: boolean;
}

export type SendMessageResult =
  | { ok: true; messageId: number }
  | {
    ok: false;
    description: string;
    status: number;
    retryAfter?: number;
    /** Telegram may have posted it anyway (timeout, reset, 5xx, unreadable 200). Never resend. */
    ambiguous?: boolean;
  };

export type CallResult = { ok: true } | { ok: false; description: string; status: number };

export interface TelegramClient {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  sendChatAction(input: {
    chat_id: string;
    message_thread_id?: number;
  }): Promise<boolean>;
  /**
   * Set one emoji reaction, or clear the bot's reaction with `emoji: null`
   * (an empty `reaction` list). Bots can set at most one reaction per message.
   */
  setMessageReaction(input: {
    chat_id: string;
    message_id: number;
    emoji: string | null;
  }): Promise<CallResult>;
  /** Private chats only. Empty text shows Telegram's "Thinking…" placeholder for up to 30 seconds. */
  sendMessageDraft(input: {
    chat_id: string;
    draft_id: number;
    message_thread_id?: number;
    text?: string;
  }): Promise<CallResult>;
}

export function telegramMethodUrl(token: string, method: string): string | null {
  if (!isPlausibleBotToken(token)) return null;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) return null;
  return `https://api.telegram.org/bot${token}/${method}`;
}

interface TelegramOk {
  ok: true;
  result?: { message_id?: number };
}

interface TelegramErr {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function createTelegramClient(options: {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  maxRetryAfterMs?: number;
}): TelegramClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 2;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 5000;

  async function call(
    method: string,
    body: unknown,
  ): Promise<{ response: Response; json: unknown } | { error: string; ambiguous: boolean }> {
    const url = telegramMethodUrl(options.token, method);
    if (!url) return { error: "bot_token_not_configured", ambiguous: false };
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { error: "telegram_redirect", ambiguous: false };
      }
      const json: unknown = await response.json().catch(() => null);
      return { response, json };
    } catch (err) {
      return { error: "telegram_unreachable", ambiguous: mayHaveBeenReceived(err) };
    }
  }

  return {
    async sendMessage(input) {
      const payload: Record<string, unknown> = {
        chat_id: input.chat_id,
        text: input.text,
      };
      if (input.message_thread_id !== undefined) payload.message_thread_id = input.message_thread_id;
      if (input.disable_notification !== undefined) payload.disable_notification = input.disable_notification;
      if (input.reply_to_message_id !== undefined) {
        // If the original message was deleted, still deliver the answer.
        payload.reply_parameters = {
          message_id: input.reply_to_message_id,
          allow_sending_without_reply: true,
        };
      }

      // Only a 429 is retried: Telegram did not post the message. Anything that may have posted it is not.
      let attempt = 0;
      while (true) {
        const result = await call("sendMessage", payload);
        if ("error" in result) {
          return result.ambiguous
            ? { ok: false, description: result.error, status: 0, ambiguous: true }
            : { ok: false, description: result.error, status: 0 };
        }
        const data = result.json as TelegramOk | TelegramErr | null;
        if (result.response.ok && data && data.ok === true) {
          const messageId = data.result?.message_id;
          return { ok: true, messageId: typeof messageId === "number" ? messageId : 0 };
        }
        const description = data && data.ok === false && data.description ? data.description : "telegram_error";
        const status = result.response.status;
        const retryAfter = data && data.ok === false ? data.parameters?.retry_after : undefined;
        const waitMs = Math.max(0, (retryAfter ?? 1) * 1000);
        // Only wait in-request for short limits. Retrying before retry_after just earns another 429.
        if (status === 429 && attempt < maxRetries && waitMs <= maxRetryAfterMs) {
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        const failure: SendMessageResult = { ok: false, description: description.slice(0, 300), status };
        if (status === 429 && typeof retryAfter === "number") failure.retryAfter = retryAfter;
        // A 5xx, or a 200 we could not read, can follow a message that was posted.
        if (status >= 500 || (result.response.ok && data === null)) failure.ambiguous = true;
        return failure;
      }
    },
    async sendChatAction(input) {
      const payload: Record<string, unknown> = {
        chat_id: input.chat_id,
        action: "typing",
      };
      if (input.message_thread_id !== undefined) payload.message_thread_id = input.message_thread_id;
      const result = await call("sendChatAction", payload);
      if ("error" in result) return false;
      const data = result.json as { ok?: boolean } | null;
      return result.response.ok && data?.ok === true;
    },
    async setMessageReaction(input) {
      return simpleCall("setMessageReaction", {
        chat_id: input.chat_id,
        message_id: input.message_id,
        reaction: input.emoji === null ? [] : [{ type: "emoji", emoji: input.emoji }],
        is_big: false,
      });
    },
    async sendMessageDraft(input) {
      // chat_id is documented as Integer here, not "Integer or String".
      const payload: Record<string, unknown> = {
        chat_id: Number(input.chat_id),
        draft_id: input.draft_id,
        text: input.text ?? "",
      };
      if (input.message_thread_id !== undefined) payload.message_thread_id = input.message_thread_id;
      return simpleCall("sendMessageDraft", payload);
    },
  };

  /** One attempt, no retries: these calls are cosmetic and must never hold up a reply. */
  async function simpleCall(method: string, body: unknown): Promise<CallResult> {
    const result = await call(method, body);
    if ("error" in result) return { ok: false, description: result.error, status: 0 };
    const data = result.json as TelegramOk | TelegramErr | null;
    if (result.response.ok && data && data.ok === true) return { ok: true };
    const description = data && data.ok === false && data.description ? data.description : "telegram_error";
    return { ok: false, description: description.slice(0, 200), status: result.response.status };
  }
}
