# 功能逐项整改与真实验收矩阵

更新时间：2026-09-19。状态：**本轮目标仍进行中；E21-R2 事件订阅、E22 当前二进制讨论链路、E30 长消息分片与默认收尾、E31 主入口 `/clear` 机械轮转已有限定真实证据，其余未覆盖场景仍未关闭。** 范围继承 [重构目标](refactor-goal.md)、[B/N 需求盘点](node-pi-refactor-requirements.md) 和 [设计](node-pi-design.md)。本文件是新的逐项追踪表；[此前验收](acceptance.md) 保留上一阶段离线证据，不代表本轮真实链路已通过。

2026-09-19 E24：修复保留群在执行器已关闭后的再次清理、外部解散回读及终态描述；另由真实模型复现并修复强制工具恢复循环与生命周期通知的证据误用。最终 `npm run check` 453/453 通过（含行数、TypeScript 与 Biome），首次 452/453 的终态错误残留回归及修正已记入 E24。两条隔离真实组件链路已验证 Codex 结果、完成后保留群、再显式/外部解散，测试群和对应 pane 均已清理。普通用户写工具护栏保持；本次未走飞书用户入站，B12/B14/B10 仅补服务组件证据，LIVE-001 与其余 U/R-部分不关闭。[E24 记录](live-evidence-e24-retained-group.md) 保留准备失败、通知失败和回读边界。

