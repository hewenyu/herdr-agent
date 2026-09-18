import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fail } from "../core/errors.js";
import type { Participant, StoredMessage, Task } from "../core/types.js";
import type { WebState } from "../web/contracts.js";
import type { ApplicationContext } from "./context.js";

/** A read projection: never calls current(), forTask(), delivery ACK or the action facade. */
export function historySnapshot(context: ApplicationContext, requestedOwner?: string): WebState {
  const allowed = [...new Set(context.config.feishu.allowedOpenIds)];
  const ownerId = requestedOwner ?? allowed[0];
  if (requestedOwner !== undefined && !allowed.includes(requestedOwner))
    fail("forbidden_owner", "该身份不在允许名单中。");
  const sessions = ownerId ? context.sessions.list(ownerId, { archived: true }) : [];
  const sessionIds = new Set(sessions.map((session) => session.id));
  const tasks = context.store.list<Task>("tasks").filter((task) => task.ownerId === ownerId);
  const messages = context.store
    .list<StoredMessage & { sequence?: number }>("messages")
    .filter((message) => sessionIds.has(message.sessionId))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        (a.sequence ?? 0) - (b.sequence ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const records: NonNullable<WebState["records"]> = [];
  const checkpoints = context.store
    .entries<{ sessionId: string; messages: AgentMessage[]; updatedAt?: string }>("pi_checkpoints")
    .filter(([, checkpoint]) => sessionIds.has(checkpoint.sessionId))
    .sort(
      ([leftId, left], [rightId, right]) =>
        (left.updatedAt ?? "").localeCompare(right.updatedAt ?? "") ||
        leftId.localeCompare(rightId),
    );
  for (const [id, checkpoint] of checkpoints) {
    for (const [index, message] of checkpoint.messages.entries()) {
      if (message.role === "assistant") {
        for (const item of message.content) {
          if (item.type !== "toolCall") continue;
          records.push({
            id: `${id}:${index}:${item.id}`,
            sessionId: checkpoint.sessionId,
            kind: "tool_call",
            createdAt: checkpoint.updatedAt,
            data: { name: item.name, arguments: item.arguments },
          });
        }
      } else if (message.role === "toolResult") {
        records.push({
          id: `${id}:${index}:${message.toolCallId}`,
          sessionId: checkpoint.sessionId,
          kind: "tool_result",
          createdAt: checkpoint.updatedAt,
          state: message.isError ? "error" : "returned",
          data: { name: message.toolName, content: message.content },
        });
      }
    }
  }
  const result: WebState = {
    activeOwnerId: ownerId,
    identities: allowed.map((id) => ({
      id,
      sessionCount: context.sessions.list(id, { archived: true }).length,
    })),
    sessions: sessions.map((session) => ({
      ...session,
      name:
        session.taskId && session.name === `任务 ${session.taskId}`
          ? (tasks.find((task) => task.id === session.taskId)?.title ?? session.name)
          : session.name,
    })),
    messages,
    records,
    participantNames: Object.fromEntries(
      context.store
        .list<Participant>("participants")
        .filter((participant) => tasks.some((task) => task.id === participant.taskId))
        .map((participant) => [participant.id, `${participant.name} (${participant.kind})`]),
    ),
    runtime: context.runtime,
    authorization: { status: context.authorization.status, message: context.authorization.message },
  };
  const secrets = [
    context.config.feishu.appSecret,
    context.config.ai.apiKey,
    context.config.memory.apiKey,
    ...Object.values(context.config.memory.users).map((memory) => memory.apiKey),
  ].filter(Boolean);
  return redact(result, secrets) as WebState;
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|authorization|password)$/i.test(
          key,
        ) && typeof item === "string"
          ? "[redacted]"
          : redact(item, secrets),
      ]),
    );
  return value;
}
