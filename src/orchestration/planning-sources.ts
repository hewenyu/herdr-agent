import { fail } from "../core/errors.js";
import type { Task } from "../core/types.js";

export interface PlanningSource {
  id: string;
  text: string;
  /** Older tasks can identify their stored request for document compatibility, not new constraints. */
  legacy?: true;
}

/** Only ingress originals and authenticated user revisions may grant constraints. */
export function planningSources(
  task: Task,
  userMessages: string[],
  sources?: PlanningSource[],
): PlanningSource[] {
  const original = task.userRequest;
  return [
    ...(!original && !task.requestContext?.length
      ? [{ id: "legacy-task-requirements", text: task.requirements, legacy: true as const }]
      : []),
    ...(task.requestContext ?? []).map(({ messageId, text }) => ({ id: messageId, text })),
    ...(original ? [{ id: original.messageId, text: original.text }] : []),
    ...(sources ?? userMessages.map((text, index) => ({ id: `revision-${index + 1}`, text }))),
  ].filter((source, index, all) => all.findIndex((entry) => entry.id === source.id) === index);
}

export function sourceText(sources: PlanningSource[], id: unknown): string {
  const source = typeof id === "string" ? sources.find((entry) => entry.id === id) : undefined;
  if (!source) fail("workflow_scope", "sourceMessageId 必须引用列出的真实用户消息。");
  return source.text;
}
