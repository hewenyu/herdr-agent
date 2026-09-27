import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext, IncomingMessage } from "../../src/core/types.js";
import {
  assertIngressProject,
  ingressRouteFor,
  resolveIngressRoute,
} from "../../src/orchestration/ingress.js";
import { setup } from "../tasks/helpers.js";

function message(messageId: string, text: string): IncomingMessage {
  return {
    source: "feishu",
    eventId: `event-${messageId}`,
    messageId,
    ownerId: "owner",
    chatId: "entry",
    chatType: "private",
    text,
    mentionedBot: false,
  };
}

function fixture(h: ReturnType<typeof setup>) {
  assert.ok(h.config.jev);
  h.config.jev.apiKey = "fixture-key";
  h.config.jev.ingressEnabled = true;
  h.config.ai.enabled = true;
  const actor: ActorContext = {
    ownerId: "owner",
    chatId: "entry",
    sessionId: "entry-session",
    messageId: "m1",
    source: "feishu",
    chatType: "private",
  };
  return {
    config: h.config,
    store: h.store,
    catalog: h.catalog.snapshot(),
    actor,
    message: message("m1", "请在 project 中新增按钮，禁止部署"),
  };
}
function transport(intent = "discussion", project = "known"): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const ids = Object.keys(body.questions.action.criteria);
    const choice = ids.includes("other")
      ? intent
      : project === "unknown"
        ? "unknown"
        : ids.find((id) => id !== "unknown");
    return Response.json({
      model: "jev-1.13.0",
      answers: {
        action: {
          type: "choice",
          choice,
          confidence: 1,
          probabilities: Object.fromEntries(ids.map((id) => [id, Number(id === choice)])),
        },
      },
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  };
}

test("frozen route survives replay without reclassifying and includes default discussion participants", async () => {
  const h = setup();
  try {
    const input = fixture(h);
    const route = await resolveIngressRoute({ ...input, fetch: transport() });
    assert.equal(route?.route, "create");
    assert.deepEqual(route?.parameters?.participants, [{ kind: "codex" }, { kind: "claude" }]);
    const replay = await resolveIngressRoute({
      ...input,
      fetch: async () => {
        throw new Error("must not reclassify");
      },
    });
    assert.deepEqual(replay, route);
    assert.equal(JSON.stringify(route).includes("fixture-key"), false);
    assert.equal(JSON.stringify(route).includes(h.directory), false);
    assert.ok(route);
    assert.ok(route.parameters);
    assert.ok(replay?.parameters);
    const project = input.catalog.projects[0];
    assert.ok(project);
    assertIngressProject(route, input.catalog);
    assert.throws(
      () =>
        assertIngressProject(route, {
          ...input.catalog,
          projects: [{ ...project, directories: ["/changed"] }],
        }),
      { code: "ingress_project_changed" },
    );
    const first = await h.service.create(input.actor, route.parameters);
    const second = await h.service.create(input.actor, replay.parameters);
    assert.equal(first.id, second.id);
    assert.equal(h.store.list("tasks").length, 1);
  } finally {
    await h.close();
  }
});

test("unknown project and provider error remain stable pi routes without creating tasks", async () => {
  const h = setup();
  try {
    const input = fixture(h);
    const unknown = await resolveIngressRoute({
      ...input,
      fetch: transport("development", "unknown"),
    });
    assert.equal(unknown?.route, "pi");
    assert.equal(unknown?.parameters, undefined);
    const different = {
      ...input,
      actor: { ...input.actor, messageId: "m2" },
      message: message("m2", "新增按钮"),
    };
    const error = await resolveIngressRoute({
      ...different,
      fetch: async () => new Response("provider failure", { status: 503 }),
    });
    assert.equal(error?.route, "pi");
    assert.equal(error?.intent?.status, "error");
    assert.equal(h.store.list("tasks").length, 0);
  } finally {
    await h.close();
  }
});

test("changed text under one message identity and cancellation never proceed to task parameters", async () => {
  const h = setup();
  try {
    const input = fixture(h);
    await resolveIngressRoute({ ...input, fetch: transport() });
    await assert.rejects(
      resolveIngressRoute({
        ...input,
        message: { ...input.message, text: "different" },
        fetch: transport(),
      }),
      { code: "duplicate_identity" },
    );
    const cancelled = {
      ...input,
      actor: { ...input.actor, messageId: "cancel" },
      message: message("cancel", "新增按钮"),
      signal: AbortSignal.abort(),
    };
    await assert.rejects(resolveIngressRoute(cancelled), { code: "cancelled" });
    assert.equal(ingressRouteFor(h.store, cancelled.actor), undefined);
  } finally {
    await h.close();
  }
});
