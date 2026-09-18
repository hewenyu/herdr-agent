import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRef, Participant } from "../../src/core/types.js";
import { HerdrRuntime } from "../../src/herdr/runtime.js";
import { TaskService } from "../../src/tasks/service.js";
import { TranscriptReader } from "../../src/transcripts/reader.js";
import { TranscriptResolver } from "../../src/transcripts/resolver.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const receipt = `HERDR_RECEIPT_${"a".repeat(32)}`;
const ref: ExecutionRef = {
  workspaceId: "w1",
  paneId: "w1:p1",
  kind: "claude",
  cwd: "/code/project",
  transcriptReceipt: receipt,
};
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const user = (id: string, marker = receipt, cwd = ref.cwd) =>
  line({ type: "user", sessionId: id, cwd, message: { content: `request\n${marker}` } });
const answer = (text: string) => line({ type: "assistant", message: { content: text } });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "receipt-test-"));
  const directory = join(home, ".claude/projects/-code-project");
  await mkdir(directory, { recursive: true });
  const reader = () => new TranscriptReader(new TranscriptResolver(home));
  return { home, directory, reader, close: () => rm(home, { recursive: true, force: true }) };
}

test("missing native ID recovers by receipt after restart and never samples pre-input replies", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "current.jsonl");
    await writeFile(path, answer("old answer"));
    assert.equal(await f.reader().sampleLastReply(ref), undefined);
    await appendFile(path, user("current"));
    assert.equal(await f.reader().sampleLastReply(ref), undefined);
    await appendFile(path, answer("task answer"));
    const reader = f.reader();
    const page = await reader.page(ref, "");
    assert.deepEqual(page.entries, []);
    assert.equal((await reader.sampleLastReply(ref))?.text, "task answer");
    await appendFile(path, answer("next turn"));
    assert.deepEqual(
      (await f.reader().page(ref, page.cursor)).entries.map((e) => e.text),
      ["next turn"],
    );
    assert.equal((await f.reader().sampleLastReply(ref))?.text, "next turn");
  } finally {
    await f.close();
  }
});

test("same cwd sessions are distinguished by exact user receipt; ambiguity is rejected even after lookup", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "current.jsonl"), user("current") + answer("correct"));
    await writeFile(
      join(f.directory, "other.jsonl"),
      user("other", `HERDR_RECEIPT_${"b".repeat(32)}`) + answer("other"),
    );
    const reader = f.reader();
    assert.equal((await reader.sampleLastReply(ref))?.text, "correct");
    await writeFile(join(f.directory, "copy.jsonl"), user("copy") + answer("ambiguous"));
    assert.equal(await reader.sampleLastReply(ref), undefined);
  } finally {
    await f.close();
  }
});

test("wrong cwd, filename, multiple native IDs, assistant echoes and malformed records cannot identify a session", async () => {
  const invalid = [
    user("current", receipt, "/different"),
    user("wrong-id"),
    user("current") + line({ type: "system", sessionId: "different-id" }),
    answer(receipt),
    user("current", `${receipt}0`),
    user("current").trimEnd(),
    `not json\n${user("current")}`,
    line({
      type: "user",
      sessionId: "current",
      cwd: ref.cwd,
      isSidechain: true,
      message: { content: receipt },
    }),
  ];
  for (const input of invalid) {
    const f = await fixture();
    try {
      await writeFile(join(f.directory, "current.jsonl"), input + answer("unrelated"));
      assert.equal(await f.reader().sampleLastReply(ref), undefined);
    } finally {
      await f.close();
    }
  }
});

test("herdr runtime reads a receipt-correlated transcript without inventing a native session ID", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "current.jsonl"), user("current") + answer("native answer"));
    const runtime = new HerdrRuntime({ homeDir: f.home, socket: join(f.home, "unused.sock") });
    runtime.client.get = async () => ({
      ...ref,
      status: "done",
      stateSeq: "2",
      interactiveReady: true,
      launchPending: false,
    });
    assert.equal((await runtime.sampleLastReply(ref))?.text, "native answer");
    assert.equal(ref.sessionId, undefined);
  } finally {
    await f.close();
  }
});

test("restart recovers an existing missing-ID Claude reply and dispatches the next discussion participant once", async () => {
  const outputs: string[] = [];
  const f = setup({
    output: async (_task, _participant, entry) => {
      outputs.push(entry.text);
    },
  });
  try {
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const first = f.service.get(actor, task.id).participants[0];
    assert.ok(first?.execution);
    const agent = f.herdr.agents.get(first.execution.paneId);
    assert.ok(agent);
    agent.sessionId = undefined;
    agent.status = "done";
    first.execution.sessionId = undefined;
    first.execution.transcriptReceipt = undefined;
    first.cursor = "";
    f.store.set<Participant>("participants", first.id, first);
    f.store.set("participant_input_baseline", first.id, { id: "" });
    const directory = join(
      f.directory,
      ".claude/projects",
      first.execution.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "current.jsonl"),
      answer("old") +
        user("current", first.initialReceipt, first.execution.cwd) +
        answer("recovered"),
    );
    const reader = new TranscriptReader(new TranscriptResolver(f.directory));
    const transcript = f.herdr.transcript.bind(f.herdr);
    const sample = f.herdr.sampleLastReply.bind(f.herdr);
    f.herdr.transcript = (target, cursor) =>
      target.kind === "claude" ? reader.page(target, cursor) : transcript(target, cursor);
    f.herdr.sampleLastReply = (target) =>
      target.kind === "claude" ? reader.sampleLastReply(target) : sample(target);
    const restored = new TaskService(f.options);
    await restored.tick();
    assert.deepEqual(outputs, ["recovered"]);
    assert.equal(f.herdr.sends.length, 2);
    assert.equal(restored.get(actor, task.id).participants[1]?.initialSent, true);
    await new TaskService(f.options).tick();
    assert.deepEqual(outputs, ["recovered"]);
    assert.equal(f.herdr.sends.length, 2);
  } finally {
    f.close();
  }
});
