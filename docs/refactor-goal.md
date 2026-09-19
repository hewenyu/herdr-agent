# Node + pi 完整重构目标

状态：**阻塞（blocked）：等待恢复真实桌面/飞书交互入口；完整目标未完成**。初始重构分支：`refactor/node-pi-runtime`（PR #16 已合并，merge commit `c3ab1a3`）；当前后续核对基于 `master`，不把已合并分支或旧运行产物当作当前源码。重构开始日期：2026-09-17；上一阶段实现与离线验收记录日期：2026-09-18。本轮不以此前阶段完成代替当前目标完成。

2026-09-18 Web 边界修正：**真实业务全部从飞书私聊或任务群发起。** Web 可浏览、筛选会话记录，并配置本机项目（有序多目录，首目录保存时自动 Git 初始化）、默认项目、Bypass、模型连接和本机身份；不能发消息、创建任务、管理参与者、审批、清理资源或操作 pi session。Web 配置 action 受 loopback、Host、Origin、CSRF 和 action 白名单保护，未测项仍按矩阵记录。

2026-09-18 发布授权与约束：用户已授权在问题修复、必要验收及最终 HEAD CI 通过后自动合并 PR #16，自动打 tag、执行并检查 Release Action 和真实 npm 安装。重构版本从 **v0.3.x** 开始，首版计划 **v0.3.0**。npm 包名 **@yuebanlaosiji/myrix**，提供 `myrix` 命令及 `herdr-agent` 兼容命令；使用 GitHub environment **NPM** 的 **TOKEN**。发布失败不得覆盖既有 npm 版本或移动公开 tag。该授权不把未测项自动视为通过；发布状态与完整验收目标分别记录。

2026-09-18 历史运行检查：仓库 `master`/`origin/master` 为 `f2afb9b`；`v0.3.6` macOS arm64 SEA 已重新构建并重启，PID `91732`，构建提交 `e7e8b3e`，SHA256 `cee2c5cd1287be2b79cbb1b2ed4487025f47baaf974783c45cb6641b66df882d`；`version --json`、`/api/state` 和授权状态均已回读。状态库 23 个任务均为 `destroyed`，177/177 个 outbox 已送达；23 个任务群及缓存中的 5 个历史专用群均经真实 Feishu GET 回读为 `dissolved`。这只是当前部署和资源清理证据，LIVE-001、B/N 矩阵中的 U/R-部分/R-F 仍保持原判定，不能以服务 ready 或测试资源为空替代真实用户入口验收。

2026-09-18 E20进展：Web 配置与历史边界整改已实际部署，真实飞书主私聊机械clear、讨论→关联开发、关闭父而保留子、子默认资源清理均有独立证据。0ccfff2全量378项检查；b53b263终态描述修复386项、SEA通过并部署，子远端描述已精确匹配最终投影。首轮讨论字数超限保留R-F；群内明确修订60字符通过。详情及当前未解决项见[E20记录](live-evidence-e20-release.md)。主分支required checks已从4个失效Go名称迁移为3个平台Node/SEA检查，strict:true及其他全部保护逐字段确认不变；最终HEAD通过前不合并。

## 目标

2026-09-19 14:00 UTC 阻塞复核：E39 收尾、E40 和本轮连续三次目标回合均无法获取飞书/Chrome 窗口（`cgWindowNotFound`），浏览器连接器另报 `unsupported Codex auth method: apikey`。服务仍 ready，当前零活动任务、零排队/处理中 inbox，原12项项目及默认 herdr-agent保持；独立磁盘满等可推进检查已完成。剩余真实审批显示/点击、修复后新创建答复与通知、session restore/当前归档、多项目及多人业务组合、浏览器可见性不能用API/fixture替代。目标未完成，当前等待恢复可用桌面及真实用户入口；已有授权和全部验收范围保持，PR #48继续草稿，不合并发布。

2026-09-19 E40：桌面仍不可用期间，核对并保留既有SIGKILL/状态锁证据，不重复同项；补独立二进制真实磁盘满的配置写失败、原值保留、释放空间重试及重启恢复。16项限定检查通过，测试脚本自身失败单列，临时磁盘卷已卸载清理，生产配置/进程未变。见[E40](live-evidence-e40-disk-full.md)。已逐行修正E39在B/N/T矩阵里的过时未验表述；真实审批、创建答复及会话组合仍待验，目标保持active。

