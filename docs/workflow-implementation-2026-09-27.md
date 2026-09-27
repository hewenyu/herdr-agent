# Jev workflow v1.1 本地实现与复核记录

日期：2026-09-27。基线：`d2a0ba0c3e1c302dbb809e66db18a87b6e2974cb`。实现与证据随本 PR 提交评审，尚未发布或重启生产服务。

后续状态：PR #54 已合并到 `392a0d3`，用户已明确确认验收通过。下文保留开发和 PR 审计期间的原始证据范围；“未验收”指当时开发者未运行的链路。后续修复与可复现验证见[合并后补齐记录](workflow-completion-2026-09-27.md)。

复核入口：[总设计 v1.1](myrix-jev-llm-orchestration-design.md)、[S3](specifications/S3-workflow-orchestration.md)、[S4](specifications/S4-ingress-verification.md)。用户已接受 S4 的两项边界变更；本次实施无需再次确认这两项授权。真实平台联合验收与发布仍是独立的后续工作。

## 已实现的行为

- 新任务在 AI 启用、配置 Jev key 且没有显式旧策略时默认保存 `workflow`；旧 `model`、`manual`、`round_robin` 不迁移。没有恢复轮数、决策数或总时长预算。
- 首次由 pi Planner 选择讨论、开发或小 Bug 模板，冻结计划版本；复杂任务可提交经过角色、依赖、权限和报告出口校验的图。小 Bug 默认四个节点，将针对性验证与独立评审合并。
- 规则生成合法候选，Jev 选择，失败或低置信度才交给只开放 `orchestration_decide` 的 pi。记录规则结论、Jev 完整分布、后备原因、模型、最终来源和回执；只读回放不执行动作。
- 派发仍经既有 `OrchestrationEvent.decision/dispatches`、`TaskService.send`、原 operationId 和回执恢复；没有新增派发表或租约。讨论独立开场等本批派出者全部结束；非讨论发送仍串行。
- 看板和完整参与者正文位于 `stateDir/tasks/<id>/board/`，通过附加目录传给 agent；数据库是事实来源。新 prompt 版本保留旧模板的精确回读候选。辅助文件不落用户仓库，不修改 Git 排除文件。
- 非空 open 集合连续稳定达到窗口后请求用户裁决，不自动综合、交付、验收或关闭。非法/迟到回执、重试和轮询不计有效批次。
- 报告包含必需章节、来源标签和明确的文件合同。`requiredArtifacts` 必须有当前版本记录；交付前重新读取真实文件并核对 hash。正文与摘要卡片各自保存送达回执，未知结果不重发。交付之后等待用户验收。
- 私聊分类独立 opt-in、默认关闭。Jev 只选 intent/project；高置信度使用原文 requirements 和确定性标题建任务，复杂输入、引用、失败或低置信度走原 pi。规则命令和任务群保持原入口。
- myrix 只运行本地项目设置中的 `verify`，固定任务主 cwd、有限超时、保存 stdout/stderr 和退出事实。配置或代码版本变化会使旧证据失效；取消检查整个进程组，重启后未知运行保留目录阻塞。
- 无 verify 时，独立 agent 实际重跑只标“agent 复核”。用户明确禁止测试时，Planner 必须引用用户原文，关闭命令候选，保留独立只读评审并输出“未运行”证据；参与者意见不能免除验证，也不能撤销已授权实现。

## S3/S4 代码与验证映射

下列编号涵盖两份 spec 的全部 48 项。代码和自动测试完成不代表真实飞书现场验收完成。

| 范围 | 实现入口 | 自动证据或状态 |
| --- | --- | --- |
| S3-01～02 | `core/types.ts`、`tasks/create.ts`、配置与业务工具 schema | `workflow-contract`、`task-budget-compatibility`：默认/显式/历史模式 |
| S3-03～08 | `orchestration/workflow.ts`、`templates.ts`、`planner.ts` | 合法/非法 DAG、验证顺序、三模板、冻结计划、复杂化重规划 |
| S3-09～11 | `state.ts`、`status-block.ts`、`runner.ts`、原 revision | `workflow-recovery`：迟到、非法块、稳定问题与重启去重 |
| S3-12～14 | `tasks/prompts.ts`、`provision.ts`、`orchestration/board.ts` | 历史模板精确兼容；runner 中看板、正文与目录测试 |
| S3-15～20 | `candidates.ts`、`jev.ts`、`policy.ts`、`decision-log.ts` | `jev`、`policy`：分布、超时、低置信度、取消、同候选后备、只读回放 |
| S3-21～25 | `runner.ts`、原 task orchestrator、`workspace.ts`、`tasks/observe.ts` | `workflow-runner/recovery/safety`：单链恢复、阶段门禁、目录冲突、僵局 |
| S3-26～28 | `report.ts`、`report-delivery.ts`、`application.ts` | 缺产物、过期证据、交付竞态、正文/卡片部分失败、未知结果与不自动验收 |
| S3-29 | `npm run check`、`npm run build` | 见下节最终检查记录 |
| S3-30 | 真实 Jev + pi 合成探针 | 部分完成：未运行真实 Claude/Codex 与飞书三模板联合验收 |
| S4-01～07 | `config/*`、`ingress.ts`、`app/messages.ts` | `jev-ingress`、`orchestration/ingress`：默认关闭、原文、作用域、恢复、去重、回退 |
| S4-08～12 | `projects/catalog.ts`、`verification-config.ts`、`verify.ts`、Web 配置 | 配置持久化与保护；真实隔离子进程成功/失败/超时/取消/未知恢复 |
| S4-13～14 | `state.ts`、`report.ts`、`runner.ts` | 独立评审、准确来源、配置/代码失效、用户禁止运行验证的完整流程 |
| S4-15～16 | 中英文 README、配置示例、`node-pi-design.md`、`ai-framework.md` | 默认值、隐私外发与命令边界已同步 |
| S4-17 | 自动回归、构建和真实模型证据 | 自动检查与模型探针已运行；飞书入口/建任务/报告实测未运行 |
| S4-18 | 本记录及 S3/S4 完成门槛 | 本地复核准备完成；没有执行联合发布 |

