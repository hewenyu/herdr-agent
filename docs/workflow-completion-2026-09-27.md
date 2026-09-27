# Jev workflow 合并后补齐记录

本轮已完成三套模板的真实本地验证：讨论 4 个节点、新需求 5 个节点、Bug 修复 4 个节点全部完成，报告合同与重放防重复检查通过。修复后的自动测试 **1039/1039 通过**。完整结果见下方实跑表和[证据索引](workflow-live-evidence-2026-09-27.json)。

基线：`392a0d3`（PR [#54](https://github.com/hewenyu/herdr-agent/pull/54) 已合并）。用户已在本会话明确确认“我自己验收通过了”。这是用户验收结论；此前文档中的“尚未验收”描述的是当时开发者尚未取得的现场证据，不能据此撤回用户结论，也不能据用户结论补造具体平台测试记录。

本轮保留 S3/S4 的既有边界，补充真实链路的可复现脚本，并修复对照检查中确认的交付阻塞。没有修改用户项目配置、开启常驻私聊入口、发布或重启服务。

## 已确认并修复的交付阻塞

一个讨论产物放在任务看板中：独立开场产生 v1，交叉评审修订为 v2，并分别提交文件引用。看板位于仓库外，因此两次产物对应同一个代码版本。旧实现遍历这两条历史记录，要求当前文件同时匹配 v1 和 v2 的 hash，导致报告永远无法交付。

修复后，交付检查按规范文件路径选择当前代码版本最新采集的引用，再读取真实文件核对 hash。原始产物记录仍完整保留；没有删除旧证据或取消交付前检查。回归覆盖修订后重启、只交付一次、历史记录不变，以及最终选择后文件被修改或删除时仍拒绝交付。修复前，新用例实际失败（交付次数 0，预期 1）。

## 真实 Jev 入口分类

重跑入口：

```sh
node --import tsx scripts/live/jev-ingress-probe.ts
# 可选：--state-dir /absolute/config-state
```

脚本仅在内存中为合成输入启用入口分类，使用本机已有 Jev 凭据，证据写入独立临时目录。不创建任务、不发送消息、不运行 pi 后备、不读取真实私聊。关闭入口和冻结路由回读的检查使用拒绝联网的 transport，验证它们确实不调用 API。

本次 `jev-1.13.0`、门槛 `0.8` 的结果见[原始脱敏证据](jev-ingress-live-evidence-2026-09-27.json)：

| 合成输入 | intent | 项目 confidence | 实际路径 |
| --- | --- | --- | --- |
| 明确创建讨论 | discussion，0.91 | 0.54 | 回退 pi |
| 明确创建新需求 | development，0.89 | 0.71 | 回退 pi |
| 明确创建小 Bug 修复 | bugfix，0.91 | 0.47 | 回退 pi |
| 明确禁止建任务、依赖上文、自定义五人安排、未登记项目、引用中的伪指令 | other；最后一项低置信度 | 未调用 | 回退 pi |

8/8 未产生错误创建路径，关闭入口和冻结路由回读均未联网；5/8 与预期分类路径一致。三个明确建任务正例均因项目置信度不足回退，说明默认门槛下快捷入口的命中率仍有限。没有通过降低门槛把低置信度包装成成功；这八条样本也不是中文总体质量或成本评测。

## 本地三模板验证入口

```sh
node --import tsx scripts/live/workflow-acceptance.ts --template all
# 本机已有 bypass=true；按既有配置显式运行：
node --import tsx scripts/live/workflow-acceptance.ts --template all --timeout-ms 900000 --bypass
```

使用真实 Jev、pi 和 herdr 参与者，逐个运行讨论、新需求和小 Bug 的极小合成任务。项目、SQLite、看板与验证输出均位于本轮临时目录；真实项目与常驻服务不参与。最多两个原生参与者，加监督代理不超过三个。外部平台操作直接拒绝，本地报告回调明确标注 `local_callback`，不能算飞书送达。

启动目录信任复用产品已有的 `DirectoryTrust`，仅对脚本创建的任务目录执行同样的菜单、目录和执行器身份校验；其他原生审批或无法确认的执行结果保留诊断，不自动答键或重发。只清理脚本本轮创建的执行位置，保留临时目录中的报告与回执用于复核。脚本的等待期限是手工验收进程的保护，不是恢复任务轮数或总时长预算。

本机 Codex CLI `0.157.1` 在该新目录的默认权限下以 `--add-dir` 启动，会直接报 `effective permissions do not allow additional writable roots`。这是本次非 Bypass 运行的实际失败，不能列为通过；相关权限说明见 [OpenAI 官方配置参考](https://developers.openai.com/codex/config-reference/)。本机 TOML 和 SQLite 中原有任务 Bypass 均为 `true`，后续运行显式使用 `--bypass` 匹配这个既有配置；脚本默认仍为 `false`，没有改写用户配置或在失败后自动切换权限。

首次启动还暴露了两处产品兼容问题：目录确认仍使用 Responses `tool_choice=required`，与本机模型网关的既有兼容问题相同；Codex 新版 `Folder access` 目录信任菜单未被识别。相应修复仍保留“只提供目录确认工具、实际回执才算成功、未知结果不重放”的边界，以及新菜单的完整目录和精确模板校验。

随后真实 Claude Code `2.1.283` 已收到任务并作答，但长粘贴在原生用户记录中被包为单个 `pasted_content` 块，导致严格输入比较未能确认回执。现场 payload 与持久任务书逐字一致。本次仅在 Claude 输入回读比较时支持该精确原生外壳，保留原始 JSONL、任务正文及 receipt、session、cwd、operation fingerprint 校验。多块、嵌套、额外文本、错 ID、正文改动均不视为送达。

原生回读与 TaskService 整合回归证明：未知输入可据真实记录恢复为已送达，收取参与者输出，重启不重发。独立开场的现有事件恢复链无需修改；新增回归证明第一位输入到达后只补派原决策中尚未发送的第二位，保留原 operationId。用户暂停、关闭、修订或回执仍未知时不会补派。

补派后的 Codex 也实际作答，但 herdr `0.8.0` 没有提供原生会话 ID，已有回执找回只覆盖 Claude，因而仍无法收取 Codex 输出。本轮为 Codex 补充同等回执找回：核对原生 `session_meta`、文件名会话 ID、完整 cwd 和唯一 user 记录中的投递标识；不按文件新旧猜会话，不以 assistant 回显或终端截图确认。扫描受读取预算约束，未完成的唯一性检查不构成送达证明。

验收脚本同时纠正自身判据：真实参与由本轮执行位置、已确认并应用的投递及对应原生输出共同证明，会话 ID 不是唯一途径；每次保存 `participant-evidence.json`。重放除检查事件数量外，还比较实际 `send` 调用次数。讨论 fixture 只要求保留确实存在的 README 和 AGENTS 文件，避免引入“缺失测试文件”的假问题。

状态块任务说明同步明确三项协议要求：未运行命令时省略 `command`，不能填空字符串；逐字复制本轮的三个归属字段；`evidenceRefs` 使用已登记 ID 或产物路径，不能把看板中 `outputs/<id>.md` 的阅读路径当作 outputId。真实输出曾因空命令或未登记引用被拒绝；本次没有放宽证据校验，也没有覆盖用于历史回执核验的旧模板。

三模板实跑继续发现：Codex 评审输出的 operationId 拼错时，任务已收取最终输出且参与者结束，旧选择器却一直忽略该块，节点永久保持 dispatched。修复将本轮未知或伪造归属的输出送入既有严格解析，记录为协议错误并转入返工候选，绝不视为完成；有可核验旧委派归属的迟到输出仍不影响当前节点。该现场还实际走过 Jev 选择返工、低置信度后 pi 在同一候选集选择交叉评审，两种来源均有原始决策日志。

本轮还保留了两类非产品成功记录：规划模型曾返回 `model_failed`，该轮没有派发输入；验收脚本曾把可自动回读的临时投递未知误判为终止错误，已按持久 dispatch 状态纠正。后续新需求样例的“使用已有两位参与者完成独立评审”存在歧义，被理解为需要两位独立评审者；实现者不能自评，流程因此选择 `user:blocked`，没有强行交付。样例现已明确“一位实现，另一位独立验证与评审，只要求一位独立评审者”，保留原失败任务与用户裁决记录，不改写为通过。

## 三模板真实运行结果

以下是修复后分别完成的成功运行，不是一次 `--template all` 全部通过。讨论来自该次批量执行的第一套；澄清 fixture 后，新需求和 Bug 修复分别执行。模型为 Jev `jev-1.13.0`、pi `kimi-k2.5`（`openai-responses`）；原生参与者为 Claude Code `2.1.283` 与 Codex CLI `0.157.1`，通过 herdr `0.8.0`、protocol 19 执行。

| 模板 | 时间（2026-09-27，UTC） | 完成节点 / 实际 send 次数 | 结果与证据 |
| --- | --- | --- | --- |
| discussion | 08:27:24–08:31:17 | 4 / 4 | 独立开场、交叉评审、报告完成；项目保持只读，未执行配置验证。[详细证据](workflow-live-discussion-2026-09-27.json) |
| development | 08:40:18–08:45:52 | 5 / 5 | `sumEven` 实现、独立验证与评审、报告完成；配置命令 `node --test verify.test.mjs` exit 0。[详细证据](workflow-live-development-2026-09-27.json) |
| bugfix | 08:47:24–08:52:48 | 4 / 4 | 复现 `clamp` 错误、修复、独立回归、报告完成；修复前测试 exit 1，修复后配置验证 exit 0。[详细证据](workflow-live-bugfix-2026-09-27.json) |

三个成功任务的节点均为 `attempt: 1`，每套 14 项适用检查全部通过。每个任务只触发一次本地报告回调，并停在 `awaiting_acceptance`；没有模拟用户接受报告。重建 orchestrator 后继续处理，真实 `send` 次数、报告回调次数和原生启动次数均未增加。每套原生参与者峰值为两位，本轮创建的全部执行位置已关闭。

讨论流程实际采用过 rule、Jev 和 pi 三种决策来源；新需求与 Bug 流程记录了真实 Jev 分布及低置信度后 pi 在合法候选集内选择的结果，没有调整置信度门槛。[证据索引](workflow-live-evidence-2026-09-27.json)还保留了早先 Jev 选择返工的记录和歧义样例的用户裁决记录。后者是 pi 选择 `user:blocked`，不是连续 N 轮未变化触发的僵局检测。

Bug 修复前的失败由 Claude 原生 `tool_result` 中的 `ERR_ASSERTION`、`fail 1` 和 `EXIT=1` 共同确认，针对的是 `node --test verify.test.mjs`。原实现令 `clamp(3, 1, 5)` 返回 1，预期为 3；最终实现使用 `Math.min(max, Math.max(min, value))`。修复后 myrix 的配置验证保存了 stdout、stderr 和退出码，另一位参与者完成独立回归。

原始证据根目录是 `/private/var/folders/vh/fv9dxg9s01v0s6y0bj600ztm0000gn/T/`，三个成功任务的相对目录如下；详细证据中的 `report.path` 给出实际报告位置，报告 hash 已重新读取文件核对。

- `myrix-workflow-acceptance-QS6fzf/discussion`
- `myrix-workflow-acceptance-NKy6oM/development`
- `myrix-workflow-acceptance-CKLtxN/bugfix`

每个目录保留 `result.json`、`workflow.json`、`events.json`、`decision-log.json`、`verification.json`、`participant-evidence.json`、`native-tool-audit.json`、本地摘要卡片、报告回调及 SQLite 状态。仓库中的 JSON 保存可评审的结果与决策快照；原始临时目录只在本机保留，不保证长期可用。

这些结果证明隔离微型项目中的真实本地执行链，不涵盖本轮未执行的飞书入站与送达、常驻服务上线或发布。私聊入口仍关闭；入口样本的低置信度回退结果按前文保留。

## 自动验证

本轮修复后的完整测试：`node --import tsx --test --test-concurrency=2 tests/**/*.test.ts`，**1039/1039 通过**，无跳过，耗时约 193 秒。日志在本地 `.cache/jev-workflow-completion-final-tests.tap`。使用并发 2 避免安装器测试与大量并发测试争抢资源，没有跳过或修改失败断言。

`npm run typecheck`、`npm run lint`、`npm run check:lines`、`npm run build` 和 `git diff --check` 均通过。行数检查覆盖 320 个源文件，每个不超过 1000 行；构建仅生成本地制品，没有部署或重启服务。

最终证据核验确认三份报告 hash、实际派发次数及原始结果一致；5 份新增证据 JSON 均可解析，文档本地链接有效。36 个变更文件均不超过 1000 行，未匹配本机配置凭据或 Jev key 格式。本轮补齐与修复从分支 `feat/jev-workflow-live-acceptance` 提交 PR 评审。
