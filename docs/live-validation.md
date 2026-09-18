# 功能逐项整改与真实验收矩阵

更新时间：2026-09-18。状态：**本轮目标进行中；功能闭环尚未验收通过。** 范围继承 [重构目标](refactor-goal.md)、[B/N 需求盘点](node-pi-refactor-requirements.md) 和 [设计](node-pi-design.md)。本文件是新的逐项追踪表；[此前验收](acceptance.md) 保留上一阶段离线证据，不代表本轮真实链路已通过。

本次更新独立读取了本地两轮飞书 REST ledger、Web 运行记录、生产回读记录及真实模型探针输出，并只读核对 HTML 产物。详见[2026-09-18 证据分层记录](live-evidence-2026-09-18.md) E01–E06。文档更新本身没有新增外部任务；主验收仍在进行，尚未记录的现场步骤保持 U。

## 1. 状态与证据规则

| 标记 | 含义 | 不能据此声称 |
| --- | --- | --- |
| I | 找到实现入口及其边界，尚不等于正确 | 用户功能已经可用 |
| O-H | 上一阶段历史离线证据；当时 170 tests 和烟测通过 | 当前修改后仍通过、真实模型自主选择工具、真实 herdr/飞书完整链路通过 |
| O-P / O-F | 本轮在指定提交重新执行的离线通过/失败 | 未实际接入的外部服务正确 |
| R-P / R-F | 指定真实环境中明确检查过的通过/失败 | 同组其他场景、其他 owner 或其他执行器也通过 |
| R-部分 | 只证实了部分真实链路 | 完整端到端成功 |
| U | 未执行或证据不足 | 默认通过 |
| D | 产品语义/入口一致性待明确 | 已确认的程序缺陷 |

每个场景均保留“实现、离线、真实”三栏。代码改变后，受影响行恢复为待复验；不得把计划、存在测试文件、服务 `ready`、模型说“完成”、参与者自述或预制模型返回值作为验收成功。真实 pi 循环接本地 SSE fixture 属于离线集成：它验证协议与执行机制，不验证真实模型是否会自主调用正确工具。

每条运行证据记录：场景 ID、提交/版本/二进制 SHA256、时间及明确时区、入口、脱敏 owner/session/task/participant ID、输入原文、环境与数据前提、实际工具调用与结果、操作回执、外部资源观察、用户实际看见的回复、退出/恢复结果、证据位置、判定。不得在文档保存 API key、app secret 或原始进程环境。

## 2. 已知真实结果与整改优先级

| 记录 | 已观察事实 | 判定及后续验证 |
| --- | --- | --- |
| LIVE-001：用户经飞书要求新项目、Codex 制作 HTML 比武页面 | 提供的记录标注 `23:28`，原始事件日期/时区待补齐；inbox=`done`、outbox=`delivered`；checkpoint 没有 `toolCall`；所有 operations 为空；没有对应新 task/group；回复却引用了旧任务 ID 并声称排队 | **R-F：调度执行与事实答复失败；R-部分：接收和文本回复链路有回执。** 不能称新项目、建群或编码已开始。需保留原请求，修复后用实际模型重新执行并核对新对象；仅让 fixture 指定 `task_create` 不构成现场复验 |
| LIVE-002：Web 未展示第二位允许用户的飞书任务 | 该次现象发生时 `snapshot/localActor` 使用 `allowedOpenIds[0]`；飞书按消息 owner 绑定。本轮工作区已新增本机管理身份选择，待验证 | **D：显示身份语义待明确，暂不定性为缺陷。** 分别核对“对象是否存在”和“当前 Web owner 是否有权看见”；不能用 owner 差异解释 LIVE-001 中所有新对象均未创建的事实。不得为消除空列表而直接取消 owner 隔离 |
| BUILD-001：此前测试二进制 | `0.3.0-refactor`；commit `7689cee3163f7da0e02403645bd028c6066113ac`；UTC `2026-09-17T23:21:14Z`；macOS arm64；SHA256 `77f901b4eab28e845af7ba445c0332565dba825a53d667f76e0a2e25e6dc22d1` | 构建与隔离 smoke 的历史证据；不能证明当前运行实例仍为该二进制，也不能抵消 LIVE-001 |

新增实测分层：**Web→真实 Codex→HTML 产物→飞书群结果已走通一条链路，原飞书入站完整创建路径仍待复验**。这不关闭 LIVE-001 的历史 R-F，也不掩盖本轮发现的阶段事实错误。

