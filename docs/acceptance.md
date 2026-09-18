# Node + pi 验收与场景映射

日期：2026-09-18。本文对照 [需求盘点](node-pi-refactor-requirements.md) 的 B01–B18 / N01–N07；默认产品选择见 [设计](node-pi-design.md)，目标状态见 [refactor-goal.md](refactor-goal.md)。业务表格中的“已测”指离线自动化，不表示在真实飞书、herdr 或模型服务上完成端到端验收；下文另明确标注只读 Web 的真实 Chrome/HTTP 检查和版本边界。

2026-09-18 E20追加：0ccfff2已部署，format/check 378项及SEA smoke通过，飞书连接/授权ready；真实父讨论→关联Codex开发→父完成而子资源保留已有证据。390×728窄屏历史浏览及刷新后Console限定检查已完成，原首次短输出超长失败保留、群内修订60字符通过。详见[本轮独立记录](live-evidence-e20-release.md)，后续b53终态描述修复已通过386项检查、SEA及真实子完成/原生手动完成回读；16专用任务群及20个执行器均已确认清理。正式发布结果另记。

2026-09-18 E22追加：提交 `57736d9` 修复后续 tick 无法接纳新 inbox lane 的竞态，`npm run check` 通过 422 项测试，SEA build/smoke 通过。当前 macOS arm64 二进制重启后，真实飞书创建讨论任务 `LIVE-RACE-20260918-R2`，Codex 回复 `LIVE_RACE_R2_OK`；用户手动确认完成后，Codex/herdr 关闭、任务销毁和群解散均已回读。该条只覆盖一条真实讨论与默认收尾链路，不能替代其余场景验收。

## 当前范围纠正

2026-09-18 范围修正：真实业务全部从飞书私聊或任务群发起。Web 可查看、筛选会话记录，并维护本机项目（多目录，首目录保存时自动 Git 初始化）、默认项目、Bypass、模型连接和本机身份；不发消息、不建任务、不管理参与者、不审批、不清理、不操作 pi session。配置写入由 CSRF/Origin/Host 和 action 白名单保护，旧 Web/API 业务证据不能算作飞书业务入口通过。

业务通过必须同时对应真实飞书用户入站或群内交互、模型/工具和操作回执、herdr/远端资源事实及实际回读。Web/API 的业务创建、发送、切换、审批或清理只能作为历史实现与底层结果证据，不补足飞书入口。W01–W29 的业务扩展撤销，新的 Web 配置与历史验收见矩阵 WR01–WR09。配置 action 白名单和历史浏览边界按 WR01–WR09 分项记录，不代表业务全链路或全部页面分支验收通过。

E19 撤销范围前的历史样本（原失败保留，以下“仍未通过真实模型复验”指当时快照）：E19 仅通过 Web 创建了单 Claude 父讨论，未继续 Web 子开发。旧本地 API 维护清理后的独立回读已确认该任务 destroyed、远端完成、群解散、准确窗口不存在、群 outbox 无待发送，专用 Web session 已归档并恢复旧选择（`.cache/live/e19-cleanup-readback.json`，11 项通过）。该新增资源单独记账，不能计作真实飞书入口通过，也不能套用 E17 快照。“等待验收”被模型误转为 keepGroup:true 的 R-F 仍未通过真实模型复验。

当前只读证据：`.cache/live/e19-web-readonly.json` 固定 `acb6300`，真实 HTTP 与 Chrome A/B、历史、署名、工具详情检查前后，11 个受检 namespace 全部一致。`.cache/live/e20-web-readonly.json` 固定 `a7e9ffb`，HTTP 阶段 11 项一致；浏览器阶段 tasks/participants 的 hash 变化，其余 9 项一致；未采逐行差异，不能确定变化原因，原始 `browserReadOnly:false` 保留，不能据此声称全库无写。a7 真实 Chrome 身份菜单跨约两分钟轮询保持打开，B 身份归档筛选后可读 `/clear` 前 `s_be0b138d…` 会话 12 条历史；桌面中文长记录无明显布局问题。当时未测390px/console；后续0ccfff2的390×728及刷新后Console限定检查见E20，未覆盖竞态/断线仍未测。