## 验证记录

下表记录初次提交 `7cee869` 的验证；后续 PR 审计修复记录见下一节。

| 检查 | 结果 |
| --- | --- |
| `npm run check:lines` | 通过，306 个源文件均不超过 1000 行；原 orchestrator 920 行，workflow runner 896 行 |
| `npm run typecheck`、`npm run lint` | 通过 |
| `npm run build` | 通过，生成 `dist/myrix.cjs` |
| 新功能及兼容专项（最终代码） | 72/72 通过，包括产物删除/替换竞态和禁止验证的完整流程 |
| 默认并发 `npm run check` | 当时 949 项中 945 通过，4 项既有安装器用例在各自 10 秒期限超时；不是全绿记录 |
| 安装器隔离复跑 | 46/46 通过，原 4 项分别约 3.19、2.78、3.57、2.77 秒；没有修改安装器或测试断言 |
| 最终全量：`node --import tsx --test --test-concurrency=2 tests/**/*.test.ts` | **952/952 通过**，失败/跳过均为 0，耗时 182.3 秒；包括最终产物合同改动 |
| `git diff --check`、文档链接、密钥扫描 | 通过；私有 TOML 权限 `0600`，入口开关关闭，仓库未检出其中的真实密钥 |

默认并发超时与隔离通过的结果均保留，不把“并发资源竞争”当作已经确认的系统根因。安装器、安装器测试及 npm 配置模块与基线字节一致；fixture 预写独立 config.toml，所以失败场景不会读取改动后的配置示例。

测试里的 TaskService、SQLite、真实隔离子进程属于运行时集成验证；FakeHerdr 与消息平台 fixture 不算真实 Claude/Codex 或飞书证据。

额外恢复审查已修复：返工状态失效与派发记录非原子、同一 transcript 页迟到旧回执覆盖合法回执、移除参与者后开场仍绑定旧 roster、失败/未启动验证被重复选中、旧配置或旧代码证据重用、计划版本缺少独立归档。

## PR #54 审计修复

