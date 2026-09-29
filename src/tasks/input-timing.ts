import type { InputProgress } from "../core/ports.js";
import type { Participant, Task } from "../core/types.js";
import type { TaskContext } from "./context.js";

export interface InputTiming {
  taskId: string;
  participantId: string;
  operationId: string;
  paneId?: string;
  events: InputProgress[];
}

/** Records request write, response ACK and readback separately; never records input text. */
export function inputTiming(
  context: TaskContext,
  task: Task,
  participant: Participant,
  operationId: string,
): (progress: InputProgress) => void {
  return (progress) => {
    const record: InputTiming = context.store.get("task_input_timing", operationId) ?? {
      taskId: task.id,
      participantId: participant.id,
      operationId,
      paneId: participant.execution?.paneId,
      events: [],
    };
    record.events.push(progress);
    context.store.set("task_input_timing", operationId, record);
    context.logger?.info("参与者输入投递边界", {
      event: `input.${progress.phase}`,
      taskId: record.taskId,
      participantId: record.participantId,
      operationId,
      paneId: record.paneId,
      at: progress.at,
      ...(progress.verified !== undefined ? { verified: progress.verified } : {}),
    });
  };
}
