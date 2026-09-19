import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArguments } from "../../src/cli/args.js";
import type { Dependencies, ServiceApplication } from "../../src/cli/dependencies.js";
import { runCLI } from "../../src/cli/run.js";
import { selectCredentials } from "../../src/cli/setup.js";
import { loadConfig } from "../../src/config/load.js";
import { OperationError } from "../../src/core/errors.js";
import type { PlatformPort } from "../../src/core/ports.js";
import { saveCredentials } from "../../src/onboarding/credentials.js";
import { Store } from "../../src/storage/store.js";
import { FakeHerdr, FakePlatform } from "../tasks/helpers.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-cli-"));
  const config = loadConfig({ stateDir: dir, env: {}, cwd: dir });
  const control = new AbortController();
  const events: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const platform = new FakePlatform();
  platform.start = async () => {
    events.push("connect");
    queueMicrotask(() => control.abort());
  };
  platform.stop = async () => {
    events.push("disconnect");
  };
  const app: ServiceApplication = {
    authorization: { status: "checking", message: "" },
    runtime: { status: "starting", message: "" },
    attachPlatform() {
      events.push("attach");
    },
    handlers: () => ({
      message: async () => {},
      action: async () => {},
      taskChanged: async () => {},
    }),
    history: () => ({}),
    subscribe: () => () => {},
    changed() {
      if (app.authorization.status === "setup_required") queueMicrotask(() => control.abort());
    },
    tick: async () => {
      events.push("tick");
    },
    shutdown: async () => {
      events.push("shutdown");
    },
  };
  const deps: Partial<Dependencies> = {
    signal: control.signal,
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    loadConfig: () => config,
    acquireLock: () => {
      events.push("lock");
      return {
        path: "test",
        release: () => {
          events.push("unlock");
        },
      };
    },
    openStore: () => {
      events.push("store");
      const store = new Store(":memory:");
      const close = store.close.bind(store);
      store.close = () => {
        events.push("close-store");
        close();
      };
      return store;
    },
    migrate: async () => {
      events.push("migrate");
      return {
        version: 1,
        state: "empty",
        fingerprint: "",
        files: [],
        counts: {},
        warnings: [],
        rollback: [],
      };
    },
    createHerdr: () => new FakeHerdr(),
    createPlatform: () => platform,
    createApp: () => {
      events.push("app");
      return app;
    },
    startWeb: async () => {
      events.push("web");
      return {
        url: "http://127.0.0.1:12345",
        close: async () => {
          events.push("close-web");
        },
      };
    },
    checkAuthorization: async () => {
      events.push("check-auth");
      return { state: "ready", missingScopes: [] };
    },
    registerApp: async () => {
      throw new Error("Unexpected real registration");
    },
    verifyPlatform: async () => ({
      inboundOK: true,
      cardOK: true,
      ownerId: "owner",
      chatId: "chat",
    }),
    saveCredentials,
    inspectHost: async () => [],
    executable: async () => true,
    openURL: async () => {
      events.push("browser");
    },
    sleep: async () => {
      control.abort();
    },
  };
  return {
    dir,
    config,
    control,
    events,
    output,
    errors,
    platform,
    app,
    deps,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("help/version/invalid flags do not initialize state or network", async () => {
  const h = harness();
  try {
    assert.equal(await runCLI(["--help"], h.deps), 0);
    assert.equal(await runCLI(["version", "--json"], h.deps), 0);
    assert.equal(await runCLI(["serve", "--reregister"], h.deps), 2);
    assert.deepEqual(h.events, []);
    assert.throws(() => parseArguments(["setup", "--reregister"]));
    assert.equal(
      parseArguments(["--state-dir", h.dir, "configure", "--listen=127.0.0.1:0"]).listen,
      "127.0.0.1:0",
    );
  } finally {
    h.cleanup();
  }
});
test("serve starts Web before authorization and missing app never connects or runs tasks", async () => {
  const h = harness();
  try {
    assert.equal(await runCLI(["serve"], h.deps), 0);
    assert.deepEqual(h.events, [
      "lock",
      "store",
      "migrate",
      "app",
      "web",
      "shutdown",
      "close-web",
      "close-store",
      "unlock",
    ]);
    assert.equal(h.output[0], "http://127.0.0.1:12345");
  } finally {
    h.cleanup();
  }
});
test("authorized serve connects once and closes resources before releasing lock", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["owner"],
      notifyChatId: "",
    };
    assert.equal(await runCLI(["serve"], h.deps), 0);
    assert.ok(h.events.indexOf("web") < h.events.indexOf("check-auth"));
    assert.equal(h.events.filter((event) => event === "connect").length, 1);
    assert.ok(h.events.indexOf("disconnect") < h.events.indexOf("close-store"));
    assert.equal(h.events.at(-1), "unlock");
  } finally {
    h.cleanup();
  }
});

