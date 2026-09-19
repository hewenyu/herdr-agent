# E38：多项目、Web 配置和会话切换的真实验收记录

日期：2026-09-19；下文时间均为 UTC。本轮从已发布的 **v0.3.13** 开始，组合验证真实 Web 项目配置、主私聊会话创建、默认项目执行，以及已有任务阻塞时创建另一个项目。**本轮部分验收已收尾：B1 在修复版上自动确认目录并完成产物与检查；测试群和绑定执行器已清理，默认项目已恢复。Web 错误呈现及新飞书任务的原文保真复验仍受桌面不可用阻塞，整体目标 active。** 下文初始业务快照截止 `12:24:56.974193Z`，保留原失败，修复和收尾证据见后续时序。

## 运行版本与证据来源

`.cache/live/e38-deployment.json` 记录：

- 版本 `v0.3.13`，提交 `492d4edf190ea569595263e7a6e5de2b828df321`。
- 构建时间 `2026-09-19T19:56:29+08:00`（`11:56:29Z`）。
- 二进制 `.cache/releases/v0.3.13/darwin-arm64/herdr-agent`，PID `24113`。
- SHA256 `2af27fcef2744bc4a41a881dd41114bfe0abfe28ff5f84f0dadcf4a869d11205`。
- 运行日志 `~/.herdr-agent/e38-runtime.log`。

`.cache/live/e38-doctor.json` 中配置、herdr、Claude/Codex 安装、飞书权限、owner、pi 配置、hook 文件和检测规则等检查通过；herdr 为 `0.8.0`、协议 `19`。pi 检查未调用模型，Codex hook 文件存在不证明已在原生客户端确认信任，pane-width 仍为 unknown。doctor 不代表业务执行通过。

真实 Web 操作由主验收者在 Chrome 中完成，真实业务请求通过飞书主私聊进入。状态文件中的 `source` 为 `SQLite mode=ro, PRAGMA query_only=ON`；其中远端操作 done 是持久化回执，不冒充后续独立 REST 回读。缓存快照为本地验收材料，不随仓库发布，也不在文档复制模型推理或密钥。

## Web 保存、非法目录错误与编辑后快照

`.cache/live/e38-baseline.json` 建立两个临时项目的输入文件与 SHA256 基线，根目录为 `/var/folders/vh/fv9dxg9s01v0s6y0bj600ztm0000gn/T/myrix-e38-projects-i6y9ntq_`。以下用 `ROOT` 代指该目录。

真实 Chrome 添加项目时，先提交了有效主目录与不存在的附加目录。服务端拒绝该保存，但错误提示显示在弹窗后方的页面，用户在仍打开的弹窗中看不到具体错误，弹窗的无障碍树内也没有该错误。**非法配置被拒绝与用户能看懂失败原因是两项不同结果；此轮错误呈现为 R-F。** 这段 UI 观察由主验收者记录，当前列出的 JSON 不含该次浏览器截图或完整错误原文，不能据其补造精确错误文字或独立截图证据。

随后真实 Web 保存成功。`.cache/live/e38-web-project-saved.json`（`12:16:40.492312Z`）确认：

| 配置项 | 已保存值 |
| --- | --- |
| 项目 | `MYRIX-E38-WEB-A` |
| 有序目录 | `ROOT/a/main`、`ROOT/a/extra` |
| 默认参与者 | `claude` |
| 默认项目 | `MYRIX-E38-WEB-A` |
| Bypass | `true` |

A1 创建后，Web 将同一项目的默认参与者改为 Codex，并将附加目录改为 `ROOT/a/extra-new`。`.cache/live/e38-after-web-edit.json`（`12:23:16.762126Z`）记录 catalog 已保存 `agent=codex` 和 `[a/main, a/extra-new]`，而旧 A1 的 `directories/sourceDirectories` 仍是 `[a/main, a/extra]`，唯一参与者仍为 Claude。这证明该次配置编辑未覆盖已创建任务的目录与参与者快照；还不能证明新任务已使用修改后的目录完成实际读写。

初稿整理时只读检查发现 `ROOT/a/main/.git` 存在，`ROOT/a/extra/.git` 不存在。该检查不追溯证明非法目录提交时未产生副作用，主目录 Git 初始化的前后证据仍需结合主验收者现场记录补充。

## S1 与 A1：需求忠实性失败保留

