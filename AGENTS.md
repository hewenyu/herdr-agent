# Agent 规则

## Subagent 派活：优先 DeepSeek，必要时切换 Astra

- 向 subagent 委派任务时，优先考虑 DeepSeek。派活前通过 `list_subagent_models` 确认当前可用渠道、模型及 reasoning effort，不要猜测标识。
- 当前已确认的首选为 `provider: "opencode-go"`、`model: "deepseek-v4.1-flash"`，支持 `low`、`high`、`max` reasoning effort；应按任务难度选择。渠道信息以运行时查询结果为准。
- 只有明确判断 DeepSeek 无法胜任该任务时，才切换到 Astra。判断应有具体依据，例如任务所需能力或上下文超出模型支持范围，或实际执行后出现关键错误、未通过验收，且经合理澄清或修正仍无法满足要求；不得仅因任务看起来复杂就默认跳过 DeepSeek。若派活前已有明确的不适配依据，可直接选择 Astra，无须强制试跑。
- 当前已确认的回退为 `provider: "openai"`、`model: "gpt-6-astra"`，支持 `low`、`medium`、`high`、`xhigh`、`max` reasoning effort；切换时简要记录原因，并传递已有上下文、尝试结果和验收标准，避免重复劳动。DeepSeek 渠道不可用或持续调用失败时，也可切换 Astra，但应将其记录为可用性问题，而非能力不足。
