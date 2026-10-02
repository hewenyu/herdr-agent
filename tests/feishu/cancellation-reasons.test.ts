import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformHandlers } from "../../src/core/ports.js";
import { FeishuPlatform } from "../../src/feishu/platform.js";

const handlers: PlatformHandlers = {
  message: async () => {},
  action: async () => {},
  taskChanged: async () => {},
};

for (const reason of [false, 0, "", null, undefined]) {
  const label = reason === "" ? "empty string" : String(reason);
  for (const stage of ["before start", "during handshake"] as const) {
    test(`cancellation ${label} ${stage} cannot leak a reason or resolve startup`, async () => {
      const controller = new AbortController();
      let requests = 0;
      let connections = 0;
      const platform = new FeishuPlatform(
        { appId: "cli_test", appSecret: "test-only-secret" },
        {
          request: async () => {
            requests++;
            return { code: 0, bot: { open_id: "bot" } };
          },
          connection: () => {
            connections++;
            return {
              start: async () => {
                controller.abort(reason);
              },
              close: () => {},
            };
          },
        },
      );
      if (stage === "before start") controller.abort(reason);
      try {
        await assert.rejects(platform.start(handlers, controller.signal), (error: unknown) => {
          assert.ok(error instanceof OperationError);
          assert.equal(error.code, "feishu_aborted");
          assert.equal(error.outcome, "not_executed");
          return true;
        });
        assert.equal(requests, stage === "before start" ? 0 : 1);
        assert.equal(connections, stage === "before start" ? 0 : 1);
      } finally {
        await platform.stop();
      }
    });
  }
}
