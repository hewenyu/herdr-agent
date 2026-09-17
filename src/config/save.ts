import { join } from "node:path";
import { stringify } from "smol-toml";
import { atomicWrite } from "../storage/atomic.js";
import { readToml } from "./load.js";

export async function saveConfigSection(
  stateDir: string,
  section: string,
  values: Record<string, unknown>,
): Promise<void> {
  const path = join(stateDir, "config.toml");
  const existing = readToml(path);
  const previous = existing[section];
  existing[section] = { ...(previous && typeof previous === "object" ? previous : {}), ...values };
  await atomicWrite(path, `${stringify(existing)}\n`);
}
