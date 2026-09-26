import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Preserve established data in place; selecting the default never migrates it. */
export function defaultStateDir(home = homedir()): string {
  const legacy = join(home, ".herdr-agent");
  return existsSync(legacy) ? legacy : join(home, ".myrix");
}
