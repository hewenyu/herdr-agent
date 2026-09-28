import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Outbox } from "../../src/app/outbox.js";
import { OperationError } from "../../src/core/errors.js";
import type { StoredMessage } from "../../src/core/types.js";
import {
  ReportDeliveries,
  type ReportEnvelope,
  reportSummaryText,
} from "../../src/orchestration/report-delivery.js";
import { Store } from "../../src/storage/store.js";
import { FakePlatform } from "../tasks/helpers.js";

function fixture() {
  const store = new Store(":memory:");
  const platform = new FakePlatform();
  const outbox = new Outbox(store, () => platform);
  const deliveries = new ReportDeliveries(store, outbox, () => platform);
  const text = "# 最终报告\n\n实现、验收与证据。";
  const input: ReportEnvelope = {
    taskId: "task",
    eventId: "event",
    reportId: "report",
    reportHash: createHash("sha256").update(text).digest("hex"),
    chatId: "chat",
    text,
    card: {
      header: { title: { content: "报告摘要" } },
      body: { elements: [{ content: "结果与保留事项" }] },
    },
    channel: "platform",
  };
  return { store, platform, outbox, deliveries, input };
}

test("body success and known card failure resumes only the original card after restart", async () => {
  const h = fixture();
  let bodies = 0;
  let cards = 0;
  h.platform.sendText = async () => {
    bodies++;
    return "body-message";
  };
  h.platform.sendCard = async () => {
    cards++;
    if (cards === 1) throw new OperationError("platform_unavailable", "known not sent");
    return "card-message";
  };
  try {
    await assert.rejects(h.deliveries.send(h.input));
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
    assert.equal(h.deliveries.retryable("task", "event", "report"), true);
    assert.equal(h.deliveries.pendingInChat("chat"), true);
    const restarted = new ReportDeliveries(h.store, h.outbox, () => h.platform);
    await restarted.send(h.input);
    await restarted.send(h.input);
    assert.equal(bodies, 1);
    assert.equal(cards, 2);
    assert.equal(await restarted.confirmed("task", "event", "report"), true);
    assert.equal(await restarted.confirmed("task", "event", "other-report"), false);
    assert.equal(restarted.pendingInChat("chat"), false);
  } finally {
    h.store.close();
  }
});

test("unknown card delivery is never replayed and one successful output is insufficient", async () => {
  const h = fixture();
  let cards = 0;
  h.platform.sendText = async () => "body-message";
  h.platform.sendCard = async () => {
    cards++;
    throw new Error("lost response");
  };
  try {
    await assert.rejects(h.deliveries.send(h.input));
    await assert.rejects(
      h.deliveries.send(h.input, async () => {
        assert.fail("an unknown card receipt must not be replaced by a freshness failure");
      }),
      { code: "delivery_uncertain" },
    );
    assert.equal(cards, 1);
    assert.equal(h.deliveries.retryable("task", "event", "report"), false);
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
    assert.equal(h.deliveries.pendingInChat("chat"), true);
  } finally {
    h.store.close();
  }
});

test("partly sent body resumes unsent parts before the card and concurrent retries serialize", async () => {
  const h = fixture();
  const text = "报告".repeat(2500);
  const input = { ...h.input, text, reportHash: createHash("sha256").update(text).digest("hex") };
  const parts: string[] = [];
  let calls = 0;
  let cards = 0;
  h.platform.sendText = async (_chat = "", part = "") => {
    calls++;
    if (calls === 2) throw new OperationError("platform_unavailable", "not sent");
    parts.push(part);
    return `part-${calls}`;
  };
  h.platform.sendCard = async () => {
    cards++;
    return "card-message";
  };
  try {
    await assert.rejects(h.deliveries.send(input));
    assert.equal(cards, 0);
    await Promise.all([h.deliveries.send(input), h.deliveries.send(input)]);
    assert.equal(parts.join(""), text);
    assert.equal(calls, 3);
    assert.equal(cards, 1);
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), true);
  } finally {
    h.store.close();
  }
});

test("frozen report envelope rejects changed text, destination, report identity and receipt corruption", async () => {
  const h = fixture();
  try {
    const record = h.deliveries.prepare(h.input);
    for (const changed of [{ text: "changed" }, { chatId: "other" }, { reportId: "other" }])
      await assert.rejects(h.deliveries.send({ ...h.input, ...changed }));
    h.store.set("workflow_report_deliveries", h.input.eventId, {
      ...record,
      bodyId: "native-output",
    });
    assert.equal(h.deliveries.retryable("task", "event", "report"), false);
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
  } finally {
    h.store.close();
  }
});

test("web confirmation requires both immutable message bodies to receive UI acknowledgements", async () => {
  const h = fixture();
  try {
    const record = h.deliveries.prepare({ ...h.input, channel: "web", chatId: "web:owner" });
    const message = (id: string, text: string): StoredMessage => ({
      id,
      text,
      sessionId: "task-session",
      taskId: "task",
      role: "assistant",
      source: "workflow_report",
      createdAt: new Date().toISOString(),
      delivery: "prepared",
      deliveryIds: [],
      generation: 0,
    });
    const body = message("body", record.text);
    const card = message("card", reportSummaryText(record.card));
    h.store.set("messages", body.id, body);
    h.store.set("messages", card.id, card);
    h.deliveries.bindWeb(record, body.id, card.id);
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
    h.store.set("messages", body.id, { ...body, delivery: "delivered" });
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
    h.store.set("messages", card.id, { ...card, delivery: "delivered" });
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), true);
  } finally {
    h.store.close();
  }
});

