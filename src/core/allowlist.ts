import type { Config } from "./config.js";

/**
 * Fail closed. A user id admits that person everywhere (including their DMs).
 * A chat id admits every sender, but only inside that chat.
 */
export function isAllowlisted(
  userId: string | null,
  chatId: string | null,
  config: Pick<Config, "allowlistUserIds" | "allowlistChatIds">,
): boolean {
  if (config.allowlistUserIds.size === 0 && config.allowlistChatIds.size === 0) return false;
  if (userId && config.allowlistUserIds.has(userId)) return true;
  if (chatId && config.allowlistChatIds.has(chatId)) return true;
  return false;
}

/**
 * Proactive sends have no end-user attached. Allow a chat id that was listed
 * directly, or a private chat whose id is an allowlisted user id (Telegram uses
 * the same id for a person and their DM with the bot).
 */
export function isOutboundChatAllowed(
  chatId: string,
  config: Pick<Config, "allowlistUserIds" | "allowlistChatIds">,
): boolean {
  if (config.allowlistUserIds.size === 0 && config.allowlistChatIds.size === 0) return false;
  return config.allowlistChatIds.has(chatId) || config.allowlistUserIds.has(chatId);
}
