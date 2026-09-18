import { OperationError } from "../core/errors.js";
import type { AgentSnapshot, AgentStatus } from "../core/types.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationError("invalid_response", "herdr 返回了无效结构。", "unknown");
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Preserve protocol uint64 values before JSON.parse can round them. */
export function parseExactJson(text: string): unknown {
  const protectedNumbers = text.replace(
    /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => {
      if (token.startsWith('"') || !/^-?\d+$/.test(token)) return token;
      const integer = BigInt(token);
      return integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)
        ? JSON.stringify(token)
        : token;
    },
  );
  return JSON.parse(protectedNumbers) as unknown;
}

export function uint64(value: unknown, fallback = "0"): string {
  if (value === undefined) return fallback;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new OperationError("invalid_sequence", "herdr 状态序号不精确。", "unknown");
  }
  const raw = typeof value === "number" ? String(value) : string(value);
  if (!/^\d+$/.test(raw) || BigInt(raw) > 18446744073709551615n) {
    throw new OperationError("invalid_sequence", "herdr 状态序号无效。", "unknown");
  }
  return BigInt(raw).toString();
}

export function snapshot(value: unknown): AgentSnapshot {
  const row = object(value);
  const kind = row.agent === "codex" || row.agent === "claude" ? row.agent : undefined;
  const status = ["idle", "working", "blocked", "done"].includes(string(row.agent_status))
    ? (row.agent_status as AgentStatus)
    : "unknown";
  const session = row.agent_session ? object(row.agent_session) : undefined;
  const paneId = string(row.pane_id);
  if (!paneId) throw new OperationError("invalid_response", "herdr 未返回 pane ID。", "unknown");
  return {
    paneId,
    workspaceId: string(row.workspace_id),
    kind,
    status,
    cwd: string(row.cwd) || string(row.foreground_cwd),
    name: string(row.name) || undefined,
    sessionId: session?.kind === "id" ? string(session.value) || undefined : undefined,
    terminalId: string(row.terminal_id) || undefined,
    stateSeq: uint64(row.state_change_seq),
    revision: uint64(row.revision),
    interactiveReady: row.interactive_ready === true,
    launchPending: row.launch_pending === true,
  };
}
