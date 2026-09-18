import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const roots = process.argv.slice(2);
const checkedRoots = roots.length
  ? roots
  : [
      "src",
      "tests",
      "scripts",
      "deploy",
      ".github",
      "package.json",
      "tsconfig.json",
      "biome.json",
      "justfile",
    ];
const failures = [];
let count = 0;

async function walk(directory) {
  const info = await stat(directory).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (info.isFile()) {
    await checkFile(directory);
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else await checkFile(path);
  }
}

async function checkFile(path) {
  if (
    /\.(?:[cm]?[jt]sx?|css|html|sh|py|go|ya?ml|toml|json)$/.test(path) ||
    basename(path) === "justfile"
  ) {
    const content = await readFile(path, "utf8");
    const lines = content.split("\n").length - Number(content.endsWith("\n"));
    count += 1;
    if (lines > 1000) failures.push(`${path}: ${lines} lines (maximum 1000)`);
    if (content.split("\n").some((line) => line.length > 500)) {
      failures.push(`${path}: line longer than 500 characters; split source, do not minify it`);
    }
  }
}

for (const root of checkedRoots) await walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`File size check passed: ${count} source files, maximum 1000 lines each.`);
