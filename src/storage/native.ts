import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";

interface FlockBinding {
  flock(fd: number, operation: number): void;
  constants: { LOCK_EX: number; LOCK_NB: number; LOCK_UN: number };
}

let binding: FlockBinding | undefined;
export function flockBinding(): FlockBinding {
  if (binding) return binding;
  const require = createRequire(import.meta.url);
  let path: string;
  if (isSea()) {
    const directory = mkdtempSync(join(tmpdir(), "herdr-agent-native-"));
    path = join(directory, "fs_ext.node");
    writeFileSync(path, Buffer.from(getAsset("fs_ext.node")), { mode: 0o600, flag: "wx" });
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  } else path = require.resolve("fs-ext/build/Release/fs_ext.node");
  binding = require(path) as FlockBinding;
  return binding;
}