| 记录 | 已观察事实 | 判定及后续验证 |
| --- | --- | --- |
| LIVE-003 / E05：Web 新项目 Codex 链路 | 真实新任务、herdr Codex、目录信任处理后产出 HTML；群 GET 存在署名最终结果；远端任务未自动完成 | 各阶段 R-P，完整功能组 R-部分；飞书入站创建、页面视觉验收、恢复/异常 U |
| LIVE-004 / E05：阶段事实提前 | 创建刚 accepted/queued 就声称远端资源和投递完成；welcome 未启动即称已开始；blocked 称仍在处理中 | **R-F 历史保留**；提示词/工具描述和通知 participants 已修。E02/E03 真实模型+合成回执/事件通过，修正后真实服务同阶段复验 U |
| REST-001/002 / E04 | 第二轮真实创建任务/群、发消息、更新描述、完成/重开/再完成、解散，各有 GET；两轮测试群已清理、任务已完成 | 独立 REST 阶段 R-P；成员查询权限不足仍 R-F，不能宣称整轮通过或全部 TaskService 生命周期通过 |
| MODEL-001 / E01–E03 | 15 次主协议首步决策、1 次另一协议查询、1 次修订后首步；2 场景×2 轮状态追问、welcome/blocked 通知 | 仅模型决策/事实措辞 R-P；原工具未执行，不能充当外部资源或执行器验收 |

**已确认审批规则：保留现有 Bypass，只处理仍出现的确认。** 当前任务绑定工作目录的启动信任由专用 pi 流程识别并经受限工具确认；其余确认必须任务群内用户选择。目录范围含已有项目新参与者、worktree、无项目讨论，不限新建项目。新自动流程仍需独立真实验收，不能用既有手动信任记录代替。

优先顺序：先修 LIVE-001 并证明“真实请求→自主工具决策→持久任务→真实资源→结果可见”；再逐项核验入口差异、身份、生命周期和恢复。发现新问题时登记缺陷及关联场景，不用整体 tests 数字替代单项关闭。

## 3. 执行协议与通用判据

测试数据使用独立命名：项目 `validation-<run>`、session `验收-<run>`、任务 `验收-<run>-<case>`。A/B 表示两个不同允许 owner；C 表示不在允许名单中的身份。记录各对象 ID，避免把旧任务或旧 transcript 误认为本轮结果。实际外部操作由负责现场的执行者在当前授权范围内执行；本矩阵不是后台自动启动第二条飞书连接的脚本。

| 判据 | 可执行步骤与通过条件 |
| --- | --- |
| F1 输入/配置失败 | 提交空要求、非法枚举/ID/目录或不匹配选项；操作前后比对 ledger、任务和外部资源，无副作用；给出可理解错误 |
| F2 明确未执行 | 在外部调用前令依赖返回明确拒绝；恢复依赖后只重试该失败步骤；成功步骤计数不增加 |
| F3 结果未知 | 让服务端已接受写入但客户端丢回执；记录 `unknown/uncertain`，重启后只读核验，不静默重发、不换参数绕过去重 |
| F4 崩溃/恢复 | 在登记前后、外部创建后、收到最终结果后、投递前后分别中断测试实例；恢复同一 state-dir，核对每步至多一次及未完成意图保留 |
| F5 输出/会话变化 | transcript UTF-8 尾部半行、截断、inode 替换、原生 session 变化、pane 消失；旧输出不重放，新完整输出不丢失 |
| F6 模型行为 | 用真实已配置模型输入原始/同义/否定/多轮修订请求；检查真实 toolCall 与参数。无工具调用时不可声称已登记、创建、启动或完成；只读状态必须来自查询事实 |
| F7 网络与配额 | 401/403/429/5xx、DNS/超时、模型中断、WebSocket 重连；错误分类清楚，不擅自注册新应用、重复建群或重放终端输入 |
| A1 owner | A/B/C 分别操作同一 ID；合法 owner 正常，异 owner/未授权身份拒绝，读/写/卡片回调均验证 |
| A2 chat/session | 在任务群引用另一任务、在入口切换/归档 session、在任务群尝试建另一个任务；actor 使用接收时绑定，不因稍后选择变化而改道 |
| A3 审批/授权 | 替换 pane/kind/workspace/session/stateSeq 或过期 nonce；旧审批拒绝；参与者文本、摘要、引用、工具结果不成为新用户授权 |
| D1 飞书可见 | 除 outbox receipt 外核对实际目标 chat、回复引用、文字内容和长消息全部片段；旧/错群送达不算通过 |
| D2 Web 可见 | 先实际显示当前 session 消息再 ACK；仅当前可见消息计入 delivered；ACK 失败可重试 ACK，不重发原用户请求 |
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

以下 O-H 引用历史测试目录，表示曾有相关离线覆盖；不保证本行全部异常、权限和现场组合均测过。本轮“离线复验”初始均为 U。

