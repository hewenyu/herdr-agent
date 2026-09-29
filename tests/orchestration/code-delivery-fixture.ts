import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { Task } from "../../src/core/types.js";

const execute = promisify(execFile);
export const branch = "feature/actual-delivery";
export const prUrl = "https://github.com/example/project/pull/42";

/** This test file runs in its own Node test process; gh never reaches a network client. */
export async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "code-delivery-evidence-")));
  const directory = join(root, "repository");
  const bin = join(root, "bin");
  await mkdir(directory);
  await mkdir(bin);
  const previousPath = process.env.PATH;
  const responseFile = join(bin, "response.json");
  await writeFile(responseFile, JSON.stringify({ unavailable: true }));
  const fakeGh = join(bin, "gh");
  await writeFile(
    fakeGh,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const response = JSON.parse(fs.readFileSync(path.join(__dirname, 'response.json'), 'utf8'));
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({args:process.argv.slice(2), cwd:process.cwd()}) + '\\n');
if (response.unavailable) process.exit(1);
if (response.advanceHead) execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'Concurrent change'], {cwd:process.cwd()});
if (response.gitArgs) execFileSync('git', response.gitArgs, {cwd:process.cwd()});
process.stdout.write(response.malformed ? 'invalid-json' : JSON.stringify(response.pr));
`,
  );
  await chmod(fakeGh, 0o700);
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ""}`;
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", directory, ...args])).stdout.trim();
  const initialize = async () => {
    await git("init", "--quiet", "--initial-branch", branch);
    await git("config", "user.name", "Isolated Fixture");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "commit.gpgsign", "false");
    await git("config", "core.hooksPath", bin);
    await writeFile(join(directory, "index.mjs"), "export const answer = 42;\n");
    await git("add", "index.mjs");
    await git("commit", "--quiet", "-m", "Initial fixture");
    return git("rev-parse", "HEAD");
  };
  const task = {
    directories: [directory],
    result: "参与者声称已提交到 https://github.com/example/project/pull/999。",
  } as Task;
  return {
    root,
    directory,
    bin,
    task,
    git,
    initialize,
    respond: (value: unknown) => writeFile(responseFile, JSON.stringify(value)),
    async close() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    },
  };
}