2026-09-19 E39：继续在 `fix/multi-project-live-validation` / PR #48 进行真实验收，并同步更新中英文 README 的安装、飞书业务与 Web 配置说明。E38 的弹窗反馈和新任务原文保真已有独立真实复验；A1 普通审批阻塞时 A2 使用编辑后配置完成产物检查。新增创建答复恢复、投递事实、通知语义和审批选项失败已单列修复，不能以执行最终成功覆盖。真实非当前 pi 归档通过，恢复/当前归档及正确审批点击仍待验；702 项检查、SEA 和三平台 CI 通过，新二进制已部署；后台审批刷新有独立证据，两个测试群和执行器已清理、原配置恢复。详见 [E39](live-evidence-e39-source-approval.md)，目标保持 active，不自动合并或发布未完成必要复验的改动。

2026-09-19 E24 后续整改：继续在 `fix/retained-group-cleanup` 修复已关闭执行器后仍保留群的再次清理与外部解散回读，以及真实模型暴露的强制工具选择持续到整轮结束、生命周期通知缺少写工具而无法生成的问题。通知依据真实任务/参与者快照，只读工具边界保持；普通用户请求的写证据检查保持。当前现场使用独立状态库和专用群，经真实飞书、pi 模型与 herdr 验证服务组件；不冒充飞书用户入站验收，LIVE-001-R4 仍待真实消息。最终离线检查 453/453 通过，`15f29b3` 的 `0.3.12-dev` SEA 已通过独立烟测并重启，PR #39 跟踪本轮修复；按用户要求同步更新中英文 README 的 myrix 安装、飞书业务和 Web 配置边界，现场状态不再混入入门说明。详情见 [E24 记录](live-evidence-e24-retained-group.md)。

2026-09-19 E25 后续整改：修复飞书长连接 ready 后 terminal failure 不触发服务级恢复的问题，并校验 tasks 关闭时旧兼容桥的回复路由和 pane/session 绑定。最终离线检查 457/457 通过；注入式连接回归验证旧平台停止、授权/订阅重试和 shutdown 取消，旧桥回归验证回复绑定优先及替换目标拒绝。真实飞书网络断线和 LIVE-001-R5 用户入站仍未验证，详情见 [E25 记录](live-evidence-e25-transport-legacy.md)。

2026-09-19 E26 真实 REST 验收：使用当前服务应用凭据创建唯一飞书任务和群，读回任务、群和消息，完成→重开→再完成，删除群并确认 `dissolved`；服务收到对应任务事件但没有生成本地 pi 任务，既有状态与 herdr pane 未改变。群成员读取因应用缺少 `im:chat.members:read` 返回 `99991672`，按权限缺口记录，未将失败吞掉。该证据只覆盖限定的 Feishu REST 资源生命周期，不关闭真实用户私聊、模型自主工具选择、pi 新项目或 B/N 完整组合；详见 [E26 记录](live-evidence-e26-feishu-rest-lifecycle.md)。

2026-09-19 E27 入口提示：确认当前生产服务 bot 在配置主聊天中发送并读回 LIVE-001-R5 唯一提示；发送后 30 秒没有用户 marker 入站。此前另一个 lark-cli bot 的 P2P 提示已明确排除。该证据只确认正确应用的提示可见，不关闭真实用户入口，详见 [E27 记录](live-evidence-e27-service-ingress-prompt.md)。

2026-09-19 E28 模型决策复验：当前 `kimi-k2.5` 真实模型在隔离探针中连续三次首选 `task_create`，参数检查通过，工具实现均在执行前拦截；历史“零工具调用”决策故障未在该输入复现。该证据不替代飞书用户入站和外部资源回读，详见 [E28 记录](live-evidence-e28-real-model-tool-decision.md)。

2026-09-19 E29 边界回归：任务键和创建锁按 pi `sessionId` 隔离并兼容同 session 的旧键重试；已解散群的消息和卡片在入口及执行前拒绝进入主 session；旧桥只呈现可接管的 Claude/Codex agent，损坏路由失败关闭。`npm run check` 通过 464/464；这些是本地自动化证据，不关闭真实飞书用户入口和外部资源链路。

2026-09-19 E30 真实长消息：当前 `cfc7d16` 的 macOS arm64 `0.3.12-dev` 经真实飞书用户入口创建专用讨论任务，Codex 输出 6108 Unicode code points，outbox 分成 `[3500,2608]`，两条群消息 REST 回读顺序正确且无重复；用户确认完成后任务、参与者、herdr pane 和群均完成清理。该证据只关闭 FSH07 长分片子项，重复 event、空 messageId、卡片重放和断线重连仍未验，详见 [E30 记录](live-evidence-e30-long-message.md)。

