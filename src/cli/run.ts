import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DATE, COMMIT, VERSION } from "../build-info.js";
import { safeError } from "../core/errors.js";
import { HELP, parseArguments } from "./args.js";
import { type Dependencies, dependencies } from "./dependencies.js";
import { debug, doctor } from "./diagnostics.js";
import { service } from "./service.js";
import { setup } from "./setup.js";

export async function runCLI(
  argv: string[],
  overrides: Partial<Dependencies> = {},
): Promise<number> {
  const deps = dependencies(overrides);
  try {
    const args = parseArguments(argv);
    if (args.command === "help") {
      deps.stdout(HELP);
      return 0;
    }
    if (args.command === "version") {
      deps.stdout(
        args.json
          ? JSON.stringify({ version: VERSION, commit: COMMIT, date: BUILD_DATE })
          : `herdr-agent ${VERSION} (${COMMIT}, ${BUILD_DATE})`,
      );
      return 0;
    }
    const config = deps.loadConfig({ stateDir: args.stateDir });
    switch (args.command) {
      case "serve":
      case "configure":
        return await service(args, config, deps);
      case "setup":
        return await setup(args, config, deps);
      case "doctor":
        return await doctor(args, config, deps);
      case "debug":
        return await debug(args, config, deps);
      case "migrate": {
        const lock = deps.acquireLock(config.stateDir);
        let store: ReturnType<Dependencies["openStore"]> | undefined;
        try {
          const path = join(config.stateDir, "state.sqlite");
          store = deps.openStore(args.dryRun && !existsSync(path) ? ":memory:" : path);
          const report = await deps.migrate(config.stateDir, store, { dryRun: args.dryRun });
          deps.stdout(JSON.stringify(report, null, 2));
          return 0;
        } finally {
          try {
            store?.close();
          } finally {
            lock.release();
          }
        }
      }
    }
  } catch (error) {
    const failure = safeError(error);
    deps.stderr(failure.message);
    return deps.signal.aborted ? 130 : failure.code === "usage" ? 2 : 1;
  }
}
