# 模型回复与消息投递验证

自然语言意图、工具选择和回复内容由模型决定。自动化测试验证上下文、工具权限、执行结果和消息投递协议，不在生产代码中添加“某句话必须调用某工具”的规则。

## 本地回归

```sh
go build ./...
go vet ./...
go test -race ./...
```

重点覆盖：确定未执行的工具校验错误允许模型纠正；执行结果未知时保留幂等保护；回复未确认完整送达时不进入模型可见的建议历史；生命周期事件由模型选择通知或静默；Codex 的实时转发与完成通知不重复发送结果；完整结果和分片确认在重启后恢复。

AI 生命周期通知在独立工作池中处理，通知模型或发送失败不会阻塞编码会话启动及初始要求投递。销毁前仍等待通知决策处理，失败保留可恢复状态。工具的 `close_decision_processed_at` 表示决策已处理，不能把模型选择静默说成已发送通知。已送达通知的历史补记独立于原发送超时和任务后续状态变化。

`internal/bridge/sdk_stream_test.go` 使用真实飞书 SDK 和本地 HTTP 服务，触发定时刷新失败、随后 `Close` 返回成功的情况，验证最终结果仍能补发。它不连接飞书服务器。

## 真实模型与隔离的 Codex 执行

真实模型验证必须显式开启。配置目录的 `config.toml` 需要有效的 `[ai]` 配置和 `api_key`；测试不会把密钥写入日志，也不会修改该配置。

```sh
HERDR_AGENT_LIVE_CONFIG="$HOME/.herdr-agent" \
HERDR_AGENT_LIVE_ARTIFACTS="$PWD/build/model-autonomy-check" \
go test ./internal/assistant \
  -run '^TestLiveConfiguredModelCreatesIndependentProjects$' -count=1 -v -timeout 10m
```

该测试把“新建鹈鹕骑车 SVG 动画项目”和“再新建宇宙飞船 SVG 动画项目”依次交给真实模型。没有预设工具调用、项目名称或回复。任务管理器使用隔离实现，项目目录位于临时目录；不会创建真实飞书任务、群或 herdr 会话。测试只要求两个明确的新建请求各自产生独立项目与任务，并保留 Codex 作为执行 agent。

增加 `HERDR_AGENT_LIVE_CODEX=1` 会将模型交给工具的任务要求交给本机 Codex CLI，在各自隔离目录中产出 `index.html`。也可以单独验证 Codex：

```sh
HERDR_AGENT_LIVE_CODEX=1 \
HERDR_AGENT_LIVE_ARTIFACTS="$PWD/build/model-autonomy-check" \
go test ./internal/assistant -run '^TestLiveCodexProducesSVG$' -count=1 -v -timeout 6m
```

Codex 保留用户配置的模型服务与 CLI 身份认证，仅为本次执行关闭 hooks，并使用 workspace-write 沙箱。不会启动网页服务或浏览器；验证器只读取生成文件。记录写到独立产物目录，普通 CI 不执行这些联网检查。未配置或认证失败必须报告为未验证，不能用模拟响应替代后宣称真实模型通过。

## 飞书现场验收

上述检查不能替代真实飞书用户消息的现场验收。部署待验收版本后，使用授权的测试用户和独立测试群完成：

1. 从主应用连续发送上述两个创建请求，确认两个项目、任务和群各自独立。
2. 等待两个 Codex 会话实际产出文件，确认最终回复全文送达，重复完成事件不重复转发。
3. 在测试环境模拟发送拒绝、超时和服务重启，确认未知结果不被当作已送达，不重放任务写操作。
4. 在对应群追加要求、查询进度，再明确验收关闭，检查任务完成与会话、群清理状态一致。

飞书服务已收到消息但客户端没有收到确认，与确认落盘前进程中断，仍属于分布式投递的不确定窗口。检查报告必须区分“已经取得并持久化确认的消息不重发”和“任意网络故障下严格只发送一次”；不能用前者测试承诺后者。
