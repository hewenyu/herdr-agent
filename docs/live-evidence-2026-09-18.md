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
- **历史失败完整保留。** `.cache/live/private-clear-model-failures-before-command.json` 保存 02:02、02:05 UTC 两次旧模型路径的 uncertain/model_failed、空工具调用与 checkpoint error。旧失败不被机械命令重放；新 `/clear` 无需模型，不能继续将其成功验收标为被模型额度阻塞。普通 AI 业务仍依赖模型；本节检查时恢复时间未确认，E17 的03:03 UTC独立健康请求随后确认模型恢复响应。

离线的 AI 关闭、事务回滚、群拒绝、无 sessionId 并发去重、未知投递等证据不冒充真实环境故障注入。setup/补授权、外部 memory、完整未知写入与长期故障等未测项仍按矩阵保留；E15 不关闭整体目标。

部署版本说明：上述运行二进制对应源码提交 ab79cc0；后续仅文档提交可能改变仓库 HEAD，不表示运行产物已按文档提交重新构建。


## E16：请求边界、记忆协议与已有证据补记（进行中）

本轮目标仍 active。本节02:40–02:56 UTC的真实 Web 检查指向 E15 的 ab79cc0/PID20390/原 SEA SHA；工作区或文档 HEAD 不代表运行二进制改变。以下新增现场检查、隔离协议检查与历史漏记分别报告，W27及会话管理的当前原生UI/API证据见本节后续；删群回执恢复已有隔离真实证据，新源码5d1e96f已提交并通过329项check与SEA，02:58 UTC新部署已核对，详见本节末尾。

### 当前部署 Web 请求边界：W02/W04

`.cache/live/web-entry-runtime.json`（02:40–02:41 UTC）固定上述运行版本。合法只读请求 200；错误 Host、错误 Origin、缺 CSRF 分别 403；非 JSON、损坏 JSON、未知 action 分别 400；超过 1 MiB 的正文 413。检查前后 owner/选中会话/对象列表及 tasks、participants、operations hash 不变，`requestBoundaryNoStateChanges=true`。CSS/JS 返回正确类型和 CSP，未知路径与 `/state.sqlite` 均 404。记为本次真实请求边界 R-P，不等于全部写入幂等、所有页面视觉或 SSE 恢复已验收。

Host 初始检查使用 Node fetch 时，传入 Host 被客户端覆盖；记录中的 harnessCorrection 明确此为验收器问题，改用原生 http.request 后才实际测试 Host 不匹配。不能把先前未发送预期 Host 的结果记作产品漏洞，也不据此删掉校验步骤。

### Memory 协议：B16/GAP15 的 O-P

`.cache/live/memory-protocol-audit.json`（02:39 UTC）与 `memory-protocol-provenance.json` 使用隔离临时 state、实际 MemoryService/native fetch 和真实 loopback HTTP，合成凭据与数据，无真实模型、飞书、herdr 或生产配置访问。15 项检查通过：owner/session/task scope、每 owner endpoint/key 覆盖、file 模式不联网、HTTP 成功/空值契约、响应错误/坏 JSON/schema/超大/断体脱敏、首部及正文超时、调用前取消不发请求、重定向不泄露流量/凭据、不安全 endpoint 拒绝及 provider 切换摘要同步。

provenance 固定检查时 HEAD `234cd22dbbd10a8d2c8c56b34991f5a53608630e` 和相关源码 hash，sourceEdits=false；这是检查源码来源，不改写生产 stamp。`node --import tsx --test tests/runtime/memory.test.ts tests/config/load.test.ts` 的保存输出为 `.cache/live/memory-protocol-targeted-tests.txt`：11/11 通过，无失败/跳过。全部归 O-P，不是外部生产 R-P。外部部署的 TLS、真实凭据、服务端 ACL/scope 强制隔离及 SLA 仍 U；provider 切换只从本地摘要在后续会话同步，不迁移原始 transcript，也不删除旧 provider 数据。

### 历史漏记补齐：不改变当时版本或覆盖失败

