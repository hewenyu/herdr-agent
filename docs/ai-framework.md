# Go AI 框架选型

更新日期：2026-09-17。目标是在现有 Go 服务中通过连续自然语言对话调用飞书任务工具，让用户配置 API 地址、模型和 key，仅支持 OpenAI Responses 与 Anthropic Messages。

选择 **CloudWeGo Eino**，使用官方模型组件、agent 工具调用循环和原生 summarization middleware，不引入 Node.js。

| 框架 | 本次核查结果 | 对本项目的影响 |
| --- | --- | --- |
| Eino | 有原生 Responses 与 Anthropic Messages 组件、动态工具和类型化 agent；所选版本均兼容 Go 1.24 | 能复用任务管理器，适合当前两个协议和工具调用需求 |
| LangChainGo | OpenAI 常规模型适配走 Chat Completions，Anthropic 支持 Messages；本次未找到同样直接的 Responses agent 接入路径 | 需要额外适配，当前没有选它 |
| Google ADK Go | 当前 v1.7.0 要求 Go 1.25，v2.4.0 要求 Go 1.26.6；提供更完整的 agent 系统 | 会引入 Go 版本迁移，当前需求不需要这项成本 |

锁定版本：

- `github.com/cloudwego/eino v0.9.19`
- `github.com/cloudwego/eino-ext/components/model/agenticopenai v0.2.2`
- `github.com/cloudwego/eino-ext/components/model/agenticclaude v0.1.5`

使用 `agenticopenai.NewResponsesModel` 调用 `/v1/responses`，使用 `agenticclaude.New` 调用 `/v1/messages`。这两个模型组件统一使用 Eino 的 `AgenticMessage`，由类型化 `ChatModelAgent` 处理模型与工具之间的循环。普通 `components/model/openai` 的 Chat Completions 适配不是本项目的 Responses 实现。

Eino 负责模型协议与 agent 编排。本项目负责飞书身份、项目仓库映射、可用工具、任务生命周期、对话记录、操作幂等以及审批边界；不向管理任务的 AI 开放任意终端或文件工具。具体启用配置和验收步骤见 [AI 接入说明](feishu-ai-integration.md)。

## 对话与上下文职责

应用私聊处理需求讨论、追问、创建任务及总览，任务群处理绑定任务的反馈、进度和验收。普通自然语言回复
与追问保留原文，短回答能够承接此前的问题；操作结果仍由实际任务记录和本轮工具回执渲染。
历史摘要与记忆不构成新的用户授权，也不替代实时状态查询。

`ai.context_tokens` 默认 `50000`，作为包含系统提示、任务快照、对话和工具定义的输入上下文压缩阈值。
按 UTF-8/JSON 字节及结构开销保守估算，达到阈值后使用 Eino
`adk/middlewares/summarization` 的类型化 AgenticMessage 支持压缩旧上下文，保留近期问答。
输出单独保留 `4096` tokens，配置阈值需适配模型实际窗口。固定 40 条消息的静默裁剪已取消；
压缩失败保留历史，每次模型请求仍有预算保护，已发生的工具操作不因后续模型失败而自动重放。

记忆的存储和检索使用本项目的 `memory.Provider` 接口，与摘要调用的模型解耦。默认文件 provider
写入 `~/.herdr-agent/memory/`；可替换为按 scope 提供 Recall/Store/Forget 的通用 HTTP provider，
并通过 `[memory.users."ou_..."]` 为用户指定独立配置。存储密钥只读 TOML，用户覆盖不继承全局地址或密钥。
本地 `conversations/` 检查点和操作/消息回执保留本地，不转移到 HTTP provider。存储故障不会自动更换 provider。
接口协议、隔离和恢复边界见[对话与记忆设计](conversation-memory.md)。

参考官方资料：

- [Eino](https://github.com/cloudwego/eino/tree/v0.9.19)
- [Eino Responses 组件](https://github.com/cloudwego/eino-ext/tree/components/model/agenticopenai/v0.2.2/components/model/agenticopenai)
- [Eino Anthropic 组件](https://github.com/cloudwego/eino-ext/tree/components/model/agenticclaude/v0.1.5/components/model/agenticclaude)
- [LangChainGo](https://github.com/tmc/langchaingo/tree/v0.1.14)
- [Google ADK Go v1.7.0 的 Go 要求](https://github.com/google/adk-go/blob/v1.7.0/go.mod)
- [Google ADK Go v2.4.0 的 Go 要求](https://github.com/google/adk-go/blob/v2.4.0/go.mod)
