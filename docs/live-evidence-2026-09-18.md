# 2026-09-18 真实验证证据

本记录补充[逐项验收矩阵](live-validation.md)，不替代未完成的现场验收。代码基线为 `eb838d6c34698d547b4a06670d9e0f5242ced246` 及验证当时未提交工作区；各探针期间提示词和启动逻辑仍有修改，不能把所有结果归给同一个发布二进制。执行二进制与每次修改的精确 hash 尚待主验收记录补齐。

时间有原始记录时使用 UTC（北京时间加 8 小时）。本文件仅摘录必要的测试对象标识，不复制生产 owner ID、原始群成员姓名、凭据或完整用户历史。本地 `.cache` 证据未必随仓库提交。

## E01：真实模型首个决策

2026-09-18 会话执行 [model-probe.ts](../scripts/live/model-probe.ts)，真实调用配置模型 `kimi-k2.5`，主协议 `openai-responses`。工具名称、描述和参数来自真实应用；首次调用时记录参数并中止，不执行原工具。因此这是模型决策证据，不是项目、任务或执行器创建证据。逐次 stdout 留在工具会话记录，未另存完整原始日志；不补造精确时间。

| 输入场景 | 次数 | 已观察决策 |
| --- | --- | --- |
| 新建项目并交 Codex 开发，不用测试 | 3 | `project_create`、`task_create`、`task_create`；创建任务参数保留 Codex 和不用测试 |
| 合成历史曾谎称任务已创建，再次明确创建 | 3 | 均调用 `task_create`，未仅复述历史承诺 |
| 已有项目新任务 | 1 | `projects_list`，属于合理前置查询；后续创建未在此探针执行 |
| 查询当前未结束任务 | 1 | `tasks_list` |
| Claude 与 Codex 只讨论需求 | 1 | `task_create`，kind 为 discussion，含两类参与者 |
| 切换、归档、恢复 pi session | 各 1 | 对应 `session_select`、`session_archive`、`session_restore` |
| 否定关闭、仅讨论本工具、普通问候 | 各 1 | 文字答复，无写工具调用 |

共 15 次符合上述首步预期。另将同配置的单次状态查询切换为 `anthropic-messages`，真实返回 `tasks_list`；没有持久修改生产配置。阶段事实文案加强后，又执行一次 `--only fresh-task`，仍为 `projects_list`。以上不证明跨 provider 的完整工具回路、会话持久化或全部对话稳定性。

## E02：真实模型与受控阶段回执

[queued-reply-probe.ts](../scripts/live/queued-reply-probe.ts) 使用真实 PiEngine/模型和应用工具结构，但工具 execute 全部替换为合成返回；不构造业务服务、存储、飞书或 herdr 对象，不产生外部任务。

先完成 3 次 queued 和 1 次“资源已创建但输入未发送”的单轮检查。四次均没有虚构已开始执行；其中 queued 答复仍将“缺少 ID”说成“未创建”。随后提示词明确异步创建中的缺失 ID 仅表示尚未确认，再执行 `--once`：

| 场景 | 第一轮 | 第二轮追问“群已经有了，而且已交给 Codex 开始做，对吗？” |
| --- | --- | --- |
| accepted:true、queued，无 chatId/remoteTaskId；started:false、initialSent:false | 创建后调用 `task_get`，只承认本地登记，资源和启动/投递尚未确认 | 调用 `task_get`，主动纠正用户前提，未把 groupDeleted:false 当成群存在 |
| 有远端任务/群 ID，starting；started:false、initialSent:false | 承认群与远端任务已就绪，明确尚未交给 Codex 开发 | 调用 `task_get`，区分“群已有”和“执行未开始” |

两场景共四轮由人工检查 stdout，符合本次阶段事实边界。样本有限，不能保证模型未来每轮都遵守，也不是外部执行的端到端证据。

## E03：真实模型通知

[notification-stage-probe.ts](../scripts/live/notification-stage-probe.ts) 调用同一真实模型，使用合成 task/participants，tools 为空。

- welcome：远端任务/群已有、参与者 pending、started/initialSent 均 false。答复为群已就绪，启动和初始投递尚未确认，没有说已开始开发。
- blocked：started/initialSent 均 true、当前 blocked。答复为启动和初始投递已确认，但当前等待用户处理，没有说仍在执行业务。

后续旧版真实服务又出现 completed 通知仍称等待验收。为此追加 `--only completed`：合成 task 的原 requirements 仍要求“完成后等待用户验收，不自动完成或关闭”，当前 status=completed、completedAt 有值、closeRequested=false，参与者 done。真实模型正确答复“任务已登记完成”，没有沿用旧阶段等待验收，也没有声称资源关闭完成。提示词现要求生命周期事实优先于旧 requirements。

本次通过仅覆盖三类通知的模型措辞。真实服务后续 welcome/blocked/completed 通知需要在带实际 participants 数据与新提示词的版本上复验。

## E04：真实飞书 REST 生命周期

入口为 [feishu-lifecycle.ts](../scripts/live/feishu-lifecycle.ts)，使用实际 FeishuPlatform、API/SDK HTTP；不启动第二条 WebSocket，不创建 herdr 执行器，不调用模型。owner 来自最近真实飞书入站的可信 owner，不按白名单首项猜测。

| 轮次与证据 | 时间（UTC） | 结果 |
| --- | --- | --- |
| `.cache/live/feishu-lifecycle-2026-09-17T23-49-54-556Z.json` | 23:49:54 起，修正回读于 23:53:55–56 | 创建任务/群并 GET；成员列表查询 HTTP 400 中断。删除群后首版脚本错误要求 GET 不可读，后续 GET `chat_status=dissolved` 证实已解散；中断测试任务补标完成并回读 |
| `.cache/live/feishu-lifecycle-2026-09-17T23-53-31-686Z.json` | 23:53:31–40 | 创建任务/群、消息发送及 GET、描述更新及 GET、complete→GET→reopen→GET→complete→GET、解散群→GET 均核验成功；成员列表仍缺权限 |

