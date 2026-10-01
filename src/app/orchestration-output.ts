import { fail } from "../core/errors.js";
import { MODEL_RESULT_MAX_BYTES } from "../runtime/model-context.js";
import type { RuntimeTool } from "../runtime/types.js";
import type { SettledTaskOutput } from "./task-orchestrator.js";

/** A task-scoped, lossless page, bounded after JSON escaping and envelope metadata. */
export function orchestrationOutputTool(
  outputs: () => SettledTaskOutput[],
  assertCurrent: () => void,
): RuntimeTool {
  return {
    name: "orchestration_output",
    description:
      "按真实输出编号分页读取本任务参与者的完整历史原文，只读。offset为字符偏移，limit最多12000；实际页长受完整JSON字节预算约束，以nextOffset继续。",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        outputId: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 12000 },
      },
      required: ["outputId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      assertCurrent();
      const output = outputs().find((entry) => entry.entry.id === args.outputId);
      if (!output) fail("orchestration_evidence", "指定输出不属于当前任务。");
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 6000;
      if (
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 12000
      )
        fail("input", "输出分页参数无效。");
      const page = {
        outputId: output.entry.id,
        participantId: output.participantId,
        text: "",
        offset,
        totalCharacters: output.entry.text.length,
        nextOffset: null as number | null,
      };
      const availableBytes = MODEL_RESULT_MAX_BYTES - Buffer.byteLength(JSON.stringify(page)) - 32;
      if (availableBytes < 6) fail("context_budget", "输出分页元数据超过模型结果预算。");
      // JSON escaping costs at most six bytes per UTF-16 code unit, including
      // lone surrogates. Reserve space for the actual numeric nextOffset too.
      page.text = output.entry.text.slice(
        Number(offset),
        Number(offset) + Math.min(Number(limit), Math.floor(availableBytes / 6)),
      );
      const next = Number(offset) + page.text.length;
      page.nextOffset = next < output.entry.text.length ? next : null;
      return page;
    },
  };
}
