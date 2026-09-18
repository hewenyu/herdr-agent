/** Manual real Feishu acceptance. Only resources created by this run are mutated. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { loadConfig } from "../../src/config/load.js";
import { OperationError, safeError } from "../../src/core/errors.js";
import { FeishuAPI, object, type Requester, sdkLogger, string } from "../../src/feishu/api.js";
import { FetchHttpClient } from "../../src/feishu/http.js";
import { FeishuPlatform } from "../../src/feishu/platform.js";

interface Step {
  phase: string;
  at: string;
  state: "started" | "verified" | "failed";
  resourceId?: string;
  code?: string;
  outcome?: string;
  apiCode?: number;
  message?: string;
  resourceStatus?: string;
}
async function run() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--state-dir" || !args[1]))
    throw new Error("Use --state-dir PATH");
  const config = loadConfig({ stateDir: args[1] });
  const database = new DatabaseSync(join(config.stateDir, "state.sqlite"), { readOnly: true });
  let ownerId: string;
  try {
    const row = database
      .prepare(`SELECT json_extract(value, '$.payload.ownerId') AS owner
      FROM records WHERE namespace = 'inbox'
      AND json_extract(value, '$.type') = 'message'
      AND json_extract(value, '$.payload.source') = 'feishu'
      AND json_extract(value, '$.payload.ownerId') LIKE 'ou_%'
      ORDER BY CAST(json_extract(value, '$.sequence') AS INTEGER) DESC,
      json_extract(value, '$.createdAt') DESC LIMIT 1`)
      .get() as { owner: string } | undefined;
    if (!row?.owner)
      throw new OperationError("owner_missing", "没有找到真实飞书入站用户，未创建资源。");
    ownerId = row.owner;
  } finally {
    database.close();
  }
  if (!config.feishu.allowedOpenIds.includes(ownerId))
    throw new OperationError("owner_not_allowed", "最近真实入站用户不在允许名单中，未创建资源。");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `验收-node-pi-${stamp}-REST`;
  const root = resolve(".cache/live");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `feishu-lifecycle-${stamp}.json`);
  const report: {
    name: string;
    startedAt: string;
    taskId?: string;
    chatId?: string;
    messageId?: string;
    finishedAt?: string;
    steps: Step[];
  } = {
    name,
    startedAt: new Date().toISOString(),
    steps: [],
  };
  const save = async () => {
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  };
  let lastAPIError: { code: number; message: string } | undefined;
  const safeMessage = (value: unknown) =>
    string(value)
      .replaceAll(config.feishu.appSecret, "[redacted]")
      .replace(
        /(?:tenant_access_token|app_access_token|authorization|secret)\s*[:=]\s*\S+/gi,
        "[redacted]",
      )
      .replace(/https?:\/\/\S+/g, "[url]")
      .slice(0, 300);
  const actual = new Client({
    ...config.feishu,
    logger: sdkLogger(),
    loggerLevel: LoggerLevel.warn,
    httpInstance: new FetchHttpClient(async (url, init) => {
      const response = await fetch(url, init);
      if (!response.ok) {
        try {
          const error = object(await response.clone().json());
          if (typeof error.code === "number")
            lastAPIError = { code: error.code, message: safeMessage(error.msg) };
        } catch {
          /* HTTP status remains available for non-JSON errors. */
        }
      }
      return response;
    }),
  });
  const request: Requester = async (input) => {
    lastAPIError = undefined;
    const body = await actual.request({ ...input, timeout: 15_000 });
    const fields = object(body);
    if (typeof fields.code === "number" && fields.code !== 0)
      lastAPIError = { code: fields.code, message: safeMessage(fields.msg) };
    return body;
  };
  const api = new FeishuAPI(config.feishu, request);
  // No start(), subscriptions or WebSocket: these are the project's real REST paths.
  const platform = new FeishuPlatform(config.feishu, { request });
  const step = async <T>(
    phase: string,
    action: () => Promise<T>,
    resourceId?: string,
  ): Promise<T> => {
    const entry: Step = { phase, at: new Date().toISOString(), state: "started", resourceId };
    report.steps.push(entry);
    await save();
    try {
      const result = await action();
      entry.state = "verified";
      if (string(object(result).resourceStatus))
        entry.resourceStatus = string(object(result).resourceStatus);
      if (lastAPIError) {
        entry.apiCode = lastAPIError.code;
        entry.message = lastAPIError.message;
      }
      await save();
      process.stdout.write(`${JSON.stringify(entry)}\n`);
      return result;
    } catch (error) {
      const failure = safeError(error);
      Object.assign(entry, {
        state: "failed",
        code: failure.code,
        outcome: failure.outcome,
        ...(lastAPIError
          ? { apiCode: lastAPIError.code, message: lastAPIError.message }
          : { message: failure.message }),
      });
      await save();
      process.stdout.write(`${JSON.stringify(entry)}\n`);
      throw error;
    }
  };
  const verify = (condition: unknown, code: string) => {
    if (!condition) throw new OperationError(code, "实际读取结果与验收条件不符。");
  };
  let failed = false;
  let scopeGap = false;
  try {
    const created = await step("create-task", () =>
      platform.createTask({
        title: name,
        description: "herdr-agent Node/pi 真实REST生命周期验收，仅为本轮测试资源。",
        ownerId,
        key: randomUUID(),
      }),
    );
    report.taskId = created.id;
    await save();
    await step(
      "get-task",
      async () => {
        const task = await platform.getTask(created.id);
        verify(
          task.id === created.id && (!task.completedAt || task.completedAt === "0"),
          "task_readback",
        );
      },
      created.id,
    );
    const chatId = await step("create-group-owner-only", () =>
      platform.createGroup(name, ownerId, randomUUID()),
    );
    report.chatId = chatId;
    await save();
    await step(
      "get-group",
      async () => {
        const result = await api.call({
          method: "GET",
          url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
          params: { user_id_type: "open_id" },
        });
        verify(object(result.data).name === name, "group_readback");
        verify(Number(object(result.data).user_count) === 1, "group_member_count");
      },
      chatId,
    );
    try {
      await step(
        "get-group-members-owner-only",
        async () => {
          const members: string[] = [];
          let cursor = "";
          do {
            const response = await api.call({
              method: "GET",
              url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
              params: {
                member_id_type: "open_id",
                page_size: "100",
                ...(cursor ? { page_token: cursor } : {}),
              },
            });
            const data = object(response.data);
            const items = Array.isArray(data.items) ? data.items : [];
            for (const item of items) members.push(string(object(item).member_id));
            cursor = data.has_more === true ? string(data.page_token) : "";
          } while (cursor);
          verify(members.length === 1 && members[0] === ownerId, "group_members_readback");
        },
        chatId,
      );
    } catch (error) {
      if (lastAPIError?.code === 99991672) scopeGap = true;
      else throw error;
    }
    const text = `这是 herdr-agent Node/pi 真实REST生命周期验收消息。测试名称：${name}。本群仅邀请本次请求用户；将验证任务完成、重开、再完成，随后解散本测试群，不影响原有群或任务。`;
    const messageId = await step(
      "send-test-message",
      () => platform.sendText(chatId, text, randomUUID()),
      chatId,
    );
    report.messageId = messageId;
    await save();
    await step(
      "get-test-message",
      async () => {
        const response = await api.call({
          method: "GET",
          url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        });
        const items = object(response.data).items;
        const item = Array.isArray(items) ? object(items[0]) : {};
        let content: Record<string, unknown> = {};
        try {
          content = object(JSON.parse(string(object(item.body).content)));
        } catch {
          /* fail verification */
        }
        verify(
          item.message_id === messageId && item.chat_id === chatId && content.text === text,
          "message_readback",
        );
      },
      messageId,
    );
    const description = `${name}：真实创建和消息读回已验证。${scopeGap ? "成员名单GET缺权限，群详情user_count=1已核验。" : "成员名单已读回核验。"}`;
    await step(
      "update-description",
      () => platform.updateTask(created.id, description),
      created.id,
    );
    await step(
      "get-updated-description",
      async () => {
        verify(
          (await platform.getTask(created.id)).description === description,
          "description_readback",
        );
      },
      created.id,
    );
    for (const [phase, completed] of [
      ["complete", true],
      ["reopen", false],
      ["complete-again", true],
    ] as const) {
      await step(
        phase,
        () => platform.updateTask(created.id, description, completed ? String(Date.now()) : "0"),
        created.id,
      );
      await step(
        `get-${phase}`,
        async () => {
          const task = await platform.getTask(created.id);
          verify(
            (!!task.completedAt && task.completedAt !== "0") === completed,
            "completion_readback",
          );
        },
        created.id,
      );
    }
  } catch {
    failed = true;
  }
  // Cleanup is only this run's known test group. No unknown write is replayed.
  if (report.chatId) {
    try {
      await step(
        "delete-test-group",
        () => platform.deleteGroup(report.chatId as string),
        report.chatId,
      );
      await step(
        "get-deleted-group",
        async () => {
          try {
            const result = await api.call({
              method: "GET",
              url: `/open-apis/im/v1/chats/${encodeURIComponent(report.chatId as string)}`,
            });
            if (object(result.data).chat_status === "dissolved")
              return { resourceStatus: "dissolved" };
          } catch (error) {
            if (error instanceof OperationError && error.code === "feishu_232009") {
              // API 232009 is the actual dissolved-chat response, not a generic forbidden/404.
              return { resourceStatus: "dissolved" };
            }
            throw error;
          }
          throw new OperationError(
            "group_still_readable",
            "删除后群仍可读取，不能声称已确认解散。",
          );
        },
        report.chatId,
      );
    } catch {
      failed = true;
    }
  }
  report.finishedAt = new Date().toISOString();
  await save();
  process.stdout.write(
    `${JSON.stringify({ report: path, state: failed ? "failed" : scopeGap ? "verified-with-member-scope-gap" : "verified", taskId: report.taskId, chatId: report.chatId, messageId: report.messageId })}\n`,
  );
  process.exitCode = failed || scopeGap ? 1 : 0;
}
void run().catch((error: unknown) => {
  const failure = safeError(error);
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
});