第二轮任务 `f3d30a30-cc7a-4e96-96b0-774d29f8d95b` 已完成，群 `oc_67528614dccec8d36f5aeed9a315f29f` 已解散，消息 `om_x100b65f3992324a4b496261e5eeed88` 内容回读一致。第一轮群同样已确认解散、任务已确认完成，不留活跃测试群。

成员查询返回 API code `99991672`，需 `im:chat:readonly`、`im:chat`、`im:chat.group_info:readonly` 或 `im:chat.members:read` 之一。只能确认建群请求邀请了单一 owner、group GET 的 user_count=1；不能据此宣称已独立核对完整成员 roster。第二轮脚本特意保留非零退出，不能写成整轮全绿。两次失败都是验收缺口或首版脚本断言问题，不是“解散失败”的产品结论。

## E05：Web 发起的真实 Codex 链路

证据：`.cache/live-validation-run.json`、`.cache/live/production-readback.json` 及主验收执行者报告。Web 请求创建新项目 `validation-node-pi-0918`，要求 Codex 在专用目录制作 HTML/SVG 双人比武、不测试、完成后等用户验收、不自动完成或关闭。

| 阶段 | 已观察事实 | 判定 |
| --- | --- | --- |
| 调度登记 | 2026-09-17 23:54:57 UTC 记录新 task `task_17c744ff6a22d619f3fa9280b261dc65` 和独立 pi session；主验收确认模型实际创建链路 | R-P：这一 Web 新建路径；实际 checkpoint/操作日志由主验收核对，缓存运行文件本身未包含完整 toolCall |
| 即时回复 | task_create 当时仅 accepted/queued，模型却说“已创建真实飞书任务和专属任务群”“约束已转交” | **R-F：事实提前**，即使稍后资源真的创建也不能改写当时失败。提示词/工具说明已改，E02 受控回执通过；新真实服务同阶段答复仍需复验 |
| Codex 目录信任 | 23:56:09 UTC，真实 Codex blocked 菜单，现场 stateSeq=73；已有审批入口返回 ok:true，随后执行继续 | R-P：这次手动受限审批链路；**不证明新 pi 自动目录信任流程，也不是群内用户点击回调验收** |
| 真实资源 | 2026-09-18 00:02:20 UTC GET：远端 task `c6118a40-0fa4-4e1f-818b-63c03f06d5c2`，群 normal/user_count=1，真实结果消息存在 | R-P：远端对象与消息内容可回读；群客户端实际打开、完整 roster 仍未验 |
| 实际产物 | 独立只读确认专用目录 `index.html` 存在，21938 bytes，SHA256 `1187575a9d0deac39ec3809d6f6317d8945b42b9674f6e658f404f85a1c0af5a`，含 SVG/script | R-P：文件实际存在；没有因此宣称动画视觉质量或交互已验收，未运行作品测试 |
| 输出与验收状态 | 群 GET 读到署名 Codex 的完整最终消息及“待验收”通知；远端 completed_at=0；主验收核对远端描述含结果全文 | R-P：本次结果投递与未自动验收；描述比较原始 `descriptionMatchesOutput:false` 因 Markdown 转 plain 导致原字串比较失败，主验收确认非漏传，归一化比较证据待落盘 |
| welcome / blocked 通知 | 群 GET 留有“参与者已开始执行”“blocked但仍在处理中” | **R-F：阶段措辞不准确**；新增实际 participants 上下文和 E03 提示词修正。真实服务修正后的通知 U |

从 Web 到真实 Codex 产物、飞书群结果已形成一条实际链路；原 LIVE-001 飞书入站创建失败仍保留 R-F 历史。真实飞书入站查询与用户明确完成正在主验收进行；已报告群 UI 可见完成回复，但远端回读与完整证据尚待补入，本文不提前记全通过。旧版 completed 通知仍说等待验收的失败也保留，修正仅有 E03 受控模型证据。不能用 Web 链路替代飞书入站创建的完整复验。

## E06：目录信任与其余审批的产品边界

用户已明确：**保留现有 Bypass；只处理执行器仍然弹出的确认。** 不为验证而关闭 Bypass，也不重新制造被 Bypass 跳过的审批。

pi 仅通过专用启动流程识别并确认当前任务由服务端配置/绑定的工作目录信任提示，含已有项目新参与者、worktree、无项目讨论目录。受限工具需重新核验参与者尚未 initialSent、任务目录、执行身份、现场版本和原生菜单；不是给普通会话通用按键或审批能力。其他所有确认须由任务群内用户亲自选择，参与者输出和“全自动/继续”等短句不能扩大该例外。

目前实现与受限边界已只读审查；上述提示词和探针脚本 Biome 通过，`npm run typecheck` 通过。新流程的真实 Codex/Claude 自动目录信任、目标变化拒绝、未知写入不重试、确认后仅一次初始投递，以及其他菜单群内点击回调，仍按 B07/B11 单独验收，不由 E05 的既有手动信任步骤替代。

## E07：主入口自动压缩与手动新 pi session

当时约束与探针范围：主机器人私聊自动压缩上下文；手动 `/clear` 由模型选择专用 `session_clear` 工具，在当轮回复持久后创建并选中新 pi session。旧历史、回执和已接收排队消息保留原 session 绑定，所有群拒绝。后续用户明确旧会话须归档，且主入口 Web 聊天同样适用，以下早期结果不证明新语义已现场通过。

`node --import tsx --test tests/runtime/*.test.ts tests/app/session-tools.test.ts tests/app/conversations.test.ts` 本轮 33 tests 通过，含新增 `entry-reset.test.ts` 三项：延迟切换/旧队列与回执/重复事件及重建服务选中状态；失败不创建及普通群/任务群拒绝；私聊自动压缩不换 session、随后 clear 新 session 不继承旧摘要。原 Web generation 清空测试仍通过。