test("attachment delivery resumes only known-unsent file/card stages, never broadcasts full report", async () => {
  const h = fixture();
  let uploads = 0;
  let files = 0;
  let cards = 0;
  let texts = 0;
  const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
  platform.uploadFile = async (name, content) => {
    uploads++;
    assert.equal(name, "report.md");
    assert.equal(content, h.input.text);
    return "file-key";
  };
  platform.sendFile = async () => {
    files++;
    if (files === 1) throw new OperationError("platform_unavailable", "not sent");
    return "file-message";
  };
  platform.sendCard = async () => {
    cards++;
    return "card";
  };
  platform.sendText = async () => {
    texts++;
    return "text";
  };
  const input = { ...h.input, presentation: "attachment" as const };
  try {
    await assert.rejects(h.deliveries.send(input));
    assert.equal(h.deliveries.retryable("task", "event", "report"), true);
    await new ReportDeliveries(h.store, h.outbox, () => platform).send(input);
    assert.deepEqual(
      { uploads, files, cards, texts },
      { uploads: 1, files: 2, cards: 1, texts: 0 },
    );
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), true);
    assert.equal(h.deliveries.pendingInChat("chat"), false);
  } finally {
    h.store.close();
  }
});

for (const stage of ["upload", "send"] as const)
  test(`unknown attachment ${stage} is never repeated`, async () => {
    const h = fixture();
    let uploads = 0;
    let files = 0;
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    platform.uploadFile = async () => {
      uploads++;
      if (stage === "upload") throw new Error("lost upload response");
      return "key";
    };
    platform.sendFile = async () => {
      files++;
      throw new Error("lost send response");
    };
    const input = { ...h.input, presentation: "attachment" as const };
    try {
      await assert.rejects(h.deliveries.send(input));
      let guards = 0;
      await assert.rejects(
        new ReportDeliveries(h.store, h.outbox, () => platform).send(input, async () => {
          guards++;
          throw new OperationError("workflow_report", "stale Git facts");
        }),
        { code: "delivery_uncertain" },
      );
      assert.equal(guards, 0, "unknown effects retain priority over freshness checks");
      assert.equal(uploads, 1);
      assert.equal(files, stage === "send" ? 1 : 0);
      assert.equal(h.deliveries.retryable("task", "event", "report"), false);
      assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
    } finally {
      h.store.close();
    }
  });

for (const boundary of ["upload", "file", "card"] as const)
  test(`attachment freshness is checked before ${boundary}, including retries without replaying completed stages`, async () => {
    const h = fixture();
    const platform = h.platform as import("../../src/core/ports.js").PlatformPort;
    const input = { ...h.input, presentation: "attachment" as const };
    const calls = { uploads: 0, files: 0, cards: 0 };
    let fresh = boundary !== "upload";
    const guard = async () => {
      if (!fresh) throw new OperationError("workflow_report", "Git facts changed");
    };
    platform.uploadFile = async () => {
      calls.uploads++;
      if (boundary === "file") fresh = false;
      return "file-key";
    };
    platform.sendFile = async () => {
      calls.files++;
      if (boundary === "card") fresh = false;
      return "file-message";
    };
    platform.sendCard = async () => {
      calls.cards++;
      return "card-message";
    };
    try {
      await assert.rejects(h.deliveries.send(input, guard), { code: "workflow_report" });
      const expected = {
        uploads: boundary === "upload" ? 0 : 1,
        files: boundary === "card" ? 1 : 0,
        cards: 0,
      };
      assert.deepEqual(calls, expected);
      assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
      assert.equal(h.deliveries.retryable("task", "event", "report"), true);
      const restarted = new ReportDeliveries(h.store, h.outbox, () => platform);
      await assert.rejects(restarted.send(input, guard), { code: "workflow_report" });
      assert.deepEqual(calls, expected, "retry checks freshness before its next unsent stage");
      fresh = true;
      await restarted.send(input, guard);
      assert.deepEqual(calls, { uploads: 1, files: 1, cards: 1 });
      await restarted.send(input, async () => {
        assert.fail("a fully delivered receipt must not re-enter effect guards");
      });
      assert.deepEqual(calls, { uploads: 1, files: 1, cards: 1 });
      assert.equal(await restarted.confirmed("task", "event", "report"), true);
      const record = h.store.get<Record<string, unknown>>("workflow_report_deliveries", "event");
      assert.equal(record?.text, input.text);
      assert.equal(record?.beforeSend, undefined, "callbacks are never persisted in the envelope");
    } finally {
      h.store.close();
    }
  });

test("web attachment report uses one visible summary and a hash-bound complete download", async () => {
  const h = fixture();
  try {
    const record = h.deliveries.prepare({
      ...h.input,
      presentation: "attachment",
      channel: "web",
      chatId: "web:owner",
    });
    const message: StoredMessage = {
      id: "summary",
      taskId: "task",
      sessionId: "session",
      role: "assistant",
      source: "workflow_report_summary",
      text: reportSummaryText(record.card),
      createdAt: new Date().toISOString(),
      delivery: "prepared",
      deliveryIds: [],
      generation: 0,
    };
    h.store.set("messages", message.id, message);
    h.deliveries.bindWeb(record, undefined, message.id);
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), false);
    assert.equal(h.deliveries.download("task", "summary").content, h.input.text);
    assert.throws(() => h.deliveries.download("other-task", "summary"));
    h.store.set("messages", message.id, { ...message, delivery: "delivered" });
    assert.equal(await h.deliveries.confirmed("task", "event", "report"), true);
  } finally {
    h.store.close();
  }
});
