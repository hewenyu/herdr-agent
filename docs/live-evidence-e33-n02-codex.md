# E33：N02 无项目单 Codex 讨论及完成回执缺陷

日期：2026-09-19。业务操作发生在 `03:15–03:18 UTC`（`11:15–11:18 Asia/Shanghai`）；本次只读复核为 `10:34 UTC`。只读复核没有发送消息、修改状态库或重启服务。

## 基线和证据边界

- 当次部署记录及当前磁盘二进制一致：`0.3.12-dev`，提交 `76d30f09f3748bf169d6d2fb14d2b092743af3de`，构建时间 `2026-09-19T02:08:32Z`，SHA256 `7f2f1241bfcafb8689be06af4cbe2ee30685319362ee778ad10b7dd9fbaa95e2`。
- 本次复核时原服务 PID `54747` 已不存在；herdr PID `39037` 仍在。磁盘版本和历史部署记录不能证明当前服务仍运行。
- 原始业务证据位于本机 `/Users/yueban/.herdr-agent/state.sqlite` 的 `inbox`、`pi_checkpoints`、`operations`、`participants`、`tasks`、`outbox` 和 `turn_receipts`。仅使用 SQLite 只读连接抽取指定测试任务。
- 本次复核未重新调用飞书 REST；群删除、投递等以下按已持久化的真实调用回执描述，不能冒充本次远端 GET。

## 真实入口和创建

用户通过真实飞书主私聊要求创建 `MYRIX-N02-CODEX-20260919`：无项目、仅 Codex，精确回复 `MYRIX_N02_OK_20260919`，禁止工具、编码、写文件和测试，创建任务及群，输出后等待用户验收。

| 证据 | 标识 / 结果 |
| --- | --- |
| owner / 主私聊 | `ou_1ee7c31ffa60b713b6db53cecf533d58` / `oc_51206f1905fd3d9d445222e9ac805cc3` |
| pi session | `s_26c0b10c-8999-411d-939a-ecd6b768dbc7` |
| 创建入站 | `message:om_x100b65ebaa77c0a4b27fcef92868415`，`source=feishu/chatType=private/state=done` |
| 创建 checkpoint | `e1a033d56103db73683e3855476f3fa0fea386b9715f5a1b5366d5c600b12531` |
| 真实工具顺序 | `task_create` → `task_get`；`kind=discussion`，单 Codex，`createGroup/createRemoteTask=true` |
| 本地任务 | `task_c68bc7be401707f3fc15c64f77b2ab45` |
| 飞书任务 / 群 | `7aaf6fa0-77b9-404f-a615-29eae8ade607` / `oc_34e86aded65d967203e571ab2710ab03` |
| herdr 目标 | `w1Y:p1`；Codex session `01a0b7a9-fd41-70e3-a5cc-31eb3ac543d0` |

`:remote` 操作在 `03:15:38.115Z`、`:group` 在 `03:15:39.051Z` 均为 `done`。任务使用独立讨论目录，不关联项目源码。创建答复同时写“初始要求的投递尚未确认”和“已完整转交限制”，后一句不能被当作初始输入已送达的事实，保留为事实措辞问题。

## 初始输入、目录信任和输出

- `:p1:directory-trust:221` 为 `failed/stale_guard/not_executed`，没有执行陈旧现场的确认；随后 `:p1:directory-trust:222` 在 `03:16:09.553Z` 为 `done/confirmed=true`。
- `:p1:initial` 在 `03:16:24.414Z` 为 `done`，`status=delivered/acked=true/verified=true/attempts=1`，receipt 为 `HERDR_RECEIPT_0f97461308e24f12ba2eb8132d663a15`。
- Codex 原生 transcript `~/.codex/sessions/2026/09/19/rollout-2026-09-19T11-16-06-01a0b7a9-fd41-70e3-a5cc-31eb3ac543d0.jsonl` 只有一条 assistant 输出，正文严格为指定 marker；`function_call/custom_tool_call` 数为零。该样本验证受控回复的禁止开发约束，不代表真实需求分析质量。
- 群 outbox `output:task_c68bc7be401707f3fc15c64f77b2ab45:task_c68bc7be401707f3fc15c64f77b2ab45:p1:74afbc40d1dcdaa433984072ba54b1ec` 为 `delivered`，正文为 `Codex (codex)：\nMYRIX_N02_OK_20260919`，飞书消息 `om_x100b65eba75608a0b14f6c9c1ba8b30`。
- 随后 review 通知说明当前为手动调度，继续或添加参与者需要安排；此处没有声称 Codex 已自动验收或自动收尾。

## 用户完成确认、真实清理与错误回执

用户通过主私聊明确确认该任务完成，并要求按默认策略关闭 Codex/herdr 和任务群。入站为 `om_x100b65eba5b9f8a8b16d953ac5927e7`，checkpoint 为 `52a139aab025fa3d3d0b40f33c77405de820985d698d4bcad797da5344793a9b`。

必须同时保留成功副作用和错误回执：

1. 模型首次把之前的标记文本当成 task ID，`task_action complete` 返回 `task_missing/not_executed`。
2. 模型随后调用 `tasks_list` 得到真实 ID，再调用正确的 `task_action complete` 和多次 `task_get`。
3. `:completion:c_22daa73de1614ca5bd5526dcc86bd2ef` 在 `03:17:26.167Z` 为 `done`；`:p1:close` 在 `03:17:33.517Z` 为 `done`；`:delete-group` 在 `03:17:39.329Z` 为 `done`。
4. 当前本地任务为 `destroyed/groupDeleted=true/closeRequested=true`，`completedAt=1789787844000`；参与者为 `gone/initialSent=true`。本次真实 `herdr agent list` 不再含 `w1Y:p1`，仍保留 E32 两个目标，未误清其他任务。
5. 结果和两条收尾通知 outbox 均为 `delivered`；其中 `notice:241c5de9555e6f5ba8fcd9851f5d4b76` 在删群前写“已完成收尾，群即将……解散”，仍有收尾完成措辞过早问题。
6. 完成请求的 inbox 和 `turn_receipts` **最终为 failed**。错误为 `model_failed`，正文“pi 调度模型调用的工具未执行，本轮业务未执行；请重试。”，与同一轮后续真实清理矛盾。checkpoint 的两段成功答复未变成对应持久 assistant 回复，不能声称主私聊已收到成功回执。

因此 N02/B06/B07/B10/B12/B13 仅补 **R-部分**：无项目、单 Codex、受控禁止开发、真实入站建任务建群、初始输入、署名输出和用户确认后的资源清理有证据。完成回合的错误判定及通知事实保留 **R-F**，不得以最终清理成功覆盖。已有项目、单 Claude、实际需求讨论、多参与者与其他异常/恢复组合继续分验。E30 的长输出和默认收尾证据独立保留。
