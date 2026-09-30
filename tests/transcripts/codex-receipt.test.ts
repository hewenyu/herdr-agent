import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HerdrPort } from "../../src/core/ports.js";
import type { ExecutionRef } from "../../src/core/types.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { TaskService } from "../../src/tasks/service.js";
import { TranscriptReader } from "../../src/transcripts/reader.js";
import { TranscriptResolver } from "../../src/transcripts/resolver.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const id = "01a0e1dc-c524-7c21-9d31-a36cb5b7f0bb";
const other = "01a0e1dc-c524-7c21-9d31-a36cb5b7f0bc";
const receipt = `HERDR_RECEIPT_${"a".repeat(32)}`;
const ref: ExecutionRef = {
  kind: "codex",
  paneId: "w1:p1",
  workspaceId: "w1",
  cwd: "/code/project",
  transcriptReceipt: receipt,
};
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const meta = (session = id, cwd = ref.cwd) =>
  line({ type: "session_meta", payload: { id: session, session_id: session, cwd } });
const message = (text: string, role = "user") =>
  line({
    type: "response_item",
    payload: {
      type: "message",
      role,
      phase: "final_answer",
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
const filename = (session = id) => `rollout-2026-09-27T15-55-37-${session}.jsonl`;
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "codex-receipt-"));
  const directory = join(home, ".codex/sessions/2026/09/27");
  await mkdir(directory, { recursive: true });
  const reader = new TranscriptReader(new TranscriptResolver(home));
  return { home, directory, reader, close: () => rm(home, { recursive: true, force: true }) };
}

test("Codex missing-ID discovery requires native meta and an exact user receipt, preserving raw records", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, filename());
    const prompt = `actual request\n${receipt}`;
    await writeFile(path, meta() + message("old output", "assistant") + message(prompt));
    assert.equal(await f.reader.initialInput(ref, receipt), prompt);
    assert.equal(
      await f.reader.sampleLastReply(ref),
      undefined,
      "pre-input output is not task evidence",
    );
    const baseline = await f.reader.page(ref);
    await appendFile(path, message("native answer", "assistant"));
    assert.equal((await f.reader.sampleLastReply(ref))?.text, "native answer");
    assert.deepEqual(
      (await f.reader.page(ref, baseline.cursor)).entries.map((entry) => entry.text),
      ["native answer"],
    );
    assert.equal(ref.sessionId, undefined, "discovery must not invent herdr session identity");
    assert.equal(
      await new TranscriptReader(new TranscriptResolver(f.home)).initialInput(ref, receipt),
      prompt,
    );
  } finally {
    await f.close();
  }
});

for (const invalid of [
  "wrong_cwd",
  "wrong_filename",
  "conflicting_session",
  "assistant_echo",
  "receipt_prefix",
  "repeated_meta",
  "repeated_receipt",
  "malformed",
  "partial_input",
] as const) {
  test(`Codex missing-ID discovery fails closed: ${invalid}`, async () => {
    const f = await fixture();
    try {
      let body = meta() + message(receipt);
      if (invalid === "wrong_cwd") body = meta(id, "/other") + message(receipt);
      if (invalid === "wrong_filename") body = meta(other) + message(receipt);
      if (invalid === "conflicting_session")
        body =
          line({ type: "session_meta", payload: { id, session_id: other, cwd: ref.cwd } }) +
          message(receipt);
      if (invalid === "assistant_echo") body = meta() + message(receipt, "assistant");
      if (invalid === "receipt_prefix") body = meta() + message(`${receipt}f`);
      if (invalid === "repeated_meta") body += meta();
      if (invalid === "repeated_receipt") body += message(receipt);
      if (invalid === "malformed") body += "not json\n";
      if (invalid === "partial_input") body = body.trimEnd();
      await writeFile(join(f.directory, filename()), body);
      assert.equal(await f.reader.initialInput(ref, receipt), undefined);
      assert.equal(await f.reader.sampleLastReply(ref), undefined);
    } finally {
      await f.close();
    }
  });
}

test("discovery searches all same-cwd sessions after a successful lookup and invalidates changed file facts", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, filename());
    await writeFile(path, meta() + message(receipt) + message("first", "assistant"));
    assert.equal((await f.reader.sampleLastReply(ref))?.text, "first");
    await writeFile(
      join(f.directory, filename(other)),
      meta(other) + message(receipt) + message("second", "assistant"),
    );
    assert.equal(
      await f.reader.sampleLastReply(ref),
      undefined,
      "new duplicate session cannot be hidden by cache",
    );
    await rm(join(f.directory, filename(other)));
    assert.equal((await f.reader.sampleLastReply(ref))?.text, "first");
    await appendFile(path, message(receipt));
    assert.equal(
      await f.reader.initialInput(ref, receipt),
      undefined,
      "changed native file is rescanned",
    );
  } finally {
    await f.close();
  }
});

test("unrelated metadata is excluded by cwd and explicit subagents cannot inherit task receipt ownership", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.directory, filename()),
      meta() + message(receipt) + message("owned", "assistant"),
    );
    const path = join(f.directory, filename(other));
    const child = (cwd: string, subagent: boolean) =>
      line({
        type: "session_meta",
        payload: {
          id: other,
          session_id: id,
          cwd,
          ...(subagent
            ? {
                thread_source: "subagent",
                source: { subagent: { thread_spawn: { parent_thread_id: id } } },
                parent_thread_id: id,
              }
            : {}),
        },
      }) +
      message(receipt) +
      message("inherited", "assistant");
    await writeFile(path, child("/unrelated-project", true));
    assert.equal((await f.reader.sampleLastReply(ref))?.text, "owned");
    await writeFile(path, child(ref.cwd, true));
    assert.equal((await f.reader.sampleLastReply(ref))?.text, "owned");
    await writeFile(path, child(ref.cwd, false));
    assert.equal(
      await f.reader.sampleLastReply(ref),
      undefined,
      "unexplained target identity conflicts remain rejected",
    );
  } finally {
    await f.close();
  }
});

