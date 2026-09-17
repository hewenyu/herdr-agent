import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type BuildStamp, buildApplication, root } from "./build.js";

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status ?? result.signal}`);
}

export function checkNodeVersion(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 13)) {
    throw new Error(`Node >=24.13.0 is required for SEA packaging, got ${version}`);
  }
}

/** Build on the destination OS/architecture: fs-ext is a native addon, not cross compiled. */
export async function buildBinary(options: { outdir?: string; stamp?: BuildStamp } = {}) {
  checkNodeVersion();
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Supported binary platforms are macOS and Linux");
  }
  const application = await buildApplication(options);
  const { outdir, bundle } = application;
  const work = resolve(outdir, "sea");
  await mkdir(work, { recursive: true });
  const require = createRequire(import.meta.url);
  const addon = require.resolve("fs-ext/build/Release/fs_ext.node");
  const binary = resolve(outdir, "herdr-agent");
  const blob = resolve(work, "sea-prep.blob");
  const config = resolve(work, "sea-config.json");
  await writeFile(
    config,
    `${JSON.stringify(
      {
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: { "fs_ext.node": addon },
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ["--experimental-sea-config", config]);
  await copyFile(process.execPath, binary);
  await chmod(binary, 0o755);
  if (process.platform === "darwin") run("codesign", ["--remove-signature", binary]);
  const args = [
    require.resolve("postject/dist/cli.js"),
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  run(process.execPath, args);
  if (process.platform === "darwin") run("codesign", ["--sign", "-", binary]);
  return { ...application, binary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildBinary();
  process.stdout.write(`Built standalone ${result.binary} (${process.platform}/${process.arch})\n`);
}