真实私聊消息 `om_x100b65d39b05a8a0b29d60e6fbc4088` 在 `12:17:33.083Z` 要求只新建并选中 `MYRIX-E38-S1`。pi 调用 `session_create`，生成 `s_120e6e58-bffe-4573-8a1b-79724b6a95e7`；inbox done，回复 `om_x100b65d398551cacb2263548ca3ce1a` delivered。创建任务的下一条消息实际绑定该 S1。

消息 `om_x100b65d3961fd8a0b1cc8d4854ccc8e` 在 `12:18:21.681Z` 入站，要求使用默认项目和单名默认参与者，建立飞书任务与群，读取主目录、附加目录各自的 `input.txt`，将两条原文按目录顺序写入**主目录** `brief.md`，检查后询问红色或蓝色并等待用户继续。约束包括保留 Bypass、仅自动处理目录信任、其他确认由群用户选择、不提交 Git、不创建 worktree、不自动完成或关闭。

`.cache/live/e38-requirements-corruption.json` 与后续快照记录了以下实际差异：

| 用户原文约束 | 实际登记的 A1 requirements |
| --- | --- |
| “把两条原文按目录顺序写入主目录 brief.md” | “在附加目录 brief.md 中写入主目录 input.txt 的原文（注意：写到附加目录，不是主目录）” |

错误同时改变了输出位置与应写入的内容；不能视为等义整理。A1 的远端任务创建回执描述也包含这份错误要求。pi 后续察觉并调用 `participant_send` 尝试更正，但操作返回 `approval_required/not_executed`，没有送达。原始任务 requirements 未因此修正。

该主回合的工具顺序为 `projects_list` → `task_create` → `task_get` → `participant_send` → `task_get`。创建任务只有一次。后续快照中 inbox 为 `uncertain`，错误 `model_failed/outcome=unknown`；checkpoint 中存在候选说明，不等于最终用户答复已送达，不能将群后台通知当成主回合成功回执。

| A1 资源 | 标识与事实 |
| --- | --- |
| 本地任务 | `task_f497c211343dd116ff18005456b28f88`，标题 `MYRIX-E38-A1` |
| 任务归属 | `MYRIX-E38-S1`、项目 `MYRIX-E38-WEB-A` |
| 飞书任务 | `c2167209-4ff9-4f97-8c56-2093a09d0120`，创建操作 `12:18:44.677Z` done |
| 飞书群 | `oc_b41e6392806ee14d866fd183a3343c4b`，创建操作 `12:18:45.582Z` done |
| Claude | `task_f497c211343dd116ff18005456b28f88:p1`，herdr `w23:p1` |
| 截止快照状态 | task blocked；participant started=true、blocked、initialSent=false；群未删除 |

四个原始 `input.txt` 的快照内容及 SHA256 与基线对应，尚无本任务生成的 `brief.md` 产物证据。目录信任阻塞造成没有实际执行，不会消除已发生的需求改写失败。

## Claude 原生目录信任仍阻塞

`.cache/live/e38-a1-directory-trust-screen.json` 保存真实 herdr 现场：Claude 显示 `Accessing workspace`、`No, exit` 与 `Yes, I trust this folder`，当前光标在拒绝项。屏幕路径为 `/private/var/.../a/main`，任务登记路径为 `/var/.../a/main`，且终端显示路径跨行。现场 `stateSeq=253`，不是普通代码执行权限菜单。

目录信任 checkpoint `82ac0cd86ffb8a0f0a78955bef21cde5` 显示 pi 已调用 `directory_trust_confirm`，工具返回 `directory_trust_scope/not_executed`，文字为“当前现场不属于等待首次投递的任务目录。”。这证明模型确实尝试了专用工具，不能笼统归因为模型未识别或未调用。路径表示和现场核验的修复尚在进行，未在本快照中真实通过。

审批 `approval_c4e6d00e819d4b6cab1595553d2a6457` 的 `publication=sent`、`consumed=false`，消息 `om_x100b65d3923074a4b299bff49c1a94a`，关联该群和 `w23:p1`。用户要求该类新目录信任应自动完成；把它留给群内用户处理不能算需求验收通过。Bypass 为 true 也没有消除该原生信任提示。本段不证明普通审批应被自动确认。

## S2 与 B1：已观察到独立创建，执行仍待验证

