import { describe, expect, it } from "vitest";
import type { TelegramUpdate, WakeEvent } from "../src/core/types.js";
import { createTestApp, groupUpdate, postUpdate, testEnv } from "./helpers.js";

function wakes(calls: { url: string; body: unknown }[]): WakeEvent[] {
  return calls.filter((call) => call.url.startsWith("https://grok.example/hook")).map((call) => call.body as WakeEvent);
}

function asChat(update: TelegramUpdate, senderChatId: number, fromId: number, isBot: boolean): TelegramUpdate {
  const message = update.message;
  if (!message) throw new Error("no message");
  message.from = { id: fromId, is_bot: isBot, first_name: "Placeholder" };
  message.sender_chat = { id: senderChatId, type: senderChatId === message.chat.id ? "supergroup" : "channel", title: "As chat" };
  return update;
}

const mention = [{ type: "mention", offset: 0, length: 8 }];

describe("who the sender is", () => {
  it("does not let a sender_chat placeholder match ALLOWLIST_USER_IDS", async () => {
    // The placeholder `from` id is allowlisted, the group is not.
    const app = createTestApp({ env: testEnv({ ALLOWLIST_USER_IDS: "777000", ALLOWLIST_CHAT_IDS: "" }) });
    const update = asChat(groupUpdate({ text: "@testbot hi", chatId: -999, entities: mention }), -777, 777000, false);
    await postUpdate(app.deps, app.tasks, update);
    expect(wakes(app.calls)).toHaveLength(0);
  });

  it("admits an anonymous admin only through an allowlisted chat id, with from set to null", async () => {
    const app = createTestApp();
    const update = asChat(groupUpdate({ text: "@testbot hi", chatId: -500, entities: mention }), -500, 1087968824, true);
    await postUpdate(app.deps, app.tasks, update);
    const [wake] = wakes(app.calls);
    expect(wake?.chat.id).toBe("-500");
    expect(wake?.from).toBeNull();
  });

  it("ignores automatic forwards from a linked channel", async () => {
    const app = createTestApp();
    const update = groupUpdate({ text: "@testbot new post", entities: mention });
    if (update.message) update.message.is_automatic_forward = true;
    await postUpdate(app.deps, app.tasks, update);
    expect(wakes(app.calls)).toHaveLength(0);
  });
});

describe("thread ids", () => {
  it("keeps message_thread_id for forum topics", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, groupUpdate({ text: "@testbot hi", threadId: 15, entities: mention }));
    expect(wakes(app.calls)[0]?.reply.message_thread_id).toBe(15);
  });

  it("drops message_thread_id on replies in a non-forum supergroup", async () => {
    const app = createTestApp();
    const update = groupUpdate({ text: "@testbot hi", entities: mention });
    if (update.message) update.message.message_thread_id = 31;
    await postUpdate(app.deps, app.tasks, update);
    const [wake] = wakes(app.calls);
    expect(wake?.reply.message_thread_id).toBeNull();
    expect(wake?.message.message_thread_id).toBeNull();
  });
});
