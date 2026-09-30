# pi leader 迭代：未知结果补证、原生调度与讨论交接

## 产品定位

myrix 是飞书里的“原生 agent 远程驾驶舱”：pi 作为 leader，将任务派给 herdr 托管的 Claude Code / Codex，参与者在各自原生 session 中完成业务工作。每个任务默认对应一个飞书群和一个飞书任务；讨论形成结论后，再创建子任务让 Codex 执行，不把讨论完成等同于实施授权。

本迭代采用方案 A：规则负责合法候选、身份和权限边界，受限 pi 负责 workflow 选择，程序根据真实回执执行和记账。Jev 不再作为 workflow 主选择者，只保留原生审批菜单自动选择和可选私聊入口分类。

用户确认保持 `tasks.bypass` 默认 `true`。AI 已启用且配置 Jev key 时，`approvals_enabled` 默认仍为 `true`，原生审批仍会把完整可见终端屏幕、任务要求和用户修订发送给第三方 Jev；本迭代没有改成默认手动审批，也没有关闭这条默认数据外发路径。

## 修复行为

### 1. 执行器关闭后释放历史输入占用

[closed-input](../src/orchestration/closed-input.ts) 对 destroying / destroyed 且已暂停讨论的任务，核对输入回执、执行器身份、关闭回执及时间顺序。执行器经确认关闭后，历史 uncertain 输入不再占用工作目录。

释放目录不等于证明旧输入成功：原输入的未知结果保留，不改写为成功。关闭结果仍未知时，只有只读证据或用户明确选择“视为完成”才能作为释放依据，pi 自己的判断不能释放共享目录。

### 2. 未知副作用先做只读补证

[未知结果补证](../src/tasks/uncertain-effects.ts) 区分 pane 关闭、输入投递和报告附件；[操作回执](../src/storage/operations.ts) 新增 resolution / history，将目标状态决议与历史调用结果分开。

- resolve 只增加决议，不改原 state、error 或 updatedAt；显式重试的旧回执另存历史。
- pane 关闭仅在窗口查询明确 not found 时补证；agent 不存在不等于 pane 不存在，查询失败或身份不符不能证明已经关闭。
- 输入投递用绑定原生 transcript 的 receipt 与完整 prompt 精确匹配补证，不凭部分文本猜测成功，也不重新投递。
- 报告附件没有平台只读查询接口，不能自动补证，直接进入受限 pi / 人工卡片。
- [closeTask](../src/tasks/lifecycle.ts) 在执行器关闭循环前先补证，避免为了确认丢失的关闭回执而直接重发关闭。
- [输入恢复](../src/tasks/input-recovery.ts) 由原生记录确认的输入写入 treat_done / evidence 决议，不再把历史回执改写成 done。

只读补证不关闭 pane、不发送输入、不上传附件；工作目录释放仍须上述可信关闭依据。

### 3. 三级决策：补证 → 受限 pi → 飞书人工卡片

AI 与任务均启用时，[application](../src/app/application.ts) 每个 tick 调用 [UncertainResolver](../src/app/uncertain-resolver.ts)，按任务加锁处理未决的 pane 关闭、输入投递和报告附件。resolver 只写决议，副作用仍由原调度器执行。

1. 只读补证：[reconcileUncertain](../src/tasks/uncertain-effects.ts) 查询 pane 是否存在（[HerdrPort.paneExists](../src/core/ports.ts) 仅在 pane_not_found 时返回 false，其他失败抛错），或比对原生 transcript receipt 与完整 prompt；确认后写入 treat_done / evidence 决议。
2. 受限 pi：剩余项交给 [chooseUncertain](../src/app/uncertain-choice.ts)，经 [chooseWithPi](../src/orchestration/pi-choice.ts) 只能从 treat_as_done / retry_once / abandon_step / escalate_to_user 中选一项，不执行副作用。每个操作修订版本（操作 ID、重试历史数与指纹）只问一次：调用 pi 前先写 `uncertain_pi_attempts`，失败或重启后不再重问。pi 选中具体项即写入 decidedBy pi 决议；escalate、无效选择、出错或取消都转人工。
3. 飞书卡片：[UncertainCards](../src/app/uncertain-cards.ts) 发到任务群，只列具体选项，不提供 escalate_to_user；用户选择写入 decidedBy user 决议。

