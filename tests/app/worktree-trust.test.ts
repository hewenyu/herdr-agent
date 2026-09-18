import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { DirectoryTrust } from "../../src/app/directory-trust.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { AgentSnapshot, Task } from "../../src/core/types.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { HerdrTransport } from "../../src/herdr/transport.js";
import { authorizedWorktreeRoot } from "../../src/projects/worktree-trust.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import { logger, setup } from "./helpers.js";

const execute = promisify(execFile);

async function fixture() {
  const h = setup();
  const root = await realpath(h.directory);
  await execute("git", ["-C", root, "init"]);
  await execute("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await h.app.projects.save({ name: "project", agent: "codex", directories: [root] });
  const task = (await h.app.dispatch("task.create", {
    kind: "development",
    title: "worktree",
    requirements: "task",
    project: "project",
    directoryMode: "worktree",
    participants: [{ kind: "codex" }],
  })) as Task;
  const start = h.herdr.startAgent.bind(h.herdr);
  h.herdr.startAgent = async (...args) => {
    const a = await start(...args);
    a.status = "blocked";
    a.sessionId = undefined;
    h.herdr.agents.set(a.paneId, a);
    return a;
  };
  await h.app.tasks.reconcile(task.id);
  const current = h.store.get<Task>("tasks", task.id);
  assert.ok(current);
  const participant = h.app.tasks.records.participants(current)[0];
  assert.ok(participant?.execution);
  const actor = {
    ownerId: "owner",
    chatId: "entry",
    sessionId: "s",
    taskId: task.id,
    messageId: "trust",
  };
  return { ...h, task: current, participant, actor, root };
}

test("worktree authorization uses frozen original inputs or verified legacy receipt, never current catalog", async () => {
  const h = await fixture();
  try {
    assert.deepEqual(h.task.sourceDirectories, [h.root]);
    assert.equal(await authorizedWorktreeRoot(h.store, h.task), h.root);
    const legacy = { ...h.task, sourceDirectories: undefined };
    h.store.set("catalog", "current", { projects: [], defaultProject: "", bypass: true });
    assert.equal(await authorizedWorktreeRoot(h.store, legacy), h.root);
    assert.equal(
      await authorizedWorktreeRoot(h.store, { ...h.task, sourceDirectories: ["/unapproved"] }),
      undefined,
    );
    assert.equal(
      await authorizedWorktreeRoot(h.store, { ...h.task, directories: [h.root] }),
      undefined,
    );
    const key = `${h.task.id}:worktree`;
    const op = h.store.get<OperationReceipt>("operations", key);
    assert.ok(op);
    for (const patch of [
      { state: "uncertain" },
      { fingerprint: "different" },
      { result: [h.root] },
    ]) {
      h.store.set("operations", key, { ...op, ...patch });
      assert.equal(await authorizedWorktreeRoot(h.store, legacy), undefined);
    }
    h.store.set("operations", key, op);
    await execute("git", ["-C", h.task.directories[0] as string, "checkout", "-b", "unrelated"]);
    assert.equal(await authorizedWorktreeRoot(h.store, legacy), undefined);
  } finally {
    await h.close();
  }
});

test("verified worktree context re-evaluates an old no-write decision but freezes every confirmed or unknown attempt", async () => {
  for (const previousState of ["failed", "pending", "uncertain", "done"] as const) {
    const h = await fixture();
    try {
      h.task.sourceDirectories = undefined;
      h.store.set("tasks", h.task.id, h.task);
      const ref = h.participant.execution;
      assert.ok(ref);
      const screen = await h.herdr.screen(ref);
      const prefix = `${h.participant.id}:directory-trust`;
      h.store.set(
        "directory_trust_decisions",
        stableId(h.participant.id, ref.paneId, screen.agent.stateSeq),
        { confirmed: false },
      );
      h.store.set("operations", `${prefix}:${screen.agent.stateSeq}`, {
        id: `${prefix}:${screen.agent.stateSeq}`,
        state: previousState,
        fingerprint: "old",
        updatedAt: new Date().toISOString(),
        error: {
          code: "directory_trust_required",
          message: "old preflight",
          outcome: "not_executed",
        },
      });
      let confirms = 0;
      (h.herdr as HerdrPort).trustDirectory = async (_ref, cwd, guard) => {
        assert.equal(cwd, ref.cwd);
        assert.equal(guard.worktreeRoot, h.root);
        confirms++;
      };
      h.engine.handler = async (turn) => {
        assert.equal(JSON.parse(turn.prompt).authorizedWorktreeRoot, h.root);
        await turn.tools[0]?.execute({}, turn.actor);
        return { text: "confirmed", messages: [] };
      };
      const controller = new DirectoryTrust(h.store, h.herdr, h.engine, logger, h.app.signal);
      assert.equal(
        await controller.handle(h.task, h.participant, screen, h.actor),
        previousState === "failed",
      );
      assert.equal(confirms, previousState === "failed" ? 1 : 0);
      await controller.handle(h.task, h.participant, screen, h.actor);
      assert.equal(confirms, previousState === "failed" ? 1 : 0);
    } finally {
      await h.close();
    }
  }
});

test("worktree tool rechecks original authorization after model evaluation", async () => {
  const h = await fixture();
  try {
    (h.herdr as HerdrPort).trustDirectory = async () =>
      assert.fail("changed origin must not reach native input");
    h.engine.handler = async (turn) => {
      h.store.set("tasks", h.task.id, { ...h.task, sourceDirectories: ["/different"] });
      await turn.tools[0]?.execute({}, turn.actor);
      return { text: "", messages: [] };
    };
    const ref = h.participant.execution;
    assert.ok(ref);
    const controller = new DirectoryTrust(h.store, h.herdr, h.engine, logger, h.app.signal);
    assert.equal(
      await controller.handle(h.task, h.participant, await h.herdr.screen(ref), h.actor),
      false,
    );
  } finally {
    await h.close();
  }
});

test("native worktree confirmation rechecks Git ownership as well as pane guards before writing", async () => {
  const h = await fixture();
  try {
    const ref = h.participant.execution;
    assert.ok(ref);
    const client = new HerdrClient(new HerdrTransport("/unused"));
    let agent: AgentSnapshot = {
      ...ref,
      status: "blocked",
      stateSeq: "3",
      terminalId: "term",
      interactiveReady: true,
      launchPending: false,
    };
    const text = `> You are in ${ref.cwd}\n\n  Note: You’re in a subdirectory of a Git project.\n  Trusting will apply to the repository root:\n  ${h.root}\n\n  Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit\n  Press enter to continue`;
    let sent = false;
    let writes = 0;
    client.get = async () => ({ ...agent });
    client.read = async () => ({ text: sent ? "Ready for input" : text, truncated: false });
    client.keys = async () => {
      writes++;
      sent = true;
      agent = { ...agent, status: "idle" };
    };
    const guard = {
      stateSeq: "3",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      worktreeRoot: h.root,
    };
    const control = new AgentControl(client);
    await assert.rejects(
      control.trustDirectory(ref, ref.cwd, { ...guard, worktreeRoot: "/other" }),
      { code: "directory_mismatch" },
    );
    await assert.rejects(
      control.trustDirectory(ref, ref.cwd, { ...guard, worktreeRoot: undefined }),
      { code: "directory_trust_required" },
    );
    assert.equal(writes, 0);
    await control.trustDirectory(ref, ref.cwd, guard);
    assert.equal(writes, 1);
    sent = false;
    agent.status = "blocked";
    let reads = 0;
    client.read = async () => {
      if (++reads === 2)
        await execute("git", ["-C", ref.cwd, "checkout", "-b", "changed-before-confirm"]);
      return { text, truncated: false };
    };
    await assert.rejects(
      new AgentControl(client).trustDirectory(ref, ref.cwd, guard),
      (error: unknown) => error instanceof OperationError && error.code === "directory_mismatch",
    );
    assert.equal(writes, 1);
  } finally {
    await h.close();
  }
});
