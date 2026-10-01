import assert from "node:assert/strict";
import test from "node:test";
import { reconcileLeaderReceipts } from "../../src/app/leader-receipts.js";
import {
  EVENT,
  harness,
  leaderOperation,
  nativeRow,
  REVISION,
  runNativeSend,
  seedLeaderTask,
  seedOperation,
} from "./leader-receipts-helpers.js";

/**
 * The initial-turn proof must accept exactly the writer's marker line and the
 * participant's own token line, in one of the two documented spacings. These
 * cases pin the whole-line semantics directly, including the two lookalikes an
 * unanchored substring search used to accept:
 *  - a token line that merely starts with the own token (`<token>-FOREIGN`);
 *  - a line that merely ends with the marker text (`伪造前缀投递标识（无需复述）：`).
 * A genuine marker+token section later in the body must still prove the body,
 * and neither mismatch may ever resolve, resend or replay anything.
 */

const MARKER = "投递标识（无需复述）：";

interface Seeded {
  h: ReturnType<typeof harness>;
  taskId: string;
  operationId: string;
  nativeId: string;
  token: string;
  text: string;
}

/** Seed one real initial native send, its Leader receipt and the session scope. */
async function seedInitial(
  h: ReturnType<typeof harness>,
  taskId: string,
  promptVersion?: 2 | 3,
): Promise<Seeded> {
  const participantId = `${taskId}:p1`;
  seedLeaderTask(h.store, taskId, participantId);
  const text = "首轮完整要求。";
  const spec = {
    taskId,
    participantId,
    text,
    initial: true as const,
    ...(promptVersion ? { promptVersion } : {}),
  };
  const nativeId = await runNativeSend(h, spec);
  const token = h.store.get<{ receipt?: string }>("input_deliveries", nativeId)?.receipt as string;
  assert.ok(token, "the native prep carries the participant's own receipt token");
  const operation = seedOperation(h.store, {
    taskId,
    tool: "participant_send",
    args: { participantId, text },
    state: "pending",
  });
  return { h, taskId, operationId: operation.id, nativeId, token, text };
}

/** Rewrite the durable delivery body without touching any other native record. */
function rewritePrompt(
  h: ReturnType<typeof harness>,
  nativeId: string,
  mutate: (prompt: string, token: string) => string,
): void {
  const delivery = h.store.get<Record<string, unknown>>("input_deliveries", nativeId);
  assert.ok(delivery);
  const prompt = String(delivery.prompt);
  const token = String(delivery.receipt);
  const altered = mutate(prompt, token);
  assert.notEqual(altered, prompt, "the corruption must really change the body");
  h.store.set("input_deliveries", nativeId, { ...delivery, prompt: altered });
}

function assertBlockedOnce(s: Seeded, label: string): void {
  const before = s.h.effects;
  const report = reconcileLeaderReceipts(s.h.store, s.taskId);
  assert.equal(report.changed, false, label);
  assert.deepEqual(
    report.blocked.map((entry) => entry.operationId),
    [s.operationId],
    label,
  );
  assert.deepEqual(report.resolved, [], label);
  assert.equal(leaderOperation(s.h.store, s.taskId, s.operationId).state, "pending", label);
  assert.equal(nativeRow(s.h.store, s.nativeId).state, "done", label);
  assert.equal(s.h.effects, before, `${label}: no native effect is ever repeated`);
}

function assertResolvesOnce(s: Seeded, label: string): void {
  const before = s.h.effects;
  const report = reconcileLeaderReceipts(s.h.store, s.taskId);
  assert.deepEqual(
    report.resolved.map((entry) => entry.operationId),
    [s.operationId],
    label,
  );
  assert.equal(leaderOperation(s.h.store, s.taskId, s.operationId).state, "complete", label);
  assert.equal(nativeRow(s.h.store, s.nativeId).state, "done", label);
  assert.equal(s.h.effects, before, `${label}: reconciliation never resends native input`);
  // A second reconcile has nothing pending left and must not touch native state.
  const again = reconcileLeaderReceipts(s.h.store, s.taskId);
  assert.deepEqual(again.resolved, [], label);
  assert.equal(s.h.effects, before, label);
}

test("a longer foreign token that merely starts with the own token stays blocked", async () => {
  for (const promptVersion of [undefined, 2, 3] as const) {
    const h = harness();
    try {
      const s = await seedInitial(h, `task-token-prefix-v${promptVersion ?? 1}`, promptVersion);
      rewritePrompt(h, s.nativeId, (prompt, token) => prompt.replace(token, `${token}-FOREIGN`));
      assertBlockedOnce(s, `prompt v${promptVersion ?? 1}`);
    } finally {
      h.store.close();
      h.close();
    }
  }
});