| ID | 正常执行步骤与必要结果 | 失败/恢复/权限/投递检查 | 实现与历史离线依据 | 真实状态 |
| --- | --- | --- | --- | --- |
| B01 | `setup` 新注册、复用、明确 `--app`、补授权分别执行；保存正确应用，私聊与精确 nonce 卡片往返 | F1/F7；取消/超时/身份不匹配；保存成功但回调未完成返回部分成功；A1/A3/D1 | I；O-H `tests/onboarding/`、`tests/cli/run.test.ts` | U，不能拿已有机器人可发消息证明注册全流程 |
| B02 | `serve` 获取排它锁→迁移→Web→校验权限/herdr→唯一平台连接 | 失权/断线/协议失败时保持可修复状态；F2/F4/F7，拒绝第二实例 | I；O-H cli/storage | R-部分：LIVE-001 入站/回复及 E05 真实运行；启动补权/重连/唯一连接完整流程 U |
| B03 | `doctor [--json]`、debug ls/screen/transcript 分别核对实际宿主结果 | 不启动编码、不建立第二平台长连接；不可读报 unknown；脱敏，宽度仅估算 | I；O-H cli/host-checks | U |
| B04 | 登记已有项目，验证全部有序目录与默认 agent/default project；任务冻结目录快照 | F1/F2；第二目录无效不先改首目录；A1/A2；bypass仅影响新执行器 | I；O-H projects/config | R-部分：E05 新项目目录和 Codex 配置进入任务；已有多目录/default/冻结快照各组合 U |
| B05 | 明确新项目指令→创建目录/Git/登记；普通新任务只复用项目 | 名称穿越/占用拒绝；F3/F4；删除登记不删代码 | I；O-H projects；LIVE-001 | R-P：E05 Web 新项目创建及 HTML 产物；LIVE-001 飞书调度历史 R-F；穿越/占用/恢复现场 U |
| B06 | 讨论/开发/评审/测试四类任务各创建；关联要求、参与者、可选群/远端任务 | F1/F3/F4、A1/A2、D1；无平台时保留用户建群意图；显式本地任务能运行 | I；O-H app/tasks/feishu/cli integration | R-部分：E05 开发任务、真实飞书任务/群；E01 discussion 仅首步决策通过，另外类型与异常现场 U |
| B07 | Claude/Codex 各启动，核对实际 argv、多个目录、bypass和唯一初始 receipt | 保留 Bypass；仅当前任务绑定启动目录信任可由专用pi确认，其余群用户选；F3/F5/A3/D3 | I；O-H herdr/lifecycle、tasks | R-P：E05 真实 Codex 手动目录信任后执行并产物；新 pi 自动信任、Claude、多目录/仅一次投递的完整现场 U；保留 Bypass |
| B08 | 在绑定群续聊/引用、非任务群 @机器人、修订/否定/含糊输入各一例 | A1/A2/A3，F6；完整约束转交、unsupported资源不虚构；D1/D3 | I；O-H app/conversations、runtime | U |
| B09 | 多 owner/多任务/多 session 查未结束和 all，核对真实状态与链接 | A1/A2、F6；任务不存在不得编造；query readError不可说运行正常 | I；O-H app/tasks/runtime；LIVE-002 | R-部分：E02 查询后阶段答复正确（合成回执）；LIVE-001 历史 R-F；真实飞书入站查询进行中，Web owner 组合 U/D |
| B10 | Claude/Codex 输出观察、署名与群消息/远端描述/Web历史逐一对应 | F3/F4/F5，D1/D2/D4；cooldown只合并进度；迟到结果不驱动新任务 | I；O-H transcripts/tasks/app presentation | R-P：E05 Codex 最终结果群 GET、真实文件、远端描述核对；阶段通知历史 R-F，修正后真实通知/Claude/恢复 U |
| B11 | 目录信任以外的实际 blocked→任务群用户选项→Guard验证→执行；单人/all中断 | A1/A3；回调竞态/双击/过期/换现场；显示裁剪不改完整Guard；D1/D3 | I；O-H approvals/herdr/legacy fixtures | R-部分：E05 真实 Codex 手动信任处理后继续；不等于新自动信任或群内用户卡片点击。其余菜单群审批/过期/替换现场 U |
| B12 | `complete` 同步远端完成，保留执行现场和群；reopen后方可追加 | F3：只回读确认，不重复PATCH；D4；完成≠销毁 | I；O-H tasks lifecycle/completion-description | R-P：E04 真实 REST complete/reopen 及 GET；TaskService complete/reopen 全链和未知结果恢复仍 U |
| B13 | 明确 close/外部勾完成→采最后结果→完成同步→关闭通知→资源清理 | F2/F3/F4，A3，D4；远端未确认不清理；模型通知失败不虚报完成 | I；O-H tasks/app | R-部分：E04 REST 完成和解散群已回读；真实 TaskService close 顺序、外部勾选与最后结果收尾 U |
| B14 | destroy不代验收，关闭受管资源但保留代码/历史；已销毁拒绝reopen | 部分清理失败恢复；不关闭别的pane/group；F3/F4/A1/A2 | I；O-H tasks/projects | R-部分：E04 仅测试群解散可确认；TaskService destroy、pane/workspace 清理和恢复 U |
| B15 | 明确失败重试、未知写入冻结、重复事件、停机中断后恢复逐项执行 | F2/F3/F4/F7；inbox/outbox/operations/checkpoint跨进程一致；D1/D2/D3 | I；O-H storage/app/tasks | U |
| B16 | session创建/选择/重命名/归档/恢复/clear、历史/摘要与provider切换 | A1/A2；未送达建议不进可见上下文；内存服务失败保留历史；代数/并发竞态；D2 | I；O-H runtime/migration | R-部分：E01 真实模型 switch/archive/restore 首步正确，E05 独立 pi session 使用；持久效果/跨入口/重启 U |
| B17 | tasks关闭时 /ls选择、引用优先、/card、/say、/stop、/mirror、/close逐项验证 | 错误旧绑定拒绝；解除不复活；notify_chat基线、F3/F5/A1/D1/D3 | I；O-H legacy/herdr/migration | U |
| B18 | 单二进制安装、版本核对、服务管理器重启、迁移/回退、长期保留 | 仅桥停止不杀herdr；锁清理、磁盘异常、日志/DB增长、三平台；F4/F7 | I；O-H build/cli/storage，BUILD-001 | 运行启动证据需补；长期运行/Linux现场 U |
| N01 | “当前有哪些任务/谁在等待/我该做什么”真实模型查询工具后答复 | F6，A1/A2；摘要和参与者自述不可替代当前事实 | I；O-H engine/app | R-部分：E01 查询自主调用 tasks_list；E02 多轮查询事实措辞通过（合成回执）；真实飞书查询进行中，LIVE-001 历史 R-F |
| N02 | 明确仅讨论→无项目或已有项目→单Claude/Codex参与需求讨论 | pi不能自行替项目写方案；禁止编码的要求完整保留；D3/D4；F6 | I；O-H tasks/prompts | R-部分：E01 创建只讨论任务的参数含 discussion/Claude/Codex；真实单参与者讨论与禁止编码行为 U |
| N03 | Claude+Codex同群轮流讨论，署名可辨、ID可定位；同种多实例另测 | 手动/轮询、轮数/时限、迟到输出、同名拒歧义、未知relay暂停；F3/A2/D4 | I；O-H discussion/app/cli integration | R-部分：E01 仅证实真实模型安排两类参与者；实际双方群内多轮/轮转/同种实例 U |
| N04 | 讨论→用户明确转开发/评审→`parentTaskId`冻结上下文→共享目录或worktree | 后续修订优先、不漏禁止事项、不读错owner；完整真实模型交接；F6/A1/A3 | I；O-H lifecycle/projects | U |
| N05 | 主入口切换pi session后继续；herdr原生session保持托管 | 已接收排队消息不改道；任务群不可切换；A1/A2，归档与clear分别验证 | I；O-H runtime/app | R-部分：E01 session_select 首步正确；实际切换、队列绑定、归档恢复和 herdr session 保持现场 U |
| N06 | pause停止后续调度，interrupt影响选定执行器，resume恢复有界轮转 | pause不宣称已停止正在编码；迟到结果保留不转发；F3/F4/D4 | I；O-H discussion/lifecycle | U |
| N07 | 结束讨论但保留关联开发、分别完成/关闭与保留群 | 不级联未授权任务，不由pi代判业务结论；A2/A3/D4 | I；O-H lifecycle | U |

