/**
 * Detect a model message that presents a business action as already happening
 * without a machine fact or tool result. This is a safety boundary for output
 * provenance; it never chooses a tool or generates a replacement response.
 */
export function hasUnverifiedToolClaim(text: string): boolean {
  const value = text.trim();
  // A question asks for state; it does not assert that the state exists. Keep
  // this narrow so a sentence containing a question and a separate assertion
  // still receives the provenance guard.
  if (/[?？]\s*$/u.test(value)) return false;
  const action =
    /(?:已经|正在|成功|排队|已(?:安排|创建|登记|发送|启动|转交|完成|关闭|解散|销毁)|\b(?:already\s+)?(?:created|creating|registered|queued|scheduled|sent|started|starting|assigned|dispatched|launched|provisioned|initialized|initialised|completed|complete|finished|closed|closing|deleted|deleting|removed|destroyed|done|succeeded)\b)/iu;
  const withoutNegatedAction = removeNegatedAction(value);
  const business =
    /(?:项目|任务|群|参与者|Codex|Claude|目录|链接|会话|session|project|task|chat|group|participant|directory|workspace|remoteTask)/iu;
  return (
    (action.test(withoutNegatedAction) ||
      futureChineseIntent.test(withoutNegatedAction) ||
      futureEnglishIntent.test(withoutNegatedAction)) &&
    business.test(value)
  );
}

/**
 * A read-only lookup can report state but cannot by itself prove that an action
 * such as creating, sending, or closing was carried out in this turn.
 */
export function requiresWriteEvidence(text: string): boolean {
  const value = text.trim();
  if (/[?？]\s*$/u.test(value)) return false;
  const withoutNegatedAction = removeNegatedAction(value);
  const writeAction =
    /(?:创建|新建|登记|发送|启动|安排|转交|拉群|建群|建立|已(?:创建|登记|发送|启动|安排|转交)|\b(?:create|created|schedule|scheduled|send|sent|start|started|assign|assigned|dispatch|dispatched|launch|launched|provision|provisioned|initialize|initialise|initialized|initialised|succeeded)\b)/iu;
  const business =
    /(?:项目|任务|群|参与者|Codex|Claude|目录|会话|session|project|task|chat|group|participant|workspace)/iu;
  return (
    (writeAction.test(withoutNegatedAction) ||
      futureChineseIntent.test(withoutNegatedAction) ||
      futureEnglishIntent.test(withoutNegatedAction)) &&
    business.test(value)
  );
}

/**
 * Detect an explicit request for this application's business tools. A model
 * may acknowledge such a request without making a claim about an external
 * result (for example, "收到，我处理"); that still cannot be accepted as a
 * completed turn because the requested operation has not been attempted.
 *
 * This is intentionally limited to business terms and action/query verbs.
 * Capability and explanation questions remain ordinary conversation unless
 * they also contain a direct imperative ("请创建项目", "帮我查询任务").
 */
export function requiresToolForRequest(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  const business =
    /(?:项目|任务|群|参与者|Codex|Claude|目录|会话|session|project|task|chat|group|participant|directory|workspace|agent)/iu;
  if (!business.test(value)) return false;
  const action =
    /(?:创建|新建|登记|安排|拉群|建群|建立|发送|启动|转交|完成|关闭|解散|销毁|删除|查询|查看|列出|列一下|看看|获取|恢复|归档|暂停|中断|继续|create|created|register|registered|schedule|scheduled|send|sent|start|started|assign|assigned|dispatch|dispatched|launch|launched|complete|completed|close|closed|delete|deleted|destroy|destroyed|list|show|get|query|archive|restore|pause|interrupt|resume)/iu;
  if (!action.test(value)) return false;
  const explanation =
    /(?:如何|怎么|怎样|解释|说明|教我|告诉我|什么是|能否|可以吗|是否可以|what\s+is|how\s+to|explain|whether|can\s+(?:you|this\s+tool)|is\s+it\s+possible)/iu;
  const directAction =
    /^(?:(?:请(?:帮我)?|帮我|帮忙|我要|我想|需要|开个|拉个|直接|现在|把|给我|能不能\s+帮我)\s*)?(?:创建|新建|登记|安排|拉群|建群|建立|发送|启动|转交|完成|关闭|解散|销毁|删除|查询|查看|列出|列一下|看看|获取|恢复|归档|暂停|中断|继续|create|created|register|registered|schedule|scheduled|send|sent|start|started|assign|assigned|dispatch|dispatched|launch|launched|complete|completed|close|closed|delete|deleted|destroy|destroyed|list|show|get|query|archive|restore|pause|interrupt|resume)/iu;
  if (explanation.test(value) && !directAction.test(value)) return false;
  return true;
}

const negatedEnglishAction =
  /\b(?:not|never|no|cannot|can't|couldn't|didn't|doesn't|isn't|wasn't|weren't|hasn't|haven't|failed\s+to|unable\s+to)\b[^.!?]{0,32}\b(?:created|creating|registered|queued|scheduled|sent|started|assigned|dispatched|launched|provisioned|initialized|initialised|completed|complete|finished|closed|deleted|removed|destroyed|done|succeeded)\b/giu;
const negatedChineseAction =
  /(?:尚未|还没|没有|没|未能|无法|不能|未|不|不会|不将|不来|不马上|不帮(?:你)?|不会帮(?:你)?)\s*(?:成功|已|正在|排队|会|将|来|马上(?:就)?|帮(?:你)?)?\s*(?:安排|创建|登记|发送|启动|转交|拉群|建群|完成|关闭|解散|销毁|删除|排队|成功)|不成功/gu;

/**
 * A first-person promise still claims that an operation will happen. It must
 * be backed by a tool result before it can be persisted as a successful reply.
 * Keep this scoped to explicit action verbs so capability explanations remain
 * ordinary text (for example, “我会告诉你如何创建项目”).
 */
const futureChineseIntent =
  /(?:(?:我(?:们)?\s*)?(?:会|将)\s*(?:(?:帮(?:你)?|马上(?:就)?|直接)\s*)?|我(?:们)?\s*(?:来|马上(?:就)?(?:会|将)?|帮(?:你)?)\s*|接下来\s*(?:(?:我(?:们)?\s*)?(?:(?:会|将)\s*)?)?)(?:创建|新建|登记|安排|发送|启动|转交|拉群|建群|建立|关闭|解散|销毁|删除)/iu;
const futureEnglishIntent =
  /\b(?:I|we)(?:'ll|'m\s+going\s+to|\s+(?:will|shall|am\s+going\s+to))\s+(?:(?:help\s+you|assist\s+you)\s+)?(?:create|schedule|start|send|assign|dispatch|launch|provision|initialize|initialise|close|delete|destroy)\b/iu;

function removeNegatedAction(value: string): string {
  return value.replace(negatedEnglishAction, "").replace(negatedChineseAction, "");
}