`node --import tsx scripts/live/entry-context-probe.ts` 使用真实配置模型、真实 PiEngine 和 SessionService，但 SQLite 仅在内存中、历史为 22 条合成用户数据，工具只提供实际 session_clear。没有真实飞书入站，也没有飞书/herdr 资源操作。

- 长上下文触发真实 `summarize` 一次；原 session 不变，24 条原始历史含本轮输入/回复保留，模型答复保留“不创建/关闭任务、保留项目代码”等约束。
- 随后输入 `/clear`，模型自主调用 `session_clear` 一次；真实内存服务创建并选中新 session，新历史为空，旧 generation=0，旧回复仍可开始投递。
- 模型答复明确 scheduled 只是已安排，本轮回复持久后生效，没有把工具受理提前描述成切换已经完成。

该探针证明指定输入下的真实模型压缩/工具决策及内存业务语义；不能代替真实飞书回调、持久数据库跨进程或长时间真实对话质量验收。代码与脚本类型/格式检查通过后方纳入构建。

## E08：外部群状态与解散事件边界

主验收记录 `.cache/live/group-status-readback.json`，UTC `2026-09-18T00:37:47.388Z`：旧 REST 测试群 `oc_67528614dccec8d36f5aeed9a315f29f` 实际 GET 为 dissolved，当前 B 群实际 GET 为 normal，与预期一致。**仅这两个群状态 API 读通过**，不代表新程序的 completed→关闭执行器→解散群已做真实验收，也不代表真实解散事件已通过平台连接送入本程序。

本地新增 `tests/feishu/group-events.test.ts`、`tests/app/group-events.test.ts`：GET 只认可 normal/dissolved/dissolved_save，未知值、API错误、403和断网不当作解散；SDK dispatcher 拒绝错误/缺失 app_id、无效 chat_id、旧连接和已取消连接，等待持久入队成功；应用重建后处理已存 group inbox，仅清对应任务，重复/未管理群不清其他资源。`node --import tsx --test tests/feishu/*.test.ts tests/app/group-events.test.ts` 17 tests 通过；使用本地请求和连接替身，无新 WebSocket 或外部资源写入。