公开选项映射为存储决议：treat_as_done → treat_done，retry_once → retry，abandon_step → abandon。

- 视为完成：不重复执行；原回执的 state、error、updatedAt 保留，不伪造历史成功。
- 重试一次：接受原操作可能已成功造成的重复风险；重新执行时旧回执移入 history。重试上限在代码中强制：整个操作历史已有 retry 时，决议返回 operation_retry_exhausted，retry_once 也不再出现在 pi 候选和卡片中。
- 放弃：不再执行（再次运行得到 operation_abandoned），也不声称目标已达成。
- pane 关闭的“放弃”只能来自用户卡片，pi 候选不含此项。[closeTask](../src/tasks/lifecycle.ts) 据此把参与者标记 removed 并继续清理，窗口可能仍在运行；非用户的放弃决议仍阻止清理。
- 报告附件被放弃后不再阻止解散群（[fileAbandoned](../src/orchestration/report-delivery.ts)），报告仍可在本机 Web 下载。
- [Operations.inFlight](../src/storage/operations.ts) 标记本进程内正在执行的操作；执行中的操作不列为未决项，也不能决议。

卡片绑定所有者、群、nonce、10 分钟有效期与操作修订版本。回调（action `uncertain`）先持久化消费再处理，拒绝跨所有者、跨群、过期、重复、候选外、修订已变化或群已解散的选择。卡片发送结果未知时不重发。同一修订版本同时只有一张有效卡片；卡片过期仍未处理时，下一轮会作废旧卡并发新卡。

### 4. 附件门禁失败不是平台未知副作用

[报告交付](../src/orchestration/report-delivery.ts) 将 beforeSend 门禁和平台调用分开。门禁失败保留已确定的阶段与诊断，不误标 uncertain；只有平台真正调用后的未知结果才进入 uncertain。已上传但尚未发送的附件，也不因发送前门禁失败而变成“上传结果未知”。

### 5. 完成性声称按分句和本轮证据核验

[声称检测](../src/runtime/claims.ts)、[资源证据](../src/runtime/provision-evidence.ts) 与[共享策略](../src/runtime/claim-policy.ts) 按分句检查，“任务已创建。还需要什么？”不能用后一句问句绕过前一句断言。

本轮 task_get / task_progress / tasks_list 查询取得的任务、群与投递现状可以如实报告；查询不能证明“我已为你创建”“本轮已安排”等本轮写操作，后者仍须本轮写证据。资源证据按任务和参与者绑定，不能借另一个任务的成功回执。engine 与 sessions 共用 evaluateClaimPolicy，避免生成与持久化边界采用不同标准。

### 6. 报告文案对应真实交付方式

[报告摘要](../src/orchestration/report.ts) 按 body / attachment / web 分别说明完整报告在正文、附件或本机 Web；不在仅有 Web 下载时声称飞书已收到附件。交付仍不代表用户验收。

历史 open 问题被标记待重新验证后，单列“旧版本遗留问题（待重新验证）”，不混入当前阻塞项，也不删除旧问题记录。

### 7. 子任务继承父讨论的冻结材料

[父任务交接](../src/tasks/parent-handoff.ts) 在核验父任务所有者后，冻结父报告与文档元数据，把可核验材料快照保存在 `stateDir/tasks/<子任务ID>/parent-handoff/`。

- 快照用 O_EXCL 创建，权限 0444，只读、内容寻址，重试不覆盖原文件；读取来源和写后快照均校验 SHA-256，并检查路径、文件类型与大小。
- 只有全部父参与者对同版、同 hash 文档的确认都匹配，才标记双方共识；冻结报告本身不证明共识。
- 文件缺失、hash 不匹配或路径不安全时，已有引用标记 unverified 并记录原因，不阻止子任务创建；没有 hash 的文档不补造引用。
- 交接任务书只列材料路径、hash 与验证/共识状态，不嵌入整份报告或序列化历史。父任务材料仅作背景，不构成子任务的新授权，本次用户要求优先。

