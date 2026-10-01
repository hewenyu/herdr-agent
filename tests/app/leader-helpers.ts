import assert from "node:assert/strict";
import type { WorkflowCandidate } from "../../src/orchestration/candidates.js";
import type { EngineInput } from "../../src/runtime/types.js";

/** Read the event payload inside the durable Leader activation, not outer-chat data. */
export function leaderEventPrompt(
  input: Pick<EngineInput, "sessionId" | "prompt" | "messages">,
): string {
  if (!input.sessionId.startsWith("task-leader:")) return input.prompt;
  let activation: unknown = JSON.parse(input.prompt);
  if (
    activation &&
    typeof activation === "object" &&
    "kind" in activation &&
    activation.kind === "leader_activation_request"
  ) {
    // Large but complete mandatory payloads live in the current request message;
    // the short prompt is only a pointer, never a substitute or a severed prefix.
    const request = input.messages.findLast((message) => message.role === "user");
    if (!request || request.role !== "user")
      throw new Error("Expected the complete Leader request message");
    const content =
      typeof request.content === "string"
        ? request.content
        : request.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
    activation = JSON.parse(content);
  }
  if (
    !activation ||
    typeof activation !== "object" ||
    !("event" in activation) ||
    typeof activation.event !== "string"
  )
    throw new Error("Expected the durable Leader activation's event payload");
  return activation.event;
}

/** Exercise v3's real read/action tools; never adapt the production engine or v2 protocol. */
export async function chooseLeaderAction(
  input: EngineInput,
  select: (ids: string[]) => string | undefined | null = (ids) =>
    ids.find((id) => id.startsWith("deliver:")) ??
    ids.find((id) => id.startsWith("dispatch:")) ??
    ids[0],
): Promise<boolean> {
  const status = input.tools.find((tool) => tool.name === "workflow_status");
  if (!status) return false;
  assert.ok(input.sessionId.startsWith("task-leader:"));
  const board = (await status.execute({}, input.actor)) as {
    legalActions: Pick<WorkflowCandidate, "id" | "kind">[];
  };
  const selected = select(board.legalActions.map((candidate) => candidate.id));
  // Explicitly simulate a model refusing to choose, without adapting real tools.
  if (selected === null) return true;
  const candidate = board.legalActions.find((entry) => entry.id === selected);
  assert.ok(candidate, "the fixture must select a real, currently legal candidate");
  const kind =
    candidate.kind === "rework" ? "dispatch" : candidate.kind === "user" ? "wait" : candidate.kind;
  const tool = input.tools.find((entry) => entry.name === `workflow_${kind}`);
  assert.ok(tool, "the selected action must be exposed by the actual Leader surface");
  await tool.execute(
    {
      ...(["wait", "deliver"].includes(kind) ? {} : { candidateId: candidate.id }),
      reason: "按当前可执行候选与已核验依赖继续。",
    },
    input.actor,
  );
  return true;
}