用户在 A1 仍 blocked 时通过真实私聊消息 `om_x100b65d3ab0c6ca8b2e238a521f029b`，要求创建并选中 `MYRIX-E38-S2`，保留 S1，不操作已有任务或审批。S2 为 `s_4bcaf0cd-25c1-4411-89bc-cb152c8c234e`，创建时间 `12:22:01.570Z`；该 inbox done。`.cache/live/e38-b-created.json` 确认 S1、S2 均未归档，当前 session selection 为 S2。

B1 消息 `om_x100b65d3a1d20cb4b1a84ef8085b1ab` 要求新建项目 `myrix-e38-project-b`、单 Codex 开发任务 `MYRIX-E38-B1`，创建 `index.html`，标题为 `MYRIX_E38_B_OK`、正文含 `Hello from project B`，并用 Python 标准库读取和断言结果后等用户验收。它与基线预置的 `MYRIX-E38-WEB-B` 临时目录不是同一个项目。

截至 `.cache/live/e38-b-created.json`（`12:24:56.974193Z`），已观察：

- pi 调用 `project_create` → `task_create` → `task_get`。新项目目录为 `/Users/yueban/herder-agent-code/myrix-e38-project-b`。
- 本地 B1 为 `task_d20b0d047e95d9a9fa58dfd2bec9f99d`，归属 S2，状态 starting。
- 远端任务 `ddc8d5e7-9404-439a-80d9-2d8826c54ac1` 创建操作于 `12:24:41.662Z` done；群 `oc_31a17aae72e9f9d9ad19a47514a25ae5` 创建操作于 `12:24:42.548Z` done。
- B1 唯一 Codex 参与者仍 pending、started=false、initialSent=false；创建 inbox processing。
- 同一快照中 A1 仍 blocked，保留原 Claude 与原目录。

因此本样本已经观察到“阻塞的 A1 未阻止 S2 中新项目登记、任务登记与远端建群”，但尚不能声称 B1 已启动、输入已送达、HTML 与检查已完成，或完整的多项目并行执行场景通过。切回 S1、恢复同一个 herdr session、用修改后配置创建后续 A 任务、完成验收与清理也不在此截止快照的已验证结果内。

## Web 错误反馈的本地修复与离线边界

本分支已完成局部前端修复，未包含在上述运行的 v0.3.13 内：

- `src/web/client/config-action.ts` 为配置调用捕获所属弹窗的反馈区域；无弹窗的模型配置错误继续显示在页面。
- `dom.ts` 为每次弹窗建立独立的 `role=alert` 区域，沿用 `notice error` 样式；服务返回文本只使用 `textContent`。`styles.css` 补充间距和长路径换行。
- 添加/编辑失败保留输入，重试和成功清除旧错误；删除配置及启用 Bypass 确认使用同一反馈机制。关闭后重开不保留旧错误，旧请求失败不污染新弹窗，旧请求成功也不关闭新弹窗。

实际离线执行 `node --import tsx --test tests/web/config-feedback.test.ts tests/web/server.test.ts`，共 **10/10** 通过：5 项客户端事件回归覆盖添加失败/重试、编辑保留与重开、迟到响应、删除/Bypass 确认和模型页面错误；另外 5 项为既有 Web 服务器边界测试。全仓 TypeScript、相关 Biome、1000 行检查和 `git diff --check` 通过。

客户端事件回归使用轻量 DOM port 执行真实前端回调，**不是浏览器渲染或无障碍树验收**。尚须构建带修复的二进制，明确新运行 stamp，再用真实 Chrome 重复非法附加目录、修改重试、保存成功和重新打开弹窗等行为。此离线结果不能把上面的 UI 原 R-F 改写为通过；需求忠实性和目录信任由其他修复单独处理，本初稿不预测其结果。

## 后续记录要求

本轮测试资源在截止快照中尚未完成或清理。后续需保留原失败证据，追加修复版本、真实输入、工具回执、文件及原生执行记录、用户验收、远端状态回读和 herdr/群清理结果；清理前不能报告测试群已关闭。整体验收矩阵与目标继续由主验收者更新，本记录不授予其他场景全量通过。

## 12:26–12:31 UTC：阻塞、窗口中断和 A1 清理

后续 `.cache/live/e38-before-a-cancel.json` 确认 B1 已启动为 herdr `w24:p1`，A1 的 `w23:p1` 同时仍 blocked；两个参与者均未确认初始投递。B1 创建主回合已结束，实际私聊回复包含新项目路径和远端任务链接。主入口随后收到只查询未结束任务的请求，具体回复与查询工具回执以该消息 checkpoint 为准，不能从任务数量推断用户看到了正确总览。

