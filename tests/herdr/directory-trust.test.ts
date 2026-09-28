import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { AgentKind, AgentSnapshot, ExecutionRef } from "../../src/core/types.js";
import { HerdrClient } from "../../src/herdr/client.js";
import { AgentControl } from "../../src/herdr/control.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";
import {
  directoryTrustKeys,
  parseOptions,
  showsDialog,
  trustKeys,
} from "../../src/herdr/screen.js";
import { HerdrTransport } from "../../src/herdr/transport.js";

const claude = await readFile(
  new URL("../fixtures/native/claude-directory-trust.txt", import.meta.url),
  "utf8",
);
const claudeDirectory =
  "/Users/yueban/herder-agent-code/validation-trust-claude-0918-1789689600588";
const codex =
  "> You are in /tmp\nDo you trust the contents of this directory?\n› 1. Yes, continue\n2. No, quit\nPress enter to continue";
const nativeCodex = await readFile(
  new URL("../fixtures/native/codex-directory-trust.txt", import.meta.url),
  "utf8",
);
const nativeCodexDirectory = "/Users/yueban/herder-agent-code/validation-node-pi-0918";
// Captured Codex 0.157.1 startup screen; only the private workspace path is replaced.
const codexFolder = `
  Folder access
  /tmp/myrix-workflow-acceptance/isolated-discussion
  /project

  Trust this folder? Codex can read, edit, and run
  files here, subject to your permission settings.
  Folder settings can run code automatically, even
  without a model request. Continue only if you
  trust these files. Your trust decision will be
  saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back
`;
const codexFolderDirectory = "/tmp/myrix-workflow-acceptance/isolated-discussion/project";
const guard = () => ({ stateSeq: "3", expiresAt: new Date(Date.now() + 60_000).toISOString() });

class TrustClient extends HerdrClient {
  agent: AgentSnapshot;
  readonly ref: ExecutionRef;
  text: string;
  after = "Welcome to your coding agent\nReady for input";
  truncated = false;
  afterTruncated = false;
  sent = false;
  gets = 0;
  reads = 0;
  strokes: string[][] = [];
  error?: Error;
  beforeGet?: (count: number) => void;
  beforeRead?: (count: number) => void;
  constructor(kind: AgentKind = "claude") {
    super(new HerdrTransport("/not-used"));
    this.ref = {
      paneId: "w1:p1",
      workspaceId: "w1",
      kind,
      cwd: kind === "claude" ? claudeDirectory : nativeCodexDirectory,
    };
    this.agent = {
      ...this.ref,
      terminalId: "term1",
      status: "blocked",
      stateSeq: "3",
      interactiveReady: true,
      launchPending: false,
    };
    this.text = kind === "claude" ? claude : nativeCodex;
  }
  override async get() {
    this.gets++;
    this.beforeGet?.(this.gets);
    return { ...this.agent };
  }
  override async read() {
    this.reads++;
    this.beforeRead?.(this.reads);
    return {
      text: this.sent ? this.after : this.text,
      truncated: this.sent ? this.afterTruncated : this.truncated,
    };
  }
  override async keys(_target: string, input: string[]) {
    this.strokes.push(input);
    if (this.error) throw this.error;
    this.sent = true;
    this.agent.status = "idle";
  }
}

function folderClient(): TrustClient {
  const client = new TrustClient("codex");
  client.ref.cwd = codexFolderDirectory;
  client.agent.cwd = codexFolderDirectory;
  client.text = codexFolder;
  return client;
}