### 8. 方案 A：pi 主选，规则与回执守边界

[下一步策略](../src/orchestration/policy.ts)、[规划协助](../src/orchestration/assistance.ts)、[计划接入](../src/orchestration/plan-selection.ts)、[文档授权](../src/orchestration/document-delivery.ts) 和[合同变更](../src/orchestration/contract-change.ts) 共用 [chooseWithPi](../src/orchestration/pi-choice.ts)。

规则先筛合法候选；确定性规则或唯一合法下一步可直接采用，其余由 pi 仅通过 orchestration_choice 选择一项。选择器没有业务执行工具，不能扩大写入范围、自动撤销合同或伪造输出；pi 无效或出错则延后并交用户决定。合同撤销必须引用最新真实任务输入，逐项核对文档交付与共识义务，不因模型省略字段就追认撤销。

[决策日志](../src/orchestration/decision-log.ts) 使用 workflow-selection-v4，规划协助使用 workflow-planning-assistance-v3，合同授权使用 workflow-contract-authorization-v2。[文档源码边界](../src/orchestration/document-source.ts) 兼容读取旧授权证据，不改写历史审计记录。

### 9. 弃用新 round_robin 与旧桥新接管

[任务创建](../src/tasks/create.ts) 和[参数校验](../src/app/validation.ts) 对新建任务显式 round_robin 返回 discussion_mode_deprecated。无 AI 的多参与者讨论默认 manual；任务与 AI 已启用时默认 workflow，与是否配置 Jev key 无关；新自动任务即使旧工具传 model，也会归一为 workflow。Jev key 只影响原生审批菜单与私聊入口分类。存量 round_robin 仍按原协议，在上一位输出核验后轮转。

[旧桥](../src/app/legacy.ts) 的 /ls 不再发选择卡，卡片 select 不能建立新绑定，去掉单 agent 隐式接管，/mirror 不能新建绑定。已经选中的 pane 保留 /say /stop /mirror /close，/card 只查看当前选择；/close 仅解除选择，执行会话继续运行。旧桥新接管请改为 pi 创建任务。

### 10. issue 随计划版本重新核验，评审与路径不越界

[WorkflowIssue](../src/orchestration/workflow.ts) 增加 planVersion / needsRevalidation。[用户修订处理](../src/orchestration/runner.ts) 调用 [markIssuesForRevalidation](../src/orchestration/state.ts)：旧 open 问题保留但不阻塞当前计划；当前回执重新提出后恢复当前阻塞状态，不把修订等同于问题已解决。

参与者不能关闭、降级、改名或重新核验 myrix 配置命令产生的验证问题；这些问题由配置命令的新证据更新。[评审候选](../src/orchestration/candidates.ts) 仅在没有任何兼容评审者时提供 add_reviewer，不因兼容者暂时忙碌而扩员，固定分工冲突仍需重规划或用户决定。

[board](../src/orchestration/board.ts)、[handoff](../src/orchestration/handoff.ts) 与父任务快照按路径段判断越界：拒绝真正的 `..` 上级路径，允许安全边界内的 `..notes.md` 文件名。这不表示取消项目文档授权自身的路径和后缀限制。

## 兼容与迁移

- workflow-selection-v1–v3 仅用于历史只读回放，保留各版本的 Jev/pi 语义，不作为新派发授权，也不把新策略写成旧日志中曾经发生的选择。
- 存量 v2 workflow、model、manual 与 round_robin 保留已有参与者协议；新建 round_robin 的弃用不批量重写存量任务。
- 历史 uncertain / 中断 pending 回执不自动迁移成成功，不自动重放副作用；仅在处理时取得严格补证或显式决议。resolution 与 history 保留未知调用的原始事实。
- 已选中的旧桥 pane 继续可用，包括旧选择记录的兼容读取；解除选择后不能通过 /ls、旧卡片或 /mirror 再建立新绑定。
- 子任务交接不覆盖父文件、不修改项目代码，不把 unverified 引用当作共识，不自动开始开发或替用户验收。

