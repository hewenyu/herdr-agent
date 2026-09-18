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