`.cache/live/e38-b1-screen.json` 显示 Codex 的原生目录信任提示。实际 cwd 为 `/Users/yueban/herder-agent-code/myrix-e38-project-b`，54 列屏幕仅显示 `/Users/yueban/herder-agent-code/myrix-e38`。现有严格菜单解析可以识别该已核验 cwd 的截断显示；pi 却将其理解为其他根目录，未调用专用确认工具。与 A1 的 `/var` 与 `/private/var` 身份比较失败分开记录。

飞书和 Chrome 原生窗口之后均返回 `cgWindowNotFound`，应用清单仍显示进程运行；浏览器连接器另报 `unsupported Codex auth method: apikey`。已请求恢复可见桌面，未将 API 或注入式调用冒充恢复后的真实 UI 操作。

为防止目录信任修复后执行 A1 的错误旧要求，按测试资源清理授权，使用当前生产应用的真实 REST 删除 A1 群。`.cache/live/e38-a1-external-group-delete.json` 记录 `12:30:22.772Z` 删除确认及独立回读 `dissolved`，远端任务 `completedAt="0"`。随后 `.cache/live/e38-after-a-external-delete.json` 中 A1 为 destroyed、groupDeleted=true，Claude gone，`p1:close` 操作 done；真实 herdr 列表只剩 B1 的 Codex。A1 输入文件保留且没有 brief.md。该证据验证外部群解散后的受管执行器清理，不是用户验收完成或飞书用户取消指令的证据。

A1 审批记录仍为 consumed=false，过期时间 `12:29:27.579Z` 早于删群，不能宣称本次清理主动将 nonce 标记为已消费，也不能据此证明旧卡片点击的真实回调已验。B1 仍保留待恢复；本轮所有资源已清理的说法尚不成立。

## 需求原文保真修复与真实原生组件复验

新任务从精确匹配当前来源、owner、chat、session、message 和 task 绑定的持久 inbox 保存 `userRequest`；该字段不能由模型工具参数指定。原生初始要求、续聊、父任务快照及远端描述区分用户原文与 pi 分派摘要，原文中的明确约束优先。自动讨论转发不挟带上一条用户消息；旧任务不回填或重新投递，旧完成与未知操作回执继续按原指纹核对。远端描述仍受 2999 字符限制，超限时明确提示内容不完整；本地与原生投递保留全文。

`.cache/live/e38-native-fidelity-r2.json` 记录 `12:36:05Z` 开始的隔离真实 Codex 组件测试：独立临时状态、两目录输入、合成 inbox、真实 herdr 与 Codex；没有 PlatformPort、飞书连接或生产状态写入。正确原文要求把两条输入按顺序写到主目录，同时故意给出与 A1 同类的错误 pi 摘要。原生 user 记录同时包含两者，Codex 实际仅新增主目录 `brief.md`，内容精确为 `E38_NATIVE_MAIN_20260919\nE38_NATIVE_EXTRA_20260919\n`；附加目录未新增 brief.md，两输入未变。原生执行记录核对了输入、写入及字节结果，最终列出原文并询问红色/蓝色，任务停留 review，没有自动验收。

该组件的原生 session 为 `01a0b9aa-fc86-7c90-a0f7-fc2cf3d664e2`，专用 herdr `w26:p1` 已关闭且回读 `agent_not_found`。目录确认先有一次 stale_guard 明确未执行，再在新现场版本上成功；没有代选普通审批。首轮 `.cache/live/e38-native-fidelity.json` 中模型声称确认却零工具调用、没有投递或产物的失败记录保留，其专用 `w25:p1` 同样已清理。

这一结果仅证明该真实 Codex 样本在收到保留原文后遵守约束，不证明所有模型、所有冲突都已解决，也不替代从真实飞书入站的新任务复验。后续目录信任工具调用约束的变更需单独记录版本与检查，不能套用本组件先前运行的结果。

## 本轮修复检查

目录信任改为按 realpath 核验任务目录身份，向 pi 提供严格原生菜单、截断标题与完整目录事实。只有原生菜单和授权目录同时成立时，首个模型请求才要求调用受限工具；后续请求恢复普通工具选择。实际工具仍复核任务、执行器、目录、现场版本和菜单，普通审批规则不变。识别版本更新允许旧未执行决策重新评估，所有版本的 pending/done/unknown 操作仍冻结，避免重发按键。单参与者通知也不再按多人轮转生成提示。