2026-09-19 E31 主入口 `/clear`：当前 `cfc7d16` 的真实飞书主私聊 exact `/clear` 未调用模型，旧 pi session 已归档、新 session 已创建并选中，客户端只显示 `CLEAR_NEW_SESSION_OK`；旧任务、群和 herdr session 未被关闭。该证据只关闭 FSH05 正常轮转子项，详见 [E31 记录](live-evidence-e31-clear-command.md)。

2026-09-19 E32 手动讨论通知：真实飞书创建 Claude/Codex 双参与者 `manual` 讨论，两者的新目录信任提示均由 pi 自动确认。后续在 `2900d8b` 的 `0.3.13-dev` 上，真实群消息经 task_get→participant_send 将要求投递给 Codex，两个指定 marker 均已看到；群内用户确认后，两次 herdr close 和删群操作均 done，任务 destroyed、两参与者 gone、groupDeleted=true，测试资源已清理。该证据覆盖手动安排下一位及默认收尾，不冒充自动轮转验证。旧“无需操作”通知 R-F 保留，本轮后台通知又在执行器和群关闭前声称“已完成收尾”，新增 R-F 不被最终成功覆盖。详见 [E32 记录](live-evidence-e32-manual-discussion.md)。

2026-09-19 E33 单 Codex 讨论与完成误报：真实飞书入口创建无项目单 Codex 受控讨论，原生 transcript 只有指定 marker、零工具调用，初始 receipt verified、署名群输出和用户确认后的 herdr 关闭/群删除均有指定任务证据。但完成回合先用错 ID，查询后成功完成了真实清理，最终 inbox/turn receipt 却失败并称“本轮业务未执行”；保留新增 R-F。创建时“已完整转交”和删群前“已完成收尾”的事实措辞问题也继续跟踪，详见 [E33 记录](live-evidence-e33-n02-codex.md)。本地 task_create 的 accepted/queued 不证明远端任务/群存在或参与者初始投递成功。首轮业务意图、回执事实校验及失败后成功恢复的修复已在 `2900d8b` 部署；E33 的同轮失败后成功恢复已由 E34 后续受控错误编号→查询→正确完成的独立真实回合复验，不以早前创建答复恢复替代；原失败仍保留。仅补 N02/B06/B07/B10/B12/B13 的限定 R-部分，完整 B01–B18/N01–N07 目标保持 active。

2026-09-19 E34 事实恢复：真实主私聊经 task_create→task_get 后，模型仍草拟“已完整转交限制”；`2900d8b` 的运行时拦截该草稿、触发再次 task_get，并只投递承认 initialSent=false 的纠正答复，未重复创建任务。用户已在群内处理普通菜单，目录信任自动确认、初始投递 verified、marker 和用户验收均有证据；受控错误编号先 task_missing、后查询并正确 complete 的回合最终 done/finished，资源 destroyed/gone/groupDeleted=true，真实 REST 回读远端完成和群 dissolved。当前仍限定 R-部分，详见 [E34 记录](live-evidence-e34-runtime-recovery.md)。后续通知护栏及任务标题边界修正 `0b3c457` 已通过 557 项自动化测试、SEA烟测并部署为 PID98996；真实模型加合成快照探针通过；生产两条收尾通知候选未通过校验并记 unavailable，被拒正文缺失，不能排除误判，正常通知生成和送达仍未通过。精确版本、构建时间和SHA见E34，不将部署或探针通过视为完整现场通过。完整目标保持 active。

2026-09-19 E35：`259b377` 的 `0.3.13-dev` 经真实主私聊 tasks_list→task_action destroy→task_get，完成指定取消/销毁子场景。两条后台通知按“进入销毁收尾/即将解散”分别在 herdr close 和删群前送达，两个阶段 processed、无 rejection；主回合 done/finished，真实 CUA 和 REST 确认群解散、执行器 gone，飞书任务 completedAt=0 且无 completion 操作。四条旧历史和空讨论目录保留，零审批记录不算审批失效验证。完整检查 566 项、SEA 烟测和三平台 CI 通过，部署 stamp 见 [E35 记录](live-evidence-e35-destroy-notices.md)。仅 destroy 指定子项 R-P；E34 原失败与正文缺失保留，修复后的 complete 全链路通知及其他组合仍分验，完整目标 active。

