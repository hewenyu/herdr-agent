# Jev workflow v1.1 本地实现与复核记录

日期：2026-09-27。基线：`d2a0ba0c3e1c302dbb809e66db18a87b6e2974cb`。实现与证据随本 PR 提交评审，尚未发布或重启生产服务。

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

## 真实请求与本机配置

- [Jev Choice 实跑](jev-choice-live-evidence-2026-09-27.md)：合成中文输入，`jev-1.13.0` 返回合法独立开场候选及完整分布。只证明该次 API 合同和 key 可用，不代表中文质量评测已经完成。
- [pi 实跑](workflow-policy-live-evidence-2026-09-27.md)：当前本机模型真实调用 Planner 和受限选择器，无探针协议覆盖，四次 HTTP 200。保留修复前网关不支持 `tool_choice=required` 的失败证据。两个入口通过合法工具结果检查强制选择，不依赖该网关选项。
- Jev key 只保存于 `~/.herdr-agent/config.toml` 的 `[jev].api_key`，文件权限 `0600`；没有写入仓库、报告或日志。Claude 复核时只需知道本机 key 已准备好，无需在评审文档中复制 key。
- `[jev].ingress_enabled` 仍为 `false`；未给用户现有项目添加 verify、未执行用户项目验证命令。自动测试所运行的命令属于隔离临时项目。

## 仍未验收的范围

没有启动实际 Claude/Codex 完成三套业务模板，也没有向飞书发送真实入口或交付消息；没有完成跨真实模型、长上下文、含糊短答及成本/质量的对照评测。S3-30 和 S4-17 的现场部分因此保持未完成，发布前需要单独补齐；当前不能标为生产全链路验收通过。

目录门禁协调本进程内的任务调度与已登记验证，不是 OS 沙箱，也不阻止用户或外部程序直接修改目录。verify 命令具有本机进程权限，退出码 0 只是一条运行事实。未知进程或投递结果保留为待核验状态，不自动重放或释放冲突目录。

Claude 复核时建议优先检查 `runner.ts` 的决策/派发原子恢复、`reportContract/assertDelivery` 的版本与文件门槛、verify 的退出确认，以及入口 opt-in 与项目设置的授权边界；所有新增逻辑均在本地源码和测试中可审阅。