## 5. CLI 全入口矩阵

本节每行实现为 I、历史证据为 O-H `tests/cli/`（迁移另见 migration，构建另见 build）；本轮执行与真实状态均 U，除表中明确记录。CLI 参数详情以 `src/cli/args.ts` 为准；`--json`被解析不等于每个子命令所有错误都有统一JSON，需实际核验。

| ID / 入口 | 正常步骤 | 失败、恢复、权限与输出核对 |
| --- | --- | --- |
| C01 `help` / `-h` / `--help` | 核对主命令、诊断命令和当前flags | 不打开state/网络；未知命令/多余参数退出2；帮助不承诺未暴露功能 |
| C02 `version` / `-v` / `--version` / `--json` | JSON与文本同时核对commit/date/version/实际安装文件 | 不读生产state；旧二进制路径不得当新版本；BUILD-001是历史通过 |
| C03 默认无命令/`serve` | 记录Web地址、authorization/runtime、唯一连接与停止退出码 | F2/F4/F7；herdr探测失败不得开始任务；凭据不足Web能解释等待 |
| C04 `serve --config-listen` / `--no-config-ui` / `--open` | 指定回环/关闭UI/尝试浏览器分别运行 | 非回环/端口占用/浏览器失败明确；后台服务不意外打开浏览器 |
| C05 `configure --listen` / `--open` | 本机配置、会话/任务管理；不连飞书长连接 | 配置损坏修复界面、同state锁；它会调度本机任务，不能当纯只读命令 |
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

