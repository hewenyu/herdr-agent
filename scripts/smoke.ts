import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { smokeModels } from "./smoke-model.js";

function isolatedEnvironment(): NodeJS.ProcessEnv {
  // Explicit --state-dir isolates application data. Do not inherit keys, NODE_OPTIONS or herdr config.
  return { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" };
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.kill("SIGTERM");
  });
}

async function ready(child: ChildProcess): Promise<string> {
  return await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error(`Web startup timed out: ${output}`)), 20_000);
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer);
      child.stdout?.off("data", inspect);
      child.stderr?.off("data", inspect);
      child.off("error", failed);
      child.off("exit", exited);
      if (error) reject(error);
      else resolveReady(url as string);
    };
    const inspect = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-32_768);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) finish(undefined, match[0]);
    };
    const failed = (error: Error) => finish(error);
    const exited = (code: number | null) => finish(new Error(`Web exited ${code}: ${output}`));
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", failed);
    child.once("exit", exited);
  });
}

/** Run the copied executable without a checkout, credentials, herdr or external services. */
export async function smokeBinary(binary: string, expectedVersion?: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "herdr-agent-smoke-"));
  let child: ChildProcess | undefined;
  try {
    const executable = join(directory, "herdr-agent");
    const stateDir = join(directory, "state");
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(
      join(stateDir, "config.toml"),
      `[tasks]\nenabled = true\n[herdr]\nsocket_path = ${JSON.stringify(join(directory, "no-herdr.sock"))}\n`,
      { mode: 0o600 },
    );
    await copyFile(resolve(binary), executable);
    await chmod(executable, 0o755);
    const options = {
      cwd: directory,
      env: isolatedEnvironment(),
      timeout: 10_000,
      encoding: "utf8" as const,
    };
    const help = spawnSync(executable, ["help"], options);
    assert.equal(help.status, 0, help.stderr || help.error?.message);
    assert.match(help.stdout, /serve/);
    assert.match(help.stdout, /configure/);
    const version = spawnSync(executable, ["version", "--json"], options);
    assert.equal(version.status, 0, version.stderr || version.error?.message);
    const stamp = JSON.parse(version.stdout) as {
      version: string;
      commit: string;
      date?: string;
      buildDate?: string;
    };
    assert.equal(typeof stamp.version, "string");
    if (expectedVersion) assert.equal(stamp.version, expectedVersion);
    if (process.env.COMMIT) assert.equal(stamp.commit, process.env.COMMIT);
    if (process.env.BUILD_DATE) assert.equal(stamp.date, process.env.BUILD_DATE);
    child = spawn(
      executable,
      ["configure", "--listen", "127.0.0.1:0", "--state-dir", join(directory, "state")],
      {
        cwd: directory,
        env: isolatedEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const origin = await ready(child);
    const duplicate = spawnSync(
      executable,
      ["configure", "--listen", "127.0.0.1:0", "--state-dir", stateDir],
      options,
    );
    assert.equal(duplicate.status, 1, duplicate.stderr || duplicate.error?.message);
    assert.match(duplicate.stderr, /状态锁/, "Native lock must reject a duplicate instance");
    for (const [path, type] of [
      ["/", "text/html"],
      ["/styles.css", "text/css"],
      ["/app.js", "javascript"],
    ]) {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get("content-type")?.includes(type as string));
      assert.ok((await response.text()).length > 100, `Empty embedded resource ${path}`);
    }
    const page = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
    const html = await page.text();
    assert.ok(!html.includes("csrf-token"), "Read-only history must not expose action tokens");
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const state = await fetch(`${origin}/api/state`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(state.status, 200);
    const before = (await state.json()) as { sessions?: unknown[]; messages?: unknown[] };
    assert.equal(typeof before, "object");
    const forbidden = await fetch(`${origin}/api/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ action: "session.create", input: { name: "must not execute" } }),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(forbidden.status, 405);
    const after = (await (
      await fetch(`${origin}/api/state`, {
        signal: AbortSignal.timeout(5_000),
      })
    ).json()) as typeof before;
    assert.deepEqual(after.sessions, before.sessions);
    assert.deepEqual(after.messages, before.messages);
    await stop(child);
    child = undefined;
    await smokeModels(directory, async (modelState, inspect) => {
      child = spawn(
        executable,
        ["configure", "--listen", "127.0.0.1:0", "--state-dir", modelState],
        {
          cwd: directory,
          env: isolatedEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      await inspect(await ready(child));
      await stop(child);
      child = undefined;
    });
    process.stdout.write(
      `SEA smoke passed: ${stamp.version}; help, version, native lock, read-only Web, rejected actions, offline inbox, pi/OpenAI/Anthropic, no browser ACK\n`,
    );
  } finally {
    if (child) await stop(child);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await smokeBinary(process.argv[2] ?? "dist/herdr-agent", process.env.VERSION);
}
