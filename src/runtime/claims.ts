/**
 * Detect a model message that presents a business action as already happening
 * without a machine fact or tool result. This is a safety boundary for output
 * provenance; it never chooses a tool or generates a replacement response.
 */
export function hasUnverifiedToolClaim(text: string): boolean {
  const action = /(?:已经|正在|成功|排队|已(?:安排|创建|登记|发送|启动|转交|完成|关闭|解散|销毁))/u;
  const business =
    /(?:项目|任务|群|参与者|Codex|Claude|目录|链接|会话|session|task|chat|remoteTask|participant)/iu;
  return action.test(text) && business.test(text);
}