test("Codex folder-access template requires its exact native text and full wrapped directory", () => {
  assert.deepEqual(directoryTrustKeys("codex", codexFolder, codexFolderDirectory), ["enter"]);
  assert.deepEqual(
    directoryTrustKeys(
      "codex",
      codexFolder.replace("› 1.", "  1.").replace("  2.", "› 2."),
      codexFolderDirectory,
    ),
    ["up", "enter"],
  );
  assert.deepEqual(trustKeys(codexFolder), ["enter"]);
  assert.equal(showsDialog(codexFolder), true);
  assert.deepEqual(parseOptions(codexFolder), [
    { key: "1", label: "Trust and continue" },
    { key: "2", label: "Back to Agent Command Center" },
  ]);
  for (const text of [
    `Quoted example:\n${codexFolder}`,
    `${codexFolder}\nRun another action`,
    codexFolder.replace("Your trust decision", "Your command approval"),
    codexFolder.replace("Trust and continue", "Run and continue"),
    codexFolder.replace("  /project", ""),
    codexFolder.replace("  /project", "  /different"),
    codexFolder.replace("  2.", "› 2."),
    codexFolder.replace("› 1.", "  1."),
    codexFolder.replace("enter continue · esc back", "Press enter to continue"),
  ])
    assert.equal(directoryTrustKeys("codex", text, codexFolderDirectory), undefined, text);
  assert.equal(
    directoryTrustKeys("codex", codexFolder, `${codexFolderDirectory}-other`),
    undefined,
  );
  assert.equal(directoryTrustKeys("claude", codexFolder, codexFolderDirectory), undefined);
});

test("Codex folder-access false idle is blocked before task delivery and remains startup scoped", async () => {
  const client = folderClient();
  const raw = {
    pane_id: client.ref.paneId,
    workspace_id: client.ref.workspaceId,
    terminal_id: "term1",
    agent: "codex",
    cwd: codexFolderDirectory,
    agent_status: "idle",
    state_change_seq: 3,
    interactive_ready: true,
    launch_pending: false,
  };
  assert.equal((await client.normalize(raw)).status, "blocked");
  client.truncated = true;
  assert.equal((await client.normalize(raw)).status, "idle");
  client.truncated = false;
  assert.equal(
    (await client.normalize({ ...raw, agent_session: { kind: "id", value: "existing" } })).status,
    "idle",
  );
  client.agent.status = "idle";
  await assert.rejects(new AgentControl(client).send(client.ref, "task must not enter this menu"), {
    code: "approval_required",
  });
  assert.deepEqual(client.strokes, []);
});

test("Codex folder-access trust retains startup, directory, menu and one-effect guards", async () => {
  const accepted = folderClient();
  await new AgentControl(accepted).trustDirectory(accepted.ref, accepted.ref.cwd, guard());
  assert.deepEqual(accepted.strokes, [["enter"]]);
  assert.equal(accepted.reads, 3);
  const cases: Array<(client: TrustClient) => void> = [
    (client) => {
      client.agent.sessionId = "already-running-task";
    },
    (client) => {
      client.agent.cwd = "/other";
    },
    (client) => {
      client.beforeRead = (count) => {
        if (count === 2) client.text = codexFolder.replace("  /project", "  /other");
      };
    },
    (client) => {
      client.beforeGet = (count) => {
        if (count === 3) client.agent.terminalId = "replacement";
      };
    },
    (client) => {
      client.truncated = true;
    },
  ];
  for (const alter of cases) {
    const client = folderClient();
    alter(client);
    await assert.rejects(
      new AgentControl(client).trustDirectory(client.ref, client.ref.cwd, guard()),
    );
    assert.deepEqual(client.strokes, []);
  }
  const client = folderClient();
  client.error = new OperationError("lost", "lost acknowledgement", "unknown");
  const control = new AgentControl(client);
  await assert.rejects(control.trustDirectory(client.ref, client.ref.cwd, guard()), {
    outcome: "unknown",
  });
  client.error = undefined;
  await assert.rejects(control.trustDirectory(client.ref, client.ref.cwd, guard()), {
    code: "directory_trust_uncertain",
  });
  assert.equal(client.strokes.length, 1);
});

test("remaining Codex folder-access markers keep confirmation uncertain even with changed menu text", async () => {
  for (const after of [
    codexFolder,
    codexFolder.replace("Trust this folder?", "Loading folder..."),
    codexFolder.replace("Folder access", ""),
  ]) {
    const client = folderClient();
    client.after = after;
    await assert.rejects(
      new AgentControl(client).trustDirectory(client.ref, client.ref.cwd, guard()),
      { code: "directory_trust_uncertain", outcome: "unknown" },
    );
    assert.equal(client.strokes.length, 1);
  }
});

