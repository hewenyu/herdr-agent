import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../../src/config/types.js";
import { OperationError, safeError } from "../../src/core/errors.js";
import type { HerdrPort, PlatformPort } from "../../src/core/ports.js";
import type { ExecutionRef } from "../../src/core/types.js";
import { HerdrRuntime } from "../../src/herdr/index.js";

export function redactor(config: AppConfig): (text: string) => string {
  const secrets = [
    config.ai.apiKey,
    config.jev?.apiKey,
    config.feishu.appSecret,
    config.memory.apiKey,
    ...Object.values(config.memory.users).map((memory) => memory.apiKey),
  ].filter((value): value is string => !!value);
  return (text) =>
    secrets
      .reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text)
      .replace(/https?:\/\/[^\s"']+/g, "[redacted-url]")
      .replace(/apikey_[a-zA-Z0-9_]+/g, "[redacted-key]");
}

/** All platform operations fail closed; this harness never constructs a Feishu client. */
export function forbiddenPlatform(attempts: string[]): PlatformPort {
  const denied = async (): Promise<never> => {
    attempts.push("platform_operation_rejected");
    throw new OperationError("acceptance_platform_forbidden", "本地验收禁止平台操作。");
  };
  return {
    start: denied,
    subscribeTasks: denied,
    stop: denied,
    sendText: denied,
    sendCard: denied,
    uploadFile: denied,
    sendFile: denied,
    updateCard: denied,
    createTask: denied,
    getTask: denied,
    updateTask: denied,
    createGroup: denied,
    deleteGroup: denied,
    getGroupStatus: denied,
  };
}

/** Only pane IDs returned by this instance's workspace.create can be mutated. */
export function ownedRuntime(config: AppConfig, root: string, signal: AbortSignal) {
  const native = new HerdrRuntime(config.herdr);
  const owned = new Map<string, ExecutionRef>();
  const closed = new Set<string>();
  let started = 0;
  let promptAttempts = 0;
  let peakAgents = 0;
  const capacityReached: string[] = [];
  const limit = (reason: string): never => {
    capacityReached.push(reason);
    throw new OperationError("acceptance_agent_limit", "本轮最多启动两个原生参与者。");
  };
  const check = (ref: ExecutionRef) => {
    const expected = owned.get(ref.paneId);
    if (
      !expected ||
      expected.workspaceId !== ref.workspaceId ||
      expected.cwd !== ref.cwd ||
      expected.kind !== ref.kind
    )
      throw new OperationError("acceptance_not_owned", "验收不能操作其他任务的 pane。");
  };
  const within = async (path: string) => {
    const resolved = await realpath(path);
    const subpath = relative(await realpath(root), resolved);
    if (subpath === ".." || subpath.startsWith(`..${sep}`) || subpath.startsWith(sep))
      throw new OperationError("acceptance_directory", "验收执行目录必须属于本轮临时项目。");
    return resolved;
  };
  const capacity = async () => {
    const agents = (await native.list(signal)).filter((agent) => agent.kind);
    peakAgents = Math.max(peakAgents, agents.length);
    // Reserve the third concurrent agent slot for the supervising root agent.
    if (agents.some((agent) => !owned.has(agent.paneId)))
      throw new OperationError(
        "acceptance_foreign_agents",
        "存在其他原生 agent，未启动验收参与者。",
      );
    if (agents.length >= 2 || started >= 2) limit("capacity_reached");
  };
  const port: HerdrPort = {
    ping: () => native.ping(signal),
    list: () => native.list(signal),
    get: (paneId) => {
      if (!owned.has(paneId))
        throw new OperationError("acceptance_not_owned", "不能读取其他参与者。");
      return native.get(paneId, signal);
    },
    paneExists: (paneId) => {
      if (!owned.has(paneId))
        throw new OperationError("acceptance_not_owned", "不能读取其他参与者。");
      return native.paneExists(paneId, signal);
    },
    createWorkspace: async (cwd, label) => {
      await within(cwd);
      if (owned.size >= 2) limit("workspace_capacity_reached");
      await capacity();
      const workspace = await native.createWorkspace(cwd, label, signal);
      owned.set(workspace.paneId, { ...workspace, kind: "codex" });
      return workspace;
    },
    startAgent: async (paneId, kind, name, options) => {
      const ref = owned.get(paneId);
      if (!ref) throw new OperationError("acceptance_not_owned", "启动位置不属于本轮。");
      await capacity();
      for (const directory of options.directories) await within(directory);
      owned.set(paneId, { ...ref, kind });
      // Count attempts before the effect: an unknown start must not gain another slot.
      started++;
      const agent = await native.startAgent(paneId, kind, name, { ...options, signal });
      owned.set(paneId, { ...ref, kind, sessionId: agent.sessionId });
      peakAgents = Math.max(peakAgents, (await native.list(signal)).filter((a) => a.kind).length);
      return agent;
    },
    send: async (ref, text, options) => {
      check(ref);
      promptAttempts++;
      return native.send(ref, text, { ...options, signal });
    },
    interrupt: async (ref) => {
      check(ref);
      return native.interrupt(ref, signal);
    },
    screen: async (ref) => {
      check(ref);
      return native.screen(ref, signal);
    },
    answer: async () => {
      throw new OperationError("acceptance_approval", "本地验收不自动回答原生审批。");
    },
    trustDirectory: async (ref, directory, guard) => {
      check(ref);
      await within(directory);
      return native.trustDirectory(ref, directory, { ...guard, signal });
    },
    close: async (ref) => {
      check(ref);
      await native.close(ref, signal);
      closed.add(ref.paneId);
    },
    transcript: async (ref, cursor) => {
      check(ref);
      return native.transcript(ref, cursor);
    },
    conversation: async (ref, receipt, cursor) => {
      check(ref);
      return native.conversation(ref, receipt, cursor);
    },
    sampleLastReply: async (ref) => {
      check(ref);
      return native.sampleLastReply(ref);
    },
    initialInput: async (ref, receipt) => {
      check(ref);
      return native.initialInput(ref, receipt);
    },
  };
  return {
    port,
    native,
    owned,
    stats: () => ({
      started,
      promptAttempts,
      peakNativeAgents: peakAgents,
      maxNativeAgents: 2,
      capacityReached,
    }),
    async snapshots() {
      const snapshots: Array<Record<string, unknown>> = [];
      for (const ref of owned.values()) {
        const pane = await native.client
          .pane(ref.paneId, AbortSignal.timeout(5000))
          .catch(() => undefined);
        const screen = await native.client
          .read(ref.paneId, "visible", AbortSignal.timeout(5000))
          .catch(() => undefined);
        // Read-only CLI diagnostics can inspect the shell left after an agent exits.
        // Do not expand the application's restricted HerdrTransport method list.
        const terminal = await promisify(execFile)(
          "herdr",
          ["pane", "read", ref.paneId, "--source", "recent", "--lines", "100"],
          {
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            env: { ...process.env, HERDR_SOCKET_PATH: native.client.transport.socketPath },
          },
        )
          .then(({ stdout }) => stdout)
          .catch((error) => ({ errorCode: safeError(error).code }));
        snapshots.push({ ref, pane, screen, terminal });
      }
      return snapshots;
    },
    async cleanup() {
      const results: Array<{ paneId: string; closed: boolean; errorCode?: string }> = [];
      for (const ref of owned.values()) {
        try {
          if (!closed.has(ref.paneId)) await native.close(ref, AbortSignal.timeout(15_000));
          closed.add(ref.paneId);
          results.push({ paneId: ref.paneId, closed: true });
        } catch (error) {
          results.push({ paneId: ref.paneId, closed: false, errorCode: safeError(error).code });
        }
      }
      return results;
    },
  };
}