官方 [获取群信息](https://open.feishu.cn/document/server-docs/group/chat/get-2.md) 与 [群解散事件](https://open.feishu.cn/document/server-docs/group/chat/events/disbanded.md) 均明确权限三选一：`im:chat`、`im:chat:read`、`im:chat:readonly`。新申请选择最小只读 `im:chat:read`，授权检查接受已有另外两项，仍要求 tenant/granted；tasks 关闭时不请求该权限和群解散事件。没有执行实际补权。群成员列表权限缺口仍独立保留，不能以群状态读取通过消除。

## E09：2c7672a 真实自动目录确认与统一收尾

2026-09-18 00:43 UTC 起运行提交 `2c7672a7049cb614e30e3f8a85f0f6b309b0b6a4` 的 macOS arm64 SEA，SHA256 `d9a9d2204580aa7e1400d08c10cacaac8d42a06a87c220b7f94331f5cccee7cc`。256 项本地检查通过；该提交 macOS arm64、Linux arm64/amd64 CI 的检查及 SEA smoke 均成功。仍不据此声明以下全部业务通过。

- `.cache/live/auto-directory-trust-r2.json`：新目录 `validation-auto-trust-0918-r2`，任务 `task_5c5871dda88726eae273ee987ab4b326`，Bypass=true。Claude `w16:p1` 首次 stale_guard 明确未按键，重读后成功；Codex `w17:p1` 一次成功。各恰有一条 done 信任回执，实际信任菜单消失，手动审批卡均为零。此前卡住的 Claude `w13:p1` 同样自动恢复。**自动目录信任 R-P；双人讨论尚未通过。**
- `.cache/live/cleanup-ac.json`：A 经真实群文字确认完成，C 经飞书原生任务详情的“完成任务”按钮手动完成。两者远端 completed_at 非零、本地 destroyed、群 GET dissolved、herdr 原 panes `w15:p1`/`w12:p1` 均缺失。各最终群回复与解散前通知都已送达，并早于 delete-group done；herdr close done 也早于删群。**两条默认收尾路径 R-P。**
- `.cache/live/external-disband-cleanup.json`：经飞书 REST 外部解散 SVG 专用测试群后，程序轮询确认、通过 herdr 清理 `wZ:p1`；本地 destroyed，远端任务仍未验收（completed_at=0），没有因群解散伪造验收完成。**外部解散轮询收尾 R-P；不等同于已验证真实解散事件订阅。**
- `.cache/live/concurrent-ac-products.json`：A/C 的独立 `index.html` 分别只含 `CONCURRENT_A_OK` / `CONCURRENT_C_OK`，有唯一初始回执。两者旧版目录提示由用户在群里手动点过，所以该轮不计为自动信任通过。

本轮新增真实失败继续追踪：Claude native 状态 done 且屏幕已有回答，但 herdr 未返回 sessionId，旧读取路径无法采集输出，Codex 尚未收到首轮，通知却误称讨论结束。已定位并准备收据关联恢复及通知事实约束，真实双人轮转待新构建复验。

真实飞书群 `/clear` 已拒绝且任务绑定未变。主私聊 `/clear`（消息 `om_x100b65fce081d4acb369c2a68a03c10`）却复述旧历史“私聊不支持”而未调用工具、未新建 session，明确记 **R-F**。用户再次明确：主私聊应归档旧 pi session 并开启新 session，只有群聊不支持；继续修正并真实复验，不以 E07 内存探针替代。

CLI 逐入口的旧构建实测见 [CLI 证据](live-cli-evidence-2026-09-18.md)，保留 setup 未测和诊断部分失败边界。

## E10：旧历史污染修复与通知事实探针

`scripts/live/entry-history-probe.ts` 用 SQLite `readOnly:true` 读取 E09 失败的生产主会话，共 26 条历史，复制到内存 Store，保留原文和已有摘要。真实配置的 pi 模型仅获得实际 `session_clear` 工具，所有写入只在内存；无飞书消息、herdr 操作或生产数据库写入。模型实际调用一次 `session_clear`，内存服务在答复持久后归档旧 session、创建并选中新 session。断言旧 generation 不变、26 条旧记录保留、新历史为空、旧答复仍能开始投递，全部通过。回复正确说明“已安排归档当前会话并开启全新会话”，没有复读旧拒绝。

修复将历史助手输出作为有来源的历史数据，不再作为当前 assistant 的示范发言；摘要移出 system 层，当前系统规则、服务端绑定和工具定义决定能力。未新增关键词执行分支或强制工具选择。主入口私聊和 Web 聊天的模型 `session_clear` 均归档旧会话并新建；Web 显式清空按钮仍使用 generation 重置。旧会话尚未执行的排队消息保留旧绑定并因归档拒绝，不能误称仍会继续执行或迁移至新会话。

`node --import tsx --test tests/runtime/*.test.ts tests/app/session-tools.test.ts tests/app/conversations.test.ts` 共 34 项通过，涵盖旧队列拒绝、不重复建新 session、旧 ACK 可达、Web 选择清除归档目标、后续消息进入新会话、显式清空按钮保持原语义、失败不归档和群聊拒绝。此项为真实模型加内存效果 **R-部分**；新构建真实飞书入站仍须复验，不抹去 E09 的失败。

`scripts/live/discussion-notice-probe.ts` 使用真实 `kimi-k2.5` / `openai-responses` 和三组合成讨论记录，无工具与外部副作用。缺输出且 0/1 轮场景没有虚构双方发言、讨论结束或群内结果；单方输出、另方未轮到场景明确区分；1/1 轮暂停场景只称自动暂停，未称已验收。修订提示词后不再因未采集输出建议补发/重新触发。`tests/app/notification-facts.test.ts` 验证真实 Application 通知上下文包含输出是否存在、初始投递、原生 session ID 和轮次事实。通知探针不证明真实 Claude transcript 采集与双人轮转已通过；模型措辞仍需在生产复验。

## E11：主入口 clear、自动压缩、并发与关联评审/测试

本轮运行基线为 `54ae61622da1bf8001c75de81a356546d3a924a4`，主验收核对 PID `91716`、macOS arm64 SEA SHA256 `c41667b0848c3c80f0234a14c035d710e50ae7934d482678a754cfeaf687d1dd`，263 项测试及 macOS arm64、Linux arm64/amd64 三平台 CI 全部通过。此处构建与 CI 信息由主验收提供；以下各业务结论分别来自实际记录，不将后续未提交修复继承为该构建已通过。

| 场景与证据 | 实际观察 | 判定及边界 |
| --- | --- | --- |
| 主私聊 `/clear`：`.cache/live/private-clear-success.json`，01:06 UTC | 真实飞书消息 `om_x100b65fc9325a4b4b175771a614d091` 触发一次 `session_clear`；旧 `legacy_s_bc25…` 已归档、generation=0，原 26 条历史保留，加本轮输入/答复共 28 条；选择新 `s_7539947a…`。后续消息进入新会话，实际回复 `CLEAR_NEW_SESSION_OK`，输入与回复均有 delivered 回执 | **R-P：该主私聊归档、切换与后续送达链路。** E09 旧历史拒绝的 R-F 原样保留；旧队列与失败边界仍引用离线测试，不把本次正常链路扩张为全部异常通过 |
| Web 聊天 `/clear`：`.cache/live/web-clear-success.json`，01:09 UTC | 实际模型/API 操作后旧 `s_24ce5cfb…` 已归档、generation=0，新 `s_0b69151e…` 被选中且历史为空 | **R-P：服务端归档与新会话效果；R-部分：Web 完整链路。** 回复为 prepared，`visibilityAcknowledged=false`；没有伪造 ACK，不能标浏览器已渲染或用户已见 |
| 自动压缩：`.cache/live/web-compaction.json`，01:03–01:05 UTC | 正在运行的 Web API、真实 `kimi-k2.5`、contextTokens=50000；4 批合成材料共 132052 bytes，第 4 批产生 1213-byte 摘要和 cursor。回忆答复保留验收代号与两条禁止外部操作的约束；原输入完整、共 10 条消息保存，其他 session 历史/摘要无代号串入；无业务工具调用 | **R-P：该配置下自动压缩、原文与约束保留、session 隔离。** 所有 API 答复仍 sending，未调用 chat.ack；不是浏览器可见性或真实长期业务质量验收。最初超 12000 字符输入明确 not_executed 后修正，专用会话验收后已归档 |
| 双 pi session 并发：`.cache/live/parallel-pi-queries.json`，00:55 UTC | 两个真实模型 `pi.turn_started` 日志相差 3ms，处理区间重叠，各实际调用 `projects_list` 一次并完成 | **R-P：独立 session 的该只读查询并发。** 答复 prepared、未 ACK；不等同多项目开发全部调度/恢复已过。记录未固定 commit/PID，不将该较早记录擅自归属于 54ae616 |
| 关联评审与测试：`.cache/live/related-review-test.json`，01:11 UTC | review 任务 `task_1a332…` 保存父讨论的要求、Claude 发言及参与者快照，Codex `w18:p1` 输出明确未执行验收；test 任务 `task_d65e…` 的 Codex `w19:p1` 实际执行只读 Python 断言，工具回执 exit_code=0，项目文件 hash 未变。两任务结果均在群观察到，均停在 review | **R-P：本次父讨论快照→评审及独立只读测试。** 关联评审不是父讨论已达成共识，也不是用户已验收；不代替讨论→开发、worktree、完整恢复或浏览器表单操作验收 |

双人讨论继续记 **R-F/待修复复验**：Claude 输出现已恢复，但第二参与者首次转交缺少 receipt，随后状态为 unknown。正在以原 user 正文与 fingerprint 匹配进行只读确认和安全恢复；缺少确认前不得重发，也不能把双方进程 done、单方输出、关联评审或上述 263 项测试当作完整轮转通过。E09/E10 的历史失败与探针边界保留。

## E12：只读恢复、明确保留与 Web ACK 新失败（待后续复验）

当前运行 `29a7715f89921ea5c5d47ebe98a67b1bb0b0bc1c`，PID `95378`，macOS arm64 SEA SHA256 `bcb0653ed711afd36af2141606254900ab0e59409e6de01403393f7c6f5cd602`，运行版本由恢复后证据再次读取。主验收报告 273 项测试、SEA 烟测，以及该提交 [三平台 CI 35294941364](https://github.com/hewenyu/herdr-agent/actions/runs/35294941364) 均通过；这些结论不扩张到尚未部署的修复。

- **原 B uncertain 只读恢复 R-P。** `.cache/live/discussion-recovery-before.json`（01:19 UTC）与 `discussion-recovery-after.json`（01:21 UTC）表明同一个 relay operation 从 uncertain 变为 done，实际结果为 delivered/verified、attempts=1，明确“未重新投递”。原生 user 记录数仍为 2，receiptCount 仍为 1，输入 SHA256 始终为 `cd5098640234a50b5b3930fbd03b0cf4ec2c77b741a33ce2ef5bbf2e9e18c5ae`。Codex `initialSent` 从 false 恢复为 true，采集到输出，群内只有一条对应输出 `om_x100b65fd513c94a8b3e09156edff673`。讨论仍 paused、rounds=0；这证明恢复未重发，不证明从零开始的完整轮转已无缺陷。
- **R2 一轮讨论结果及有界停止 R-P，首次确认缺陷保留。** `.cache/live/r2-discussion-round.json`（01:26 UTC）固定运行 29a7715：Claude `w16:p1` 与 Codex `w17:p1` 各有唯一 native 输入、零原生工具调用、各一条群输出，实际 rounds=1/maxRounds=1、paused=true。双方围绕需求发言并等待验收。但首次 resume 返回 delivery_unconfirmed，之后由原生输入只读恢复为 verified/delivered、attempts=1、未重发。不能将最终一轮完成写成首发同步确认无缺陷；末尾 receipt 修复仍待部署复验。
- **明确 complete 同时保留群和执行器 R-P。** `.cache/live/discussion-keep-both.json`（01:22 UTC）：原 B 任务 completed、remoteCompletedAt 非零、keepGroup=true、closeRequested=false；群实际 normal，`w13:p1` 和 `w14:p1` 两个 panes 均保留。验收器最初误将状态 normal 当成 active，随后只读修正核对，没有重复完成操作。此为明确保留例外，不改变默认收尾。
- **独立 test 默认最终收尾 R-P。** `.cache/live/related-test-cleanup.json`（01:17 UTC）对 E11 的 test 任务只读核验七项检查全部为 true：远端完成、群解散、herdr close 回执 done、所有群消息 delivered、消息确认早于删群、close 确认早于删群、delete 回执 done。任务本地 destroyed，`w19:p1` 及该任务受管 panes 已不存在，无 error/syncError。该记录早于本次部署，不作为 29a7715 新执行收尾的证据；“七项”是七个检查，不是七个任务。
- **真实浏览器 Web clear 整体 R-F，部分步骤通过。** `.cache/live/web-clear-browser.json`（01:21–01:22 UTC）使用真实 Chromium、现运行服务和真实模型，无响应替身。归档旧 session、选择空的新 session、后续输入隔离、新回复实际显示后 ACK、归档历史实际渲染均通过；390px 检查无横向溢出、pageErrors 为空。但 clear 回复仍属于旧 session，尚无可见 DOM 节点时程序尝试 chat.ack，`visibleBeforeRequest=false`，验收器阻止该 ACK；回复仍 sending。必须保留 status=FAIL，不能用其它回复可见、API 200 或会话切换成功改成整体通过。

本轮待复验项：主验收另发现 R2 的首次 relay 仍先 unconfirmed 后只读恢复，原因是 receipt 放在本轮安排之前，而既有 verifyReceipt 要求正文末尾。正在修复末尾 receipt 及旧格式兼容；Web ACK 可见性和移除参与者后的 resume 也在修复。此处仅记录发现及待验证方向，尚未部署，不能提前标修复通过。E09/E11 的旧失败及本轮 Web R-F 均保留，后续复验须有独立记录。

## E13：9a86e40 成员调度、收尾与真实浏览器复验

部署提交 `9a86e4026e4145cb16d490fdbdf3c8567deb2915`，PID `97147`，macOS arm64 SEA SHA256 `e10e7e6e5998982302142ce7c77fa601babb6248fdac146019cf836708dbf454`，成员及浏览器证据均固定该版本。主验收报告 280 项测试、SEA 烟测和 [三平台 CI 35295605258](https://github.com/hewenyu/herdr-agent/actions/runs/35295605258) 成功。以下只确认对应分支，不以构建通过替代未执行的验收。

- **移除后 resume 的本次调度 R-P。** `.cache/live/discussion-membership-readback.json`（01:35 UTC）九项检查全为 true：保留 Claude 获得新 native 输入与输出、输出匹配本地记录并在群可见；被移除 Codex 的 `w17:p1` 不存在，旧输出保留，移除后无新 relay 或 native 输入，activeParticipant 指向保留者。恢复投递即时 delivered/acked/verified、attempts=1；不需要先返回 unknown 再恢复。此记录 rounds=0、paused=false，不把这一次恢复发言当作新轮预算完整结束。
- **新增参与者首次完整投递 R-P。** `.cache/live/participant-added-first-send.json`（01:35 UTC）七项检查全为 true：新增 Claude 的 3025 字 native user 正文内 initial receipt 恰好一次且位于末尾，投递即时 verified/acked、attempts=1；有新输出，与参与者记录匹配且群消息真实可见。随后出现普通 `AskUserQuestion`，当前 task/participant 为 blocked，主验收已观察到发卡且未自动确认，等待群内用户本人选择；不能把首次投递通过扩张为普通审批端到端通过。
- **原 B 保留后明确 close 的最终清理 R-P。** `.cache/live/discussion-b-cleanup.json`（01:28 UTC）保留显式 complete 的 keepGroup/keepExecution=true 回执，随后明确 close、keepGroup=false；远端完成、本地 destroyed、群 dissolved、`w13:p1`/`w14:p1` 均不存在，两个 close 与 delete 回执 done，群消息均 delivered 且通知/close 确认早于删群，十项检查全 true。证据早于 9a86e40 部署，不写成该新提交的执行记录。
- **外部解散测试远端待办的后续清理已单独完成。** `.cache/live/external-disband-task-finalized.json`（01:32 UTC）明确为专用验收任务清理，remote completedAt 从 0 改为非零，localStatusUnchanged=true。这不是外部解散自动验收；E09“群解散后远端仍未完成、未伪造验收”的原证据与结论不变。

Web clear 使用真实 Chromium、正在运行的服务与真实模型，保留三次独立记录：

| 记录 | 实际结果与边界 |
| --- | --- |
| `.cache/live/web-clear-browser-9a86e40-model-no-reset.json`，01:31–01:32 UTC | **R-F 保留。** 前一条合成输入包含无明确时限的“只回复标记、不要调用工具”；随后 `/clear` 模型复读前一条标记，checkpoint 无工具调用，未发生归档切换。答复可见 ACK 正常，后续 session 归档只是验收器清理，不能误当 clear 成功。该失败与 E12 不可见 ACK 是不同问题 |
| `.cache/live/web-clear-browser-9a86e40-scoped-canary-pass.json`，01:33 UTC | **R-P：明确限制只适用前一条消息的该输入链路。** `/clear` 实际调用一次 session_clear；旧会话归档、新会话初始空且服务端/UI选中、clear 回复先可见再 ACK 且最终 delivered、归档链接与历史可见、后续回复隔离并 delivered。全部 ACK 前有可见节点，390px 无横向溢出，pageErrors 为空。旧/新测试 session 均已归档 |
| `.cache/live/web-clear-browser-9a86e40-natural-pass.json`，01:34 UTC | **R-P：普通自然对话后的 `/clear` 真实链路。** 首句仅要求记住验收标记，随后模型调用一次 session_clear；上述归档、切新、空上下文、可见 clear 回复/ACK、历史链接、后续隔离与移动布局检查均通过，全部 ACK 有可见节点，clear 最终 delivered。两测试 session 均已归档 |

E12 未显示 clear 回复却尝试 ACK 的历史 R-F 保留，9a86e40 两次相应真实浏览器正常链路通过；本轮无 scope 的禁止工具历史仍导致模型未执行 clear，因此不宣称所有历史约束下必定调用。以下补充 R2 清理与用户本人处理普通菜单的独立回读；不改写上述旧失败。


E13 后续收尾证据：

- **R2 默认 complete 最终收尾 R-P。** `.cache/live/r2-cleanup.json`（01:36 UTC）十项检查均为 true：远端完成、本地 destroyed、群 dissolved、`w16:p1`/`w17:p1` 均不存在，两份 close 与 delete 回执 done，全部群消息 delivered，消息和关闭确认及解散前通知均早于删群。被移除 Codex 保持 removed，保留 Claude 最终 gone，无 error/syncError 或读取失败。
- **普通用户菜单本次标记 A 链路 R-P。** `.cache/live/ordinary-menu-completed.json`（01:39 UTC）八项检查均为 true：真实 callback 的 owner/group/card/message/nonce 与审批匹配，key=1；inbox action 回执 done，卡片 consumed；native AskUserQuestion 的对应 toolUseId 得到“标记 A”答案，Claude 随后输出“用户选择：标记 A。等待后续安排。”，该结果有 delivered 回执且群 GET 实际可见。问题期间 directory-trust 操作数为零；主验收仅只读观察，选择由用户本人完成。只确认本次普通菜单链路，不扩张为所有权限菜单、过期/替换现场或重复回调均通过。主验收随后移除新增 Claude 并 complete review，review 最终清理仍待单独回读。
- **多目录前置拒绝边界 R-P，worktree 执行待证据。** `.cache/live/worktree-create.json`（01:39 UTC）仅确认新项目登记与 task_d563… 对应任务创建记录，以及非法第二目录导致 save 被拒绝、首目录没有提前初始化 Git。该记录不含工作树/多目录执行产物或清理证据，任务 `task_d563c47aa704fbc208c6391606d1972e` 仍在执行，不提前标通过。

E13 进一步定位记录：

- `.cache/live/web-clear-model-probe.json` 与 `web-clear-model-probe-warm.json` 使用原失败历史、原系统提示的真实模型隔离重放，合计六次 clear 决策均选择 session_clear（两次直接、四次先正常首轮再 clear）。实际请求顺序正确，最后用户输入为 `/clear`；保留或移除客户端 cache/affinity 字段均通过，但 provider 仍报告 cacheRead，不能声称已关闭供应商缓存。记录工具意图后即停止，不执行生产会话切换。原一次 model-no-reset 继续保留为未稳定复现异常，目前没有证据确认源码缺陷或缓存错配，不因此改动 prompt；此前对历史约束影响的描述是输入条件与观察，不是已证根因。
- `.cache/live/worktree-trust-failure.json`（01:43 UTC）固定 9a86e40：工作树操作 done，任务目录包含新 worktree 和额外目录；Codex 原生信任菜单同时呈现 source repository root。当前严格模板/授权目录识别拒绝，两次结果分别为 stale_guard 与 directory_trust_required，均 not_executed；未发送确认按键，initialSent=false、任务 blocked。**该 worktree 自动信任执行链 R-F**，最小安全修复与新构建复验尚待完成。另一个暂停/中断专用任务正在验证独立推进，不因已创建便标其暂停、中断或并发全部通过。

本轮之后用户新增回复规范：主入口 clear 实际归档旧 pi、创建并选中新 pi 成功后，只回复模型生成的 `CLEAR_NEW_SESSION_OK`；一般控制与通知默认只简洁说明用户可见结果，不展示内部术语。E11/E13 旧版冗长成功回复原样保留，新规范待新版本真实复验；旧证据中的后续同名验收标记不等于当时 clear 回复已符合新规范。

新规范部署前的隔离真实模型证据（不是生产验收，暂不新增 E14）：

- `.cache/live/clear-exact-model-validation-r2.json`（01:55–01:56 UTC）使用真实配置的 PiEngine、完整二十个工具 schema 和隔离临时 Application/SQLite；只有 session_clear 允许调用真实本地处理器，其他工具拒绝，没有生产数据库、飞书或 herdr 写入。Web、主私聊以及历史已包含同名成功标记三种场景，均实际调用一次工具、由模型生成准确 `CLEAR_NEW_SESSION_OK`，实际归档旧会话并创建/选中新空会话，事务提交后才返回 prepared 回复。工具返回时旧会话尚未归档，不能把工具受理本身当作完成；本地事务与返回结果已分别核验。
- 工具明确失败和 unconfirmed 两种场景均无成功标记、无会话切换。注入模型已生成成功文本之后的新会话事务失败，实际 rollback，旧会话未归档、无标记存储、没有返回可投递答复。此为隔离故障验证通过，不是生产故障注入。unconfirmed 模型仍建议“稍后重试”，保留措辞限制；实际没有重复工具调用，不能把不重发程序约束通过说成建议措辞也正确。
- **该报告整体 FAIL，不能写全通过。** 原 restrictive BEFORE 历史场景未调用任何工具，却输出 AFTER 标记，旧会话保持不变；记真实模型隔离 **R-F**。`.cache/live/clear-exact-model-validation-r1-failure.json` 早期直接复读成功标记却未调用工具的失败也保留。R2 的 same-marker 历史通过不抹去 R1，也不抹去 restrictive 历史失败。
- `.cache/live/notification-tone-probe.json` 三种合成事件由真实模型生成通知，分别为 62、73、59 字，未展示 scheduled/持久化/内部回执字段，未把等待创建的外部资源说成已创建，也区分即将解散与已经解散。三种限定事件的措辞检查通过；无外部投递，不能据此记生产通知已送达或全部事件均已验收。

提示与工具确认方案已冻结待新构建。主验收正在完成全量检查，尚不将预期测试数量记为已通过；新规范的生产私聊与真实浏览器送达待部署后独立验收。

## E14：2aa5337 精确 clear 回复、worktree 执行及模型额度阻塞

生产二进制提交 `2aa53375f20e425d97182157a84559b9286daa68`，PID `11008`，macOS arm64 SEA SHA256 `e1b2b82546425f01467f38a92eac6e7037421bd77666e553656cee6847314e9f`。主验收报告 285 项测试及 [三平台 CI 35297564515](https://github.com/hewenyu/herdr-agent/actions/runs/35297564515) 通过。下列记录均固定实际版本，旧 R-F 保留，不能由测试总数关闭未完成现场验收。

- **真实 Web 新规范 clear 链路 R-P。** `.cache/live/web-clear-concise-success.json`（02:01 UTC）使用真实 Chromium、生产服务和真实模型；输入 `/clear` 后模型实际调用一次 session_clear，答复严格等于 `CLEAR_NEW_SESSION_OK`，实际归档旧会话、创建并选中新空会话。clear 回复有可见节点后才 ACK、最终 delivered；归档链接/历史实际可见，后续消息进入新会话且 delivered、原文保留，上下文隔离，390px 无溢出、pageErrors 为空。两个测试 session 最终均归档。此证据中的 marker 是 clear 本轮答复，区别于 E11 的后续 canary。
- **真实私聊新规范尚未通过，模型故障记录保留。** 主验收记录两次真实私聊 `/clear` 均 model_failed，未切换也未产生成功答复；其中 `.cache/live/private-clear-concise-model-failure.json` 保存首轮真实入站、checkpoint terminal=error、工具调用为空、旧 session 未归档且 generation=0。不能将 E11 旧私聊切换后的 `CLEAR_NEW_SESSION_OK` canary 写成新规范 clear 答复通过。隔离模型 private/same-marker 通过也不替代本次生产送达验收。
- **503 的已确认上游原因与边界。** `.cache/live/model-service-failure.json`（02:07 UTC）是一次无工具、无生产状态修改的真实 PiEngine 健康请求；HTTP 503 报 `auth_unavailable`，其中上游 Kimi 明确 `access_terminated_error`、五小时使用额度耗尽。恢复时间未知，不能从“五小时窗口”推算确定恢复时刻；这证明当时服务不可用，不将模型故障伪报为 clear 成功，也不据此抹去早前模型未调用工具的 R-F。
- **worktree 自动目录信任及本次多目录执行 R-P。** `.cache/live/worktree-success.json`（02:02 UTC）中原信任失败回执仍保留；新专用确认 done，用户审批 callback 为 0，初始输入一次。Codex 实际 cwd 为任务 worktree，分支为 `herdr/task_d563…`，读取主工作树 seed 与额外目录文件，仅在 worktree 产出 `WORKTREE_OK_0918`；原项目状态干净、额外目录未变，群输出一次。修复后的执行产物与隔离检查通过，不等于收尾通过。
- **worktree 默认收尾仍受阻。** `.cache/live/worktree-cleanup-before-command.json`（02:05 UTC，原 worktree-cleanup.json 的保留快照）回读：远端已完成、本地 destroying、syncErrorPresent=true，群仍 normal，`w1B:p1` 仍存在，close/delete 回执尚无 done。主验收确认通知生成受当前模型故障阻塞。不能写全部测试群或执行器已清理；后续清理由主验收继续处理并补独立回读。

新规范仍为：实际归档旧 pi、创建并选中新 pi 成功后，只送达 pi 自主生成的 `CLEAR_NEW_SESSION_OK`；程序不加关键词业务路由或固定回复替换，事务失败不送成功。E14 仅将真实 Web 分支标通过，真实私聊成功送达仍受模型额度限制。E09–E13 历史失败、R1/R2 隔离失败及 unconfirmed 建议重试的措辞限制全部保留。

**E14 之后用户明确覆盖旧要求：** 主入口飞书私聊/Web聊天的 exact `/clear` 改为确定性会话命令，不由大模型接管。程序机械归档旧 pi、创建并选中新 pi，事务成功后仅返回 `CLEAR_NEW_SESSION_OK`；失败不得送成功，群聊不支持，不清任务/herdr。普通业务沟通继续由 AI。主验收正在实现并安排真实私聊复验，尚无新机械轮转证据；上段模型自主工具要求仅描述当时方案，已被本条最新要求替代。E14 旧模型 Web 通过与私聊额度失败保留，不能当作新方案通过或失败。


## E15：ab79cc0 机械会话命令与通知故障收尾真实复验

`ab79cc0470f28c65473fc3810e6b8e39dc0a296f` 已按原部署运行，PID `20390`，构建时间 `2026-09-18T02:25:03.576Z`，SEA SHA256 `04d14c861c91c980038c9e659de68a86b531216c39f6c2b971444700adf20358`。`npm run format`、`npm run check`（315 项测试）及 SEA smoke 通过；[CI 35299218668](https://github.com/hewenyu/herdr-agent/actions/runs/35299218668) 已在同一源码提交的 linux_amd64、linux_arm64、darwin_arm64 三任务通过 check 与 SEA。E15 已独立回读真实私聊/Web机械轮转及本轮 9 个测试任务的资源清理；未测的整体功能项仍保留，目标 active。

修复同时覆盖 AI 关闭时旧归档 session 的排队命令拒绝，以及 Web 省略 sessionId 后用相同 requestId 重试造成重复轮转：按 owner/chat/messageId 加命令锁，命令回执与轮转同事务写入，重复请求复用原答复。`before_close` / `before_group_delete` 仅在通知生成失败、尚未发送时写入 `unavailable` 审计并继续已授权清理；不生成固定替代通知，不记录虚假送达。已尝试但结果未知的发送、未完成输入/输出和原生最后结果的投递屏障仍保留，不能借模型故障跳过。

离线回归对应 `tests/app/clear-command.test.ts`、`tests/app/session-tools.test.ts`、`tests/app/cleanup-notification.test.ts`，包含精确正文与引用边界、AI 开/关和模型不可用、事务失败、重复及并发请求、旧队列、未知投递恢复、通知模型/格式失败、未知发送不降级和最后结果/停机屏障。315 项全部通过属于 O-P，不是飞书、真实浏览器或资源清理 R-P。E14 worktree 阻塞及旧模型 clear 的全部 R-F 保留。以下是新版本独立现场证据，目标仍 active。


- **真实飞书主私聊机械轮转 R-P。** `.cache/live/private-clear-command-success.json`（02:28 UTC）记录主验收通过 CUA 实际发送 `/clear`：旧会话归档、4 条旧历史保留且主验收比对 hash 一致，新会话被选中且为空；答复 `source:command`，没有模型 checkpoint 或工具调用，轮转回执与旧/新 ID 对应。远端 GET 正文准确为 `CLEAR_NEW_SESSION_OK`，本地 delivered；证据中的 nativeUIReadback 另记录主验收在飞书界面确认 10:28（Asia/Shanghai）可见单行标记。此标记就是该命令回复，不是后续 canary。
- **真实 Web 机械轮转 R-P。** `.cache/live/web-clear-command-success.json`（02:26 UTC）使用真实 Chromium 与部署二进制，无模型请求及 API mock。八项检查均通过：无模型 checkpoint、旧归档、新选中且空、精确成功文本、显示后 ACK、归档历史可见、390px 无溢出；pageErrors 为空，答复 source=command 且 delivered；主验收已肉眼检查新空会话及移动宽度截图。旧测试 session 已由命令归档，新测试 session 随后也归档。
- **worktree 模型通知不可用后的已授权清理 R-P。** `.cache/live/worktree-cleanup.json`（02:26 UTC）独立回读本地 destroyed、远端 completed、群 dissolved、`w1B:p1` 不存在，close/delete 回执 done，已有群消息均 delivered，消息及 close 确认早于删群。两类收尾通知均记 `unavailable / generation_failed / model_failed`，没有生成决策、发送尝试或送达记录；它们的 acknowledged 检查为 false 是如实未发送，不应改成“通知已送达”。旧阻塞快照保留在 `worktree-cleanup-before-command.json`。
- **本轮已知测试资源清理 R-P。** `.cache/live/test-resource-inventory.json`（02:26 UTC）只读核对 runId `node-pi-live-20260918` 的全部 9 个已知任务：均本地 destroyed、远端 completed、群 dissolved，所有已知受管 pane 不存在；pending outbox、error/syncError、readErrors 均为零，awaitingCleanup、stillUsedForValidation 与 unownedValidationAgents 均为空。该结论仅覆盖本轮已知任务和对应资源，不代表所有功能已验收或用户代码目录已删除。
- **历史失败完整保留。** `.cache/live/private-clear-model-failures-before-command.json` 保存 02:02、02:05 UTC 两次旧模型路径的 uncertain/model_failed、空工具调用与 checkpoint error。旧失败不被机械命令重放；新 `/clear` 无需模型，不能继续将其成功验收标为被模型额度阻塞。普通 AI 业务仍依赖模型，额度恢复时间未确认。

离线的 AI 关闭、事务回滚、群拒绝、无 sessionId 并发去重、未知投递等证据不冒充真实环境故障注入。setup/补授权、外部 memory、完整未知写入与长期故障等未测项仍按矩阵保留；E15 不关闭整体目标。

部署版本说明：上述运行二进制对应源码提交 ab79cc0；后续仅文档提交可能改变仓库 HEAD，不表示运行产物已按文档提交重新构建。
