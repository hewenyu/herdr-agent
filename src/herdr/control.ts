import { OperationError } from "../core/errors.js";
import type { AgentSnapshot, Delivery, ExecutionRef } from "../core/types.js";
import type { HerdrClient } from "./client.js";
import { composerOccupied, verifyEcho, verifyReceipt } from "./echo.js";
import { showsDialog, trustKeys } from "./screen.js";
import { pause } from "./timing.js";

const keys = new Set([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "y",
  "n",
  "enter",
  "esc",
  "up",
  "down",
  "tab",
]);

export function verifyIdentity(ref: ExecutionRef, agent: AgentSnapshot): void {
  if (
    agent.paneId !== ref.paneId ||
    agent.workspaceId !== ref.workspaceId ||
    agent.kind !== ref.kind
  ) {
    throw new OperationError("target_changed", "执行位置已变化，未向其他 agent 投递。");
  }
}

export class AgentControl {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly client: HerdrClient) {}

  private async serial<T>(paneId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(paneId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pending.set(paneId, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.pending.get(paneId) === next) this.pending.delete(paneId);
    }
  }

  async current(ref: ExecutionRef, signal?: AbortSignal): Promise<AgentSnapshot> {
    const agent = await this.client.get(ref.paneId, signal);
    verifyIdentity(ref, agent);
    return agent;
  }

  private async settle(ref: ExecutionRef, signal?: AbortSignal): Promise<AgentSnapshot> {
    let agent = await this.current(ref, signal);
    const begin = Date.now();
    let stable = begin;
    while (Date.now() - stable < 1_000 && Date.now() - begin < 10_000) {
      if (agent.status === "blocked")
        throw new OperationError("approval_required", "agent 正在等待人工审批。");
      await pause(250, signal);
      const next = await this.current(ref, signal);
      if (next.status !== agent.status) stable = Date.now();
      agent = next;
    }
    return agent;
  }

  async send(
    ref: ExecutionRef,
    text: string,
    options: { receipt?: string; signal?: AbortSignal } = {},
  ): Promise<Delivery> {
    if (!text.trim()) throw new OperationError("empty_prompt", "不能发送空消息。");
    return this.serial(ref.paneId, async () => {
      await this.settle(ref, options.signal);
      // An unreadable/truncated screen cannot rule out a permission menu.
      const before = await this.client.read(ref.paneId, "visible", options.signal);
      if (before.truncated)
        throw new OperationError("screen_incomplete", "屏幕内容不完整，请检查后重试。");
      if (showsDialog(before.text))
        throw new OperationError("approval_required", "屏幕存在审批菜单，正文未发送。");
      const agent = await this.current(ref, options.signal);
      if (agent.status === "blocked")
        throw new OperationError("approval_required", "agent 正在等待人工审批。");
      if (agent.launchPending || !["idle", "done", "working"].includes(agent.status))
        throw new OperationError("agent_not_ready", "agent 尚不能接收消息。");
      const queued = agent.status === "working";
      const body = composerOccupied(before.text) ? `\n${text}` : text;
      let acked = false;
      try {
        await this.client.prompt(ref.paneId, body, queued, options.signal);
        acked = true;
      } catch (error) {
        if (error instanceof OperationError && error.outcome === "not_executed") throw error;
        return {
          status: "unconfirmed",
          acked: false,
          verified: false,
          attempts: 1,
          detail: "投递结果未知；请先查看现场，不能自动重发。",
        };
      }
      let after: string | undefined;
      let mayHaveAnsweredDialog = false;
      try {
        if (queued) await pause(1_000, options.signal);
        const latest = await this.current(ref, options.signal);
        const screen = await this.client.read(ref.paneId, "visible", options.signal);
        if (!screen.truncated) after = screen.text;
        mayHaveAnsweredDialog = queued && (latest.status === "blocked" || showsDialog(screen.text));
      } catch {
        /* Acknowledged input with missing read-back remains unconfirmed. */
      }
      const verified =
        verifyEcho(before.text, after, text, queued) ||
        verifyReceipt(before.text, after, text, options.receipt, queued);
      return {
        status: verified ? (queued ? "queued" : "delivered") : "unconfirmed",
        acked,
        verified,
        attempts: 1,
        mayHaveAnsweredDialog,
      };
    });
  }

  private async writeKeys(ref: ExecutionRef, input: string[], signal?: AbortSignal): Promise<void> {
    try {
      await this.client.keys(ref.paneId, input, signal);
      await pause(3_000, signal);
      await this.current(ref, signal);
    } catch (cause) {
      throw new OperationError(
        "input_unconfirmed",
        "按键已尝试，结果未确认；不要重复操作。",
        "unknown",
        { cause },
      );
    }
  }

  async interrupt(ref: ExecutionRef, signal?: AbortSignal): Promise<void> {
    return this.serial(ref.paneId, async () => {
      await this.current(ref, signal);
      await this.writeKeys(ref, ["esc"], signal);
    });
  }

  async answer(
    ref: ExecutionRef,
    key: string,
    guard: { stateSeq: string; sessionId?: string; expiresAt: string; signal?: AbortSignal },
  ): Promise<void> {
    if (!keys.has(key)) throw new OperationError("invalid_key", "不支持此审批按键。");
    const validate = async () => {
      const expires = Date.parse(guard.expiresAt);
      if (!Number.isFinite(expires) || expires < Date.now() || expires > Date.now() + 630_000)
        throw new OperationError("stale_guard", "审批卡片已过期或时间无效。");
      const agent = await this.current(ref, guard.signal);
      if (
        agent.status !== "blocked" ||
        agent.stateSeq !== guard.stateSeq ||
        (guard.sessionId && guard.sessionId !== agent.sessionId)
      )
        throw new OperationError("stale_guard", "审批目标或问题已变化，请刷新卡片。");
    };
    return this.serial(ref.paneId, async () => {
      await validate();
      let input = [key];
      if (ref.kind === "codex" && key === "1") {
        const read = await this.client.read(ref.paneId, "visible", guard.signal);
        if (!read.truncated) input = trustKeys(read.text) ?? input;
        await validate();
      }
      await this.writeKeys(ref, input, guard.signal);
    });
  }
}
