import assert from "node:assert/strict";
import test from "node:test";
import { displayThenAcknowledge } from "../../src/web/client/delivery.js";

test("reply is rendered before its delivery acknowledgement", async () => {
  const order: string[] = [];
  const result = await displayThenAcknowledge(
    () => {
      order.push("render");
    },
    async () => {
      order.push("ack");
    },
    () => {
      order.push("uncertain");
    },
  );
  assert.equal(result, true);
  assert.deepEqual(order, ["render", "ack"]);
});

test("failed acknowledgement keeps visible reply and does not replay the request", async () => {
  const order: string[] = [];
  const result = await displayThenAcknowledge(
    () => {
      order.push("render");
    },
    async () => {
      order.push("ack");
      throw new Error("network");
    },
    () => {
      order.push("offer_ack_retry");
    },
  );
  assert.equal(result, false);
  assert.deepEqual(order, ["render", "ack", "offer_ack_retry"]);
});

test("failed rendering cannot acknowledge an unseen reply", async () => {
  let acknowledged = false;
  await assert.rejects(
    displayThenAcknowledge(
      () => {
        throw new Error("render failed");
      },
      async () => {
        acknowledged = true;
      },
      () => {},
    ),
    /render failed/,
  );
  assert.equal(acknowledged, false);
});

test("a render that switched to a replacement session cannot acknowledge the hidden old reply", async () => {
  const order: string[] = [];
  const visible = new Set<string>();
  const result = await displayThenAcknowledge(
    () => {
      visible.add("new-session-empty");
      order.push("render replacement");
    },
    async () => {
      order.push("ack old reply");
    },
    () => {
      order.push("offer display and retry");
    },
    () => visible.has("old-session-reply"),
  );
  assert.equal(result, false);
  assert.deepEqual(order, ["render replacement", "offer display and retry"]);
});
