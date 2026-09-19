# E34：真实业务请求与投递事实恢复

日期：2026-09-19。以下时间均为 UTC。本记录按时间保留创建事实恢复、普通审批阻塞及后续输出/验收/清理证据；最后一节为最新状态，早期待验快照不代表当前仍阻塞。

## 运行版本与资源

- macOS arm64 SEA：`0.3.13-dev`，提交 `2900d8bf647a8fe2535b2157f7f0b771d0e4ef04`。
- 构建时间：`2026-09-19T10:45:12.558486+00:00`；SHA256：`c0fe3f8f9d33f79bbd956b573996bff90a37c40fe753419611a8142cfbfdd2d0`；服务 PID `88576` 在本次只读复核时存在。
- owner：`ou_1ee7c31ffa60b713b6db53cecf533d58`；主私聊：`oc_51206f1905fd3d9d445222e9ac805cc3`；pi session：`s_26c0b10c-8999-411d-939a-ecd6b768dbc7`。
- 本地任务：`task_7242cd5dd7032227ea0c82a1867e1cab`；标题：`MYRIX-E34-INTENT-20260919`。
- 飞书任务：`a978e77e-31d4-4887-9955-e103ad8928d0`；任务群：`oc_baeb29f026e40681bf97f8e19e171a18`。
- Codex 目标：`w1Z:p1`；receipt：`HERDR_RECEIPT_06e90c2d311740399803bc8a14d35bb5`。

## 真实输入与恢复链路

真实主私聊消息 `om_x100b65d2cdc5b4a8b048eab27fd1e96`：

> 让 Codex 讨论这个需求，作为新的无项目讨论任务，标题 MYRIX-E34-INTENT-20260919，只有一名 Codex。需求是核对受控讨论：Codex 只回复 MYRIX_E34_OK，不调用任何工具、不编码、不写文件、不运行测试。请建立专属飞书任务和群；输出后等待我验收。

inbox 于 `10:47:13.109Z` 入队，最终 `done`。checkpoint `681df9498cd18830d260d956a8c2916af4db6d72fda70d0bd8175370f3df24ae` 保留以下完整顺序：

1. `task_create` 创建 `discussion`，仅一名 Codex，保留完整限制；返回 `accepted=true/task.status=queued`。此时本地登记不证明远端资源或初始投递成功。
2. `task_get` 已读到远端任务 ID 和群 ID，任务 `starting`，参与者 `pending/started=false/initialSent=false`。真实 `:remote`、`:group` 操作分别于 `10:47:25.509Z` 和 `10:47:26.447Z` 为 `done`。
3. 模型第一段草稿虽然承认投递未确认，仍写“已完整转交限制”。运行时未把这段草稿写入回复 outbox，而是追加事实恢复指令：accepted/queued 只证明登记，remoteTaskId/chatId 对应远端对象，initialSent 或 verified 投递回执才证明已转交；已有登记不得重复创建。
4. 模型再次调用 `task_get`，读到相同的未投递快照，改为“限制已随任务完整登记”“尚不能说要求已转交给 Codex”，也明确当前没有 marker。整轮只调用一次 `task_create`，未因恢复重复创建任务。
5. 最终 `turn_receipts.status=finished`，唯一回复 outbox `reply_681df9498cd18830d260d956a8c2916af4db6d72fda70d0bd8175370f3df24ae` 为 `delivered`，远端消息 `om_x100b65d2cb8fb4a8b31c8532838a2f4`；本轮执行者通过真实飞书桌面 CUA 看到的是恢复后的答复。

本记录提供真实模型产生矛盾声称后、程序触发只读恢复、最终发送有事实依据答复的证据。该用户输入包含完整任务请求，不能用单一样本声称所有口语表达的意图检测已真实覆盖。恢复回复仍较长且包含 `starting/initialSent` 等诊断术语，不能算用户可见回复简洁性已全部验收。

## 普通菜单审批与未完成边界

截至 `10:53 UTC` 的状态库回读，任务 `blocked/groupDeleted=false/closeRequested=false`；Codex `started=true/initialSent=false`，无输出，也无 `:p1:initial` 操作。本轮执行者在真实界面观察到 Codex 版本更新菜单，属于普通选择，不能按新目录信任代为自动确认。