for (const tasksEnabled of [true, false]) {
  test(`serve subscribes only after connection and before ready/ticks when tasks=${tasksEnabled}`, async () => {
    const h = harness();
    try {
      h.config.feishu = {
        appId: "cli_test",
        appSecret: "secret",
        allowedOpenIds: ["owner"],
        notifyChatId: "",
      };
      h.config.tasks.enabled = tasksEnabled;
      h.platform.start = async () => {
        h.events.push("connect");
      };
      h.platform.subscribeTasks = async () => {
        assert.notEqual(h.app.runtime.status, "ready");
        assert.ok(!h.events.includes("tick"));
        h.events.push("subscribe-tasks");
      };
      h.app.changed = () => {
        if (h.app.runtime.status === "ready") h.events.push("ready");
      };
      h.app.tick = async () => {
        h.events.push("tick");
        h.control.abort();
      };
      assert.equal(await runCLI(["serve"], h.deps), 0);
      assert.deepEqual(
        h.events.filter((event) => ["connect", "subscribe-tasks", "ready", "tick"].includes(event)),
        tasksEnabled
          ? ["connect", "subscribe-tasks", "ready", "tick"]
          : ["connect", "ready", "tick"],
      );
    } finally {
      h.cleanup();
    }
  });
}

test("failed task subscription stops that connection and retries the same app before starting work", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["owner"],
      notifyChatId: "",
    };
    h.config.tasks.enabled = true;
    let attempts = 0;
    h.platform.start = async () => {
      h.events.push("connect");
    };
    h.platform.subscribeTasks = async () => {
      h.events.push("subscribe-tasks");
      if (++attempts === 1) throw new OperationError("feishu_subscription", "订阅未成功。");
    };
    h.deps.sleep = async () => {
      assert.equal(h.app.runtime.status, "waiting");
      assert.ok(!h.events.includes("tick"));
      assert.equal(h.events.at(-1), "disconnect");
      h.events.push("retry");
    };
    h.app.tick = async () => {
      h.events.push("tick");
      h.control.abort();
    };
    assert.equal(await runCLI(["serve"], h.deps), 0);
    assert.equal(attempts, 2);
    assert.equal(h.config.feishu.appId, "cli_test");
    assert.deepEqual(
      h.events.filter((event) =>
        ["connect", "subscribe-tasks", "disconnect", "retry", "tick"].includes(event),
      ),
      [
        "connect",
        "subscribe-tasks",
        "disconnect",
        "retry",
        "connect",
        "subscribe-tasks",
        "tick",
        "disconnect",
      ],
    );
    assert.deepEqual(h.errors, ["订阅未成功。"]);
  } finally {
    h.cleanup();
  }
});

