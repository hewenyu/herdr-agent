import { OperationError } from "../core/errors.js";
import {
  type LifecycleEvidence,
  unsupportedLifecycleClaim,
} from "../runtime/lifecycle-evidence.js";
import {
  type ProvisionEvidence,
  recordProvisionEvidence,
  unsupportedProvisionClaim,
} from "../runtime/provision-evidence.js";
import type { ConversationEngine, EngineInput } from "../runtime/types.js";

/** The model writes notices; this boundary only checks their current machine facts. */
export async function noticeDecision(
  engine: ConversationEngine,
  input: EngineInput,
  facts: LifecycleEvidence,
): Promise<{ notify: boolean; text: string }> {
  const provisioning: ProvisionEvidence = { created: [], tasks: [] };
  recordProvisionEvidence(
    provisioning,
    "task_get",
    {},
    {
      ...facts.task,
      participants: facts.participants,
    },
  );
  let rejected: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await engine.run({
      ...input,
      ...(rejected
        ? {
            prompt: `${input.prompt}\n上次通知与当前事实不符，尚未发送。只依据上述服务端快照重新决定是否通知并输出JSON；群未解散时不得称已完成收尾或已解散，参与者尚未关闭不得称执行器已关闭，已登记不等于初始要求已投递。不重复查询等待本条通知送达。被拒通知仅供纠错：${JSON.stringify(rejected)}`,
          }
        : {}),
    });
    const decision = JSON.parse(answer.text) as { notify?: unknown; text?: unknown };
    if (typeof decision.notify !== "boolean" || typeof decision.text !== "string")
      throw new OperationError("notice_format", "模型通知格式无效，尚未发送。");
    if (
      !decision.notify ||
      (!unsupportedLifecycleClaim(decision.text, facts) &&
        !unsupportedProvisionClaim(decision.text, provisioning))
    )
      return { notify: decision.notify, text: decision.text };
    rejected = decision.text;
  }
  throw new OperationError("notice_fact_missing", "模型通知缺少对应事实，尚未发送。");
}
