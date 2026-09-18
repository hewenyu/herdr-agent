import assert from "node:assert/strict";
import test from "node:test";
import { Outbox } from "../../src/app/outbox.js";
import { OperationError } from "../../src/core/errors.js";
import { stableId } from "../../src/core/ids.js";
import type { PlatformPort } from "../../src/core/ports.js";
import { Store } from "../../src/storage/store.js";

function fixture() {
  const store = new Store(":memory:");
  const calls: Array<{ chatId: string; text: string; key: string; replyTo?: string }> = [];
  let failureAt = 0;
  let failure: OperationError | undefined;
  const platform = {
    async sendText(chatId: string, text: string, key: string, replyTo?: string) {
      calls.push({ chatId, text, key, replyTo });
      if (calls.length === failureAt) throw failure;
      return `message-${calls.length}`;
    },
  } as PlatformPort;
  return {
    store,
    calls,
    outbox: () => new Outbox(store, () => platform),
    rejectAt(index: number, outcome: "not_executed" | "unknown" = "not_executed") {
      failureAt = index;
      failure = new OperationError("send_failure", "发送失败", outcome);
    },
  };
}

test("legacy chat delivery evidence is read-only and never proves a reply target", async () => {
  const h = fixture();
  const delivered = {
    id: "receipt",
    chatId: "chat",
    text: "正文附文",
    parts: ["正文", "附文"],
    ids: ["sent-1", "sent-2"],
    state: "delivered",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  try {
    h.store.set("outbox", "receipt", delivered);
    assert.deepEqual(h.outbox().legacyDeliveredToChat("chat", delivered.text, "receipt"), {
      ids: delivered.ids,
      updatedAt: delivered.updatedAt,
    });
    assert.equal(h.outbox().legacyDeliveredToChat("other", delivered.text, "receipt"), undefined);
    assert.equal(h.outbox().legacyDeliveredToChat("chat", "changed", "receipt"), undefined);
    assert.equal(h.outbox().legacyDeliveredToChat("chat", delivered.text, "other"), undefined);
    await assert.rejects(h.outbox().send("chat", delivered.text, "receipt", "parent"), {
      code: "outbox_envelope_unknown",
    });
    assert.deepEqual(h.store.get("outbox", "receipt"), delivered);
    assert.equal(h.calls.length, 0);
    for (const patch of [
      { state: "uncertain" },
      { state: "sending" },
      { state: "prepared" },
      { state: "retryable" },
      { ids: ["sent-1"] },
      { ids: ["sent-1", ""] },
      { parts: ["different", "正文"] },
      { id: "other" },
      { envelope: { version: 1, replyTo: "parent", fingerprint: "invalid" } },
    ]) {
      const record = { ...delivered, ...patch };
      h.store.set("outbox", "receipt", record);
      assert.equal(h.outbox().legacyDeliveredToChat("chat", delivered.text, "receipt"), undefined);
      assert.deepEqual(h.store.get("outbox", "receipt"), record);
    }
  } finally {
    h.store.close();
  }
});

test("outbox reuses the same complete envelope and refuses a changed reply target after restart", async () => {
  const h = fixture();
  try {
    const ids = await h.outbox().send("chat", "正文", "receipt", "parent-a");
    const saved = h.store.get("outbox", "receipt");
    assert.deepEqual(await h.outbox().send("chat", "正文", "receipt", "parent-a"), ids);
    for (const replyTo of ["parent-b", undefined])
      await assert.rejects(h.outbox().send("chat", "正文", "receipt", replyTo), {
        code: "outbox_conflict",
      });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.store.get("outbox", "receipt"), saved);
  } finally {
    h.store.close();
  }
});

test("a direct message receipt cannot be reused as a reply", async () => {
  const h = fixture();
  try {
    await h.outbox().send("chat", "正文", "receipt");
    await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent"), {
      code: "outbox_conflict",
    });
    assert.equal(h.calls.length, 1);
  } finally {
    h.store.close();
  }
});

for (const failedPart of [0, 1]) {
  test(`multipart recovery after refused part ${failedPart} preserves the original reply target and keys`, async () => {
    const h = fixture();
    try {
      const text = "🟢".repeat(3501);
      h.rejectAt(failedPart + 1);
      await assert.rejects(h.outbox().send("chat", text, "receipt", "parent-a"), {
        code: "send_failure",
      });
      const saved = h.store.get("outbox", "receipt");
      await assert.rejects(h.outbox().send("chat", text, "receipt", "parent-b"), {
        code: "outbox_conflict",
      });
      assert.deepEqual(h.store.get("outbox", "receipt"), saved);
      const ids = await h.outbox().send("chat", text, "receipt", "parent-a");
      assert.equal(ids.length, 2);
      assert.equal(h.calls.length, 3);
      assert.equal(h.calls[0]?.replyTo, "parent-a");
      assert.equal(h.calls[1]?.replyTo, failedPart === 0 ? "parent-a" : undefined);
      assert.equal(h.calls[2]?.replyTo, undefined);
      assert.deepEqual(
        h.calls.map((call) => call.key),
        (failedPart === 0 ? [0, 0, 1] : [0, 1, 1]).map((index) =>
          stableId("receipt", String(index)),
        ),
      );
      assert.equal(h.calls[0]?.text, "🟢".repeat(3500));
      assert.equal(h.calls.at(-1)?.text, "🟢");
    } finally {
      h.store.close();
    }
  });
}