| 场景 | 已有真实事实与原始证据 | 保留边界 |
| --- | --- | --- |
| B05/B06/T14/FSH01 | `.cache/live-validation-run.json` 的 concurrentRequest/concurrentToolCalls/concurrentObservations：00:18:29 UTC飞书入站done，3次task_create(newProject=true)，3个项目的任务/群/远端task与4名started参与者；`.cache/live/concurrent-ac-products.json` 另证A/C独立产物及唯一初始回执 | 三项目创建正常分支R-P；不关闭LIVE-001原HTML比武输入失败，也不证明已working/blocked时再次独立请求的完整时序。A/C旧信任为人工处理，不冒充自动信任 |
| B03 | `.cache/live/cli-2026-09-18T00-16-12.656Z.json` 实际doctor、debug ls/screen/transcript与缺pane拒绝，详见CLI证据 | 限旧SHA793b9006…c982c098；保留pane-width旧fail输出，但未读实际终端列数，不能推断现场过窄；E17另记诊断修正 |
| W06/W08/W10 | `.cache/live-web-session-fixed-0918.json`（00:16 UTC）真实部署浏览器：archiveAutoHistory、restorePersisted、explicitSelectionReconnect均true，恢复后服务端选中正确、390px无溢出且pageErrors空 | 补正常分支，不抹去recheck旧归档历史为空/恢复丢选中两失败；报告缺源码stamp，不写成当前版本复验；草稿/跨owner/迟到回执及T19/T20模型工具仍分验 |
| B11/N06/W16/W19 | `.cache/live/pause-interrupt.json`（01:44 UTC，9a86e40）：pause前后Codex仍working、暂停send拒绝，真实native interrupted、2条stop done、重复请求不变、resume accepted、项目文件未变 | 服务及执行器限定分支R-P，非Web按钮点击或T06模型选择；Claude当时idle，不能说两位均被中断运行中任务，也不保证任意子进程退出 |
| FSH02/FSH07/GAP09 | `.cache/live/ordinary-menu-completed.json`（01:39 UTC）8项true：本人匹配owner/group/card/nonce/key=1回调、inbox done、卡片consumed、native AskUserQuestion答案和群内结果可见；问题期间目录信任操作0 | 本次普通菜单链路R-P；非owner、过期/重复卡片、长分片及其他权限菜单仍U，不替代W20 Web审批 |
| B12/B13/N07 | `.cache/live/review-cleanup.json` 和 `interrupt-cleanup.json`（01:47 UTC）各9项PASS：destroyed/远端完成/群dissolved/受管pane缺失，close/delete done，消息与close确认早于删群；E15九任务库存再次核对最终资源状态 | 只补具体已知资源，不扩大到全部未知写入恢复或任意用户资源；旧通知文字冗长证据保留 |
| W25/GAP11 | `.cache/live/config-invalid-provider.json`（00:58 UTC）：ai_provider错误且configurationUnchanged=true | 仅非法provider拒绝分支；缺部署stamp和完整请求，不能据此关闭当前配置保存、密钥遮蔽或重启生效全流程 |

初次只读审计时未找到W27旧记录，因此没有凭单个owner绑定关闭缺口；下文新增原生Chrome和API检查提供独立证据。


### F3/B12：真实删群成功后丢回执的跨进程恢复

`.cache/live/group-delete-recovery-summary.json` 汇总两个专用测试群，baseline/fixed 分别使用独立 state 和不同的注入/恢复进程。直接连接真实飞书；没有模型请求、herdr/native 执行、远端 task 创建或 WebSocket，生产服务和数据库不变。各组在真实 DELETE 已成功之后注入回执丢失，恢复阶段只发真实 GET，不再次 DELETE。两组既有通知均在删除前确认送达，不能将这组证据当成 outbox 未知发送恢复。

