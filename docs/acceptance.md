# Node + pi 验收与场景映射

日期：2026-09-18。本文对照 [需求盘点](node-pi-refactor-requirements.md) 的 B01–B18 / N01–N07；默认产品选择见 [设计](node-pi-design.md)，目标状态见 [refactor-goal.md](refactor-goal.md)。表格中的“已测”指离线自动化，不表示在真实飞书、herdr 或模型服务上完成端到端验收。

## 当前证据

- 最终源码已执行 `npm ci`（152 个包）、`npm run format`（152 个文件，无修改）和 `npm run check`：157 个源码文件均不超过 1000 行，严格 TypeScript 与 Biome 通过，170 项测试通过，0 失败、取消、跳过或待办。测试包含真实 pi 循环配合本地模型协议替身、真实 SQLite/flock/Git、飞书 SDK 事件分派、临时 Unix socket/HTTP 和文件样例。
- `npm audit`：0 项漏洞；`git diff --check` 通过。
- 最终源码已实际完成 macOS arm64 `npm run binary`、`npm run smoke`：复制单个可执行文件到新临时目录，在没有源码/node_modules 的位置验证 help、version、原生锁拒绝重复实例、SQLite、嵌入页面/JS/CSS、状态 API、CSRF 和退出；另用 loopback OpenAI Responses / Anthropic SSE fixture 验证二进制内真实 pi、调度工具 schema、Web 答复和 ACK 后 delivered。本地产物为 `dev` 构建标记，未发布远端 release。
- 已用 Playwright headless Chromium 对隔离 fake backend 做真实浏览器 QA：四页、创建 session、发送聊天及 ACK 后数据库 delivered；390px 移动宽度没有横向溢出，零 pageerror。已人工查看 `.cache/web-{sessions,tasks,projects,settings,mobile}.png`；这些是本轮本地证据，不是生产飞书验收。
- 许可证生成已针对实际 bundle 产出 62 个去重 npm 包及 Node 24.13.0 的原文声明；`tests/build/licenses.test.ts` 通过，覆盖嵌套包根/NOTICE/README 原文、固定版本 hash 与缺许可阻止构建。release 工作流已将 `LICENSES/`、文档、部署模板与许可来源说明一并纳入压缩包；尚未发布远端 release。
- Linux x64/arm64 原生 runner 构建与烟测已配置在 CI/release 工作流中，尚未执行验证；本文不把当前机器结果称为 Linux 通过。macOS ad-hoc 签名不是开发者公证。
- 未连接真实生产飞书、herdr 或模型，未读取/迁移真实 `~/.herdr-agent`，未启动第二条生产 WebSocket。真实安装/授权/审批及长期运行仍需独立环境验收。

## B：既有业务

