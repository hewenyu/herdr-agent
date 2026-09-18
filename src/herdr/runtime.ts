import { OperationError } from "../core/errors.js";
import type { HerdrPort } from "../core/ports.js";
import type { AgentScreen, ExecutionRef } from "../core/types.js";
import { TranscriptReader } from "../transcripts/reader.js";
import { TranscriptResolver } from "../transcripts/resolver.js";
import { HerdrClient } from "./client.js";
import { AgentControl } from "./control.js";
import { createWorkspace, startAgent } from "./lifecycle.js";
import { cleanScreen, directoryTrustKeys, parseOptions, trustKeys } from "./screen.js";
import { resolveSocketPath } from "./socket-path.js";
import { HerdrTransport } from "./transport.js";

export class HerdrRuntime implements HerdrPort {
  readonly client: HerdrClient;
  private readonly control: AgentControl;
  private readonly transcripts: TranscriptReader;

  constructor(options: { socket?: string; timeoutMs?: number; homeDir?: string } = {}) {
    this.client = new HerdrClient(
      new HerdrTransport(
        resolveSocketPath(options.socket, process.env, options.homeDir),
        options.timeoutMs,
      ),
    );
    this.control = new AgentControl(this.client);
    this.transcripts = new TranscriptReader(new TranscriptResolver(options.homeDir));
  }

  ping: HerdrPort["ping"] = (signal) => this.client.ping(signal);
  list: HerdrPort["list"] = (signal) => this.client.list(signal);
  get: HerdrPort["get"] = (paneId, signal) => this.client.get(paneId, signal);
  createWorkspace: HerdrPort["createWorkspace"] = (cwd, label, signal) =>
    createWorkspace(this.client, cwd, label, signal);
  startAgent: HerdrPort["startAgent"] = (paneId, kind, name, options) =>
    startAgent(this.client, paneId, kind, name, options);
  send: HerdrPort["send"] = (ref, text, options) => this.control.send(ref, text, options);
  interrupt: HerdrPort["interrupt"] = (ref, signal) => this.control.interrupt(ref, signal);
  answer: HerdrPort["answer"] = (ref, key, guard) => this.control.answer(ref, key, guard);
  trustDirectory: NonNullable<HerdrPort["trustDirectory"]> = (ref, directory, guard) =>
    this.control.trustDirectory(ref, directory, guard);

  async screen(ref: ExecutionRef, signal?: AbortSignal): Promise<AgentScreen> {
    const agent = await this.control.current(ref, signal);
    let read = await this.client.read(
      ref.paneId,
      agent.status === "blocked" ? "detection" : "visible",
      signal,
    );
    if (agent.status === "blocked") {
      const visible = await this.client.read(ref.paneId, "visible", signal);
      if (
        !visible.truncated &&
        (directoryTrustKeys(ref.kind, visible.text, ref.cwd) ||
          (ref.kind === "codex" && trustKeys(visible.text)))
      )
        read = visible;
    }
    const text = cleanScreen(read.text);
    const options = read.truncated ? [] : parseOptions(text);
    // Unnumbered native menus still need an explicit human navigation path.
    // These choices never become automatic approval keys.
    if (agent.status === "blocked" && !read.truncated && text.trim() && !options.length) {
      options.push(
        { key: "up", label: "上移选择（不确认）" },
        { key: "down", label: "下移选择（不确认）" },
        { key: "enter", label: "确认当前选项（Enter）" },
      );
    }
    return {
      agent,
      text: read.truncated ? `${text}\n[屏幕读取被截断]` : text,
      question: text,
      options,
    };
  }

  async close(ref: ExecutionRef, signal?: AbortSignal): Promise<void> {
    // An exited agent leaves an owned shell pane behind; cleanup must still work.
    const pane = await this.client.pane(ref.paneId, signal).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (!pane) return;
    if (
      pane.pane_id !== ref.paneId ||
      pane.workspace_id !== ref.workspaceId ||
      (pane.agent && pane.agent !== ref.kind)
    ) {
      throw new OperationError("target_changed", "关闭目标已变化，未清理其他执行窗口。");
    }
    await this.client.transport.call("pane.close", { pane_id: ref.paneId }, signal);
  }

  private async liveRef(ref: ExecutionRef): Promise<ExecutionRef> {
    try {
      const agent = await this.control.current(ref);
      return { ...ref, sessionId: agent.sessionId ?? ref.sessionId };
    } catch (error) {
      // Final transcript content survives a native agent exiting normally.
      if (missing(error) && (ref.sessionId || ref.transcriptReceipt)) return ref;
      throw error;
    }
  }

  transcript: HerdrPort["transcript"] = async (ref, cursor) =>
    this.transcripts.page(await this.liveRef(ref), cursor);
  async sampleLastReply(ref: ExecutionRef) {
    return this.transcripts.sampleLastReply(await this.liveRef(ref));
  }

  async initialInput(ref: ExecutionRef, receipt: string): Promise<string | undefined> {
    const before = await this.control.current(ref);
    if (before.cwd !== ref.cwd || (ref.sessionId && ref.sessionId !== before.sessionId)) return;
    const text = await this.transcripts.initialInput(
      { ...ref, sessionId: before.sessionId },
      receipt,
    );
    const after = await this.control.current(ref);
    if (
      after.cwd !== before.cwd ||
      after.sessionId !== before.sessionId ||
      after.terminalId !== before.terminalId
    )
      return;
    return text;
  }
}

function missing(error: unknown): boolean {
  return (
    error instanceof OperationError &&
    ["agent_not_found", "pane_not_found", "not_found"].includes(error.code)
  );
}
