import type { WebState } from "../contracts.js";

/** Browsing records never changes the runtime identity, session or delivery receipts. */
export async function state(ownerId?: string): Promise<WebState> {
  const query = ownerId ? `?${new URLSearchParams({ ownerId })}` : "";
  const response = await fetch(`/api/state${query}`, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("无法读取会话记录，请刷新重试。");
  return response.json() as Promise<WebState>;
}
