import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../../src/app/application.js";
import { loadConfig } from "../../src/config/load.js";
import type { IncomingMessage } from "../../src/core/types.js";
import type { ConversationEngine, EngineInput, EngineResult } from "../../src/runtime/types.js";
import { Store } from "../../src/storage/store.js";
import { FakeHerdr, FakePlatform } from "../tasks/helpers.js";

export class Engine implements ConversationEngine {
  contextTokens = 128000;
  calls: EngineInput[] = [];
  response = "请指定讨论参与者。";
  handler?: (input: EngineInput) => Promise<EngineResult>;
  async run(input: EngineInput): Promise<EngineResult> {
    this.calls.push(input);
    if (this.handler) return this.handler(input);
    return {
      text: input.sessionId.startsWith("notice:")
        ? '{"notify":true,"text":"进度通知"}'
        : this.response,
      messages: [],
    };
  }
  async summarize() {
    return "历史摘要";
  }
}
export class Platform extends FakePlatform {
  texts: Array<{ chat: string; text: string; key: string }> = [];
  cards: Array<{ chat: string; card: Record<string, unknown>; key: string }> = [];
  sendHook?: () => void;
  cardHook?: (nonce: string) => Promise<void>;
  override async sendText(chat = "", text = "", key = ""): Promise<string> {
    this.sendHook?.();
    this.texts.push({ chat, text, key });
    return `message-${this.texts.length}`;
  }
  override async sendCard(
    chat = "",
    card: Record<string, unknown> = {},
    key = "",
  ): Promise<string> {
    this.cards.push({ chat, card, key });
    await this.cardHook?.(key);
    return `card-${this.cards.length}`;
  }
}
export const logger = { info() {}, warn() {}, error() {} };
export function message(id: string, text: string, chatId = "entry"): IncomingMessage {
  return {
    source: "feishu",
    eventId: `event-${id}`,
    messageId: id,
    ownerId: "owner",
    chatId,
    chatType: "private",
    text,
    mentionedBot: false,
  };
}
export function setup(ai = true, platformEnabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-app-"));
  const store = new Store(join(directory, "state.sqlite"));
  const config = loadConfig({ stateDir: directory, home: directory, cwd: directory, env: {} });
  config.ai.enabled = ai;
  config.tasks.enabled = true;
  config.feishu.allowedOpenIds = ["owner"];
  config.catalog.projects = [{ name: "project", directories: [directory], agent: "codex" }];
  config.catalog.defaultProject = "project";
  const engine = new Engine();
  const platform = new Platform();
  const herdr = new FakeHerdr();
  const app = new Application({
    config,
    store,
    engine,
    herdr,
    platform: platformEnabled ? platform : undefined,
    logger,
  });
  return {
    directory,
    store,
    config,
    engine,
    platform,
    herdr,
    app,
    async close() {
      await app.shutdown();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
