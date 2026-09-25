import { fail } from "../core/errors.js";
import type { AgentKind, DirectoryMode, TaskCreateInput, TaskKind } from "../core/types.js";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("input", "输入必须为对象。");
  return value as Record<string, unknown>;
}

export function string(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) fail("input", `缺少有效字段：${key}`);
  if (value.length > 48_000) fail("input", `字段过长：${key}`);
  return value;
}

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  return input[key] === undefined || input[key] === "" ? undefined : string(input, key);
}

export function boolean(input: Record<string, unknown>, key: string, fallback = false): boolean {
  if (input[key] === undefined) return fallback;
  if (typeof input[key] !== "boolean") fail("input", `字段必须为布尔值：${key}`);
  return input[key] as boolean;
}

export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    fail("input", "目录必须是非空字符串数组。");
  }
  return value as string[];
}

export function agentKind(value: unknown): AgentKind {
  if (value !== "codex" && value !== "claude") fail("input", "参与者必须为 codex 或 claude。");
  return value;
}

export function taskInput(input: Record<string, unknown>): TaskCreateInput {
  const kind = string(input, "kind");
  if (!["discussion", "development", "review", "test"].includes(kind))
    fail("input", "任务类型无效。");
  if (!Array.isArray(input.participants)) fail("input", "请提供参与者列表。");
  const directoryMode = optionalString(input, "directoryMode");
  if (directoryMode && directoryMode !== "shared" && directoryMode !== "worktree")
    fail("input", "目录模式无效。");
  const discussion = input.discussion === undefined ? undefined : object(input.discussion);
  if (discussion?.mode && discussion.mode !== "manual" && discussion.mode !== "round_robin")
    fail("input", "讨论模式无效。");
  const orchestration = input.orchestration === undefined ? undefined : object(input.orchestration);
  if (orchestration && orchestration.mode !== "model" && orchestration.mode !== "manual")
    fail("input", "调度模式无效。");
  return {
    kind: kind as TaskKind,
    title: string(input, "title"),
    requirements: string(input, "requirements"),
    project: optionalString(input, "project"),
    newProject: boolean(input, "newProject"),
    participants: input.participants.map((entry) => {
      const value = object(entry);
      return {
        kind: agentKind(value.kind),
        name: optionalString(value, "name"),
        role: optionalString(value, "role"),
      };
    }),
    directoryMode: directoryMode as DirectoryMode | undefined,
    keepGroup: input.keepGroup === undefined ? undefined : boolean(input, "keepGroup"),
    createGroup: input.createGroup === undefined ? undefined : boolean(input, "createGroup"),
    createRemoteTask:
      input.createRemoteTask === undefined ? undefined : boolean(input, "createRemoteTask"),
    parentTaskId: optionalString(input, "parentTaskId"),
    orchestration: orchestration
      ? {
          mode: orchestration.mode as "model" | "manual",
          maxDecisions:
            orchestration.maxDecisions === undefined
              ? undefined
              : Number(orchestration.maxDecisions),
          maxMinutes:
            orchestration.maxMinutes === undefined ? undefined : Number(orchestration.maxMinutes),
        }
      : undefined,
    discussion: discussion
      ? {
          mode: discussion.mode as "manual" | "round_robin" | undefined,
          maxRounds: discussion.maxRounds === undefined ? undefined : Number(discussion.maxRounds),
          maxMinutes:
            discussion.maxMinutes === undefined ? undefined : Number(discussion.maxMinutes),
        }
      : undefined,
  };
}
