import { mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { generateLicenses } from "./licenses.js";

export const root = fileURLToPath(new URL("../", import.meta.url));

export interface BuildStamp {
  version: string;
  commit: string;
  date: string;
}

/** SEA permits only built-in requires; esbuild exists solely in the unused development branch. */
export function checkStandaloneImports(metafile: Metafile): void {
  const allowed = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    "esbuild",
  ]);
  const invalid = Object.values(metafile.outputs).flatMap((output) =>
    output.imports.filter((entry) => entry.external && !allowed.has(entry.path)),
  );
  if (invalid.length) {
    throw new Error(`Unbundled runtime imports: ${invalid.map((item) => item.path).join(", ")}`);
  }
}

export async function buildApplication(options: { outdir?: string; stamp?: BuildStamp } = {}) {
  const outdir = resolve(options.outdir ?? resolve(root, "dist"));
  const stamp = options.stamp ?? {
    version: process.env.VERSION ?? "dev",
    commit: process.env.COMMIT ?? "unknown",
    date: process.env.BUILD_DATE ?? process.env.DATE ?? "unknown",
  };
  const frontend = await build({
    absWorkingDir: root,
    entryPoints: ["src/web/client/app.ts"],
    platform: "browser",
    format: "esm",
    target: "es2022",
    bundle: true,
    minify: true,
    write: false,
  });
  const appJs = frontend.outputFiles?.[0]?.text;
  if (!appJs) throw new Error("Missing frontend bundle");
  const [html, css] = await Promise.all([
    readFile(resolve(root, "src/web/assets/index.html"), "utf8"),
    readFile(resolve(root, "src/web/assets/styles.css"), "utf8"),
  ]);
  const plugin: Plugin = {
    name: "embedded-application-assets",
    setup(builder) {
      // ws has complete JavaScript fallbacks; debug's terminal colors are cosmetic.
      builder.onResolve({ filter: /^(supports-color|bufferutil|utf-8-validate)$/ }, (args) => ({
        path: args.path,
        namespace: "optional-runtime-module",
      }));
      builder.onLoad({ filter: /.*/, namespace: "optional-runtime-module" }, (args) => ({
        contents:
          args.path === "supports-color"
            ? "module.exports = false;"
            : 'throw new Error("Optional WebSocket native accelerator is disabled in standalone builds");',
        loader: "js",
      }));
      builder.onLoad({ filter: /[/\\]build-assets\.ts$/ }, () => ({
        contents: `export const webAssets = ${JSON.stringify({ "index.html": html, "styles.css": css, "app.js": appJs })};`,
        loader: "js",
      }));
      builder.onLoad({ filter: /[/\\]build-info\.ts$/ }, () => ({
        contents: `export const VERSION=${JSON.stringify(stamp.version)}; export const COMMIT=${JSON.stringify(stamp.commit)}; export const BUILD_DATE=${JSON.stringify(stamp.date)};`,
        loader: "js",
      }));
    },
  };
  await mkdir(outdir, { recursive: true });
  const bundle = resolve(outdir, "herdr-agent.cjs");
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/cli/main.ts"],
    outfile: bundle,
    platform: "node",
    format: "cjs",
    target: "node24.13",
    bundle: true,
    metafile: true,
    sourcemap: false,
    legalComments: "eof",
    external: ["esbuild"],
    define: { "import.meta.url": "__bundleModuleURL" },
    banner: {
      js: 'const __bundleModuleURL = require("node:url").pathToFileURL(__filename).href;',
    },
    plugins: [plugin],
  });
  checkStandaloneImports(result.metafile);
  await generateLicenses(result.metafile, outdir);
  await writeFile(
    resolve(outdir, "metafile.json"),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
  );
  return { bundle, outdir, stamp };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildApplication();
  process.stdout.write(`Built ${result.bundle}\n`);
}
