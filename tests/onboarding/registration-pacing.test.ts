import assert from "node:assert/strict";
import test from "node:test";
import { registerApp } from "../../src/onboarding/registration.js";

const begin = {
  device_code: "test-only-device-code",
  verification_uri_complete: "https://open.feishu.cn/app/registration?code=test-only",
  expires_in: 600,
  interval: 120,
};
const response = (body: unknown) => new Response(JSON.stringify(body));

// Slow-down status exposes the chosen interval without waiting minutes or changing clocks.
test("registration respects a server interval longer than one minute when slowing down", async () => {
  const controller = new AbortController();
  let interval: number | undefined;
  let calls = 0;
  await assert.rejects(
    registerApp({
      signal: controller.signal,
      onURL: () => {},
      onStatus: (status) => {
        if (status.status !== "slow_down") return;
        interval = status.interval;
        controller.abort();
      },
      fetch: async () => response(++calls === 1 ? begin : { error: "slow_down" }),
    }),
    { code: "authorization_aborted" },
  );
  assert.equal(interval, 125);
  assert.equal(calls, 2);
});

test("slow_down near the native timer limit cannot overflow its next delay", async () => {
  const maxTimerMs = 2_147_483_647;
  const controller = new AbortController();
  let interval: number | undefined;
  let calls = 0;
  await assert.rejects(
    registerApp({
      signal: controller.signal,
      onURL: () => {},
      onStatus: (status) => {
        if (status.status !== "slow_down") return;
        interval = status.interval;
        controller.abort();
      },
      fetch: async () =>
        response(
          ++calls === 1
            ? { ...begin, interval: (maxTimerMs - 1_000) / 1_000 }
            : { error: "slow_down" },
        ),
    }),
    { code: "authorization_aborted" },
  );
  assert.equal(interval, maxTimerMs / 1_000);
  assert.equal(calls, 2);
});

test("fractional local registration budgets use a valid timer delay", async () => {
  let calls = 0;
  const result = await registerApp({
    timeoutMs: 1_000.5,
    onURL: () => {},
    fetch: async () =>
      response(
        ++calls === 1 ? begin : { client_id: "cli_test", client_secret: "test-only-secret" },
      ),
  });
  assert.equal(result.appId, "cli_test");
  assert.equal(calls, 2);
});
