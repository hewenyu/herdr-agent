# E42：恢复真实桌面后的继续验收

状态：**进行中，完整目标未完成**。2026-09-19，主验收已重新取得飞书/Chrome 桌面并恢复真实交互。14:00 UTC 的阻塞保留为历史；恢复后已继续完成下列限定交互。最迟在 14:52:22.833 UTC 已有本轮真实主私聊恢复请求入站；本文不推定更早的精确恢复时刻。

15:13 UTC 后桌面再次不可取得：主验收调用 Feishu/Chrome 各返回 `cgWindowNotFound`；应用列表仍显示 running，浏览器连接器仍报 `unsupported Codex auth method: apikey`。A 卡片只实际看见、尚未点击。已异步请求用户恢复窗口，后续真实 UI 步骤等待；只读观察、诊断修复与离线检查继续。这是本次恢复后的首次入口阻塞，不据此宣告整体停止。

主目标工具仍返回 `blocked`，工具没有恢复参数；这是主验收报告的目标记录限制。用户已明确继续，已有授权范围内的验收继续执行。PR [#48](https://github.com/hewenyu/herdr-agent/pull/48) 仍为 draft，必要验收完成前不合并发布。

## 运行边界

- 本轮开始时源码分支为 `fix/multi-project-live-validation`，HEAD `3cd5367`；该 HEAD 的后续改动仅为文档。
- 本轮真实交互验收时，生产运行是 `a3978c097aba137e857a2af5d39eb538d53dbde2` 构建的 `0.3.14-dev` macOS arm64 SEA，路径 `build/e39/herdr-agent`，`dist/herdr-agent` 为同一产物。
- SHA256：`cb9a000ab4bd6e19aef35702353a06878d1ea1543f553a2f7c3df5fdbbbc242d`。部署证据见 [E39](live-evidence-e39-source-approval.md) 与 `.cache/live/e39-deployment.json`；文档提交不视为新二进制部署。
- 正式 npm 版本仍为 `0.3.13`。本记录不声称新的发布已完成。

## 主私聊恢复非当前 pi 会话

入口为真实飞书主私聊，消息序列 `177`，入站 ID `om_x100b65de54a948a0b3d48f93efc94ce`，时间 `2026-09-19T14:52:22.833Z`。用户原文：

> 恢复归档的主入口 pi 会话 MYRIX-E39-S2-R，保留它原来的 ID 和历史；不要选中它，当前继续使用 MYRIX-E39-S1。不要操作任何任务、群和 herdr 执行器。简短回复恢复结果和当前会话名称。

真实 checkpoint 记录 `sessions_list({archived:true})` 后调用 `session_restore`，目标为原 S2-R ID `s_0da1de4b-b5d8-495a-a834-1e1155d7334d`。列表返回该会话 `archived:true`，恢复工具返回 `archived:false`、`generation:0`，原 `createdAt` `2026-09-19T13:12:17.636Z` 保持，操作状态为 `complete`。此回合仅含上述两个会话工具，没有任务、群或执行器写工具调用。

14:55:04.114923 UTC 的限定只读生产快照确认：S2-R 使用原 ID 且未归档；当前选中仍为 S1 `s_90f47592-bc08-43af-8598-e5e788b3c723`。入站为 `done`，turn receipt 为 `finished`，最终回复为 `delivered`，回执 ID `om_x100b65de557ed0a0b4c427710f0eae6`。已投递回复原文：

> 已恢复 MYRIX-E39-S2-R（原 ID s_0da1de4b-b5d8-495a-a834-1e1155d7334d，历史保留），未选中它；当前继续使用的会话是 MYRIX-E39-S1。未操作任何任务、群和执行器。

本项确认原会话恢复、选择不切换及回复投递。回复中的“历史保留”不能自行证明所有历史字节未变：历史 hash 基线在恢复之后的 14:54:04.463014 UTC 才捕获。快照中的 9 条历史记录在该基线至 14:55:04 之间存在且 hash 未变，**不能反推恢复操作前后的全量历史一致**。恢复前的独立只读观察只记录原 ID、归档状态、当前选择等元数据，未保存操作前历史 hash。

证据：`.cache/live/e42-baseline.json` 的 `preRestoreObservation` 与 `limitations`、`.cache/live/e42-baseline-captured-after-restore.json`、`.cache/live/e42-restore-complete.json`。生产查询使用 `mode=ro` 与 `query_only=ON`，按本轮相关 session/入站筛选；不以只读快照替代 UI 按钮验收。

## 切换、轮转与当前会话归档

`.cache/live/e42-session-audit.json` 对序列 177–181 作独立只读归纳：

| 入站序列 | 实际工具/行为 | 已核验结果 |
| --- | --- | --- |
| 178 | `sessions_list` → `session_select(S2-R)` | 本轮回复仍绑定 S1 且 delivered；后续选择为 S2-R |
| 179 | 零工具 marker 回合 | 新消息已绑定 S2-R，回复严格为 `E42_S2_ROUTED_OK`，delivered |
| 180 | 自然语言要求归档并开新会话，实际调用 `session_clear` | S2-R 归档、新 `s_0ef0c389-f54b-43cb-a58e-aea23bdc39ba` 创建并选中；旧会话回复 `CLEAR_NEW_SESSION_OK` 已投递 |
| 181 | 零工具 marker 回合 | 新消息绑定新会话，回复严格为 `E42_AFTER_ARCHIVE_NEW_OK`，delivered |

这四个入站均为 `done`。序列 180 由模型处理自然语言，**不计为 exact `/clear` 命令拦截复验，也不计为 `session_archive` 通过**。9 条旧历史在 14:54:04 的 canonical JSON 基线之后保持；14:57:29 在选择完成后额外采集的原始 JSON 字节 hash，只支持后续 marker/轮转/新会话阶段，不能倒推更早操作。

另有独立的纯当前归档回合：15:08:47 UTC 前置快照中，`MYRIX-E42-SB`（`s_a139bf8e-aef4-4d41-9bd5-2a108a962cc9`）为选中且未归档；真实私聊序列 193、消息 `om_x100b65de144388a0b1c86e025c92285` 明确要求仅归档当前 SB，不执行 `/clear`、不立即创建/选中其他会话，保留 A1/B1 和执行器。实际仅调用 `session_archive(SB)`，工具先返回 `scheduled:true, archived:false`。

15:10:11 UTC 完成快照中，SB 已 `archived:true`，选择指针仍是 SB，没有该回合新建的替代会话；inbox `done`、turn receipt `finished`、原 SB 回复 `delivered`，ID `om_x100b65de1528b8a0b146a38801ff6ab`。主验收在真实客户端看到：

> 已安排归档当前主入口会话 MYRIX-E42-SB，历史保留；本轮答复后生效。未执行 `/clear`，也不会创建或选中其他会话。A1、B1 及其群和 herdr 执行器保持不动，B1 继续工作。

A1 仍 blocked、B1 仍 running，两任务 `groupDeleted:false`；后续原生观察还确认 B1 工作与 RUNNING 文件。下一条 C1 请求在新的 `s_5b548b0f-76ab-4a07-9921-29093e63b4bc` 进入，未复用已归档 SB。由此通过当前会话延迟归档、原回合答复可达及后续入口选新会话的限定子项；“答复后生效”的客户端文字不用于证明网络送达先于数据库归档。

证据：`.cache/live/e42-session-before-current-archive.json`、`.cache/live/e42-session-current-archive-complete.json`、`.cache/live/e42-task-c-created.json`。归档失败、旧队列、异 owner/任务绑定和迟到 ACK 等异常仍需独立验收。

## Web 多目录项目与 A1 原失败、重试

主验收在真实 Chrome 保存 `MYRIX-E42-WEB-A` 的有序 `a/main`、`a/extra` 与默认 Claude。`.cache/live/e42-web-project-save.json` 的保存后文件回读为：主目录 `.git` 存在、附加目录 `.git` 不存在；两输入分别是 `MYRIX_E42_A_MAIN\n` 与 `MYRIX_E42_A_EXTRA\n`。这只覆盖指定双目录保存及主目录 Git 初始化，未扩展到全部 Web 配置项。

首次 A1 请求（序列 182，`om_x100b65de74b2d8a4b2429821e889df2`）先成功调用 `projects_list`，下一次 assistant `stopReason:error`，持久错误被旧实现覆盖为“模型响应失败”。没有写工具、任务或 assistant 回复，inbox `uncertain/model_failed`、turn receipt `failed`。这是独立原失败；无法从现存记录判断具体上游原因，也不能归因网络或额度。证据：`.cache/live/e42-task-watch-150115678656.json` 及后续 session 完成快照。

用户随后真实重试（序列 183，`om_x100b65de0aec28a4b3bd2948656d040`），明确先查同名任务避免重复。实际 `tasks_list`、`projects_list` 后仅一次 `task_create`，A1 `task_bac2e7ae05993c12f796ff7724ab555d`、远端任务 `18766a4c-af3c-4963-94ea-d89cb5ed1ba4` 和群 `oc_d323fba2e9664d9246131433fe8d73f4` 已建立，Claude 为 `w29:p1`。首份候选答复仍称“已按你的要求完整转交约束”，当时 `initialSent:false`；事实守卫拒绝该草稿，模型通过 `task_get`/`participant_screen` 只读恢复，最终回复明确初始投递未确认，并已 delivered，入站 `done`。这覆盖约束投递事实恢复限定子项；不能以随后真实执行覆盖首次上游失败，也不能用 Bypass 开启的回复文字证明目录信任弹窗已自动确认。

15:11:24 UTC 原生回读中，A1 已 `initialSent:true`，真实 Claude transcript 包含原文，`brief.md` 恰为两输入按序拼接的 35 字节，`briefExactConcat:true`；只有主目录新增 brief.md，choice.txt 尚不存在。原生 `AskUserQuestion` 正等待红/蓝选择。主验收已在真实飞书卡片看到红色、蓝色、Type something、Chat about this 和 Esc；**本段尚未点击**，只确认选项呈现及等待，不记人工批准/续行通过。证据：`.cache/live/e42-task-a1-current.json`、`.cache/live/e42-native-c-ingress.json`；卡片原记录 ID `om_x100b65de03c998a4b1fafaa119272de`。

## 三项目交叠期间创建 C1

B1 由真实入口在独立 SB 会话创建，任务 `task_8ed04787ede8268286ace55fc194b144`、群 `oc_b9ee3e46b688fb3a9f29d686441feae5`，Codex `w2A:p1`。C1 请求入站序列 194（`om_x100b65de117330a8b4c93e1cea0f370`）绑定新主入口会话 `s_5b548b0f-76ab-4a07-9921-29093e63b4bc`，要求新建独立项目 C、创建任务与群、只写指定 HTML 并验证。

15:11:24 UTC 交叠原生观察明确为：A1 仍在红/蓝普通确认处 blocked；B1 的 herdr agent 为 `working`，屏幕显示仍在等待 Python 稳定性检查，磁盘 `status.txt` 精确为 `E42_B_RUNNING\n`；此时 C1 的项目、任务和群均已存在。15:11:36 UTC 状态快照再次确认 C1 `task_75eec76e171df567ac26a06e2f6e4fc8`、远端任务 `f7c2c2d5-c20e-4c1f-959e-45ff84cb3c77`、群 `oc_4d1bed0b058145c674ff4b96817b1e4b`，当时为 `starting`。三个任务属于三个不同项目和 pi session。

因此仅补“三项目中一项真实工作、一项普通审批阻塞时，第三项目可登记并建任务/群”的 R-部分。该快照不证明 C 执行器已经启动、产物验收、最终创建答复或收尾通过。C 首份候选回复曾被事实守卫触发只读恢复，该快照 inbox 仍 `processing`，不能提前认定主回合成功。证据：`.cache/live/e42-task-b-running.json`、`.cache/live/e42-native-c-ingress.json`、`.cache/live/e42-task-c-created.json`。

## 后续原生执行与产物回读

15:15:11–15:15:13 UTC 的只读原生/磁盘快照及 15:16:53 UTC 审计补充如下；这部分没有 UI 输入、审批或生产写操作：

| 项目 | 原生与产物事实 | 当前资源状态 |
| --- | --- | --- |
| A1 | 原文从真实重试入站到任务快照、Claude transcript 一致；brief.md 35字节等于两输入按序拼接，choice.txt 不存在；AskUserQuestion 仍等待 | blocked；未请求关闭，群保留 |
| B1 | 原文精确传入 Codex；Python 180秒成功并有全部30秒标记；status.txt 恰为11字节 `E42_B_DONE\n` | 原生 done、任务 review；未请求关闭，群保留 |
| C1 | 原文精确传入 Codex `w2B:p1`；仅指定 index.html，277字节、严格UTF-8可读，标题为“E42 项目 C”，正文含 `C_READY_OK` | 原生 done、任务 review；未请求关闭，群保留 |

B 最终文件 SHA256 为 `a848943046ee030b59edbc8333a6acea30415f3610883d7751184ca32fc9b955`；C 为 `5711c14176c50f794d2680ad0417270505b54051273fbc40c895b1fb94d31096`。此观察时三个目录均保留，群和执行器等待收尾；后续已按下节方式清理，不能把当时的 `done` 或 `review` 解释为人工 UI 已确认完成。

并行证据可进一步补到 C 的 workspace/原生 Codex 启动发生于 A blocked、B 正在执行180秒检查的窗口。但 **C 实际业务执行 `working@296` 首次观察于15:12:52.952 UTC，晚于 B 文件15:12:38.588 UTC 改为DONE；不能声称两者业务执行时间重叠**。指定非阻塞登记/资源启动和最终产物通过，不扩展为所有并行边界验收。

另核对 SB 归档前已存在的两条消息记录，归档后均原值保留；这补当前归档子项的历史保存证据，不补恢复S2-R之前缺失的全量历史基线。

证据：`.cache/live/e42-native-audit.json`、`.cache/live/e42-native-final-snapshot.json`、`.cache/live/e42-native-c-start-window.json` 及审计引用的三份指定原生 transcript。飞书批准点击、主回复/群输出的完整可见性及用户确认后绑定资源清理仍须独立记录。

## 新诊断补丁与未完成项

针对 A 首次失败的诊断缺失，工作区已新增 runtime 结构化诊断：只保存固定分类、停止原因及实际 HTTP 状态；不保存任意错误正文、响应 header 或原始停止字符串。上游错误/中止/长度终止时，零写工具为 `not_executed`，尝试过写工具维持 `unknown`。保持 AI 普通回复完全由模型生成，没有新增固定错误回复/卡片，也没有增加请求或重试。

诊断修改后的首轮完整检查 710/710 通过；“已申请创建”修复初版为 724/724，但独立审查发现删除资源名后遗漏“现已创建成功”等省略主语断言，未部署该中间版本。补充资源承接回归后，最终 `npm run check` **733/733 通过**，包含 TypeScript、Biome 和每个手写文件 ≤1000 行检查。23 项请求阶段回归保留原 E42 候选、后续完成断言、资源和任务隔离；8 项诊断测试涵盖两协议真实适配器 fixture、超时/取消及 SQLite/WAL/SHM 敏感内容扫描。补丁不能补回首次失败已丢失的原因，也未新增固定失败回复；上述真实飞书业务结果来自 `a3978c0`，不冒充新补丁现场复验。

人工审批点击、A 后续颜色产物和 B/C 完整客户端可见性未补齐；后续已通过 API 事件与外部删群完成资源清理，详见下一节。多人业务组合及其他矩阵未验项继续保持，整体目标未完成。


## 远端完成事件与测试资源清理

窗口未恢复后，按已有测试清理授权，使用当前应用的真实飞书任务 API 完成已经产物校验通过的 B/C，生产长连接收到远端完成事件并收尾。A 仍等待普通审批，只外部解散其测试群，未代选也未标记完成。这些分别是远端 API 完成事件与外部删群链路，不冒充人工飞书 UI 完成。

15:23:59 UTC 独立回读：三任务 `destroyed`、三参与者 `gone`；三个真实群均 `dissolved`；`w29:p1`、`w2A:p1`、`w2B:p1` 均返回 `agent_not_found`。A 的远端 `completedAt=0`，B/C 分别为 `1789831276000`、`1789831277000`。生产 close 回执均为 `done`，程序关闭路径调用 herdr；没有通过测试脚本直接关闭 native pane。B/C 的四条收尾通知仅表达即将关闭/解散，删群在对应通知 delivered 之后；相关清理操作和 outbox 无 unknown/pending。没有捕获逐条 pane.close RPC 网络日志，不扩大此证据。

A 旧卡仍 `consumed:false`，已过期且群删除、执行器不存在；代码在入队和执行前均检查 `groupDeleted`。这不是旧卡真实回放验收。原 A 原文及 brief.md、B/C 产物、任务和 pi 历史均保留。只通过受保护的本机配置 API 删除三项 E42 项目登记，并恢复原 12 项项目、默认 `herdr-agent` 与 Bypass=true；不记作 Web 点击删除验证。

证据：`.cache/live/e42-remote-complete.json`、`e42-a-external-cleanup.json`、`e42-native-cleanup-audit.json`、`e42-native-cleanup-watch.json`、`e42-config-cleanup.json`。

## 最终本地部署

功能提交 `1d0d7ec07a826512f7bacac58713a19ad9a9f3e1` 已构建为 `0.3.14-dev` macOS arm64 SEA，构建时间 `2026-09-19T15:23:21.859Z`，路径 `build/e42/herdr-agent`；独立 SEA 烟测通过。`dist/herdr-agent` 已同步同一产物，SHA256 为 `429c0f002027b4ec361ea696681775c4ba8d516282b510895ef386001047a925`。

桥接服务已重启为 PID `75496`，原 herdr PID `39037` 保持。version、doctor 及 HTTP runtime/authorization 均回读通过，零活动任务、零 queued/processing inbox。原 E42 首次失败 inbox 仍保留，不把零排队误写成历史零失败。当前配置模型的独立只读 canary 返回 HTTP 200、精确 `E42_MODEL_CANARY_OK`、零工具调用；它未写生产会话或发飞书消息，不替代新二进制真实用户入口复验。

证据：`.cache/e42-task-provision-check.log`、`.cache/e42-build.log`、`.cache/live/e42-build.json`、`e42-deployment.json`、`e42-doctor.json`、`e42-ready.json`、`e42-model-canary.json`。PR #48 保持草稿，未发布新的 npm 版本；最终 HEAD CI 另行记录。
