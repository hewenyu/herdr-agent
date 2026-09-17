import type { Logger } from "../core/ports.js";

export function createLogger(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    const safe = Object.fromEntries(
      Object.entries(fields ?? {}).filter(
        ([key]) => !/secret|key|token|authorization|password|body|content/i.test(key),
      ),
    );
    write(JSON.stringify({ time: new Date().toISOString(), level, message, ...safe }));
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