test("native Claude directory fixture recognizes wrapped cwd and exact selected trust choice only", async () => {
  assert.deepEqual(directoryTrustKeys("claude", claude, claudeDirectory), ["down", "enter"]);
  assert.deepEqual(
    directoryTrustKeys(
      "claude",
      claude
        .replace("❯ No, exit", "No, exit")
        .replace("Yes, I trust this folder", "❯ Yes, I trust this folder"),
      claudeDirectory,
    ),
    ["enter"],
  );
  assert.equal(directoryTrustKeys("claude", claude, "/another-directory"), undefined);
  assert.equal(
    directoryTrustKeys("claude", `User quoted example:\n${claude}`, claudeDirectory),
    undefined,
  );
  assert.equal(
    directoryTrustKeys("claude", `${claude}\nRun another action`, claudeDirectory),
    undefined,
  );
  assert.equal(
    directoryTrustKeys(
      "claude",
      claude.replace("Security guide", "Approve command"),
      claudeDirectory,
    ),
    undefined,
  );
  assert.deepEqual(directoryTrustKeys("codex", nativeCodex, nativeCodexDirectory), ["enter"]);
  assert.equal(directoryTrustKeys("codex", nativeCodex, "/another-directory"), undefined);
  assert.equal(
    directoryTrustKeys(
      "codex",
      nativeCodex.replace("/Users/yueban/herder-agent-code/validatio", "/Users"),
      nativeCodexDirectory,
    ),
    undefined,
  );
  assert.equal(
    directoryTrustKeys(
      "codex",
      nativeCodex.replace("  Do you trust", "Do you trust"),
      nativeCodexDirectory,
    ),
    undefined,
  );
  for (const name of ["claude-53.txt", "claude-173.txt"]) {
    const ordinary = await readFile(
      new URL(`../fixtures/legacy/screens/${name}`, import.meta.url),
      "utf8",
    );
    assert.equal(directoryTrustKeys("claude", ordinary, "/tmp/herdr-accept"), undefined);
  }
  assert.deepEqual(directoryTrustKeys("codex", codex, "/tmp"), ["enter"]);
  assert.equal(directoryTrustKeys("codex", codex, "/different"), undefined);
  assert.equal(
    directoryTrustKeys(
      "codex",
      codex.replace("Do you trust", "Example commands; Do you trust"),
      "/tmp",
    ),
    undefined,
  );
});

test("false idle Claude startup is recognized as blocked only from its complete native directory menu", async () => {
  const client = new TrustClient();
  const raw = {
    pane_id: "w1:p1",
    workspace_id: "w1",
    terminal_id: "term1",
    agent: "claude",
    cwd: claudeDirectory,
    agent_status: "idle",
    state_change_seq: 3,
    interactive_ready: true,
    launch_pending: false,
  };
  assert.equal((await client.normalize(raw)).status, "blocked");
  client.truncated = true;
  assert.equal((await client.normalize(raw)).status, "idle");
  client.truncated = false;
  assert.equal(
    (await client.normalize({ ...raw, agent_session: { kind: "id", value: "existing" } })).status,
    "idle",
  );
});

test("complete unnumbered blocked menus expose explicit human navigation without sending keys", async () => {
  const client = new TrustClient();
  const runtime = new HerdrRuntime({ socket: "/not-used" });
  runtime.client.get = client.get.bind(client);
  runtime.client.read = client.read.bind(client);
  let screen = await runtime.screen(client.ref);
  assert.deepEqual(
    screen.options.map((option) => option.key),
    ["up", "down", "enter", "tab", "y", "n"],
  );
  assert.ok(screen.options.every((option) => option.label.length > 0));
  assert.deepEqual(client.strokes, []);
  client.truncated = true;
  screen = await runtime.screen(client.ref);
  assert.deepEqual(screen.options, []);
  client.truncated = false;
  client.agent.status = "idle";
  screen = await runtime.screen(client.ref);
  assert.deepEqual(screen.options, []);
});

test("restricted trust derives keys and confirms menu disappearance for Claude and Codex", async () => {
  for (const kind of ["claude", "codex"] as const) {
    const client = new TrustClient(kind);
    await new AgentControl(client).trustDirectory(client.ref, client.ref.cwd, guard());
    assert.deepEqual(client.strokes, [kind === "claude" ? ["down", "enter"] : ["enter"]]);
    assert.equal(client.reads, 3, "two preflight screens and one post-input screen");
    assert.ok(client.gets >= 5, "identity is rechecked around screen reads and after input");
  }
});

