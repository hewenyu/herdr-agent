import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const runURL = new URL("../../src/cli/run.ts", import.meta.url).href;
const storeURL = new URL("../../src/storage/store.ts", import.meta.url).href;

function child(script: string, nodeArgs: string[] = []) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_NO_WARNINGS;
  return spawnSync(
    process.execPath,
    [...nodeArgs, "--import", "tsx", "--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      env,
      timeout: 15_000,
    },
  );
}

test("help, version and invalid arguments do not load SQLite or configuration", () => {
  for (const args of [
    ["help"],
    ["--help"],
    ["version", "--json"],
    ["--trace-warnings", "version"],
    ["--unknown"],
    ["--trace-warnings=true"],
  ]) {
    const result = child(`
      import { runCLI } from ${JSON.stringify(runURL)};
      const output = [];
      const errors = [];
      const code = await runCLI(${JSON.stringify(args)}, {
        stdout: line => output.push(line), stderr: line => errors.push(line),
        loadConfig: () => { throw new Error("unexpected configuration load"); },
      });
      console.log(JSON.stringify({code, output, errors, modules: process.moduleLoadList}));
    `);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout) as {
      code: number;
      output: string[];
      errors: string[];
      modules: string[];
    };
    assert.equal(
      parsed.code,
      args[0]?.startsWith("--unknown") || args[0]?.includes("=true") ? 2 : 0,
    );
    assert.equal(parsed.modules.includes("NativeModule sqlite"), false);
    assert.ok(!parsed.errors.includes("unexpected configuration load"));
  }
});

test("application trace flag also works when native Node tracing is already enabled", () => {
  const result = child(
    `
    import { runCLI } from ${JSON.stringify(runURL)};
    const code = await runCLI(["--trace-warnings", "version"], {stdout: () => {}});
    process.exitCode = code;
    process.emitWarning("ALREADY_TRACING");
  `,
    ["--trace-warnings"],
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Warning: ALREADY_TRACING/);
  assert.match(result.stderr, /\n\s+at /);
});

test("application trace-warnings enables native stacks and preserves every warning type", () => {
  const result = child(`
    import { runCLI } from ${JSON.stringify(runURL)};
    await runCLI(["--trace-warnings", "version"], {stdout: () => {}});
    function warningProbe() {
      process.emitWarning("TRACE_SENTINEL", {type: "RuntimeProbeWarning", code: "PROBE001"});
      process.emitWarning("EXPERIMENTAL_SENTINEL", "ExperimentalWarning");
    }
    warningProbe();
  `);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /\[PROBE001\] RuntimeProbeWarning: TRACE_SENTINEL/);
  assert.match(result.stderr, /ExperimentalWarning: EXPERIMENTAL_SENTINEL/);
  assert.match(result.stderr, /at warningProbe/);
  assert.doesNotMatch(result.stderr, /Use .*--trace-warnings/);
});

test("importing Store does not load SQLite; opening it still uses the real database", () => {
  const result = child(`
    import { Store } from ${JSON.stringify(storeURL)};
    const before = process.moduleLoadList.includes("NativeModule sqlite");
    const store = new Store(":memory:");
    store.set("probe", "key", {saved: true});
    const after = process.moduleLoadList.includes("NativeModule sqlite");
    const value = store.get("probe", "key");
    store.close();
    console.log(JSON.stringify({before, after, value}));
  `);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), {
    before: false,
    after: true,
    value: { saved: true },
  });
});