2026-09-19 E36：`2e621e1` 的 `0.3.13-dev`（602 项完整检查、SEA 和三平台 CI 通过）经真实入口创建带引号 Codex 的单参与者受控讨论；旧目录信任现场拒绝后自动确认新现场、initial verified、原生零工具 marker 和群可见输出有证据。群内用户确认后 complete→task_get、两条正确阶段通知 processed/delivered、herdr close、群删除及真实 REST completedAt/group dissolved 的限定完成通知子链 R-P。但主私聊创建回合 inbox failed/model_failed，事实护栏拒绝了两份候选答复，当时疑似误拒，创建阶段保留 R-F；后续修复及独立复验见 E37，不以最终资源清理改写旧失败。详见 [E36 记录](live-evidence-e36-completion-notices.md)。完整目标 active，未声称全矩阵通过。

2026-09-19 E37：`772163d` 修复 E36 创建答复误拒，完整检查 609 项、SEA 和三平台 CI 通过。独立真实主私聊 tasks_list→task_create→task_get 仅创建一次，已建群与初始投递未确认的准确答复 delivered；目录信任、初始 verified、原生零工具 marker、群确认 complete→task_get、两条通知 processed/delivered、herdr close 与群删除均有指定证据。真实 REST 于 11:51:04.164Z 确认 completedAt1789818588000/group dissolved，两 inbox done；限定创建到清理子链通过，E36 原 R-F 不改写。详见 [E37 记录](live-evidence-e37-create-delivery.md)。单参与者 welcome 仍写轮到他人，保留 B10 其他措辞边界；全库 active tasks/pending inbox 为零仅作资源回读，整体目标 active，不代表全矩阵通过。

E21 现场新增失活执行器阻断完成/清理的问题，已补修复与421项自动化检查；真实失败、订阅事件未到达和后续复验在 [E21记录](live-evidence-e21-release.md) 分别记录。未经最终验收不合并，未知投递不重发。

2026-09-18 E21 审查整改：启动飞书长连接后订阅当前应用负责的任务，订阅失败沿原连接清理与重试流程处理，成功前不启动调度。普通后台任务和群查询遵守 `tasks.pollIntervalMs`，失败尝试时间持久化，重启不清空冷却；真实事件和显式完成/重开操作即时同步，执行器观察与资源清理不等待远端轮询。403 项自动化及格式、类型、lint、行数检查通过；真实订阅事件验收与最终 HEAD CI 另行记录，通过前不合并。

完成 herdr-agent 的 Node / TypeScript + pi 重构，实现
[业务场景与需求清单](node-pi-refactor-requirements.md) 中的现有及新增业务场景，
交付可验证、可评审、可独立分发的程序。

pi 仅负责 herdr-agent 本工具的业务。项目需求讨论、方案、开发、测试和评审由
herdr 托管的 Claude / Codex 执行，不替换或绕过 herdr 的托管职责。

2026-09-19 E38 进行中：真实 Web 保存并编辑多目录项目，已有 A1 blocked 时另一 pi session 的新项目 B1 仍完成登记、建任务、建群和启动 Codex。发现配置弹窗错误不可见、pi 改写主目录双文件要求、目录别名及窄屏信任识别失败，均保留 R-F。已补原文快照传递、弹窗反馈和受限目录确认修复，隔离真实 Codex 原文冲突验证通过且专用执行器已清理；不替代飞书新任务验收。`261771d` 的 `0.3.14-dev` 已通过 639 项完整检查和 SEA 烟测并部署；B1 在同一旧执行器上由 pi 自动确认目录，真实 Codex 产物/Python检查及飞书消息回读通过，停 review。A1/B1 已外部删群并由 herdr 清理，默认项目恢复，目录和历史保留。桌面窗口 cgWindowNotFound 导致真实 UI 复验暂停，目标仍 active；详见 [E38 记录](live-evidence-e38-multi-project.md)。

## 用户明确要求的硬约束

