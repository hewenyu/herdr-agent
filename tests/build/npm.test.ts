import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import {
  defaultPackageName,
  launcher,
  packageName,
  platformPackage,
  releaseVersion,
  type Target,
  targets,
} from "../../scripts/npm/config.js";
import { command, extract, offlineEnvironment } from "../../scripts/npm/io.js";
import {
  type Distribution,
  prepareDistribution,
  verifyArchitecture,
} from "../../scripts/npm/prepare.js";
import { publishVerified, type RegistryPort } from "../../scripts/npm/publish.js";
import {
  loadDistribution,
  requireVerification,
  verifyDistribution,
} from "../../scripts/npm/verify.js";

function executable(target: Target) {
  const data = Buffer.alloc(32);
  if (target.os === "darwin") {
    data.writeUInt32LE(0xfeedfacf, 0);
    data.writeUInt32LE(0x0100000c, 4);
  } else {
    data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    data.writeUInt16LE(target.cpu === "x64" ? 62 : 183, 18);
  }
  return data;
}

test("npm release names and strict tags are explicit and cannot escape paths or shell arguments", () => {
  assert.equal(packageName(), "@yuebanlaosiji/myrix");
  assert.equal(packageName("@team/myrix"), "@team/myrix");
  assert.equal(platformPackage("@team/myrix", targets[0]), "@team/myrix-darwin-arm64");
  for (const name of [
    "",
    "rix",
    "herdr-agent",
    "../myrix",
    "@team/../bad",
    "Myrix",
    "myrix;echo bad",
    "-flag",
    "@team/myrix/extra",
  ])
    assert.throws(() => packageName(name));
  assert.deepEqual(releaseVersion("v0.3.0"), { version: "0.3.0", distTag: "latest" });
  assert.deepEqual(releaseVersion("v0.3.0-rc.1"), { version: "0.3.0-rc.1", distTag: "next" });
  for (const tag of [
    "0.3.0",
    "v01.3.0",
    "v0.3",
    "v0.3.0-01",
    "v0.3.0-",
    "v0.3.0-rc..1",
    "v0.3.0+build",
    "v0.3.0\n",
    "v0.3.0;echo bad",
    "v9007199254740992.0.0",
  ])
    assert.throws(() => releaseVersion(tag), tag);
});

test("native package verification rejects wrong architectures and non-native content", () => {
  for (const target of targets) verifyArchitecture(executable(target), target);
  assert.throws(() => verifyArchitecture(executable(targets[1]), targets[2]));
  assert.throws(() => verifyArchitecture(executable(targets[0]), targets[1]));
  assert.throws(() => verifyArchitecture(Buffer.from("#!/bin/sh"), targets[0]));
});

test("launcher forwards arguments, exit status and termination to only the installed native package", () => {
  const child = new EventEmitter() as EventEmitter & { kill(signal: string): void };
  const killed: string[] = [];
  child.kill = (signal) => {
    killed.push(signal);
  };
  const processStub = Object.assign(new EventEmitter(), {
    platform: "linux",
    arch: "arm64",
    argv: ["node", "myrix", "serve", "--state-dir", "/tmp/a b"],
    exitCode: 0,
    stderr: {
      write() {
        throw new Error("Unexpected launcher error");
      },
    },
    kill(_pid: number, signal: string) {
      killed.push(`self:${signal}`);
    },
    pid: 123,
  });
  const required: string[] = [];
  const requireStub = Object.assign(
    (name: string) => {
      if (name === "node:child_process")
        return {
          spawn(path: string, args: string[], options: unknown) {
            assert.equal(path, `/packages/${defaultPackageName}-linux-arm64/bin/herdr-agent`);
            assert.deepEqual(Array.from(args), ["serve", "--state-dir", "/tmp/a b"]);
            assert.equal(JSON.stringify(options), '{"stdio":"inherit"}');
            return child;
          },
        };
      if (name === "node:path")
        return { dirname: (path: string) => path.slice(0, path.lastIndexOf("/")), join };
      throw new Error(`Unexpected require: ${name}`);
    },
    {
      resolve(name: string) {
        required.push(name);
        return `/packages/${name}`;
      },
    },
  );
  new Script(launcher(defaultPackageName)).runInNewContext({
    require: requireStub,
    process: processStub,
  });
  assert.deepEqual(required, [`${defaultPackageName}-linux-arm64/package.json`]);
  processStub.emit("SIGTERM");
  assert.deepEqual(killed, ["SIGTERM"]);
  child.emit("exit", 7, null);
  assert.equal(processStub.exitCode, 7);
  assert.equal(processStub.listenerCount("SIGTERM"), 0);
  child.emit("exit", null, "SIGINT");
  assert.deepEqual(killed, ["SIGTERM", "self:SIGINT"]);
});

