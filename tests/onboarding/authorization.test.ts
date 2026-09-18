import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkAuthorization } from "../../src/onboarding/authorization.js";
import { saveCredentials } from "../../src/onboarding/credentials.js";
import { requiredEvents, requiredScopes } from "../../src/onboarding/scopes.js";

const credentials = { appId: "cli_test", appSecret: "test-secret" };
const response = (data: unknown) => new Response(JSON.stringify(data));

test("checks current secret then uses that token; only granted tenant scopes count", async () => {
  const calls: RequestInit[] = [];
  const result = await checkAuthorization(credentials, {
    fetch: async (_url, init) => {
      calls.push(init ?? {});
      if (calls.length === 1) return response({ code: 0, tenant_access_token: "new-token" });
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer new-token");
      return response({
        code: 0,
        data: {
          scopes: requiredScopes().map((scope_name, index) => ({
            scope_name,
            scope_type: index === 0 ? "user" : "tenant",
            grant_status: index === 1 ? 0 : 1,
          })),
        },
      });
    },
  });
  assert.equal(JSON.parse(String(calls[0]?.body)).app_secret, "test-secret");
  assert.equal(result.state, "required");
  assert.deepEqual(result.missingScopes, requiredScopes().slice(0, 2));
});

test("invalid secret requests auth but transient failures and invalid parameters do not", async () => {
  assert.deepEqual(
    await checkAuthorization(credentials, { fetch: async () => response({ code: 10015 }) }),
    { state: "required", missingScopes: [] },
  );
  await assert.rejects(
    checkAuthorization(credentials, {
      fetch: async () => response({ code: 10003, msg: "sensitive" }),
    }),
    { code: "authorization_response" },
  );
  await assert.rejects(
    checkAuthorization(credentials, {
      fetch: async () => {
        throw new Error("test-secret");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("test-secret"));
      return true;
    },
  );
});

test("chat status requests minimal read scope but accepts already granted official alternatives", async () => {
  assert.ok(requiredScopes().includes("im:chat:read"));
  assert.ok(!requiredScopes().includes("im:chat"));
  assert.ok(!requiredScopes(false).includes("im:chat:read"));
  assert.ok(requiredEvents().includes("im.chat.disbanded_v1"));
  assert.deepEqual(requiredEvents(false), ["im.message.receive_v1"]);
  for (const alternative of ["im:chat:read", "im:chat", "im:chat:readonly"])
    for (const valid of [true, false]) {
      const grants = requiredScopes()
        .filter((scope) => scope !== "im:chat:read")
        .map((scope_name) => ({ scope_name, scope_type: "tenant", grant_status: 1 }));
      grants.push({
        scope_name: alternative,
        scope_type: valid ? "tenant" : "user",
        grant_status: 1,
      });
      grants.push({ scope_name: alternative, scope_type: "tenant", grant_status: 0 });
      const result = await checkAuthorization(credentials, {
        fetch: async (url) =>
          response(
            String(url).endsWith("/scopes")
              ? { code: 0, data: { scopes: grants } }
              : { code: 0, tenant_access_token: "fixture-token" },
          ),
      });
      assert.deepEqual(
        result,
        valid
          ? { state: "ready", missingScopes: [] }
          : { state: "required", missingScopes: ["im:chat:read"] },
      );
    }
});

test("credentials save preserves unrelated settings, enforces app identity and private mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdr-credentials-"));
  try {
    const path = join(root, ".env");
    await writeFile(path, "OTHER_SETTING=keep\nLARK_APP_ID=cli_test\nLARK_APP_SECRET=old\n");
    await saveCredentials(root, credentials, { expectedAppId: "cli_test" });
    const content = await readFile(path, "utf8");
    assert.match(content, /OTHER_SETTING=keep/);
    assert.match(content, /FEISHU_APP_SECRET=test-secret/);
    assert.ok(!content.includes("LARK_APP_SECRET"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(saveCredentials(root, { ...credentials, appId: "cli_other" }), {
      code: "credentials_exist",
    });
    await assert.rejects(
      saveCredentials(root, { ...credentials, appSecret: "bad\nINJECTED=value" }),
      { code: "credentials_invalid" },
    );
    assert.equal(await readFile(path, "utf8"), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