test("runtime connection failure stops the old platform and retries before work continues", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["owner"],
      notifyChatId: "",
    };
    let starts = 0;
    const runtimePlatform = h.platform as PlatformPort;
    runtimePlatform.start = async (_handlers, _signal, onFailure) => {
      starts++;
      h.events.push(`connect-${starts}`);
      if (starts === 1) queueMicrotask(() => onFailure?.(new Error("socket closed")));
    };
    h.deps.sleep = async () => {
      h.events.push("retry");
    };
    h.app.tick = async () => {
      h.events.push("tick");
      if (starts === 2) h.control.abort();
    };
    assert.equal(await runCLI(["serve"], h.deps), 0);
    assert.equal(starts, 2);
    assert.deepEqual(
      h.events.filter((event) => /^(connect|disconnect|retry|tick)/.test(event)),
      ["connect-1", "disconnect", "retry", "connect-2", "tick", "disconnect"],
    );
    assert.deepEqual(h.errors, ["操作未完成，请查看本机诊断状态。"]);
  } finally {
    h.cleanup();
  }
});

for (const abortedAt of ["connect", "subscribe"] as const) {
  test(`abort during ${abortedAt} does not mark service ready or start tasks`, async () => {
    const h = harness();
    try {
      h.config.feishu = {
        appId: "cli_test",
        appSecret: "secret",
        allowedOpenIds: ["owner"],
        notifyChatId: "",
      };
      h.config.tasks.enabled = true;
      h.platform.start = async () => {
        h.events.push("connect");
        if (abortedAt === "connect") h.control.abort();
      };
      h.platform.subscribeTasks = async () => {
        h.events.push("subscribe-tasks");
        h.control.abort();
      };
      assert.equal(await runCLI(["serve"], h.deps), 0);
      assert.equal(h.events.includes("subscribe-tasks"), abortedAt === "subscribe");
      assert.notEqual(h.app.runtime.status, "ready");
      assert.ok(!h.events.includes("tick"));
      assert.ok(h.events.includes("disconnect"));
    } finally {
      h.cleanup();
    }
  });
}
test("authorization transport errors never create a new application", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["owner"],
      notifyChatId: "",
    };
    h.deps.checkAuthorization = async () => {
      throw new OperationError("network", "暂时无法连接。");
    };
    assert.equal(await runCLI(["serve"], h.deps), 0);
    assert.equal(h.app.authorization.status, "unknown");
    assert.ok(!h.events.includes("connect"));
  } finally {
    h.cleanup();
  }
});
test("serve repairs only the same application and rechecks grants before connection", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "old",
      allowedOpenIds: ["owner"],
      notifyChatId: "chat",
    };
    let checks = 0;
    h.deps.checkAuthorization = async () => ({
      state: ++checks === 1 ? "required" : "ready",
      missingScopes: ["scope"],
    });
    h.deps.registerApp = async (options) => {
      assert.equal(options.appId, "cli_test");
      assert.equal(options.createOnly, undefined);
      options.onURL({ url: "https://open.feishu.cn/authorize", expiresAt: "later" });
      return { appId: "cli_test", appSecret: "new", brand: "feishu" };
    };
    assert.equal(await runCLI(["serve"], h.deps), 0);
    assert.equal(checks, 2);
    assert.equal(h.config.feishu.appSecret, "new");
    assert.match(readFileSync(join(h.dir, ".env"), "utf8"), /FEISHU_APP_ID=cli_test/);
    assert.deepEqual(h.config.feishu.allowedOpenIds, ["owner"]);
  } finally {
    h.cleanup();
  }
});
test("configure runs local tasks without authorization or Feishu connection", async () => {
  const h = harness();
  try {
    h.app.tick = async () => {
      h.events.push("tick");
      h.control.abort();
    };
    assert.equal(await runCLI(["configure", "--open"], h.deps), 0);
    assert.ok(h.events.includes("tick"));
    assert.ok(h.events.includes("browser"));
    assert.ok(!h.events.includes("check-auth"));
    assert.ok(!h.events.includes("connect"));
  } finally {
    h.cleanup();
  }
});
test("startup failure releases state and lock without connecting", async () => {
  const h = harness();
  try {
    h.deps.startWeb = async () => {
      throw new OperationError("bind", "端口被占用。");
    };
    assert.equal(await runCLI(["serve"], h.deps), 1);
    assert.deepEqual(h.events.slice(-3), ["shutdown", "close-store", "unlock"]);
  } finally {
    h.cleanup();
  }
});
test("setup reuses valid app, verifies and preserves unrelated configuration", async () => {
  const h = harness();
  try {
    writeFileSync(
      join(h.dir, "config.toml"),
      '[tasks]\nenabled = true\n[feishu]\nallowed_open_ids = ["existing"]\n',
    );
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["existing"],
      notifyChatId: "",
    };
    assert.equal(
      await runCLI(["setup", "--app", "cli_test", "--no-open"], {
        ...h.deps,
        registerApp: async () => ({ appId: "cli_test", appSecret: "secret", brand: "feishu" }),
      }),
      0,
    );
    const next = readFileSync(join(h.dir, "config.toml"), "utf8");
    assert.match(next, /enabled = true/);
    assert.match(next, /existing/);
    assert.match(next, /owner/);
    assert.ok(!h.output.join("").includes("secret"));
  } finally {
    h.cleanup();
  }
});
test("setup keeps saved credentials and exits 3 when callback verification is incomplete", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["owner"],
      notifyChatId: "",
    };
    h.deps.verifyPlatform = async () => ({ inboundOK: true, cardOK: false, ownerId: "owner" });
    assert.equal(await runCLI(["setup", "--no-open"], h.deps), 3);
    assert.match(readFileSync(join(h.dir, ".env"), "utf8"), /FEISHU_APP_ID/);
  } finally {
    h.cleanup();
  }
});
test("ambiguous credential sources require explicit app selection", () => {
  const candidates = [
    { source: "state", appId: "cli_one", appSecret: "one" },
    { source: "repository", appId: "cli_two", appSecret: "two" },
  ];
  assert.throws(() => selectCredentials(candidates, parseArguments(["setup"])), /多个应用/);
  assert.deepEqual(selectCredentials(candidates, parseArguments(["setup", "--app", "cli_two"])), {
    appId: "cli_two",
    appSecret: "two",
  });
});
test("doctor is read-only and never opens a platform connection", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["owner"],
      notifyChatId: "",
    };
    assert.equal(await runCLI(["doctor", "--json"], h.deps), 0);
    assert.deepEqual(h.events, ["check-auth"]);
    assert.ok(!h.output.join("").includes("secret"));
  } finally {
    h.cleanup();
  }
});

