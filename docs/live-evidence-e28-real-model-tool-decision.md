# E28：当前模型首步工具选择复验

日期：2026-09-19（Asia/Shanghai）。运行仓库脚本 `scripts/live/model-probe.ts --state-dir /Users/yueban/.herdr-agent --only fresh-project`，使用当前配置的 OpenAI Responses 模型 `kimi-k2.5`。探针为只读决策复验：在任何工具实现执行前拦截，所有服务、项目、飞书和 herdr 写操作都没有发生。

## 结果

输入为“创建一个新项目，交给 Codex 开发一个 HTML SVG 双人比武，不用测试。”，连续三次结果均为：

| attempt | 首个工具 | 参数检查 | 判定 |
| ---: | --- | --- | --- |
| 1 | `task_create` | `kind=development`、`newProject=true`、包含 Codex、requirements 保留“不用测试” | 通过 |
| 2 | `task_create` | 同上 | 通过 |
| 3 | `task_create` | 同上 | 通过 |

每次记录均为 `direct_tool_intercepted`；探针没有调用真实工具实现，因此不能证明项目目录、Git、飞书任务/群或 herdr 执行器已经创建。

## 边界

这条证据说明当前真实模型在隔离首步决策中没有复现历史“零工具调用却声称已安排”的问题。它不关闭 LIVE-001，也不替代真实飞书用户入站；完整验收仍需核对当前服务收到用户消息后的 pi checkpoint、实际写工具回执、项目/Git、任务群、参与者、用户可见结果和清理。
