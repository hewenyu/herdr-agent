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
  // Quoted examples and code are data, not fresh instructions. Work clause by
  // clause so "不要建群，先查询任务" still recognizes the positive lookup.
  const value = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"\n]*"/gu, " ").trim();
  if (!value) return false;
  const business =
    /(?:项目|任务|群|参与者|Codex|Claude|目录|会话|session|project|task|chat|group|participant|directory|workspace|agent)/iu;
  const clauses = value.split(/([，,。.!！?？;；\n]+|但是|不过|然后|\bbut\b|\bthen\b)/iu);
  const businessContext = business.test(value) || /讨论/iu.test(value);
  let explaining = false;
  for (let index = 0; index < clauses.length; index += 2) {
    const original = clauses[index]?.trim() ?? "";
    if (requestIsExplanation.test(original) || capabilityQuestion.test(original)) {
      explaining = true;
      continue;
    }
    if (!original || requestIsNonAction.test(original)) continue;
    // Explanation examples span commas. A fresh imperative or an explicit
    // transition starts a new request; numbered example steps do not.
    const separator = clauses[index - 1] ?? "";
    if (
      explaining &&
      !/^(?:请|帮我|我要|现在|直接|另外|please|now)\s*/iu.test(original) &&
      !/(?:[。.!！?？;；]|但是|不过|然后|\bbut\b|\bthen\b)/iu.test(separator)
    )
      continue;
    if (explaining && /^(?:第[一二三四五六七八九十\d]+步|步骤\s*\d|step\s+\d)/iu.test(original))
      continue;
    const clause = removeNegatedAction(original);
    const target = business.test(clause);
    // Delegation is an application action even when the work delegated is
    // explaining, discussing, coding or reviewing. The runtime still selects
    // only orchestration tools; it never performs that work itself.
    if (target && delegatedRequest.test(clause)) return true;
    if (requestExplanation.test(clause)) continue;
    if (target && (businessRequestAction.test(clause) || projectWorkRequest.test(clause)))
      return true;
    // Lifecycle replies often refer to the active task/discussion implicitly.
    if (businessContext && lifecycleRequest.test(clause)) return true;
  }
  return false;
}

const businessRequestAction =
  /(?:创建|新建|登记|安排|拉群|建群|建立|发送|启动|转交|交给|完成|关闭|解散|销毁|删除|查询|查看|列出|列一下|看看|获取|恢复|归档|暂停|中断|继续|开(?:一)?个.{0,12}任务|拉(?:一)?个.{0,12}群|\b(?:create|register|schedule|send|start|assign|dispatch|launch|complete|close|delete|destroy|list|show|get|query|archive|restore|pause|interrupt|resume)\b)/iu;
const delegatedRequest =
  /(?:让|请|叫|找|用|安排|交给|转交|派).{0,48}(?:Codex|Claude|参与者|agent)|(?:Codex|Claude).{0,24}(?:来|开始|继续|参与|讨论|开发|实现|执行|梳理|评审|测试)|\b(?:ask|have|let|use|involve|assign|delegate|hand)\b.{0,48}\b(?:Codex|Claude|agents?)\b/iu;
const projectWorkRequest =
  /^(?:(?:请|帮我|我要|我想|需要|现在|先|开始|继续)\s*)*(?:开发|实现|执行|讨论|梳理|评审|测试)|^(?:please\s+)?(?:implement|develop|execute|discuss|review|test)\b/iu;
const lifecycleRequest =
  /^(?:(?:请|帮我|先|现在|直接|把它|把这个)\s*)*(?:暂停|中断|停止|停一下|继续|恢复)(?:(?:这个|当前|这场)?(?:执行|讨论|任务)|一下|吧|它|这个)?$|^(?:please\s+)?(?:pause|interrupt|stop|resume|continue)(?:\s+(?:it|this|the\s+(?:task|discussion)))?$/iu;
const requestIsExplanation =
  /^(?:(?:请|帮我|我想|我想知道|能不能|可以|只|仅|简单|please|just|only)\s*)*(?:如何|怎么|怎样|解释|说明|教我|告诉我|什么是|能否|是否可以|can\s+(?:you|this\s+tool)|what\s+is|how\s+to|explain|is\s+it\s+possible)/iu;
const capabilityQuestion =
  /^(?:(?:Claude|Codex|pi|机器人|这个工具)\s*)?(?:可以|能够|支持|能否|是否可以|可不可以|能不能).{0,64}(?:吗|么)\s*$/iu;
const requestExplanation =
  /(?:如何|怎么|怎样|解释|说明|教我|告诉我|什么是|能否|可以吗|是否可以|what\s+is|how\s+to|explain|whether|can\s+(?:you|this\s+tool)|is\s+it\s+possible)/iu;
const requestIsNonAction =
  /^(?:(?:请|先|现在|暂时|这次|我们|我|你|please)\s*)*(?:不要|别|不必|不用|无需|不需要|禁止|不能|不会|没有|尚未|还没|never\b|do\s+not\b|don't\b)|^(?:只是|只需|只要|仅需|仅仅|仅|先)?(?:讨论|解释|说明|分析).*(?:怎么|如何|能否|是否)|^(?:他说|她说|用户说|用户要求|文档说|文档提到|日志显示|之前|昨天|曾经|例如|比如|假如|如果|示例|原话|\b(?:he|she|they)\s+(?:said|asked)|\b(?:example|suppose|if)\b)|\b(?:do\s+not|don't|must\s+not|should\s+not|cannot|can't|never)\b|(?:不要|禁止|不需要).*(?:Codex|Claude|创建|拉群|建群)/iu;

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
