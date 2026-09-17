import { homedir } from "node:os";
import { join } from "node:path";

export function resolveSocketPath(explicit?: string, env = process.env, home = homedir()): string {
  if (explicit) return explicit;
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "herdr")
    : join(home, ".config", "herdr");
  const session = env.HERDR_SESSION ?? "";
  return session !== "default" &&
    session !== "." &&
    session !== ".." &&
    /^[A-Za-z0-9._-]{1,64}$/.test(session)
    ? join(base, "sessions", session, "herdr.sock")
    : join(base, "herdr.sock");
}
