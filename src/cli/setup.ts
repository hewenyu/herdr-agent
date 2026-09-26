import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { fields, readEnv, readToml } from "../config/load.js";
import type { AppConfig } from "../config/types.js";
import { OperationError, safeError } from "../core/errors.js";
import type { Credentials } from "../onboarding/index.js";
import { atomicWrite } from "../storage/atomic.js";
import type { Arguments } from "./args.js";
import { type Dependencies, openBrowser } from "./dependencies.js";

export interface CredentialCandidate extends Credentials {
  source: string;
}
export function credentialCandidates(stateDir: string): CredentialCandidate[] {
  const sources: Array<[string, NodeJS.ProcessEnv]> = [
    ["进程环境", process.env],
    [join(stateDir, ".env"), readEnv(join(stateDir, ".env"))],
  ];
  for (let current = resolve(process.cwd()); ; current = dirname(current)) {
    if ([".git", "go.mod", "package.json"].some((marker) => existsSync(join(current, marker)))) {
      sources.push([join(current, ".env"), readEnv(join(current, ".env"))]);
      break;
    }
    if (dirname(current) === current) break;
  }
  return sources.flatMap(([source, values]) => {
    const appId = values.FEISHU_APP_ID ?? values.LARK_APP_ID;
    return appId
      ? [{ source, appId, appSecret: values.FEISHU_APP_SECRET ?? values.LARK_APP_SECRET ?? "" }]
      : [];
  });
}
export function selectCredentials(
  candidates: CredentialCandidate[],
  args: Arguments,
): Credentials | undefined {
  if (args.reregister) return undefined;
  const ids = new Set(candidates.map((candidate) => candidate.appId));
  if (!args.appId && ids.size > 1)
    throw new OperationError(
      "ambiguous_app",
      `发现多个应用：${candidates.map((item) => `${item.appId}（${item.source}）`).join("、")}。请使用 --app 明确选择。`,
    );
  const selected = args.appId ?? candidates[0]?.appId;
  if (!selected) return undefined;
  const candidate = candidates.find((item) => item.appId === selected && item.appSecret);
  return { appId: selected, appSecret: candidate?.appSecret ?? "" };
}

export async function setup(
  args: Arguments,
  config: AppConfig,
  deps: Dependencies,
): Promise<number> {
  const lock = deps.acquireLock(config.stateDir);
  let saved = false;
  try {
    let credentials = selectCredentials(credentialCandidates(config.stateDir), args);
    if (credentials?.appId === config.feishu.appId && !credentials.appSecret)
      credentials.appSecret = config.feishu.appSecret;
    // Injected/test configurations may not originate from a file or environment.
    if (!credentials && !args.reregister && config.feishu.appId) credentials = { ...config.feishu };
    if (args.updatePermissions && !credentials)
      throw new OperationError("app_required", "补授权需要现有应用，请指定 --app。");
    let ownerId: string | undefined;
    let ready = false;
    if (credentials?.appSecret && !args.updatePermissions) {
      const checked = await deps.checkAuthorization(credentials, {
        tasks: config.tasks.enabled,
        signal: deps.signal,
      });
      ready = checked.state === "ready";
    }
    if (!ready) {
      const registered = await deps.registerApp({
        appId: credentials?.appId,
        createOnly: args.reregister || undefined,
        tasks: config.tasks.enabled,
        timeoutMs: args.timeoutMs,
        signal: deps.signal,
        onURL: ({ url, expiresAt }) => {
          deps.stdout(args.json ? JSON.stringify({ event: "authorization", url, expiresAt }) : url);
          if (!args.noOpen) void openBrowser(deps, url);
        },
      });
      if (registered.brand !== "feishu")
        throw new OperationError(
          "unsupported_brand",
          "当前版本仅支持飞书国内应用；Lark 凭据未保存。",
        );
      if (credentials && registered.appId !== credentials.appId)
        throw new OperationError("credentials_mismatch", "补授权返回了另一个应用，未保存。");
      credentials = registered;
      ownerId = registered.openId;
    }
    if (!credentials) throw new OperationError("credentials_missing", "没有取得应用凭据。");
    await deps.saveCredentials(config.stateDir, credentials, {
      expectedAppId: args.reregister ? undefined : credentials.appId,
      allowReplace: args.reregister || Boolean(args.appId),
    });
    saved = true;
    config.feishu.appId = credentials.appId;
    config.feishu.appSecret = credentials.appSecret;
    if (ownerId) await persistIdentity(config.stateDir, ownerId);
    const checked = await deps.checkAuthorization(credentials, {
      tasks: config.tasks.enabled,
      signal: deps.signal,
    });
    if (checked.state !== "ready")
      throw new OperationError(
        "authorization_incomplete",
        "凭据已保存，但所需权限尚未全部生效。请运行 setup --update-permissions。",
      );
    const verification = await deps.verifyPlatform(deps.createPlatform(config), {
      signal: deps.signal,
      expectedOwnerId: ownerId ?? config.feishu.allowedOpenIds[0],
      onPhase: (phase) => {
        const messages = {
          connecting: "正在建立临时验证连接。",
          message: "请向飞书机器人发送一条私聊消息。",
          card: "请点击机器人发出的“确认连接”按钮。",
          verified: "消息与卡片回调均已验证。",
        };
        deps.stderr(messages[phase]);
      },
    });
    if (verification.ownerId)
      await persistIdentity(config.stateDir, verification.ownerId, verification.chatId);
    deps.stdout(
      args.json
        ? JSON.stringify({ event: "setup", appId: credentials.appId, ...verification })
        : verification.cardOK && verification.inboundOK
          ? "配置完成，可以运行 myrix serve。"
          : "凭据已保存，连接验证未完成。请重新运行 setup 完成私聊与卡片验证。",
    );
    return verification.cardOK && verification.inboundOK ? 0 : 3;
  } catch (error) {
    deps.stderr(safeError(error).message);
    return saved ? 3 : deps.signal.aborted ? 130 : 1;
  } finally {
    lock.release();
  }
}

async function persistIdentity(stateDir: string, ownerId: string, chatId?: string): Promise<void> {
  const path = join(stateDir, "config.toml");
  const document = readToml(path);
  const feishu = fields(document.feishu);
  const allowed = Array.isArray(feishu.allowed_open_ids)
    ? feishu.allowed_open_ids.filter((value): value is string => typeof value === "string")
    : [];
  document.feishu = {
    ...feishu,
    allowed_open_ids: [...new Set([...allowed, ownerId])],
    ...(chatId && !feishu.notify_chat_id ? { notify_chat_id: chatId } : {}),
  };
  await atomicWrite(path, stringify(document));
}