`0ccfff2` 已完成 format/check（378 项测试）及 SEA smoke并实际部署。它包含只读页面、旧送达回执恢复、讨论格式优先级与 npm 分发相关修正；离线通过不替代各项真实业务复验。npm 包、三平台安装校验及部分发布恢复流程见 [releasing.md](releasing.md)，这里不声称已经发布。

## 历史整改与现场证据

E18 已部署版本记录（不含本次只读 Web 整改）：运行源码 `0b6966ff6509d3e7cdc0a26e5ba660d7b4e14392`，PID38264，构建时间 `2026-09-18T03:49:25.716Z`，SEA SHA256 `feb114e3c0fd08752533b48c85d07ff7072081e3af9b7b3824f7ccac95680069`。format/check（345项测试）、SEA smoke及[同提交三平台CI 35304636486](https://github.com/hewenyu/herdr-agent/actions/runs/35304636486)通过；03:51回读飞书连接/授权ready，herdr PID39037保持。收尾阶段提示修正已部署，真实模型受控回执单样本通过，尚不称生产收尾回复重验；旧R-F保留。主入口无模型机械 `/clear` 语义不变。E17新增3任务及此前9任务均已确认资源清理，整体目标active。后续文档提交不冒充重新构建。

E17 部署与验收记录：`.cache/live/e17-deployment.json` 固定运行源码 `a6018ec1f51affce2b4160a0aea1a6e4483bcb1c`、PID `32000`、构建时间 `2026-09-18T03:24:39.516Z`、SEA SHA256 `87cfcebabb4957380713b7aa57440d3d79357727f1d8d33b0b06dfd2de168505`。format、check（345项测试）、SEA smoke 及[三平台 CI 35303089613](https://github.com/hewenyu/herdr-agent/actions/runs/35303089613)全部通过；飞书连接及授权 ready，herdr 原进程保留。

本次修复区分参与者显示名与合法原生名称，将 agent.start 的明确名称拒绝归为 not_executed；只有明确重名拒绝才换用稳定名称重试。迁移参与者独立 ID 的操作归属统一纳入 retry事务、pending恢复、错误保留；短可见文本的宽度改为 unknown。E17 的5d1e96f二进制 CLI 28项只读及迁移8项证据保留原版本：迁移4项为真实旧数据的 R-local-copy、4项为合成故障 O，不是生产迁移／完整回退。旧样本仅3个destroyed任务，无pending。

E17后续独立证据已确认B/C从真实飞书请求到原生执行、产物、署名群结果、远端描述与review等待验收的限定链路通过，见 `cli-e17-r2-completion.json`、`independent-e17-completion.json`。C入站和创建时A仍attention，B原生回合尚未结束；A的原生名称拒绝及误unknown历史R-F保留。03:03模型已恢复200/精确标记，不继续沿用旧额度阻塞。任务群owner无@ exact `/clear`拒绝也为限定R-P。

随后A/B/C均完成已授权资源清理，`e17-cleanup-readback.json`最终快照全true；B通过真实任务群无@完成指令调用task_action，回复送达和herdr close均早于删群。原9加本轮3共12群dissolved、panes缺失、pending outbox为0；inventory-e17两次remote GET400在03:45串行回读均200/completed，原失败保留且原因不确定，见 `test-resource-inventory-e17-read-errors.json`。

新增措辞R-F仍未关闭：B回复首句“已完成收尾”早于群解散，尽管正文说明尚未解散；实际最终清理成功不能覆盖该阶段事实错误。提示修正已在E18部署并通过345项check、真实受控回执probe单样本；尚未重验生产收尾答复，详见E18。a6018ec部署和345项测试/CI证据保留；整体目标active，详见[现场矩阵](live-validation.md)及[版本化证据 E17](live-evidence-2026-09-18.md)。

E16 历史进展：运行二进制已更新为源码提交 `5d1e96f1698af95ad0fa2317b34b73441518e968`，PID `26077`，构建时间 `2026-09-18T02:52:38.355Z`，SEA SHA256 `c165c6424037337cda912bc4471731fb7d0dfdc250c9e083148e8922b2c39ec5`。format、check（329项测试）、SEA smoke 和[同提交三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/35301019616)全部通过；重启后飞书连接及授权 ready，herdr 原进程未重启。两专用群真实复现并验证删群回执丢失后的跨进程恢复，各仅一次 DELETE，最终均 dissolved；恢复只凭匹配群的 fresh GET 事实，保留原错误审计及其他未决问题。Web 身份隔离、17项 API 作用域检查、会话创建/重命名/归档/恢复和显式清空已补验，三个测试会话已归档并恢复原选择。memory 15项 loopback 协议检查仅为 O-P，外部服务仍未测。重启后原9个测试任务清理状态再次回读通过；原失败和未覆盖分支保留，整体目标 active。详细边界见[现场矩阵](live-validation.md)和[版本化证据 E16](live-evidence-2026-09-18.md)。

E15 历史部署与验收记录：`ab79cc0470f28c65473fc3810e6b8e39dc0a296f` 已按原部署运行，PID `20390`，构建时间 `2026-09-18T02:25:03.576Z`，SEA SHA256 `04d14c861c91c980038c9e659de68a86b531216c39f6c2b971444700adf20358`。`npm run format`、`npm run check`（315 项测试）及 SEA smoke 通过；[CI 35299218668](https://github.com/hewenyu/herdr-agent/actions/runs/35299218668) 已在同一源码提交的 linux_amd64、linux_arm64、darwin_arm64 三任务通过 check 与 SEA。E15 已独立回读真实私聊/Web机械轮转及本轮 9 个测试任务的资源清理；未测的整体功能项仍保留，目标 active。新增 `clear-command`、`session-tools` 和 `cleanup-notification` 回归已随 315 项测试通过，覆盖机械轮转、AI关闭旧队列拒绝、Web无sessionId同requestId并发去重，以及通知生成失败审计后继续已授权清理、未知发送与最后结果投递屏障。E15 另有真实私聊/Web机械命令和本轮 9 个测试任务资源清理的独立通过证据；通知 unavailable 没有发送/送达记录，不把清理成功写成通知成功。

## 初版离线证据（历史记录）

本节保留初版 170 项测试及构建记录，其中“最终源码”“本轮”均指当时快照，不表示当前工作区或最新部署已按同一结果验收。后续版本及真实链路证据见 [现场矩阵](live-validation.md) 和 [版本化记录](live-evidence-2026-09-18.md)。最新 exact `/clear` 已改为不调用模型的确定性命令；旧模型驱动的通过和失败均保留，新行为需独立验收。

- 最终源码已执行 `npm ci`（152 个包）、`npm run format`（152 个文件，无修改）和 `npm run check`：157 个源码文件均不超过 1000 行，严格 TypeScript 与 Biome 通过，170 项测试通过，0 失败、取消、跳过或待办。测试包含真实 pi 循环配合本地模型协议替身、真实 SQLite/flock/Git、飞书 SDK 事件分派、临时 Unix socket/HTTP 和文件样例。
- `npm audit`：0 项漏洞；`git diff --check` 通过。
- 最终源码已实际完成 macOS arm64 `npm run binary`、`npm run smoke`：复制单个可执行文件到新临时目录，在没有源码/node_modules 的位置验证 help、version、原生锁拒绝重复实例、SQLite、嵌入页面/JS/CSS、状态 API、CSRF 和退出；另用 loopback OpenAI Responses / Anthropic SSE fixture 验证二进制内真实 pi、调度工具 schema、Web 答复和 ACK 后 delivered。本地产物为 `dev` 构建标记，未发布远端 release。
- 已用 Playwright headless Chromium 对隔离 fake backend 做真实浏览器 QA：四页、创建 session、发送聊天及 ACK 后数据库 delivered；390px 移动宽度没有横向溢出，零 pageerror。已人工查看 `.cache/web-{sessions,tasks,projects,settings,mobile}.png`；这些是本轮本地证据，不是生产飞书验收。
- 许可证生成已针对实际 bundle 产出 62 个去重 npm 包及 Node 24.13.0 的原文声明；`tests/build/licenses.test.ts` 通过，覆盖嵌套包根/NOTICE/README 原文、固定版本 hash 与缺许可阻止构建。release 工作流已将 `LICENSES/`、文档、部署模板与许可来源说明一并纳入压缩包；尚未发布远端 release。
- Linux x64/arm64 原生 runner 构建与烟测已配置在 CI/release 工作流中，尚未执行验证；本文不把当前机器结果称为 Linux 通过。macOS ad-hoc 签名不是开发者公证。
- 未连接真实生产飞书、herdr 或模型，未读取/迁移真实 `~/.herdr-agent`，未启动第二条生产 WebSocket。真实安装/授权/审批及长期运行仍需独立环境验收。

## B：既有业务

本表保留代码与历史自动化依据；其中 Web/API 业务写路径已撤销，不继续作为当前验收任务，相关业务改从飞书验证。Web 配置写入和历史浏览按新的页面边界验收。

| 场景 | 新实现与行为 | 自动化依据 / 实际覆盖 | 未覆盖的现场部分 |
| --- | --- | --- | --- |
| B01 安装授权 | `cli/setup.ts`、`onboarding/`；选对应用，保存凭据，消息和精确 nonce 卡片往返 | `tests/cli/run.test.ts` 复用/冲突/部分成功退出码；`tests/onboarding/` 权限、取消、超时、同应用与卡片身份 | 飞书租户真实注册、发布、收到私聊并点击 |
| B02 启动补授权 | `cli/service.ts`；锁→迁移→Web→授权与 herdr 核验→唯一飞书连接 | `tests/cli/run.test.ts` 授权前 Web、网络错误不注册、同应用补授权、启动失败清理；`tests/storage/lock.test.ts` 排它与 inode | 真实 herdr 不兼容/断线、长连接恢复和权限传播 |
| B03 本机诊断 | `cli/diagnostics.ts`、`host-checks.ts`；配置/协议/可执行文件/权限、hooks、继承环境、检测配置、可见内容宽度 | `tests/cli/run.test.ts` 只读且不建立平台连接；`tests/cli/host-checks.test.ts` hook/环境脱敏/manifest、不可读/短内容UNKNOWN、宽内容估算、doctor文本/JSON退出码 | hook 文件存在不证明执行器已信任；内容宽度是估算，不是终端物理尺寸保证 |
| B04 已有项目 | `projects/catalog.ts`、Web 项目配置页与飞书 pi 项目工具；多目录有序、默认项目、保存时主目录自动 Git 初始化、独立任务快照 | `tests/projects/catalog.test.ts` 验证全部目录再初始化 Git；`tests/config/load.test.ts` JSON 覆盖与 bypass 继承 | 本机权限、具体执行器附加目录行为 |
| B05 新建项目 | 明确 `newProject`/项目创建动作；固定 home 子目录；删除仅移除登记 | `tests/projects/catalog.test.ts` 路径穿越/目录占用拒绝、Git、删除后原文件保留 | 无自动清理用户工作目录 |
| B06 建立任务 | `tasks/create.ts`、`provision.ts`；完整要求/参与者/群/远端任务/资源绑定 | `tests/app/workflows.test.ts` pi 工具到任务编排；`tests/tasks/lifecycle.test.ts` 未知创建不重复、平台不可用仍保留建群/远端 task 意图、显式本地任务可运行；`tests/feishu/platform.test.ts` bot-owned 私群与幂等 key；`tests/cli/integration.test.ts` 现由离线飞书适配器驱动真实 pi 循环和 fake herdr，Web 仅读取历史；原 pi/Web 建任务属于历史证据 | 真实平台资源创建及 herdr UI |
| B07 首次启动 | `herdr/lifecycle.ts`、`tasks/baseline.ts`；显示名映射合法原生名、明确名称拒绝not_executed；确认argv/身份，先基线再投递唯一初始回执 | `tests/herdr/lifecycle.test.ts` blocked 启动、明确 busy 重试、未知不重放、多目录 argv；`tests/tasks/lifecycle.test.ts` 不采前一轮回复 | 真实 CLI 版本提示、目录信任菜单 |
| B08 群内续聊 | `app/messages.ts`、`runtime/sessions.ts`、`tasks/records.ts`；owner/任务固定，普通 AI 对话由模型路由，群内 exact /clear 确定性拒绝 | `tests/app/conversations.test.ts` 普通斜杠/unsupported、故障不落模板/终端；新增 `tests/app/clear-command.test.ts` 对应群拒绝与引用不触发；任务/session 测试对应 owner/group/actor 隔离；E15 离线回归通过，真实状态见现场矩阵 | E17任务群owner无@ exact /clear拒绝限定R-P；普通续聊、引用与其他身份仍待验 |
| B09 多任务总览 | `tasks/records.ts`、飞书 pi 查询工具；默认隐藏结束任务，all 显式读历史；Web 仅浏览会话，不提供任务总览操作 | `tests/app/workflows.test.ts` 多对象事实；`tests/tasks/lifecycle.test.ts` 作用域；`tests/runtime/sessions.test.ts` 多 session 隔离 | 大量长期任务的性能上限未做压力测试 |
| B10 进度产出 | `tasks/observe.ts`、`transcripts/`、`app/outbox.ts`；参与者署名、完整结果回执、review≠完成 | `tests/transcripts/reader.test.ts` Claude/Codex、UTF-8/截断/替换；`tests/tasks/discussion.test.ts` 结果投递恢复；`tests/tasks/lifecycle.test.ts` 完成/暂停后迟到结果只观察；`tests/tasks/description.test.ts` 描述按内容去重与精确回读确认；`tests/tasks/completion-description.test.ts` 完成描述覆盖旧投影、未知描述不重放；`tests/app/presentation.test.ts` 进度冷却合并最新状态；`tests/app/workflows.test.ts` 的旧内部兼容门面 ACK 回归不表示 HTTP 暴露该入口；当前拒写及只读投影由 `tests/web/server.test.ts`、`tests/app/identity.test.ts` 覆盖 | 真实 transcript 新版本；供应商输出语义 |
| B11 审批与中断 | `app/approvals.ts`、`herdr/control.ts`；完整 Guard、nonce、状态序号，正文不代批 | `tests/app/approvals.test.ts` 回调竞态/重复/外来身份；`tests/herdr/control.test.ts` 过期/目标变化/假 idle/queued 回显；`tests/app/presentation.test.ts` 显示裁剪不改变 Guard/选项、审批不受进度冷却影响；`tests/transcripts/legacy-fixtures.test.ts` 原始宽窄屏幕样例 | 真实各类 TUI 菜单与终端宽度 |
| B12 完成与群策略 | `tasks/lifecycle.ts` complete；确认完成后默认经herdr关闭pane，群按keepGroup快照处理；新默认delete，群解散必清执行器；明确keepExecution例外须同时保留群，review不收尾 | 原历史 complete 保留测试不等于新策略验收；新增默认/覆盖/解散通知与恢复证据见 [本轮矩阵](live-validation.md)。`tests/tasks/completion-description.test.ts` 覆盖未知描述回执 | E15–E17默认收尾已有限定R-P；平台一致性延迟及未覆盖异常组合继续分验 |
| B13 验收关闭 | close 先确认完成，再通知/结果事实与受管资源清理；外部勾选完成也收尾 | `tests/tasks/lifecycle.test.ts` 远端完成确认前不清理、外部完成、保留群策略、关闭前保存未轮询最终结果（含 agent 已退出的原生记录）；`tests/app/presentation.test.ts` 最终结果/关闭通知不受进度冷却影响；`tests/app/workflows.test.ts` 通知只读权限 | 通知模型选择与飞书群可见效果 |
| B14 销毁重开 | destroy 不自动验收；destroyed 不可重开，代码保留 | `tests/tasks/lifecycle.test.ts` 销毁临时拒绝恢复、结束任务边界；`tests/projects/catalog.test.ts` 文件保留 | 关闭后资源实际状态人工核对 |
| B15 失败恢复 | `storage/operations.ts`、`app/inbox.ts`、`outbox.ts`、任务恢复；未知写操作冻结，旧participant独立ID归属及retry事务 | `tests/storage/store.test.ts` ledger/回滚；`tests/app/conversations.test.ts` 输入去重/部分投递；任务测试覆盖重启和未知响应；`tests/tasks/migrated-operations.test.ts`、group-recovery对应旧participant回执与未决错误保留 | 进程硬断电、磁盘满、长期网络抖动未做混沌测试 |
| B16 会话记忆 | pi 多 session、私聊自动压缩；飞书主入口 exact /clear 不调模型，事务归档旧 session 并新建选中，成功后仅 CLEAR_NEW_SESSION_OK；AI 关闭也可用；Web 无命令或清空入口 | 新增 `tests/app/clear-command.test.ts` 对应 AI 开/关及模型不可用、去重、旧队列拒绝、引用与非精确正文、群拒绝、事务回滚、未知投递恢复；E15 离线回归通过；`session-tools.test.ts` 另覆盖 Web 省略 sessionId 的同 requestId 并发去重。既有 `tests/runtime/entry-reset.test.ts` 对应模型工具延迟切换；`sessions.test.ts`、`memory.test.ts`、`migration/conversations.test.ts` 对应持久化、压缩及迁移 | E15 已独立验证真实私聊直接命令/精确送达和 Web 显示后 ACK/归档历史；故障组合仅离线通过，外部 memory 服务 SLA 仍须核验 |
| B17 已有 agent 桥 | `app/legacy.ts` 只在 tasks 关闭时启用；选择/回复绑定/镜像/解除选择 | `tests/app/legacy.test.ts` 回复优先于选中、迁移绑定核验、解除后不复活、notify_chat 基线；herdr control 与 migration 测试覆盖底层 | 旧卡片完整恢复不应推定；必须重新核对目标 |
| B18 长期部署升级 | `cli/service.ts`、flock/SQLite、SEA、deploy 与 CI；停止服务不杀全部 agent | 锁/存储/迁移测试；`tests/tasks/lifecycle.test.ts` 停机等待已提交结果、不启动后续 agent/任务、不关闭 herdr；`scripts/smoke.ts` 空目录独立运行 | E17迁移8项为4 R-local-copy/4 O，同提交三平台CI已通过；完整生产回退、Linux真实宿主、服务管理器重启和长期保留增长仍未全验 |

## N：新增业务

本节操作均要求飞书入口；旧 Web/fake backend 证据只说明当时底层实现，不构成当前飞书链路通过。

| 场景 | 实现与默认行为 | 证据与边界 |
| --- | --- | --- |
| N01 工具总览 | 飞书中 pi `tasks_list/task_get` 查询事实；Web 配置与会话记录 | `tests/app/workflows.test.ts`、`tests/runtime/engine.test.ts`；不能仅凭历史摘要报告实时完成 |
| N02 单人需求讨论 | discussion 任务，Claude/Codex 按专用提示处理业务；可无项目 | `tasks/create.ts`、`prompts.ts` 与任务流程测试；无项目使用独立目录，提示约束不等于文件系统沙箱 |
| N03 双参与者群讨论 | 一个机器人署名，多实例 ID，有界轮转 | `tests/tasks/discussion.test.ts` 逐轮、预算、不可用暂停、未知 relay 不重放；`tests/app/workflows.test.ts` 同名拒绝歧义；`tests/cli/integration.test.ts` 现由离线飞书适配器驱动真实 pi、fake herdr 双参与者轮转，Web 配置与记录结果；原 pi/Web 与 ACK 检查保留为历史证据。未据此完成真实双 CLI 群聊验收 |
| N04 讨论后开发/评审 | 新关联任务 `parentTaskId`，要求快照，执行任务参与者串行；显式 worktree | `tests/tasks/lifecycle.test.ts` 验证冻结 parentContext 背景且本次用户要求优先，`tests/projects/catalog.test.ts` 验证 worktree；完整“业务结论→用户确认→实现→评审”需真实模型行为验收，不由字段存在推定 |
| N05 切回 pi session | 独立选择与上下文恢复；编码资源不随选择变化 | `tests/runtime/sessions.test.ts` 重启/身份隔离，`tests/app/conversations.test.ts` durable inbox 固定接收时 session；归档任务会话不被选作活跃会话 |
| N06 暂停继续 | pause 停未来调度；interrupt 单人/全部；归档只影响 pi；resume 重置已明确的轮转预算 | `tests/tasks/discussion.test.ts` 时间/轮数停止和恢复回执；迟到输出可记录，不成为新授权；暂停不等于终止运行中的编码工作 |
| N07 分别结束讨论与执行 | 独立任务状态、群保留、关联历史，参与者给业务结论 | lifecycle 测试证明资源策略；没有自动跨任务级联完成，也没有 pi 代判业务结论。需要现场核对交接内容完整性 |

## AI 核心边界专门验收

`tests/app/conversations.test.ts` 的既有证据验证普通斜杠文本和不支持的内容进入模型上下文，模型失败不触发传统命令或终端原文投递。最新明确例外是实际正文 `text.trim() === '/clear'`：飞书主入口私聊直接轮转，群内不轮转且进入处理流程时明确拒绝；Web 无命令入口，AI 关闭或模型不可用时也不调用模型。引用、`/CLEAR`、`／clear`、`/clear now` 和正文中提到命令不能触发轮转。`tests/app/clear-command.test.ts` 对应这些边界并已在 E15 离线回归通过，不能将离线或旧模型工具证据写成新命令已通过现场验收。

`tests/runtime/engine.test.ts` 使用真实 pi 循环验证参数、可信 actor、工具前检查点、未知写操作后只读限制和工具次数上限。通知只读工具由 runtime 测试验证，不能把 agent 输出转成用户权限。

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

`check` 包含单文件 1000 行限制、严格 TypeScript、Biome lint/格式和全部测试。修改后需重新验证受影响证据。此前 `npm run binary` 与 `npm run smoke` 的通过属于对应历史提交；当前 `0ccfff2` 已通过 format/check 378 项及 SEA smoke，但尚未部署；acb/a7 的现场检查不冒充该提交部署后复验，不能用旧烟测替代后续改动的检查。

依赖审计曾定位到开发依赖 `tsx@4.21.0 → esbuild@0.27.7` 的 low 公告 [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr)（Windows 开发服务器文件访问）。集成已将 tsx 升级为 4.23.13 并更新锁文件，最终已执行 `npm audit`，报告 0 项漏洞。

原 Go 源码已从当前实现移除；七份屏幕/transcript 原始样例保留在 `tests/fixtures/legacy/`，用于协议兼容回归。历史代码路径以需求盘点中的固定 commit 链接为准。
