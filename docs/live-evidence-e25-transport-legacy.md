# E25：飞书长连接故障恢复与旧桥路由校验

日期：2026-09-19（Asia/Shanghai）。本轮修复来自代码审查和注入式组件回归；没有主动断开生产飞书连接，也没有把服务组件测试写成真实用户入口验收。

## 飞书连接故障

`FeishuPlatform.start()` 原本只等待第一次 `onReady`。连接 ready 后，SDK 在自动重连耗尽时调用 `onError`，平台只记录日志；服务仍保持 `ready`，不会停止旧连接、重新检查授权或重新订阅任务。

现在 `PlatformPort.start` 接受可选的 terminal failure 回调。初次握手失败仍拒绝 `start`；ready 后每代连接只通知一次故障。`authorize` 收到故障后停止旧平台，把运行状态置为等待并使用原有退避重试；重试重新执行 herdr 检查、飞书授权检查、连接和任务订阅。全局 shutdown 取消重试，旧 generation 的迟到事件被丢弃。

回归覆盖：

- ready 后连续两次 `onError` 只通知一次，停止后迟到错误不再通知；
- CLI 在运行中断线后停止旧平台、等待 retry、重新连接并在第二次连接后才开始 tick；
- 初次握手超时、订阅失败、服务停止和 abort 的既有边界保持通过。

## 旧兼容桥路由

`tasks.enabled=false` 时的 `/ls`、`/card`、`/say`、`/stop`、`/mirror`、`/close` 仍属于已有 agent 兼容路径。修复了两项路由风险：回复消息的 `replyToMessageId` 优先于正文中指定的 pane；持久化的 `ExecutionRef` 每次投递前重新读取 herdr，并精确核对 pane、workspace、kind、cwd 和 session，替换后的 pane/session 会拒绝投递。新增回归验证显式 pane 不能覆盖回复绑定，旧 route 在 session 替换后不会发送。

## 验证与边界

本轮最终 `npm run check` 为 **457/457**，包含 224 个手写文件的 1000 行限制、TypeScript、Biome 格式/lint 和全部测试。定向 Feishu/CLI/旧桥回归共 31 项通过，旧桥专项 6 项通过。

这些是本地注入式连接和真实 herdr 兼容路径的证据。尚未在生产中人为制造网络中断，也尚未完成真实飞书用户私聊 `LIVE-001-R5`；B02、B17 和其余 B/N 行仍按现场矩阵的原状态记录。