test("configure exposes repair UI for invalid enabled AI without starting tasks", async () => {
  const h = harness();
  try {
    h.config.ai.enabled = true;
    h.config.ai.baseUrl = "invalid";
    h.config.tasks.enabled = true;
    let reason: string | undefined;
    h.deps.createApp = (_config, _store, _herdr, recoveryError) => {
      reason = recoveryError;
      return h.app;
    };
    h.app.changed = () => {
      if (h.app.runtime.status === "configuration_required") h.control.abort();
    };
    assert.equal(await runCLI(["configure"], h.deps), 0);
    assert.ok(reason);
    assert.ok(h.events.includes("web"));
    assert.ok(!h.events.includes("tick"));
    assert.equal(h.config.ai.enabled, true);
    assert.equal(h.config.ai.baseUrl, "invalid");
  } finally {
    h.cleanup();
  }
});
test("serve cannot connect Feishu or start work when herdr protocol probe fails", async () => {
  const h = harness();
  try {
    h.config.feishu = {
      appId: "cli_test",
      appSecret: "secret",
      allowedOpenIds: ["owner"],
      notifyChatId: "",
    };
    const herdr = new FakeHerdr();
    herdr.ping = async () => {
      throw new OperationError("protocol_too_old", "需要 protocol 19。");
    };
    h.deps.createHerdr = () => herdr;
    assert.equal(await runCLI(["serve"], h.deps), 0);
    assert.ok(h.events.includes("web"));
    assert.ok(!h.events.includes("connect"));
    assert.ok(!h.events.includes("tick"));
  } finally {
    h.cleanup();
  }
});