test("unknown send retains its frozen envelope and never retries or changes targets", async () => {
  const h = fixture();
  try {
    h.rejectAt(1, "unknown");
    await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent-a"));
    const saved = h.store.get("outbox", "receipt");
    await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent-a"), {
      code: "delivery_uncertain",
      outcome: "unknown",
    });
    await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent-b"), {
      code: "outbox_conflict",
    });
    assert.deepEqual(h.store.get("outbox", "receipt"), saved);
    assert.equal(h.calls.length, 1);
  } finally {
    h.store.close();
  }
});

for (const state of ["sending", "uncertain", "delivered", "prepared", "retryable"] as const) {
  test(`legacy ${state} receipt with possible effects never guesses the missing envelope`, async () => {
    const h = fixture();
    try {
      const partial = state === "prepared" || state === "retryable";
      const saved = {
        id: "receipt",
        chatId: "chat",
        text: partial ? "正文附文" : "正文",
        parts: partial ? ["正文", "附文"] : ["正文"],
        ids: ["sending", "uncertain"].includes(state) ? [] : ["already-sent"],
        state,
        error: {
          code: "legacy",
          message: "旧错误",
          outcome: state === "retryable" ? "not_executed" : "unknown",
        },
        updatedAt: "2026-09-01T00:00:00.000Z",
      };
      h.store.set("outbox", "receipt", saved);
      for (const replyTo of [undefined, "parent-a", "parent-b"])
        await assert.rejects(h.outbox().send("chat", saved.text, "receipt", replyTo), {
          code: ["sending", "uncertain"].includes(state)
            ? "delivery_uncertain"
            : "outbox_envelope_unknown",
          outcome: "unknown",
        });
      assert.deepEqual(h.store.get("outbox", "receipt"), saved);
      assert.deepEqual(h.outbox().receipt("receipt"), { state, ids: saved.ids });
      assert.equal(h.calls.length, 0);
    } finally {
      h.store.close();
    }
  });
}

for (const outcome of [undefined, "unknown"]) {
  test(`legacy retryable without a definite refusal (${outcome}) cannot invent its envelope`, async () => {
    const h = fixture();
    try {
      const saved = {
        id: "receipt",
        chatId: "chat",
        text: "正文",
        parts: ["正文"],
        ids: [],
        state: "retryable",
        ...(outcome ? { error: { code: "lost", message: "未确认", outcome } } : {}),
        updatedAt: "2026-09-01T00:00:00.000Z",
      };
      h.store.set("outbox", "receipt", saved);
      await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent"), {
        code: "outbox_envelope_unknown",
        outcome: "unknown",
      });
      assert.deepEqual(h.store.get("outbox", "receipt"), saved);
      assert.equal(h.calls.length, 0);
    } finally {
      h.store.close();
    }
  });
}

test("the persisted fingerprint rejects altered parts before continuing a refused send", async () => {
  const h = fixture();
  try {
    h.rejectAt(1);
    await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent"));
    const saved = h.store.get<Record<string, unknown>>("outbox", "receipt");
    const altered = { ...saved, parts: ["不同正文"] };
    h.store.set("outbox", "receipt", altered);
    await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent"), {
      code: "outbox_conflict",
    });
    assert.deepEqual(h.store.get("outbox", "receipt"), altered);
    assert.equal(h.calls.length, 1);
  } finally {
    h.store.close();
  }
});

for (const state of ["prepared", "retryable"] as const) {
  test(`legacy ${state} without an external effect can freeze its first reply target`, async () => {
    const h = fixture();
    try {
      h.store.set("outbox", "receipt", {
        id: "receipt",
        chatId: "chat",
        text: "正文",
        parts: ["正文"],
        ids: [],
        state,
        ...(state === "retryable"
          ? { error: { code: "refused", message: "未执行", outcome: "not_executed" } }
          : {}),
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
      await h.outbox().send("chat", "正文", "receipt", "parent-a");
      await assert.rejects(h.outbox().send("chat", "正文", "receipt", "parent-b"), {
        code: "outbox_conflict",
      });
      assert.equal(h.calls[0]?.replyTo, "parent-a");
      assert.equal(h.calls.length, 1);
    } finally {
      h.store.close();
    }
  });
}
