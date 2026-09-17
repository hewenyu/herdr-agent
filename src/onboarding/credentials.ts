import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readEnv } from "../config/load.js";
import { OperationError } from "../core/errors.js";
import { atomicWrite } from "../storage/atomic.js";

export interface Credentials {
  appId: string;
  appSecret: string;
}
export async function saveCredentials(
  stateDir: string,
  credentials: Credentials,
  options: { expectedAppId?: string; allowReplace?: boolean } = {},
): Promise<void> {
  if (
    !/^cli_[A-Za-z0-9]+$/.test(credentials.appId) ||
    !/^[A-Za-z0-9._~-]+$/.test(credentials.appSecret)
  ) {
    throw new OperationError("credentials_invalid", "注册返回的凭据格式无效，未保存。");
  }
  if (options.expectedAppId && options.expectedAppId !== credentials.appId)
    throw new OperationError("credentials_mismatch", "补授权不能覆盖另一个应用。");
  const path = join(stateDir, ".env");
  const previous = readEnv(path);
  const previousAppId = previous.FEISHU_APP_ID ?? previous.LARK_APP_ID;
  if (previousAppId && previousAppId !== credentials.appId && !options.allowReplace) {
    throw new OperationError(
      "credentials_exist",
      "已有另一个飞书应用的凭据；请明确选择应用后操作。",
    );
  }
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new OperationError("credentials_read", "无法读取已有凭据，未覆盖。");
  }
  const preserved = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?(?:FEISHU|LARK)_APP_(?:ID|SECRET)\s*=/.test(line));
  const next = [
    ...preserved,
    `FEISHU_APP_ID=${credentials.appId}`,
    `FEISHU_APP_SECRET=${credentials.appSecret}`,
    "",
  ].join("\n");
  try {
    await atomicWrite(path, next);
  } catch {
    throw new OperationError(
      "credentials_save",
      "凭据保存结果未确认，请检查本机配置文件；不要重新注册应用。",
      "unknown",
    );
  }
}