## 6. Web 全入口矩阵

I 表示 action 或页面路径已存在；O-H 来自 `tests/web/`、`tests/app/` 与历史Chromium假后端QA，不能据此认定每个真实表单已测。除 E05 的 Web 新建会话、chat.send 和现场信任处理部分外，页面全场景仍 U；该 API/实际业务证据不能替代桌面与移动布局、ACK及每个表单点击验收。W01/W27 的owner表现关联 LIVE-002/D，身份组合仍待复验。本轮要为每行分别记录桌面和390px可见结果，以及浏览器console/pageerror。

| ID / 页面或API | 正常执行与预期可见结果 | 失败/恢复/身份/回执 |
| --- | --- | --- |
| W01 `GET /api/state`、四页与导航 | owner、sessions/tasks/participants/projects/model字段准确；默认任务session以标题显示，用户rename保留 | LIVE-002先核验本机owner语义；禁止跨owner泄漏，不把空列表判作所有任务不存在 |
| W02 `/` `/styles.css` `/app.js`、嵌入静态资源 | 脱离源码运行、移动布局、空态、长列表/中文/长输出 | 404不暴露文件；CSP无内联脚本；加载失败明确，不显示陈旧成功 |
| W03 `GET /api/events` / 15秒刷新 | 状态改变可见，断线重连、正在编辑不丢草稿 | SSE限额/背压/关闭释放；切页后不确认未显示消息；D2 |
| W04 `POST /api/actions` | 合法Origin+CSRF的单次请求执行一次 | Host重绑定/跨站/缺token/非JSON/超1MiB/未知action拒绝且无副作用 |
| W05 `session.create` | 创建独立会话并选中 | 名称空/过长、未setup、重复点击；不创建编码任务 |
| W06 `session.select` | 切换当前会话且还原各自草稿 | 归档/他人/无ID拒绝；已接收消息保持旧actor，D2 |
| W07 `session.rename` | 列表/标题同步，刷新后保留 | 无效名称/跨owner拒绝；默认标题映射不能覆盖用户名称 |
| W08 `session.archive` / `session.restore` | 各执行一次，归档历史可读、恢复后可选 | 活动回合取消、迟到reply/ACK、任务现场保留；恢复不是新建session |
| W09 `session.clear` | 新generation、历史归档、当前上下文清空 | 任务绑定session/并发回合/重复操作核对；不得清除herdr session或任务 |
| W10 `session.history` | 活动/归档历史按session/owner返回并展示 | 选择别的session不能混入；未知ID/A1；未送达消息标记真实 |
| W11 `chat.send` | 明确操作请求走真实模型工具；回复先显示 | F6/F7；API成功不代表业务已执行；输入保留、重复请求与并发行为 |
| W12 `chat.ack` | 当前实际显示的回复/参与者输出记delivered | A1/sessionId匹配、重复ACK幂等、失败仅重试ACK、隐藏session不ACK |
| W13 `task.create`表单 | 四类、1–8参与者、已有/新建项目/无项目讨论、可选关联讨论、独立session、shared/worktree、建群/远端task/保留选项 | 默认round_robin/4轮/30分；50轮/240分边界；绑定task session排除、空session明确；F1/F3/D3 |
| W14 `task.get`、任务列表/详情/历史 | 状态、错误、参与者、结果、链接正确 | 其他owner/无ID/同名歧义；无group/remoteTask的本地任务不显示假链接 |
| W15 `task.action` complete/close/destroy | 每个动作分别确认后核对B12/B13/B14资源差异 | 取消确认无操作；未知结果不重复；完成未同步不清理；D4 |
| W16 `task.action` reopen/retry/pause/resume | 分别按原状态验证；恢复预算与历史保留 | destroyed拒重开、completed拒直接resume/send、unknown拒自动retry |
| W17 `participant.add` / `participant.remove` | 指定kind/name/role新增，移除只关闭该受管窗口 | 上限/未启动/不存在/重名/当前轮转者移除；F3/A1/A2 |
| W18 `participant.send` | 用ID或唯一名称转完整文本到指定执行器 | 多人未指定、同名拒歧义；blocked/working/queued/unconfirmed分别展示 |
| W19 `participant.interrupt` 单人/`all` | 只中断选中或全体，并暂停自动讨论 | 空/错ID明确，不能误中断别的任务；部分失败如实呈现 |
| W20 `participant.screen` / `participant.answer` | 展示裁剪现场+完整选项，手动nonce选项送出 | 身份/状态/nonce过期/重复/消费竞态；Esc也需明确操作；A3 |
| W21 `project.save` | 新登记/编辑已有目录，默认agent/多目录顺序 | 不存在路径/非目录/路径权限；全部校验后才初始化；已建任务快照不变 |
| W22 `project.default` / `project.delete` | 切默认；移除登记保留代码，引用清晰 | 删除默认项、仍有任务的项目；撤销确认不执行 |
| W23 `project.create` API | 明确新项目名创建目录/Git/登记 | I：API有实现；**页面未提供独立新建目录表单，入口差异D**；F1/F3 |
| W24 `catalog.bypass` | 勾选经确认、刷新后持久；仅新agent使用 | 取消不改变；不暗改当前agent的审批策略 |
| W25 `config.ai` | provider/model/baseUrl/key/enabled保存；显示重启生效；key不回填 | 非法URL/协议/缺key拒绝；保存失败不误显示成功；模型未连通不能称验证通过 |
| W26 授权/运行状态、错误反馈、确认弹窗 | 配置待修/授权链接/未知结果有实际可操作说明 | 自动刷新不覆盖用户输入；不凭runtime=ready宣称任务已执行 |
| W27 `identity.select`（本轮新增） | 在允许owner A/B间显式选择；查看各自session/task，不移动或合并旧记录 | 未允许owner拒绝；expectedOwnerId拦旧页面操作；切换中的ACK/迟到回复/草稿/缓存不可跨身份显示；重启保存的选择撤销授权后失效 |
| W28 新建项目表单（本轮新增） | 显式选择新建，输入名称，task.create提交project与newProject=true；切回已有/无项目不带残留新建字段 | 同名、穿越、空名/超长拒绝；选择已有项目不创建目录；O-P：本轮task-form.test.ts输入边界通过，真实目录/浏览器U |
| W29 关联讨论表单（本轮新增） | 只列当前owner的discussion任务，显示title与ID；选择后提交parentTaskId，必须填写本次完整要求 | 他人/非discussion/陈旧选择拒绝；旧要求/结论不替代本次输入；O-P：本轮task-form.test.ts通过，真实交接/浏览器U |

