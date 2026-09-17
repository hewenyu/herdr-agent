import type { Logger } from "../core/ports.js";

// Log primitive diagnostics only. Never serialize transport objects or URL credentials.
function safeText(value: string): string {
  return value.replace(/\b(?:https?|wss?):\/\/\S+/gi, "[redacted-url]");
}

export function createLogger(
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    const safe = Object.fromEntries(
      Object.entries(fields ?? {})
        .filter(
          ([key, value]) =>
            !/secret|key|token|authorization|password|body|content|prompt|text|url|request|response|credential|^(time|level|message)$/i.test(
              key,
            ) &&
            (value === null || ["string", "number", "boolean"].includes(typeof value)),
        )
        .map(([key, value]) => [key, typeof value === "string" ? safeText(value) : value]),
    );
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        message: safeText(message),
        ...safe,
      }),
    );
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
