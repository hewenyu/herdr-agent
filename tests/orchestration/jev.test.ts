import assert from "node:assert/strict";
import test from "node:test";
import { chooseWithJev } from "../../src/orchestration/jev.js";

const candidates = [
  { id: "review", description: "由评审者独立检查实现" },
  { id: "wait", description: "需要用户提供必需信息" },
] as const;
const config = { apiKey: "fixture-key", confidenceThreshold: 0.8 };
function response(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: "jev-1.13.0",
    answers: {
      action: {
        type: "choice",
        choice: "review",
        confidence: 0.9,
        probabilities: { review: 0.95, wait: 0.05 },
        ...overrides,
      },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  });
}

test("Jev uses documented Bearer Choice schema and preserves full provider evidence", async () => {
  const result = await chooseWithJev(
    { ...config, baseUrl: "https://api.typesafe.ai/v1/" },
    { state: { stage: "review" }, candidates },
    async (url, init) => {
      assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fixture-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "jev-1.13.0");
      assert.deepEqual(body.state, { stage: "review" });
      assert.deepEqual(body.questions.action.criteria, {
        review: candidates[0]?.description,
        wait: candidates[1]?.description,
      });
      assert.equal(body.questions.action.type, "choice");
      return response();
    },
  );
  assert.equal(result.status, "success");
  assert.equal(result.candidateId, "review");
  assert.equal(result.model, "jev-1.13.0");
  assert.deepEqual(result.probabilities, { review: 0.95, wait: 0.05 });
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(JSON.stringify(result).includes("fixture-key"), false);
});

test("low confidence retains actual choice and distribution without treating it as accepted", async () => {
  const result = await chooseWithJev(config, { state: "不确定", candidates }, async () =>
    response({ confidence: 0.1, probabilities: { review: 0.55, wait: 0.45 } }),
  );
  assert.equal(result.status, "low-confidence");
  assert.equal(result.threshold, 0.8);
  assert.equal(result.candidateId, "review");
  assert.deepEqual(result.probabilities, { review: 0.55, wait: 0.45 });
});

test("rejects missing, foreign, unnormalised, inconsistent and out-of-range probability data", async () => {
  const invalid = [
    { choice: "dispatch" },
    { type: "noul" },
    { confidence: 1.1 },
    { probabilities: { review: 1 } },
    { probabilities: { review: 0.95, dispatch: 0.05 } },
    { probabilities: { review: 0.4, wait: 0.1 } },
    { probabilities: { review: 0.05, wait: 0.95 } },
    { probabilities: { review: 1.1, wait: -0.1 } },
  ];
  for (const fixture of invalid) {
    const result = await chooseWithJev(config, { state: {}, candidates }, async () =>
      response(fixture),
    );
    assert.equal(result.status, "invalid", JSON.stringify(fixture));
    assert.equal(result.candidateId, undefined);
  }
});

test("HTTP, network and malformed JSON failures never log provider error bodies or credentials", async () => {
  for (const fetchImpl of [
    async () => new Response("fixture-key provider body", { status: 401 }),
    async () => {
      throw new Error("fixture-key connection exception");
    },
    async () => new Response("fixture-key invalid json"),
  ]) {
    const result = await chooseWithJev(config, { state: {}, candidates }, fetchImpl);
    assert.ok(["invalid", "error"].includes(result.status));
    assert.equal(JSON.stringify(result).includes("fixture-key"), false);
  }
});

test("timeout aborts transport and is distinct from user cancellation", async () => {
  const blocked: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const timeout = await chooseWithJev(
    { ...config, timeoutMs: 5 },
    { state: {}, candidates },
    blocked,
  );
  assert.equal(timeout.status, "timeout");
  const cancellation = new AbortController();
  const cancelled = chooseWithJev(
    config,
    { state: {}, candidates, signal: cancellation.signal },
    blocked,
  );
  cancellation.abort();
  assert.equal((await cancelled).status, "cancelled");
});

test("unconfigured keys, invalid candidates and pre-cancelled requests make no network calls", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    return response();
  };
  assert.equal(
    (await chooseWithJev({ apiKey: "" }, { state: {}, candidates }, transport)).status,
    "skipped",
  );
  assert.equal(
    (
      await chooseWithJev(
        config,
        { state: {}, candidates: [candidates[0], candidates[0]] },
        transport,
      )
    ).status,
    "invalid",
  );
  assert.equal(
    (await chooseWithJev(config, { state: {}, candidates, signal: AbortSignal.abort() }, transport))
      .status,
    "cancelled",
  );
  assert.equal(calls, 0);
});
