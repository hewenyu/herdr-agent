# E32：真实飞书手动讨论调度与通知事实

日期：2026-09-19（Asia/Shanghai）。本记录覆盖真实飞书入口创建 Claude/Codex 双参与者讨论、目录信任自动确认，以及 `discussion.mode=manual` 下的调度和生命周期通知。

## 运行基线

- 服务二进制：`dist/herdr-agent`
- 版本：`0.3.12-dev`
- 构建提交：`54aa384bfda9750889f98e82260090e8742d4c0d`
- SHA256：`31051d50964d7947efa7d3434f15933e19d0989be277de5d71523524d019e36f`
- 运行实例：macOS arm64，PID `6280`，`serve --state-dir /Users/yueban/.herdr-agent --no-config-ui`

## 修正后重启复核（2026-09-19 09:46，Asia/Shanghai）

以下是当前现场的只读复核，替换了上面的旧部署基线；旧基线和错误通知仍保留，便于追溯：

- 当前提交：`c8408612cefa7b0b194b44faad90fe26694038f0`
- 当前二进制：`0.3.12-dev`，SHA256 `3af28845f0330f7d5029e6f90d97bcf6266d27a041a02c6e82c6a4d681d281b4`
- 运行实例：macOS arm64，PID `30485`，`serve --state-dir /Users/yueban/.herdr-agent --no-config-ui`
- 当前源码完整检查：`npm run check` 通过 470/470；本次现场复核未修改现场、未发送消息、未点击审批。

现场仍未完成：任务保持 `blocked`、`groupDeleted=false`、`closeRequested=false`；Claude pane `w1W:p1` 为 `blocked`，Codex pane `w1X:p1` 显示空闲但本地 participant 为 `done`。两者 `initialSent=false`，没有 `:initial` 投递记录。两个目录信任操作均为 `confirmed=true`；Claude 仍停在普通 Bypass Permissions 选项，必须由用户在任务群选择，pi 不得代选。由于该审批尚未处理，不能声称双 marker、任务完成、群解散或 herdr pane/session 已发生。

当前 bot 可读到任务群详情仍为 `normal`，但读取群消息返回 `230002`（bot 不在群），成员列表缺少对应 scope；lark-cli 用户 token 仍缺失，因此这些远端读取限制不被解释为业务完成或失败。

## 合并提交重建后复核（2026-09-19 10:11，Asia/Shanghai）

- 合并提交：`76d30f09f3748bf169d6d2fb14d2b092743af3de`（PR #43）。
- 当前二进制：`0.3.12-dev`，构建时间 `2026-09-19T02:08:32Z`，SHA256 `7f2f1241bfcafb8689be06af4cbe2ee30685319362ee778ad10b7dd9fbaa95e2`。
- 运行实例：macOS arm64，PID `54747`，`serve --state-dir /Users/yueban/.herdr-agent --no-config-ui`。
- `npm run check` 470/470、`npm run smoke`、`version --json`、`doctor --json` 通过；运行日志显示飞书长连接已就绪。
- 重启后的只读回读仍为 `status=blocked`、`groupDeleted=false`、`closeRequested=false`；Claude `w1W:p1` 为 `blocked`，Codex `w1X:p1` 为 `done`，两者 `initialSent=false`。本次未处理群内 Claude Bypass 审批，不能声称双 marker、任务完成、群解散或 herdr pane/session 已发生。

## 真实入口和资源

用户在真实飞书主私聊中要求创建标题为 `FSH08-DUAL-E32-20260919` 的讨论任务，加入 Claude 和 Codex，并让两者分别只回复指定 marker。pi 真实调用 `task_create` 和 `task_get`，没有直接创建业务结果或伪造参与者输出。