test("unsupported or missing native packages fail explicitly without downloading anything", () => {
  for (const platform of ["win32", "linux"]) {
    let error = "";
    const processStub = {
      platform,
      arch: "x64",
      stderr: {
        write(text: string) {
          error += text;
        },
      },
      exitCode: 0,
    };
    const requireStub = Object.assign((name: string) => (name === "node:path" ? {} : {}), {
      resolve() {
        throw new Error("missing");
      },
    });
    new Script(launcher(defaultPackageName)).runInNewContext({
      require: requireStub,
      process: processStub,
    });
    assert.equal(processStub.exitCode, 1);
    assert.match(
      error,
      platform === "win32"
        ? /unsupported platform win32-x64/
        : new RegExp(`missing native package ${defaultPackageName}-linux-x64`),
    );
  }
});

test("npm pack retains every platform license and executable mode, produces reproducible tarballs, and rejects tampering", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "myrix-npm-test-"));
  const tag = "v0.3.0-rc.1";
  try {
    const archives = join(temporary, "archives");
    await mkdir(archives);
    for (const target of targets) {
      const source = join(temporary, target.suffix);
      await mkdir(join(source, "LICENSES", "fixture@1.0.0"), { recursive: true });
      await writeFile(join(source, "herdr-agent"), executable(target), { mode: 0o755 });
      await writeFile(join(source, "LICENSE"), "Project license fixture\n");
      for (const file of [
        "manifest.json",
        "NODE-LICENSE.txt",
        "README.md",
        "fixture@1.0.0/LICENSE",
      ])
        await writeFile(
          join(source, "LICENSES", file),
          file === "manifest.json" ? "{}\n" : "Complete test fixture notice\n",
        );
      command("tar", [
        "-czf",
        join(archives, `herdr-agent_${tag}_${target.archive}.tar.gz`),
        "-C",
        source,
        "herdr-agent",
        "LICENSE",
        "LICENSES",
      ]);
    }
    const first = await prepareDistribution(tag, "@team/myrix", archives, join(temporary, "one"));
    const second = await prepareDistribution(tag, "@team/myrix", archives, join(temporary, "two"));
    assert.deepEqual(first, second);
    assert.equal(first.packages.length, 4);
    assert.equal(first.packages.at(-1)?.target, "launcher");
    assert.deepEqual(await loadDistribution(join(temporary, "one"), tag, "@team/myrix"), first);
    await assert.rejects(requireVerification(join(temporary, "one"), first));
    // This shell fixture tests offline npm dependency/bin wiring, not SEA execution.
    const current = first.packages.find(
      (item) => item.target === `${process.platform}-${process.arch}`,
    );
    assert.ok(current);
    const installedFixture = join(temporary, "installed-fixture");
    await extract(join(temporary, "one", current.tarball), installedFixture);
    await writeFile(
      join(installedFixture, "package", "bin/herdr-agent"),
      `#!/bin/sh\nif [ "$1" = "version" ]; then\n  printf '%s\\n' '{"version":"${tag}"}'\nelif [ "$1" = "help" ]; then\n  printf '%s\\n' 'serve'\nelse\n  printf '%s\\n' '${tag}'\nfi\n`,
      { mode: 0o755 },
    );
    const packed = JSON.parse(
      command(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", join(temporary, "one")],
        join(installedFixture, "package"),
        offlineEnvironment(temporary),
      ),
    ) as Array<{ integrity: string }>;
    assert.ok(packed[0]);
    current.integrity = packed[0].integrity;
    await writeFile(join(temporary, "one", "distribution.json"), JSON.stringify(first));
    await verifyDistribution(join(temporary, "one"), tag, "@team/myrix");
    await requireVerification(join(temporary, "one"), first);
    const native = first.packages[0];
    assert.ok(native);
    await writeFile(join(temporary, "one", native.tarball), "corrupted");
    await assert.rejects(
      loadDistribution(join(temporary, "one"), tag, "@team/myrix"),
      /integrity changed/,
    );
    await chmod(join(temporary, targets[0].suffix, "herdr-agent"), 0o644);
    command("tar", [
      "-czf",
      join(archives, `herdr-agent_${tag}_${targets[0].archive}.tar.gz`),
      "-C",
      join(temporary, targets[0].suffix),
      "herdr-agent",
      "LICENSE",
      "LICENSES",
    ]);
    await assert.rejects(
      prepareDistribution(tag, "myrix", archives, join(temporary, "bad-mode")),
      /not executable/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("release archive links are rejected before extraction", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "myrix-npm-link-"));
  try {
    await symlink("/tmp", join(temporary, "outside"));
    const archive = join(temporary, "input.tar.gz");
    command("tar", ["-czf", archive, "-C", temporary, "outside"]);
    await assert.rejects(extract(archive, join(temporary, "output")), /links or special files/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function distribution(tag = "v0.3.0"): Distribution {
  const release = releaseVersion(tag);
  return {
    schema: 1,
    tag,
    name: defaultPackageName,
    ...release,
    packages: [
      ...targets.map((target) => ({
        name: platformPackage(defaultPackageName, target),
        target: target.suffix,
      })),
      { name: defaultPackageName, target: "launcher" },
    ].map((item, i) => ({
      ...item,
      version: release.version,
      tarball: `${item.name}.tgz`,
      integrity: `sha512-test${i}`,
    })),
  };
}

test("publication preflights all versions, publishes platforms before launcher, and skips an identical rerun", async () => {
  for (const tag of ["v0.3.0", "v0.3.1-rc.1"]) {
    const input = distribution(tag);
    const existing = new Map<string, string>();
    const published: string[] = [];
    const port: RegistryPort = {
      async integrity(name) {
        return existing.get(name);
      },
      async publish(item, distTag) {
        assert.equal(distTag, input.distTag);
        published.push(item.name);
        existing.set(item.name, item.integrity);
      },
    };
    assert.deepEqual(
      await publishVerified(input, port),
      input.packages.map((item) => item.name),
    );
    assert.equal(published.at(-1), defaultPackageName);
    assert.deepEqual(await publishVerified(input, port), []);
    assert.equal(published.length, 4);
  }
});

test("a version conflict or registry read failure prevents every publish", async () => {
  for (const failure of ["conflict", "network"]) {
    let writes = 0;
    await assert.rejects(
      publishVerified(distribution(), {
        async integrity(name) {
          if (name !== defaultPackageName) return undefined;
          if (failure === "network") throw new Error("registry unavailable");
          return "sha512-different";
        },
        async publish() {
          writes++;
        },
      }),
      failure === "conflict" ? /different integrity/ : /registry unavailable/,
    );
    assert.equal(writes, 0);
  }
});

test("partial publication never advances the launcher and reruns only the missing packages", async () => {
  const input = distribution();
  const existing = new Map<string, string>();
  let fail = true;
  const published: string[] = [];
  const port: RegistryPort = {
    async integrity(name) {
      return existing.get(name);
    },
    async publish(item) {
      if (fail && item.target === "linux-arm64") throw new Error("publish interrupted");
      published.push(item.name);
      existing.set(item.name, item.integrity);
    },
  };
  await assert.rejects(publishVerified(input, port), /publish interrupted/);
  assert.deepEqual(published, [platformPackage(defaultPackageName, targets[0])]);
  fail = false;
  assert.deepEqual(await publishVerified(input, port), [
    platformPackage(defaultPackageName, targets[1]),
    platformPackage(defaultPackageName, targets[2]),
    defaultPackageName,
  ]);
  assert.equal(
    published.filter((name) => name === platformPackage(defaultPackageName, targets[0])).length,
    1,
  );
});

test("publication confirmation retries while npm registry metadata propagates", async () => {
  const input = distribution();
  const existing = new Map<string, string>();
  const reads = new Map<string, number>();
  const published: string[] = [];
  const port: RegistryPort = {
    async integrity(name) {
      const count = (reads.get(name) ?? 0) + 1;
      reads.set(name, count);
      return count < 3 ? undefined : existing.get(name);
    },
    async publish(item) {
      published.push(item.name);
      existing.set(item.name, item.integrity);
    },
  };
  assert.deepEqual(
    await publishVerified(input, port, { confirmationDelayMs: 0, pause: async () => {} }),
    [...input.packages.map((item) => item.name)],
  );
  assert.equal(reads.get(input.packages[0]?.name ?? ""), 3);
  assert.deepEqual(
    published,
    input.packages.map((item) => item.name),
  );
});
