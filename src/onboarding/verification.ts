import { randomUUID } from "node:crypto";
import { OperationError } from "../core/errors.js";
import type { PlatformPort } from "../core/ports.js";
import type { CardAction, IncomingMessage } from "../core/types.js";

export interface VerificationResult {
  inboundOK: boolean;
  cardOK: boolean;
  ownerId?: string;
  chatId?: string;
}
export interface VerificationOptions {
  signal: AbortSignal;
  expectedOwnerId?: string;
  inboundTimeoutMs?: number;
  cardTimeoutMs?: number;
  onPhase?(phase: "connecting" | "message" | "card" | "verified"): void;
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function wait<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, ms);
    const abort = () => {
      cleanup();
      reject(new OperationError("verification_aborted", "连接验证已取消。"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Owns a temporary connection; use before starting the production event consumer. */
export async function verifyPlatform(
  platform: PlatformPort,
  options: VerificationOptions,
): Promise<VerificationResult> {
  const inbound = deferred<IncomingMessage>();
  const clicked = deferred<CardAction>();
  const nonce = randomUUID();
  let selected: IncomingMessage | undefined;
  let active = true;
  let cardId = "";
  let earlyAction: CardAction | undefined;
  const acceptAction = (action: CardAction) => {
    if (
      !active ||
      !selected ||
      action.ownerId !== selected.ownerId ||
      action.chatId !== selected.chatId ||
      action.value.setup_nonce !== nonce ||
      action.value.action !== "verify"
    )
      return;
    if (!cardId) earlyAction = action;
    else if (action.messageId === cardId) clicked.resolve(action);
  };
  try {
    options.onPhase?.("connecting");
    await platform.start(
      {
        message: async (message) => {
          if (
            !active ||
            selected ||
            message.chatType !== "private" ||
            message.unsupportedType ||
            !message.ownerId ||
            (options.expectedOwnerId && message.ownerId !== options.expectedOwnerId)
          )
            return;
          selected = message;
          inbound.resolve(message);
        },
        action: async (action) => {
          acceptAction(action);
        },
        taskChanged: async () => {},
      },
      options.signal,
    );
    options.onPhase?.("message");
    const message = await wait(
      inbound.promise,
      options.inboundTimeoutMs ?? 150_000,
      options.signal,
    );
    if (!message) return { inboundOK: false, cardOK: false };
    const result = {
      inboundOK: true,
      cardOK: false,
      ownerId: message.ownerId,
      chatId: message.chatId,
    };
    options.signal.throwIfAborted();
    cardId = await platform.sendCard(
      message.chatId,
      {
        header: { title: { tag: "plain_text", content: "herdr-agent 连接验证" } },
        elements: [
          {
            tag: "div",
            text: { tag: "plain_text", content: "消息已收到。请点击下方按钮，完成卡片回调验证。" },
          },
          {
            tag: "action",
            actions: [
              {
                tag: "button",
                type: "primary",
                text: { tag: "plain_text", content: "确认连接" },
                value: { action: "verify", setup_nonce: nonce },
              },
            ],
          },
        ],
      },
      `setup-${nonce}`,
    );
    if (earlyAction) acceptAction(earlyAction);
    options.onPhase?.("card");
    const action = await wait(clicked.promise, options.cardTimeoutMs ?? 120_000, options.signal);
    if (!action) return result;
    options.onPhase?.("verified");
    return { ...result, cardOK: true };
  } finally {
    active = false;
    await platform.stop();
  }
}