- 本地任务：`task_f03a6cca39d2979694b90d10a4b626a6`
- 飞书任务：`2b273dc9-2055-4c80-8c0e-969002ecc710`
- 任务群：`oc_542469ab5afeeb084f1a81c73cc256f6`
- 任务模式：`manual`，最多 4 轮、60 分钟
- 参与者目录：`/Users/yueban/.herdr-agent/discussions/task_f03a6cca39d2979694b90d10a4b626a6`

Claude 和 Codex 的原生目录信任提示均由 pi 在目录与任务授权一致后自动确认，两个 `directory_trust_confirm` 操作均返回 `confirmed=true`。这只覆盖目录信任；其他审批仍通过任务群由用户选择。

## 暴露的问题

`manual` 模式创建后，任务快照显示 Claude 为 `blocked`、Codex 为 `done`，两者 `initialSent` 均为 `false`，讨论轮次为 `0`。Claude 的 Bypass 审批卡已真实发送到任务群，当前仍等待用户处理；没有自动点击普通 Bypass，也没有把 Codex 的待安排状态当成已经输出。任务和群暂未关闭，以保留用户验收现场。

旧二进制发出的等待通知却写成“后续会按要求继续推进，无需你操作”。这与 `manual` 模式和已发送的审批卡矛盾，会让用户误以为后续参与者必然自动投递。该通知判定为 **R-F**，不能用任务创建成功、群已建立或目录信任通过抵消。

## 修正和复验边界

当前分支已修正通知提示词：

- `manual` 只自动尝试首位参与者；其他参与者的 `initialSent=false` 必须明确说明等待用户或调度器安排。
- 只有 `round_robin` 在上一位参与者产生已核验输出后才允许自动转交下一位。
- 任一参与者 `blocked` 时必须说明需要用户在任务群处理审批卡。
- `welcome`、`group_ready` 只证明通知入口可用，不能承诺参与者要求已经投递或“无需操作”。

离线定向测试 12/12、`npm run lint` 和完整 `npm run check` 470/470 已通过。真实修正后的通知、用户处理 Claude 审批、Claude/Codex 两个 marker、任务完成、群解散以及对应 herdr pane 关闭，仍需在用户处理审批后继续复验；本记录在这些步骤完成前保持 **R-部分**，不把当前保留的测试群或执行器当作已清理。

## 2026-09-19 10:34 UTC 只读复核

先前“仍等待用户处理 Claude 审批”的描述只适用于当时的快照，当前 SQLite 已有后续进展：

- Claude `:p1:initial` 在 `02:55:13.930Z` 为 `done/delivered/acked=true/verified=true/attempts=1`，`initialSent=true`。`lastOutput=CLAUDE_DUAL_E32_OK`；对应群 outbox 为 `delivered`，飞书消息 ID `om_x100b65ebd76128a0b3f30ffd2903a3a`。
- Codex `initialSent=false`，没有 `:p2:initial` 操作、没有 `lastOutput`，其 `done` 只表示当前执行器状态，不能据此声称已经发言。
- 任务仍为 `review/groupDeleted=false/closeRequested=false`，结果只含 Claude marker。`manual` 模式不会自动把下一位当成已安排；仍需从真实任务群明确安排 Codex，完成双 marker 后再由用户验收和清理。
- 本次真实 `herdr agent list` 同时列出 `w1W:p1` 和 `w1X:p1`，两个测试执行目标仍保留。没有清理 E32 任务或群。
- 原服务 PID `54747` 已不存在，herdr PID `39037` 仍在；磁盘二进制仍是上述 `76d30f0` 的 `0.3.12-dev`，不能将历史 ready 记录写成当前在线证明。

本次仅从指定状态记录、磁盘版本和 herdr 只读列表核实，未发送消息、点击审批或重新查询飞书远端。不能仅凭 Claude 已输出推断普通 Bypass 审批具体由哪个入口处理；原错误通知的 R-F 不被覆盖。双参与者完整链路和收尾仍未验收。

## 2026-09-19 10:45–10:47 UTC：真实群内续调度、双输出和默认清理

