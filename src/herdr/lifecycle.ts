import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { OperationError } from "../core/errors.js";
import type { AgentKind, AgentSnapshot } from "../core/types.js";
import type { HerdrClient } from "./client.js";
import { object, string } from "./protocol.js";
import { deadline, pause } from "./timing.js";

export async function createWorkspace(
  client: HerdrClient,
  cwd: string,
  label: string,
  signal?: AbortSignal,
) {
  if (!isAbsolute(cwd) || !label.trim())
    throw new OperationError("invalid_params", "工作区需要绝对目录和名称。");
  const result = object(
    await client.transport.call("workspace.create", { cwd, label, focus: false }, signal),
  );
  const workspace = object(result.workspace);
  const pane = object(result.root_pane);
  const workspaceId = string(workspace.workspace_id);
  const paneId = string(pane.pane_id);
  if (!workspaceId || !paneId)
    throw new OperationError("invalid_response", "工作区创建结果缺少资源 ID。", "unknown");
  return { workspaceId, paneId, cwd: string(pane.cwd) || cwd };
}

export async function startupArgs(
  kind: AgentKind,
  directories: string[],
  bypass: boolean,
): Promise<string[]> {
  const args: string[] = [];
  if (bypass)
    args.push(
      kind === "codex"
        ? "--dangerously-bypass-approvals-and-sandbox"
        : "--dangerously-skip-permissions",
    );
  for (const directory of directories) {
    if (!isAbsolute(directory) || /\p{Cc}/u.test(directory))
      throw new OperationError("invalid_params", "额外目录必须是有效绝对路径。");
    try {
      if (!(await stat(directory)).isDirectory()) throw new Error("not_directory");
    } catch (cause) {
      throw new OperationError("invalid_params", "额外目录不存在或无法读取。", "not_executed", {
        cause,
      });
    }
    args.push("--add-dir", directory);
  }
  return args;
}

export async function startAgent(
  client: HerdrClient,
  paneId: string,
  kind: AgentKind,
  name: string,
  options: { directories: string[]; bypass: boolean; signal?: AbortSignal },
): Promise<AgentSnapshot> {
  if (!paneId || !name || !["claude", "codex"].includes(kind))
    throw new OperationError("invalid_params", "agent 启动参数不完整。");
  const args = await startupArgs(kind, options.directories, options.bypass);
  const signal = deadline(30_000, options.signal);
  let shellTerminal: string | undefined;
  let result: Record<string, unknown>;
  for (;;) {
    if (shellTerminal) {
      await pause(100, signal);
      const pane = await client.pane(paneId, signal);
      if (pane.pane_id !== paneId || pane.agent || pane.terminal_id !== shellTerminal)
        throw new OperationError("target_changed", "等待 shell 时目标已改变。");
    }
    try {
      result = object(
        await client.transport.call(
          "agent.start",
          { pane_id: paneId, kind, name, ...(args.length ? { args } : {}), timeout_ms: 30_000 },
          signal,
          Math.max(32_000, client.transport.timeoutMs),
        ),
      );
      break;
    } catch (error) {
      if (!(error instanceof OperationError) || error.code !== "agent_pane_busy") throw error;
      const pane = await client.pane(paneId, signal);
      if (pane.pane_id !== paneId || pane.agent || !string(pane.terminal_id)) throw error;
      if (shellTerminal && shellTerminal !== pane.terminal_id) throw error;
      shellTerminal = string(pane.terminal_id);
    }
  }
  let agent = await client.normalize(result.agent, signal);
  if (
    args.length &&
    (!Array.isArray(result.argv) ||
      result.argv.length !== args.length + 1 ||
      args.some((arg, index) => Array.isArray(result.argv) && result.argv[index + 1] !== arg))
  ) {
    throw new OperationError(
      "agent_options_unconfirmed",
      "herdr 未确认启动参数，不能投递任务。",
      "unknown",
    );
  }
  const terminalId = agent.terminalId;
  if (!terminalId)
    throw new OperationError("invalid_response", "agent 启动结果缺少 terminal ID。", "unknown");
  const readySignal = deadline(30_000, options.signal);
  for (;;) {
    if (
      agent.paneId !== paneId ||
      agent.terminalId !== terminalId ||
      agent.name !== name ||
      (agent.kind && agent.kind !== kind)
    ) {
      throw new OperationError("target_changed", "启动的 agent 已不属于原执行位置。", "unknown");
    }
    if (agent.status === "blocked") return agent;
    if (
      (agent.status === "idle" || agent.status === "done") &&
      agent.interactiveReady &&
      !agent.launchPending &&
      agent.kind === kind
    )
      return agent;
    if ((agent.status === "idle" || agent.status === "done") && !agent.launchPending)
      throw new OperationError("agent_start_failed", "agent 在进入交互状态前退出。", "unknown");
    try {
      await pause(100, readySignal);
      agent = await client.get(paneId, readySignal);
    } catch (cause) {
      throw new OperationError("startup_unconfirmed", "agent 启动结果尚未确认。", "unknown", {
        cause,
      });
    }
  }
}
