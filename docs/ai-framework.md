# Go AI 框架选型

核查日期：2026-09-16。目标是在现有 Go 服务中通过自然语言调用飞书任务工具，让用户配置 API 地址、模型和 key，仅支持 OpenAI Responses 与 Anthropic Messages。

选择 **CloudWeGo Eino**，使用官方模型组件和 agent 工具调用循环，不引入 Node.js。

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

参考官方资料：

- [Eino](https://github.com/cloudwego/eino/tree/v0.9.19)
- [Eino Responses 组件](https://github.com/cloudwego/eino-ext/tree/components/model/agenticopenai/v0.2.2/components/model/agenticopenai)
- [Eino Anthropic 组件](https://github.com/cloudwego/eino-ext/tree/components/model/agenticclaude/v0.1.5/components/model/agenticclaude)
- [LangChainGo](https://github.com/tmc/langchaingo/tree/v0.1.14)
- [Google ADK Go v1.7.0 的 Go 要求](https://github.com/google/adk-go/blob/v1.7.0/go.mod)
- [Google ADK Go v2.4.0 的 Go 要求](https://github.com/google/adk-go/blob/v2.4.0/go.mod)
