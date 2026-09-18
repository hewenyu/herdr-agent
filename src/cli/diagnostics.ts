import type { AppConfig } from "../config/types.js";
import { validateConfig } from "../config/validate.js";
import { OperationError, safeError } from "../core/errors.js";
import type { Arguments } from "./args.js";
import type { Dependencies } from "./dependencies.js";
import { type Check, paneWidths } from "./host-checks.js";

export async function doctor(
  args: Arguments,
  config: AppConfig,
  deps: Dependencies,
): Promise<number> {
  const checks: Check[] = [];
  const herdr = deps.createHerdr(config);
  try {
    validateConfig(config);
    checks.push({ name: "config", status: "pass", message: "配置格式有效。" });
  } catch (error) {
    checks.push({ name: "config", status: "fail", message: safeError(error).message });
  }
  const results = await Promise.allSettled([
    herdr.ping(deps.signal),
    deps.executable("codex"),
    deps.executable("claude"),
    config.feishu.appId && config.feishu.appSecret
      ? deps.checkAuthorization(config.feishu, { tasks: config.tasks.enabled, signal: deps.signal })
      : Promise.resolve(undefined),
  ]);
  const ping = results[0];
  checks.push(
    ping.status === "fulfilled"
      ? {
          name: "herdr",
          status: "pass",
          message: `herdr ${ping.value.version}，协议 ${ping.value.protocol}。`,
        }
      : { name: "herdr", status: "fail", message: safeError(ping.reason).message },
  );
  for (const [index, name] of [
    [1, "codex"],
    [2, "claude"],
  ] as const) {
    const result = results[index];
    checks.push({
      name,
      status: result.status === "fulfilled" && result.value ? "pass" : "warn",
      message:
        result.status === "fulfilled" && result.value
          ? `${name} 可执行文件已安装。`
          : `${name} 未在 PATH 中找到。`,
    });
  }
  const authorization = results[3];
  checks.push(
    authorization.status === "rejected"
      ? { name: "authorization", status: "fail", message: safeError(authorization.reason).message }
      : authorization.value?.state === "ready"
        ? { name: "authorization", status: "pass", message: "飞书应用权限完整。" }
        : {
            name: "authorization",
            status: "fail",
            message: authorization.value
              ? `需要补授权：${authorization.value.missingScopes.join(", ") || "凭据无效"}`
              : "请运行 setup 配置飞书应用。",
          },
  );
  checks.push({
    name: "owner",
    status: config.feishu.allowedOpenIds.length ? "pass" : "fail",
    message: config.feishu.allowedOpenIds.length
      ? "已配置允许名单。"
      : "允许名单为空，请完成 setup。",
  });
  checks.push({
    name: "pi",
    status: config.ai.enabled ? "pass" : "warn",
    message: config.ai.enabled ? "pi 已配置；未调用模型。" : "pi 调度未启用。",
  });
  const [host, panes] = await Promise.allSettled([
    deps.inspectHost(deps.signal),
    ping.status === "fulfilled"
      ? paneWidths(herdr, deps.signal)
      : Promise.resolve<Check>({
          name: "pane-width",
          status: "unknown",
          message: "herdr 无法连接，未测量终端宽度。",
        }),
  ]);
  checks.push(
    ...(host.status === "fulfilled"
      ? host.value
      : [{ name: "host", status: "unknown" as const, message: "本机环境检查未完成。" }]),
  );
  checks.push(
    panes.status === "fulfilled"
      ? panes.value
      : { name: "pane-width", status: "unknown", message: "终端宽度未能测量。" },
  );
  deps.stdout(
    args.json
      ? JSON.stringify({ checks }, null, 2)
      : checks.map((check) => `[${check.status}] ${check.name}: ${check.message}`).join("\n"),
  );
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

export async function debug(
  args: Arguments,
  config: AppConfig,
  deps: Dependencies,
): Promise<number> {
  const [command, paneId, extra] = args.positionals;
  if (
    !command ||
    !["ls", "screen", "transcript"].includes(command) ||
    extra ||
    (command === "ls" ? paneId : !paneId)
  ) {
    throw new OperationError(
      "usage",
      "诊断用法：debug ls | debug screen PANE | debug transcript PANE。",
    );
  }
  const herdr = deps.createHerdr(config);
  let output: unknown;
  if (command === "ls") output = await herdr.list(deps.signal);
  else {
    const pane = await herdr.get(paneId ?? "", deps.signal);
    if (!pane.kind) throw new OperationError("agent_kind", "该终端尚未绑定 Claude 或 Codex。");
    const ref = {
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      sessionId: pane.sessionId,
      kind: pane.kind,
      cwd: pane.cwd,
    };
    output =
      command === "screen" ? await herdr.screen(ref, deps.signal) : await herdr.transcript(ref);
  }
  deps.stdout(JSON.stringify(output, null, 2));
  return 0;
}