首次完整检查 639 项中 638 项通过：无原文的 parentContext 在创建时携带 undefined 键，JSON 回读后丢失，违反快照严格相等断言。修正为可选原文字段仅在有值时装配，保留原断言并补回读一致性验证。最终 `npm run check` 的行数、TypeScript、Biome 和 **639/639** 测试全部通过，日志 `.cache/e38-check-r2.log`；独立目录信任审核及相关 31 项测试通过。`git diff --check` 通过。该结果仍不是生产部署或完整业务验收。

## 12:48–12:52 UTC：修复部署、B1 恢复与测试清理

功能提交 `261771d6eea4810a58acb8f44e45d606bf0756fc` 构建为 macOS arm64 `0.3.14-dev`，构建时间 `2026-09-19T12:47:29.100Z`。独立 SEA 烟测通过，覆盖临时目录中的单二进制运行、锁、SQLite、嵌入页面、配置/历史边界与隔离双协议 pi 循环。运行路径 `build/e38/herdr-agent`，`dist/herdr-agent` 同步同一产物；PID `42319`，SHA256 `1b6f1ebdef91bd7f0819a7f94e7a329a4055ee641ac9db3d79399c64beed307f`。部署前确认无 queued/processing inbox、A1 已 destroyed，再停止旧 bridge；herdr PID `39037` 保留。版本记录 `.cache/live/e38-r2-deployment.json`，日志 `~/.herdr-agent/e38-r2-runtime.log`，后续文档提交不冒充重新构建。

B1 在同一 `w24:p1`、同一旧任务上恢复。生产日志与操作回执确认：`12:48:24.141Z` pi 调用 `directory_trust_confirm`，`12:48:28.314Z` 返回成功，随后首次要求投递 verified。没有手动按键放行。`.cache/live/e38-b1-recovery-native.json` 及保存的原生 transcript 记录 Codex 的真实目录/Git 检查、写入 index.html 和 Python 标准库 HTMLParser 断言；原生检查 exit 0/PASS，Git 仅 `?? index.html`。独立 Python 回读同样确认 151 字节 HTML 的标题为 `MYRIX_E38_B_OK`，正文含 `Hello from project B`。任务随后 review，Codex done，closeRequested=false；没有自动代验收。这是旧任务恢复，不是新 `userRequest` 快照的飞书全链路证明。

`.cache/live/e38-remote-result.json` 用生产应用独立 REST 读回署名输出 `om_x100b65dc03d054a4b1a8fa06cdc86a5` 和 review 通知 `om_x100b65dc036f4ca0b39c132225ece39`，远端任务未完成、群正常。也读回主私聊任务查询答复 `om_x100b65d3bb79c0a8b1f85288d62f3ef`，内容为查询时的两项 blocked 任务及正确链接；默认列表查询限定通过，原 blocked 内部术语措辞问题保留。没有把 REST 消息存在性称为本次 CUA 可见性复验。

飞书及 Chrome 原生窗口复查仍为 `cgWindowNotFound`，无法继续新 A2、群内确认和浏览器错误呈现。按测试清理授权，生产应用 REST 于 `12:51:12.774Z` 删除 B1 群并独立回读 dissolved；服务观察后自动通过 herdr 关闭 `w24:p1`。`.cache/live/e38-after-b1-cleanup.json` 中 A1/B1 均 destroyed、groupDeleted=true、参与者 gone；这次清理没有完成远端任务，不能替代用户确认完成场景。

`.cache/live/e38-config-cleanup.json` 记录受保护本机配置 API 的收尾：恢复 defaultProject=herdr-agent，移除两项 E38 测试登记，保留原 12 项项目及 Bypass=true，目录、输入和 HTML 产物不删除。herdr 受管 agent 列表为空；隔离组件 w25/w26 也已有各自关闭回读。pi 测试会话与历史保留，未通过后门更改 session selection。runtime/authorization ready 仅为运行状态回读。原 R-F、新建 A2 原文传递、Claude 别名自动确认的生产复验、Web 弹窗视觉/交互、切回/归档/恢复 pi 会话、三个项目并发组合和迟到审批卡仍继续跟踪。