test("restricted trust rejects ordinary approvals, incomplete screens and changing startup guards before keys", async () => {
  const cases: Array<(client: TrustClient) => void> = [
    (client) => {
      client.text = "Bash command\nDo you want to proceed?\n❯ 1. Yes\n2. No";
    },
    (client) => {
      client.truncated = true;
    },
    (client) => {
      client.agent.cwd = "/different";
    },
    (client) => {
      client.agent.workspaceId = "different";
    },
    (client) => {
      client.agent.stateSeq = "4";
    },
    (client) => {
      client.agent.sessionId = "existing";
    },
    (client) => {
      client.beforeRead = (count) => {
        if (count === 2) client.text = client.text.replace("❯ No, exit", "No, exit");
      };
    },
    (client) => {
      client.beforeGet = (count) => {
        if (count === 3) client.agent.terminalId = "replacement";
      };
    },
    (client) => {
      client.beforeGet = (count) => {
        if (count === 3) client.agent.stateSeq = "4";
      };
    },
  ];
  for (const alter of cases) {
    const client = new TrustClient();
    alter(client);
    await assert.rejects(
      new AgentControl(client).trustDirectory(client.ref, client.ref.cwd, guard()),
    );
    assert.deepEqual(client.strokes, []);
  }
  const client = new TrustClient();
  await assert.rejects(new AgentControl(client).trustDirectory(client.ref, "/different", guard()), {
    code: "directory_mismatch",
  });
  await assert.rejects(
    new AgentControl(client).trustDirectory(client.ref, client.ref.cwd, {
      ...guard(),
      expiresAt: "2000-01-01T00:00:00Z",
    }),
    { code: "stale_guard" },
  );
  assert.deepEqual(client.strokes, []);
});

test("unknown trust write cannot be repeated under the same native state", async () => {
  const client = new TrustClient();
  client.error = new OperationError("lost", "lost acknowledgement", "unknown");
  const control = new AgentControl(client);
  await assert.rejects(control.trustDirectory(client.ref, client.ref.cwd, guard()), {
    outcome: "unknown",
  });
  client.error = undefined;
  await assert.rejects(control.trustDirectory(client.ref, client.ref.cwd, guard()), {
    code: "directory_trust_uncertain",
  });
  assert.equal(client.strokes.length, 1);
});

test("a remaining trust menu or truncated readback cannot claim successful directory confirmation", async () => {
  for (const truncated of [false, true]) {
    const client = new TrustClient();
    client.after = truncated ? "Ready" : claude;
    client.afterTruncated = truncated;
    await assert.rejects(
      new AgentControl(client).trustDirectory(client.ref, client.ref.cwd, guard()),
      { code: "directory_trust_uncertain", outcome: "unknown" },
    );
    assert.equal(client.strokes.length, 1);
  }
});

test("Codex worktree repository-root note requires separately verified exact root authorization", async () => {
  const screen = await readFile(
    new URL("../fixtures/native/codex-worktree-directory-trust.txt", import.meta.url),
    "utf8",
  );
  const cwd = "/Users/yueban/.herdr-agent/worktrees/task_d563c47aa704fbc208c6391606d1972e";
  const root = "/Users/yueban/herder-agent-code/validation-worktree-0918";
  assert.deepEqual(directoryTrustKeys("codex", screen, cwd, root), ["enter"]);
  assert.equal(directoryTrustKeys("codex", screen, cwd), undefined);
  assert.equal(directoryTrustKeys("codex", screen, cwd, "/other"), undefined);
  assert.equal(
    directoryTrustKeys("codex", screen.replace("  0918", "  0918\n  /other"), cwd, root),
    undefined,
  );
  assert.equal(
    directoryTrustKeys(
      "codex",
      screen.replace("Trusting will apply", "Execute will apply"),
      cwd,
      root,
    ),
    undefined,
  );
  assert.equal(
    directoryTrustKeys("codex", screen.replace("  Note:", "  Approve command. Note:"), cwd, root),
    undefined,
  );
});
