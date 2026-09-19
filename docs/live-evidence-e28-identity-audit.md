# E28：生产飞书身份与只读验收边界

日期：2026-09-19（Asia/Shanghai）。本轮只执行身份状态与生产应用的只读请求；没有发消息、建任务、建群、更新任务或解散群聊。

## 身份证据

- 当前 `lark-cli` 配置使用的应用是 `cli_a97a042adcb8dbd5`。`lark-cli auth status --json --verify` 显示 bot ready，user identity 缺少 token，用户标识为 `ou_789ef988acd27b4e9392d15c0da52cb5`。`lark-cli auth check` 返回 `no_token`。
- 生产服务状态目录 `.env` 使用的应用是 `cli_aaf4647d33f95be8`，与 `lark-cli` 应用不同。服务配置允许 `ou_a90a043a4d5ada881180931d822651db` 与 `ou_1ee7c31ffa60b713b6db53cecf533d58`。
- 生产 SQLite 的真实飞书入站记录均由 `ou_1ee7c31ffa60b713b6db53cecf533d58` 发出；其中配置的主聊天 `oc_51206f1905fd3d9d445222e9ac805cc3` 有 30 条私聊入站记录。这证明生产服务实际收到过用户事件，但不能把 `lark-cli` 当前 user 身份当作该用户的回放身份。

## 生产应用只读回读

使用生产应用自身的 tenant token（凭据未写入本文）确认：

- `/bot/v3/info` 返回 HTTP 200，应用机器人 open_id 为 `ou_e0cb93d1eb7ce6f6e6bcb11f803aabf2`，名称为 `herdr-agent-e1`。
- `GET /im/v1/chats` 返回当前 E32 专用群 `oc_542469ab5afeeb084f1a81c73cc256f6`；该群详情为 `normal`、`bot_count=1`、`user_count=1`。
- `GET /im/v1/chats/oc_51206f1905fd3d9d445222e9ac805cc3` 成功，主聊天为 `normal`，owner 为 `ou_1ee7c31ffa60b713b6db53cecf533d58`。
- `GET /task/v2/tasks/2b273dc9-2055-4c80-8c0e-969002ecc710` 成功，标题为 `FSH08-DUAL-E32-20260919`，`completed_at=0`，成员是该用户与生产应用。
- `GET /im/v1/messages` 在主聊天和 E32 群均返回 HTTP 200；主聊天最近记录同时包含生产应用 `cli_aaf...` 与用户 `ou_1ee...` 的消息，说明服务应用可以回读消息元数据。
- E32 群当前回读 14 条消息，发送者为系统或生产应用，没有用户消息；这只能说明群可读，不能证明 Claude/Codex 已完成或用户已处理审批。
- 成员明细读取返回 HTTP 400/code `99991672`，生产应用身份缺少 `im:chat:readonly`、`im:chat.group_info:readonly` 或 `im:chat.members:read` 等任一权限。因此 `user_count`/`bot_count` 不能扩张为成员明细证据。

## 验收边界

LIVE-001 及真实用户入口复验应由用户直接在生产服务的飞书私聊中发送唯一 marker，再核对服务 inbox、pi checkpoint/tool call、项目、任务、群、参与者、模型结果和清理。若要用 CLI 读取该入口，必须先由用户为生产应用和 `ou_1ee...` 完成 user-access-token 授权。本轮未完成用户授权；曾误启动的 device flow 属于另一套 `lark-cli` 应用，未用于生产入口，也没有把另一个应用的 bot 消息当作用户入站。

当前证据只支持“生产应用凭据可读任务/群状态、真实用户事件曾到达”，不支持将 B01–B18/N01–N07 或 LIVE-001 标记为完整真实验收通过。
