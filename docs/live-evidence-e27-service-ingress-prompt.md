# E27：当前服务 bot 的 LIVE-001 入口提示

日期：2026-09-19（Asia/Shanghai）。本轮使用生产服务当前状态目录和同一 `FEISHU_APP_ID`，向配置的主聊天发送一次唯一验收提示，随后用同一应用读回消息；没有伪造用户消息，也没有执行任何业务工具。

## 已确认

- 生产服务：`build/e24/herdr-agent`，版本 `0.3.12-dev`，功能提交 `3d0353627898aa38d4451983c3bcd3c94f3064b4`，PID `51905`，`runtime=ready`、`authorization=ready`。
- 目标聊天：`oc_51206f1905fd3d9d445222e9ac805cc3`，即当前服务配置的 `notify_chat_id`。
- 服务应用发送消息：`om_x100b65ecad7a0ca4b3bb11178d0b35b`；应用 ID 为当前 `.env` 中的 `FEISHU_APP_ID`，正文以 `LIVE-001-R5` 开头并包含唯一 marker `LIVE-001-R5-USER-20260919`。
- 通过同一服务应用 `GET` 读回，消息 ID、chat ID、sender type=`app` 和正文均匹配。
- 发送后观察 30 秒，SQLite `inbox` 没有该 marker 的 `type=message` 用户入站；最新用户入站仍是历史记录。服务状态、项目目录和既有资源没有变化。

## 判定与边界

这证明当前服务 bot 能在正确配置的聊天中发送和读回验收提示，不能证明用户已回复，也不能证明 pi 自主选择 `task_create`、创建项目、建群或启动 Claude/Codex。此前发送到 `oc_3bb…` 的提示属于另一个 lark-cli bot 应用，已从 LIVE-001 证据中排除。

LIVE-001-R5 仍为 **U/等待真实用户入站**。收到用户原文 `LIVE-001-R5-USER-20260919` 后，必须继续核对 inbox、pi checkpoint/tool calls、项目/Git、任务、群、herdr session、用户可见回复和清理结果，不能只依据提示送达关闭场景。
