import assert from "node:assert/strict";
import test from "node:test";
import { taskProgress } from "../../src/app/workflow-progress.js";
import type { Participant } from "../../src/core/types.js";
import {
  type ProvisionEvidence,
  recordProvisionEvidence,
  unsupportedProvisionClaim,
} from "../../src/runtime/provision-evidence.js";
import type { OperationReceipt, OperationResolution } from "../../src/storage/operations.js";
import type { InputDelivery } from "../../src/tasks/input-delivery.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const cases: Array<{
  name: string;
  state?: OperationReceipt["state"];
  verified?: boolean;
  choice?: OperationResolution["choice"];
  by?: OperationResolution["decidedBy"];
  expected: "confirmed" | "decided" | "pending";
}> = [
  { name: "missing receipt", expected: "pending" },
  { name: "verified delivery", state: "done", verified: true, expected: "confirmed" },
  { name: "unverified completion", state: "done", verified: false, expected: "pending" },
  { name: "unknown outcome", state: "uncertain", verified: true, expected: "pending" },
  {
    name: "evidence decision",
    state: "uncertain",
    choice: "treat_done",
    by: "evidence",
    verified: true,
    expected: "confirmed",
  },
  {
    name: "unverified evidence",
    state: "uncertain",
    choice: "treat_done",
    by: "evidence",
    verified: false,
    expected: "pending",
  },
  {
    name: "pi decision",
    state: "uncertain",
    choice: "treat_done",
    by: "pi",
    verified: false,
    expected: "decided",
  },
  {
    name: "user decision",
    state: "uncertain",
    choice: "treat_done",
    by: "user",
    verified: false,
    expected: "decided",
  },
  {
    name: "retry decision",
    state: "uncertain",
    choice: "retry",
    by: "user",
    verified: true,
    expected: "pending",
  },
  {
    name: "abandon decision",
    state: "uncertain",
    choice: "abandon",
    by: "pi",
    verified: true,
    expected: "pending",
  },
];

for (const prepared of [false, true]) {
  for (const scenario of cases) {
    test(`${prepared ? "prepared send" : "initial"} projection: ${scenario.name}`, async () => {
      const fixture = setup();
      try {
        const task = await fixture.service.create(actor, {
          ...discussion,
          participants: [{ kind: "codex", name: "Codex" }],
        });
        const participant = fixture.service.records.participants(task)[0];
        assert.ok(participant);
        participant.initialSent = true;
        fixture.store.set("participants", participant.id, participant);
        const operationId = prepared ? `${task.id}:send:first` : `${participant.id}:initial`;
        const receipt: OperationReceipt = {
          id: operationId,
          fingerprint: "fingerprint",
          state: scenario.state ?? "pending",
          result: { verified: scenario.verified },
          updatedAt: new Date().toISOString(),
          ...(scenario.choice && scenario.by
            ? {
                resolution: {
                  choice: scenario.choice,
                  decidedBy: scenario.by,
                  reason: "test decision",
                  at: new Date().toISOString(),
                  result: { verified: scenario.verified },
                },
              }
            : {}),
        };
        if (scenario.state) fixture.store.set("operations", operationId, receipt);
        if (prepared) {
          fixture.store.set<InputDelivery>("input_deliveries", operationId, {
            taskId: task.id,
            participantId: participant.id,
            operationId,
            fingerprint: receipt.fingerprint,
            execution: { paneId: "pane", workspaceId: "workspace", kind: "codex", cwd: "/project" },
            receipt: participant.initialReceipt,
            initial: true,
            prompt: "requirements",
            discussionWasPaused: false,
            outputSequence: 0,
          });
        }
        const snapshots = [
          fixture.service.get(actor, task.id),
          fixture.service.list(actor)[0],
          fixture.service.list({ ...actor, taskId: task.id, source: "web" })[0],
          await taskProgress(
            { tasks: fixture.service, herdr: fixture.herdr, store: fixture.store },
            actor,
            task.id,
          ),
        ];
        for (const snapshot of snapshots) {
          assert.equal(snapshot?.participants[0]?.initialDelivery, scenario.expected);
          assert.equal(snapshot?.participants[0]?.initialSent, true);
          for (const name of ["task_get", "task_progress", "tasks_list"]) {
            const evidence: ProvisionEvidence = { created: [], tasks: [] };
            recordProvisionEvidence(
              evidence,
              name,
              {},
              name === "tasks_list" ? [snapshot] : snapshot,
            );
            assert.equal(
              unsupportedProvisionClaim("要求已转交给 Codex。", evidence),
              scenario.expected !== "confirmed",
            );
            assert.equal(
              unsupportedProvisionClaim("Codex 已收到要求。", evidence),
              scenario.expected !== "confirmed",
            );
            assert.equal(
              unsupportedProvisionClaim("Codex 的要求已按决策视为送达，未经确认。", evidence),
              false,
            );
            assert.equal(unsupportedProvisionClaim("按决策视为送达，未经确认。", evidence), false);
            assert.equal(
              unsupportedProvisionClaim(
                "Codex 的要求已按决策视为送达，未经确认；要求已转交给 Codex。",
                evidence,
              ),
              scenario.expected !== "confirmed",
            );
          }
        }
        assert.equal(
          fixture.store.get<Participant>("participants", participant.id)?.initialSent,
          true,
        );
        assert.equal(
          "initialDelivery" in
            (fixture.store.get<Participant>("participants", participant.id) ?? {}),
          false,
        );
        assert.deepEqual(
          fixture.store.get("operations", operationId),
          scenario.state ? JSON.parse(JSON.stringify(receipt)) : undefined,
        );
      } finally {
        fixture.close();
      }
    });
  }
}

test("legacy participant fixtures retain initialSent fallback", () => {
  for (const initialSent of [false, true]) {
    const evidence: ProvisionEvidence = { created: [], tasks: [] };
    recordProvisionEvidence(
      evidence,
      "task_get",
      {},
      {
        id: "task_legacy",
        participants: [{ id: "codex", name: "Codex", kind: "codex", initialSent }],
      },
    );
    assert.equal(unsupportedProvisionClaim("要求已转交给 Codex。", evidence), !initialSent);
  }
});
