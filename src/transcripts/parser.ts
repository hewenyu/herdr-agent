import { createHash } from "node:crypto";
import type { AgentKind, TranscriptEntry } from "../core/types.js";
import { cleanScreen } from "../herdr/screen.js";

type Row = Record<string, unknown>;
function row(value: unknown): Row | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : undefined;
}
function text(value: unknown): string {
  return typeof value === "string" ? cleanScreen(value).trim() : "";
}
const codexTags = new Set([
  "environment_context",
  "user_instructions",
  "skills_instructions",
  "multi_agent_mode",
  "INSTRUCTIONS",
]);
const claudeTags = new Set([
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "system-reminder",
]);

export function injected(value: string, kind: AgentKind): boolean {
  if (kind === "codex" && value.startsWith("# AGENTS.md instructions")) return true;
  const tags = kind === "codex" ? codexTags : claudeTags;
  let rest = value.trim();
  let matched = false;
  while (rest) {
    const match = /^<([\w-]+)>/.exec(rest);
    const tag = match?.[1];
    if (!tag || !tags.has(tag)) return false;
    const end = rest.indexOf(`</${tag}>`, match[0].length);
    if (end < 0) return false;
    rest = rest.slice(end + tag.length + 3).trim();
    matched = true;
  }
  return matched;
}

function toolSummary(block: Row): string {
  const name = text(block.name) || "tool";
  let input = row(block.input) ?? row(block.arguments);
  if (!input && typeof block.arguments === "string") {
    try {
      input = row(JSON.parse(block.arguments));
    } catch {
      /* Keep only the tool name. */
    }
  }
  const description =
    input &&
    ["file_path", "path", "command", "cmd", "pattern", "query"]
      .map((key) => text(input?.[key]))
      .find(Boolean);
  return description ? `${name}(${description.replace(/\s+/g, " ").slice(0, 180)})` : name;
}

export function parseRecord(
  kind: AgentKind,
  line: string,
  offset: number,
  source: string,
): TranscriptEntry[] {
  let record: Row | undefined;
  try {
    record = row(JSON.parse(line));
  } catch {
    return [];
  }
  if (!record) return [];
  const id = createHash("sha256").update(`${source}:${offset}:${line}`).digest("hex").slice(0, 32);
  const timestamp =
    typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
      ? record.timestamp
      : undefined;
  const entry = (
    role: TranscriptEntry["role"],
    content: string,
    final = false,
    suffix = "",
  ): TranscriptEntry => ({ id: id + suffix, role, text: content, final, timestamp });
  if (kind === "claude") {
    if (record.isSidechain === true || !["user", "assistant"].includes(text(record.type)))
      return [];
    if (record.type === "user" && record.isMeta === true) return [];
    const message = row(record.message);
    if (!message) return [];
    const role = record.type === "user" ? "user" : "assistant";
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    if (!Array.isArray(blocks)) return [];
    const prose: string[] = [];
    const tools: string[] = [];
    for (const value of blocks) {
      const block = row(value);
      if (!block) continue;
      if (block.type === "text") {
        const content = text(block.text);
        if (content && !(role === "user" && injected(content, kind))) prose.push(content);
      } else if (block.type === "tool_use" && role === "assistant") tools.push(toolSummary(block));
    }
    const result: TranscriptEntry[] = [];
    if (prose.length)
      result.push(entry(role, prose.join("\n\n"), role === "assistant" && tools.length === 0));
    if (tools.length) result.push(entry("tool", tools.join("\n"), false, ":tools"));
    return result;
  }
  if (record.type !== "response_item") return [];
  const payload = row(record.payload);
  if (!payload) return [];
  if (payload.type === "function_call" || payload.type === "custom_tool_call")
    return [entry("tool", toolSummary(payload))];
  if (
    payload.type !== "message" ||
    !["user", "assistant"].includes(text(payload.role)) ||
    !Array.isArray(payload.content)
  )
    return [];
  const role = payload.role === "user" ? "user" : "assistant";
  const blocks = payload.content
    .map(row)
    .filter((block) => block && ["input_text", "output_text", "text"].includes(text(block.type)));
  const prose = blocks
    .map((block) => text(block?.text))
    .filter((content) => content && !(role === "user" && injected(content, kind)));
  return prose.length
    ? [entry(role, prose.join("\n\n"), role === "assistant" && payload.phase !== "commentary")]
    : [];
}

export function parseLines(
  kind: AgentKind,
  data: Buffer,
  start: number,
  source: string,
): { entries: TranscriptEntry[]; consumed: number } {
  const entries: TranscriptEntry[] = [];
  let offset = 0;
  for (;;) {
    const end = data.indexOf(10, offset);
    if (end < 0) return { entries, consumed: offset };
    entries.push(
      ...parseRecord(kind, data.subarray(offset, end).toString("utf8"), start + offset, source),
    );
    offset = end + 1;
  }
}