- 使用 Node 技术栈，统一前后端语言，使用 pi 实现调度。
- 支持多个 pi session，以及讨论任务和 Claude / Codex 多参与者协作。
- 实现业务场景清单，保留身份隔离、人工审批、投递回执与故障恢复等必要语义。
- 精简日常命令，同时保留无模型依赖的必要诊断和控制能力。
- **启用 AI 时，普通业务沟通由模型决定。** 程序提供工具及确定性约束，不生成固定业务答复或替代模型决策。若模型输出可识别的业务完成性声称却没有本轮工具事实，运行时只做来源审计并触发一次工具受限重试；仍无工具调用则记录模型失败，不发送成功答复，也不改写模型文本。用户最新明确例外：主入口 exact `/clear` 是确定性会话命令，不交给模型。飞书审批卡片和无 AI 兼容路径保留确定性操作；Web 只承接本机配置，不承接业务操作。
- **启动新目录时，由 pi 读取真实屏幕并自动确认原生目录信任提示。其他所有确认选项必须发到任务群，由用户选择。** 自动工具只允许确认当前受管参与者的任务目录，必须核验执行器身份、目录、现场版本与投递阶段；不能转变为任意审批或按键工具。实际验证 Codex/Claude 的目录信任自动通过，以及普通审批在群内等待用户。
- **保留现有 Bypass 配置，仅对仍然出现的确认应用上述规则。** 用户明确选择不为这一变更关闭 Bypass；已被执行器 Bypass 跳过的审批不重新制造。
- **自动确认必须分别用真实 Claude 和 Codex 验收。** 2026-09-18 用户反馈仍需在群中手动点击；不能把手动放行后的执行成功记录为自动确认通过。覆盖启动状态变化后重新观察、模型暂时失败恢复及无编号菜单的人工导航；未知按键效果不得重放。
- **测试结束后清理测试群和绑定执行器。** 本轮专用群验收完成后应实际解散，并经 herdr 关闭相应 Claude/Codex session，回读确认；仍在复现问题的资源保留至验收结束。
- **新任务在 completed 完成确认后默认自动解散任务群；用户明确保留群时例外。** review 不触发收尾。任务、群及 herdr 托管的 Claude/Codex session 统一生命周期：包括用户手动勾选飞书完成在内，complete 默认通过 herdr 关闭对应执行器并解散群；任何原因群解散也必须清对应资源。强制明确保留是例外：keepGroup:true 只保留群，keepExecution:true 仅 complete 支持且有群任务须同时 keepGroup:true；无群任务例外。旧任务已有群快照兼容不暗改，解散前通知及未知结果恢复需验证。
- **连续创建不同项目互相独立。** 前一个任务正在运行或等待审批，不能阻塞后续项目登记、资源创建和执行器启动；多个 pi session 可并行调度。真实验收至少覆盖三个项目、一项运行/一项 blocked 时继续新建及多 session，不用单任务串行成功代替。
- **主机器人私聊自动压缩长上下文；飞书主入口私聊的 exact `/clear` 走确定性会话命令，不需要大模型。** 程序在事务内归档旧 pi session、创建并选中新 pi session，保留旧历史/回执。已接收排队消息仍属原 session，归档后尚未执行的消息拒绝执行，不改投新会话；后续新消息进入新 session。群聊不执行轮转；进入消息处理流程的群消息明确拒绝，非任务群未 @ 仍按路由忽略。Web 不提供 `/clear`、清空或 active session 切换入口；本地查看历史不影响任务或 herdr 会话。
- **主入口 `/clear` 实际归档旧 pi session、创建并选中新 pi session 成功后，面向用户只回复 `CLEAR_NEW_SESSION_OK`。** 该命令由程序机械执行，事务提交成功后返回这个确定性确认文本，事务失败或未完成不能送达成功标记。此要求覆盖此前“/clear必须由pi自主调用工具和生成文本”的要求；只对exact `/clear`例外，普通业务沟通仍由AI。旧模型驱动和冗长回复证据原样保留，E15 真实私聊机械轮转证据保留；旧 Web 轮转仅属历史范围，不计飞书入口通过，完整场景仍按矩阵逐项记录。
- **一般控制答复与生命周期通知简洁说明用户可见结果。** 默认不展示 scheduled、持久化、排队回执等内部术语，不因隐藏实现细节而夸大实际进展；用户追问诊断细节时再提供必要依据。
- 提供前后端一体的可执行文件交付，完成迁移、验证与文档。
- **代码模块化、规范化，每个代码文件不得超过 1000 行。**
  该上限覆盖应用代码、前端、测试和构建脚本；通过自动检查强制执行。
  模块按职责拆分，不通过压缩代码或拼接超长行规避限制。

实施默认与职责详见 [Node 设计](node-pi-design.md)，逐项场景、自动化与现场边界见 [验收映射](acceptance.md)。

