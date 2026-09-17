import type { WebActionResult, WebState } from "../contracts.js";

export type Action = (
  name: string,
  input: Record<string, unknown>,
) => Promise<WebActionResult | undefined>;

export async function state(): Promise<WebState> {
  const response = await fetch("/api/state", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error("无法读取本机状态");
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
    throw new Error("网络中断，操作结果未知。请刷新状态核对，勿重复提交。");
  }
  const body = (await response.json()) as {
    ok?: boolean;
    result?: WebActionResult;
    error?: { message?: string; outcome?: string };
  };
  if (!response.ok || !body.ok) {
    const suffix =
      body.error?.outcome === "unknown"
        ? " 操作可能已经发生；请先核对任务和执行现场，不要自动重试。"
        : "";
    throw new Error((body.error?.message ?? "操作未完成") + suffix);
  }
  return body.result ?? {};
}