审批 `approval_831411b7eb4e445794f7124c33be28ff` 绑定 `w1Z:p1/stateSeq=229`，`publication=sent/consumed=false`，群卡片消息 `om_x100b65d2cbfdb0a0b29d6e6539cc4b4`，允许键为 `1/2/3/esc`，有效期至 `10:57:46.654Z`。用户已被请求在任务群选择 Skip；本次文档复核没有点击菜单、发送消息或清理任务。后续必须重新检查卡片是否有效，不能凭本记录重复使用已过期审批。

只读 `herdr agent list` 当时列出该目标为 `idle/interactive_ready=true`，本地 participant 仍为 `blocked`；两种状态都不能证明业务初始输入已送达或 marker 已输出，仍以真实投递和输出回执验收。

另外保留通知措辞问题：`notice:72dcc27b0a35ac510557b3bcfb16ec14` 对这个只有一位参与者的任务写“之后会自动转交下一位参与者”，消息 `om_x100b65d2ca61f8a4b115e98c3ea0003` 已发送。不能据此推断存在第二位参与者或继续扩展任务。本轮主私聊事实恢复通过，不代表所有后台通知均正确；E32 收尾通知的独立 R-F 也继续保留。

该时点结论为 **R-部分**：真实入站、创建与查询、虚假投递声称恢复、最终回复送达已有证据；普通菜单用户确认、Codex marker、验收完成和资源清理当时未通过。E33 的“同轮先失败后成功仍误报未执行”当时需要单独真实复验，本轮创建恢复不能替它关闭。后续实际结果见下节。

## 通知护栏追加修正与最终部署

E32 再次提前报告收尾后，新增基于服务端任务/参与者快照的通知校验。模型负责选择是否通知及生成正文；若正文声称群已解散、执行器已关闭或全部收尾完成而缺少对应事实，最多要求模型重新生成一次。再次不符则记为通知生成失败，不发送错误正文；已经授权的清理仍遵守原有通知失败、未知投递和最后结果屏障。

真实模型加合成快照探针曾暴露任务标题 `受控收尾通知验证` 被误识别为收尾声明的问题：两次准确正文均被拒绝，保留 `.cache/live/e34-notice-model-probe-detail.json`。后续按可信标题的精确引号引用隔离标题文字，并保留标题后真实断言的校验。修正后探针于 `10:57:18.355Z` 返回“任务已完成……该群即将解散但尚未执行”，校验通过；证据为 `.cache/live/e34-notice-model-probe-fixed.json`。这些探针未发送消息或改变外部资源，不能代替生产清理通知验收。

最终部署（后续文档提交不改变此功能构建）：

- 功能提交：`0b3c457d308b1b0bc18a485991665f903118446c`。
- 版本：`0.3.13-dev`；构建时间：`2026-09-19T10:57:57.361Z`。
- 二进制：`build/e34-final/herdr-agent`，`dist/herdr-agent` 为相同产物。
- SHA256：`8cf504cc1d3966b25a5beb29e25cd506f62bae0c5a2d1774e1cba6b69906d42d`。
- 新服务 PID：`98996`；旧 PID88576 在确认无正在处理的 inbox 后通过 SIGTERM 正常退出；herdr PID39037 未重启。
- `npm run format`、`npm run check`（557/557）、独立 SEA smoke 均通过。
- `version --json`、进程路径和 `10:58:42.375Z` 的 `feishu.connection_ready` 已回读。

该部署时点 E34 仍等待用户在真实群处理普通更新菜单。服务重启不代替审批，也不清理未完成验收的任务。原有审批卡可能过期，须使用群里的当前卡片。该时点生产通知、输出及完成收尾尚未验收；后续实际验收结果见下节，完整目标仍 active。

最终生产应用 REST 只读回读（`11:00:58.323Z`）：E32 飞书任务 `completedAt=1789814817000`、群 `dissolved`；E34 飞书任务 `completedAt=0`、群 `normal`。同期真实 herdr agent list 仅保留 E34 的 `w1Z:p1`，E32 `w1W:p1/w1X:p1` 均不在列表。原始结果存于 `.cache/live/e34-remote-readback.json`，此读取没有修改外部状态。

## 11:00–11:05 UTC：用户审批、受控输出和错误编号恢复完成

后续版本为 `0.3.13-dev`，提交 `0b3c457d308b1b0bc18a485991665f903118446c`，构建时间 `2026-09-19T10:57:57.361Z`，SHA256 `8cf504cc1d3966b25a5beb29e25cd506f62bae0c5a2d1774e1cba6b69906d42d`，服务 PID `98996`。以下更新先前待验快照；原草稿错误、单参与者通知及此前阻塞记录保留。

