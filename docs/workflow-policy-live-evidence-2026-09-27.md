# 工作流规划与 pi 选择器：真实模型证据

2026-09-27 使用本地已配置的 `kimi-k2.5` / `openai-responses` 运行合成讨论任务。修复后的产品请求未经过探针协议覆盖，真实模型成功调用 `orchestration_plan` 和 `orchestration_decide`；后者在给定的两个合法候选中选择 `independent-analysis`。四次 HTTP 请求均返回 200。

| 运行条件 | 实际结果 | 原始证据 |
| --- | --- | --- |
| 修复前产品请求，`tool_choice: required` | 规划请求返回 HTTP 400，`invalid_request_error`，未产生工具调用 | [required-choice.json](workflow-policy-live-evidence-2026-09-27-required-choice.json) |
| 诊断覆盖：仅将工具设为 `strict: false`，仍保留 `required` | 同样返回 HTTP 400 | [non-strict.json](workflow-policy-live-evidence-2026-09-27-non-strict.json) |
| 诊断覆盖：将 `tool_choice` 改为 `auto` | 规划和候选选择均成功，四次 HTTP 200 | [auto-choice.json](workflow-policy-live-evidence-2026-09-27-auto-choice.json) |
| 修复后产品请求，无诊断覆盖，运行时间 `2026-09-27T04:24:58.327Z` | 规划和候选选择均成功，四次 HTTP 200，`runtimeProtocolUnmodified: true` | [最终实跑 JSON](workflow-policy-live-evidence-2026-09-27.json) |

修复仅移除新工作流的 `planner.ts`、`policy.ts` 对 `requireToolCall: true` 的传入。默认产品请求因此不再发送 `tool_choice: required`。通用运行时和旧业务路径保持现有行为；两个新模块仍只接受工具执行回调写入的合法结果，缺少实际工具调用时会被 `selected` 校验拒绝。此处实测结论只适用于当前配置的模型与接入服务，不能据此断言所有 Responses 服务都不支持 `required`。

复现最终产品路径：

```sh
node --import tsx scripts/live/workflow-policy-probe.ts
```

`--non-strict-tools`、`--tool-choice-auto` 仅供协议诊断，并写入带不同后缀的文件。它们不能代替无覆盖运行的产品证据。旧的 A/B 文件按当时运行结果保留；其中重复 checkpoint 是早期探针重复观察同一个终止状态，不代表额外模型请求。最终探针已对这些重复记录去重。

证据仅包含合成任务、工具名称、参数字段名、HTTP 状态及安全错误摘要、选择结果和规划产物；不包含密钥、服务地址或原始请求。该探针没有启动实际 Claude/Codex 参与者，没有调用飞书入口或发送交付消息，没有修改用户项目，也没有执行 `verify` 命令。因此它验证的是实际模型规划与受限 pi 候选选择链路，不代表整条参与者与飞书交付链路已实测通过。Jev API 的真实调用证据见 [Jev 实测记录](jev-choice-live-evidence-2026-09-27.md)。

探针自身检查：`npx biome check scripts/live/workflow-policy-probe.ts` 与 `npm run typecheck` 均通过。