| 场景 | 新实现与行为 | 自动化依据 / 实际覆盖 | 未覆盖的现场部分 |
| --- | --- | --- | --- |
| B01 安装授权 | `cli/setup.ts`、`onboarding/`；选对应用，保存凭据，消息和精确 nonce 卡片往返 | `tests/cli/run.test.ts` 复用/冲突/部分成功退出码；`tests/onboarding/` 权限、取消、超时、同应用与卡片身份 | 飞书租户真实注册、发布、收到私聊并点击 |
| B02 启动补授权 | `cli/service.ts`；锁→迁移→Web→授权与 herdr 核验→唯一飞书连接 | `tests/cli/run.test.ts` 授权前 Web、网络错误不注册、同应用补授权、启动失败清理；`tests/storage/lock.test.ts` 排它与 inode | 真实 herdr 不兼容/断线、长连接恢复和权限传播 |
| B03 本机诊断 | `cli/diagnostics.ts`、`host-checks.ts`；配置/协议/可执行文件/权限、hooks、继承环境、检测配置、可见内容宽度 | `tests/cli/run.test.ts` 只读且不建立平台连接；`tests/cli/host-checks.test.ts` hook/环境脱敏/manifest、不可读 UNKNOWN、空/窄/宽内容 | hook 文件存在不证明执行器已信任；内容宽度是估算，不是终端物理尺寸保证 |
| B04 已有项目 | `projects/catalog.ts` 与 Web 项目表单；多目录有序、默认项目、独立任务快照 | `tests/projects/catalog.test.ts` 验证全部目录再初始化 Git；`tests/config/load.test.ts` JSON 覆盖与 bypass 继承 | 本机权限、具体执行器附加目录行为 |
| B05 新建项目 | 明确 `newProject`/项目创建动作；固定 home 子目录；删除仅移除登记 | `tests/projects/catalog.test.ts` 路径穿越/目录占用拒绝、Git、删除后原文件保留 | 无自动清理用户工作目录 |
| B06 建立任务 | `tasks/create.ts`、`provision.ts`；完整要求/参与者/群/远端任务/资源绑定 | `tests/app/workflows.test.ts` pi 工具到任务编排；`tests/tasks/lifecycle.test.ts` 未知创建不重复、平台不可用仍保留建群/远端 task 意图、显式本地任务可运行；`tests/feishu/platform.test.ts` bot-owned 私群与幂等 key；`tests/cli/integration.test.ts` 真实 pi/Web 与 fake herdr 建讨论任务 | 真实平台资源创建及 herdr UI |
| B07 首次启动 | `herdr/lifecycle.ts`、`tasks/baseline.ts`；确认 argv/身份，先基线再投递唯一初始回执 | `tests/herdr/lifecycle.test.ts` blocked 启动、明确 busy 重试、未知不重放、多目录 argv；`tests/tasks/lifecycle.test.ts` 不采前一轮回复 | 真实 CLI 版本提示、目录信任菜单 |
| B08 群内续聊 | `app/messages.ts`、`runtime/sessions.ts`、`tasks/records.ts`；owner/任务固定，AI 纯模型路由 | `tests/app/conversations.test.ts` AI 接收斜杠/unsupported、故障不落模板/终端；`tests/tasks/lifecycle.test.ts` owner/group 隔离；`tests/runtime/sessions.test.ts` task actor 边界 | 飞书群中真人消息、引用与被提及结构 |
| B09 多任务总览 | `tasks/records.ts`、pi 查询工具、Web；默认隐藏结束任务，all 显式读历史 | `tests/app/workflows.test.ts` 多对象事实；`tests/tasks/lifecycle.test.ts` 作用域；`tests/runtime/sessions.test.ts` 多 session 隔离 | 大量长期任务的性能上限未做压力测试 |
| B10 进度产出 | `tasks/observe.ts`、`transcripts/`、`app/outbox.ts`；参与者署名、完整结果回执、review≠完成 | `tests/transcripts/reader.test.ts` Claude/Codex、UTF-8/截断/替换；`tests/tasks/discussion.test.ts` 结果投递恢复；`tests/tasks/lifecycle.test.ts` 完成/暂停后迟到结果只观察；`tests/tasks/description.test.ts` 描述按内容去重与精确回读确认；`tests/tasks/completion-description.test.ts` 完成描述覆盖旧投影、未知描述不重放；`tests/app/presentation.test.ts` 进度冷却合并最新状态；`tests/app/workflows.test.ts` Web ACK | 真实 transcript 新版本；供应商输出语义 |
| B11 审批与中断 | `app/approvals.ts`、`herdr/control.ts`；完整 Guard、nonce、状态序号，正文不代批 | `tests/app/approvals.test.ts` 回调竞态/重复/外来身份；`tests/herdr/control.test.ts` 过期/目标变化/假 idle/queued 回显；`tests/app/presentation.test.ts` 显示裁剪不改变 Guard/选项、审批不受进度冷却影响；`tests/transcripts/legacy-fixtures.test.ts` 原始宽窄屏幕样例 | 真实各类 TUI 菜单与终端宽度 |
| B12 完成与群策略 | `tasks/lifecycle.ts` complete；确认完成后默认经herdr关闭pane，群按keepGroup快照处理；新默认delete，群解散必清执行器；明确keepExecution例外须同时保留群，review不收尾 | 原历史 complete 保留测试不等于新策略验收；新增默认/覆盖/解散通知与恢复证据见 [本轮矩阵](live-validation.md)。`tests/tasks/completion-description.test.ts` 覆盖未知描述回执 | 新默认及平台一致性延迟需本轮复验 |
| B13 验收关闭 | close 先确认完成，再通知/结果事实与受管资源清理；外部勾选完成也收尾 | `tests/tasks/lifecycle.test.ts` 远端完成确认前不清理、外部完成、保留群策略、关闭前保存未轮询最终结果（含 agent 已退出的原生记录）；`tests/app/presentation.test.ts` 最终结果/关闭通知不受进度冷却影响；`tests/app/workflows.test.ts` 通知只读权限 | 通知模型选择与飞书群可见效果 |
| B14 销毁重开 | destroy 不自动验收；destroyed 不可重开，代码保留 | `tests/tasks/lifecycle.test.ts` 销毁临时拒绝恢复、结束任务边界；`tests/projects/catalog.test.ts` 文件保留 | 关闭后资源实际状态人工核对 |
| B15 失败恢复 | `storage/operations.ts`、`app/inbox.ts`、`outbox.ts`、任务恢复；未知写操作冻结 | `tests/storage/store.test.ts` ledger/回滚；`tests/app/conversations.test.ts` 输入去重/部分投递；任务测试覆盖重启和未知响应 | 进程硬断电、磁盘满、长期网络抖动未做混沌测试 |
| B16 会话记忆 | pi 多 session、私聊自动压缩与 /clear 归档旧session并新建、Web代数clear、可见上下文、原文保留、HTTP摘要隔离 | `tests/runtime/entry-reset.test.ts` 旧session归档及新session延迟切换/旧队列拒绝不改绑/旧回执可投递/失败与群拒绝/压缩后隔离；`sessions.test.ts` 重启/clear/延迟确认；`memory.test.ts` 压缩失败/代数竞态；`migration/conversations.test.ts` 旧归档隔离 | 真实飞书新session切换与外部memory服务SLA仍须现场核验 |
| B17 已有 agent 桥 | `app/legacy.ts` 只在 tasks 关闭时启用；选择/回复绑定/镜像/解除选择 | `tests/app/legacy.test.ts` 回复优先于选中、迁移绑定核验、解除后不复活、notify_chat 基线；herdr control 与 migration 测试覆盖底层 | 旧卡片完整恢复不应推定；必须重新核对目标 |
| B18 长期部署升级 | `cli/service.ts`、flock/SQLite、SEA、deploy 与 CI；停止服务不杀全部 agent | 锁/存储/迁移测试；`tests/tasks/lifecycle.test.ts` 停机等待已提交结果、不启动后续 agent/任务、不关闭 herdr；`scripts/smoke.ts` 空目录独立运行 | Linux runner 尚未执行；真实服务管理器重启、长期保留增长 |

