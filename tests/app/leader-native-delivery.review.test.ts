import assert from "node:assert/strict";
import test from "node:test";
import { nativeSendOperationId, reconcileLeaderReceipts } from "../../src/app/leader-receipts.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { participantPrompt } from "../../src/tasks/prompts.js";
import { actor, discussion, setup } from "../tasks/helpers.js";
import {
  EVENT,
  leaderOperation,
  nativeRow,
  seedDispatch,
  seedOperation,
  seedSession,
} from "./leader-receipts-helpers.js";

// Use the actual TaskService send path, not a hand-written approximation of
// participantPrompt. The v2 protocol footer follows its own initial receipt.
for (const promptVersion of [undefined, 2, 3] as const)
  for (const corruption of [undefined, "token-prefix", "marker-suffix"] as const)
    test(`initial native delivery ${corruption ?? "exact proof"} (prompt v${promptVersion ?? 1})`, async () => {
      const h = setup();
      try {
        h.config.ai.enabled = true;
        const created = await h.service.create(actor, {
          ...discussion,
          orchestration: { mode: "workflow" },
        });
        created.promptVersion = promptVersion;
        created.orchestration = { mode: "model" };
        h.service.records.save(created);
        await h.service.reconcile(created.id);
        const task = h.service.records.get(actor, created.id);
        const participant = h.service.records.participants(task)[0];
        assert.ok(participant?.execution);
        assert.equal(participant.initialSent, false);
        const text = "请仅核对原有要求并报告现有证据；不要部署。";
        const nativeId = nativeSendOperationId(task.id, EVENT, participant.id, text);
        const expectedPrompt = participantPrompt(task, participant, text);
        const before = h.herdr.sends.length;
        await h.service.send(
          {
            ...actor,
            source: "system",
            chatId: task.chatId ?? task.entryChatId,
            sessionId: `orchestration:${task.id}`,
            taskId: task.id,
            messageId: EVENT,
          },
          task.id,
          participant.id,
          text,
        );
        assert.equal(h.herdr.sends.length, before + 1);
        assert.equal(h.herdr.sends.at(-1)?.text, expectedPrompt);
        const delivery = h.store.get<InputDelivery>("input_deliveries", nativeId);
        assert.equal(delivery?.initial, true);
        assert.equal(delivery?.prompt, expectedPrompt);
        assert.equal(nativeRow(h.store, nativeId).state, "done");

        // Simulate the precise crash gap: native success is durable, while the
        // corresponding Leader operation is still pending. No native row is forged.
        const nativeTask = h.service.records.get(actor, task.id);
        seedSession(h.store, task.id, task.ownerId);
        h.service.records.save(nativeTask);
        seedDispatch(h.store, task.id, nativeId, participant.id);
        const operation = seedOperation(h.store, {
          taskId: task.id,
          tool: "participant_send",
          args: { taskId: task.id, participantId: participant.id, text },
        });
        if (corruption) {
          assert.ok(delivery);
          const altered =
            corruption === "token-prefix"
              ? delivery.prompt.replace(delivery.receipt, `${delivery.receipt}-FOREIGN`)
              : delivery.prompt.replace("投递标识（无需复述）：", "伪造前缀投递标识（无需复述）：");
          assert.notEqual(altered, delivery.prompt);
          h.store.set("input_deliveries", nativeId, { ...delivery, prompt: altered });
          const blocked = reconcileLeaderReceipts(h.store, task.id);
          assert.deepEqual(blocked.resolved, [], "receipt and marker must match complete lines");
          assert.deepEqual(
            blocked.blocked.map((entry) => entry.operationId),
            [operation.id],
          );
          assert.equal(leaderOperation(h.store, task.id, operation.id).state, "pending");
          assert.equal(h.herdr.sends.length, before + 1);
          return;
        }
        const report = reconcileLeaderReceipts(h.store, task.id);
        assert.deepEqual(
          report.resolved.map((entry) => entry.operationId),
          [operation.id],
        );
        const resolved = leaderOperation(h.store, task.id, operation.id);
        assert.equal(resolved.state, "complete");
        assert.equal((resolved.result as { verified?: boolean }).verified, true);
        assert.equal(h.herdr.sends.length, before + 1, "reconciliation never resends native input");
        assert.equal(task.closeRequested, false);
      } finally {
        h.close();
      }
    });
