import { readdir, readFile } from "node:fs/promises";
import { checkModuleBoundaries } from "./module-boundaries.js";

const files = new Map<string, string>();
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && path.endsWith(".ts")) files.set(path, await readFile(path, "utf8"));
  }
}

await collect("src");
const violations = checkModuleBoundaries(files);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else console.log(`Module boundary check passed: ${files.size} TypeScript source files.`);