- [显式模板漂移](https://github.com/hewenyu/herdr-agent/pull/54#discussion_r4114113412)：Planner 枚举、工具执行和 `validatePlan` 均保留任务显式模板。未指定模板仍可选择；同模板下的节点重规划仍可进行。新增 4 项合同回归。
- [派发重试重复计数](https://github.com/hewenyu/herdr-agent/pull/54#discussion_r4114113414)：在事件尝试开始时计数，失败处理不重复累加；目录准入等待归还次数。新增 9 项回归，验证初次加两次重试、第三次成功或进入 attention、重启、未知结果不重发，以及规划/选择失败的计数。

第一轮整合回归 103/103 通过，行数、类型、lint、构建与差异检查通过。提交 `cbe76cf` 的三平台 CI 全部通过，包括全量检查与独立可执行文件烟测。

第二轮修复：

- [安全取消后验证无法恢复](https://github.com/hewenyu/herdr-agent/pull/54#discussion_r4114152975)：只有已确认退出的取消记录才产生新候选，新运行通过 `retryOf` 引用原记录，保留独立 stdout/stderr 与证据。旧候选重放保持原身份，失败、超时、未启动失败及未知退出不自动重跑。新成功证据解除对应 myrix 验证问题。新增暂停恢复、正常关闭重启到报告交付的集成回归，以及取消链、并发去重、旧选择恢复和终态保护测试。
- [任务类型与模板不兼容](https://github.com/hewenyu/herdr-agent/pull/54#discussion_r4114152979)：创建入口在项目、目录及持久化副作用前拒绝非法配对；讨论仅允许 discussion，其他类型允许 development/bugfix，省略模板及历史模式保持兼容。直接调用和业务工具覆盖全部配对及无副作用拒绝。
- 本地独立审查复现的前台暂缓计数：前台消息和安全停止不消耗失败重试次数，已应用动作保持完成；未知投递仍进入 attention。每次重新选择使用独立持久日志 ID，避免归还次数后覆盖不可变旧日志；已选动作恢复继续复用原选择。新增连续暂缓、停止恢复和未知效果不重放的回归。
- 验证问题编号冲突：系统问题绑定命令索引，与参与者同名问题使用不同 ID；成功验证只解除对应系统问题，不关闭参与者独立提出的缺陷。旧系统问题按原编号兼容回读。

第二轮全量 981/981 通过（183.6 秒）；随后加入编号冲突保护与回归，最终相关整合 120/120 通过（28.7 秒）。行数、类型、lint、构建与差异检查均通过。全量记录与最后增量分开列出，最终提交的完整测试由三平台 CI 再核验。

提交 `cd82791` 的三平台 CI 全部通过；macOS 完整测试 982/982，Linux ARM64 为 981 通过、1 项 Darwin 专属检查按平台跳过，独立可执行文件烟测通过。第三轮审计仍发现 [返工丢失原实现者身份](https://github.com/hewenyu/herdr-agent/pull/54#discussion_r4114202368)：已改为在任务状态累计实现派发参与者，并由已有事件及历史计划回填旧记录。候选、恢复派发、回执证据和交付合同均核对该集合；旧作者错误标记的独立证据降级，原报告失效。失效且尚未送达的冻结报告明确进入 attention，不循环重试原报告；未知送达恢复规则保持原样。

第三轮新增 5 项回归，覆盖 A→B 返工后增加第三人独立复核、重启与新计划、跨版本节点改名后的历史回填、旧作者回执和旧冻结选择拒绝、失效报告只提示一次。最终相关整合 126/126 通过（34.2 秒），类型、lint、行数、构建及差异检查通过；最终完整测试仍由对应提交的三平台 CI 核验。

提交 `cdcd6f3` 的三平台 CI 全部通过，macOS 完整测试 987/987、独立可执行文件烟测通过。第四轮审计发现 [自定义可写节点漏记作者](https://github.com/hewenyu/herdr-agent/pull/54#discussion_r4114234904)：统一将非 reviewer 的可写节点计入潜在作者，适用于当前节点、派发和历史计划回填。reviewer 仍可运行验证；若观察到节点执行前后的产物版本变化，先持久记录潜在作者，再解析回执或重置计划，不因格式错误、外来回执、用户 resume 或旧 blocked 状态漏记。外部修改的归因保持保守，不把推断表述成真实作者事实。

第四轮新增 6 项回归，作者身份专项 11/11、最终相关整合 132/132 通过（52.0 秒）；类型、lint、行数、构建及差异检查通过。当前 workflow runner 为 938 行；补充身份逻辑位于独立 `authorship.ts`，没有扩展主调度器文件。

继续沿用事件级尝试次数；没有新增任务轮数预算或独立派发预算。最新 CI 和审计结果以对应提交的 GitHub checks 与审计回执为准。

## 真实请求与本机配置

- [Jev Choice 实跑](jev-choice-live-evidence-2026-09-27.md)：合成中文输入，`jev-1.13.0` 返回合法独立开场候选及完整分布。只证明该次 API 合同和 key 可用，不代表中文质量评测已经完成。
- [pi 实跑](workflow-policy-live-evidence-2026-09-27.md)：当前本机模型真实调用 Planner 和受限选择器，无探针协议覆盖，四次 HTTP 200。保留修复前网关不支持 `tool_choice=required` 的失败证据。两个入口通过合法工具结果检查强制选择，不依赖该网关选项。
- Jev key 只保存于 `~/.herdr-agent/config.toml` 的 `[jev].api_key`，文件权限 `0600`；没有写入仓库、报告或日志。Claude 复核时只需知道本机 key 已准备好，无需在评审文档中复制 key。
- `[jev].ingress_enabled` 仍为 `false`；未给用户现有项目添加 verify、未执行用户项目验证命令。自动测试所运行的命令属于隔离临时项目。

## 仍未验收的范围

没有启动实际 Claude/Codex 完成三套业务模板，也没有向飞书发送真实入口或交付消息；没有完成跨真实模型、长上下文、含糊短答及成本/质量的对照评测。S3-30 和 S4-17 的现场部分因此保持未完成，发布前需要单独补齐；当前不能标为生产全链路验收通过。

目录门禁协调本进程内的任务调度与已登记验证，不是 OS 沙箱，也不阻止用户或外部程序直接修改目录。verify 命令具有本机进程权限，退出码 0 只是一条运行事实。未知进程或投递结果保留为待核验状态，不自动重放或释放冲突目录。

Claude 复核时建议优先检查 `runner.ts` 的决策/派发原子恢复、`reportContract/assertDelivery` 的版本与文件门槛、verify 的退出确认，以及入口 opt-in 与项目设置的授权边界；所有新增逻辑均在本地源码和测试中可审阅。
