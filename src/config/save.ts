import { join, resolve } from "node:path";
import { stringify } from "smol-toml";
import { KeyedMutex } from "../core/mutex.js";
import { atomicWrite } from "../storage/atomic.js";
import { readToml } from "./load.js";

type Fields = Record<string, unknown>;

// Serializes read-modify-write per resolved config path so concurrent saves cannot
// overwrite each other's section. Cross-process writes are out of scope.
const locks = new KeyedMutex();

function mergeSection(existing: Fields, section: string, values: Fields): void {
  const previous = existing[section];
  existing[section] = { ...(previous && typeof previous === "object" ? previous : {}), ...values };
}

/**
 * Merges all sections with one atomic replacement under the per-path lock.
 * Unknown fields survive; later saves win on conflicting fields. As with atomicWrite,
 * a post-rename sync failure can reject after the complete batch is already visible.
 */
export async function saveConfigSections(
  stateDir: string,
  sections: Readonly<Record<string, Fields>>,
): Promise<void> {
  const path = resolve(join(stateDir, "config.toml"));
  await locks.run(path, async () => {
    const existing = readToml(path);
    for (const [section, values] of Object.entries(sections)) {
      mergeSection(existing, section, values);
    }
    await atomicWrite(path, `${stringify(existing)}\n`);
  });
}

export async function saveConfigSection(
  stateDir: string,
  section: string,
  values: Fields,
): Promise<void> {
  await saveConfigSections(stateDir, { [section]: values });
}
