import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { packageName, registry, releaseVersion, targets } from "./config.js";
import { command, offlineEnvironment } from "./io.js";

/** Public registry acceptance: isolated npm install, no publish credentials and no install scripts. */
export async function verifyRegistry(
  tag: string,
  name: string,
  commit: string,
  options: { run?: typeof command; pause?: (milliseconds: number) => Promise<unknown> } = {},
): Promise<void> {
  const { version } = releaseVersion(tag);
  packageName(name);
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.ok(
    targets.some((target) => target.os === process.platform && target.cpu === process.arch),
  );
  const temporary = await mkdtemp(join(tmpdir(), "myrix-npm-download-"));
  const env = { ...offlineEnvironment(temporary), npm_config_offline: "false" };
  const prefix = join(temporary, "prefix");
  const run = options.run ?? command;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        run(
          "npm",
          [
            "install",
            "--global",
            "--prefix",
            prefix,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefer-online",
            "--fetch-retries=1",
            "--fetch-retry-mintimeout=1000",
            "--fetch-retry-maxtimeout=5000",
            "--registry",
            registry,
            `${name}@${version}`,
          ],
          temporary,
          env,
        );
        // npm may exit successfully after skipping an unavailable optional native package.
        // Only working aliases with the exact release stamp make this attempt successful.
        for (const alias of ["myrix", "herdr-agent"]) {
          const executable = join(prefix, "bin", alias);
          const stamp = JSON.parse(run(executable, ["version", "--json"], temporary, env)) as {
            version: string;
            commit: string;
          };
          assert.ok(
            stamp.version === tag || stamp.version === version,
            `${alias} downloaded version mismatch`,
          );
          assert.equal(stamp.commit, commit, `${alias} downloaded commit mismatch`);
          assert.ok(run(executable, ["--version"], temporary, env).includes(stamp.version));
          assert.match(run(executable, ["help"], temporary, env), /serve/);
        }
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await rm(prefix, { recursive: true, force: true });
        await (options.pause ?? delay)(2_000);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