2026-09-19 E24 部署：功能提交 `15f29b31383adfd0cda416bb59eaaa71fafd6939` 构建的 macOS arm64 SEA `0.3.12-dev` 已通过独立烟测并重启为 PID `37384`，构建时间 `2026-09-18T18:20:23.267Z`，SHA256 `3620789d387f5b5bea4f6f496732f72c88f63f8b41080fc9388c7e79d7649122`。运行路径 `build/e24/herdr-agent`，`dist/herdr-agent` 已同步同一产物；`version --json`、`doctor --json`、HTTP runtime/authorization ready 均回读。生产 SQLite 中 23 任务 destroyed、23 群 groupDeleted=true、25 参与者 gone/2 removed、177 outbox delivered；这些是本地状态读回，不冒充本轮逐群远端验证。herdr agent 列表为空，原有 `w1:p1`、`w2:p1`、`w2:p2` 保持。PR [#39](https://github.com/hewenyu/herdr-agent/pull/39) 已创建；真实用户入口标记仍未观察到，相关场景继续待验。

2026-09-19 E25：修复 ready 后飞书长连接 terminal failure 不会触发服务级重连的问题，增加连接代次、一次性故障通知、旧平台停止、授权/订阅重试和 shutdown 取消回归；同时修复 tasks 关闭时旧兼容桥的回复路由覆盖和 pane/session 替换校验。最终 `npm run check` 457/457，定向 Feishu/CLI/legacy 回归 31 项通过。[E25 记录](live-evidence-e25-transport-legacy.md)仅记本地注入式故障与兼容路径，不关闭真实飞书断线或用户入口验收。

2026-09-19 E26：使用当前服务应用凭据运行真实 REST 生命周期脚本，创建唯一测试任务和群，读回任务/群/消息，完成→重开→再完成，删除群并确认 `dissolved`；服务同步收到 5 个对应任务更新事件且未生成本地 pi 任务，原有 23 个任务、27 个参与者和 177 条 outbox 未改变。群成员列表因应用缺少 `im:chat.members:read` 返回 `99991672`，记录为明确权限缺口。该证据只关闭限定的 Feishu REST 资源步骤，不代表真实用户私聊、模型工具选择、pi 建项目或 B/N 完整组合。[E26 记录](live-evidence-e26-feishu-rest-lifecycle.md)

2026-09-19 E27：向当前生产服务配置的主聊天发送唯一 LIVE-001-R5 提示，并用同一服务应用读回 sender/chat/body；随后观察 30 秒没有用户 marker 入站。此前另一个 lark-cli bot 的提示不计入本服务入口。该记录只证明正确应用的提示送达，LIVE-001 仍等待真实用户回复。[E27 记录](live-evidence-e27-service-ingress-prompt.md)

2026-09-19 E28：当前配置模型 `kimi-k2.5` 的真实首步探针连续三次均选择 `task_create`，参数保留新项目、Codex 和“不用测试”；工具实现在执行前拦截，没有外部写入。历史零工具决策问题在此隔离首步未复现，但该证据不关闭 LIVE-001 用户入口或完整资源链路。[E28 记录](live-evidence-e28-real-model-tool-decision.md)

2026-09-19 E29：补充自动化边界回归。任务键和创建锁加入 pi `sessionId` 后，相同 request ID 的不同 session 可并行创建不同项目且互不串行阻塞；升级后的旧任务键在同 session 重试仍保持幂等。已解散群的迟到消息和卡片在入口及执行前均忽略，不创建主 pi session、不消费审批；旧桥 `/ls` 不再暴露无 kind 的 shell pane，损坏的历史路由统一失败关闭。当前 `npm run check` 通过 464/464。以上均为本地回归，不替代真实飞书用户入口、模型和 herdr 端到端验收。

2026-09-19 E30：当前 `cfc7d16` 的 `0.3.12-dev` macOS arm64 二进制经真实飞书用户私聊创建专用讨论任务，Codex 在真实任务群输出 6108 Unicode code points。outbox 持久为两片 `[3500,2608]`，真实 REST 回读两条消息均存在、顺序正确、无重复；用户随后真实确认完成，任务 `completed_at`、本地 `destroyed`、参与者 `gone`、herdr pane 关闭、群 `dissolved` 均已回读。详见 [E30 记录](live-evidence-e30-long-message.md)。该记录只关闭 FSH07 长分片子项，重复 event、空 messageId、卡片重放和断线重连仍 U。

2026-09-19 E31：当前服务实例收到真实飞书主私聊 exact `/clear` 后未调用模型，旧 session `s_2d0d2bc7…` 归档，新 session `s_26c0b10c…` 选中，用户与回复均 `delivered`，客户端可见回复严格为 `CLEAR_NEW_SESSION_OK`；旧任务、群和 herdr session 未受影响。详见 [E31 记录](live-evidence-e31-clear-command.md)。该记录只关闭 FSH05 的正常主入口子项，失败事务、旧队列、重复事件、群拒绝与重启恢复仍分验。

2026-09-19 v0.3.11 离线检查记录：功能发布基线为 `2a5bbd0`。`npm run check` 通过 440/440 项（单文件行数、typecheck、Biome lint 和测试）。这只是该发布基线的离线检查记录，不代表后续修复检查结果或新的现场飞书业务验收，因此不关闭仍未真实验证的矩阵行。下面保留的 2026-09-18 运行记录是历史部署 stamp，不能当作当前 HEAD 的运行证明。

2026-09-19 E24 前本机重启：提交 `2a5bbd0fbe6124a4691be7fd9e64ca1c84b6dc11` 构建的 macOS arm64 SEA `0.3.11-dev` 已重启，PID `6323`，SHA256 `a6a89894350de6abc8437bd53880bef31271e296f07efcc41b65c890f49bc593`，构建时间 `2026-09-19T01-10-00+08:00`。`version --json`、`/api/state`、runtime/authorization ready 和独立 SEA smoke 已回读；该 stamp 与当前功能提交匹配，真实飞书业务场景仍按矩阵逐项验收。v0.3.11 的三平台 Release Action 和 npm 安装验证已另行完成。

2026-09-18 历史运行检查：仓库 `master`/`origin/master` HEAD 为 `f2afb9b`；运行中的 macOS arm64 SEA `0.3.6` 由旧提交 `e7e8b3e` 构建，构建提交为 `e7e8b3e`，SHA256 `cee2c5cd1287be2b79cbb1b2ed4487025f47baaf974783c45cb6641b66df882d`，PID `91732`；`/api/state` 的 runtime/authorization 均为 `ready`。本地 23 个任务均为 `destroyed`，177/177 outbox 已送达；本地任务对应的 23 个群及缓存中 5 个历史专用群均经真实 Feishu GET 回读为 `dissolved`。这条记录只更新当时的现场基线，不关闭仍未真实验证的矩阵行；LIVE-001 仍需当前生产服务 bot 对应的真实用户从主私聊发起唯一 marker 后核对 checkpoint/toolCall、task/group、herdr 和用户可见回执。

本次更新核对 E19/E20 的只读 HTTP、真实 Chrome 浏览和定向状态快照，并保留此前飞书 REST、真实模型和资源回读的版本边界。历史业务证据见[2026-09-18 证据分层记录](live-evidence-2026-09-18.md)，本轮 pi 工具事实修正见[现场证据](live-evidence-pi-tool-recovery-2026-09-18.md)，只读 Web 的已测范围与未测项见 WR01–WR09。文档更新本身没有新增外部任务；主验收仍在进行，尚未记录的现场步骤保持 U。

2026-09-18 E23 发布后重启：仓库 `master`/`origin/master` 为 `452aae9`；macOS arm64 SEA `v0.3.7` 已从该提交重建并重启，PID `31577`，SHA256 `f717b402b2cc82f6fc815046d0b20eef4287c751238cb5593a2f0a4a9a412aec`。`version --json`、`/api/state`、runtime/authorization ready 和 `npm run smoke` 均已回读。状态库仍为 23 个 `destroyed` 任务、177 个已 `delivered` outbox；本条只更新部署基线，不把 LIVE-001 或其余未覆盖矩阵行标记为通过。

2026-09-18 范围纠正后的当前边界：**真实业务全部在飞书私聊或任务群发生。** Web 可浏览、筛选会话记录，并维护受保护的本机配置：本机身份、项目及多目录、默认项目、Bypass、模型连接；不能发消息、创建任务或参与者、审批、清理资源或操作 pi session，不提供业务 `/clear` 入口。配置 action 仅接受 loopback、Host/Origin 和 CSRF 校验并通过 allowlist；浏览历史本身不得改变 active pi session、任务或投递事实。旧版只读页面的部署与检查仍保留在下文作为历史，不能证明当前配置页面已经完成现场验收。

业务入口验收必须由真实飞书用户入站/群内交互触发，再关联工具与操作回执、执行器现场、平台资源和实际回读。旧 Web/API 成功、故障、产物和清理事实继续保留，但不得计为飞书业务入口通过；历史 R-P 只在原证据范围内有效。CLI 安装维护、离线故障测试和只读 API 核对仍分别记账。

E19 撤销范围前的历史记录（以下“尚无真实模型复验”指该样本当时的状态）：E19 只在 Web 创建了单 Claude 父讨论，后续 Web 子开发停止。该次是旧入口偏离的记录，不计飞书业务验收；旧本地 API 维护清理后的独立回读已确认该任务 destroyed、远端完成、群解散、准确窗口不存在、群 outbox 无待发送，专用 Web session 已归档并恢复旧选择（`.cache/live/e19-cleanup-readback.json`，11 项通过）。该新增资源单独记账，不套用 E17 快照；“等待验收”被模型误转为 keepGroup:true 的 R-F 继续保留，提示修正尚无真实模型复验。

当前只读 Web 证据分两次部署记录：`.cache/live/e19-web-readonly.json` 对应 `acb6300`，HTTP 与真实 Chrome A/B 身份、会话历史、参与者署名及工具记录展开前后，11 个受检 namespace 的数量与内容 hash 全部一致。`.cache/live/e20-web-readonly.json` 对应 `a7e9ffb`，HTTP 阶段同样 11 项一致；浏览器阶段仅 `tasks`、`participants` 的 hash 变化，其余 9 项一致；未采逐行差异，不能确定变化原因。该文件保留 `browserReadOnly:false` 的原始全量比较结果，不能改称整段浏览全库无写入，也不能仅据后台任务变化认定浏览器执行业务。

`a7e9ffb` 在真实 Chrome 刷新后，身份菜单从本地时间 12:50 到 12:52 跨多轮轮询保持打开；随后切换 B、筛选归档并读取 `/clear` 前的 `s_be0b138d…` 会话 12 条历史。桌面中文长记录截图未见明显布局问题。此轮未测 390px 或 console；acb 版本轮询关闭菜单的失败与 a7 修复复验分别保留。后续 `0ccfff2` 的 format/check（378 项测试）及 SEA smoke 已通过并部署，现场证据按E20独立记录，不能直接沿用a7结果。npm 分发与发布恢复流程见 [releasing.md](releasing.md)，尚未据此声称已发布。

2026-09-18 E20追加：0ccfff2已部署，format/check 378项及SEA smoke通过，飞书连接/授权ready；真实父讨论→关联Codex开发→父完成而子资源保留已有证据。390×728窄屏历史浏览及刷新后Console限定检查已完成，原首次短输出超长失败保留、群内修订60字符通过。详见[本轮独立记录](live-evidence-e20-release.md)，后续b53终态描述修复已通过386项检查、SEA及真实子完成/原生手动完成回读；16专用任务群及20个执行器均已确认清理。正式发布结果另记。

## 1. 状态与证据规则

| 标记 | 含义 | 不能据此声称 |
| --- | --- | --- |
| I | 找到实现入口及其边界，尚不等于正确 | 用户功能已经可用 |
| O-H | 上一阶段历史离线证据；当时 170 tests 和烟测通过 | 当前修改后仍通过、真实模型自主选择工具、真实 herdr/飞书完整链路通过 |
| O-P / O-F | 本轮在指定提交重新执行的离线通过/失败 | 未实际接入的外部服务正确 |
| R-P / R-F | 指定真实环境中明确检查过的通过/失败 | 同组其他场景、其他 owner 或其他执行器也通过 |
| R-部分 | 只证实了部分真实链路 | 完整端到端成功 |
| R-local-copy | 实际二进制对真实旧状态的隔离副本验证 | 生产已迁移、运行旧服务回退或外部资源已恢复 |
| U | 未执行或证据不足 | 默认通过 |
| 撤销范围 | 用户已取消的产品入口或验收计划；原证据保留 | 继续扩展旧 Web 业务，或把历史通过算作当前飞书入口通过 |
| D | 产品语义/入口一致性待明确 | 已确认的程序缺陷 |

每个场景均保留“实现、离线、真实”三栏。代码改变后，受影响行恢复为待复验；不得把计划、存在测试文件、服务 `ready`、模型说“完成”、参与者自述或预制模型返回值作为验收成功。真实 pi 循环接本地 SSE fixture 属于离线集成：它验证协议与执行机制，不验证真实模型是否会自主调用正确工具。

每条运行证据记录：场景 ID、提交/版本/二进制 SHA256、时间及明确时区、入口、脱敏 owner/session/task/participant ID、输入原文、环境与数据前提、实际工具调用与结果、操作回执、外部资源观察、用户实际看见的回复、退出/恢复结果、证据位置、判定。不得在文档保存 API key、app secret 或原始进程环境。

## 2. 已知真实结果与整改优先级

| 记录 | 已观察事实 | 判定及后续验证 |
| --- | --- | --- |
| LIVE-001：用户经飞书要求新项目、Codex 制作 HTML 比武页面 | 提供的记录标注 `23:28`，原始事件日期/时区待补齐；inbox=`done`、outbox=`delivered`；checkpoint 没有 `toolCall`；所有 operations 为空；没有对应新 task/group；回复却引用了旧任务 ID 并声称排队 | **R-F：调度执行与事实答复失败；R-部分：接收和文本回复链路有回执。** 不能称新项目、建群或编码已开始。需保留原请求，修复后用实际模型重新执行并核对新对象；仅让 fixture 指定 `task_create` 不构成现场复验 |
| LIVE-002：Web 未展示第二位允许用户的飞书任务 | 该次现象发生时 `snapshot/localActor` 使用 `allowedOpenIds[0]`；飞书按消息 owner 绑定。已增加本机管理身份选择；E16实际A/B切换、列表隔离及17项API边界通过，竞态/撤权仍未验 | **R-部分：E16已验证本机显式身份切换及限定隔离，原现象不因此自动定性为缺陷。** 分别核对“对象是否存在”和“当前 Web owner 是否有权看见”；不能用 owner 差异解释 LIVE-001 中所有新对象均未创建的事实。不得为消除空列表而直接取消 owner 隔离 |
| BUILD-001：此前测试二进制 | `0.3.0-refactor`；commit `7689cee3163f7da0e02403645bd028c6066113ac`；UTC `2026-09-17T23:21:14Z`；macOS arm64；SHA256 `77f901b4eab28e845af7ba445c0332565dba825a53d667f76e0a2e25e6dc22d1` | 构建与隔离 smoke 的历史证据；不能证明当前运行实例仍为该二进制，也不能抵消 LIVE-001 |

新增实测分层：**Web→真实 Codex→HTML 产物→飞书群结果已走通一条链路；另有飞书一次安排三个新项目的真实创建与 A/C 产物证据，E16 补记其原始时间及边界。E17保留原核心输入并增加独立项目范围，A原生名称拒绝R-F保留；修复后B/C已核对产物、署名群结果、远端描述、等待验收和后续授权清理，另发现B提前声称收尾的措辞R-F**。这不关闭 LIVE-001 的历史 R-F，也不掩盖本轮发现的阶段事实错误。

| 记录 | 已观察事实 | 判定及后续验证 |
| --- | --- | --- |
| LIVE-003 / E05：Web 新项目 Codex 链路 | 真实新任务、herdr Codex、目录信任处理后产出 HTML；群 GET 存在署名最终结果；远端任务未自动完成 | 各阶段 R-P，完整功能组 R-部分；飞书入站创建、页面视觉验收、恢复/异常 U |
| LIVE-004 / E05：阶段事实错误 | 创建刚 accepted/queued 就声称远端资源和投递完成；welcome 未启动即称已开始；blocked 称仍在处理中；用户完成后通知仍称等待验收 | **R-F 历史保留**；提示词/工具描述和通知 participants 已修。E02/E03 真实模型+合成回执/事件通过，修正后真实服务同阶段复验 U |
| REST-001/002 / E04 | 第二轮真实创建任务/群、发消息、更新描述、完成/重开/再完成、解散，各有 GET；两轮测试群已清理、任务已完成 | 独立 REST 阶段 R-P；成员查询权限不足仍 R-F，不能宣称整轮通过或全部 TaskService 生命周期通过 |
| MODEL-001 / E01–E03 | 15 次主协议首步决策、1 次另一协议查询、1 次修订后首步；2 场景×2 轮状态追问、welcome/blocked/completed 通知 | 仅模型决策/事实措辞 R-P；原工具未执行，不能充当外部资源或执行器验收 |
| E11：54ae616 主入口与任务补验 | 263测试/三平台CI；真私聊clear及后续送达，Web/API clear与50000预算自动压缩，双模型查询并发，关联review/只读test | 各记录限定步骤 R-P，Web渲染未ACK、双讨论receipt unknown仍未过；旧R-F保留，见E11具体边界 |
| E12：29a7715 恢复与新失败 | 273测试/SEA烟测/三平台CI；原B只读恢复、R2一轮后暂停、明确保留群和两pane、test七项收尾检查 | 限定步骤R-P；Web clear回复未显示却尝试ACK为R-F；新R2 receipt位置、Web ACK及移除后resume修复均未部署 |
| E13：9a86e40 成员/浏览器复验 | 280测试/SEA/三平台CI；成员移除resume九项、新增完整首发七项、B后续清理、scoped与普通自然输入Web clear真实通过 | E12 ACK旧R-F保留；E13前文无scope禁工具致未调用的新R-F保留；普通AskUserQuestion标记A本人选择完整8项通过；R2收尾10项通过；review/worktree后续待证据 |
| E14：2aa5337 精确回复与服务故障 | 285tests/三平台CI；真实Web clear准确成功文本+可见ACK；worktree自动信任与实际多目录执行通过 | 私聊两次model_failed无切换/成功；上游Kimi五小时额度耗尽恢复未知；worktree通知失败阻塞收尾，全部旧R-F保留 |
| E15：ab79cc0 确定性 clear 与通知故障修复 | format/check 315 tests、SEA smoke 通过；机械 clear、AI关闭旧队列拒绝、Web省略sessionId去重、通知生成失败审计后继续收尾 | 真实私聊/Web无模型轮转及可见送达 R-P；worktree通知 unavailable 后清理 R-P；9 个已知测试任务资源清理通过；同一源码提交三平台 CI check/SEA 已通过 |

**已确认群策略：新任务 completed 确认后默认自动解散群，明确 keepGroup:true 保留，review 不触发；明确保留证据继续有效；旧默认/未知来源保留值在收尾时采用解散，不批量改写活跃旧任务。** complete（含飞书手动完成）默认经herdr清对应执行器；任意群解散也清执行资源。明确keepExecution:true保留执行器时，有群任务须同时keepGroup:true；解散前通知和清理回执分别核验，不能把登记完成当成群已删除。明确配置retain或显式操作证据仍保留；groupRetentionSource区分explicit/default/legacy，旧未知任务进入完成/关闭时按默认解散。E09 已有两条真实默认完成收尾及外部解散轮询回收证据；旧 REST 删除不替代它们，例外与未知结果仍分项验收。

**已确认连续创建要求：不同项目和 pi session 独立推进。** 一项任务运行或 blocked 时，后续任务仍须登记、创建资源并启动执行器；E09 已有 A/C 独立产物，E11 双 pi session 实际只读查询并发通过；E12 原 B 未重发恢复与 R2 一轮暂停通过；E13 新增首发和移除后resume已即时确认，不能把这些分支扩张为全部调度组合通过。

**E09–E13 历史会话语义（旧 Web 业务范围已撤销）：私聊自动压缩，当时私聊/Web聊天的 /clear 归档旧 pi session 并开启新 session。** 当轮回复持久后归档与切换，旧历史/回执保留；旧排队消息不改绑且因归档拒绝执行，当前 clear 答复仍可投递；群聊拒绝，Web 显式清空按钮继续使用原 session generation 重置。E09 旧拒绝污染的 R-F 保留；E10 只读旧历史探针通过后，E11 真实飞书归档切新及后续送达通过。Web/API归档切新和实际50000预算自动压缩通过；E12 不可见ACK旧R-F保留；E13 scoped与普通自然输入后的真实浏览器clear全链路通过，同时保留无scope禁止工具历史导致模型未调用clear的新R-F。

**当前规范：仅飞书主入口私聊 exact `/clear` 机械轮转，E15 真实私聊证据保留。** 程序确定性归档旧pi、创建并选中新pi，事务成功后仅回复 `CLEAR_NEW_SESSION_OK`，不调用大模型、不依赖模型额度；失败不得送成功。群聊拒绝，不清任务/herdr，旧历史/回执保留、旧队列不改绑。用户最新要求明确覆盖此前“必须由pi自主调用工具”的规范，普通业务沟通仍由AI。须验证无模型或额度耗尽时仍可成功、事务失败不送成功、旧回执与新会话隔离、群拒绝。一般控制/通知简洁说明用户可见结果，诊断在追问时再给。所有旧模型驱动成功/失败证据保留；E11后续canary不等于旧clear答复合规，飞书机械轮转以 E15 私聊独立证据为准；旧 Web 成功保留为历史，新 Web 不再提供命令入口。

E14 旧模型驱动方案的历史边界（当时新机械轮转尚未部署）：真实 Web 新规范已完整通过；真实私聊两次 model_failed、无切换无成功答复，503 上游明确 Kimi 五小时额度耗尽，恢复时间未知。worktree 执行产物通过，但默认收尾因通知生成失败停在 destroying，当时群和 pane 仍在。E15 后续独立回读已确认本轮 9 个已知测试任务均完成资源清理，不改写旧失败。

E15 历史实施记录：`ab79cc0470f28c65473fc3810e6b8e39dc0a296f` 已按原部署运行，PID `20390`，构建时间 `2026-09-18T02:25:03.576Z`，SEA SHA256 `04d14c861c91c980038c9e659de68a86b531216c39f6c2b971444700adf20358`。`npm run format`、`npm run check`（315 项测试）及 SEA smoke 通过；[CI 35299218668](https://github.com/hewenyu/herdr-agent/actions/runs/35299218668) 已在同一源码提交的 linux_amd64、linux_arm64、darwin_arm64 三任务通过 check 与 SEA。E15 已独立回读真实私聊/Web机械轮转及本轮 9 个测试任务的资源清理；未测的整体功能项仍保留，目标 active。

修复同时覆盖 AI 关闭时旧归档 session 的排队命令拒绝，以及 Web 省略 sessionId 后用相同 requestId 重试造成重复轮转：按 owner/chat/messageId 加命令锁，命令回执与轮转同事务写入，重复请求复用原答复。`before_close` / `before_group_delete` 仅在通知生成失败、尚未发送时写入 `unavailable` 审计并继续已授权清理；不生成固定替代通知，不记录虚假送达。已尝试但结果未知的发送、未完成输入/输出和原生最后结果的投递屏障仍保留，不能借模型故障跳过。E15 已独立核对真实私聊/Web机械轮转及全部 9 个已知测试任务资源清理；两类 unavailable 通知如实无发送/送达记录，E14 旧阻塞快照保留。

旧模型方案部署前探针见 E13 后续记录：`clear-exact-model-validation-r2.json` 整体 FAIL，不能用其中成功场景覆盖 restrictive 历史未调用工具的 R-F；R1 无工具却复读成功标记也保留。unconfirmed 未实际重发但仍建议稍后重试，措辞限制待处理。`notification-tone-probe.json` 三种通知 59–73 字、无内部术语且未抢报资源，仅隔离模型检查通过，无生产送达证据。

**已确认审批规则：保留现有 Bypass，只处理仍出现的确认。** 当前任务绑定工作目录的启动信任由专用 pi 流程识别并经受限工具确认；其余确认必须任务群内用户选择。目录范围含已有项目新参与者、worktree、无项目讨论，不限新建项目。E09 全新目录的 Claude/Codex 专用自动信任已有真实通过；其余确认菜单和全部异常仍单独验收，既有手动记录不替代自动证据。

优先顺序：先修 LIVE-001 并证明“真实请求→自主工具决策→持久任务→真实资源→结果可见”；再逐项核验入口差异、身份、生命周期和恢复。发现新问题时登记缺陷及关联场景，不用整体 tests 数字替代单项关闭。

E16 本轮补验：02:40–02:56 UTC的Web证据运行于 E15 的 ab79cc0/PID20390/SHA；当前 W04 请求边界及静态资源限定分支 R-P，memory 15项 HTTP loopback 与11项针对性测试仅 O-P。另补记旧时间的飞书三项目创建、CLI诊断、Web恢复选中、暂停/中断和普通回调证据；旧R-F不覆盖，W05–10/W27已有原生Chrome CUA限定正常链路和17项跨owner/陈旧请求API拒绝R-P；隔离state的真实飞书删群丢回执跨进程恢复已有R-F→修复R-P。新源码5d1e96f的329项check、format与SEA smoke通过，CI35301019616三平台成功；02:58 UTC实际部署PID26077、SEA SHA c165c642…2c39ec5已核对，完整stamp见E16。旧Web检查不冒充新版本重跑，新部署九任务库存已由test-resource-inventory-e16.json独立回读：9 cleaned、零待清理/未归属agent/readErrors/pendingOutbox；两新隔离群单独记账，不算生产11任务，目标active。详见证据文档 E16。

E18 已部署版本记录（不含本次只读 Web 整改）：运行源码 `0b6966ff6509d3e7cdc0a26e5ba660d7b4e14392`，PID38264，构建时间 `2026-09-18T03:49:25.716Z`，SEA SHA256 `feb114e3c0fd08752533b48c85d07ff7072081e3af9b7b3824f7ccac95680069`。format/check（345项测试）、SEA smoke及[同提交三平台CI 35304636486](https://github.com/hewenyu/herdr-agent/actions/runs/35304636486)通过；03:51回读飞书连接/授权ready，herdr PID39037保持。收尾阶段提示修正已部署，真实模型受控回执单样本通过，尚不称生产收尾回复重验；旧R-F保留。主入口无模型机械 `/clear` 语义不变。E17新增3任务及此前9任务均已确认资源清理，整体目标active。后续文档提交不冒充重新构建。

E17 部署与验收记录：`.cache/live/e17-deployment.json` 固定运行源码 `a6018ec1f51affce2b4160a0aea1a6e4483bcb1c`、PID `32000`、构建时间 `2026-09-18T03:24:39.516Z`、SEA SHA256 `87cfcebabb4957380713b7aa57440d3d79357727f1d8d33b0b06dfd2de168505`。format、check（345项测试）、SEA smoke 及[三平台 CI 35303089613](https://github.com/hewenyu/herdr-agent/actions/runs/35303089613)全部通过；飞书连接及授权 ready，herdr 原进程保留。

本次修复区分参与者显示名与合法原生名称，将 agent.start 的明确名称拒绝归为 not_executed；只有明确重名拒绝才换用稳定名称重试。迁移参与者独立 ID 的操作归属统一纳入 retry事务、pending恢复、错误保留；短可见文本的宽度改为 unknown。E17 的5d1e96f二进制 CLI 28项只读及迁移8项证据保留原版本：迁移4项为真实旧数据的 R-local-copy、4项为合成故障 O，不是生产迁移／完整回退。旧样本仅3个destroyed任务，无pending。

E17后续独立证据已确认B/C从真实飞书请求到原生执行、产物、署名群结果、远端描述与review等待验收的限定链路通过，见 `cli-e17-r2-completion.json`、`independent-e17-completion.json`。C入站和创建时A仍attention，B原生回合尚未结束；A的原生名称拒绝及误unknown历史R-F保留。03:03模型已恢复200/精确标记，不继续沿用旧额度阻塞。任务群owner无@ exact `/clear`拒绝也为限定R-P。

E21-R2 已完成订阅发布后的真实事件闭环：提交 `71ffd7a`、PID `8171`、SEA SHA256 `6ee3f05d65c413fd24f52be453cd2a8f624b0d7e64bc6fdb5b889a5e8c1a952`；用户在飞书原生任务详情点击完成后，`task.task.update_user_access_v2` 在约0.6秒内进入 task inbox，约1.3秒内强制读回远端完成状态并绕过30秒轮询冷却。随后 herdr 关闭 `w1P:p1`，任务描述同步、群解散和所有 outbox 送达均完成；本地任务 `destroyed`、参与者 `gone`、群 `dissolved`，飞书“已完成”列表可见。证据：`docs/live-evidence-e21-release.md`、`.cache/live/e21-r2-event-closure-2026-09-18.json`。该条为 B12/B13 的 R-P 子场景，不能扩张为其他任务类型、权限或恢复组合均已通过。

E22 当前二进制的真实讨论链路：源码提交 `57736d9af5516054f1cd11260798ba328dc18b99`（macOS arm64，`dist/herdr-agent` SHA256 `7488461ec9ce743a71aacfbd2c07f13401d0d3548cf4b9bb67182daac03c8d5b`）重启后，用户在飞书私聊创建 `LIVE-RACE-20260918-R2`，实际建立飞书任务和专属群，启动 Codex，初始输入回执为 `delivered/acked/verified`，群内输出 `LIVE_RACE_R2_OK` 已回读。用户随后在私聊确认完成；本地回读为 `destroyed`、参与者 `gone`、`groupDeleted=true`，关闭和删群操作均为 `done`。启动阶段曾出现一次真实 `stale_guard`（未执行）后由新 guard 完成目录信任，未重复发送初始要求。`npm run check` 为 422/422，`build`、`binary`、`smoke` 和 `doctor` 均通过。该条是 N02/B06/B12/B13 的限定 R-P，证明当前二进制的一条讨论与默认清理链路；其他任务类型、并发满载补位、审批/权限和异常恢复仍未验。

随后A/B/C均完成已授权资源清理，`e17-cleanup-readback.json`最终快照全true；B通过真实任务群无@完成指令调用task_action，回复送达和herdr close均早于删群。原9加本轮3共12群dissolved、panes缺失、pending outbox为0；inventory-e17两次remote GET400在03:45串行回读均200/completed，原失败保留且原因不确定，见 `test-resource-inventory-e17-read-errors.json`。

新增措辞R-F仍未关闭：B回复首句“已完成收尾”早于群解散，尽管正文说明尚未解散；实际最终清理成功不能覆盖该阶段事实错误。提示修正已在E18部署并通过345项check、真实受控回执probe单样本；尚未重验生产收尾答复，详见E18。a6018ec部署和345项测试/CI证据保留；整体目标active，详见[现场矩阵](live-validation.md)及[版本化证据 E17](live-evidence-2026-09-18.md)。

## 3. 执行协议与通用判据

测试数据使用独立命名：项目 `validation-<run>`、session `验收-<run>`、任务 `验收-<run>-<case>`。A/B 表示两个不同允许 owner；C 表示不在允许名单中的身份。记录各对象 ID，避免把旧任务或旧 transcript 误认为本轮结果。实际外部操作由负责现场的执行者在当前授权范围内执行；本矩阵不是后台自动启动第二条飞书连接的脚本。

| 判据 | 可执行步骤与通过条件 |
| --- | --- |
| F1 输入/配置失败 | 提交空要求、非法枚举/ID/目录或不匹配选项；操作前后比对 ledger、任务和外部资源，无副作用；给出可理解错误 |
| F2 明确未执行 | 在外部调用前令依赖返回明确拒绝；恢复依赖后只重试该失败步骤；成功步骤计数不增加 |
| F3 结果未知 | 让服务端已接受写入但客户端丢回执；记录 `unknown/uncertain`，重启后只读核验，不静默重发、不换参数绕过去重；E16专用真实飞书删群：远端DELETE成功后注入丢回执，另一进程仅GET恢复uncertain→done，保留原错误审计、清除任务陈旧错误；每群DELETE一次。限工作区补丁/隔离state，不代表生产或其它未知写入已验收 |
| F4 崩溃/恢复 | 在登记前后、外部创建后、收到最终结果后、投递前后分别中断测试实例；恢复同一 state-dir，核对每步至多一次及未完成意图保留 |
| F5 输出/会话变化 | transcript UTF-8 尾部半行、截断、inode 替换、原生 session 变化、pane 消失；旧输出不重放，新完整输出不丢失 |
| F6 模型行为 | 用真实已配置模型输入原始/同义/否定/多轮修订请求；检查真实 toolCall 与参数。无工具调用时不可声称已登记、创建、启动或完成；只读状态必须来自查询事实 |
| F7 网络与配额 | 401/403/429/5xx、DNS/超时、模型中断、WebSocket 重连；错误分类清楚，不擅自注册新应用、重复建群或重放终端输入 |
| A1 owner | A/B/C 分别操作同一 ID；合法 owner 正常，异 owner/未授权身份拒绝，读/写/卡片回调均验证 |
| A2 chat/session | 在任务群引用另一任务、在入口切换/归档 session、在任务群尝试建另一个任务；actor 使用接收时绑定，不因稍后选择变化而改道 |
| A3 审批/授权 | 替换 pane/kind/workspace/session/stateSeq 或过期 nonce；旧审批拒绝；参与者文本、摘要、引用、工具结果不成为新用户授权 |
| D1 飞书可见 | 除 outbox receipt 外核对实际目标 chat、回复引用、文字内容和长消息全部片段；旧/错群送达不算通过 |
| D2 Web 历史可见 | 当前页面只展示已存消息和送达状态，不发 ACK、不改变 delivered、不重放历史；旧“显示后 ACK”的实施与测试仅保留在历史证据中 |
| D3 初始投递 | 核对 agent 身份、唯一 receipt、真实 transcript/输入确认；明确区分 delivered、queued、unconfirmed，不由工具接受请求推断完成 |
| D4 最终结果 | 参与者署名、完整输出、持久消息与远端任务描述一致；review 不代表验收；cooldown 不丢最终结果/关闭通知 |

### 最先复现的真实链路 L01

1. 核对唯一运行实例的版本、commit、state-dir、配置 owner/模型协议与 endpoint、herdr socket；记录脱敏信息，不靠 `ready` 判成功。
2. 由实际用户在飞书入口提交 LIVE-001 原始完整请求；保留“新建项目、Codex、HTML 比武”的要求和禁止事项。
3. 在当轮 checkpoint 中核对 `project_create` 或 `task_create(newProject=true)` 等实际调用及结果；模型自行选择合理调用顺序，不通过测试预置 toolCall。
4. 核对项目目录/Git、任务/参与者、operations 与初始投递；若需求包含飞书任务/群，核对实际创建并能打开的链接。没有操作时必须如实表示尚未执行。
5. 在 herdr 核对 Codex pane/workspace、目录、完整初始要求与 receipt；读取本轮实际 transcript，不能拿旧任务 ID 充数。
6. 由 Codex 产出页面；保留用户“不测试”的约束，不追加测试任务。独立只读核对文件，视觉/交互验收另行记录。pi 区分已观察事实与参与者自述。
7. 核对飞书结果可见、task/session 历史和进度查询；完成/关闭使用后续明确授权，不能因编码回复结束自动验收。
8. 按 F3/F4 对同链路的隔离测试副本验证恢复。将每个检查点分别记通过/失败；只通过第 1 或第 2 步不得关闭 L01。

## 4. B01–B18 / N01–N07 全场景矩阵

本节所有业务操作以真实飞书用户输入/群交互为入口。表中旧 Web/API 结果只作历史或底层证据，不补足飞书入口；若缺对应飞书证据，当前入口仍记 U 或 R-部分。

以下 O-H 引用历史测试目录，表示曾有相关离线覆盖；不保证本行全部异常、权限和现场组合均测过。本轮“离线复验”初始均为 U。

| ID | 正常执行步骤与必要结果 | 失败/恢复/权限/投递检查 | 实现与历史离线依据 | 真实状态 |
| --- | --- | --- | --- | --- |
| B01 | `setup` 新注册、复用、明确 `--app`、补授权分别执行；保存正确应用，私聊与精确 nonce 卡片往返 | F1/F7；取消/超时/身份不匹配；保存成功但回调未完成返回部分成功；A1/A3/D1 | I；O-H `tests/onboarding/`、`tests/cli/run.test.ts` | U，不能拿已有机器人可发消息证明注册全流程 |
| B02 | `serve` 获取排它锁→迁移→只读历史页→校验权限/herdr→唯一平台连接 | 失权/断线/协议失败时保持可修复状态；F2/F4/F7，拒绝第二实例 | I；O-H cli/storage；E25 runtime failure recovery | R-部分：E25 注入式 terminal failure 已验证旧连接停止、授权/订阅重新执行和退避重试；真实飞书网络中断、重连耗尽和用户入口仍 U |
| B03 | `doctor [--json]`、debug ls/screen/transcript 分别核对实际宿主结果 | 不启动编码、不建立第二平台长连接；不可读报 unknown；脱敏，宽度仅估算 | I；O-H cli/host-checks | R-部分：旧CLI成功screen/transcript证据保留；旧width fail不证明窄终端。E17在5d1e96f的28项只读检查通过，doctor文本/JSON无agent正常；a6018ec已修短内容为unknown，实际PTY列数未测 |
| B04 | 登记已有项目，验证全部有序目录与默认 agent/default project；任务冻结目录快照 | F1/F2；第二目录无效不先改首目录；A1/A2；bypass仅影响新执行器 | I；O-H projects/config | R-部分：E13非法第二目录拒绝且首目录未初始化Git；E14真实worktree/额外目录读取、原项目干净与额外目录不变通过；完整多目录/配置组合未全验 |
| B05 | 明确新项目指令→创建目录/Git/登记；普通新任务只复用项目；连续不同项目独立创建 | 名称穿越/占用拒绝；F3/F4；删除登记不删代码 | I；O-H projects；LIVE-001 | R-部分：E05/E16证据保留。E17 a6018ec B/C各自新项目、真实Codex产物、署名群结果及远端描述通过；原核心输入+新scope限定链路R-P，不覆盖A名称拒绝和历史无工具R-F |
| B06 | 讨论/开发/评审/测试四类任务各创建；关联要求、参与者、可选群/远端任务；三项目中一项运行/一项blocked不阻塞后续登记 | F1/F3/F4、A1/A2、D1；无平台时保留用户建群意图；显式本地任务能运行 | I；O-H app/tasks/feishu/cli integration | R-部分：E17 C入站/创建时A attention、B原生回合未结束，C独立创建并完成产物/群结果；B/C等待验收后再授权收尾。其他任务类型、所有blocked原因/权限/恢复组合仍分验 |
| B07 | Claude/Codex 各启动，核对实际 argv、多个目录、bypass和唯一初始 receipt；前任务blocked不阻塞其它执行器启动 | 保留 Bypass；仅当前任务绑定启动目录信任可由专用pi确认，其余群用户选；F3/F5/A3/D3 | I；O-H herdr/lifecycle、tasks | R-部分：E09/E13/E14证据保留。E17 B/C同中文显示名映射不同合法native名称，自动目录信任、唯一初始输入/一次verified投递及真实产物通过；A名称拒绝/误unknown原R-F保留 |
| B08 | 在绑定群续聊/引用、非任务群 @机器人、修订/否定/含糊输入各一例 | A1/A2/A3，F6；完整约束转交、unsupported资源不虚构；D1/D3 | I；O-H app/conversations、runtime | R-部分：E17绑定任务群owner无@ exact /clear拒绝，正文远端/CUA可见，session/selection/status不变且无checkpoint；普通续聊/引用及其他身份组合仍分验 |
| B09 | 多 owner/多任务/多 session 查未结束和 all，核对真实状态与链接 | A1/A2、F6；任务不存在不得编造；query readError不可说运行正常 | I；O-H app/tasks/runtime；LIVE-002 | R-部分：E02 查询后阶段答复正确（合成回执）；LIVE-001 历史 R-F；真实飞书入站查询进行中，E16 Web A/B列表隔离与17项API边界通过，完整身份竞态仍U |
| B10 | Claude/Codex 输出观察、署名与群消息/远端描述/Web历史逐一对应 | F3/F4/F5，D1/D2/D4；控制/通知简洁说用户可见结果，默认无scheduled/持久化/排队回执术语，追问再给诊断；cooldown只合并进度；迟到结果不驱动新任务 | I；O-H transcripts/tasks/app presentation | R-部分：E17 B/C native final、参与者输出、署名群结果及远端描述匹配；E21-R2 的最终描述、结果、收尾通知和飞书已完成列表逐一匹配。B完成回复首句提前称“已完成收尾”为历史R-F；E24 隔离真实组件通知恢复正常、第二样本群内 GET 读到署名与结果，但首样本仍显示 review 字段，简洁措辞与其他异常投递仍分验 |
| B11 | 目录信任以外的实际 blocked→任务群用户选项→Guard验证→执行；单人/all中断 | A1/A3；回调竞态/双击/过期/换现场；显示裁剪不改完整Guard；D1/D3 | I；O-H approvals/herdr/legacy fixtures | R-P（本次普通标记A）：E13真实owner/group/card/nonce/key=1 callback done→consumed→native AskUserQuestion答案→群GET输出，8项通过；由用户本人选择，期间directory-trust操作0；其他权限/过期/替换/重复组合未全验；E16补记9a86e40真实pause与native interrupted、重复请求不重复stop；非全部子进程退出证明 |
| B12 | `complete`/飞书手动完成确认后默认herdr关闭执行器并解散群；明确keepExecution例外须同时keepGroup:true（无群任务除外），review不收尾；旧默认/未知来源策略在收尾时兼容修正，显式保留证据继续有效 | F3：只回读确认，不重复PATCH；D4；解散前通知/未知删除不重放；群任何原因解散均清对应执行器；明确保留例外单验 | I；O-H tasks lifecycle/completion-description；O-P E15 cleanup-notification：生成不可用审计、未知发送与最后结果屏障 | R-部分：E21-R2 原生完成→事件→herdr close→群 dissolved、全部 outbox delivered 的子场景为 R-P；E15/E16/E17 既有默认/保留/unknown 恢复证据继续有效，E24 真实组件 complete+keepGroup:true 已关闭 pane 并保留群、完成时间独立回读；keepExecution、权限、异常组合及本次飞书用户入口仍未全验 |
| B13 | 明确 close/外部勾完成→采最后结果→完成同步→关闭通知→资源清理 | F2/F3/F4，A3，D4；远端未确认不清理；模型通知失败不虚报完成 | I；O-H tasks/app | R-部分：E21-R2 已核对事件驱动强制刷新、最终 description sync、远端完成、本地 destroyed、pane gone、群 dissolved 和消息先于删群；E17三任务旧收尾事实保留，B提前声称收尾的历史R-F及其他未知/失败恢复仍需单验 |
| B14 | destroy不代验收，关闭受管资源但保留代码/历史；已销毁拒绝reopen | 部分清理失败恢复；不关闭别的pane/group；F3/F4/A1/A2 | I；O-H tasks/projects | R-部分：E09 外部群解散后只清对应pane、本地destroyed且远端未冒充验收通过；E24 真实组件已验证 destroyed 后显式 destroy+keepGroup:false 及外部解散后 tick 更新，未重启/重关执行器、未改原完成时间且移除失效群链接；显式 destroy 的真实飞书用户入口及其他失败恢复仍未全验 |
| B15 | 明确失败重试、未知写入冻结、重复事件、停机中断后恢复逐项执行 | F2/F3/F4/F7；inbox/outbox/operations/checkpoint跨进程一致；D1/D2/D3 | I；O-H storage/app/tasks | R-部分：E12初始输入只读恢复、E16隔离真实删群unknown-ack恢复保留。a6018ec补旧participant操作归属与retry事务，O-P；E17迁移故障4项O。outbox/建群/remote未知写入与硬断电仍未全验 |
| B16 | 飞书中session创建/选择/重命名/归档/恢复；私聊自动压缩及飞书主入口exact /clear确定性归档旧session并新建选中，不调模型，事务成功后仅CLEAR_NEW_SESSION_OK；Web无命令/清空入口；provider通过本地安装配置维护 | A1/A2；事务失败不送成功标记、失败不切换、排队旧绑定拒绝/旧回执保留、群拒绝、摘要不串新session；D2 | I；O-H runtime/migration；O-P E15 clear-command/session-tools：AI关闭、正文匹配、旧队列、Web无sessionId重复请求；既有entry-reset | R-部分：E15真实私聊及Chromium机械clear均无checkpoint、source command、实际归档切新和精确marker送达；私聊4条旧历史保留，Web可见ACK/归档历史/390px通过。旧模型两次失败及全部R-F保留；新命令故障组合仅离线通过；E16 memory 15项真实loopback HTTP及11针对性测试O-P，外部生产memory/TLS/ACL仍U |
| B17 | tasks关闭时 /ls选择、引用优先、/card、/say、/stop、/mirror、/close逐项验证 | 错误旧绑定拒绝；解除不复活；notify_chat基线、F3/F5/A1/D1/D3 | I；O-H legacy/herdr/migration；E25 route verification | U：E25 已补旧桥 6 项离线回归，真实 tasks 关闭飞书入口和 notify_chat 现场仍未验 |
| B18 | 单二进制安装、版本核对、服务管理器重启、迁移/回退、长期保留 | 仅桥停止不杀herdr；锁清理、磁盘异常、日志/DB增长、三平台；F4/F7 | I；O-H build/cli/storage，BUILD-001 | R-部分：当前0b6966f/PID38264/SHAfeb1…0069，345tests、SEA和三平台CI35304636486通过；a6018ec历史证据保留。E17 5d1e96f旧状态副本迁移4项R-local-copy/4项O；完整生产回退、Linux宿主及长期故障未验，旧版本证据保留 |
| N01 | “当前有哪些任务/谁在等待/我该做什么”真实模型查询工具后答复 | F6，A1/A2；摘要和参与者自述不可替代当前事实 | I；O-H engine/app | R-部分：E01 查询自主调用 tasks_list；E02 多轮查询事实措辞通过（合成回执）；真实飞书查询进行中，LIVE-001 历史 R-F |
| N02 | 明确仅讨论→无项目或已有项目→单Claude/Codex参与需求讨论 | pi不能自行替项目写方案；禁止编码的要求完整保留；D3/D4；F6 | I；O-H tasks/prompts | R-部分：E01 创建只讨论任务的参数含 discussion/Claude/Codex；真实单参与者讨论与禁止编码行为 U |
| N03 | Claude+Codex同群轮流讨论，署名可辨、ID可定位；同种多实例另测 | 手动/轮询、轮数/时限、迟到输出、同名拒歧义、未知relay暂停；F3/A2/D4 | I；O-H discussion/app/cli integration | R-部分：E12 R2双方唯一输入零toolcall各一次群输出、1轮暂停通过但首发曾unconfirmed；E13新增首发及移除后resume即时verified通过，旧R-F保留，完整多实例/轮次组合未全验 |
| N04 | 讨论→用户明确转开发/评审→`parentTaskId`冻结上下文→共享目录或worktree | 后续修订优先、不漏禁止事项、不读错owner；完整真实模型交接；F6/A1/A3 | I；O-H lifecycle/projects | R-部分：E11 真实parentContext冻结父讨论要求/发言/参与者，Codex关联review完成并有群结果；讨论→开发、worktree、修订与owner完整组合 U |
| N05 | 主入口切换pi session后继续；多个pi session并行创建不同项目，运行/blocked互不拖住；herdr原生session保持托管 | 已接收排队消息不改道；任务群不可切换；A1/A2，归档与clear分别验证 | I；O-H runtime/app | R-部分：E11 真私聊clear切换后继续成功；两个真实pi session起始相差3ms且各projects_list，处理区间重叠。只读并发不代表多项目创建/blocked/恢复全组合通过 |
| N06 | pause停止后续调度，interrupt影响选定执行器，resume恢复有界轮转 | pause不宣称已停止正在编码；迟到结果保留不转发；F3/F4/D4 | I；O-H discussion/lifecycle | R-部分：E13移除后resume九项真实检查通过，保留者新输入/输出、移除者pane缺失且无新输入；该次rounds=0，完整暂停/中断/预算/迟到组合仍未全验；E16补记pause-interrupt.json：pause后仍working、暂停send拒绝、native interrupted、2 stop done、重复请求不变、resume accepted及项目文件未变；未知恢复和所有子进程未全验 |
| N07 | 结束讨论但保留关联开发、分别完成/关闭与保留群 | 不级联未授权任务，不由pi代判业务结论；A2/A3/D4 | I；O-H lifecycle | R-部分：E12明确保留群/两pane通过；E13原B后续close及R2默认complete完整清理通过；E15 review及本轮全部9任务最终资源清理已回读，不级联完整组合未全验 |

## 5. CLI 全入口矩阵

本节实现为 I、历史证据为 O-H `tests/cli/`；详见 [CLI 实测证据](live-cli-evidence-2026-09-18.md)。旧SHA `793b9006…c982c098` 的结果保留，但pane-width fail仅依据内容长度，不能证明终端过窄。E17在5d1e96f执行28项只读CLI检查通过，doctor文本/JSON在无agent时均12项pass；迁移8项中4项R-local-copy、4项合成O。它们不冒充a6018ec重跑或setup/serve/配置写入通过；C06/C07仍U，C08/C09仅参数拒绝。新宽度算法已在a6018ec部署，真实PTY列数仍未测。下表保留完整范围；`--json`不保证help及所有错误均为JSON。

| ID / 入口 | 正常步骤 | 失败、恢复、权限与输出核对 |
| --- | --- | --- |
| C01 `help` / `-h` / `--help` | 核对主命令、诊断命令和当前flags | 不打开state/网络；未知命令/多余参数退出2；帮助不承诺未暴露功能 |
| C02 `version` / `-v` / `--version` / `--json` | JSON与文本同时核对commit/date/version/实际安装文件 | 不读生产state；旧二进制路径不得当新版本；BUILD-001是历史通过 |
| C03 默认无命令/`serve` | 记录Web地址、authorization/runtime、唯一连接与停止退出码 | F2/F4/F7；herdr探测失败不得开始任务；凭据不足在CLI/服务状态说明等待；Web可提供受保护的本机配置写入口，但不提供业务任务、聊天、审批或清理写入口 |
| C04 `serve --config-listen` / `--no-config-ui` / `--open` | 指定回环/关闭UI/尝试浏览器分别运行 | 非回环/端口占用/浏览器失败明确；后台服务不意外打开浏览器 |
| C05 `configure --listen` / `--open` | 提供不连接飞书的本机会话记录和配置页；旧 Web 业务管理范围撤销 | HTTP 仅允许 allowlist 配置 action（identity/project/default/Bypass/model），且必须通过 Host/Origin/CSRF；浏览无副作用不等于 CLI 启动无副作用，仍有状态打开/迁移与既有后台 tick，按 WR05/WR06 核对 |
| C06 `setup` | 新注册与复用应用分别完成授权和消息/卡片往返 | 超时/取消/错误brand/权限延迟；凭据已存但验证未完退出3；A1/A3/D1 |
| C07 `setup --app ID` / `--update-permissions` | 明确选应用、给原应用补授权 | 多凭据来源冲突必须明确选；失败不误换app或自动新建 |
| C08 `setup --reregister --yes` | 仅明确替代应用流程执行 | 未带yes、与app/update冲突拒绝；失败不覆盖正确旧凭据 |
| C09 `setup --no-open --timeout` | 链接可手动打开，合法时长正确 | 0/负数/超1小时/坏duration拒绝；超时不继续后台注册 |
| C10 `doctor [--json]` | 核对config/herdr/CLI/权限/owner/pi/hooks/env/manifest/pane-width | 只读、不连接平台WS；fail退出1；不可读unknown；敏感值不输出 |
| C11 `debug ls` | 返回实际agent列表 | herdr不可用/身份未知错误，不启动agent |
| C12 `debug screen PANE` | 读指定真实pane完整现场 | 无pane/非coding agent/换身份拒绝；不得裁剪后用于Guard |
| C13 `debug transcript PANE` | 返回当前读取语义和cursor；确认与文档一致 | reader初读默认尾部cursor可能无entries，不能误写成“返回全部历史”；F5 |
| C14 `migrate --dry-run` | 对独立旧state副本列迁移计划/警告 | 对原文件/DB做前后hash，验证dry-run真实写入范围；缺历史身份不虚构 |
| C15 `migrate` | 导入task/session/receipt/archive、备份、再次执行幂等 | F4；迁移后不自动重放未知写入，不采旧final当新结果 |
| C16 全局 `--state-dir` / `--json` / `--key=value` | 独立目录、路径展开与命令参数组合 | 多余位置/不适用flag/单横线旧flag/缺值/未知flag拒绝；实际JSON契约单测 |

## 6. Web 会话记录与本机配置验收

W01–W29 中聊天、任务、参与者、审批、清理和 pi session 的业务写路径计划停止扩展；本机配置写路径保留且仅限 `identity.select`、`project.save/create/delete/default`、`catalog.bypass`、`config.ai`，统一受 loopback、Host/Origin 和 CSRF 保护。旧通过或失败记录保留，不继续验收已撤销的业务页面/API；WR01–WR09 检查会话记录浏览，配置写入另按 allowlist、输入校验、重启生效和密钥遮蔽验收。状态基于旧部署的真实检查和当前源码离线证据，未覆盖分支明确保留，不沿用旧业务页面的移动端或 ACK 通过结果。离线依据为 `tests/web/server.test.ts`、`tests/app/identity.test.ts`、`tests/cli/integration.test.ts` 及独立 SEA smoke；378 项检查对应 `0ccfff2`，没有将测试总数当成各行全部分支通过。

| ID | 只读要求 | 验收事实与边界 | 状态 |
| --- | --- | --- | --- |
| WR01 | 查看既有会话列表及记录 | acb/a7 HTTP 核对 A/B 的会话、消息、工具记录数量；真实 Chrome 查看飞书历史、参与者署名和工具详情。空态、未知会话等全部边界尚未逐一实测 | O-P / R-部分 |
| WR02 | 本地浏览、筛选历史 | a7 实际切换 A/B、归档筛选和 `s_be0b138d…` 的 12 条旧历史；身份菜单跨 12:50–12:52 轮询保持打开。受检 selection、identity、session、命令回执未变；返回、重连及快速切换竞态仍 U | O-P / R-部分 |
| WR03 | 飞书新增记录可读 | a7 可读取真实飞书产生的会话记录及 `/clear` 前历史；切换只读视图没有新增消息、pi checkpoint 或 outbox。新增消息到 SSE 自动刷新的实时过程和断线补读尚未单独验收 | O-P / R-部分 |
| WR04 | 历史和投递事实准确 | 真实 Chrome 查看用户、pi、参与者署名和工具记录；HTTP 历史含投递状态，浏览前后 messages/outbox 不变，旧 chat.ack 请求被拒绝。未知/部分送达等全部样本的视觉表达仍 U | O-P / R-部分 |
| WR05 | 无 Web 业务操作控件（本机配置除外） | 旧部署页面没有聊天/命令、任务/参与者、审批、清理或 pi session 控件；当前项目/默认/Bypass/模型/身份配置控件属于允许范围，只能调用 allowlist 配置 action，不发送业务消息或 ACK。旧页面证据不证明当前配置页面的现场可用性 | O-P / R-部分（当前配置现场待补） |
| WR06 | 服务端拒绝业务写入口、保护配置写入口 | `chat.send`、`task.*`、`participant.*`、`approval.*` 和 pi session 等业务 action 必须拒绝；allowlist 配置 action 需合法 Host/Origin/CSRF，未知 action 和坏输入拒绝。当前测试覆盖 `project.save`/`config.ai` 合法 200 及业务 action 403；旧 acb/a7 的11类405结果仅为历史只读部署证据 | O-P / R-部分 |
| WR07 | 本机只读访问边界 | acb/a7 实际未允许 owner 请求 403，/state.sqlite 为 404；A/B 只读投影隔离。loopback/Host/Origin、敏感字段脱敏另有离线覆盖；撤权竞态和所有恶意路径未穷尽 | O-P / R-部分 |
| WR08 | 页面可用性与分发 | acb/a7 独立二进制加载只读页面，a7 桌面中文长记录截图无明显问题，轮询菜单失焦已实测修复。后续0ccfff2已部署，390×728中文长记录与刷新后Console限定检查通过；全部空态/加载失败/断线界面仍 U | O-P / R-部分 |
| WR09 | 查看无业务副作用 | acb HTTP+Chrome 前后 11 项一致；a7 HTTP 11 项一致，Chrome 阶段 tasks/participants 的 hash 变化且未定因，其余 9 项一致。保留原 browserReadOnly:false，限定证明会话、选中、消息、checkpoint、outbox、审批未因浏览改写；后续b53、测试任务均关闭后的独立基线HTTP+Chrome前后11项全一致（e20-web-readonly-final.json）；未采完整网络追踪，不扩大到所有竞态 | O-P / R-部分 |

<details>
<summary>W01–W29：已撤销的旧业务页面/API 验收索引（原事实保留，以下“待验/本轮”均指旧计划）</summary>


历史 I 表示当时 action 或页面路径已存在；O-H 来自 `tests/web/`、`tests/app/` 与历史Chromium假后端QA，不能据此认定每个真实表单已测。E05 的 Web 新建会话、chat.send 和现场信任处理已有部分业务证据，E11 新增 clear、自动压缩、并发查询与关联review/test的服务效果；这些 API/实际业务证据不能替代桌面与移动布局、ACK及每个表单点击验收，E13 scoped/普通自然输入后的真实浏览器clear及可见ACK通过；E12不可见ACK旧R-F与E13模型复读禁止工具历史的新R-F均保留，其余旧页面场景不再扩展业务验收。旧 W01/W27 的owner表现关联 LIVE-002；E16原生Chrome实际A/B切换及限定API拒绝已通过，进行中的回复/ACK竞态与撤权仍未验。本轮CUA没有console instrumentation，也未重测390px。该要求属于撤销前计划；新只读页面按 WR01–WR09 验收。

| ID / 页面或API | 正常执行与预期可见结果 | 失败/恢复/身份/回执 |
| --- | --- | --- |
| W01（历史范围撤销） `GET /api/state`、四页与导航 | owner、sessions/tasks/participants/projects/model字段准确；默认任务session以标题显示，用户rename保留 | LIVE-002先核验本机owner语义；禁止跨owner泄漏，不把空列表判作所有任务不存在；E16原生UI：A见自身任务，B空列表且state仅B对象；只关闭该两身份限定范围 |
| W02（历史范围撤销） `/` `/styles.css` `/app.js`、嵌入静态资源 | 脱离源码运行、移动布局、空态、长列表/中文/长输出 | 404不暴露文件；CSP无内联脚本；加载失败明确，不显示陈旧成功；E16当前部署CSS/JS正常、未知路径与/state.sqlite均404且带CSP，桌面全页面/长列表仍分验 |
| W03（历史范围撤销） `GET /api/events` / 15秒刷新 | 状态改变可见，断线重连、正在编辑不丢草稿 | SSE限额/背压/关闭释放；切页后不确认未显示消息；D2 |
| W04（历史范围撤销） `POST /api/actions` | 合法Origin+CSRF的单次请求执行一次 | Host重绑定/跨站/缺token/非JSON/超1MiB/未知action拒绝且无副作用；E16 R-P（本次请求边界）：合法只读200；错误Host/Origin/CSRF 403，非JSON/坏JSON/未知action 400，超1MiB 413；对象与资源hash不变，不代表所有写操作去重通过 |
| W05（历史范围撤销） `session.create` | 创建独立会话并选中 | 名称空/过长、未setup、重复点击；不创建编码任务；E16当前ab79cc0原生Chrome新建A/B独立session通过，未创建任务/执行器 |
| W06（历史范围撤销） `session.select` | 切换当前会话且还原各自草稿 | 归档/他人/无ID拒绝；已接收消息保持旧actor，D2；E16补记00:16真实浏览器显式选中重连通过；旧报告未绑定源码stamp，草稿/跨owner仍U；E16当前原生UI返回A选中自身session、刷新保留B选择通过；不承诺跨身份草稿恢复或in-flight竞态 |
| W07（历史范围撤销） `session.rename` | 列表/标题同步，刷新后保留 | 无效名称/跨owner拒绝；默认标题映射不能覆盖用户名称；E16当前原生UI重命名A通过；17项API另证异owner/陈旧身份rename拒绝且DB不变 |
| W08（历史范围撤销） `session.archive` / `session.restore` | 各执行一次，归档历史可读、恢复后可选 | 活动回合取消、迟到reply/ACK、任务现场保留；恢复不是新建session；E16补记live-web-session-fixed-0918.json归档历史自动可见、恢复刷新保留选中，旧两项R-F保留；不冒充ab79cc0或模型工具路径复验；E16当前原生UI归档按钮、归档历史与恢复B后刷新仍选中通过；旧R-F保留 |
| W09（历史范围撤销） `session.clear` | 新generation、历史归档、当前上下文清空 | 任务绑定session/并发回合/重复操作核对；不得清除herdr session或任务；E16显式按钮使恢复后的B generation 0→1、原/clear及marker历史保留；不换session，区别于聊天/clear机械轮转 |
| W10（历史范围撤销） `session.history` | 活动/归档历史按session/owner返回并展示 | 选择别的session不能混入；未知ID/A1；未送达消息标记真实；E16补记旧真实浏览器归档历史自动加载通过，另有E15当前机械clear历史可见；跨owner/未知ID仍未全验；E16当前UI归档B历史可见；API自身读正常、跨owner与陈旧身份读拒绝；in-flight迟到回复仍未验 |
| W11（历史范围撤销） `chat.send` | 普通业务请求走真实模型工具，exact /clear直接执行；回复先显示 | E15真实Chromium机械clear无模型请求/无checkpoint、source command、切新/精确marker/可见ACK/归档历史/390px通过，测试会话均归档；旧模型成功及restrictive未调工具R-F保留；E11 API压缩/并发不计渲染 |
| W12（历史范围撤销） `chat.ack` | 当前实际显示的回复/参与者输出记delivered | E12不可见ACK历史R-F保留；E13两轮真实clear所有ACK前有可见DOM、clear最终delivered通过；A1/隐藏session/断线等完整组合另验 |
| W13（历史范围撤销） `task.create`表单 | 四类、1–8参与者、已有/新建项目/无项目讨论、可选关联讨论、独立session、shared/worktree、建群/远端task/保留选项 | 默认round_robin/4轮/30分；50轮/240分边界；绑定task session排除、空session明确；F1/F3/D3 |
| W14（历史范围撤销） `task.get`、任务列表/详情/历史 | 状态、错误、参与者、结果、链接正确 | 其他owner/无ID/同名歧义；无group/remoteTask的本地任务不显示假链接 |
| W15（历史范围撤销） `task.action` complete/close/destroy | 每个动作分别核对B12/B13/B14资源差异；complete默认解散新任务群，明确保留可覆盖 | 取消确认无操作；未知结果不重复；完成未同步不清理；D4 |
| W16（历史范围撤销） `task.action` reopen/retry/pause/resume | 分别按原状态验证；恢复预算与历史保留 | destroyed拒重开、completed拒直接resume/send、unknown拒自动retry；E16补记pause/resume的真实服务及native证据，非浏览器点击证据；reopen/retry完整组合仍U |
| W17（历史范围撤销） `participant.add` / `participant.remove` | 指定kind/name/role新增，移除只关闭该受管窗口 | 上限/未启动/不存在/重名/当前轮转者移除；F3/A1/A2 |
| W18（历史范围撤销） `participant.send` | 用ID或唯一名称转完整文本到指定执行器 | 多人未指定、同名拒歧义；blocked/working/queued/unconfirmed分别展示 |
| W19（历史范围撤销） `participant.interrupt` 单人/`all` | 只中断选中或全体，并暂停自动讨论 | 空/错ID明确，不能误中断别的任务；部分失败如实呈现；E16补记9a86e40真实native interrupted及重复请求不重复stop，非Web控件或T06模型选择验收 |
| W20（历史范围撤销） `participant.screen` / `participant.answer` | 展示裁剪现场+完整选项，手动nonce选项送出 | 身份/状态/nonce过期/重复/消费竞态；Esc也需明确操作；A3 |
| W21（历史范围撤销） `project.save` | 新登记/编辑已有目录，默认agent/多目录顺序 | 不存在路径/非目录/路径权限；全部校验后才初始化；已建任务快照不变 |
| W22（历史范围撤销） `project.default` / `project.delete` | 切默认；移除登记保留代码，引用清晰 | 删除默认项、仍有任务的项目；撤销确认不执行 |
| W23（历史范围撤销） `project.create` API | 明确新项目名创建目录/Git/登记 | I：API有实现；**页面未提供独立新建目录表单，入口差异D**；F1/F3 |
| W24（历史范围撤销） `catalog.bypass` | 勾选经确认、刷新后持久；仅新agent使用 | 取消不改变；不暗改当前agent的审批策略 |
| W25（历史范围撤销） `config.ai` | provider/model/baseUrl/key/enabled保存；显示重启生效；key不回填 | 非法URL/协议/缺key拒绝；保存失败不误显示成功；模型未连通不能称验证通过；E16补记config-invalid-provider.json的ai_provider拒绝/配置未变；该记录缺部署stamp，仅限定历史证据 |
| W26（历史范围撤销） 授权/运行状态、错误反馈、确认弹窗 | 配置待修/授权链接/未知结果有实际可操作说明 | 自动刷新不覆盖用户输入；不凭runtime=ready宣称任务已执行 |
| W27（历史范围撤销） `identity.select`（本轮新增） | 在允许owner A/B间显式选择；查看各自session/task，不移动或合并旧记录 | 未允许owner拒绝；expectedOwnerId拦旧页面操作；切换中的ACK/迟到回复/草稿/缓存不可跨身份显示；重启保存的选择撤销授权后失效；E16有限R-P：原生A/B切换、A草稿不泄漏B、列表/回复隔离、B刷新持久及17项API边界；已归档3测试session并恢复原owner和A/B选择，业务资源hash不变；无本轮390px/console证据，in-flight回复/ACK、撤权未验 |
| W28（历史范围撤销） 新建项目表单（本轮新增） | 显式选择新建，输入名称，task.create提交project与newProject=true；切回已有/无项目不带残留新建字段 | 同名、穿越、空名/超长拒绝；选择已有项目不创建目录；O-P：本轮task-form.test.ts输入边界通过，真实目录/浏览器U |
| W29（历史范围撤销） 关联讨论表单（本轮新增） | 只列当前owner的discussion任务，显示title与ID；选择后提交parentTaskId，必须填写本次完整要求 | 他人/非discussion/陈旧选择拒绝；旧要求/结论不替代本次输入；O-P：task-form.test.ts通过；E11实际关联review的parentContext与输出通过，浏览器表单/讨论转开发仍U |

`project.create`、`task.get`等 API 无独立UI按钮不等于功能不存在；反之页面可操作不表示 pi 自然语言有对应工具。本轮任务表单已接入 `newProject/parentTaskId`，采用已有task.create语义；E11已核对关联review的服务效果，真实页面点击及完整任务类型组合仍待验收。


</details>

## 7. pi 工具全量矩阵（既有20个）

工具调用的业务验收从真实飞书消息触发；旧 Web/API 调用只保留历史实现事实，不计飞书入口通过。

工具清单来自 `src/app/tools.ts`：基线7689cee有18个，本轮工作区新增T19/T20，尚未据此标为测试通过。前8个可用于任务群；其余仅主入口。所有行均 I；历史 O-H 仅代表 engine/app/tasks/runtime 等测试存在相关机制覆盖；E01 仅验证部分工具的首个真实模型决策，E02 验证多轮真实模型读取合成状态，E05 验证一次真实 Web 创建业务链；各行完整正常/异常组合仍 U。LIVE-001 关联失败保留历史。业务执行由真实飞书用户入站触发，再核对模型自主选择工具及实际效果；不再通过 Web/API 直接执行业务作替代验收。只读查询和隔离故障测试独立分类。

| ID / 工具 | 正常请求与要核对的工具参数/结果 | 失败/恢复/身份/投递 |
| --- | --- | --- |
| T01 `tasks_list` | “列未结束任务/含历史”，all含义、群内只绑定任务 | A1/A2/F6；无调用不得声称查询；LIVE-001事实答复失败 |
| T02 `task_get` | 指定真实task，包含参与者实时runtime与observedAt/readError | 无ID/异owner/pane替换；readError不是正常运行；LIVE-001旧ID/排队无依据 |
| T03 `participant_screen` | 指定participant真实完整screen/options | 只读、不批准；多参与者必须明确，A2/A3 |
| T04 `participant_send` | 转完整原始要求、修订/否定到指定执行器 | F3/F6/A2/D3；真实blocked/queued/unconfirmed不可改称delivered |
| T05 `task_action` | complete/close/destroy/reopen/retry/pause/resume各实际一例 | 每个动作匹配明确授权；完成且保留群须传keepGroup:true；保留执行器须keepExecution:true且有群时同时保留群，省略群策略按来源与明确保留证据处理；“不要关闭/完成后再关”不执行；F3/A3 |
| T06 `participant_interrupt` | 单人或all，核对所有目标和暂停状态 | 同名/未指定/错任务、部分失败；不得说暂停就等于进程已停 |
| T07 `participant_add` | 指定claude/codex/name/role，后续有界调度 | 8人上限、重复/失败/未知创建，不重建已成功资源 |
| T08 `participant_remove` | 指定ID移除并关闭其受管pane，保留历史 | 对当前发言者与已gone分别测；A1/A2/F3 |
| T09 `project_save` | 已有多目录、agent、makeDefault，准确登记 | F1/F2；不擅自把新任务变成新目录；既有任务冻结快照 |
| T10 `project_create` | 只有明确新项目才创建并初始化 | 重复名称/占用/穿越/权限错误；F3；LIVE-001未进入此路径 |
| T11 `project_remove` | 移除登记，明确代码仍保留 | 不误删文件/任务，默认项目失效处理 |
| T12 `session_clear` | 历史模型工具的副作用/回执继续校验；最新主入口exact /clear绕过模型走确定性命令，不以此工具调用作为新命令必备证据 | E14旧模型Web通过、私聊因额度失败及全部旧R-F保留；E15已独立验证私聊/Web机械归档/创建/选中/精确文本/无模型调用，不要求session_clear工具调用 |
| T13 `projects_list` | 查询目录/default agent/Bypass实际值 | E11两个真实模型各projects_list成功且并发；无配置/身份异常仍需分验，不读项目源码代做需求 |
| T14 `task_create` | 四种kind、完整requirements、participants、目录模式、newProject/parentTaskId、建群/远端task、讨论预算 | F1/F3/F4/F6，A1/A2/D1/D3；accepted仅已登记；**LIVE-001 历史失败保留；E05 Web 真实开发创建通过，accepted 时事实答复失败；E11关联review和独立test通过；E12原B无重发恢复、E13首发即时确认通过，四类型恢复未全验**；E16补记飞书一次请求3次真实task_create(newProject=true)，完整参数与3项目资源存在；旧事实措辞失败和未测组合保留 |
| T15 `sessions_list` | 当前owner活动/archived=true列表 | 群内无此工具；A1；不混淆pi与Codex/Claude原生session |
| T16 `session_create` | 名称及select布尔，切换仅后续消息 | 不创建task/agent；A2与排队actor，失败不误切 |
| T17 `session_select` | 在飞书选存在的独立session；Web仅本地查看历史 | 他人/归档/task绑定拒绝，已接收消息不重路由 |
| T18 `session_rename` | 名称与已有session ID，刷新后准确 | 空/超长/外owner拒绝；不改变任务关系 |
| T19 `session_archive`（本轮新增） | 归档主入口会话；当前回合答复持久后生效，历史/任务/herdr保留 | 当前回合异常不假报成功；异owner/task绑定拒绝；排队消息与迟到ACK不复活归档；E01真实模型首步正确；实际持久效果及本行异常现场仍待验 |
| T20 `session_restore`（本轮新增） | 恢复已有主入口归档，随后显式session_select，保留原历史 | 他人/任务绑定拒绝、不新建；Web历史查看不能改变此业务选择；E01真实模型首步正确；实际持久效果及本行异常现场仍待验 |

入口差异：基线缺少 `session_archive/session_restore` 工具，盘点期间工作区已新增T19/T20；必须补真实模型自然语言及旧 `/session` 文本的调用验证，不能仅因工具已加入就关闭缺口。没有独立 `project_default/catalog_bypass/config.ai` pi工具；`project_save(makeDefault)`可设置默认项目，其它控制的旧 Web/API 写入口已撤销；安装配置走本地维护，仍承诺的业务控制须在飞书有明确入口，不能恢复网页写入补缺口。普通会话没有任意shell/编辑/人工审批工具是职责边界。另有专用启动上下文的 directory_trust_confirm，仅确认绑定目录的原生信任菜单；不计入上述20个普通工具，不作为通用审批能力。

## 8. 飞书入口与兼容模式

| ID | 操作组合 | 必须验证的边界 | 状态 |
| --- | --- | --- | --- |
| FSH01 AI启用 | 私聊文字、富文本、斜杠、引用、多轮指代、图片/附件/语音占位 | 普通业务由模型沟通决策，主入口exact /clear按最新要求走确定性命令；未知资源不虚构，普通业务模型失败不落传统命令或终端原文 | R-部分：E17 B/C真实飞书→task_create→执行/产物/署名群结果限定链路通过；A名称拒绝与历史LIVE-001 R-F保留，B收尾措辞新增R-F。富文本/引用/多模态组合仍未全验 |
| FSH02 群/身份 | 任务群、非任务群@/不@、异owner、回调非owner | owner与chat绑定；当前任务群不能跳转其它任务；callback等同严格验证 | R-部分：E13本人菜单回调/native答案/可见结果保留；E17 owner在任务群无@ exact /clear被拒且未改会话。非owner/非任务群/跨任务等仍U |
| FSH03 AI关闭、tasks启用 | `/help /doctor /projects /tasks [all] /sessions`；`/session new\|switch\|rename\|archive\|restore` | 返回确定性控制结果；任务群禁止切换；无AI不冒充pi沟通 | I/O-H，现场U |
| FSH04 AI关闭、tasks启用 | `/new <项目> [agent] <要求>`、自然“新建任务”、`/task`七动作、`/screen /stop` | 完整参数/默认agent；关闭/确认关闭中文别名与否定区分；多参与者明确ID | I/O-H，现场U |
| FSH05 `/clear`跨模式 | 飞书主入口私聊exact /clear不调用模型，确定性归档旧pi并新建选中，事务成功仅CLEAR_NEW_SESSION_OK；自动压缩无需clear | 所有群拒绝；事务失败不送成功标记、模型不可用不影响exact命令；旧history/receipt保留，queued消息不改绑且拒绝执行；Web无命令/清空入口 | R-部分：E31真实主私聊正常轮转、精确 marker 和旧资源隔离通过；E17任务群owner无@拒绝分支R-P（八项true），E15与旧 Web 结果作历史；AI关闭、无关群、其他owner、事务故障/未知恢复仍分验，旧R-F保留 |
| FSH06 tasks关闭兼容桥 | `/ls`选中；引用优先；`/card /say /stop /mirror on\|off /close /help`，普通文本续聊 | 只按已有herdr agent发送；/close仅解除选中；notify_chat只选可信owner；旧路由核验 | I/O-H，现场U |
| FSH07 消息回执 | 长消息分片、重复event、空messageId回退、卡片重放、飞书事件重连 | 可见片段齐全且目标正确；去重不吞合法新消息；F3/F4/D1 | R-部分：E30真实群输出两片 `[3500,2608]`，REST回读顺序/完整正文/无重复，完成后资源已清理；E13普通菜单有真实callback done/consumed/native答案/群可见回执，E15私聊机械clear有远端精确正文；重复event/空ID/卡片重放/重连仍U，旧R-F保留 |

## 9. 横向遗漏检查与本轮缺陷账本

| 编号 | 检查项 / 判定 | 下一步与关闭证据 |
| --- | --- | --- |
| GAP01 / P0 | 真实模型没用工具却声称执行成功（LIVE-001） | E17原核心输入+新scope的B完整创建/产物/结果可见限定链路通过，C独立请求并行完成；不覆盖原历史上下文和A启动失败。新收尾措辞R-F仍需部署后独立验证，整体目标不关闭 |
| GAP02 / P0 | 成功定义过度依赖inbox done/outbox delivered | E17 B/C各阶段及最终清理已分别核验；B首句“已完成收尾”发生在群解散前，新增措辞R-F保留。E18提示修正已部署、真实受控probe单样本通过，尚未生产重验；不以最终成功覆盖先前夸大 |
| GAP03 / P1 | Web 历史筛选不得改变服务端业务身份或 active pi session | `identity.select` 是有意保留的本机 Web 查看身份配置，只切换历史投影 owner，不改变飞书/任务绑定；需继续验证允许 owner、expectedOwner、撤权及 in-flight 回复隔离。WR02/WR07 的历史浏览检查不应改写 active session 或投递回执 |
| GAP04 / P1 | AI session归档/恢复基线入口能力不对齐，工作区已补工具 | T19/T20继续验证真实模型调用、权限、当前回合延迟归档和恢复；实现新增不等于现场通过 |
| GAP05 / P1 | 新项目与讨论→开发交接需飞书真实入口完整证据 | L01/N04/T14以飞书讨论→用户明确授权→关联开发→产物/群结果验收；W28/W29撤销。E19仅Web单Claude父讨论，未继续Web子开发；维护清理独立回读通过，不算飞书通过，误推断keepGroup的R-F待真实复验 |
| GAP06 / P1 | E05 Codex 既有手动信任链路通过，新 pi 自动目录信任及其他群审批未全验 | E09专用自动信任、E13本人普通标记A菜单8项已证；保留Bypass，其他菜单/重复/换现场/未知写入仍分验，不扩大为所有审批通过 |
| GAP07 / P1 | E12无重发恢复已证，E13新增首发及移除后resume receipt末尾即时确认通过；旧失败保留，其余恢复未全验 | E17部署补旧participant独立ID归属，retry失败清理同事务、pending/错误不误清，离线O-P；真实旧副本无pending，不能算未知恢复R。outbox/建群/其他写入继续F3/F4/F5分验 |
| GAP08 / P1 | E04 REST完成/重开/解散通过，E05结果描述经主验收核对；应用生命周期仍未全验 | B12–B14补TaskService操作顺序/未知结果/资源保留；descriptionMatchesOutput:false为Markdown归一化比较问题，不误记漏传缺陷 |
| GAP09 / P1 | E04/E05任务/群/消息已有真实GET；成员列表查询缺权限99991672；卡片/引用/重复事件未全验 | E30 已补真实长分片两片、顺序、完整正文和无重复；仍需补 roster 权限与群客户端/卡片回调/引用/重连证据，不能把单次 GET 代替全部用户可见验收 |
| GAP10 / P1 | E09旧拒绝失败保留；E13一次model-no-reset异常在原历史/原提示隔离重放6/6选clear，未稳定复现，无源码bug或缓存错配证据；E14旧模型私聊额度失败保留，E15新机械命令私聊/Web均独立通过且无需模型 | 查询事实覆盖历史但保留审计；新/旧session、clear、重启分别验证；不以删历史关闭LIVE-001 |
| GAP11 / P1 | 本地配置与运行生效时间、密钥遮蔽需验证；Web配置入口保留但受保护 | 配置文件/CLI/Web→重启→实际 endpoint/model 核对；错误 key/重定向不泄密；allowlist 配置 action 需通过 Host/Origin/CSRF 与输入校验，业务 action 仍须在飞书，删除旧 `config.ai` 全拒绝断言 |
| GAP12 / P1 | 旧 Web 不可见 ACK 失败及修复记录保留；新页面不发送 ACK | WR03/WR04/WR06核对飞书记录展示、不伪造送达、不因打开历史补发或改状态；旧模型历史约束失败继续独立保留 |
| GAP13 / P1 | 本机项目目录、非Git/多目录/worktree、Bypass及清理风险 | E13非法第二目录save拒绝且首目录未初始化Git已证；E13 source-root模板拒绝未按键R-F保留，E14修复后worktree实际执行/原项目及附加目录隔离通过，E15通知unavailable后授权收尾已独立回读通过，未伪造通知送达。冻结快照/旧worktree保护/代码保留仍逐项核对 |
| GAP14 / P1 | setup应用选择/补权与服务唯一连接的真实路径 | 不新建无关app、不污染现用凭据；部分成功与重试阶段精确，B01/B02 |
| GAP15 / P2 | HTTP记忆隔离/超时/迁移provider、长上下文边界 | E11实际50000预算、4批132052bytes自动压缩、原文/约束/session隔离通过；HTTP/provider及超时/失败边界仍分验，不能以Web/API答复代替可见性；E16补15项loopback HTTP协议与11 targeted tests O-P；真实外部供应商TLS/ACL/生产凭据/SLA仍未验 |
| GAP16 / P2 | 三平台发行、依赖原生ABI/许可证/版本、旧部署参数 | E17 a6018ec/345tests/SEA及CI35303089613三平台成功，运行PID32000/SHA87cf…8505已核对；旧E15/E16记录保留。真实旧副本迁移4项R-local-copy/4项O，Linux宿主和完整生产回退未验 |
| GAP17 / P2 | 长期与资源故障 | E11双真实模型只读并发已证实；大任务量/磁盘满/DB损坏/日志增长/WS抖动仍未验，不声称仅并发查询通过即长期稳定 |
| GAP18 / P1 | 飞书业务能力与只读 Web 边界不一致 | 旧W23/W28/W29表单需求撤销；当前业务缺口在飞书/pi工具中核对，Web/API拒绝写入，诊断保持只读；不能以补网页按钮继续扩大范围 |
| GAP19 / P1 | 任务完成事件订阅曾未到达，只能依赖30秒轮询 | E21-R2 在发布 `task.task.update_user_access_v2` 后已由飞书原生完成触发真实事件，强制刷新和默认资源清理均 R-P；重复事件幂等通过。其他事件类型、订阅失效/重连与权限组合仍未验 |

## 10. 每轮关闭流程与记录模板

1. 从账本选取失败/未测项，记录最小可复现输入和预期事实，先区分产品选择与程序缺陷。
2. 修正相关实现，补充能复现该缺陷的离线回归；运行受影响检查。未知结果场景必须验证“不再发一次”，不能仅检查错误文案。
3. 从当前提交构建独立二进制并核对版本；在约定现场窗口替换唯一运行实例。测试实例不得争用生产state或同一飞书连接。
4. 执行本行正常、失败、恢复、权限、投递条件，保存实际证据，按 O/R 分别更新；不能只运行正常路径后全行打勾。
5. 复验相关上下游入口，更新缺陷状态/未解决限制。全部承诺功能有证据或明确未通过项后，再判断持久目标是否完成。

```text
场景ID / 缺陷ID：
提交 / 二进制version / SHA256：
时间（含时区）/ 运行环境 / CLI与模型版本：
owner / chat / pi session / task / participant（脱敏标识）：
前置条件 / 输入原文：
正常 / 失败 / 恢复 / 权限 / 投递：分别列步骤与结果
toolCall与结果 / operations / 外部对象 / 产物 / 用户可见回执：
证据文件或记录位置：
I：入口及边界
O：历史或本轮，实际命令与结果
R：通过 / 失败 / 部分 / 未测，不能跨层推定
后续动作 / 复验关联场景 / 完成时间：
```

撤销范围前的历史离线记录 DOC-UI-01：`node --import tsx --test tests/web/task-form.test.ts`，7通过/0失败，验证项目模式切换不残留写意图、名称边界、当前owner讨论筛选、关联必须保留本次要求，以及与真实taskInput解析器兼容。该记录未启动浏览器、服务或构建，不能作为W28/W29真实通过；现已撤销这两个业务表单的范围，不继续补验。

当前结论：**本轮整改目标仍未全部完成。** E21-R2 的任务事件订阅、原生完成、强制刷新、herdr 关闭、群解散、最终描述和 outbox 已有独立 R-P；E05/E17 继续提供限定的飞书创建与产物证据，LIVE-001及LIVE-004失败历史保留。仍未关闭的包括其他任务类型和多参与者完整组合、审批与权限边界、异常/未知写入恢复、订阅重连、完整 session/archive/restore 组合、长期资源故障、三平台安装回退，以及若干消息格式与投递边界。上一阶段测试总数不能替代这些现场验收。