2026-09-18 旧模型驱动方案的实际验收状态：E14 的 `2aa5337` 真实 Web `/clear` 已实际切换并仅回复 `CLEAR_NEW_SESSION_OK`，可见后 ACK 通过；真实私聊两次模型故障均未切换、未送成功。上游 Kimi 五小时额度耗尽，恢复时间未知，用户随后明确 `/clear` 改为无模型的机械轮转，当时新方案尚未部署；不能拿旧方案的额度阻塞判断新方案失败。E11 同名标记是切换后的另一次 canary，不能冒充新规范通过。当时 worktree 默认收尾受通知失败阻塞；E15 后续独立证据已确认该任务及本轮全部 9 个测试任务完成资源清理，旧阻塞记录仍保留。

E18 已部署版本记录（不含本次只读 Web 整改）：运行源码 `0b6966ff6509d3e7cdc0a26e5ba660d7b4e14392`，PID38264，构建时间 `2026-09-18T03:49:25.716Z`，SEA SHA256 `feb114e3c0fd08752533b48c85d07ff7072081e3af9b7b3824f7ccac95680069`。format/check（345项测试）、SEA smoke及[同提交三平台CI 35304636486](https://github.com/hewenyu/herdr-agent/actions/runs/35304636486)通过；03:51回读飞书连接/授权ready，herdr PID39037保持。收尾阶段提示修正已部署，真实模型受控回执单样本通过，尚不称生产收尾回复重验；旧R-F保留。主入口无模型机械 `/clear` 语义不变。E17新增3任务及此前9任务均已确认资源清理，整体目标active。后续文档提交不冒充重新构建。

E17 部署与验收记录：`.cache/live/e17-deployment.json` 固定运行源码 `a6018ec1f51affce2b4160a0aea1a6e4483bcb1c`、PID `32000`、构建时间 `2026-09-18T03:24:39.516Z`、SEA SHA256 `87cfcebabb4957380713b7aa57440d3d79357727f1d8d33b0b06dfd2de168505`。format、check（345项测试）、SEA smoke 及[三平台 CI 35303089613](https://github.com/hewenyu/herdr-agent/actions/runs/35303089613)全部通过；飞书连接及授权 ready，herdr 原进程保留。

本次修复区分参与者显示名与合法原生名称，将 agent.start 的明确名称拒绝归为 not_executed；只有明确重名拒绝才换用稳定名称重试。迁移参与者独立 ID 的操作归属统一纳入 retry事务、pending恢复、错误保留；短可见文本的宽度改为 unknown。E17 的5d1e96f二进制 CLI 28项只读及迁移8项证据保留原版本：迁移4项为真实旧数据的 R-local-copy、4项为合成故障 O，不是生产迁移／完整回退。旧样本仅3个destroyed任务，无pending。

E17后续独立证据已确认B/C从真实飞书请求到原生执行、产物、署名群结果、远端描述与review等待验收的限定链路通过，见 `cli-e17-r2-completion.json`、`independent-e17-completion.json`。C入站和创建时A仍attention，B原生回合尚未结束；A的原生名称拒绝及误unknown历史R-F保留。03:03模型已恢复200/精确标记，不继续沿用旧额度阻塞。任务群owner无@ exact `/clear`拒绝也为限定R-P。

随后A/B/C均完成已授权资源清理，`e17-cleanup-readback.json`最终快照全true；B通过真实任务群无@完成指令调用task_action，回复送达和herdr close均早于删群。原9加本轮3共12群dissolved、panes缺失、pending outbox为0；inventory-e17两次remote GET400在03:45串行回读均200/completed，原失败保留且原因不确定，见 `test-resource-inventory-e17-read-errors.json`。

新增措辞R-F仍未关闭：B回复首句“已完成收尾”早于群解散，尽管正文说明尚未解散；实际最终清理成功不能覆盖该阶段事实错误。提示修正已在E18部署并通过345项check、真实受控回执probe单样本；尚未重验生产收尾答复，详见E18。a6018ec部署和345项测试/CI证据保留；整体目标active，详见[现场矩阵](live-validation.md)及[版本化证据 E17](live-evidence-2026-09-18.md)。

E16 历史进展：运行二进制已更新为源码提交 `5d1e96f1698af95ad0fa2317b34b73441518e968`，PID `26077`，构建时间 `2026-09-18T02:52:38.355Z`，SEA SHA256 `c165c6424037337cda912bc4471731fb7d0dfdc250c9e083148e8922b2c39ec5`。format、check（329项测试）、SEA smoke 和[同提交三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/35301019616)全部通过；重启后飞书连接及授权 ready，herdr 原进程未重启。两专用群真实复现并验证删群回执丢失后的跨进程恢复，各仅一次 DELETE，最终均 dissolved；恢复只凭匹配群的 fresh GET 事实，保留原错误审计及其他未决问题。Web 身份隔离、17项 API 作用域检查、会话创建/重命名/归档/恢复和显式清空已补验，三个测试会话已归档并恢复原选择。memory 15项 loopback 协议检查仅为 O-P，外部服务仍未测。重启后原9个测试任务清理状态再次回读通过；原失败和未覆盖分支保留，整体目标 active。详细边界见[现场矩阵](live-validation.md)和[版本化证据 E16](live-evidence-2026-09-18.md)。

E15 历史部署与验收记录：`ab79cc0470f28c65473fc3810e6b8e39dc0a296f` 已按原部署运行，PID `20390`，构建时间 `2026-09-18T02:25:03.576Z`，SEA SHA256 `04d14c861c91c980038c9e659de68a86b531216c39f6c2b971444700adf20358`。`npm run format`、`npm run check`（315 项测试）及 SEA smoke 通过；[CI 35299218668](https://github.com/hewenyu/herdr-agent/actions/runs/35299218668) 已在同一源码提交的 linux_amd64、linux_arm64、darwin_arm64 三任务通过 check 与 SEA。E15 已独立回读真实私聊/Web机械轮转及本轮 9 个测试任务的资源清理；未测的整体功能项仍保留，目标 active。

修复同时覆盖 AI 关闭时旧归档 session 的排队命令拒绝，以及 Web 省略 sessionId 后用相同 requestId 重试造成重复轮转：按 owner/chat/messageId 加命令锁，命令回执与轮转同事务写入，重复请求复用原答复。`before_close` / `before_group_delete` 仅在通知生成失败、尚未发送时写入 `unavailable` 审计并继续已授权清理；不生成固定替代通知，不记录虚假送达。已尝试但结果未知的发送、未完成输入/输出和原生最后结果的投递屏障仍保留，不能借模型故障跳过。真实私聊/Web机械轮转及 worktree 收尾已独立回读通过，本轮 9 个已知测试任务均完成资源清理；两类不可用通知没有伪造送达。未测功能继续按矩阵推进，目标仍 active。

## 完成条件

1. 按最新飞书业务/只读 Web 边界逐项建立实现与验收映射；撤销的 Web 业务不再扩展。
2. pi session、任务、参与者、群与 herdr 资源关系明确，数据可恢复。
3. 讨论、单参与者执行、多参与者调度、人工审批和任务收尾可验证。
4. 原有配置、持久状态和回执有明确迁移及回退路径。
5. 类型检查、代码规范、1000 行限制、业务回归与二进制烟测通过。
6. 业务验收由真实飞书用户入站、群内交互及实际回读组成；保留 Web/API 与离线证据，但不把它们算作飞书业务通过。Web 配置与历史浏览另验配置 action 白名单、CSRF/Origin/Host 防护、密钥不回传和无业务副作用。
7. 普通AI业务入口不以业务关键词生成答复或抢占模型决策；仅对缺少工具事实的可识别完成性声称做来源审计和一次受限重试，主入口exact `/clear`按用户明确要求例外使用确定性会话轮转；格式化和lint必须实际通过。

新增需求在此文件持续记录，并落实到实现和验收。当前目标工具不支持修改已创建
目标的正文，本文件作为该目标的持续约束与验收记录，不代表另建独立目标。

## 上一阶段交付证据（历史记录）

- 现有 B01–B18 与新增 N01–N07 均有实现、测试依据及现场边界，逐项见 [验收映射](acceptance.md)。README、配置与部署模板、设计、迁移回退说明和历史源码链接已同步到 Node 实现。
- 最终执行 `npm ci`（152 个包）、`npm run format`（152 个文件，无修改）与 `npm run check`。157 个源码文件均满足 1000 行上限，严格 TypeScript、Biome 与 170 项测试通过；0 失败、取消、跳过或待办。`npm audit` 为 0 项漏洞，`git diff --check` 通过。
- 最终 `npm run binary`、`npm run smoke` 在 macOS arm64 通过。从无源码、无 node_modules 的临时目录运行单个可执行文件，验证原生锁、SQLite、嵌入前端、Web/CSRF，以及二进制内真实 pi 对接本地 OpenAI Responses / Anthropic SSE 替身和 Web ACK。当前产物使用 `dev` 构建标记。
- 隔离环境的真实 Chromium 验证四个页面、创建 session、聊天与 ACK、390px 移动宽度；无横向溢出或 pageerror。
- release 工作流包含二进制、项目许可、实际依赖与 Node 原文声明、文档、部署模板和许可来源说明；Linux x64/arm64 原生构建与烟测已配置，尚未执行，未发布远端 release。

上述阶段完成范围是实现、文档及当时的本地离线验证；当时未连接真实飞书、生产 herdr 或外部模型服务，未读取或迁移真实 `~/.herdr-agent`，未启动生产 WebSocket。这是历史时点说明，不是后续现场操作记录。真实注册授权、双执行器群聊、模型业务交接、审批、服务管理器及长期运行不能由这些离线结果推定通过。


## 2026-09-18：逐项修正与真实验收目标

用户新增要求：创建持续目标，循环修正每个功能点并逐项验证。主代理已创建新的持久目标，状态 active；本文件与 [逐项真实验收矩阵](live-validation.md) 维护其范围、已知问题和完成证据。

本轮覆盖飞书中的 B01–B18、N01–N07、pi 工具和 AI/无 AI/已有 agent 兼容入口，以及必要 CLI 安装维护和只读 Web WR01–WR09。旧 W01–W29 的业务页面/API 扩展撤销。每项分别核对正常、失败、恢复、权限和投递；实现存在、历史离线通过、当前离线通过与真实通过分别记录。此前 170 tests 和本地预制模型 SSE smoke 仅保留为历史离线证据，不证明真实模型自主调用正确工具或项目业务已经完成。

### 已知现场问题

- LIVE-001：提供的飞书事件记录标注 23:28（日期/时区随原始证据补齐）。用户要求新项目、Codex 制作 HTML 比武页面；inbox done、outbox delivered，但 checkpoint 无 toolCall，operations 为空，没有对应新任务/群；模型回复虚构旧任务 ID 和排队状态。判定真实调度与事实答复失败，不能以文字回复成功关闭目标。
- LIVE-002：该次现象发生时 Web 使用允许名单首个 owner，第二位允许用户的飞书任务不会自动显示。本轮已新增显式身份选择，E16 实际浏览器 A/B 切换、各自会话/任务和草稿隔离、刷新选中持久及17项 API 作用域检查通过；迟到回复/ACK竞态与撤销授权仍未验。原现象不以取消 owner 隔离处理，也不能用该差异解释 LIVE-001 的无对象事实。

### 本轮执行与完成条件

1. 保留可复现的完整请求和阶段事实；先修复“无工具执行却声称成功”，使用真实已配置模型重验请求到工具、ledger、herdr、远端资源、项目产物和用户可见结果的完整链路。
2. 每个矩阵项先记录问题及影响，再修复、做针对性离线回归、构建当前提交并按实际外部环境验证；失败恢复不得重放已尝试但未知的写操作。
3. 不把模型自述、参与者自述、启动ready、inbox done、outbox delivered或预置toolCall中的任意单层证据当作整个业务端到端成功。
4. 业务入口不对齐在飞书/pi 工具中收口，包括会话归档/恢复和关联开发。旧 Web 的 newProject/parentTaskId 表单及7项输入边界测试保留为历史，不继续做 Web 业务联调；网页与服务端共同禁止业务写入。
5. 现场动作、构建版本、脱敏对象ID、观察到的副作用、失败/恢复结果和用户可见回执可关联；未测/受阻项明确保留，不能用测试总数整体勾选。
6. 所有用户承诺功能完成逐项验证，或由用户明确调整范围，才能将本轮持久目标标记 complete；当前仍为 active。

本轮文档盘点已完成入口清单与遗漏账本，见 [live-validation.md](live-validation.md)。该盘点本身没有启动服务、建群、发送消息或进行新的真实功能验收。此前 Web 新项目/关联讨论输入边界7项测试保留为历史离线证据；这些业务入口现已撤销范围，不再补 Web 业务验收，当前仅补配置 action 和历史浏览验收。E19 的 Web 单 Claude 父讨论已完成旧本地 API 维护清理，独立只读回读 11 项通过；未继续子开发，不计真实飞书入口通过，模型误推断 keepGroup:true 的 R-F 仍待真实复验。
