import { OperationError } from "../core/errors.js";
import type { RemoteTask } from "../core/ports.js";
import { type FeishuAPI, object, string } from "./api.js";

function remote(value: unknown, mutation: boolean): RemoteTask {
  const task = object(value);
  if (!string(task.guid))
    throw new OperationError(
      "feishu_invalid_task",
      "飞书未返回任务标识。",
      mutation ? "unknown" : "not_executed",
    );
  return {
    id: string(task.guid),
    url: string(task.url),
    description: string(task.description),
    completedAt: string(task.completed_at),
  };
}
export class FeishuResources {
  constructor(
    private readonly api: FeishuAPI,
    private readonly appId: string,
  ) {}

  async createTask(input: {
    title: string;
    description: string;
    ownerId: string;
    key: string;
  }): Promise<RemoteTask> {
    const body = await this.api.call({
      method: "POST",
      url: "/open-apis/task/v2/tasks",
      params: { user_id_type: "open_id" },
      data: {
        summary: input.title,
        description: input.description,
        client_token: input.key,
        mode: 2,
        members: [
          { id: input.ownerId, type: "user", role: "assignee" },
          { id: this.appId, type: "app", role: "assignee" },
        ],
      },
    });
    return remote(object(body.data).task, true);
  }
  async getTask(id: string): Promise<RemoteTask> {
    const body = await this.api.call({
      method: "GET",
      url: `/open-apis/task/v2/tasks/${encodeURIComponent(id)}`,
      params: { user_id_type: "open_id" },
    });
    return remote(object(body.data).task, false);
  }
  async updateTask(id: string, description: string, completedAt?: string): Promise<void> {
    const task: Record<string, unknown> = { description };
    const update_fields = ["description"];
    if (completedAt !== undefined) {
      const current = await this.getTask(id);
      const completed = (value: string) => value !== "" && value !== "0";
      if (completed(current.completedAt) !== completed(completedAt)) {
        task.completed_at = completedAt;
        update_fields.push("completed_at");
      }
    }
    await this.api.call({
      method: "PATCH",
      url: `/open-apis/task/v2/tasks/${encodeURIComponent(id)}`,
      params: { user_id_type: "open_id" },
      data: { task, update_fields },
    });
  }
  async createGroup(name: string, ownerId: string, key: string): Promise<string> {
    const body = await this.api.call({
      method: "POST",
      url: "/open-apis/im/v1/chats",
      params: { user_id_type: "open_id", uuid: key },
      data: {
        name,
        user_id_list: [ownerId],
        chat_mode: "group",
        chat_type: "private",
        group_message_type: "chat",
        external: false,
      },
    });
    const id = string(object(body.data).chat_id);
    if (!id)
      throw new OperationError("feishu_invalid_group", "建群结果未确认，缺少群标识。", "unknown");
    return id;
  }
  async deleteGroup(chatId: string): Promise<void> {
    try {
      await this.api.call({
        method: "DELETE",
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
      });
    } catch (error) {
      if (!(error instanceof OperationError) || error.code !== "feishu_232009") throw error;
    }
  }
  async getGroupStatus(chatId: string): Promise<"normal" | "dissolved"> {
    const body = await this.api.call({
      method: "GET",
      url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    });
    const status = object(body.data).chat_status;
    if (status === "normal") return "normal";
    if (status === "dissolved" || status === "dissolved_save") return "dissolved";
    throw new OperationError("feishu_group_status", "无法确认群状态，未推断群已解散。");
  }
  async subscribeTasks(): Promise<void> {
    // tenant_access_token subscribes this application's assigned tasks, including
    // those created above with the app as assignee. No user token or request body.
    const body = await this.api.call({
      method: "POST",
      url: "/open-apis/task/v2/task_v2/task_subscription",
      params: { user_id_type: "open_id" },
    });
    const result = object(body.data);
    if (result.code !== undefined && result.code !== 0)
      throw new OperationError(
        "feishu_task_subscription",
        "飞书任务更新事件订阅未确认。",
        "unknown",
      );
  }
}
