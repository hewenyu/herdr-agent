# E26：真实飞书 REST 任务与群生命周期

日期：2026-09-19（Asia/Shanghai；记录时间为 UTC `2026-09-18T19:04:43Z` 至 `19:04:51Z`）。本轮只使用当前服务应用凭据和已有允许名单中的历史真实入站 owner，运行仓库脚本 `scripts/live/feishu-lifecycle.ts --state-dir /Users/yueban/.herdr-agent`。脚本为本轮生成唯一名称的任务和群，完成后只清理自己创建的资源。

运行服务：`build/e24/herdr-agent`，版本 `0.3.12-dev`，功能提交 `3d0353627898aa38d4451983c3bcd3c94f3064b4`，PID `51905`；服务在脚本期间保持 `runtime=ready`、`authorization=ready`。脚本报告保存在 `.cache/live/feishu-lifecycle-2026-09-18T19-04-43-690Z.json`，未保存凭据。

## 已通过的真实步骤

测试资源名称为 `验收-node-pi-2026-09-18T19-04-43-690Z-REST`。

- 创建飞书任务并立即 `GET` 读回：通过。任务 GUID：`8513be9c-f34c-4b07-b925-395824f97475`。
- 创建私有任务群并 `GET` 读回：通过。群 ID：`oc_37891a8c2c8e2f3552ab409777097021`，群详情确认 `user_count=1`。
- 发送测试消息并按消息 ID 读回：通过。消息 ID：`om_x100b65ecfa28e8a4b3be14f0f466f17`，正文和 chat ID 精确匹配。
- 更新任务描述并读回：通过。
- 任务 `complete → reopen → complete-again`，每次均用任务 `GET` 核对完成状态：通过。
- 删除测试群并再次 `GET`：通过，返回 `dissolved`；群没有遗留。

服务在测试期间收到该任务的 5 个任务更新事件，均持久化为 `inbox` `done`；因为它们没有对应本地 pi 任务，没有创建新的本地任务、参与者或 outbox。测试后本地状态仍为 23 个历史任务、27 个参与者和 177 条 outbox，原有 herdr agent 现场未改变。

## 明确的权限缺口与边界

群成员列表 `GET /open-apis/im/v1/chats/{chat_id}/members` 返回飞书错误 `99991672`，要求 `im:chat:readonly`、`im:chat`、`im:chat.group_info:readonly` 或 `im:chat.members:read`。脚本因此以 `verified-with-member-scope-gap` 退出；这不是把失败吞掉，也不影响已核验的建群、发消息、任务生命周期和群解散步骤。

这条记录是服务应用通过真实飞书 REST API 的平台资源证据，不是用户从飞书私聊触发 pi 的业务验收。没有把机器人自发消息当作用户入站，也没有证明模型自主选择 `task_create`、自动建项目、herdr Claude/Codex 参与、群内确认或用户可见回执。LIVE-001、B01 的真实用户入口和 B17 tasks-disabled 入口仍保持未关闭。
