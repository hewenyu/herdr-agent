import assert from "node:assert/strict";
import { test } from "node:test";
import { type UncertainCard, UncertainCards } from "../../src/app/uncertain-cards.js";
import { uncertainCandidates } from "../../src/app/uncertain-choice.js";
import { UncertainResolver } from "../../src/app/uncertain-resolver.js";
import { canonical, stableId } from "../../src/core/ids.js";
import type { Participant, Task } from "../../src/core/types.js";
import type { ReportDelivery } from "../../src/orchestration/report-delivery.js";
import { type OperationReceipt, Operations } from "../../src/storage/operations.js";
import { setup as taskSetup } from "../tasks/helpers.js";
import { Engine, logger, Platform } from "./helpers.js";

function setup(kind: "pane_close" | "input_delivery" | "report_file" = "input_delivery") {
  const h = taskSetup();
  const engine = new Engine();
  const platform = new Platform();
  const task = {
    id: "task",
    ownerId: "owner",
    chatId: "chat",
    status: "review",
    participantIds: ["task:p1"],
  } as Task;
  const execution = {
    paneId: "pane",
    workspaceId: "workspace",
    kind: "codex",
    cwd: h.directory,
  } as const;
  const participant = { id: "task:p1", taskId: task.id, execution, started: true } as Participant;
  const id =
    kind === "pane_close"
      ? `${participant.id}:close`
      : kind === "report_file"
        ? "report-file:event"
        : "task:send:unknown";
  const receipt: OperationReceipt = {
    id,
    fingerprint: stableId(canonical(execution)),
    state: "uncertain",
    updatedAt: new Date().toISOString(),
  };
  h.store.set("tasks", task.id, task);
  h.store.set("participants", participant.id, participant);
  if (kind === "report_file")
    h.store.set("workflow_report_deliveries", "event", {
      eventId: "event",
      taskId: task.id,
      fingerprint: "report",
      fileState: "uncertain",
    });
  else h.store.set("operations", id, receipt);
  const context = {
    ...h.options,
    platform,
    records: h.service.records,
    operations: new Operations(h.store),
    signal: h.service.signal,
  };
  const ports = {
    store: h.store,
    engine,
    logger,
    context: () => context,
    platform: () => platform,
    actor: () => ({
      source: "system" as const,
      ownerId: "owner",
      chatId: "chat",
      taskId: task.id,
      sessionId: "session",
      messageId: "tick",
    }),
  };
  const resolver = new UncertainResolver(ports);
  const select = (choice: string) => {
    engine.handler = async (input) => {
      await input.tools[0]?.execute({ candidateId: choice }, input.actor);
      return { text: "", messages: [] };
    };
  };
  const candidates = () =>
    (
      JSON.parse(engine.calls[0]?.prompt ?? "{}") as {
        candidates: Array<{ id: string }>;
      }
    ).candidates.map((candidate) => candidate.id);
  const card = () => {
    const value = h.store.list<UncertainCard>("uncertain_cards")[0];
    assert.ok(value);
    return value;
  };
  return {
    ...h,
    engine,
    platform,
    task,
    participant,
    id,
    receipt,
    ports,
    resolver,
    select,
    candidates,
    card,
  };
}

test("pane absence is resolved by evidence without pi or any close side effect", async () => {
  const h = setup("pane_close");
  try {
    await h.resolver.tick([h.task]);
    assert.equal(
      h.store.get<OperationReceipt>("operations", h.id)?.resolution?.decidedBy,
      "evidence",
    );
    assert.equal(h.engine.calls.length, 0);
    assert.equal(h.herdr.closes, 0);
    assert.equal(h.platform.cards.length, 0);
  } finally {
    h.close();
  }
});

test("pi treat_as_done persists a pi resolution once across two ticks", async () => {
  const h = setup();
  try {
    h.select("treat_as_done");
    await h.resolver.tick([h.task]);
    await h.resolver.tick([h.task]);
    const resolution = h.store.get<OperationReceipt>("operations", h.id)?.resolution;
    assert.equal(resolution?.choice, "treat_done");
    assert.equal(resolution?.decidedBy, "pi");
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.herdr.sends.length, 0);
  } finally {
    h.close();
  }
});

