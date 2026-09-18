import { createHash } from "node:crypto";
import type { CardAction, IncomingMessage } from "../core/types.js";
import { object, string } from "./api.js";
import { postText } from "./post.js";

function event(raw: unknown): Record<string, unknown> {
  const root = object(raw);
  return root.event ? { ...object(root.header), ...object(root.event) } : root;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Only actual human text is forwarded; resources are never substituted as instructions. */
export function normalizeMessage(raw: unknown, botOpenId: string): IncomingMessage | undefined {
  const data = event(raw);
  const sender = object(data.sender);
  if (sender.sender_type !== "user") return undefined;
  const message = object(data.message);
  const ownerId = string(object(sender.sender_id).open_id);
  const messageId = string(message.message_id);
  const chatId = string(message.chat_id);
  if (!ownerId || !messageId || !chatId) return undefined;
  let text = "";
  let mentionedBot = false;
  let unsupportedType: string | undefined;
  if (message.message_type === "text") {
    try {
      const content = object(JSON.parse(string(message.content)));
      if (typeof content.text !== "string") unsupportedType = "invalid_text";
      else text = content.text;
    } catch {
      unsupportedType = "invalid_text";
    }
  } else if (message.message_type === "post") {
    try {
      const result = postText(JSON.parse(string(message.content)), botOpenId);
      text = result.text;
      mentionedBot = result.mentionedBot;
      if (!text) unsupportedType = "post_without_text";
    } catch {
      unsupportedType = "invalid_post";
    }
  } else unsupportedType = string(message.message_type) || "unknown";
  for (const rawMention of Array.isArray(message.mentions) ? message.mentions : []) {
    const mention = object(rawMention);
    if (botOpenId && string(object(mention.id).open_id) === botOpenId) {
      mentionedBot = true;
      const key = string(mention.key);
      if (key) text = text.split(key).join("");
    }
  }
  const reply = string(message.parent_id) || string(message.root_id);
  return {
    source: "feishu",
    eventId: string(data.event_id) || `message:${messageId}`,
    messageId,
    ownerId,
    chatId,
    chatType: message.chat_type === "p2p" ? "private" : "group",
    text: text.trim(),
    mentionedBot,
    ...(reply ? { replyToMessageId: reply } : {}),
    ...(unsupportedType ? { unsupportedType } : {}),
  };
}

export function normalizeAction(raw: unknown): CardAction | undefined {
  const data = event(raw);
  const context = object(data.context);
  const action = object(data.action);
  const ownerId = string(object(data.operator).open_id);
  const chatId = string(context.open_chat_id) || string(data.open_chat_id);
  const messageId = string(context.open_message_id) || string(data.open_message_id);
  if (!ownerId || !chatId || !messageId) return undefined;
  const value = object(action.value);
  // Preserve Go syntheticActionID so migrated headerless card presses stay deduplicated.
  const payload = JSON.stringify(canonical(value)).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const fallback = createHash("sha256")
    .update([messageId, chatId, ownerId, string(action.tag), payload, ""].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return {
    eventId: string(data.event_id) || `synth-card-${fallback}`,
    ownerId,
    chatId,
    messageId,
    value,
  };
}
