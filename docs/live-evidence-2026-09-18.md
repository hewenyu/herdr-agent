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

本次通过只覆盖两类通知的模型措辞。真实服务后续 welcome/blocked 通知需要在带实际 participants 数据的新版本上复验。

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

从 Web 到真实 Codex 产物、飞书群结果已形成一条实际链路；原 LIVE-001 飞书入站创建失败仍保留 R-F 历史。真实飞书入站查询正在主验收进行，本文不提前记通过；也不能用 Web 链路替代飞书入站创建的完整复验。

## E06：目录信任与其余审批的产品边界

用户已明确：**保留现有 Bypass；只处理执行器仍然弹出的确认。** 不为验证而关闭 Bypass，也不重新制造被 Bypass 跳过的审批。

pi 仅通过专用启动流程识别并确认当前任务由服务端配置/绑定的工作目录信任提示，含已有项目新参与者、worktree、无项目讨论目录。受限工具需重新核验参与者尚未 initialSent、任务目录、执行身份、现场版本和原生菜单；不是给普通会话通用按键或审批能力。其他所有确认须由任务群内用户亲自选择，参与者输出和“全自动/继续”等短句不能扩大该例外。

目前实现与受限边界已只读审查；上述提示词和探针脚本 Biome 通过，`npm run typecheck` 通过。新流程的真实 Codex/Claude 自动目录信任、目标变化拒绝、未知写入不重试、确认后仅一次初始投递，以及其他菜单群内点击回调，仍按 B07/B11 单独验收，不由 E05 的既有手动信任步骤替代。
