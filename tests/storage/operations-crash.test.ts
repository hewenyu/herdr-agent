import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { type OperationReceipt, Operations } from "../../src/storage/operations.js";
import { Store } from "../../src/storage/store.js";

// A separate process and real SQLite WAL exercise abrupt loss, not a thrown
// exception whose catch/finally could accidentally write a recovery receipt.
const childSource = `
import { appendFileSync } from 'node:fs';
import { Store } from ${JSON.stringify(new URL("../../src/storage/store.ts", import.meta.url).href)};
import { Operations } from ${JSON.stringify(new URL("../../src/storage/operations.ts", import.meta.url).href)};
const [database, effects, boundary] = process.argv.slice(1);
const store = new Store(database);
async function park() {
  setInterval(() => {}, 1000);
  process.send({ boundary });
  await new Promise(() => {});
}
await new Operations(store).run('effect', { target: 'fixture' }, async () => {
  if (boundary === 'before-effect') await park();
  appendFileSync(effects, 'performed\\n');
  if (boundary === 'after-effect') await park();
  return { externalId: 'fixture-result' };
});
await park();
`;

for (const boundary of ["before-effect", "after-effect", "after-receipt"] as const) {
  test(`SIGKILL ${boundary} preserves durable operation authority without replay`, {
    timeout: 30000,
  }, async (t) => {
    const root = await realpath(tmpdir());
    const directory = await mkdtemp(join(root, "myrix-operation-crash-"));
    t.after(async () => {
      // Verify the exact temporary target before recursively removing fixtures.
      const resolved = await realpath(directory);
      assert.equal(dirname(resolved), root);
      assert.ok(basename(resolved).startsWith("myrix-operation-crash-"));
      await rm(resolved, { recursive: true, force: true });
    });
    const database = join(directory, "state.sqlite");
    const effects = join(directory, "external-effects.txt");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        childSource,
        database,
        effects,
        boundary,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, "exit");
    try {
      const ready = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(15000) }).then(([message]) => message),
        exited.then(([code, signal]) => {
          throw new Error(`Child exited before failpoint: ${code}/${signal}: ${stderr}`);
        }),
      ]);
      assert.deepEqual(ready, { boundary });
      assert.equal(child.kill("SIGKILL"), true);
      assert.deepEqual(await exited, [null, "SIGKILL"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    const externalLog = () =>
      existsSync(effects) ? readFile(effects, "utf8") : Promise.resolve("");
    // Independent oracle: the external effect and receipt have different crash
    // boundaries. Never regenerate this expected result from implementation state.
    const expectedEffects = boundary === "before-effect" ? "" : "performed\n";
    assert.equal(await externalLog(), expectedEffects);
    for (let restart = 0; restart < 2; restart++) {
      const reopened = new Store(database);
      try {
        const before = reopened.get<OperationReceipt>("operations", "effect");
        assert.equal(before?.state, boundary === "after-receipt" ? "done" : "pending");
        let replayed = false;
        const replay = new Operations(reopened).run("effect", { target: "fixture" }, async () => {
          replayed = true;
          return { externalId: "unexpected" };
        });
        if (boundary === "after-receipt")
          assert.deepEqual(await replay, { externalId: "fixture-result" });
        else await assert.rejects(replay, { code: "operation_uncertain", outcome: "unknown" });
        assert.equal(replayed, false);
        assert.deepEqual(reopened.get("operations", "effect"), before);
        assert.equal(await externalLog(), expectedEffects);
      } finally {
        reopened.close();
      }
    }
  });
}
