import { OperationError } from "../core/errors.js";
import type { Participant } from "../core/types.js";
import type { TaskContext } from "./context.js";

/** Capture pre-input transcript identity so a later idle poll cannot report an old answer. */
export async function captureInputBaseline(
  context: TaskContext,
  participant: Participant,
): Promise<void> {
  if (!participant.execution)
    throw new OperationError("participant_unavailable", "参与者尚未就绪。");
  try {
    const legacy = context.store.get<Record<string, unknown>>("legacy_imports", participant.id);
    if (participant.cursor === undefined || (legacy && !legacy.baseline)) {
      participant.cursor = (await context.herdr.transcript(participant.execution)).cursor;
    }
    const before = await context.herdr.sampleLastReply(participant.execution);
    context.store.transaction(() => {
      context.store.set("participant_input_baseline", participant.id, { id: before?.id ?? "" });
      if (legacy && !legacy.baseline) {
        context.store.set("legacy_imports", participant.id, { ...legacy, baseline: true });
        if (typeof legacy.lastResult === "string") participant.lastOutput = legacy.lastResult;
      }
      context.records.saveParticipant(participant);
    });
  } catch (cause) {
    // No send has occurred. A failed read must not create an uncertain-input receipt.
    throw new OperationError(
      "transcript_unavailable",
      "投递前无法核对会话记录，本次尚未发送。",
      "not_executed",
      { cause },
    );
  }
}