test("pi escalation publishes one human-only card and consumes the answer once", async () => {
  const h = setup();
  try {
    h.select("escalate_to_user");
    await h.resolver.tick([h.task]);
    await new UncertainResolver(h.ports).tick([h.task]);
    assert.equal(h.engine.calls.length, 1);
    assert.equal(h.platform.cards.length, 1);
    const card = h.card();
    assert.ok(!card.candidates.some((candidate) => candidate.id === "escalate_to_user"));
    platformAssert(h.platform.cards[0]?.card);
    await h.resolver.cards.answer("owner", "chat", card.nonce, "treat_as_done");
    assert.equal(h.store.get<OperationReceipt>("operations", h.id)?.resolution?.decidedBy, "user");
    await assert.rejects(
      h.resolver.cards.answer("owner", "chat", card.nonce, "treat_as_done"),
      /已处理/,
    );
  } finally {
    h.close();
  }
});

function platformAssert(card: Record<string, unknown> | undefined) {
  assert.match(JSON.stringify(card), /"action":"uncertain"/);
  assert.doesNotMatch(JSON.stringify(card), /escalate_to_user/);
}

for (const kind of ["input_delivery", "report_file"] as const) {
  test(`${kind}: prior retry is excluded from pi and defensive card publication`, async () => {
    const h = setup(kind);
    try {
      const resolution = {
        choice: "retry" as const,
        decidedBy: "user" as const,
        reason: "one retry",
        at: new Date().toISOString(),
      };
      if (kind === "report_file") {
        const record = h.store.get<ReportDelivery>("workflow_report_deliveries", "event");
        h.store.set("workflow_report_deliveries", "event", {
          ...record,
          fileHistory: [{ fileResolution: resolution }],
        });
      } else
        h.store.set("operations", h.id, {
          ...h.receipt,
          history: [{ ...h.receipt, resolution }],
        });
      h.select("escalate_to_user");
      await h.resolver.tick([h.task]);
      assert.ok(!h.candidates().includes("retry_once"));
      assert.ok(!h.card().candidates.some((candidate) => candidate.id === "retry_once"));
      const publisher = new UncertainCards(
        h.store,
        () => h.platform,
        async () => {},
      );
      const defensive = await publisher.publish({
        ...h.card(),
        revision: `${h.card().revision}:defensive`,
        candidates: uncertainCandidates,
      });
      assert.ok(!defensive.candidates.some((candidate) => candidate.id === "retry_once"));
      assert.ok(!defensive.candidates.some((candidate) => candidate.id === "escalate_to_user"));
      assert.ok(
        h.store
          .list<UncertainCard>("uncertain_cards")
          .every((card) => !card.candidates.some((candidate) => candidate.id === "retry_once")),
      );
    } finally {
      h.close();
    }
  });
}

test("pane_close offers abandon only to the human owner", async () => {
  const h = setup("pane_close");
  try {
    h.herdr.paneExists = async () => true;
    h.select("escalate_to_user");
    await h.resolver.tick([h.task]);
    assert.ok(!h.candidates().includes("abandon_step"));
    assert.ok(h.card().candidates.some((candidate) => candidate.id === "abandon_step"));
    await h.resolver.cards.answer("owner", "chat", h.card().nonce, "abandon_step");
    assert.equal(h.store.get<OperationReceipt>("operations", h.id)?.resolution?.choice, "abandon");
    assert.equal(h.herdr.closes, 0);
  } finally {
    h.close();
  }
});

test("card answers reject groupDeleted tasks without consuming or resolving", async () => {
  const h = setup();
  try {
    h.select("escalate_to_user");
    await h.resolver.tick([h.task]);
    h.store.set("tasks", h.task.id, { ...h.task, groupDeleted: true });
    await assert.rejects(
      h.resolver.cards.answer("owner", "chat", h.card().nonce, "retry_once"),
      /失效/,
    );
    assert.equal(h.card().consumed, false);
    assert.equal(h.store.get<OperationReceipt>("operations", h.id)?.resolution, undefined);
  } finally {
    h.close();
  }
});

test("pi failure escalates only once and does not stop another effect", async () => {
  const h = setup();
  try {
    h.store.set("operations", "task:send:second", { ...h.receipt, id: "task:send:second" });
    h.engine.handler = async () => {
      throw new Error("pi failed");
    };
    await h.resolver.tick([h.task]);
    await h.resolver.tick([h.task]);
    assert.equal(h.engine.calls.length, 2);
    assert.equal(h.platform.cards.length, 2);
  } finally {
    h.close();
  }
});
