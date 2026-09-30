import assert from "node:assert/strict";
import test from "node:test";
import { workflowCandidates } from "../../src/orchestration/candidates.js";
import {
  countSettledBatch,
  currentOpenIssues,
  markIssuesForRevalidation,
  mergeStatus,
  workflowState,
} from "../../src/orchestration/state.js";
import type { StatusBlock } from "../../src/orchestration/status-block.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

async function fixture() {
  const h = setup();
  const task = await h.service.create(actor, discussion);
  const state = workflowState(h.store, task, "initial");
  const node = state.plan.nodes[0];
  assert.ok(node);
  state.nodes[node.id] = {
    status: "dispatched",
    attempt: 1,
    participantId: task.participantIds[0],
  };
  const receipt = (issues: StatusBlock["issues"]): StatusBlock => ({
    protocolVersion: 1,
    nodeId: node.id,
    operationId: "operation",
    inputRevision: "initial",
    status: "completed",
    summary: "receipt",
    issues,
    artifactRefs: [],
    evidence: [],
    blockers: [],
  });
  const issue = {
    id: "bug",
    description: "old blocker",
    status: "open" as const,
    blocking: true,
    evidenceRefs: [],
  };
  return { ...h, task, state, node, receipt, issue };
}

test("user revision retains issue history without blocking new reporting or stall, and a new receipt reactivates it", async () => {
  const h = await fixture();
  try {
    mergeStatus(h.state, h.node, h.receipt([h.issue]), "old-output", "old-source");
    assert.equal(h.state.issues[0]?.planVersion, 1);
    markIssuesForRevalidation(h.state);
    h.state.plan.version++;
    assert.equal(h.state.issues[0]?.status, "open");
    assert.equal(h.state.issues[0]?.needsRevalidation, true);
    assert.equal(currentOpenIssues(h.state).length, 0);
    countSettledBatch(h.state, "new-batch", 1);
    assert.deepEqual(h.state.stall.open, []);
    const reporter = h.state.plan.nodes.find((node) => node.phase === "reporting");
    assert.ok(reporter);
    for (const node of h.state.plan.nodes)
      h.state.nodes[node.id] = {
        status: node.id === reporter.id ? "pending" : "completed",
        attempt: 1,
      };
    const participants = h.service.records.participants(h.task).map((participant) => ({
      ...participant,
      status: "idle" as const,
      started: true,
      execution: {
        workspaceId: "workspace",
        paneId: participant.id,
        kind: participant.kind,
        cwd: h.directory,
      },
    }));
    assert.ok(
      workflowCandidates(h.task, h.state, participants, [], false).some(
        (choice) => choice.assignments?.[0]?.nodeId === reporter.id,
      ),
    );
    mergeStatus(
      h.state,
      h.node,
      h.receipt([{ ...h.issue, id: "renamed" }]),
      "new-output",
      "new-source",
    );
    assert.equal(h.state.issues.length, 1);
    assert.equal(h.state.issues[0]?.id, "bug");
    assert.equal(h.state.issues[0]?.planVersion, 2);
    assert.equal(h.state.issues[0]?.needsRevalidation, false);
    assert.equal(currentOpenIssues(h.state).length, 1);
    assert.equal(
      workflowCandidates(h.task, h.state, participants, [], false).some(
        (choice) => choice.assignments?.[0]?.nodeId === reporter.id,
      ),
      false,
    );
  } finally {
    h.close();
  }
});

for (const match of ["id", "description"] as const) {
  test(`participant receipt cannot resolve or downgrade configured verification by ${match}`, async () => {
    const h = await fixture();
    try {
      h.state.issues.push({
        ...h.issue,
        id: "verify-0",
        raisedBy: "myrix",
        verificationCommandIndex: 0,
        planVersion: 1,
        needsRevalidation: true,
        responses: [],
        evidenceRefs: ["real-run"],
      });
      mergeStatus(
        h.state,
        h.node,
        h.receipt([
          {
            ...h.issue,
            id: match === "id" ? "verify-0" : "renamed",
            description: match === "id" ? "claimed success" : h.issue.description,
            status: "resolved",
            blocking: false,
            evidenceRefs: ["agent-claim"],
          },
        ]),
        "agent-output",
        "source",
      );
      const issue = h.state.issues[0];
      assert.ok(issue);
      assert.equal(issue.status, "open");
      assert.equal(issue.blocking, true);
      assert.equal(issue.description, "old blocker");
      assert.equal(issue.needsRevalidation, true);
      assert.deepEqual(issue.evidenceRefs, ["real-run"]);
      assert.deepEqual(issue.responses, [{ outputId: "agent-output", summary: "receipt" }]);
    } finally {
      h.close();
    }
  });
}

test("legacy configured verification issues also reject participant closure", async () => {
  const h = await fixture();
  try {
    h.state.issues.push({ ...h.issue, id: "verify-0", raisedBy: "myrix", responses: [] });
    mergeStatus(
      h.state,
      h.node,
      h.receipt([{ ...h.issue, id: "verify-0", status: "deferred", blocking: false }]),
      "agent-output",
      "source",
    );
    assert.equal(h.state.issues[0]?.status, "open");
    assert.equal(h.state.issues[0]?.blocking, true);
  } finally {
    h.close();
  }
});

for (const status of ["working", "unknown", "idle"] as const) {
  test(`compatible ${status} reviewer does not trigger duplicate reviewer creation`, async () => {
    const h = await fixture();
    try {
      const reviewer = h.state.plan.nodes.find((node) => node.role === "reviewer");
      assert.ok(reviewer);
      reviewer.participantId = undefined;
      for (const node of h.state.plan.nodes)
        h.state.nodes[node.id] = {
          status: node.id === reviewer.id ? "pending" : "completed",
          attempt: 1,
        };
      const participants = h.service.records.participants(h.task).map((participant) => ({
        ...participant,
        started: false,
        status,
        error: status === "unknown" ? "failed" : undefined,
      }));
      assert.equal(
        workflowCandidates(h.task, h.state, participants, [], false).some(
          (choice) => choice.kind === "add_reviewer",
        ),
        false,
      );
      for (const participant of participants) participant.status = "removed" as typeof status;
      assert.ok(
        workflowCandidates(h.task, h.state, participants, [], false).some(
          (choice) => choice.kind === "add_reviewer",
        ),
      );
    } finally {
      h.close();
    }
  });
}