`project.create`、`task.get`等 API 无独立UI按钮不等于功能不存在；反之页面可操作不表示 pi 自然语言有对应工具。本轮任务表单已接入 `newProject/parentTaskId`，采用已有task.create语义；真实页面点击和服务创建仍待验收。

## 7. pi 工具全量矩阵（当前工作区20个）

工具清单来自 `src/app/tools.ts`：基线7689cee有18个，本轮工作区新增T19/T20，尚未据此标为测试通过。前8个可用于任务群；其余仅主入口。所有行均 I；历史 O-H 仅代表 engine/app/tasks/runtime 等测试存在相关机制覆盖；E01 仅验证部分工具的首个真实模型决策，E02 验证多轮真实模型读取合成状态，E05 验证一次真实 Web 创建业务链；各行完整正常/异常组合仍 U。LIVE-001 关联失败保留历史。执行时先让真实模型自行选择工具，再补显式Web/API的确定性对照，不能把后者冒充前者。

| ID / 工具 | 正常请求与要核对的工具参数/结果 | 失败/恢复/身份/投递 |
| --- | --- | --- |
| T01 `tasks_list` | “列未结束任务/含历史”，all含义、群内只绑定任务 | A1/A2/F6；无调用不得声称查询；LIVE-001事实答复失败 |
| T02 `task_get` | 指定真实task，包含参与者实时runtime与observedAt/readError | 无ID/异owner/pane替换；readError不是正常运行；LIVE-001旧ID/排队无依据 |
| T03 `participant_screen` | 指定participant真实完整screen/options | 只读、不批准；多参与者必须明确，A2/A3 |
| T04 `participant_send` | 转完整原始要求、修订/否定到指定执行器 | F3/F6/A2/D3；真实blocked/queued/unconfirmed不可改称delivered |
| T05 `task_action` | complete/close/destroy/reopen/retry/pause/resume各实际一例 | 每个动作匹配明确授权；“不要关闭/完成后再关”不执行；F3/A3 |
| T06 `participant_interrupt` | 单人或all，核对所有目标和暂停状态 | 同名/未指定/错任务、部分失败；不得说暂停就等于进程已停 |
| T07 `participant_add` | 指定claude/codex/name/role，后续有界调度 | 8人上限、重复/失败/未知创建，不重建已成功资源 |
| T08 `participant_remove` | 指定ID移除并关闭其受管pane，保留历史 | 对当前发言者与已gone分别测；A1/A2/F3 |
| T09 `project_save` | 已有多目录、agent、makeDefault，准确登记 | F1/F2；不擅自把新任务变成新目录；既有任务冻结快照 |
| T10 `project_create` | 只有明确新项目才创建并初始化 | 重复名称/占用/穿越/权限错误；F3；LIVE-001未进入此路径 |
| T11 `project_remove` | 移除登记，明确代码仍保留 | 不误删文件/任务，默认项目失效处理 |
| T12 `session_clear` | 用户明确clear，当轮回复持久后生效 | 不清任务群/编码session；generation与可见答复匹配；未完成回合失败不假称成功 |
| T13 `projects_list` | 查询目录/default agent/Bypass实际值 | 无配置返回事实空态；不读项目源码代做需求 |
| T14 `task_create` | 四种kind、完整requirements、participants、目录模式、newProject/parentTaskId、建群/远端task、讨论预算 | F1/F3/F4/F6，A1/A2/D1/D3；accepted仅已登记；**LIVE-001 历史失败保留；E05 Web 真实开发创建通过，accepted 时事实答复失败；四类型及恢复未全验** |
| T15 `sessions_list` | 当前owner活动/archived=true列表 | 群内无此工具；A1；不混淆pi与Codex/Claude原生session |
| T16 `session_create` | 名称及select布尔，切换仅后续消息 | 不创建task/agent；A2与排队actor，失败不误切 |
| T17 `session_select` | 选存在的独立session，Web/飞书入口分别核对 | 他人/归档/task绑定拒绝，已接收消息不重路由 |
| T18 `session_rename` | 名称与已有session ID，刷新后准确 | 空/超长/外owner拒绝；不改变任务关系 |
| T19 `session_archive`（本轮新增） | 归档主入口会话；当前回合答复持久后生效，历史/任务/herdr保留 | 当前回合异常不假报成功；异owner/task绑定拒绝；排队消息与迟到ACK不复活归档；E01真实模型首步正确；实际持久效果及本行异常现场仍待验 |
| T20 `session_restore`（本轮新增） | 恢复已有主入口归档，随后显式session_select，保留原历史 | 他人/任务绑定拒绝、不新建；与Web选中状态一致；E01真实模型首步正确；实际持久效果及本行异常现场仍待验 |

