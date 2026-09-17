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
