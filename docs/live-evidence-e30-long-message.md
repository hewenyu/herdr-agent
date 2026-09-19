# E30：真实飞书长消息分片与任务收尾

日期：2026-09-19（Asia/Shanghai）。本记录只覆盖 FSH07 的长消息分片子场景，以及为清理测试资源执行的真实完成链路。

## 运行基线

- 源码提交：`cfc7d1663c244d232fd821b701d2e98a30baae46`
- 二进制：`build/e30/herdr-agent`，版本 `0.3.12-dev`
- SHA256：`ce9bae81f9c37931d18f3dda40be6a264685679ee81680ffb460008cde56d9af`
- 运行实例：macOS arm64，PID `89471`，`serve --state-dir /Users/yueban/.herdr-agent --no-config-ui`
- `version --json`、`doctor --json`、SEA smoke 通过；飞书长连接日志为 `connection_ready`。

## 真实入口和分片结果

用户通过已登录的飞书桌面端主私聊发送创建请求，服务真实收到消息并由 pi 调用 `task_create`。本次专用资源如下（ID 仅用于关联本记录）：

- pi session：`s_2d0d2bc7…`
- 本地任务：`task_2a7d0f12…`，标题 `FSH07-LONG-E30`
- 飞书任务：`7981ee7d-102b-4b56-b8ad-e0fa890174b3`
- 任务群：`oc_dd152de4…`
- 参与者：Codex，herdr pane `w1V:p1`

用户要求 Codex 在任务群输出至少 4000 个 Unicode 字符，内容包含中文、emoji 和换行。服务完成目录信任重试、初始输入投递和 Codex 输出后，SQLite outbox 记录为 `delivered`：

| 项目 | 结果 |
| --- | --- |
| 原始输出长度 | 6108 Unicode code points |
| 分片长度 | 3500、2608 |
| 飞书 message ID 数量 | 2 |
| 飞书读回 | 两条均存在于同一任务群，顺序按 `create_time` 递增 |
| 飞书可见长度 | 第一条 3500，第二条 2608 |
| sender | 两条均为当前服务 app |
| 截断/重复 | 未发现 |
| 引用关系 | 两条 `root_id`/`parent_id` 均为空；这是参与者普通群输出，本次没有引用目标 |

真实 REST 回读确认群中的两个 message ID 与本地 outbox 一致，首片和后续片的正文边界与持久 `parts` 一致。该证据证明真实飞书端显示完整有序的长输出，并证明后续片没有误用引用目标。

## 完成和清理

用户随后在同一主私聊中确认任务完成。pi 真实调用 `task_get` 和 `task_action`，没有由程序模板伪造完成答复。最终回读：

- 本地任务 `destroyed`，参与者 `gone`。
- `task_…:p1:close`、`completion:…`、`delete-group` 操作均为 `done`。
- herdr `debug ls` 不再返回该 pane。
- 飞书任务 `completed_at=1789776633000`。
- 飞书群状态为 `dissolved`。

## 判定和边界

E30 将 FSH07 的“真实长消息分片、顺序、完整正文、outbox 送达”子项判为 **R-P**。重复 event 去重、空 `messageId` 回退、卡片重放和真实长连接断线重连仍为 U；不能因本次长分片通过而关闭整行 FSH07 或其他 B/N 场景。