入口差异：基线缺少 `session_archive/session_restore` 工具，盘点期间工作区已新增T19/T20；必须补真实模型自然语言及旧 `/session` 文本的调用验证，不能仅因工具已加入就关闭缺口。没有独立 `project_default/catalog_bypass/config.ai` pi工具；`project_save(makeDefault)`可设置默认项目，但其它控制仅Web/API。普通会话没有任意shell/编辑/人工审批工具是职责边界。另有专用启动上下文的 directory_trust_confirm，仅确认绑定目录的原生信任菜单；不计入上述20个普通工具，不作为通用审批能力。

## 8. 飞书入口与兼容模式

| ID | 操作组合 | 必须验证的边界 | 状态 |
| --- | --- | --- | --- |
| FSH01 AI启用 | 私聊文字、富文本、斜杠、引用、多轮指代、图片/附件/语音占位 | 全部由模型沟通决策；未知资源不虚构内容；模型失败不落传统命令或终端原文 | I/O-H，LIVE-001调度事实失败，其余U |
| FSH02 群/身份 | 任务群、非任务群@/不@、异owner、回调非owner | owner与chat绑定；当前任务群不能跳转其它任务；callback等同严格验证 | I/O-H，现场U |
| FSH03 AI关闭、tasks启用 | `/help /doctor /projects /tasks [all] /sessions`；`/session new\|switch\|rename\|archive\|restore` | 返回确定性控制结果；任务群禁止切换；无AI不冒充pi沟通 | I/O-H，现场U |
| FSH04 AI关闭、tasks启用 | `/new <项目> [agent] <要求>`、自然“新建任务”、`/task`七动作、`/screen /stop` | 完整参数/默认agent；关闭/确认关闭中文别名与否定区分；多参与者明确ID | I/O-H，现场U |
| FSH05 `/clear`跨模式 | AI启用文本由模型session_clear处理；AI关闭命令拒绝ai_disabled | 不把源码中的传统clear分支当AI模式的直接命令保证；task群禁止clear | I/O-H，现场U |
| FSH06 tasks关闭兼容桥 | `/ls`选中；引用优先；`/card /say /stop /mirror on\|off /close /help`，普通文本续聊 | 只按已有herdr agent发送；/close仅解除选中；notify_chat只选可信owner；旧路由核验 | I/O-H，现场U |
| FSH07 消息回执 | 长消息分片、重复event、空messageId回退、卡片重放、飞书事件重连 | 可见片段齐全且目标正确；去重不吞合法新消息；F3/F4/D1 | I/O-H，LIVE-001仅证明一条文本outbox回执，完整范围U |

## 9. 横向遗漏检查与本轮缺陷账本

