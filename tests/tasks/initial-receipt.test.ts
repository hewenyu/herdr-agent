import assert from "node:assert/strict";
import test from "node:test";
import type { HerdrPort } from "../../src/core/ports.js";
import { verifyReceipt } from "../../src/herdr/echo.js";
import { actor, discussion, setup } from "./helpers.js";

test("a long first relay can be confirmed from its final receipt without full screen echo", async () => {
  const f = setup();
  try {
    const send = f.herdr.send.bind(f.herdr);
    (f.herdr as HerdrPort).send = async (ref, text, options) => {
      const delivered = await send(ref, text);
      const screen = `${options?.receipt}\n────────────────────\n> \n────────────────────`;
      const verified = verifyReceipt("old output", screen, text, options?.receipt, false);
      return { ...delivered, status: verified ? "delivered" : "unconfirmed", verified };
    };
    const task = await f.service.create(actor, discussion);
    await f.service.tick();
    const [first, second] = f.service.get(actor, task.id).participants;
    assert.ok(first?.execution && second?.execution);
    f.herdr.finish(first.execution.paneId, "第一位参与者的长观点。".repeat(300));
    await f.service.tick();
    const current = f.service.get(actor, task.id);
    assert.equal(current.participants[1]?.initialSent, true);
    assert.equal(current.discussion.activeParticipant, second.id);
    assert.equal(f.herdr.sends.length, 2);
    assert.ok(f.herdr.sends[1]?.text.includes("本轮安排："));
    assert.ok(f.herdr.sends[1]?.text.includes(task.requirements));
  } finally {
    f.close();
  }
});
