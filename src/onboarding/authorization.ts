import { OperationError } from "../core/errors.js";
import { object, string } from "../feishu/api.js";
import { apiHosts } from "../feishu/http.js";
import { type HTTPOptions, jsonRequest } from "./http.js";
import { hasRequiredScope, requiredScopes } from "./scopes.js";

export interface AuthorizationResult {
  state: "ready" | "required";
  missingScopes: string[];
}
const authorizationCodes = new Set([
  10005, 10014, 10015, 20002, 99991663, 99991664, 99991671, 99991672,
]);
function accepted(body: Record<string, unknown>): boolean {
  if (body.code === 0) return true;
  if (typeof body.code === "number" && authorizationCodes.has(body.code)) return false;
  throw new OperationError("authorization_response", "飞书权限检查未成功，未自动启动补授权。");
}
/** Reads current grants with a freshly acquired token; never starts a connection/login. */
export async function checkAuthorization(
  credentials: { appId: string; appSecret: string },
  options: HTTPOptions & { tasks?: boolean; brand?: "feishu" | "lark" } = {},
): Promise<AuthorizationResult> {
  if (!/^cli_[A-Za-z0-9]+$/.test(credentials.appId) || !credentials.appSecret.trim())
    return { state: "required", missingScopes: [] };
  const host = options.brand === "lark" ? "open.larksuite.com" : "open.feishu.cn";
  const tokenResult = await jsonRequest(
    `https://${host}/open-apis/auth/v3/tenant_access_token/internal`,
    apiHosts,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
    },
    options,
  );
  if (!accepted(tokenResult)) return { state: "required", missingScopes: [] };
  const token =
    string(tokenResult.tenant_access_token) || string(object(tokenResult.data).tenant_access_token);
  if (!token) throw new OperationError("authorization_response", "飞书没有返回有效的授权凭证。");
  const scopes = await jsonRequest(
    `https://${host}/open-apis/application/v6/scopes`,
    apiHosts,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    options,
  );
  if (!accepted(scopes)) return { state: "required", missingScopes: [] };
  const list = object(scopes.data).scopes;
  if (!Array.isArray(list))
    throw new OperationError("authorization_response", "飞书没有返回权限列表。");
  const granted = new Set(
    list
      .map(object)
      .filter((item) => item.scope_type === "tenant" && item.grant_status === 1)
      .map((item) => item.scope_name),
  );
  const missingScopes = requiredScopes(options.tasks ?? true).filter(
    (scope) => !hasRequiredScope(granted, scope),
  );
  return { state: missingScopes.length ? "required" : "ready", missingScopes };
}