用户已在真实任务群处理普通审批。`action:16eeada1aa7681f496c782b4752b24ea` 于 `11:00:37.995Z` 入队、`11:00:43.266Z` 为 `done`，绑定该任务群、当前 owner 和新卡片 `om_x100b65d2e47d40a4b2e96e4ac6fc122`，提交键 `3`。使用的是新 nonce `approval_50c4d53a20d24d66a77f7ebff054d4d7`，不能将早前已过期 nonce 当作本次点击对象。

随后 `:p1:directory-trust:230` 于 `11:00:59.991Z` 为 `done/confirmed=true`；`:p1:initial` 于 `11:01:08.050Z` 为 `done/delivered/acked=true/verified=true/attempts=1`。群输出 outbox 于 `11:01:13.602Z` 为 `delivered`，正文为 `Codex (codex)：\nMYRIX_E34_OK`，消息 `om_x100b65d2f95a54a0b483883d80ac708`，本轮执行者通过真实飞书桌面 CUA 看到输出。

用户随后在真实主私聊发送完成确认，并明确要求先试一个不存在的测试 task ID，取得明确未执行后再查询并完成真实 E34 任务，以复验 E33 的同轮失败后恢复。入站消息 `om_x100b65d28d1478a4b39a4b7a960acc9` 于 `11:04:30.228Z` 创建，最终 `11:04:59.238Z` 为 `done`。

checkpoint `11fc132ca13fccb1d59df773030cbb5e0189c52d6ba755974dd7eb578b191f94` 的工具顺序为：

1. 对不存在的编号调用 `task_action complete`，得到 `task_missing/outcome=not_executed`。
2. `tasks_list` 找到真实 E34 任务、review 状态和 marker。
3. 对 `task_7242cd5dd7032227ea0c82a1867e1cab` 调用 `task_action complete`，返回 `completed/groupDeleted=false`。
4. 最终答复正确区分“已确认完成”和“资源收尾进行中”，没有把首个明确失败判成整轮未执行；turn receipt 为 `finished`，回复 outbox `reply_11fc132ca13fccb1d59df773030cbb5e0189c52d6ba755974dd7eb578b191f94` 为 `delivered`，消息 `om_x100b65d28b7c40a0b14f7a084141f8a`。

| 后台操作 / 状态 | UTC 时间 | 结果 |
| --- | --- | --- |
| `:completion:c_e23a9b3a2e3f477fae5a74e95ac2bb17` | `11:04:50.312Z` | `done` |
| `:p1:close` | `11:05:15.426Z` | `done`；participant `gone` |
| `:delete-group` | `11:05:30.718Z` | `done` |
| task | `11:05:32.050Z` | `destroyed/groupDeleted=true/closeRequested=true` |
| 真实 herdr agent list | 清理后只读回读 | `agents=[]`，E34 目标不再存在 |

最终真实生产应用 REST 回读保存在 `.cache/live/e34-remote-completion.json`，时间为 `11:07:18.948Z`：任务 `completedAt=1789815888000`，群 `dissolved`，与本地和 herdr 回执一致。Codex 原生 transcript `~/.codex/sessions/2026/09/19/rollout-2026-09-19T19-00-56-01a0b953-9033-7450-979c-8fe8910e22c0.jsonl` 的本轮只读检查为零工具调用、assistant 仅输出 `MYRIX_E34_OK`。本轮关闭普通审批、目录信任、初始投递、marker、用户验收和清理的限定步骤，并独立提供 E33 类“明确失败后正确写工具恢复”的真实通过证据；E33 原失败历史不删除。

通知验收仍未完全通过：`task_close_notice` 于 `11:05:15.197Z`、`task_group_delete_notice` 于 `11:05:29.765Z` 均记录 `unavailable/reason=generation_failed/errorCode=notice_fact_missing`，没有对应收尾通知 outbox。校验未通过的候选通知被拒，随后按已有规则继续授权清理；由于被拒正文未持久化，不能判断候选一定有错，也不能排除误判。隔离真实模型重建相同阶段的两条 probe 均通过（`.cache/live/e34-live-stage-model-probe.json`），不替代生产候选审计或真实送达。整体仍为 **R-部分**，正常收尾通知生成/送达与其他业务组合继续验收。
