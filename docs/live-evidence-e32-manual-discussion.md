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
