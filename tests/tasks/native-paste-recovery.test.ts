import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { HerdrPort } from "../../src/core/ports.js";
import type { OperationReceipt } from "../../src/storage/operations.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { TaskService } from "../../src/tasks/service.js";
import { TranscriptReader } from "../../src/transcripts/reader.js";
import { TranscriptResolver } from "../../src/transcripts/resolver.js";
import { actor, discussion, setup } from "./helpers.js";

const wrap = (text: string) =>
  `\n\n<pasted_content id="2e42">\n\n${text}\n</pasted_content id="2e42">\n`;

for (const evidence of [
  "exact",
  "session_from_receipt",
  "extra_prefix",
  "extra_suffix",
  "extra_newline",
  "wrong_id",
  "multiple_blocks",
  "nested_block",
  "wrong_payload",
  "wrong_receipt",
  "wrong_cwd",
  "wrong_session",
  "wrong_fingerprint",
] as const) {
  test(`real transcript readback recovers only the exact Claude paste without another send: ${evidence}`, async () => {
    const outputs: string[] = [];
    const f = setup({
      output: async (_task, _participant, entry) => {
        outputs.push(entry.text);
      },
    });
    try {
      f.config.ai.enabled = true;
      const task = await f.service.create(actor, {
        ...discussion,
        participants: [{ kind: "claude", name: "Claude" }],
        orchestration: { mode: "workflow", template: "discussion" },
      });
      await f.service.reconcile(task.id);
      let participant = f.service.get(actor, task.id).participants[0];
      assert.ok(participant?.execution);
      const sessionId = participant.execution.sessionId as string;
      if (evidence === "session_from_receipt") {
        participant.execution.sessionId = undefined;
        f.service.records.saveParticipant(participant);
      }
      f.herdr.delivery = { status: "unconfirmed", verified: false, acked: true, attempts: 1 };
      const operationId = `${task.id}:workflow:isolated-native-paste`;
      await assert.rejects(
        f.service.send(
          { ...actor, source: "system", messageId: "workflow-paste" },
          task.id,
          participant.id,
          "独立分析任务，并给出简短结论。",
          undefined,
          operationId,
        ),
      );
      const delivery = f.store.get<InputDelivery>("input_deliveries", operationId);
      assert.ok(delivery);
      assert.equal(f.store.get<OperationReceipt>("operations", operationId)?.state, "uncertain");
      assert.equal(f.herdr.sends.length, 1);
      const expected = delivery.prompt;
      let nativeText = wrap(expected);
      if (evidence === "extra_prefix") nativeText = `other input${nativeText}`;
      if (evidence === "extra_suffix") nativeText += "other input";
      if (evidence === "extra_newline") nativeText += "\n";
      if (evidence === "wrong_id")
        nativeText = nativeText.replace(
          '</pasted_content id="2e42">',
          '</pasted_content id="2e43">',
        );
      if (evidence === "multiple_blocks") nativeText += wrap("another paste");
      if (evidence === "nested_block") nativeText = wrap(nativeText);
      if (evidence === "wrong_payload") {
        const changed = expected.replace(
          "独立分析任务，并给出简短结论。",
          "独立分析任务，但正文已变更。",
        );
        assert.notEqual(changed, expected);
        nativeText = wrap(changed);
      }
      if (evidence === "wrong_receipt")
        nativeText = wrap(expected.replaceAll(delivery.receipt, `HERDR_RECEIPT_${"0".repeat(32)}`));
      if (evidence === "wrong_fingerprint") {
        const operation = f.store.get<OperationReceipt>("operations", operationId);
        assert.ok(operation);
        f.store.set("operations", operationId, { ...operation, fingerprint: "other-operation" });
      }
      const directory = join(
        f.directory,
        ".claude/projects",
        delivery.execution.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
      );
      await mkdir(directory, { recursive: true });
      const path = join(directory, `${sessionId}.jsonl`);
      const nativeRecord = `${JSON.stringify({
        type: "user",
        sessionId: evidence === "wrong_session" ? "other-session" : sessionId,
        cwd: evidence === "wrong_cwd" ? "/unrelated-project" : delivery.execution.cwd,
        message: { content: nativeText },
      })}\n`;
      await writeFile(path, nativeRecord);
      const reader = new TranscriptReader(new TranscriptResolver(f.directory));
      if (!["wrong_receipt", "wrong_cwd", "wrong_session"].includes(evidence))
        assert.equal(await reader.initialInput(delivery.execution, delivery.receipt), nativeText);
      (f.herdr as HerdrPort).initialInput = (ref, receipt) => reader.initialInput(ref, receipt);
      f.herdr.transcript = (ref, cursor) => reader.page(ref, cursor);
      f.herdr.sampleLastReply = (ref) => reader.sampleLastReply(ref);
      participant = f.service.get(actor, task.id).participants[0];
      assert.ok(participant?.execution);
      participant.cursor = (await reader.page(participant.execution)).cursor;
      f.service.records.saveParticipant(participant);
      const assistantRecord = `${JSON.stringify({
        type: "assistant",
        sessionId,
        cwd: delivery.execution.cwd,
        message: { content: [{ type: "text", text: "真实原生回复" }] },
      })}\n`;
      await appendFile(path, assistantRecord);
      const agent = f.herdr.agents.get(participant.execution.paneId);
      assert.ok(agent);
      agent.status = "done";
      const recovered = evidence === "exact" || evidence === "session_from_receipt";
      const restored = new TaskService(f.options);
      await restored.reconcile(task.id);
      const recoveredOperation = f.store.get<OperationReceipt>("operations", operationId);
      assert.equal(recoveredOperation?.state, "uncertain");
      assert.equal(recoveredOperation?.resolution?.choice, recovered ? "treat_done" : undefined);
      assert.equal(recoveredOperation?.resolution?.decidedBy, recovered ? "evidence" : undefined);
      assert.equal(restored.get(actor, task.id).participants[0]?.initialSent, recovered);
      assert.equal(f.herdr.sends.length, 1, "input recovery never resends the unknown operation");
      assert.equal(f.store.get<InputDelivery>("input_deliveries", operationId)?.prompt, expected);
      assert.equal(await readFile(path, "utf8"), nativeRecord + assistantRecord);
      if (recovered) {
        assert.deepEqual(outputs, ["真实原生回复"]);
        assert.ok(f.store.get("task_input_applied", operationId));
        assert.equal(f.store.get("participant_awaiting_output", participant.id), undefined);
        await new TaskService(f.options).reconcile(task.id);
        assert.deepEqual(outputs, ["真实原生回复"]);
        assert.equal(f.herdr.sends.length, 1);
      }
    } finally {
      f.close();
    }
  });
}