test("a longer foreign token that merely ends with the own token stays blocked", async () => {
  const h = harness();
  try {
    const s = await seedInitial(h, "task-token-suffix");
    rewritePrompt(h, s.nativeId, (prompt, token) => prompt.replace(token, `FOREIGN-${token}`));
    assertBlockedOnce(s, "token suffix");
  } finally {
    h.store.close();
    h.close();
  }
});

test("a lookalike line ending with the marker text stays blocked", async () => {
  for (const promptVersion of [undefined, 2, 3] as const) {
    const h = harness();
    try {
      const s = await seedInitial(h, `task-marker-prefix-v${promptVersion ?? 1}`, promptVersion);
      rewritePrompt(h, s.nativeId, (prompt) => prompt.replace(MARKER, `伪造前缀${MARKER}`));
      assertBlockedOnce(s, `prompt v${promptVersion ?? 1}`);
    } finally {
      h.store.close();
      h.close();
    }
  }
});

test("a marker line with added text or surrounding space stays blocked", async () => {
  const variants: Array<[string, (prompt: string, token: string) => string]> = [
    ["marker suffix", (prompt) => prompt.replace(MARKER, `${MARKER}（补充）`)],
    ["marker leading space", (prompt) => prompt.replace(MARKER, ` ${MARKER}`)],
    ["marker trailing space", (prompt) => prompt.replace(MARKER, `${MARKER} `)],
    [
      "token line trailing space",
      (prompt, token) =>
        prompt
          .split("\n")
          .map((line) => (line === token ? `${line} ` : line))
          .join("\n"),
    ],
    [
      "token line leading space",
      (prompt, token) =>
        prompt
          .split("\n")
          .map((line) => (line === token ? ` ${line}` : line))
          .join("\n"),
    ],
  ];
  for (const [label, mutate] of variants) {
    const h = harness();
    try {
      const s = await seedInitial(h, `task-marker-variant-${label.replace(/\s+/g, "-")}`);
      rewritePrompt(h, s.nativeId, mutate);
      assertBlockedOnce(s, label);
    } finally {
      h.store.close();
      h.close();
    }
  }
});

test("a genuine marker+token section later in the body still proves the whole body", async () => {
  for (const promptVersion of [undefined, 2, 3] as const) {
    const h = harness();
    try {
      const s = await seedInitial(h, `task-later-section-v${promptVersion ?? 1}`, promptVersion);
      // An earlier lookalike section must not mask the real one that follows it.
      rewritePrompt(h, s.nativeId, (prompt, token) => `${MARKER}\n${token}-FOREIGN\n\n${prompt}`);
      assertResolvesOnce(s, `prompt v${promptVersion ?? 1}`);
    } finally {
      h.store.close();
      h.close();
    }
  }
});

test("both documented spacings and the v2 trailing footer stay accepted", async () => {
  for (const promptVersion of [undefined, 2, 3] as const) {
    const h = harness();
    try {
      const s = await seedInitial(h, `task-spacing-v${promptVersion ?? 1}`, promptVersion);
      const delivery = h.store.get<{ prompt?: string }>("input_deliveries", s.nativeId);
      const prompt = String(delivery?.prompt);
      const direct = prompt.includes(`${MARKER}\n${s.token}`);
      const blank = prompt.includes(`${MARKER}\n\n${s.token}`);
      assert.ok(
        promptVersion === 3 ? blank : direct,
        `prompt v${promptVersion ?? 1} uses its documented spacing`,
      );
      if (promptVersion === 2)
        assert.equal(prompt.endsWith(s.token), false, "the v2 footer follows the token");
      assertResolvesOnce(s, `prompt v${promptVersion ?? 1}`);
    } finally {
      h.store.close();
      h.close();
    }
  }
});

test("a foreign event revision or dispatch link never resolves the exact body", async () => {
  const h = harness();
  try {
    const s = await seedInitial(h, "task-lines-identity");
    // The body is exact; only the identity link is foreign. Whole-line matching
    // must not bypass the event/revision/dispatch proofs around it.
    h.store.set("task_orchestration_events", EVENT, {
      ...h.store.get<Record<string, unknown>>("task_orchestration_events", EVENT),
      userRevision: "other-revision",
    });
    assertBlockedOnce(s, "foreign revision");
    // Restoring the exact revision link proves the body itself was never the
    // reason the mismatch above stayed blocked.
    h.store.set("task_orchestration_events", EVENT, {
      ...h.store.get<Record<string, unknown>>("task_orchestration_events", EVENT),
      userRevision: REVISION,
    });
    assertResolvesOnce(s, "restored revision");
  } finally {
    h.store.close();
    h.close();
  }
});
