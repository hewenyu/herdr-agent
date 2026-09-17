import assert from "node:assert/strict";
import { test } from "node:test";
import type { Metafile } from "esbuild";
import { checkNodeVersion } from "../../scripts/binary.js";
import { checkStandaloneImports } from "../../scripts/build.js";

function metadata(paths: string[]): Metafile {
  return {
    inputs: {},
    outputs: {
      "app.cjs": {
        bytes: 100,
        inputs: {},
        exports: [],
        imports: paths.map((path) => ({ path, external: true, kind: "require-call" })),
      },
    },
  };
}

test("packaging refuses an unsupported Node runtime before producing a binary", () => {
  assert.throws(() => checkNodeVersion("22.19.0"), /Node >=24.13/);
  assert.throws(() => checkNodeVersion("24.12.0"), /Node >=24.13/);
  assert.doesNotThrow(() => checkNodeVersion("24.13.0"));
});

test("SEA bundle rejects dependencies that would need node_modules at runtime", () => {
  assert.doesNotThrow(() =>
    checkStandaloneImports(metadata(["node:fs", "node:sqlite", "esbuild"])),
  );
  assert.throws(
    () => checkStandaloneImports(metadata(["fs-ext"])),
    /Unbundled runtime imports: fs-ext/,
  );
  assert.throws(
    () => checkStandaloneImports(metadata(["./provider.js"])),
    /Unbundled runtime imports/,
  );
});