本轮使用 `0.3.13-dev`，提交 `2900d8bf647a8fe2535b2157f7f0b771d0e4ef04`，构建时间 `2026-09-19T10:45:12.558486+00:00`，SHA256 `c0fe3f8f9d33f79bbd956b573996bff90a37c40fe753419611a8142cfbfdd2d0`，服务 PID `88576`。本节追加新事实，不覆盖此前未完成和错误通知的历史。

用户在真实任务群发送 `om_x100b65d230bef8a4b2525989af47849`，明确只安排尚未投递的 Codex 回复 `CODEX_DUAL_E32_OK`，不重复安排 Claude，继续保留禁止工具/编码/写文件/测试的限制。入站绑定群 pi session `s_1fd472ef-10a5-4d36-a61c-c427cc417ca4` 和当前任务。

- checkpoint `84ad46cc068b9cfe25d855f2f899bea96f61aa40c8e738830d9e33fb06d49f93` 的真实顺序为 `task_get` → `participant_send`，目标严格为 `:p2`。
- `:send:7b2cdbf119855293683b108f89441941` 在 `10:46:12.467Z` 为 `done`，`delivered/acked=true/verified=true/attempts=1`；Codex 随后 `initialSent=true`。
- Codex 输出 `CODEX_DUAL_E32_OK`，署名 outbox 在 `10:46:20.317Z` 为 `delivered`，飞书消息 `om_x100b65d2310eecb8b3206d8896b9e13`；本轮执行者通过真实飞书桌面 CUA 看到该输出。Claude 原有 marker 保留，未重新安排 Claude。
- 本轮不是 `round_robin` 自动轮转验证，而是 `manual` 讨论中用户明确指定下一位、pi 调用工具投递的验证。

用户随后在群内发送 `om_x100b65d2cf6cc4acb033c41713cd48c`，明确“双输出已在群中看到，验收通过”，并要求通过 herdr 关闭两个执行器、解散群。checkpoint `58c66c2624c063cec10c71b9e04a5501e8c574058f9a591b09f6eda2d8c83c33` 调用 `task_action complete` → `task_get`；inbox 为 `done`、turn receipt 为 `finished`，对应群回复 `om_x100b65d2cde6d4b0b245aa3f4a2adc4` 已 `delivered`，正确描述“收尾进行中，群目前还未解散”。

| 操作回执（任务 ID 前缀同上） | UTC 时间 | 结果 |
| --- | --- | --- |
| `:completion:c_fc920692e48a41b4ad310c9df0c1f4db` | `10:46:58.768Z` | `done` |
| `:p1:close` | `10:47:07.288Z` | `done` |
| `:p2:close` | `10:47:07.520Z` | `done` |
| `:delete-group` | `10:47:24.240Z` | `done` |
| 最终 task / participants | `10:47:26.103Z` / `10:47:14.860–861Z` | `destroyed/groupDeleted=true`；两者 `gone` |

本次只读 `herdr agent list` 不再包含 `w1W:p1/w1X:p1`，仅含后续 E34 的 `w1Z:p1`。本节群删除依据真实操作的持久回执及本地状态，未追加独立飞书 REST GET。双 marker 分别在 participant `lastOutput` 和群 outbox 保留；`task.result` 当前只为最后一位 Codex 的输出，不能称该字段包含完整讨论历史。

仍有 **R-F**：后台 `notice:98769a6a3e6778900ee3c1d08824a717` 在 `10:47:05.900Z` 生成“已完成收尾……任务群即将解散”，消息 `om_x100b65d2cc693ca8b1c30234591ffe5` 已发送；当时两个 close 和删群均未完成。主回合的正确回复及最终清理成功不能抵消这条错误通知。主代理正在补充通知事实护栏，修复版尚待新的真实复验。本节关闭限定的双参与者手动投递/输出/用户确认后资源清理步骤，E32 总体仍为 **R-部分**。
