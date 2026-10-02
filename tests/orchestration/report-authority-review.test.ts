import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Outbox } from "../../src/app/outbox.js";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformPort } from "../../src/core/ports.js";
import { ReportDeliveries, type ReportEnvelope } from "../../src/orchestration/report-delivery.js";
import { Store } from "../../src/storage/store.js";
import { FakePlatform } from "../tasks/helpers.js";

const namespace = "workflow_report_deliveries";

for (const corruption of [
  "null",
  "false",
  "zero",
  "empty string",
  "unknown card state",
  "missing card state",
  "unknown file state",
  "missing file state",
  "mismatched event identity",
  "incomplete file retry",
  "incomplete file treat_done",
  "incomplete file abandon",
  "spent file retry",
  "null file history",
  "malformed file history",
  "missing file history resolution",
  "non-retry file history",
] as const) {
  test(`a damaged report receipt (${corruption}) cannot authorize another delivery`, async () => {
    const store = new Store(":memory:");
    const platform: PlatformPort = new FakePlatform();
    let effects = 0;
    platform.sendText = async () => {
      effects++;
      return "body";
    };
    platform.sendCard = async () => {
      effects++;
      return "card";
    };
    platform.uploadFile = async () => {
      effects++;
      return "file";
    };
    platform.sendFile = async () => {
      effects++;
      return "file-message";
    };
    const deliveries = new ReportDeliveries(
      store,
      new Outbox(store, () => platform),
      () => platform,
    );
    const text = "Frozen report";
    const input: ReportEnvelope = {
      taskId: "task",
      eventId: "event",
      reportId: "report",
      reportHash: createHash("sha256").update(text).digest("hex"),
      chatId: "chat",
      text,
      card: { body: { elements: [{ content: "summary" }] } },
      channel: "platform",
      ...(corruption.includes("file ") ? { presentation: "attachment" as const } : {}),
    };
    try {
      const prepared = deliveries.prepare(
        corruption === "mismatched event identity" ? { ...input, eventId: "another-event" } : input,
      );
      const roots: Record<string, unknown> = {
        null: null,
        false: false,
        zero: 0,
        "empty string": "",
      };
      const resolution = {
        choice: "retry",
        decidedBy: "user",
        reason: "One explicitly authorized retry.",
        at: "2026-10-01T00:00:00.000Z",
      };
      const fileDamage: Record<string, Record<string, unknown>> = {
        "incomplete file retry": { fileResolution: { choice: "retry" } },
        "incomplete file treat_done": { fileResolution: { choice: "treat_done" } },
        "incomplete file abandon": { fileResolution: { choice: "abandon" } },
        "spent file retry": {
          fileResolution: resolution,
          fileHistory: [
            { fileState: "uncertain", fileResolution: resolution, updatedAt: resolution.at },
          ],
        },
        "non-retry file history": {
          fileResolution: resolution,
          fileHistory: [{ fileResolution: { ...resolution, choice: "abandon" } }],
        },
        "null file history": { fileResolution: resolution, fileHistory: null },
        "malformed file history": { fileResolution: resolution, fileHistory: "not-history" },
        "missing file history resolution": {
          fileResolution: resolution,
          fileHistory: [{ fileState: "uncertain", updatedAt: resolution.at }],
        },
      };
      const state = corruption.startsWith("missing") ? undefined : "unrecognized";
      const row = Object.hasOwn(roots, corruption)
        ? roots[corruption]
        : fileDamage[corruption] !== undefined
          ? { ...prepared, fileState: "uncertain", ...fileDamage[corruption] }
          : corruption.includes("card state")
            ? { ...prepared, cardState: state }
            : corruption.includes("file state")
              ? { ...prepared, fileState: state }
              : prepared;
      store.set(namespace, input.eventId, row);
      const before = store.entries(namespace);
      const error: unknown = await deliveries.send(input).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.equal(effects, 0, "a damaged receipt must not authorize delivery");
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "report_delivery_conflict");
      assert.deepEqual(store.entries(namespace), before);
      assert.deepEqual(store.list("outbox"), []);
    } finally {
      store.close();
    }
  });
}