- **基线 R-F 保留。** `group-delete-recovery-baseline-injected.json` 与 `group-delete-recovery-baseline-failure.json`（02:42 UTC）记录 PID21457 注入、PID21482恢复：远端群已 dissolved，本地 task 已 destroyed，但 delete-group 回执仍 uncertain，task 仍带未确认错误。旧源码 lifecycle SHA256 为 `7b4ff41dfe9aa233f770b9e9ee56e27f44e332c00bd9750ef79b48ed14a9d325`。原故障回执和错误保留在隔离数据库及快照中，没有用后续成功覆盖。
- **工作区修复后的限定恢复 R-P。** `group-delete-recovery-fixed-success.json`（02:47 UTC）及 fixed-ledger 记录 PID21767 注入、PID21787恢复。真实 GET 确认目标群 dissolved 后，delete-group 回执由 uncertain 转 done，`confirmedBy=group_status`、原 previousState/previousError 与 observedAt 均留存；task destroyed，陈旧错误清除。测试对应 `src/tasks/lifecycle.ts` SHA256 `dfbde766351bf4e2d9878cebedef35287092149115eb6d9116d25d870ac4e41d`，该次隔离实测发生于未提交工作区，随后修复已提交5d1e96f；02:58 UTC新部署已核对，但旧生产ab79cc0不包含该修复。
- **资源与重放边界。** summary 和两份 ledger 的最终 GET（02:48 UTC）确认两群均 dissolved；每组全流程 DELETE 恰好一次，forbiddenCalls 为空，allOutboxDelivered 与 allMessagesAcknowledgedBeforeDelete 均 true。这是删群 lost acknowledgement 的跨进程恢复实证，不扩展为消息未知发送、建群未知响应、远端 task 未知写入或完整灾难恢复通过。

此隔离检查执行时生产仍为E15的ab79cc0；后续5d1e96f部署单独记录，隔离检查的PID和源码hash不替代运行部署证据。整体目标保持 active。


### W05–W10/W27：原生 Chrome 会话管理与身份隔离

`.cache/live/web-entry-runtime.json` 的 ui/cleanup（截至02:56 UTC）固定真实运行 ab79cc0，使用原生 CUA Chrome，无 HTTP mock。实际创建并重命名A会话、观察未发送草稿，切换B后不显示A会话或草稿；创建B会话，刷新保留B身份与选中。A任务列表显示自身任务，B列表为空，返回A后选中自身会话且不显示B回复。记为该正常UI流程有限R-P。

在B输入 `/clear`，机械归档原B会话、创建并选中新空会话，`source:command` 的 `CLEAR_NEW_SESSION_OK` 在页面可见并ACK为delivered；随后可查看归档历史，恢复原B后刷新仍保持选中。点击显式清空按钮将这个原B的 generation 从0增加到1，仍保留旧命令和marker历史；它不是再次机械轮转。归档按钮也实际确认执行。

cleanup记录三个测试session均已归档、原主owner与A/B原选中均恢复；tasks/participants/operations hash保持一致。UI切身份会清除草稿，且返回A前已经刷新，因此只确认草稿未泄漏，不声称跨身份切回能还原草稿。本次没有console/pageerror instrumentation，未重测390px，也没有验证in-flight回复/ACK身份竞态、撤销授权或重启后的撤权失效；E15移动布局证据独立保留，不移植成本轮全覆盖。

### A1/W27：真实 Web API 的17项owner边界

`.cache/live/web-owner-scope-api.json`（02:51 UTC）17项PASS：自身session历史读取200；跨owner的history/select/rename/clear拒绝，陈旧expectedOwnerId拒绝，伪造ownerId拒绝，跨owner task.get（id/taskId两种输入）及participant.screen拒绝，未允许身份的identity.select拒绝。预期错误分别为session_not_found、web_identity_changed、web_identity_input、task_missing、unauthorized，拒绝均not_executed；state只含B对象、任务数0。

该API检查不执行身份切换、模型、执行器控制、任务动作或远端对账，配合上段实际UI切换证据使用。前后完整SQLite records均903条且hash相同（`5c3511fe8f3ad74a8c529f3c4b832ac0a3beaddc7ebd2e8e6b702bc4965881e7`），changedNamespaces为空，identityUnchanged=true。只覆盖这些请求，不扩张为所有权限和异步竞态通过。

源码与部署边界：修复源码提交为 `5d1e96f1698af95ad0fa2317b34b73441518e968`，主验收报告329项check和SEA通过；本节上述UI/API仍实际运行ab79cc0，新构建已在02:58 UTC重启核对，不能把上述旧运行UI/API冒充新版本重跑。目标仍active。


### E16 新源码部署与验证范围

