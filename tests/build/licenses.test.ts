import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Metafile } from "esbuild";
import { generateLicenses, packageRoot } from "../../scripts/licenses.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "herdr-licenses-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nodeLicensePath = join(root, "NODE-LICENSE");
  await writeFile(nodeLicensePath, "Node.js is licensed for use as follows:\nfixture original\n");
  const write = async (path: string, content: string) => {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  };
  const pkg = async (name: string, version = "1.0.0") => {
    await write(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version, license: "MIT" }),
    );
  };
  return { root, nodeLicensePath, write, pkg, outdir: join(root, "dist") };
}
function metadata(inputs: Record<string, number>): Metafile {
  return {
    inputs: {},
    outputs: {
      "output.cjs": {
        bytes: 1,
        imports: [],
        exports: [],
        inputs: Object.fromEntries(
          Object.entries(inputs).map(([name, bytesInOutput]) => [name, { bytesInOutput }]),
        ),
      },
    },
  };
}

test("license packaging uses actual package roots, includes NOTICE and native texts, and skips eliminated code", async (t) => {
  const f = await fixture(t);
  await f.pkg("fixture");
  await f.write("node_modules/fixture/libesm/package.json", '{"type":"module"}');
  await f.write("node_modules/fixture/LICENSE-MIT", "verbatim copyright\r\npermission\r\n");
  await f.write("node_modules/fixture/NOTICE", "original notice\n");
  await f.pkg("native");
  await f.write("node_modules/native/LICENSE", "native permission\n");
  await generateLicenses(
    metadata({ "node_modules/fixture/libesm/index.js": 9, "node_modules/eliminated/index.js": 0 }),
    f.outdir,
    { root: f.root, nativePackages: ["native"], nodeLicensePath: f.nodeLicensePath },
  );
  assert.equal(
    packageRoot("node_modules/fixture/libesm/index.js", f.root),
    join(f.root, "node_modules/fixture"),
  );
  assert.equal(
    packageRoot("node_modules/a/node_modules/@scope/b/lib/index.js", f.root),
    join(f.root, "node_modules/a/node_modules/@scope/b"),
  );
  const result = JSON.parse(await readFile(join(f.outdir, "LICENSES/manifest.json"), "utf8"));
  assert.deepEqual(
    result.packages.map((entry: { name: string }) => entry.name),
    ["fixture", "native"],
  );
  assert.equal(
    await readFile(join(f.outdir, "LICENSES/fixture_1.0.0/LICENSE-MIT"), "utf8"),
    "verbatim copyright\r\npermission\r\n",
  );
  assert.equal(
    await readFile(join(f.outdir, "LICENSES/fixture_1.0.0/NOTICE"), "utf8"),
    "original notice\n",
  );
  assert.deepEqual(
    await readFile(join(f.outdir, "LICENSES/NODE-LICENSE.txt")),
    await readFile(f.nodeLicensePath),
  );
});

test("complete README permission is copied verbatim; MIT label alone fails closed", async (t) => {
  const f = await fixture(t);
  await f.pkg("readme");
  const body =
    "License\n-------\n\nCopyright Fixture\nPermission is hereby granted\nTHE SOFTWARE IS PROVIDED\n";
  await f.write("node_modules/readme/README.md", `# Package\n\n${body}`);
  const options = { root: f.root, nativePackages: [], nodeLicensePath: f.nodeLicensePath };
  const meta = metadata({ "node_modules/readme/main.js": 1 });
  await generateLicenses(meta, f.outdir, options);
  assert.equal(
    await readFile(join(f.outdir, "LICENSES/readme_1.0.0/README-LICENSE.txt"), "utf8"),
    body,
  );
  await f.write("node_modules/readme/README.md", "# Package\n\n## License\nMIT\n");
  await assert.rejects(
    generateLicenses(meta, f.outdir, options),
    /Missing complete license: readme@1.0.0/,
  );
});

test("vendored permissions require exact version and digest; missing Node notice fails build", async (t) => {
  const f = await fixture(t);
  await f.pkg("pinned");
  const bytes = Buffer.from("Original pinned permission\n");
  await f.write("licenses/vendor/LICENSE.txt", bytes.toString());
  await f.write(
    "licenses/vendor/sources.json",
    JSON.stringify({
      "pinned@1.0.0": {
        file: "LICENSE.txt",
        source: "https://example.test/commit/LICENSE",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }),
  );
  const options = { root: f.root, nativePackages: [], nodeLicensePath: f.nodeLicensePath };
  const meta = metadata({ "node_modules/pinned/main.js": 1 });
  await generateLicenses(meta, f.outdir, options);
  await f.write("licenses/vendor/LICENSE.txt", "Changed");
  await assert.rejects(generateLicenses(meta, f.outdir, options), /hash mismatch/);
  await f.pkg("pinned", "2.0.0");
  await assert.rejects(
    generateLicenses(meta, f.outdir, options),
    /Missing complete license: pinned@2.0.0/,
  );
  await assert.rejects(
    generateLicenses(metadata({}), f.outdir, {
      ...options,
      nodeLicensePath: join(f.root, "missing"),
    }),
    /Missing Node distribution LICENSE/,
  );
});
