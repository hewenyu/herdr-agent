import type { StoredMessage, Task } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { TaskUserRevision } from "../tasks/user-request.js";

/** Passive provenance remains available for auditing, but grants no planning instructions. */
export function orchestrationUserMessages(store: Store, task: Task): StoredMessage[] {
  const revisions = store
    .entries<TaskUserRevision>("task_user_revisions")
    .filter(([, entry]) => entry.taskId === task.id && entry.source.ownerId === task.ownerId);
  const passive = new Set(
    task.promptVersion === 3 && task.orchestration?.mode === "workflow"
      ? revisions
          .filter(([, entry]) => entry.usage === "read" || entry.usage === "control")
          .map(([, entry]) => entry.source.messageId)
      : [],
  );
  const messages = store
    .list<StoredMessage>("messages")
    .filter(
      (message) =>
        message.taskId === task.id &&
        message.role === "user" &&
        message.source === "user" &&
        !(message.deliveryIds ?? []).some((id) => passive.has(id)),
    );
  for (const [id, revision] of revisions) {
    if (
      passive.has(revision.source.messageId) ||
      messages.some((message) => message.deliveryIds?.includes(revision.source.messageId))
    )
      continue;
    messages.push({
      id,
      sessionId: revision.source.sessionId,
      taskId: task.id,
      role: "user",
      source: "user",
      text: revision.source.text,
      createdAt: revision.at,
      delivery: "delivered",
      deliveryIds: [revision.source.messageId],
      generation: 0,
    });
  }
  return messages.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}
