import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort, PlatformPort, RemoteTask } from "../../src/core/ports.js";
import type {
  ActorContext,
  AgentKind,
  AgentSnapshot,
  Delivery,
  ExecutionRef,
  TaskCreateInput,
  TranscriptEntry,
} from "../../src/core/types.js";
import { ProjectCatalog } from "../../src/projects/catalog.js";
import { Store } from "../../src/storage/store.js";
import type { TaskHooks } from "../../src/tasks/context.js";
import { TaskService } from "../../src/tasks/service.js";

export class FakeHerdr implements HerdrPort {
  agents = new Map<string, AgentSnapshot>();
  outputs = new Map<string, TranscriptEntry[]>();
  creates = 0;
  starts = 0;
  closes = 0;
  sends: Array<{ pane: string; text: string }> = [];
  createError?: Error;
  sendError?: Error;
  getError?: Error;
  closeError?: Error;
  delivery: Delivery = { status: "delivered", acked: true, verified: true, attempts: 1 };
  async ping() {
    return { version: "test", protocol: 1 };
  }
  async list() {
    return [...this.agents.values()];
  }
  async get(id: string) {
    if (this.getError) throw this.getError;
    const agent = this.agents.get(id);
    if (!agent) throw new OperationError("agent_not_found", "missing");
    return { ...agent };
  }
  async createWorkspace(cwd: string) {
    this.creates++;
    if (this.createError) throw this.createError;
    return { workspaceId: `w${this.creates}`, paneId: `p${this.creates}`, cwd };
  }
  async startAgent(
    paneId: string,
    kind: AgentKind,
    name: string,
    options: { directories: string[] },
  ) {
    this.starts++;
    const agent: AgentSnapshot = {
      paneId,
      workspaceId: `w${paneId.slice(1)}`,
      kind,
      name,
      status: "idle",
      cwd: options.directories[0] ?? "",
      sessionId: `session-${paneId}`,
      stateSeq: "1",
      interactiveReady: true,
      launchPending: false,
    };
    this.agents.set(paneId, agent);
    return { ...agent };
  }
  async send(ref: ExecutionRef, text: string) {
    this.sends.push({ pane: ref.paneId, text });
    if (this.sendError) throw this.sendError;
    const agent = this.agents.get(ref.paneId);
    if (agent && this.delivery.verified) agent.status = "working";
    return this.delivery;
  }
  async interrupt(ref: ExecutionRef) {
    const agent = this.agents.get(ref.paneId);
    if (agent) agent.status = "idle";
  }
  async screen(ref: ExecutionRef) {
    return { agent: await this.get(ref.paneId), text: "screen", question: "", options: [] };
  }
  async answer() {}
  async close(ref: ExecutionRef) {
    this.closes++;
    if (this.closeError) throw this.closeError;
    this.agents.delete(ref.paneId);
  }
  async transcript(ref: ExecutionRef, cursor?: string) {
    const entries = this.outputs.get(ref.paneId) ?? [];
    return {
      entries: cursor === undefined ? [] : entries.slice(Number(cursor)),
      cursor: String(entries.length),
    };
  }
  async sampleLastReply(ref: ExecutionRef) {
    return this.outputs.get(ref.paneId)?.at(-1);
  }
  finish(pane: string, text: string) {
    const output = this.outputs.get(pane) ?? [];
    output.push({
      id: `out-${output.length}`,
      role: "assistant",
      text,
      final: true,
      timestamp: new Date().toISOString(),
    });
    this.outputs.set(pane, output);
    const agent = this.agents.get(pane);
    if (agent) agent.status = "done";
  }
}
export class FakePlatform implements PlatformPort {
  tasks = new Map<string, RemoteTask>();
  creates = 0;
  groups = 0;
  deletions = 0;
  updates = 0;
  updateCalls: Array<{ id: string; description: string; completedAt?: string }> = [];
  getError?: Error;
  updateError?: Error;
  async start() {}
  async stop() {}
  async sendText() {
    return "message";
  }
  async sendCard() {
    return "card";
  }
  async updateCard() {}
  async createTask(input: { title: string; description: string }) {
    this.creates++;
    const task = {
      id: `remote${this.creates}`,
      url: "https://example.invalid/task",
      description: input.description,
      completedAt: "0",
    };
    this.tasks.set(task.id, task);
    return { ...task };
  }
  async getTask(id: string) {
    if (this.getError) throw this.getError;
    const task = this.tasks.get(id);
    if (!task) throw new Error("missing");
    return { ...task };
  }
  async updateTask(id: string, description: string, completedAt?: string) {
    this.updates++;
    this.updateCalls.push({ id, description, completedAt });
    if (this.updateError) throw this.updateError;
    const task = this.tasks.get(id);
    if (!task) throw new Error("missing");
    task.description = description;
    if (completedAt !== undefined) task.completedAt = completedAt;
  }
  async createGroup() {
    return `group${++this.groups}`;
  }
  async deleteGroup() {
    this.deletions++;
  }
}
export const actor: ActorContext = {
  ownerId: "owner",
  chatId: "entry",
  sessionId: "pi-session",
  messageId: "create",
};
export const discussion: TaskCreateInput = {
  kind: "discussion",
  title: "讨论需求",
  requirements: "只讨论，不修改文件",
  participants: [
    { kind: "claude", name: "Claude" },
    { kind: "codex", name: "Codex" },
  ],
};
export function setup(hooks: TaskHooks = {}) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-tasks-"));
  const store = new Store(join(directory, "state.sqlite"));
  const herdr = new FakeHerdr();
  const platform = new FakePlatform();
  const config = loadConfig({ stateDir: directory, home: directory, cwd: directory, env: {} });
  config.tasks.enabled = true;
  config.feishu.allowedOpenIds = ["owner", "other"];
  config.runtime.groupRetention = "delete";
  const catalog = new ProjectCatalog(
    store,
    {
      projects: [{ name: "project", directories: [directory], agent: "codex" }],
      defaultProject: "project",
      bypass: true,
    },
    directory,
  );
  const options = { store, herdr, platform, config, catalog, hooks };
  const service = new TaskService(options);
  return {
    directory,
    store,
    herdr,
    platform,
    config,
    catalog,
    service,
    options,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
