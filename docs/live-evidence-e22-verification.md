# E22：scoped npm 分发与真实 REST/模型决策复验

日期：2026-09-18。现场操作只使用本轮新建的飞书任务和群，完成后已删除群；没有修改既有任务或执行器。

## 真实飞书 REST 生命周期

证据文件：`.cache/live/feishu-lifecycle-2026-09-18T08-45-32-739Z.json`。

本轮创建了专用飞书任务 `d89695dc-dfca-4103-b0a2-e9e368b8169a`、群 `oc_16cdfb46259bff4acb33d7ea110db99f` 和消息 `om_x100b65fbedc70084b25c5ff6faa6456`。任务创建与读回、群创建与详情读回、消息发送与读回、描述更新与读回、完成、重开、再次完成均通过；随后群删除和 `chat_status=dissolved` 读回也通过。

成员列表读回明确被飞书权限拒绝（错误码 `99991672`，缺少 `im:chat.members:read` 等权限），因此只计入“群详情及 user_count 路径通过”，不把成员名单读回伪称通过。该权限缺口不影响本轮资源清理。

## 真实模型首次工具决策

证据文件：`.cache/live/e22-model-fresh-project.jsonl`、`.cache/live/e22-model-discussion.jsonl`。探针会在工具执行前拦截，不写入任务、项目、群或 herdr 资源。

- 新项目请求 3/3 次首个工具均为 `task_create`，且满足 `kind=development`、`newProject=true`、Codex 参与者和“不用测试”要求。
- Claude+Codex 讨论请求首个工具为 `task_create`，参数检查通过 `kind=discussion` 且包含两种参与者。
- 模型为 `kimi-k2.5`，provider 为 `openai-responses`。

这证明当前提示和工具选择已能驱动正确的首个业务工具，但不替代真实飞书入站到工具执行、自动建群和资源收尾的完整链路；该链路仍按 B06/B07/N02/N03 单独计账。

## scoped npm 决策

用户已明确采用 `@yuebanlaosiji/myrix`。从本次改动起，默认主包为该 scoped 名称，平台包为：

- `@yuebanlaosiji/myrix-darwin-arm64`
- `@yuebanlaosiji/myrix-linux-arm64`
- `@yuebanlaosiji/myrix-linux-x64`

安装后命令仍为 `myrix`，并保留 `herdr-agent` 兼容别名；用户可以通过 `npm install -g @yuebanlaosiji/myrix@<version>` 安装指定版本。发布配置、README、发布说明和默认包名已同步更新。已有 `v0.3.0` tag 不移动；该版本此前没有任何 npm 包成功发布，合并后使用新的 `v0.3.1` tag。

## 检查结果与未决项

当前源码 `npm run check` 通过：行数限制（220 个源码文件，最大 1000 行）、typecheck、Biome lint 和 422 项测试全部通过。`v0.3.0` 的构建和离线打包验证通过，但未 scoped 的 npm 发布因 token 权限返回 403；scoped 包改动需合并后以 `v0.3.1` 重新构建、发布、三平台无凭证安装和 GitHub Release 验证。

本记录不关闭核心验收矩阵中的未测项，尤其是完整飞书模型入站、自动目录信任、双参与者多轮讨论、异常恢复、重连和 npm 实际发布。
