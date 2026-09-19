/** Current-turn provisioning facts, separate from a successful local enqueue. */
export interface ProvisionEvidence {
  created: string[];
  tasks: ProvisionTask[];
}

interface ProvisionTask {
  id: string;
  remoteTask: boolean;
  group: boolean;
  participants: Array<{ id: string; name: string; kind: string; sent: boolean }>;
  deliveries: string[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function recordProvisionEvidence(
  evidence: ProvisionEvidence,
  name: string,
  args: Record<string, unknown>,
  result: unknown,
  boundTaskId?: string,
): void {
  const value = object(result);
  if (["task_create", "task_get", "tasks_list", "task_action"].includes(name)) {
    const records = name === "tasks_list" && Array.isArray(result) ? result : [value.task ?? value];
    for (const item of records) {
      const task = object(item);
      if (typeof task.id !== "string") continue;
      const previous = evidence.tasks.find((entry) => entry.id === task.id);
      const participants = Array.isArray(task.participants)
        ? task.participants
            .filter((entry) => typeof entry === "object")
            .map((entry) => {
              const participant = object(entry);
              return {
                id: String(participant.id ?? ""),
                name: String(participant.name ?? ""),
                kind: String(participant.kind ?? ""),
                sent: participant.initialSent === true,
              };
            })
        : (previous?.participants ?? []).filter(
            (participant) =>
              !Array.isArray(task.participantIds) || task.participantIds.includes(participant.id),
          );
      const fact: ProvisionTask = {
        id: task.id,
        remoteTask: typeof task.remoteTaskId === "string" && !!task.remoteTaskId,
        group: typeof task.chatId === "string" && !!task.chatId && task.groupDeleted === false,
        participants,
        deliveries: previous?.deliveries ?? [],
      };
      evidence.tasks = evidence.tasks.filter((entry) => entry.id !== task.id).concat(fact);
      if (name === "task_create" && !evidence.created.includes(task.id))
        evidence.created.push(task.id);
    }
  }
  if (name === "participant_send" && value.status === "delivered" && value.verified === true) {
    const id = typeof args.taskId === "string" ? args.taskId : boundTaskId;
    if (!id) return;
    let task = evidence.tasks.find((entry) => entry.id === id);
    if (!task) {
      task = { id, remoteTask: false, group: false, participants: [], deliveries: [] };
      evidence.tasks.push(task);
    }
    const selector = typeof args.participantId === "string" ? args.participantId : "";
    task.deliveries.push(selector);
    const matches = task.participants.filter(
      (entry) => entry.id === selector || entry.name === selector,
    );
    if (matches.length === 1 && matches[0]) matches[0].sent = true;
    if (!selector && task.participants.length === 1 && task.participants[0])
      task.participants[0].sent = true;
  }
}

/** Guard assertions only; questions, pending stages and negations remain model-written. */
export function unsupportedProvisionClaim(text: string, evidence: ProvisionEvidence): boolean {
  const clauses = text.split(/(?<=[。！？!?；;\n])/u).flatMap(taskClauses);
  return clauses.some((sentence) => {
    if (/[?？]\s*$/u.test(sentence)) return false;
    const clause = sentence.replace(/[。！？!?；;\n]+$/u, "");
    if (/(?:吗|么)\s*$/u.test(clause) || /^\s*(?:是否|Has |Have |Is )/iu.test(clause)) return false;
    // Remove only a negated/pending segment so a later contradictory assertion is still checked.
    const value = clause.replace(
      /(?:尚未|还没|没有|未能|无法|不能|等待|待|尚需|即将|将会|未|不会|会(?=创建|建群|转交|发送|收到))[^，,：:]*|\b(?:not|never|pending|waiting|will|cannot|can't)\b[^,;.]*/giu,
      "",
    );
    const asserted =
      /(?:已|成功|建好|建成|\b(?:created|established|sent|received|delivered|forwarded|dispatched|ready)\b)/iu;
    if (!asserted.test(value)) return false;
    const group =
      /(?:群|\b(?:group|chat)\b).{0,24}(?:建立|建好|建成|创建|拉好|就绪|已(?:经)?建(?:了)?(?=[，,、：:\s]|$)|created|established|ready)|(?:建好|建成|创建|建立|拉好|已(?:经)?建(?:了)?|created|established).{0,24}(?:群|\b(?:group|chat)\b)/iu.test(
        value,
      );
    const remote =
      /(?:飞书|Feishu|remote).{0,16}(?:任务|task).{0,16}(?:创建|建立|建好|建成|已(?:经)?建(?:了)?(?=[，,、：:\s]|$)|created)|(?:创建|建立|建好|建成|已(?:经)?建(?:了)?|created).{0,16}(?:飞书|Feishu|remote).{0,16}(?:任务|task)/iu.test(
        value,
      );
    // Delivery must be asserted in its own clause. "群已建立，初始要求投递
    // 确认前" and "已加入，但投递尚未确认" contain no successful delivery.
    const sent = value
      .split(/[，,]|(?:但是|不过|但|并且|而且)/iu)
      .some(
        (part) =>
          asserted.test(part) &&
          /(?:转交|投递|送达|交给|传给|发送|收到|forwarded|delivered|dispatched|\b(?:sent|received)\b)/iu.test(
            part,
          ) &&
          /(?:要求|需求|指令|限制|约束|Claude|Codex|参与者|prompt|requirements|instructions|constraints|participant)/iu.test(
            value,
          ),
      );
    if (!group && !remote && !sent) return false;
    const explicitIds = clause.match(/task_[a-zA-Z0-9]+/gu) ?? [];
    const ids = explicitIds.length ? explicitIds : evidence.created;
    const tasks = ids.length
      ? ids.map((id) => evidence.tasks.find((task) => task.id === id))
      : evidence.tasks;
    if (!tasks.length || tasks.some((task) => !task)) return true;
    return tasks.some((task) => {
      if (!task || (group && !task.group) || (remote && !task.remoteTask)) return true;
      if (!sent) return false;
      const kinds = ["claude", "codex"].filter((kind) => value.toLowerCase().includes(kind));
      const named = task.participants.filter(
        (participant) =>
          (participant.id && mentions(value, participant.id)) ||
          (participant.name &&
            !["claude", "codex"].includes(participant.name.toLowerCase()) &&
            mentions(value, participant.name)),
      );
      const participants =
        named.length && !/(?:所有|双方|全部|全体|\b(?:all|both)\b)/iu.test(value)
          ? named
          : task.participants.filter(
              (participant) => !kinds.length || kinds.includes(participant.kind),
            );
      if (kinds.some((kind) => !participants.some((participant) => participant.kind === kind)))
        return true;
      return participants.length
        ? participants.some((participant) => !participant.sent)
        : task.deliveries.length === 0 || kinds.length > 0;
    });
  });
}

/** A new explicit task starts its own assertion scope, not a new global claim. */
function taskClauses(sentence: string): string[] {
  const parts = sentence.split(
    /(?:[，,]\s*(?:(?:但是|不过|但|而)\s*)?|(?:但是|不过|但|而)\s*)(?=(?:任务\s*)?task_[a-zA-Z0-9]+)/u,
  );
  const result: string[] = [];
  let references = "";
  for (const part of parts) {
    const clause = references + part;
    // "task_a, task_b 群已创建" asserts both tasks. Do not mistake the ID
    // enumeration (or a participant-name comma) for independent assertions.
    const onlyReferences = clause
      .replace(/task_[a-zA-Z0-9]+/gu, "")
      .replace(/(?:任务|和|与|及|\band\b|[\s、，,:：])/giu, "");
    if (!onlyReferences && /task_[a-zA-Z0-9]+/u.test(clause)) {
      references = `${clause}，`;
      continue;
    }
    result.push(clause);
    references = "";
  }
  if (references) result.push(references);
  return result;
}

function mentions(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`, "iu").test(text);
}
