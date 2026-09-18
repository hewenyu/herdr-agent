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
  "im:chat:read",
  "im:message.group_msg",
];
export const events = [
  "im.message.receive_v1",
  "im.chat.disbanded_v1",
  "task.task.update_user_access_v2",
];
export const callbacks = ["card.action.trigger"];
export function requiredEvents(tasks = true): string[] {
  return tasks ? events : ["im.message.receive_v1"];
}
export function requiredScopes(tasks = true): string[] {
  return [...baseScopes, ...(tasks ? taskScopes : [])];
}

/** Chat GET and disbanded events accept any one of these official permission alternatives. */
export function hasRequiredScope(granted: ReadonlySet<unknown>, scope: string): boolean {
  return (
    granted.has(scope) ||
    (scope === "im:chat:read" &&
      ["im:chat", "im:chat:readonly"].some((alternative) => granted.has(alternative)))
  );
}
