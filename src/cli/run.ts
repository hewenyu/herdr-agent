import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUILD_DATE, COMMIT, VERSION } from "../build-info.js";
import { safeError } from "../core/errors.js";
import { HELP, parseArguments } from "./args.js";
import type { Dependencies } from "./dependencies.js";
import { configureWarningTraces } from "./warnings.js";

export async function runCLI(
  argv: string[],
  overrides: Partial<Dependencies> = {},
): Promise<number> {
  const io = {
    signal: overrides.signal ?? new AbortController().signal,
    stdout:
      overrides.stdout ??
      ((line: string) => {
        process.stdout.write(`${line}\n`);
      }),
    stderr:
      overrides.stderr ??
      ((line: string) => {
        process.stderr.write(`${line}\n`);
      }),
  };
  try {
    const args = parseArguments(argv);
    configureWarningTraces(args.traceWarnings);
    if (args.command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (args.command === "version") {
      io.stdout(
        args.json
          ? JSON.stringify({ version: VERSION, commit: COMMIT, date: BUILD_DATE })
          : `herdr-agent ${VERSION} (${COMMIT}, ${BUILD_DATE})`,
      );
      return 0;
    }
    if (args.command === "status") {
      const { status } = await import("./status.js");
      return await status(args, { stdout: io.stdout });
    }
    // Informational commands and usage errors must not initialize the service graph.
    const { dependencies } = await import("./dependencies.js");
    const deps = dependencies({ ...overrides, ...io });
    const config = deps.loadConfig({ stateDir: args.stateDir });
    switch (args.command) {
      case "serve":
      case "configure": {
        const { service } = await import("./service.js");
        return await service(args, config, deps);
      }
      case "setup": {
        const { setup } = await import("./setup.js");
        return await setup(args, config, deps);
      }
      case "doctor": {
        const { doctor } = await import("./diagnostics.js");
        return await doctor(args, config, deps);
      }
      case "debug": {
        const { debug } = await import("./diagnostics.js");
        return await debug(args, config, deps);
      }
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
    io.stderr(failure.message);
    return io.signal.aborted ? 130 : failure.code === "usage" ? 2 : 1;
  }
}