`.cache/live/e16-deployment.json`（02:58:40 UTC）实际版本为 `5d1e96f1698af95ad0fa2317b34b73441518e968 / PID26077 / 构建2026-09-18T02:52:38.355Z / SEA SHA256 c165c6424037337cda912bc4471731fb7d0dfdc250c9e083148e8922b2c39ec5`，runtime/authorization ready，原 herdr 进程39037保留，主owner及原选中保持。主验收报告format/check全部329测试及SEA smoke通过；[CI 35301019616](https://github.com/hewenyu/herdr-agent/actions/runs/35301019616) 的macOS arm64、Linux x64/arm64三任务全部成功。

本节原生Chrome、owner API及W04证据仍固定此前实际运行的ab79cc0；删群故障修复是上述源码的隔离state/真实Feishu跨进程验证。部署ready不代替生产业务回归。新版本下原九任务资源清理只读复查见下文独立记录，不覆盖E15库存快照；整体目标仍active。


`.cache/live/test-resource-inventory-e16.json`（02:58:39–02:58:40 UTC）在本次重启后只读核对生产专用runId的9个已知任务：9/9 destroyed、remote completed、groups dissolved、所有已知受管panes缺失；awaitingCleanup、stillUsedForValidation、unownedValidationAgents及readErrors为空，pendingOutbox为0。两个人工故障注入样本的群在独立state及各自ledger确认dissolved，不能并成“生产11个任务”。E15原库存保持不变。后续纯文档提交改变HEAD时，实际运行产物仍对应5d1e96f，不冒充文档提交构建。

## E17：当前 CLI 与真实旧状态副本迁移

以下 CLI、迁移与飞书业务检查对应二进制 `5d1e96f1698af95ad0fa2317b34b73441518e968`，构建时间 `2026-09-18T02:52:38.355Z`，macOS arm64 SEA SHA256 `c165c6424037337cda912bc4471731fb7d0dfdc250c9e083148e8922b2c39ec5`，服务 PID26077。模型健康及工作区 helper 检查的执行方式另行说明；未部署的修复不计作该二进制已有能力。

### C01/C02/C10–C13/C16：当前二进制只读分支

`.cache/live/cli-e17-readonly.json`（03:05:30–03:05:35 UTC）28 项检查全部通过：help/version 别名、真实 debug ls、缺失 pane 的 screen/transcript、参数拒绝和 doctor 的 JSON／文本。前后生产数据库、配置和二进制 hash 相同。当时 herdr 没有运行中 agent，doctor 两种格式均 12 项 pass、退出 0；pane-width 仅为“无需测量”，不证明某个真实终端足够宽。本轮没有成功读取现存 pane 的 screen/transcript，保留旧版本该分支证据。

help 带 `--json` 仍为文本，失败输出也仍为文本，debug 成功默认输出 JSON；不将退出码正确等同于统一 JSON 协议。setup、第二个 serve、配置写入和断线恢复不在本组范围。具体历史与本轮边界见 [CLI 证据](live-cli-evidence-2026-09-18.md)。

旧 pane-width fail 的解释已修正：代码仅计算最长可见内容行，不曾取得 PTY 实际列数，短文本不能证明终端过窄。`.cache/live/cli-e17-pane-width-before.json` 保留合成 `ready` 误报 fail；`cli-e17-pane-width-fixed.json` 记录工作区 helper 将短文本、空屏和 60 列改为 unknown，较长 ASCII／CJK 内容保留估算通过。此为合成 O-P，修复源码 hash `67902a772e7bec02929c08dd7e2eb9d453e51cd23eb78f10de9dc2dbb5f1306b`，不是运行 5d1e96f 已含修复的证明，也不关闭真实终端几何检查。

### C14/C15/B18：真实旧 JSON 的隔离迁移与备份恢复

`.cache/live/migration-e17-summary.json` 汇总成功 ledger `migration-e17-2026-09-18T03-08-17.051Z.json`；脚本为 `migration-e17-audit.ts`。读取生产目录内 9 个既有迁移源文件后，仅在专用隔离副本运行当前 SEA 的 migrate。生产 JSON、配置和凭据源文件前后 hash 相同；迁移检查没有打开生产 SQLite、启动服务／WebSocket或调用模型、飞书、herdr。所有临时数据库、备份、凭据和二进制副本已删除。

真实样本为 1 位 owner、3 个 destroyed 任务、3 组 task/group 绑定、2 个 native session 绑定及 1 份对话文件。导入后为 3 tasks、3 participants、4 pi sessions、18 messages、9 message receipts、2 legacy operations、10 event receipts、18 routes 和 1 selection；逐项核对 owner、任务／群／原生会话及回执绑定，正文只在内存中比对，ledger 不保存消息或密钥。没有生成可执行 inbox/outbox、pi operations 或 turn receipts。

| 检查 | 结果与分类 |
| --- | --- |
| dry-run | R-local-copy：planned；原先不存在的 SQLite 和备份均未创建 |
| 实际导入及绑定 | R-local-copy：migrated；上述对象数量、关联和历史内容一致 |
| 再次执行 | R-local-copy：already_migrated；所有 records 不变，备份目录仍只有 1 个 |
| 备份恢复 | R-local-copy：9 文件字节及 manifest hash 一致，文件／目录权限为 0600／0700；恢复到另一空目录后再次迁移，除迁移报告路径外全部 facts 一致 |
| 已导入源被修改 | O：在副本修改 tasks.json 后拒绝覆盖，数据库 facts 不变 |
| 坏回执与既有记录冲突 | O：合成坏 deliveries 拒绝且 records 为 0；合成同标识 SQLite 记录冲突拒绝，原记录不变；两者均未创建备份 |
| 事务中途失败 | O：SQLite trigger 在 sessions 写入时注入 ABORT，此前 task/participant 写入全部回滚，records 为 0，源备份仍完整；移除故障后重迁移得到相同 facts |

共 8 项通过，其中 4 项 R-local-copy、4 项合成 O。R-local-copy 只指真实旧数据与实际二进制的隔离验证，不能称生产正在执行迁移或已完成运行旧服务的回退。全部旧任务已 destroyed、无 pending；真实样本没有独立 memory、notifications、deliveries 文件，因此未知操作、运行中任务、多 owner及这些缺失类型不计为本轮真实覆盖。未执行断电／进程杀死测试，也未恢复或核对外部资源来完成生产回退。

两次早期检查失败 ledger `migration-e17-2026-09-18T03-06-31.731Z.json`、`migration-e17-2026-09-18T03-07-05.644Z.json` 原样保留。原因是检查脚本直接读取 SQLite TEXT key，Node sqlite 在 NUL 处截短返回值，导致旧 `owner + NUL + request` key 的内存查找失败；SQLite 中完整 key 与参数查询均正常。检查脚本改用 `hex(key)` 解码后通过；这是验收器修正，不是迁移源码修改或真实数据丢失。

### 模型恢复与 LIVE-001 新会话创建复验

`.cache/live/model-health-e17.json`（03:03:35–03:03:38 UTC）使用真实 PiEngine 对 `kimi-k2.5 / openai-responses` 发起一次无工具健康请求：HTTP 200、无 assistant error、精确健康标记匹配，status=HEALTHY。E14 的503／额度耗尽仍为当时真实故障；03:03 的独立成功证明本轮已恢复响应，不能继续用旧额度问题解释以下新失败，也不据单次请求保证长期可用。

`.cache/live/live001-e17.json` 保留原核心输入“创建一个新项目，使用codex，创建一个HTML，内容是SVG绘制一个双人比武的的2D动画，不用进行测试”，另加专用项目／任务名、仅在新目录工作及等待用户验收的范围。使用新 pi session，没有重放原失败的完整历史。正式请求正文与预期精确一致且只入站一次，03:14:10–03:14:45 UTC 的记录显示 inbox done、模型调用一次 `task_create(newProject=true)`，保留“不测试、等待验收”的要求。

**创建到原生执行器启动仍为 R-F。** 新任务 `task_8482d7516c319328993601602e30262c` 已登记，新项目、远端任务和群创建回执均 done；群为 `oc_071458d11c8cf63e92ededb3cec8b32c`，远端任务为 `fe850195-fc58-4736-8673-a9d22c922628`。参与者显示名 `Codex` 被直接交给 herdr 的 agent.start，触发 `invalid_agent_name`：原生名称必须以小写字母开头且仅含小写字母、数字、连字符或下划线，长度1–32。程序又将该明确参数拒绝记为 unknown，start 回执 uncertain，任务 attention；started=false、initialSent=false，没有执行或产物通过证据。

`.cache/live/cli-e17-pane-width-live.json`（03:15:49 UTC）仅只读访问这个已授权目标：`agent.get` 返回 agent_not_found／not_executed，`pane.get` 确认 `w1E:p1` 存在于 `w1E`、目录匹配、agent=null。没有读取 screen；宽度记 unknown。这支持“工作区／pane 创建、agent 未启动”的分阶段判断，不能当作终端宽度已测或执行器已经工作。

同一 ledger 的 harnessIssue 另保留两条正式请求之前的损坏输入：CUA `typeText` 中文丢字／换行提前提交导致碎片文字，其中一条仅调用 projects_list，另一条无工具，均只澄清、未创建。这两条不是有效 LIVE-001 请求，不能把它们的未创建归因于正式完整请求。正式请求的 agent 名称拒绝是独立产品失败；原历史 LIVE-001 与本次 R-F 都保留。

截至本段最后检查，任务、群和空 pane 暂留作阻塞样本，尚未记已关闭。合法原生名称生成及错误分类正在修复；尚无修复部署后真实通过证据，不能把本轮 task_create 决策正确扩大为端到端成功。

### FSH05：任务群无 @ 的 exact `/clear` 拒绝

`.cache/live/group-clear-e17.json`（03:20:39 UTC）固定上述运行版本，任务 owner 在本次 attention 任务群发送无 @ 的 exact `/clear`。八项检查均 true：inbox done，拒绝回复 delivered，远端正文精确为“/clear 仅用于主入口私聊或 Web 聊天。”且原生飞书 UI 可见；task session、入口选中和 task status 未变，未生成模型 checkpoint。记为此任务群／owner／无 @ 分支 R-P；不扩张为无关群、其他 owner 或全部聊天权限场景。


### E17 修复部署与原生启动核验

修复源码提交为 `a6018ec1f51affce2b4160a0aea1a6e4483bcb1c`。format、check 的 345 项测试及 SEA smoke 通过；[CI 35303089613](https://github.com/hewenyu/herdr-agent/actions/runs/35303089613) 的 macOS arm64、Linux x64/arm64 全部成功。`.cache/live/e17-deployment.json` 固定运行 PID32000、构建时间 `2026-09-18T03:24:39.516Z`、SEA SHA256 `87cfcebabb4957380713b7aa57440d3d79357727f1d8d33b0b06dfd2de168505`，runtime/authorization ready；原 herdr PID39037 保留。后续纯文档提交不改变实际二进制版本。

修复保留参与者展示名；不符合 herdr 名称规则的中文、大写或过长名称，根据 pane 与完整展示名生成稳定原生名称。合法名称兼容原样，只有 herdr 明确未执行的重名拒绝才回退一次；unknown 不改名重发。响应 ID 先核对，再将 agent.start 的 invalid_agent_name／agent_name_taken 归为明确未执行。旧失败 A 的 uncertain 回执原样保留，没有手工改数据库。独立核对 herdr 源码确认这些拒绝发生在启动副作用前。

同提交还修复迁移参与者的操作归属：旧 participant ID 不必以 task ID 开头，删群恢复、未知操作提示及 retry 按 task 与其实际 participant ID 的精确前缀判定；多前缀 retry 同事务，遇 unknown 整体回滚。7 项新增回归属于 O-P，真实迁移样本均已 destroyed，不能写成真实旧 pending 已恢复。doctor 的可见内容长度只提供估算下界；短文本改 unknown，不冒充 PTY 实际列数。

`.cache/live/cli-e17-r2-native.json`（03:30:17 UTC）限定读取修复后 B 任务的 `w1F:p1`：展示名保留“编码者 Codex”，原生名 `agent-c57164c1f59d9be147331e7329` 与 pane／展示名映射一致，start 回执 done、指纹匹配。herdr 官方 pane process-info 独立确认实际 Codex 与 Node 进程参数包含 Bypass 及专用目录，cwd 一致；正文／原始 argv 未保存。此时 native working、interactiveReady=true、launchPending=false，初始投递已确认。可见最长内容 54 列时报告 unknown，符合修复后的诊断边界。

主入口机械 `/clear` 的代码与 E15 实测版本逐文件对比一致：实际正文精确匹配在模型分支之前执行，事务内归档、新建、选中并写命令回执，提交成功后才投递 `CLEAR_NEW_SESSION_OK`。E15 私聊和真实浏览器证据继续有效；本轮另补上文任务群无 @ 拒绝。普通非任务群未 @ 时按消息路由忽略，不声称所有群输入都会收到拒绝文字。模型关闭、事务回滚、队列与未知投递等故障组合仍属离线验证。


### E17 真实飞书创建、连续独立项目与唯一投递

`.cache/live/live001-e17-r2.json` 记录 B 的正式入站 `om_x100b65feb90d50b0b27104d0efd2b1e`，原始核心要求保持不变，仅追加专用名称、目录范围与等待验收。真实模型调用 task_create，项目、远端任务与群均实际创建。任务 `task_fabf92c58fbbbdcccba3c8abfa86b99e`、群 `oc_adde953d324976833bb71c73baccb0ef`、远端任务 `14132626-ac33-4210-9155-fdce9e460d54` 对应同一条链路；本次调用与执行成功不抹去最早“零工具却虚报”的失败，也不能证明已从机制上消除所有模型虚报。

`.cache/live/cli-e17-r2-completion.json` 独立核验：目录信任144为 stale_guard/not_executed，重读后的145确认成功，pi checkpoint有对应真实工具结果；原生 transcript 仅一条用户初始输入，时间03:28:57.317 UTC，全文与 participantPrompt 一致、唯一receipt、投递attempts=1且verified/acked。原生final与participant.lastOutput一致，署名群结果 `om_x100b65ff5c9a88b0b36f3582e966263` 全文与outbox一致，远端task描述与当前投影精确一致。产物 index.html 为19563 bytes，SHA256 `3730333c86323f57d3113e468469f1acb62964dd37e6c32b166fb3e34a4813f8`，源码含SVG、动画与展示名。群客户端也实际看到了署名结果和待验收通知。按请求没有运行作品测试或渲染验收，产物内容检查不等同于视觉质量保证。

第三个独立项目 C `validation-independent-e17-0918` 在03:33:30.660 UTC从主私聊发送，03:33:54.811登记任务 `task_4f7da18ad66422fd3a4760053ca5d449`。B的匹配原生final在03:33:56.474、task_complete在03:33:57.649，均晚于C入站和创建；这些时间来自匹配原生session的transcript，agent.get不提供finishedAt。创建C时A仍attention，B原生回合尚未结束，C未被两者阻塞。此证据覆盖“异常任务存在＋另一任务执行时创建新项目”，不扩张为所有working／native blocked时序组合。

C群 `oc_440e59d0945fa1a2188d766e390647f9`、远端任务 `3d8e3c9f-0ed1-4df8-90d5-831a75d68c3a`、pane `w1G:p1`。`.cache/live/independent-e17-completion.json` 20项通过：同展示名“编码者 Codex”映射到另一稳定原生名 `agent-4a4335e40b2e4f59501402c5c1`；目录信任150明确stale拒绝、151确认成功；初始投递1次，原生输入唯一。index.html源码含蓝色／橙色两个SVG圆和INDEPENDENT_E17_OK，SHA256 `f5f90a7b28c474449ead65faaeb03349f8a8a7dc4a44ca28d1dcec256ad2a1b0`；最终原生输出、task结果、唯一署名群消息与规范化后的远端描述一致。没有运行作品测试。B/C均先停review、远端completed_at=0、群normal、执行器保留，满足等待验收的要求。

### E17 完成确认与资源收尾

A通过真实应用task.action close退役失败样本；远端测试任务标完成只用于清理，不计作原业务交付成功，原start uncertain和错误审计仍保留。B由任务owner在真实飞书群无@发送明确完成确认，C通过应用Web API complete接受专用产物。三条收尾都通过应用流程执行，没有直接手改数据库或绕开herdr杀进程。

`.cache/live/e17-b-group-completion.json` 保存B唯一入站 `om_x100b65ff651c8c40b1d59faf08f1f4f`，模型实际调用一次task_action complete。herdr close done在03:41:28.814；最终pi回复03:42:25.962 delivered，解散前GET读到精确远端正文；before_group_delete通知03:42:39.637 delivered；delete-group done03:42:40.582。群删除等待本轮回复完成，关闭与回复均先于删群。解散后message GET的HTTP400不当作消息丢失，保留解散前已核对的正文；最终解散通知未抢到远端正文，只能确认本地delivered回执。

**新措辞R-F保留：** B回复开头说“任务已完成收尾”，但该时刻群仍normal，正文又说明群尚未解散；“解散指令已发出”也先于真实DELETE。程序没有提前删群，资源最终确已清理，但不能用后来的完成抹去当时措辞过满。后续提示修正与复验另记，不称本轮所有答复均正确。

`.cache/live/e17-cleanup-readback.json` 的03:42:42最终快照核对三任务均destroyed、远端completed、群dissolved、各受管pane缺失、herdr close和delete回执done；全部群outbox delivered，并且最后消息及herdr close均早于删除。B产物hash不变，任务与会话历史保留。以上三个新样本与E15/E16的原九个测试任务分别记账，不覆盖早期库存快照。


`.cache/live/test-resource-inventory-e17.json`（03:43:27 UTC）独立复查原9个加新增3个专用任务：12个群均dissolved，全部已知pane缺失，没有未归属测试agent、待发送群消息或仍保留作验证的执行器。10个remote task GET当场确认completed；另外2个GET返回HTTP400，原报告如实保留。当时错误封装未保留响应body，原因不能确定，不能写成限频、权限变化或任务未完成。`.cache/live/test-resource-inventory-e17-read-errors.json` 在03:45对两目标各串行GET一次，均HTTP200／Feishu code0，completed_at与E16一致。结合两份快照，12个测试任务均已确认清理；原失败报告及E15/E16库存没有覆盖。


## E18：收尾答复的阶段事实修正

E17群完成答复提前概括“已完成收尾”，实际群尚未解散。`runtime/prompts.ts` 与 `app/tools.ts` 的说明已加强：首句和明细保持同一阶段；任务已完成、执行器已关闭、群待解散分别说明；没有已提交DELETE的事实不声称“解散指令已发出”。当群正等待本轮回复送达时，不用反复task_get等待自己；其他unknown或错误不得一概当作只等回复。普通业务答复继续由pi模型自主生成，没有关键词替换、固定收尾文案或新增审批。

`.cache/live/e17-cleanup-stage-probe.json`（03:46:50 UTC开始）使用实际配置PiEngine、完整应用工具schema，所有execute handler替换为内存回执：先给合成review状态，再给B真实completed动作返回及destroying/groupDeleted:false查询返回。真实工具序列为task_get→task_action complete→task_get，之后结束并答复，没有重复轮询自身。答复区分“任务已确认完成”“Codex执行器已关闭”“这条回复送达后群将解散”，说明文件与历史保留，没有提前声称全部收尾或删群指令已发，也未展示completed/gone/排队回执字段。判定PASS_SINGLE_SAMPLE。

该探针没有创建Application、打开生产数据库、调用飞书／herdr或执行任何外部业务写操作；只证明这个受控回执样本的真实模型措辞，不是生产投递验收，也不保证未来所有模型回复。E17原R-F保留。此次format/check全部345项测试、类型／lint／1000行检查通过（`.cache/live/e18-full-check.log`），后续构建和部署单独固定版本，不借E17部署冒充。


E18实际部署证据 `.cache/live/e18-deployment.json`（03:51:22 UTC）：源码 `0b6966ff6509d3e7cdc0a26e5ba660d7b4e14392`，PID38264，构建 `2026-09-18T03:49:25.716Z`，SEA SHA256 `feb114e3c0fd08752533b48c85d07ff7072081e3af9b7b3824f7ccac95680069`。独立SEA smoke通过，飞书连接及授权ready，herdr原PID39037未重启；[同提交CI 35304636486](https://github.com/hewenyu/herdr-agent/actions/runs/35304636486)的macOS arm64、Linux x64/arm64全部通过check与SEA。部署成功不替代上述生产收尾回复重验。此次没有为提示验证重建已清理的群或执行器，整体逐项目标继续active。后续文档HEAD不是新的二进制stamp。
