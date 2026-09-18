import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { Store } from "../../src/storage/store.js";

export async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-migration-"));
  const store = new Store(":memory:");
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const write = async (name: string, value: unknown) => {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), JSON.stringify(value));
  };
  return { dir, store, write };
}
export function task(id = "task-1", changes: Record<string, unknown> = {}) {
  return {
    id,
    owner_id: "owner",
    entry_chat_id: "dm",
    project: "old-project",
    path: "/project",
    directories: ["/project", "/second"],
    agent_cwd: "/agent-worktree",
    agent: "codex",
    title: "旧任务",
    task_guid: `remote-${id}`,
    task_url: "https://example.test/task",
    chat_id: `group-${id}`,
    workspace_id: "workspace",
    pane_id: `pane-${id}`,
    session_id: `native-${id}`,
    started: true,
    prompt_sent: true,
    bypass: true,
    status: "review",
    result: "旧结果",
    result_delivered: true,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    ...changes,
  };
}
export function conversation(changes: Record<string, unknown> = {}) {
  return {
    version: 1,
    owner: "owner",
    chat: "dm",
    messages: [
      { role: "user", content: "旧用户消息", turn_id: "old-message" },
      { role: "assistant", content: "旧回复", turn_id: "old-message" },
    ],
    receipts: {
      "old-message": {
        finished: true,
        reply: "旧回复",
        delivery: "delivered",
        delivery_ids: ["sent-id"],
      },
    },
    memory: { summary: "当前摘要", revision: "revision" },
    ...changes,
  };
}
