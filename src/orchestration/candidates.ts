import type { Participant, Task } from "../core/types.js";
import { independentReviewer } from "./authorship.js";
import { readyNodes } from "./state.js";
import type { VerificationCandidate } from "./verify.js";
import type { WorkflowState } from "./workflow.js";

export interface WorkflowCandidate {
  id: string;
  description: string;
  kind: "dispatch" | "rework" | "verify" | "deliver" | "replan" | "user" | "add_reviewer";
  assignments?: Array<{ nodeId: string; participantId: string }>;
  verification?: VerificationCandidate;
}

export function workflowCandidates(
  task: Task,
  state: WorkflowState,
  participants: Participant[],
  verification: VerificationCandidate[],
  reportReady: boolean,
): WorkflowCandidate[] {
  const available = participants.filter(
    (entry) =>
      entry.started && entry.execution && ["idle", "done"].includes(entry.status) && !entry.error,
  );
  if (state.stall.awaitingUser)
    return [
      {
        id: "user:stall",
        kind: "user",
        description: `未决问题连续未变化，请用户裁决：${state.issues
          .filter((item) => item.status === "open")
          .map((item) => `${item.id}: ${item.description}`)
          .join("；")}`,
      },
    ];
  const blocked = Object.entries(state.nodes).filter(([, entry]) => entry.status === "blocked");
  const ready = readyNodes(state);
  const candidates: WorkflowCandidate[] = [];
  const eligible = (nodeId: string) => {
    const node = state.plan.nodes.find((entry) => entry.id === nodeId);
    return available.filter(
      (entry) =>
        (!node?.participantId || node.participantId === entry.id) &&
        (node?.role !== "reviewer" || independentReviewer(state, entry.id)),
    );
  };
  if (
    task.kind === "discussion" &&
    task.promptVersion !== 3 &&
    ready.length > 1 &&
    ready.every((node) => node.role === "analyst" && !node.dependsOn.length && node.participantId)
  ) {
    const assignments = ready.flatMap((node) => {
      const participant = eligible(node.id)[0];
      return participant ? [{ nodeId: node.id, participantId: participant.id }] : [];
    });
    if (assignments.length === ready.length)
      candidates.push({
        id: "dispatch:independent-opening",
        kind: "dispatch",
        description: "安排全部讨论参与者独立开场，再收齐输出进行交叉回应。",
        assignments,
      });
  } else {
    for (const node of ready) {
      if (
        node.phase === "reporting" &&
        state.issues.some((issue) => issue.status === "open" && issue.blocking)
      )
        continue;
      if (node.phase === "validating" && verification.length) continue;
      for (const participant of eligible(node.id))
        candidates.push({
          id: `dispatch:${node.id}:${participant.id}`,
          kind: "dispatch",
          description: `${participant.name}：${node.purpose}`,
          assignments: [{ nodeId: node.id, participantId: participant.id }],
        });
    }
  }
  for (const command of verification)
    candidates.push({
      id: `verify:${command.commandIndex}`,
      kind: "verify",
      description: command.description,
      verification: command,
    });
  if (
    ready.some((node) => node.role === "reviewer" && !eligible(node.id).length) &&
    participants.filter((entry) => entry.status !== "removed").length < 8
  )
    candidates.push({
      id: "add:reviewer",
      kind: "add_reviewer",
      description: "增加独立评审参与者，在当前授权范围内复核，不能由实现者自行证明评审通过。",
    });
  for (const [nodeId, progress] of blocked) {
    for (const participant of eligible(nodeId))
      candidates.push({
        id: `rework:${nodeId}:${participant.id}`,
        kind: "rework",
        description: `${participant.name} 补证据或修订 ${nodeId}：${progress.error ?? progress.summary}`,
        assignments: [{ nodeId, participantId: participant.id }],
      });
  }
  if (state.issues.some((issue) => issue.status === "open")) {
    const target =
      [...state.plan.nodes]
        .reverse()
        .find((node) => node.role === "implementer" || node.documentPaths?.length) ??
      state.plan.nodes.find((node) => node.phase === "reviewing");
    if (target)
      for (const participant of eligible(target.id))
        candidates.push({
          id: `resolve:${target.id}:${participant.id}`,
          kind: "rework",
          description: `${participant.name} 针对未决问题补证据或修订，随后重新验证评审。`,
          assignments: [{ nodeId: target.id, participantId: participant.id }],
        });
  }
  if (reportReady)
    candidates.push({
      id: "deliver:report",
      kind: "deliver",
      description: "报告合同满足，将完整报告及摘要交给用户验收。",
    });
  if (!reportReady && !candidates.length && !ready.length && !blocked.length)
    candidates.push({
      id: "replan:missing",
      kind: "replan",
      description: "当前计划未产生可交付报告，请按缺失证据重规划。",
    });
  if (blocked.length || state.issues.some((issue) => issue.status === "open"))
    candidates.push(
      {
        id: "replan:blocked",
        kind: "replan",
        description:
          "根因不明、影响扩大或方案分歧使原计划不适用时，重规划加入讨论和补证据节点；不扩展用户授权。",
      },
      {
        id: "user:blocked",
        kind: "user",
        description: "只有确需用户决定、权限或必需信息时等待用户；常规返工继续安排参与者。",
      },
    );
  return candidates;
}