## N：新增业务

| 场景 | 实现与默认行为 | 证据与边界 |
| --- | --- | --- |
| N01 工具总览 | pi `tasks_list/task_get` 查询事实，Web 显式查看 | `tests/app/workflows.test.ts`、`tests/runtime/engine.test.ts`；不能仅凭历史摘要报告实时完成 |
| N02 单人需求讨论 | discussion 任务，Claude/Codex 按专用提示处理业务；可无项目 | `tasks/create.ts`、`prompts.ts` 与任务流程测试；无项目使用独立目录，提示约束不等于文件系统沙箱 |
| N03 双参与者群讨论 | 一个机器人署名，多实例 ID，有界轮转 | `tests/tasks/discussion.test.ts` 逐轮、预算、不可用暂停、未知 relay 不重放；`tests/app/workflows.test.ts` 同名拒绝歧义；`tests/cli/integration.test.ts` 真实 pi/Web、fake herdr 双参与者轮转与结果 ACK。未做真实双 CLI 群聊验收 |
| N04 讨论后开发/评审 | 新关联任务 `parentTaskId`，要求快照，执行任务参与者串行；显式 worktree | `tests/tasks/lifecycle.test.ts` 验证冻结 parentContext 背景且本次用户要求优先，`tests/projects/catalog.test.ts` 验证 worktree；完整“业务结论→用户确认→实现→评审”需真实模型行为验收，不由字段存在推定 |
| N05 切回 pi session | 独立选择与上下文恢复；编码资源不随选择变化 | `tests/runtime/sessions.test.ts` 重启/身份隔离，`tests/app/conversations.test.ts` durable inbox 固定接收时 session；归档任务会话不被选作活跃会话 |
| N06 暂停继续 | pause 停未来调度；interrupt 单人/全部；归档只影响 pi；resume 重置已明确的轮转预算 | `tests/tasks/discussion.test.ts` 时间/轮数停止和恢复回执；迟到输出可记录，不成为新授权；暂停不等于终止运行中的编码工作 |
| N07 分别结束讨论与执行 | 独立任务状态、群保留、关联历史，参与者给业务结论 | lifecycle 测试证明资源策略；没有自动跨任务级联完成，也没有 pi 代判业务结论。需要现场核对交接内容完整性 |

## AI 核心边界专门验收

`tests/app/conversations.test.ts` 已验证 AI 开启时斜杠文本和不支持的内容也进入模型上下文，模型失败不触发模板回复/传统命令/终端原文投递。`tests/runtime/engine.test.ts` 使用真实 pi 循环验证参数、可信 actor、工具前检查点、未知写操作后只读限制和工具次数上限。通知只读工具由 runtime 测试验证，不能把 agent 输出转成用户权限。

还需真实模型样例核对：否定的关闭请求、仅讨论不开发、讨论成果的准确交接、含糊短答、未知操作结果、多个同种参与者和人工审批。提示词存在不等于这些模型行为已保证。

## 最终执行清单

```sh
npm ci
npm run format
npm run check
npm run build
npm run binary
npm run smoke
npm audit
```

`check` 包含单文件 1000 行限制、严格 TypeScript、Biome lint/格式和全部测试。修改后需重新验证受影响证据。`npm run binary` 已从最终源码重建应用及 SEA，并通过 `npm run smoke`；不能用较早构建的烟测代替最终交付。

依赖审计曾定位到开发依赖 `tsx@4.21.0 → esbuild@0.27.7` 的 low 公告 [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)（Windows 开发服务器文件访问）。集成已将 tsx 升级为 4.23.13 并更新锁文件，最终已执行 `npm audit`，报告 0 项漏洞。

原 Go 源码已从当前实现移除；七份屏幕/transcript 原始样例保留在 `tests/fixtures/legacy/`，用于协议兼容回归。历史代码路径以需求盘点中的固定 commit 链接为准。