## 已知限制与不一致

- [生命周期回读](../src/tasks/lifecycle.ts) 的 `confirmGroupDeletion` / `syncCompletion` 原先直接把未知回执改为 done，是已有测试覆盖的历史行为，不是本迭代回归；当前两者已改为追加 treat_done / evidence 决议，并跳过已有 resolution 的回执，收敛到“补证目标状态、不改写历史回执”。群回读的 `resolution.result` 仍保留 previousState / previousError。
- [输入恢复](../src/tasks/input-recovery.ts) 中，pi / 用户的 treat_done 仅通过有 `input_deliveries` 记录的 prepared-input 路径推进参与者。旧版导入且无该记录的 `:initial` / `:send` / `:relay` 回执，一旦已有 resolution 就被 `recoverInitialInputs` 跳过，“视为完成”不会推进参与者；用户需明确请 pi 重新拉起参与者（`participants_restart`），不能据此声称已恢复通信。
- 输入“视为完成”不等于投递已核验：仅原生 transcript 精确匹配的 evidence 补证令 `resolution.result.verified = true`；pi / 用户决议仍为 false。

## 验证与边界

本迭代自动化测试为离线 fixture：使用本地临时文件、SQLite、原生 transcript 和平台/模型替身核对决议历史、严格补证、三级 resolver、声称策略、父子交接、选择器、卡片、弃用及 issue 版本边界。fixture 结果不是远端飞书资源或真实模型执行的证明。

尚未做本迭代真实飞书 / herdr / Claude Code / Codex 全链验收；三级未知结果处理已接入 application，但真实 pane 查询、飞书卡片发送与回调尚无现场证据。

已记录的 `npm run check`：check:lines 通过（440 个源文件）、tsc 通过、Biome 通过（435 个文件）；默认并发 `npm test` 共 1802 项，1755 通过、47 失败，全部为超时（10s / 40s / 247s），分布于 `tests/deploy/install.test.ts`（30）、`tests/orchestration/workflow-worktree.test.ts`（6）、`code-delivery.test.ts`（5）、`workflow-safety.test.ts`（3）、`verify.test.ts`（1）、`tests/build/npm.test.ts`（1）及 `tests/app/workflow-report-delivery.test.ts`（1）。这 7 个文件单独重跑，在本分支与迭代前基线 `ec060cd` 均通过：install 组均为 57/57，worktree 14/14、code-delivery 9/9、safety 8/8、verify 7/7、report-delivery 19/19、npm 9/9。

全套改用 `node --import tsx --test --test-concurrency=2 tests/**/*.test.ts`：1802 项，1799 通过、3 失败，均为 `tests/deploy/install.test.ts` 的 launchd installer bootstrap 用例约 40s 超时；该文件单独重跑 46/46 通过。基线在负载下同样出现 launchd installer 超时，属于既有的负载敏感环境问题，非本迭代引入。

合并测试 helper 后再次执行默认并发 `npm test`：1802 项，1751 通过、51 失败，仍全部为超时，分布于 install（33）、workflow-worktree（6）、code-delivery（5）、workflow-safety（3）、report-git-contract、verify、npm、workflow-report-delivery（各 1）。这 8 个文件合并单独重跑 142/142 通过。因此默认并发的 `npm run check` 在本机仍会因既有超时退出 1，不能称整树检查通过；是否为 `npm test` 固定 `--test-concurrency` 留待决定。

文档自检使用 `node scripts/check-lines.mjs`；该脚本不检查 docs。只读补证仍依赖绑定身份与可核验原生记录，报告附件仍没有平台查询接口，pi 判断也不能单独释放工作目录。本轮不调整 Bypass 与 Jev 自动审批默认值。
