import type { WebActionResult, WebState } from "../contracts.js";

export type Action = (
  name: string,
  input: Record<string, unknown>,
) => Promise<WebActionResult | undefined>;

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

export async function dispatch(
  action: string,
  input: Record<string, unknown>,
): Promise<WebActionResult> {
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";
  let response: Response;
  try {
    response = await fetch("/api/actions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ action, input }),
    });
  } catch {
    throw new Error("网络中断，配置结果未知。请刷新状态核对，不要重复提交。");
  }
  const body = (await response.json()) as {
    ok?: boolean;
    result?: WebActionResult;
    error?: { message?: string; outcome?: string };
  };
  if (!response.ok || !body.ok)
    throw new Error(body.error?.message ?? "配置未完成，请刷新后重试。");
  return body.result ?? {};
}
