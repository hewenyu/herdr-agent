export const baseScopes = [
  "im:message",
  "im:message.p2p_msg:readonly",
  "im:message:send_as_bot",
  "im:resource",
];
export const taskScopes = [
  "task:task:write",
  "task:task:read",
  "im:chat:create",
  "im:chat:delete",
  "im:message.group_msg",
];
export const events = ["im.message.receive_v1"];
export const callbacks = ["card.action.trigger"];
export function requiredScopes(tasks = true): string[] {
  return [...baseScopes, ...(tasks ? taskScopes : [])];
}
