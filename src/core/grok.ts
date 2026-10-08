import type { Config } from "./config.js";
import type { WakeEvent } from "./types.js";

import { mayHaveBeenReceived } from "./http.js";

export interface ForwardResult {
  ok: boolean;
  status: number;
  reason: string;
  /**
   * True when the routine may have taken the wake anyway (timeout, reset, a
   * gateway error). Never retry, never tell the person it failed.
   */
  ambiguous: boolean;
}

/** Gateway answers where the origin may already have the request: bad gateway, gateway timeout, CDN origin errors. */
const AMBIGUOUS_STATUSES = new Set([502, 504, 520, 524]);

/**
 * JSON with `<`, `>`, and `&` escaped. It parses to the same value, but user
 * text can no longer contain a literal `</webhook_event>` that closes the
 * block the assistant sees the payload in.
 */
export function encodeWakeBody(payload: WakeEvent): string {
  return JSON.stringify(payload)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

export async function forwardToGrok(
  config: Pick<Config, "grokWebhookUrl" | "grokWebhookSenderKey" | "allowInsecureWebhook">,
  payload: WakeEvent,
  fetchImpl: typeof fetch,
): Promise<ForwardResult> {
  if (!config.grokWebhookUrl || !config.grokWebhookSenderKey) {
    return { ok: false, status: 0, reason: "grok_not_configured", ambiguous: false };
  }
  let url: URL;
  try {
    url = new URL(config.grokWebhookUrl);
  } catch {
    return { ok: false, status: 0, reason: "bad_url", ambiguous: false };
  }
  const https = url.protocol === "https:";
  const insecureOk = config.allowInsecureWebhook && url.protocol === "http:";
  if (!https && !insecureOk) return { ok: false, status: 0, reason: "insecure_url", ambiguous: false };
  if (url.username || url.password) return { ok: false, status: 0, reason: "bad_url", ambiguous: false };

  // Exactly one attempt. Once the POST may have reached the routine, a retry could wake it twice.

  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.grokWebhookSenderKey}`,
      },
      body: encodeWakeBody(payload),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, status: response.status, reason: "redirect", ambiguous: false };
    }
    const ok = response.status >= 200 && response.status < 300;
    return {
      ok,
      status: response.status,
      reason: ok ? "accepted" : "upstream",
      ambiguous: !ok && AMBIGUOUS_STATUSES.has(response.status),
    };
  } catch (err) {
    const ambiguous = mayHaveBeenReceived(err);
    return { ok: false, status: 0, reason: ambiguous ? "no_response" : "unreachable", ambiguous };
  }
}
