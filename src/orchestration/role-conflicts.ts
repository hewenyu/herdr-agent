import type { Participant, Task } from "../core/types.js";
import { implementationParticipants, independentReviewer } from "./authorship.js";
import { workflowCandidates } from "./candidates.js";
import { readyNodes } from "./state.js";
import type { ProgramUserDecision, UserDecisionQuestion } from "./user-decision.js";
import type { WorkflowState } from "./workflow.js";

export interface WorkflowRoleConflict {
  nodeId: string;
  role: "reviewer" | "document_author";
  fixedParticipantId?: string;
  fixedParticipantName?: string;
  constraint: string;
  activeParticipants: Array<{
    id: string;
    name: string;
    authored: boolean;
    fixedReviewer: boolean;
  }>;
  participantLimit: 8;
  question: UserDecisionQuestion;
}

const participantName = (participant: Participant): string => participant.name.slice(0, 60);

/** Observe the same actual role conflict as the candidate builder, never model prose. */
export function observedRoleConflicts(
  task: Task,
  state: WorkflowState,
  participants: Participant[],
): WorkflowRoleConflict[] {
  if (
    !workflowCandidates(task, state, participants, [], false).some(
      (item) => item.id === "user:roles",
    )
  )
    return [];
  const active = participants.filter((participant) => participant.status !== "removed");
  const authors = implementationParticipants(state);
  const reviewers = new Set(
    state.plan.nodes
      .filter((node) => node.role === "reviewer")
      .flatMap((node) => node.participantId ?? []),
  );
  const ready = new Set(readyNodes(state).map((node) => node.id));
  return state.plan.nodes.flatMap((node) => {
    if (
      (!ready.has(node.id) && state.nodes[node.id]?.status !== "blocked") ||
      (!node.documentPaths?.length && node.role !== "reviewer")
    )
      return [];
    const canFillRole = (participant: Participant) =>
      (!node.documentPaths?.length || !reviewers.has(participant.id)) &&
      (node.role !== "reviewer" || independentReviewer(state, participant.id));
    if (
      active.some(
        (participant) =>
          (!node.participantId || node.participantId === participant.id) &&
          canFillRole(participant),
      )
    )
      return [];
    if (!node.documentPaths?.length && !node.participantId && active.length < 8) return [];
    const bound = participants.find((participant) => participant.id === node.participantId);
    const role = node.role === "reviewer" ? "reviewer" : "document_author";
    const label = role === "reviewer" ? "独立评审者" : "文档作者";
    const boundName = bound ? participantName(bound) : node.participantId;
    const constraint =
      role === "reviewer"
        ? "本任务的实现/文档作者不能担任独立评审者。"
        : "文档作者不能占用计划中固定的独立评审者。";
    const problem = !node.participantId
      ? `当前 ${active.length} 名参与者均不能担任该${label}，参与者上限为 8 人。`
      : !active.some((participant) => participant.id === node.participantId)
        ? `当前计划将${label}固定为 ${boundName}，但该参与者已不在有效名单中。`
        : `当前计划将${label}固定为 ${boundName}，但${role === "reviewer" ? "其已参与本任务实现或文档编写" : "其同时被固定为独立评审者"}。`;
    const replacements = active.filter(canFillRole).slice(0, 2);
    const options = replacements.map((participant) => ({
      label: `申请改由 ${participantName(participant)} 担任${label}`,
      impact: `需要更新节点 ${node.id} 的固定分工，再重新规划；${constraint}`,
    }));
    if (active.length < 8)
      options.push({
        label: `申请新增${label}并调整当前分工`,
        impact: `当前 ${active.length}/8 人，可申请增加一位符合角色约束的参与者；新增后仍需重规划${node.participantId ? "并更新固定绑定" : ""}。`,
      });
    options.push({
      label: "保留当前约束，暂不推进",
      impact: `节点 ${node.id} 及依赖它的后续工作继续等待；不会省略独立评审或宣告完成。`,
    });
    const sourceRef = `role_conflict:${node.id}`;
    const question: UserDecisionQuestion = {
      kind: options.length >= 2 ? "choice" : "input",
      question: `节点 ${node.id} 的${label}分工冲突，你允许怎样调整？`,
      why: `${problem}${constraint}程序不能自行解除当前固定分工或把自评算作独立评审。`,
      blockedScope: `节点 ${node.id}（${node.purpose.slice(0, 60)}）及依赖它的后续步骤；当前回复只说明调整意向，不直接修改分工。`,
      sourceRefs: [sourceRef],
      replyExample: replacements[0]
        ? `请将节点 ${node.id} 改由 ${participantName(replacements[0])} 担任${label}，保持独立评审要求并重新规划。`
        : active.length < 8
          ? `允许新增符合约束的${label}，调整节点 ${node.id} 的固定分工后重新规划。`
          : `我允许调整参与者名单：用新的${label}替换【填写可退出者姓名】，并重新规划节点 ${node.id}。`,
      ...(options.length >= 2
        ? { options }
        : {
            missingInput: `当前已满 ${active.length}/8 人，请指明你允许替换或退出的参与者姓名；若不允许调整，可回复“保留当前约束，暂不推进”。`,
            example: `允许将【现有参与者姓名】替换为符合约束的${label}，保持独立评审门槛；先按这个调整意向重新规划。`,
          }),
    };
    return [
      {
        nodeId: node.id,
        role,
        fixedParticipantId: node.participantId,
        fixedParticipantName: boundName,
        constraint,
        participantLimit: 8 as const,
        activeParticipants: active.map((participant) => ({
          id: participant.id,
          name: participantName(participant),
          authored: authors.has(participant.id),
          fixedReviewer: reviewers.has(participant.id),
        })),
        question,
      },
    ];
  });
}

export function roleConflictQuestions(
  task: Task,
  state: WorkflowState,
  participants: Participant[],
): ProgramUserDecision[] {
  return observedRoleConflicts(task, state, participants).map(({ question, ...facts }) => ({
    id: `role_conflict:${facts.nodeId}`,
    kind: "role_conflict",
    text: question.why,
    facts,
    question,
  }));
}
