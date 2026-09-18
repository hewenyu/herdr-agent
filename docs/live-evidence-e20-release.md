# E20：飞书关联任务、只读历史与 v0.3.x 发布

2026-09-18。本文追加当前证据，不覆盖 E01–E19 原始成功、失败或未测项。整体逐项验收目标仍 active。业务入口为真实飞书客户端；Web 仅浏览历史。

## 已部署与离线检查

- `acb6300`：只读 Web 与旧投递回执恢复，355 项 check 通过；三平台 CI [35307218800](https://github.com/hewenyu/herdr-agent/actions/runs/35307218800) 全通过。
- `a7e9ffb`：修复后台轮询替换筛选菜单，SEA smoke 通过；现场 PID53096，SHA256 `32155ceb41485e1672199ca0a30a7b16d9bdb0f9e55186a269acbd2625496dc1`，构建时间 `2026-09-18T04:38:53.817Z`。E20 父子任务按此源码创建。
- `0ccfff2`：加入 myrix npm 分发、讨论短格式优先及旧模板精确投递恢复。format、check **378/378** 与独立 SEA smoke 通过。现场 PID61170，SHA256 `7c83223b0c62bcf215295aea7f010bacea957bf8a540984133cd20478bf269eb`，构建时间 `2026-09-18T04:55:16.729Z`；重启后另行 GET 确认飞书连接/授权 ready。未重启 herdr。

部署依据 `.cache/live-running.json` 及各轮 build/restart 日志；后续源码或文档 HEAD 不自动替换运行产物。现场版本 `0.3.0-live-validation`，不冒充正式已发布版本。

## 主私聊机械 /clear

04:39:22 UTC 在飞书主私聊发送 exact `/clear`，客户端可见机器人仅回复 `CLEAR_NEW_SESSION_OK`。旧 session `s_be0b138d-333f-4956-92af-d335f4cb0fe2` 已归档，新 session `s_2d0d2bc7-9ecf-457a-afb7-79cbae585505` 已创建并选中。

`.cache/live/e20-before-clear.json` 与 `e20-after-clear-2026-09-18T04-40-18.487Z.json`：11/11 检查通过，包括实际远端精确正文、source=command、旧10条消息 hash 保留、旧5个 checkpoint 无新增、命令未调用模型、事务与命令回执一致。后续真实创建请求进入新会话。

## 讨论到开发的真实飞书链路

父讨论 `task_330c40bf8dc0690860615589e9f76959`，群 `oc_efa3a85fd37b5ae95cea7494db8a60f6`，Claude pane `w1J:p1`。真实私聊只指定“讨论后等待验收，不自动完成或关闭”，task_create 未传 keepGroup，落库 false/default，未再误推断验收后保留群。该分支为 E19 R-F 后的限定复验通过。

`.cache/live/e20-parent-ready-2026-09-18T04-45-21.740Z.json`：原生会话与 receipt/cwd 唯一匹配，初始要求逐字一致、一次输入、无工具调用，原生最终回复与本地及署名群结果对应。**要求120字以内，实际214字符，保留失败。** 通用讨论模板随后修正为尊重用户篇幅与格式；新旧模板恢复均保留全文、唯一回执和操作指纹验证，不截断原文伪装合规。

子开发 `task_8ca1cb14b699a5feb5ddd59a41c458e0`，群 `oc_83e380cfe329bbd0a6ab23762dd0413a`，Codex pane `w1K:p1`。真实飞书明确授权新项目 `validation-linked-e20-0918`，parentTaskId 指向父讨论，本次要求把姓名改成称呼，20/100字上限、均必填、离线单 HTML、不上传或存储、不运行测试。

`.cache/live/e20-child-linked-2026-09-18T04-52-17.220Z.json`：13/13 通过，讨论快照在创建时冻结并进入唯一原生初始输入，本次要求优先，两个任务资源独立。目录信任第一次 stale_guard/not_executed 保留，重新观察后167号操作自动确认；没有人工确认代替自动化。

`e20-child-artifact-review.json`：13项静态/原生观察通过。产物 index.html 为4849 bytes，SHA256 `ca6a1022d1377859c8284879dd629efd11b619fe8aa5c7b09afbfd36ddd8bc21`；字段、限制、页面内空值提示、textContent展示及无网络/存储/SW/导出源码符合本次要求。原生最终结果、本地结果、署名群消息及远端任务描述一致。按请求未运行作品测试或浏览器渲染，静态阅读不能扩大为页面运行质量通过。

04:56左右在父任务群无@发送完成指令，同时明确不操作子任务。`e20-after-parent-close-2026-09-18T04-58-00.776Z.json`：24/24生命周期与独立性检查通过，父 destroyed、remote completed、群 dissolved、herdr pane不存在；子仍review，群/执行器保留，parentContext、产物及输出hash不变。`e20-parent-completion-analysis.json` 另5项通过：只对父调用complete，回复送达先于herdr close和删群，通知使用“收尾已发起/将解散”，未提前宣称已关闭。群解散后消息GET返回400，所以仅本地回执与客户端可见证据，不冒充删除后远端逐字回读。

此时父飞书任务描述仍为完成前review投影，虽然completedAt正确；记录为新增显示缺陷，后续修复和复验另记。

## 只读 Web

acb 的 `.cache/live/e19-web-readonly.json` 保存 HTTP 与真实 Chrome 浏览前后11个 namespace 全一致。11类历史写 action 全返回405/read_only；非法身份与Origin拒绝，旧actions及state.sqlite读取404。身份A/B、真实飞书任务历史、署名消息、工具与回执详情可读，没有业务输入控件。

a7 的 `.cache/live/e20-web-ui-observation.json`：重新加载后身份菜单跨12:50–12:52后台刷新仍打开；选择B、筛选归档、读取clear前session的12条历史，桌面中文长记录截图已看。当时390px和console未验，后续独立检查如下。

`.cache/live/e20-web-readonly.json`：HTTP阶段11项全一致，浏览阶段tasks/participants两项hash变化，另外9项不变。原采集器未保存逐行差异，不能确定变化原因，保留 browserReadOnly:false；不覆盖独立的E19全一致证据，不把活跃任务期间的全库变化直接认定为浏览器业务写入。

05:07–05:08 UTC，0ccfff2部署后使用原生Chrome DevTools设备工具栏设为390×728，实际选择身份、查看E20真实群历史、滚动中文长消息与链接，未见横向溢出。刷新前Console有两条api/state ERR_CONNECTION_REFUSED（没有保存发生时间，不据此确定原因）；刷新后所测浏览期间Console无可见错误，Issues仍有两项possible improvements未检查。退出设备模式并关闭DevTools。见 `e20-web-mobile-observation.json`；这是限定视觉检查，不是DOM尺寸断言或长期无错误保证。

## 短输出复验与群内修订

R2任务 `task_23cd1437067201acbc9e67926808b0a5`，群 `oc_901705a91971c76bdb22f8a6d97ba333`，Claude pane `w1M:p1`。新0ccfff2模板真实初始投递逐字匹配、一次输入、无工具，目录信任自动确认；原生/本地/群正文一致。首次回复154字符，仍超过120，保留R-F（`e20-r2-parent-ready-2026-09-18T05-04-09.844Z.json`）。通用模板不再追加未决问题不等于保证模型每次严格遵循字数；应用未截断输出。

随后在真实任务群无@要求把明确的100字符纯文本修订原样转交Claude。`e20-r2-revision-2026-09-18T05-08-37.037Z.json` 11/11通过：第一次简写p1被拒未执行，pi读取任务后使用完整参与者ID成功；修订全文保留，第二条原生user正文与实际工具文本一致，投递verified/acked且attempts=1。新回复60字符、一段纯文本、含marker、无工具，本地与署名群消息GET逐字一致，任务继续review等待验收。这个样本证明后续修订链路，不覆盖首次超长失败。

## npm 与发布门禁

默认主包 myrix，三个原生平台包精确同版本；无postinstall，提供myrix/herdr-agent两个命令，完整许可证与执行位保留。仅publish步骤注入NPM环境的TOKEN，公共registry三平台下载检查不带凭证。流程与恢复规则见[发布说明](releasing.md)。

`.cache/live/npm-local-install-2026-09-18T04-44-24.299Z.json`：真实a7 macOS SEA的pack/隔离离线安装通过，约39.2MB平台包、65份许可、0755执行位、安装前后二进制hash一致；两个命令version/--version/help均通过。Linux不使用伪造产物冒充实测。npm相关12项自动化覆盖完整性冲突、幂等恢复、可选原生包缺失和全部命令纳入有界重试。

用户授权问题修复、必要验收和最终HEAD CI通过后自动合并、打tag和检查Release Action，首版从v0.3.0开始。主分支旧Go required checks需等价迁移为三个实际Node/SEA检查，保留strict和其他保护，不绕过失败检查。正式tag、registry发布和安装结果尚待实际执行，不以本地pack代替。

## 终态描述修复的真实复验

`b53b263` 修复完成意图的目标描述，以及资源清理后的最终描述同步。只同步有本次持久意图的已关闭任务；失败不阻塞清理，未知写入不重放，只读精确核对，历史destroyed不自动写。全量386项检查、相关57项独立回归及停机中断探针通过，独立SEA smoke通过。部署PID71369、构建时间`2026-09-18T05:12:44.082Z`、SHA256 `68ff2b13994d9f3b059a453a184b42bf5d3b74f9e000920877b518975ab361c4`；另行GET确认ready。

05:14左右从真实子任务群无@确认完成。`e20-child-completion-inbound-2026-09-18T05-15-48.825Z.json`：一次task_action complete，未显式传保留例外。`e20-final-cleanup-2026-09-18T05-16-01.299Z.json`：父子18项资源清理检查全通过，子destroyed/gone、远端completed、群dissolved、pane缺失、无pending群outbox；子final_description_sync done，远端描述精确等于destroyed/gone/无群链接投影。旧父描述保持原值，旧R-F不被冒充修复。

子收尾另外发现回复事实错误，独立记录`e20-child-parent-state-misstatement.json`：05:15:17.286与05:15:24.008两个已送达通知把已于04:57:21解散的父讨论说成仍待验收/未关闭。创建时parentContext与旧要求不是当前状态；本次未操作父也不证明父仍存活。此问题保留R-F，提示修复及复验另记，不影响上述资源清理事实。未保存当时逐字模型输入，不伪造该项证据。

主分支保护只PATCH required_status_checks：三个`check and SEA · darwin_arm64/linux_arm64/linux_amd64`，app_id均15368，strict:true；`.cache/master-protection-before-node.json`与after快照排除该字段后完全一致。没有更改管理员保护、审查、force push或删除限制，也没有绕过失败CI。

原生手动完成也已独立验证：飞书客户端在R2详情点击“完成任务”，按钮变为“任务已完成”。`e20-r2-native-completion-analysis.json` 9/9通过，远端/本地completedAt为05:18:44.415，herdr close05:19:02.738、删群05:19:09.739；没有pi complete调用、completion_sync或程序completion写回执，靠远端同步观察到完成（未收到taskChanged事件，不把poll误称事件触发）。远端最终描述精确匹配，两个描述同步回执done。`e20-final-cleanup-2026-09-18T05-20-18.910Z.json` 27/27资源检查通过，本轮3群均dissolved、3准确pane不存在、无对应群pending outbox。

所有E20测试任务收尾后，另建新的只读基线，`e20-web-readonly-final.json`：HTTP阶段以及真实Chrome查看已关闭子任务历史/切换工具回执页后，11个namespace均完全一致，httpReadOnly/browserReadOnly均true。该次独立通过不覆盖之前活跃任务期间的false或未定因记录。

全量专用资源库存 `.cache/live/test-resource-inventory-e20.json`：E17十二项＋E19一项＋E20三项，共16任务全部清理；16远端task已完成、16群dissolved、20个准确绑定pane均不存在，0保留、0未知、0待发送outbox，读取无需重试。仅核对专用资源，没有列举或更改无关用户执行器。两个隔离恢复fixture群不在生产DB，沿用02:48历史解散证据，未称本轮新鲜回读。

## 通知事实输入整改

真实错误促使通知默认输入改为当前task生命周期投影与参与者结构状态：保留资源ID、状态、完成/关闭意图、保留策略、讨论轮次、阻塞/同步错误、首发投递和hasOutput；不默认混入requirements、parentContext、task.result或参与者lastOutput正文。完整历史与原始输出继续持久保存，AI仍可按需调用现有只读task_get；普通对话、工具权限及参与者原文投递均不改变。通知是否发送和正文仍由AI决定，没有固定业务回复或关键词替换。

只加提示的三组真实隔离probe全部保留，最终两组未再误报父状态，但仍有收尾措辞歧义，未记整体P（`e20-parent-state-probe-r1/r2/r3.json`及review）。输入投影改变后另做一组真实模型复验，两个重建notice阶段均只报告当前任务完成/进入收尾/群即将解散，未引用父状态或旧业务结果；这是新输入结构的有限证据，不是无限重试挑选。普通答复输入未变，该样本仍把未来群解散与当前回复送达过度绑定，保留措辞局限，不宣称模型全场景事实表达有确定性保证。所有probe只调用真实模型与隔离录制工具事实，未发飞书、未操作herdr或生产任务，不冒充实际通知送达。

最终投影原始运行与人工判定分别为 `e20-projected-notice-probe.json`、`e20-projected-notice-review.json`。独立审查24项相关测试通过，测试中的handler断言已移至可观测失败收集，避免被通知生成失败降级逻辑吞掉。最终 `npm run format`、`npm run check` 全通过：严格类型、Biome、1000行限制及 **388/388** 测试，零失败、跳过或取消。此计数不替代本文保留的真实模型限制及矩阵未测项。
