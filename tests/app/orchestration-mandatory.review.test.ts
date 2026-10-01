import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMandatoryContextFits,
  boundActivationEnvelope,
  mandatoryOnlyPrompt,
  taskContextEnvelope,
} from "../../src/app/orchestration-context.js";
import type { StoredMessage } from "../../src/core/types.js";
import { actor, discussion, setup } from "../tasks/helpers.js";

const marker = "HARD_CONSTRAINT: no deployment, no directory widening, no close without acceptance";

async function fixture(text: string) {
  const h = setup();
  const task = await h.service.create(actor, discussion);
  const message: StoredMessage = {
    id: "authenticated-user-revision",
    sessionId: actor.sessionId,
    taskId: task.id,
    role: "user",
    source: "feishu",
    text,
    createdAt: "2026-09-30T00:00:00Z",
    delivery: "delivered",
    deliveryIds: [],
    generation: 0,
  };
  const envelope = taskContextEnvelope({
    task,
    participants: h.service.records.participants(task),
    userMessages: [message],
    mutations: [],
    outputs: [],
    decisions: [],
    event: { id: "event", trigger: "user_revision", outputIds: [] },
  });
  return { ...h, envelope, message };
}

test("legacy Leader retains a complete authenticated revision beyond the 20000-byte prefix", async () => {
  const text = `${"context ".repeat(4000)}\n${marker}`;
  const h = await fixture(text);
  try {
    const bounded = boundActivationEnvelope(h.envelope, { tokenBudget: 44880 });
    const parsed = JSON.parse(bounded.prompt) as { userRevisions: Array<{ text: string }> };
    assert.ok(
      parsed.userRevisions[0]?.text === text,
      "a full-text pointer or truncation notice cannot replace unseen current constraints",
    );
    assert.ok(bounded.bytes > 12288, "complete mandatory input may use out-of-line delivery");
  } finally {
    h.close();
  }
});

test("mandatory-only budget accounting includes every authenticated user revision", async () => {
  const h = await fixture(marker);
  try {
    const mandatory = JSON.parse(mandatoryOnlyPrompt(h.envelope)) as {
      userRevisions?: Array<{ id: string; text: string }>;
    };
    assert.ok(mandatory.userRevisions, "user revisions are not optional observations");
    assert.equal(mandatory.userRevisions.length, 1);
    assert.equal(mandatory.userRevisions[0]?.id, h.message.id);
    assert.equal(mandatory.userRevisions[0]?.text, marker);
  } finally {
    h.close();
  }
});

test("unfit authenticated revisions are refused rather than excluded from the mandatory budget", async () => {
  const h = await fixture(`${"context ".repeat(40000)}\n${marker}`);
  try {
    assert.throws(
      () =>
        assertMandatoryContextFits({
          engineTokens: 50000,
          prompt: mandatoryOnlyPrompt(h.envelope),
        }),
      { code: "orchestration_context_budget", outcome: "not_executed" },
    );
  } finally {
    h.close();
  }
});
