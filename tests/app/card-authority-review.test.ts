import assert from "node:assert/strict";
import test from "node:test";
import { type UncertainCard, UncertainCards } from "../../src/app/uncertain-cards.js";
import { uncertainCandidates } from "../../src/app/uncertain-choice.js";
import { OperationError } from "../../src/core/errors.js";
import type { HerdrPort } from "../../src/core/ports.js";
import type { AgentScreen, ExecutionRef } from "../../src/core/types.js";
import { setup } from "./helpers.js";

const ref: ExecutionRef = {
  workspaceId: "workspace",
  paneId: "pane",
  kind: "codex",
  cwd: "/fixture",
  sessionId: "session",
};
const screen: AgentScreen = {
  text: "Confirm?",
  question: "Confirm?",
  options: [{ key: "1", label: "Allow" }],
  agent: {
    ...ref,
    stateSeq: "1",
    status: "blocked",
    interactiveReady: true,
    launchPending: false,
  },
};

for (const kind of ["approval", "uncertain"] as const) {
  for (const [name, defect] of [
    ["null consumption", { consumed: null }],
    ["numeric consumption", { consumed: 0 }],
    ["string consumption", { consumed: "" }],
    ["missing consumption", { consumed: undefined }],
    ["mismatched nonce", { nonce: "another-card" }],
  ] as const) {
    test(`damaged ${kind} card (${name}) cannot consume authority or apply a choice`, async () => {
      const h = setup();
      let effects = 0;
      try {
        let nonce: string;
        let invoke: () => Promise<void>;
        const namespace = kind === "approval" ? "approvals" : "uncertain_cards";
        if (kind === "approval") {
          (h.herdr as HerdrPort).answer = async (_ref, _key, guard) => {
            await guard.beforeWrite?.();
            guard.assertCurrent?.();
            effects++;
          };
          nonce = h.app.approvals.create("owner", "chat", ref, screen).nonce;
          invoke = () => h.app.approvals.answer("owner", "chat", nonce, "1");
        } else {
          const cards = new UncertainCards(
            h.store,
            () => h.platform,
            async () => {
              effects++;
            },
          );
          const card: UncertainCard = {
            nonce: "card",
            taskId: "task",
            operationId: "operation",
            ownerId: "owner",
            chatId: "chat",
            step: "frozen operation",
            evidence: { status: "unknown" },
            candidates: uncertainCandidates,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            consumed: false,
          };
          nonce = card.nonce;
          h.store.set(namespace, nonce, card);
          invoke = () => cards.answer("owner", "chat", nonce, "retry_once");
        }
        const original = h.store.get<Record<string, unknown>>(namespace, nonce);
        assert.ok(original);
        h.store.set(namespace, nonce, { ...original, ...defect });
        const before = h.store.entries(namespace);
        const error: unknown = await invoke().then(
          () => undefined,
          (cause: unknown) => cause,
        );
        assert.equal(effects, 0);
        assert.deepEqual(h.store.entries(namespace), before);
        assert.ok(error instanceof OperationError);
        assert.equal(
          error.code,
          kind === "approval" ? "approval_record_invalid" : "card_record_invalid",
        );
        assert.equal(h.platform.cards.length, 0);
      } finally {
        await h.close();
      }
    });
  }
}

for (const defect of ["missing target", "foreign pane target"] as const) {
  test(`approval identity index with ${defect} cannot create or redirect authority`, async () => {
    const h = setup();
    let effects = 0;
    try {
      h.app.approvals.create("owner", "chat", ref, screen);
      const indexed = h.store.entries<string>("approval_identity")[0];
      assert.ok(indexed);
      const [identity] = indexed;
      const foreign = h.app.approvals.create(
        "owner",
        "chat",
        { ...ref, paneId: "another-pane" },
        { ...screen, agent: { ...screen.agent, paneId: "another-pane" } },
      );
      h.store.set(
        "approval_identity",
        identity,
        defect === "missing target" ? "missing" : foreign.nonce,
      );
      const before = h.store.entries("approvals");
      const indexBefore = h.store.entries("approval_identity");
      (h.herdr as HerdrPort).answer = async (_ref, _key, guard) => {
        await guard.beforeWrite?.();
        guard.assertCurrent?.();
        effects++;
      };
      const error: unknown = await Promise.resolve()
        .then(async () => {
          const selected = h.app.approvals.create("owner", "chat", ref, screen);
          await h.app.approvals.answer("owner", "chat", selected.nonce, "1");
        })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      assert.equal(effects, 0);
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "approval_record_invalid");
      assert.deepEqual(h.store.entries("approvals"), before);
      assert.deepEqual(h.store.entries("approval_identity"), indexBefore);
    } finally {
      await h.close();
    }
  });
}

for (const defect of ["missing target", "foreign operation target"] as const) {
  test(`uncertain identity index with ${defect} cannot create or redirect authority`, async () => {
    const h = setup();
    let effects = 0;
    try {
      const cards = new UncertainCards(
        h.store,
        () => h.platform,
        async () => {
          effects++;
        },
      );
      const request = {
        operationId: "operation",
        taskId: "task",
        ownerId: "owner",
        chatId: "chat",
        step: "frozen operation",
        evidence: { status: "unknown" },
        candidates: uncertainCandidates,
      };
      await cards.publish(request);
      const indexed = h.store.entries<string>("uncertain_card_identity")[0];
      assert.ok(indexed);
      const [identity] = indexed;
      const foreign = await cards.publish({ ...request, operationId: "another-operation" });
      h.store.set(
        "uncertain_card_identity",
        identity,
        defect === "missing target" ? "missing" : foreign.nonce,
      );
      const before = h.store.entries("uncertain_cards");
      const indexBefore = h.store.entries("uncertain_card_identity");
      const publications = h.platform.cards.length;
      const error: unknown = await cards
        .publish(request)
        .then(async (selected) => {
          await cards.answer("owner", "chat", selected.nonce, "treat_as_done");
        })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      assert.equal(effects, 0);
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, "card_record_invalid");
      assert.equal(h.platform.cards.length, publications);
      assert.deepEqual(h.store.entries("uncertain_cards"), before);
      assert.deepEqual(h.store.entries("uncertain_card_identity"), indexBefore);
      assert.throws(
        () => cards.lookup(request),
        (cause: unknown) => cause instanceof OperationError && cause.code === "card_record_invalid",
      );
    } finally {
      await h.close();
    }
  });
}

test("approval removed during native preparation cannot pass the final write guard", async () => {
  const h = setup();
  let effects = 0;
  try {
    const { nonce } = h.app.approvals.create("owner", "chat", ref, screen);
    (h.herdr as HerdrPort).answer = async (_ref, _key, guard) => {
      await guard.beforeWrite?.();
      h.store.delete("approvals", nonce);
      guard.assertCurrent?.();
      effects++;
    };
    const error: unknown = await h.app.approvals.answer("owner", "chat", nonce, "1").then(
      () => undefined,
      (cause: unknown) => cause,
    );
    assert.equal(effects, 0);
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, "approval_record_invalid");
    assert.equal(h.store.get("approvals", nonce), undefined);
  } finally {
    await h.close();
  }
});
