import { OperationError } from "../core/errors.js";
import type { AgentSnapshot } from "../core/types.js";
import { object, snapshot, string } from "./protocol.js";
import { directoryTrustKeys, showsStartupMenu, trustKeys } from "./screen.js";
import type { HerdrTransport } from "./transport.js";

export interface ScreenRead {
  text: string;
  truncated: boolean;
}

export class HerdrClient {
  constructor(readonly transport: HerdrTransport) {}

  async ping(signal?: AbortSignal): Promise<{ version: string; protocol: number }> {
    const result = object(await this.transport.call("ping", {}, signal));
    if (typeof result.protocol !== "number" || result.protocol < 19)
      throw new OperationError("protocol_too_old", "需要 herdr protocol 19 或更新版本。");
    return { version: string(result.version), protocol: result.protocol };
  }

  async read(
    target: string,
    source: "visible" | "detection",
    signal?: AbortSignal,
  ): Promise<ScreenRead> {
    const result = object(await this.transport.call("agent.read", { target, source }, signal));
    const read = object(result.read);
    if (typeof read.text !== "string")
      throw new OperationError("invalid_response", "herdr 屏幕内容无效。", "unknown");
    return { text: read.text, truncated: read.truncated === true };
  }

  async normalize(value: unknown, signal?: AbortSignal): Promise<AgentSnapshot> {
    const agent = snapshot(value);
    if (
      (agent.kind === "codex" || agent.kind === "claude") &&
      agent.status !== "working" &&
      agent.status !== "blocked" &&
      !(agent.sessionId && agent.interactiveReady && !agent.launchPending)
    ) {
      try {
        const screen = await this.read(agent.paneId, "visible", signal);
        if (
          !screen.truncated &&
          (showsStartupMenu(screen.text) ||
            directoryTrustKeys(agent.kind, screen.text, agent.cwd) ||
            (agent.kind === "codex" && trustKeys(screen.text)))
        )
          agent.status = "blocked";
      } catch {
        /* The status remains unconfirmed; control performs its own preflight. */
      }
    }
    return agent;
  }

  async get(paneId: string, signal?: AbortSignal): Promise<AgentSnapshot> {
    const result = object(await this.transport.call("agent.get", { target: paneId }, signal));
    return this.normalize(result.agent, signal);
  }

  async list(signal?: AbortSignal): Promise<AgentSnapshot[]> {
    const result = object(await this.transport.call("agent.list", {}, signal));
    if (!Array.isArray(result.agents))
      throw new OperationError("invalid_response", "herdr agent 列表无效。", "unknown");
    return Promise.all(result.agents.map((agent) => this.normalize(agent, signal)));
  }

  async pane(paneId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = object(await this.transport.call("pane.get", { pane_id: paneId }, signal));
    return object(result.pane);
  }

  async prompt(
    paneId: string,
    text: string,
    queued: boolean,
    signal?: AbortSignal,
  ): Promise<AgentSnapshot> {
    const wait = queued
      ? undefined
      : { until: ["working", "blocked", "idle", "done"], timeout_ms: 8_000 };
    const result = object(
      await this.transport.call(
        "agent.prompt",
        { target: paneId, text, ...(wait ? { wait } : {}) },
        signal,
        queued ? this.transport.timeoutMs : Math.max(this.transport.timeoutMs, 10_000),
      ),
    );
    return snapshot(result.agent);
  }

  async keys(paneId: string, keys: string[], signal?: AbortSignal): Promise<void> {
    await this.transport.call("agent.send_keys", { target: paneId, keys }, signal);
  }
}