| 编号 | 检查项 / 判定 | 下一步与关闭证据 |
| --- | --- | --- |
| GAP01 / P0 | 真实模型没用工具却声称执行成功（LIVE-001） | 修复模型输入/工具声明/运行链路与事实约束；L01真实重验，保存toolCall、ledger与外部产物 |
| GAP02 / P0 | 成功定义过度依赖inbox done/outbox delivered | 单独记录“收到/模型完成/工具执行/资源存在/输入确认/业务产物/用户可见”；任何层失败不得提升为下一层成功 |
| GAP03 / D | Web原先固定首owner，工作区新增显式选择但尚未现场验收 | 核对本机管理身份语义与W27；测试A1/陈旧请求/撤销授权/缓存隔离，不把原现象自动定性为缺陷 |
| GAP04 / P1 | AI session归档/恢复基线入口能力不对齐，工作区已补工具 | T19/T20继续验证真实模型调用、权限、当前回合延迟归档和恢复；实现新增不等于现场通过 |
| GAP05 / P1 | 新项目与讨论→开发交接缺少真实完整证据；Web入口本轮已补 | L01及N04/W28/W29；输入边界7测试通过仅属O-P，仍需实际页面→API→目录/任务→编码产物验收 |
| GAP06 / P1 | E05 Codex 既有手动信任链路通过，新 pi 自动目录信任及其他群审批未全验 | 保留 Bypass；B07/B11各执行器分别验证专用自动信任、剩余菜单用户选择、重复/换现场/未知写入；E05不冒充新流程通过 |
| GAP07 / P1 | unknown/uncertain、重启和迟到结果只已有离线机制证据 | 在隔离实服务对象上做F3/F4/F5；恢复无重复群/task/pane/terminal输入 |
| GAP08 / P1 | E04 REST完成/重开/解散通过，E05结果描述经主验收核对；应用生命周期仍未全验 | B12–B14补TaskService操作顺序/未知结果/资源保留；descriptionMatchesOutput:false为Markdown归一化比较问题，不误记漏传缺陷 |
| GAP09 / P1 | E04/E05任务/群/消息已有真实GET；成员列表查询缺权限99991672，卡片/引用/分片未全验 | 只确认邀请请求及user_count=1；补roster权限与群客户端/卡片回调/引用/分片证据，不能把GET代替全部用户可见验收 |
| GAP10 / P1 | E01合成虚假历史3次均实际选择创建；E02多轮纠正状态前提通过，真实历史/重启仍未全验 | 查询事实覆盖历史但保留审计；新/旧session、clear、重启分别验证；不以删历史关闭LIVE-001 |
| GAP11 / P1 | config.ai保存与运行配置/生效时间、密钥遮蔽需完整验证 | 保存→重启→实际endpoint/model核对；错误key/重定向拒绝不泄露key；Web不误报已连通 |
| GAP12 / P1 | Web async刷新、归档历史、并行操作与ACK竞态 | 当前页面/隐藏session/切页/断网/重试ACK各执行，不能因HTTP200提前记可见 |
| GAP13 / P1 | 本机项目目录、非Git/多目录/worktree、Bypass及清理风险 | 全目录先校验、冻结快照、已有worktree保护；删除登记/销毁均不删用户代码 |
| GAP14 / P1 | setup应用选择/补权与服务唯一连接的真实路径 | 不新建无关app、不污染现用凭据；部分成功与重试阶段精确，B01/B02 |
| GAP15 / P2 | HTTP记忆隔离/超时/迁移provider、长上下文边界 | 新旧provider不静默回退，摘要不成为授权，单条超预算失败保留已执行receipt |
| GAP16 / P2 | 三平台发行、依赖原生ABI/许可证/版本、旧部署参数 | 各平台原生CI证据和空目录smoke；安装文件hash等于测试产物；可回退而不反向伪迁移 |
| GAP17 / P2 | 长期与资源故障 | 真并发/大任务量/磁盘满/DB损坏/日志增长/WS抖动；逐项记录降级与恢复，不声称仅启动即稳定 |
| GAP18 / D | API有实现但UI没入口/模型无工具、诊断输出语义 | W23及W28/W29新项目/关联讨论、T19/T20新增session动作、debug transcript语义逐项决定承诺，文档与实现一致 |

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

本轮新增离线记录 DOC-UI-01：`node --import tsx --test tests/web/task-form.test.ts`，7通过/0失败，验证项目模式切换不残留写意图、名称边界、当前owner讨论筛选、关联必须保留本次要求，以及与真实taskInput解析器兼容。该记录未启动浏览器、服务或构建，不能作为W28/W29真实通过。

当前结论：**未完成本轮整改目标。** E05已证实一条Web到真实Codex产物和飞书群结果链路，E04证实指定REST生命周期，E01–E03只证实真实模型在所测输入/受控回执上的决策和措辞。LIVE-001及LIVE-004失败历史保留；新版本真实通知、pi自动目录信任、其他群内审批、真实飞书入站完整创建、多参与者讨论、恢复和权限组合等仍需逐项补证。上一阶段170项测试不能替代这些现场验收。