test("unrelated large Codex bodies are skipped after metadata; incomplete same-cwd or deep searches fail closed", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, filename()), meta() + message(receipt));
    const large = join(f.directory, filename(other));
    await writeFile(large, meta(other, "/other-project"));
    await truncate(large, 16 * 1_048_576);
    assert.equal(await f.reader.initialInput(ref, receipt), receipt);
    assert.equal(
      await f.reader.initialInput(ref, receipt),
      receipt,
      "unchanged unrelated body need not be read",
    );
    await writeFile(large, meta(other));
    await truncate(large, 16 * 1_048_576);
    assert.equal(await f.reader.initialInput(ref, receipt), undefined);
    await rm(large);
    const deep = join(
      f.home,
      ".codex/sessions",
      ...Array.from({ length: 11 }, (_, i) => `deep${i}`),
    );
    await mkdir(deep, { recursive: true });
    assert.equal(
      await f.reader.initialInput(ref, receipt),
      undefined,
      "depth cap cannot turn partial search into uniqueness",
    );
  } finally {
    await f.close();
  }
});

test("missing-ID Codex sessions remain discoverable after growing past 8 MiB", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, filename());
    await writeFile(path, meta() + message(receipt));
    assert.equal(await f.reader.initialInput(ref, receipt), receipt);
    for (let index = 0; index < 10; index++)
      await appendFile(
        path,
        line({ type: "event_msg", payload: { type: "history", text: "x".repeat(1_048_576) } }),
      );
    await appendFile(path, message("long-session answer", "assistant"));
    assert.equal(await f.reader.initialInput(ref, receipt), receipt);
    assert.equal((await f.reader.sampleLastReply(ref))?.text, "long-session answer");
    assert.equal(
      await new TranscriptReader(new TranscriptResolver(f.home)).initialInput(ref, receipt),
      receipt,
    );
  } finally {
    await f.close();
  }
});

test("TaskService restores unknown missing-ID Codex input and existing output without resending", async () => {
  const outputs: string[] = [];
  const f = setup({
    output: async (_task, _participant, entry) => {
      outputs.push(entry.text);
    },
  });
  try {
    f.config.ai.enabled = true;
    const start = f.herdr.startAgent.bind(f.herdr);
    f.herdr.startAgent = async (...args) => {
      const agent = await start(...args);
      agent.sessionId = undefined;
      f.herdr.agents.set(agent.paneId, agent);
      return agent;
    };
    const task = await f.service.create(actor, {
      ...discussion,
      participants: [{ kind: "codex", name: "Codex" }],
      orchestration: { mode: "workflow" },
    });
    await f.service.reconcile(task.id);
    const participant = f.service.get(actor, task.id).participants[0];
    assert.ok(participant?.execution);
    assert.equal(participant.execution.sessionId, undefined);
    f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
    const operationId = `${task.id}:workflow:codex-native-receipt`;
    await assert.rejects(
      f.service.send(
        { ...actor, source: "system" },
        task.id,
        participant.id,
        "independent analysis",
        undefined,
        operationId,
      ),
    );
    const original = f.store.get<OperationReceipt>("operations", operationId);
    assert.ok(original);
    assert.equal(original.state, "uncertain");
    const delivery = f.store.get<InputDelivery>("input_deliveries", operationId);
    assert.ok(delivery);
    const directory = join(f.directory, ".codex/sessions/2026/09/27");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, filename()),
      meta(id, delivery.execution.cwd) +
        message("old", "assistant") +
        message(delivery.prompt) +
        message("recovered Codex output", "assistant"),
    );
    const reader = new TranscriptReader(new TranscriptResolver(f.directory));
    (f.herdr as HerdrPort).initialInput = (target, marker) => reader.initialInput(target, marker);
    f.herdr.transcript = (target, cursor) => reader.page(target, cursor);
    f.herdr.sampleLastReply = (target) => reader.sampleLastReply(target);
    const agent = f.herdr.agents.get(participant.execution.paneId);
    assert.ok(agent);
    agent.status = "done";
    participant.cursor = "";
    f.service.records.saveParticipant(participant);
    const restored = new TaskService(f.options);
    await restored.reconcile(task.id);
    const recovered = f.store.get<OperationReceipt>("operations", operationId);
    assert.ok(recovered);
    assert.equal(recovered.state, "uncertain");
    assert.deepEqual(recovered.error, original.error);
    assert.equal(recovered.updatedAt, original.updatedAt);
    assert.equal(recovered.resolution?.choice, "treat_done");
    assert.equal(recovered.resolution?.decidedBy, "evidence");
    assert.equal((recovered.resolution?.result as { verified?: boolean })?.verified, true);
    assert.equal(restored.get(actor, task.id).participants[0]?.initialSent, true);
    assert.deepEqual(outputs, ["recovered Codex output"]);
    assert.equal(f.herdr.sends.length, 1);
    await new TaskService(f.options).reconcile(task.id);
    assert.deepEqual(outputs, ["recovered Codex output"]);
    assert.equal(f.herdr.sends.length, 1);
    assert.equal(restored.get(actor, task.id).participants[0]?.execution?.sessionId, undefined);
  } finally {
    f.close();
  }
});
