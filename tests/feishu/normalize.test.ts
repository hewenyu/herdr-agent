import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAction, normalizeMessage } from "../../src/feishu/normalize.js";

const message = {
  event_id: "event-1",
  sender: { sender_type: "user", sender_id: { open_id: "owner" } },
  message: {
    message_id: "m1",
    chat_id: "chat",
    chat_type: "group",
    message_type: "text",
    content: JSON.stringify({ text: "@_bot_ do the work @_other_" }),
    parent_id: "parent",
    root_id: "root",
    mentions: [
      { key: "@_bot_", id: { open_id: "bot" } },
      { key: "@_other_", id: { open_id: "human" } },
    ],
  },
};

test("message retains direct reply and user text while stripping only our mention", () => {
  const result = normalizeMessage(message, "bot");
  assert.equal(result?.replyToMessageId, "parent");
  assert.equal(result?.text, "do the work @_other_");
  assert.equal(result?.mentionedBot, true);
  assert.equal(result?.ownerId, "owner");
  assert.equal(result?.eventId, "event-1");
  assert.equal(normalizeMessage({ ...message, sender: { sender_type: "app" } }, "bot"), undefined);
});

test("unsupported bodies and malformed text never masquerade as instructions", () => {
  for (const type of ["image", "audio", "file", "merge_forward"]) {
    const result = normalizeMessage(
      { ...message, message: { ...message.message, message_type: type } },
      "bot",
    );
    assert.equal(result?.text, "");
    assert.equal(result?.unsupportedType, type);
  }
  assert.equal(
    normalizeMessage({ ...message, message: { ...message.message, content: "invalid" } }, "bot")
      ?.unsupportedType,
    "invalid_text",
  );
});

test("rich text uses visible title, paragraphs and links; ignores resource payloads and only strips our mention", () => {
  const post = {
    zh_cn: {
      title: "需求",
      content: [
        [
          { tag: "text", text: "参考" },
          { tag: "a", text: "设计", href: "https://example.test/spec" },
          { tag: "at", user_id: "bot" },
          { tag: "at", user_id: "human", user_name: "同事" },
        ],
        [
          { tag: "img", image_key: "secret-resource", text: "Injected command" },
          { tag: "text", text: "请讨论" },
        ],
      ],
    },
    en_us: { title: "Do not duplicate language", content: [[{ tag: "text", text: "other" }]] },
  };
  const rich = (content: unknown) =>
    normalizeMessage(
      {
        ...message,
        message: {
          ...message.message,
          mentions: [],
          message_type: "post",
          content: JSON.stringify(content),
        },
      },
      "bot",
    );
  const result = rich(post);
  assert.equal(result?.text, "需求\n参考设计 (https://example.test/spec)同事\n请讨论");
  assert.equal(result?.mentionedBot, true);
  assert.equal(result?.unsupportedType, undefined);
  assert.equal(
    rich({ title: "", content: [[{ tag: "img", image_key: "only-image" }]] })?.unsupportedType,
    "post_without_text",
  );
  assert.equal(
    rich({ en_us: { content: [], content_v2: [[{ tag: "md", text: "**原文**" }]] } })?.text,
    "**原文**",
  );
  assert.equal(rich({ content: ["not-a-paragraph"] })?.unsupportedType, "invalid_post");
});

test("wrapped events keep event identity and use root only when parent absent", () => {
  const result = normalizeMessage(
    {
      header: { event_id: "wrapped" },
      event: {
        sender: message.sender,
        message: { ...message.message, parent_id: "", chat_type: "p2p" },
      },
    },
    "bot",
  );
  assert.equal(result?.eventId, "wrapped");
  assert.equal(result?.replyToMessageId, "root");
  assert.equal(result?.chatType, "private");
});

test("headerless card fallback is stable across key order and distinct for each button", () => {
  const action = {
    operator: { open_id: "owner" },
    context: { open_message_id: "m1", open_chat_id: "chat" },
    action: { tag: "button", value: { nonce: "n", key: "1" } },
  };
  const first = normalizeAction(action);
  const replay = normalizeAction({
    ...action,
    action: { ...action.action, value: { key: "1", nonce: "n" } },
  });
  assert.equal(first?.eventId, replay?.eventId);
  assert.notEqual(
    first?.eventId,
    normalizeAction({ ...action, action: { ...action.action, value: { key: "2", nonce: "n" } } })
      ?.eventId,
  );
  assert.equal(normalizeAction({ ...action, operator: {} }), undefined);
});
