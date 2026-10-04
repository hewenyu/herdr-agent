# 全仓代码健壮性复盘（2026-10-01）

## 本轮结论（2026-10-02）

本轮全仓审计、12 组已确认问题的定向修复及首轮主代理复核已提交至 [Draft PR #70](https://github.com/hewenyu/herdr-agent/pull/70)，提交为 `a00e11d`。该提交的三平台 CI 已全部通过，**但本地完整检查仍可失败，尚不能宣布问题明确解决或发布就绪**。

| 验收层次 | 当前证据及适用提交 |
| --- | --- |
| 静态检查 | `a00e11d`：文件长度 567 文件、模块边界 226 TypeScript 文件、TypeScript、Biome 562 文件全部通过 |
| 独立专项与相邻回归 | 首轮合并 455/455，含 63 个主代理权限/dispatch 验收用例；不是与全量相加的额外测试数 |
| 首轮冻结完整 `npm run check` | `a00e11d` 对应源码：exit 1；2633 项，2626 通过、7 失败、0 跳过/取消，约 840 秒 |
| 三平台 CI | `a00e11d`：macOS ARM64 2633 通过；Linux AMD64/ARM64 各 2632 通过、1 项既有 Darwin-only 跳过；均 0 失败，SEA 构建与 smoke 全通过 |
| 后续本地完整对照 | 同一 `a00e11d`，文件沙箱放开后：exit 1；2633 项，2625 通过、8 失败、0 跳过/取消，约 889 秒 |
| 最新无插桩本地失败 | 7 个安装器用例（6 个外层 watchdog，1 个预期 launchctl 记录缺失）；1 个工作区恢复后的验证达到原有 5 秒 deadline |
| 单项复核的边界 | 工作区失败用例不改代码/断言复跑 1/1 通过，不能替代失败的全量结果或证明根因；初始提交 CI 也不能代替后续提交验收 |

主要实现交官方 DeepSeek；主代理补反例、拒绝不满足授权/证据保全要求的交付，并修正遗漏。OpenCode 仅使用一次只读复核。经用户授权已提交并推送 Draft PR；本地没有安装依赖、修改真实服务、放大测试超时或削弱原断言；保留开始时已有的 [`.gitignore`](../.gitignore) 修改且未提交它。

## PR 后续证据与拒绝的修法

- [初始提交 CI run 37020917001](https://github.com/hewenyu/herdr-agent/actions/runs/37020917001) 的 head 为 `a00e11d`，base 为 `544bb18`。三平台完整测试分别耗时约 268.7 秒（macOS ARM64）、210.8 秒（Linux AMD64）、252.6 秒（Linux ARM64），全部通过既有 SEA 构建和 smoke。两项 Linux 跳过均为同一项既有 Darwin `plutil` 测试，不是新增跳过。
- 最初本地失败的 7 项在这三个 CI runner 上全部通过。例如 macOS fresh-bootstrap 用例约 0.78 秒、工作区恢复用例约 0.36 秒。本地/CI 差异说明需要定位进程时序，而不是扩大 watchdog；它不证明本地根因已经消失。
- 后续本地放开文件沙箱仍失败 8 项，证明该环境变化没有消除症状。后台调查还进行了临时进程实验，尚未排除与这次对照重叠，因此不把它当作严格控制变量实验，更不据此认定沙箱是或不是唯一根因。
- DeepSeek 提议将验证 deadline 的最终判定推迟到 `setImmediate`，让稍后到达的 `close` 优先。主代理用真实 `VerificationRunner` 独立反证：配置 500ms，子进程在约 924ms 才完成，父事件循环暂停 2000ms；原实现保持 `timed_out`，建议补丁却返回 `passed`。子进程和父进程的独立单调时钟记录证明这不是仅仅“退出通知晚到”，而是实际超过 deadline。**该补丁拒绝合入**；不能通过将真正超时改判成功来消除测试失败。
- 新增 [deadline 回归](../tests/orchestration/verify-deadline-review.test.ts)，用受控时钟和不会发送真实信号的模拟子进程固定“deadline 已触发、稍后收到 exit 0”的顺序，同时保留期限内退出的正常对照。主代理检查后，和相邻验证测试合跑 15/15、TypeScript、Biome 均通过。对仓库外复制的建议补丁做 mutation test，恰好超时反例失败、正常对照通过；确认该测试确实能拦截已拒绝的修法，生产实现未改变。
- 另一次只对疑似测试进程加时序记录的全量诊断运行：原有已跟踪测试 2633 项，2632 通过、1 失败，约 416.9 秒；新增 deadline 测试未纳入这一诊断队列。它不是无插桩的冻结验收。唯一失败为 canonical readiness（loaded=true、disabled=true）：readiness 的 deadline 为第 33 秒，第 27 次探测正常返回失败；随后在 `sleep 0.5` 与下一条循环条件之间，shell 记录从第 20 秒跳至第 39 秒，正确拒绝继续探测并开始回滚，却在第 40 秒被外层 watchdog 终止。此次现场没有 probe timeout 的 TERM 记录，不能用“三次 10 秒探测”解释它。
- 主代理随后将阻塞移至一个 50ms 父进程 timer 回调，发现**原生产实现也存在独立的超时漏判**：500ms 期限、真实子进程约 924.1ms 才完成、父回调暂停 2000ms，恢复后 `close` 先于超时回调被观察到，原实现返回 `passed`。这证明仅靠 timer 回调设置 `timedOut` 不充分。[生产修复](../src/orchestration/verify.ts) 在同一起点记录单调时钟 deadline，并在收到退出后再次保守检查；主代理复跑同一真实反例，约 923.9ms 完成仍保持 `timed_out`。它不是原工作区测试失败原因的证明。
- [安装器夹具](../tests/deploy/install.test.ts) 将本就禁用的非限定 `sleep` 从 `exit 0` 脚本改为 fixture-local Bash 函数，保留其他 shell 的 PATH fallback 与真实 `/bin/sleep` 探测 watchdog；新增契约测试用失败 fallback 和 marker 证明不会启动这个多余解释器。失败断言保留 status、signal、error 及两路输出，预期 launchctl 日志缺失时也附带这些诊断。
- [工作区短验证夹具](../tests/orchestration/workflow-worktree.test.ts) 改用真实 `/bin/sh` 的 `cd -P`/`printf` 内建命令写入相同的物理 cwd、不加换行；长验证仍用原 Node release-file 轮询。所有原断言、5 秒验证期限及安装器 watchdog 保留。这些改动减少无关进程启动成本，不把改变夹具等同于证明 OS 根因。
- 后续修复的定向验收：安装/卸载 56/56，工作区及验证 30/30，TypeScript、文件长度、模块边界和变更文件 Biome 均通过。三项 deadline 测试分别固定已触发超时、正常退出、期限已过但 timer 未执行；移除单调时钟保护只破坏第三项，延迟 timer 的补丁只破坏第一项，两个 mutation 均为 2 通过、1 个预期失败。这里只是定向证据，不能替代新提交全量验收。
- 人工延迟事件循环的实验不能替代原始失败现场的子进程启动/结束证据。安装器轮询、新写可执行文件启动和嵌套预算目前仅是排查线索；这个现场中的 mock `sleep` 已被多次调用，且内容只是 `exit 0`，仍需区分子进程启动、调度、退出回收与观察本身的影响。最终效果必须由后续冻结全量检查及精确提交的 CI 验证。

## 范围与方法

- 基线提交：`544bb18`，项目 `myrix@0.3.0`；本地 Node `v24.13.0`、npm `11.6.2`。
- 保留开始时已有的 [`.gitignore`](../.gitignore) 修改；不调整依赖、持久化 schema 或产品审批策略。
- 官方 DeepSeek 负责分域审计与定向实现；OpenCode 仅用于一次 onboarding/Feishu 的只读复核，修复仍交给官方 DeepSeek。主代理逐项阅读实际 diff、检查测试断言与错误语义，再做回归。
- 检查重点：并发读改写、崩溃恢复、不可重放副作用、授权/身份过期、取消/超时、畸形输入、文件安全和安装回滚。
- 所有复现与回归使用临时目录、假 API、假 launchctl 或测试 Unix socket；没有调用真实飞书/herdr 服务，也没有安装、卸载或重启真实服务。
- 这是按模块和风险边界组织的代码审查及离线验证，不代表形式化证明、每条代码路径覆盖或真实服务端到端验收。

## 模块覆盖

| 模块 | 重点 |
| --- | --- |
| core / storage | 错误 outcome、mutex、原子写、锁、持久化与恢复证据 |
| runtime / tasks | 调度与取消、审批状态、任务所有权、unknown 副作用不可重发 |
| app / orchestration / projects | action 边界、生命周期、工作流恢复、报告回执、工作区验证 |
| transcripts / migration | 文件输入、游标/身份、迁移保全与失败语义 |
| config | TOML 校验、并发保存、批量保存、未知字段和权限保留 |
| herdr | RPC 请求边界、连接/写入时授权、原生身份/屏幕复核、回读与 unknown |
| feishu / onboarding | 官方 host、身份核对、请求 deadline、取消、授权轮询和 SDK 生命周期 |
| web | loopback、Host/Origin/CSRF、请求体上限、SSE、文本渲染、报告确认 |
| cli / deploy | 参数与退出、启动停止、诊断只读性、安装前置检查、回滚与卸载 |
| scripts / CI | 打包外部依赖边界、完整性、发布前置检查、CI 静态检查和平台矩阵 |

各分域审计结果和最终回归结论将在复核结束后记录到下方。

## 已确认问题及修复

### 1. 配置并发保存丢更新；AI/tasks 分两次落盘

- 原因：[保存函数](../src/config/save.ts) 在异步写入前读取旧快照，并发调用会各自覆盖另一个调用的更新。[模型配置 action](../src/app/actions.ts) 又将 AI 配置与 tasks.enabled 分两次写入。
- 主代理临时目录复现：并发写 AI 和 tasks，最终 TOML 只留下 tasks。
- 修复：按规范化绝对路径使用现有 `KeyedMutex` 包住完整 read–merge–write；新增批量 helper，模型配置一次原子替换写入两个 section，保留原单段 API。
- 回归：[配置保存测试](../tests/config/config-save.test.ts)、[action 测试](../tests/app/model-config-save.test.ts)；主代理额外补充路径规范化与同键后写优先断言。
- 主代理 review：现有浅合并语义、未知字段和 0600 权限保留；锁由已有实现 finally 释放。特别澄清：rename 后目录 fsync 失败可能在整批数据已可见时抛错，不承诺“报错必然未写入”。
- 范围限制：进程内、同一规范化路径；不解决外部编辑器/跨进程竞争或符号链接别名。

### 2. 原生审批缺失 socket.write 时的最终授权/有效期检查

- [answer 路径](../src/herdr/control.ts) 完成最后一次异步屏幕检查后即检查授权，但没有将同步校验交给 transport 的写前回调。建立连接期间的授权变更/过期不能拦住待发按键。
- 修复：在真实写入边界同步复核授权、取消与时间；写前拒绝为 `not_executed`，尝试写入后的不确定性继续为 `unknown`，不增加自动重发。
- 主代理已复核 source、transport、审批调用方及真实测试 socket：[写入边界回归](../tests/herdr/approval-write-boundary.test.ts) 中，撤权/过期在旧实现上失败；新实现拦截且无按键送达，正常按键与写后回读 unknown 语义不变。主代理另补取消发生在 connect 期间的测试，5/5 通过。实现者既有 herdr 相关回归 66/66 通过。

### 3. 取消原因绕过领域错误分类

- [onboarding HTTP](../src/onboarding/http.ts) 的预取消检查在 try 之外；[Feishu 启动](../src/feishu/platform.ts) 的连接等待阶段会抛出原始 caller abort reason。
- 已用默认 abort、Error 和字符串 reason 离线复现；应分别返回稳定的 `authorization_aborted` / `feishu_aborted`，而不是内部错误。内部 stop 的 `feishu_stopped` 语义必须保留。
- 主代理进一步复现：`abort(false)`、`abort(0)`、`abort("")` 在连接等待阶段使 `start()` 成功 resolve，因为通用 finish 用 truthiness 判断错误。必须在 abort 入口构造明确的领域错误，不能只在 catch 中处理原始 reason。
- 已复核修复：所有取消入口构造稳定领域错误；内部 stop、连接失败/超时的分类保留。onboarding 仍保留保守 `unknown`，Feishu 启动取消为 `not_executed`。
- 主代理补充 review 修正：即使取消 reason 本身是 `OperationError`，也不能原样透传其 code/message；用异常与 `signal.reason` 的身份比较先规范化，独立的已分类 HTTP 错误仍保持原分类。新增请求阶段/读 body 阶段回归，修正前 7/8、修正后通过；另验并发取消不会覆盖明确的 HTTP 403。
- [取消边界测试](../tests/feishu/cancellation-reasons.test.ts) 覆盖 false/0/空串/null/default × 启动前/握手中共 10 项；实现者的测试另外覆盖 Error/字符串、身份读取和内部 stop。

### 4. 远端授权轮询时间溢出

- [注册流程](../src/onboarding/registration.ts) 只检查正有限数，没有计时器上限。超大 interval 被 Node 截断为 1ms，离线复现约 200ms 内 149 次轮询；超大 expires_in 可触发 Date/timeout RangeError，被误报为授权过期。
- 修复要求：在回调或定时器前验证/限制远端时间，同时约束 slow_down 累加，拒绝畸形响应而不制造快速轮询。
- 主代理拒绝第一版额外的固定 60 秒 pacing 上限（会把服务端要求的较长间隔缩短）；最终实现采用 Node 计时器范围与既有整体等待预算，并将本地小数 timeout 安全向上取整。
- 数字为非有限、非正或秒转毫秒溢出时，在展示 QR/创建轮询 timer 前拒绝为 `registration_response`；缺省/非数字字段保留原默认值。有限超大值按原生计时器上限约束，QR 有效期不超过本地等待预算，slow_down 累加不溢出。
- 主代理新增 [轮询策略测试](../tests/onboarding/registration-pacing.test.ts)：服务端 120 秒加 slow_down 得 125 秒、临近原生 timer 上限的累加、小数预算全部通过。将防洪测试收紧到至多 begin + 首轮 poll 两次请求，不再容忍 20 次；不扩大超时。

### 5. 卸载未确认服务退出就删除定义并报告成功

- [安装器](../deploy/install.sh) 的共用 unload helper 在卸载等待结束后仍可能返回成功；卸载路径缺少额外 `job_loaded` 检查。
- 修复要求：保留共享 helper 的回滚兼容行为，在 uninstall 调用点单独确认服务已退出；否则保留 plist 并非零退出。
- 实现已复核：仅在 `remove_job` 内新增最终检查，共用 unload、旧 label 处理及安装/回滚路径不变。主代理收紧注释与恢复提示，避免暗示停止 job 必须依赖 plist。
- [新增卸载测试](../tests/deploy/uninstall.test.ts)：实现者先在旧脚本上跑出 3 个对应失败，再在修复后 9/9 通过；覆盖卡死的 bridge/server、legacy 既有防护、幂等成功和两种卸载范围。只用隔离假 launchctl，50 次 sleep 上限未扩大。

### 6. 已由用户处理的 unknown 投递仍阻塞任务（专项验收通过）

- 分域审计用真实 Operations/orchestrator 离线复现：用户选择 abandon 后，effect 已从 uncertain 视图消失，但 [dispatch reconcile](../src/app/task-orchestrator.ts) 仍将其恢复为 uncertain，任务持续 attention；新 requirements、普通 retry/reopen/resume 不能解除，完整参与者 restart 才能逃离。
- 主代理已读对应 reconcile/runner 条件，确认只辨认 done/treat_done 的非对称逻辑。重试与审计退休也需要按实际 operation 契约处理，不能直接映射状态而绕过重试授权。
- 已交官方 DeepSeek 定向修复。验收底线：abandon 不是 sent，不能自动重发；未裁决 unknown 仍阻塞；明确 retry 仍受既有次数/身份/授权约束，审计退休不重放。首个实现子任务中途失败且未留下对应文件改动，之后缩小范围重派，未增加 OpenCode 使用。
- 后续实现正式交付了 reconcile 分类和 runner abandon/retirement 前置屏障；主代理独立运行 [dispatch 回归](../tests/app/resolved-dispatch.test.ts)，原 7 项通过，但追加 9 项全部失败：falsey 回执、failed-with-unknown、空或无审计依据的退休标记、未完成/不同任务/不含本操作的 restart、错配 done 身份及不完整 abandon 都错误解除阻塞。该交付暂不接受，已另派官方 DeepSeek 复用完整回执验证并要求匹配的完成重启证据。
- 重派交付改为在 [共用证明函数](../src/orchestration/dispatch-proof.ts) 中复用完整 durable receipt 验证；reconcile 与 runner 同源分类，abandon/已审计退休只能成为 failed，不能冒充 sent。
- 主代理交付后又复现 4 项：重启审计的 operationIds 为字符串或混杂数组时被当有效；null 抛 TypeError；已完成重启未覆盖更早的未消费 retry，实际多发一次假 native input。修正 [任务操作归属](../src/tasks/operation-scope.ts) 的审计绑定数组验证，并将已完成退休证明放在 retry 授权之前。20/20 dispatch 专项独立通过，旧 unknown 回执与未消费决议原样保留。
- 明确限制：当前显式 retry 的同身份/参数/一次性约束只在 workflow 模式验证；model 模式仍被 Leader journal 的 operation_unconfirmed 保守拦住。本轮不能声称 model retry 端到端已经打通，也不能为了推进而放宽未知日志屏障。

### 7. Leader 检查点压缩静默丢掉最后一批上下文

- [checkpoint bounder](../src/orchestration/leader-session-journal.ts) 先移除旧批次后，将 dropped 标记设为 true；最后剩余批次仍超预算时，该标记错误地阻止 remember，因此最新一整批既不保留也没有 summary/omission 表示。
- 审计复现：旧 user turn + 最新 20 个大 toolResult 超过 256KiB 时，只留下旧 turn 摘要。官方 DeepSeek 去掉错误 guard，让最后一批 shift 后始终 remember，主代理已 review：每批只记一次、循环严格减少剩余批次，pinned 强制请求/完整 call-result 配对/字节和条数限制不变。
- [强化回归](../tests/orchestration/leader-checkpoint-extra.test.ts) 先证明每个 result 自身未超 16KiB、整批超 256KiB；再断言最新/旧批次均在 summary 与实际存储消息中有表示，省略 bytes 计入最新整批。40-byte 不可表示预算仍类型化拒绝。实现者修正前 11/12、后 12/12；主代理相邻 checkpoint/context/read-boundary 回归 51/51（约 1.1 秒），Biome 和 diff 检查通过。

### 8. 部分持久化坏记录绕过类型化拒绝（专项验收通过）

- 分域审计证明：approval/uncertain card 的 expiresAt、自动审批/目录信任的 retryAt、approval_identity 的 nonce、报告 text、verify 的目录字段损坏时，可能在 Date.parse/SQLite/hash/realpath 抛出原始 TypeError。
- 这是损坏/旧记录输入边界，不是已发生生产事故。已交官方 DeepSeek 做最小读取边界检查，保存原记录并给明确领域错误。
- 主代理拒绝“跳过坏 verify 记录”或“静默重建坏审批索引”的建议：不能因无法解释记录而释放 unknown 工作区阻塞、创建重复授权或允许删除未确认报告。必须保守拒绝，等待定向测试与最终复核。
- 主代理对在制实现继续审查，新增 [自动审批权限红测](../tests/app/automatic-authority-review.test.ts) 和 [报告投递权限红测](../tests/orchestration/report-authority-review.test.ts)，12/12 复现失败：负数/小数 attempts、未知 decision.state、错配 decision.id 均放行额外 Enter；null/false/0/空串报告回执被当缺失，未知/缺失 cardState/fileState 被当可发送，实际调用 2–3 次假平台副作用。这说明只校验字段可被解引用不等于权限有效；该组仍不接受，待实现者停止编辑后补齐并跑绿。
- 随后 [verify 权限红测](../tests/orchestration/verify-authority-review.test.ts) 4/4 失败：未知 status、字符串 exitConfirmed、空 legacy cwd 未被拒绝；更直接地，key/id 错配的 running 行在重建 runner 时被复制到另一个 key 并标 unknown。新测试同时要求重启读取与既有 runner 的目录屏障读取均拒绝、原行集合不变，全程不启动任何命令。
- [两类审批卡片红测](../tests/app/card-authority-review.test.ts) 10/10 失败：consumed 为 null/0/空字符串/缺失，以及 nonce 与 key 不匹配，均能到达一次假 native answer 或未知操作 apply；native 替身仍执行 beforeWrite/assertCurrent 钩子。拒绝条件要求原始行集合不变、零副作用及类型化错误。
- [目录信任红测](../tests/app/directory-authority-review.test.ts) 最初 2/2 失败：负数或小数 attempts 都触发额外一次假模型调用，而不是保留记录并拒绝。该阶段独立权限回归共 28 条失败，证明只检查字段类型的补丁不足。
- 重派后的审批组正式交付：nonce/id 绑定真实持久 key、consumed 必须为 boolean、automatic state 限定合法枚举、预算限定安全非负整数；已有可选字段仍允许合法缺省。主代理又补出两个边界：目录决定的数组根值未类型化拒绝；审批在 native 准备期间被删除时，最终 assertCurrent 仍允许按键。追加回归先 2/2 失败，再补数组检查及最终必须存在的审批读取。
- 审批组主代理独立验收：人工卡片/最终写入 6/6，自动审批/目录信任/相邻审批和真实 Unix socket 写入边界 140/140，相关 6 文件 Biome 通过。超长自动审批测试的坏记录用例原断言移到 [独立文件](../tests/app/automatic-approval-corruption.test.ts)，原文件降至 971 行。
- 报告组复核又确认一处身份缺口：另一 event 的合法完整报告回执复制到当前 event 的 key 下，prepare 未比较 eventId，仍触发两次假平台发送。官方 DeepSeek 已补比较；主代理把断言强化为整个 namespace 保持不变，而不只检查入口 key，并独立复验。
- 主代理进一步复现 4 个身份索引反例：approval/uncertain-card 索引指向缺失目标，或指向另一 pane/operation 的合法记录，都能到达一次假 native answer/apply。现在已有索引必须绑定当前 owner/chat/目标/修订身份，不能重新创建或接纳外来记录；拒绝前后卡片与索引集合均不变。人工审批、未知卡片、报告、verify 及相邻回归独立 95/95（约 4.1 秒）。
- 随后继续检查附件决议，新增 7 个仍待修复的红测：不完整 retry、treat_done、abandon，已用过 retry 又授予 retry，以及 null/字符串/缺失历史决议的 fileHistory。前两类与已用/损坏历史仍分别触发 1–3 次假平台调用；不完整 abandon 没有新增发送，但被错误当成真实放弃。该轮报告专项先为 9/16 通过、7/16 失败；官方 DeepSeek 随后复用 [持久决议验证](../src/storage/operations.ts) 并在报告读取边界拒绝损坏历史及重复 retry，原 7 条全部转绿。
- 主代理交付复核再补 1 条协议反例：fileHistory 只会由 retry 消费生成，历史决议换成结构完整的 abandon 仍能重新授予 retry，触发 3 次假平台调用。现在历史必须保存有效的已消费 retry 决议，不能只满足通用决议 schema；兼容仅含 fileResolution 的旧历史条目。17 个报告权限用例、全部 storage/tasks、其他权限/dispatch 及相邻报告/决议回归合并独立 455/455（约 7.4 秒），TypeScript 与相关 Biome 通过。

### 9. CLI 每次运行时断线重连遗留一个 abort 监听器

- 主代理补查 [service 重连等待](../src/cli/service.ts) 发现：`Promise.race([aborted(signal), connectionFailed])` 在连接失败获胜时，不会释放失败连接的 abort 等待；once 只在整个服务最终取消时生效。
- 新增 [真实 CLI + 假连接回归](../tests/cli/run.test.ts)，用 setImmediate 保证故障发生在启动成功之后，而非握手阶段。12 次启动/11 次断线后，每次重试前监听器数量为 2、3、…、12，而不是固定基线 1；失败已复现（1/1 fail），临时目录及所有外部端口均为替身。
- 官方 DeepSeek 新增局部连接等待 helper，在失败/取消任一结束路径释放自己的监听器；共享 `aborted` 的其他调用语义、停止后重连顺序和最终解锁不变。
- 主代理 review 发现初版对 pre-aborted signal 提前返回，没有消费同时拒绝的 connection promise。新增 microtask 精确触发“启动完成 → 取消 + runtime failure → 等待”的测试，复现未处理 rejection；修正为始终先安装 rejection handler，再处理已有取消。两项新回归及全部 CLI 测试 49/49 通过，Biome/diff 检查通过。

### 10. operation 坏回执可能被当作缺失；已决议历史仍阻塞 resetFailed

- 基础分域审计复现：[Operations.run](../src/storage/operations.ts) 用 truthiness 判断前次 receipt，数据库中的 JSON `null` 被当成无记录，非幂等 perform 再次执行。这是需要优先关闭的 fail-open 边界；其他假值也需验证。
- [Store](../src/storage/store.ts) 对畸形 JSON 原样抛 SyntaxError；task 的 operations 扫描及其错误处理均依赖 entries，单条坏记录会阻塞整个扫描。跳过记录会丢失 unknown 屏障，主代理明确禁止；先类型化拒绝并保留证据，不声称修复了损坏隔离/整体可用性。
- 官方 DeepSeek 在通用 Store 解码边界将畸形 JSON 分类为 `state_invalid/unknown`，诊断不回显原始 payload；通用 namespace 的合法 null/false/0/空串/数组仍保持原语义。Operations 另验证业务回执，现有坏记录不再成为 absence，run/resolve/resetFailed 均保留原行并拒绝。
- `resetFailed` 只清除确定 failed 的记录；已决议 pending/uncertain 历史不再阻塞，也不删除其 resolution/history；未裁决 unknown、failed-with-unknown-outcome 和仍在执行的操作继续阻塞，事务回滚保证混合记录不会部分删除。
- 主代理 review 补出反例：resolve 在验证前解引用 null/非字符串 reason，仍触发 TypeError；回执 id 与数据库 key 错配或已有 retry 历史却再带 retry resolution 时，仍可执行。新增红测后补齐检查顺序、身份绑定、有限非负整数 attempt 和已用授权检查；再补“磁盘已有 resolution 但进程仍 in-flight”反例，确保 live guard 优先于已决议状态。
- [真实 SQLite 回归](../tests/storage/operations-integrity.test.ts) 检查 perform 次数为零、原始记录文本保持不变、合法缓存/冲突/确定失败重试和历史保留。主代理 storage/runtime 相邻回归 514/514；强化 deferred-intent 测试后的 storage + runtime 坏记录专项 64/64，8 文件 Biome/diff 检查通过。

### 11. transcript 缩短后 receipt 下界超过 EOF 导致 RangeError

- 基础审计复现：[reader.page](../src/transcripts/reader.ts) 在同一文件被截短后，仍用 receipt 的 afterOffset 抬高游标，再用 `size - offset` 分配 Buffer，可能得到负数。
- 官方 DeepSeek 保留 afterOffset 下界；在它超过当前 EOF 时返回空页，游标记录当前 EOF，下次继续重新应用 receipt 下界。身份变更仍走原 baseline 分支；因下界前移而失效的 skipPartial 清除，避免丢掉首条 post-receipt 记录。没有扩大 resolver/receipt schema。
- 主代理 review 澄清：真实 resolver 通常在重新核对 receipt 时已发现截短；新测试用固定已验证 source 模拟 resolve → stat 的竞态窗口，而非声称整个损坏文件仍然有效。保留原有“同 inode 截短后从 receipt 下界重新读取”的语义，不承诺不再返回截短后重新写入的同一 post-receipt 记录。
- [新增回归](../tests/transcripts/reader-offset.test.ts) 在旧 reader 上复现负 Buffer 长度；主代理补充“baseline 落在 receipt 半行，随后增长”的测试，确保首条有效输出不被 stale skipPartial 吞掉。全部 transcripts 44/44 通过（约 28.8 秒），两文件 Biome/diff 检查通过；覆盖边界以下不泄漏、截短恢复、半行、新 inode 和增量不重复读取。

### 12. runtime 操作日志的非法状态可再次授权同一个写工具

- 主代理沿存储问题继续检查 [wrapped tool](../src/runtime/sessions.ts)，发现独立的 `pi_operations` 日志只特殊处理 complete/pending，其他现有值会被新 pending 覆盖并执行写工具。交官方 DeepSeek 用真实 SessionService + 假 engine/tool 在精确操作 key 上复现；初版新增测试 25 项失败。
- 修复在 [recovery](../src/runtime/recovery.ts) 共用读取检查中只认可 pending/complete/not_executed；非法根值或未知状态返回 `state_invalid/unknown`，不覆盖、不删除、不跳过。缺失行和有效 not_executed 保持原执行权限，complete 返回缓存，pending 保持阻塞；旧记录可选的 turnId/tool/args 不变，不修改 canonical key。
- 同一检查覆盖恢复缺失 tool result、恢复前 unknown 扫描和 [deferred intent 恢复](../src/runtime/session-records.ts)。主代理额外在坏行之前放入合法 reset/archive intent，复现 helper 先写请求再因后续坏行拒绝；改成全扫描验证后才恢复请求，避免部分恢复。
- [回归](../tests/runtime/malformed-effects.test.ts) 覆盖真实 wrapped tool、恢复入口、合法旧记录和原始行保全；主代理先跑全部 storage/runtime 514/514，再跑含强化 intent 用例的专项 64/64。这里修复的是日志根结构和执行状态，不声称对所有可选 metadata 做了完整 schema 迁移或坏行可用性隔离。

## 验证记录

- 初始静态检查：文件长度、模块边界、TypeScript、Biome 均通过。
- 初始 `npm run check`：2454 项，2445 通过、9 失败，用时约 836 秒。6 项安装测试为 probe/watchdog 超时或其后续断言失败；3 项工作流测试为子进程未及时进入可取消状态或验证命令超时。启动后与部分实现修改有时间重叠，不能作为最终代码验收；失败涉及的安装/工作流路径此时未改动，另做串行复核，不直接断言为环境原因。
- 主代理串行复跑上述失败相关分支（含相邻 canonical rollback 组合）：13/13 通过，约 40 秒。没有修改失败文件、放大超时或降低断言；这只能说明存在跨次执行差异，不等于全量已绿，也没有定位具体根因。
- 主代理复核后的第一组定向回归：29/29 通过（配置保存/加载/action 15、卸载 9、审批写入边界 5），约 13 秒；包含主代理新增的路径规范化及 connect 中取消测试。
- 扩大相邻模块验证：全部 herdr/config 测试 + 模型配置 action + 卸载回归，168/168 通过，约 101 秒（包含前述 29 项，不重复相加）；实际写后 unknown、原生身份/屏幕、trust、启动、transcript 回执和传输协议均保持原断言。
- OpenCode 限定只读复核的原始定向基线：onboarding + Feishu 45/45；上述取消和数值溢出问题原测试未覆盖。
- 官方 DeepSeek 取消/轮询实现交付 71/71；主代理追加 typed abort reason 与明确 HTTP 403 的对照回归、收紧轮询次数后，onboarding + Feishu 73/73 通过（约 2.9 秒）。8 个相关文件 Biome、git diff 空白检查、安装器 bash 语法检查通过。
- 主代理补查 Web/CLI：Web 14/14 通过（约 4.1 秒，含 CSRF、报告身份/冻结正文与 rendered ACK、重启、工作区替换和 SSE 基础生命周期）；CLI 49/49 通过（约 4.1 秒），包括重连监听器与 shutdown/failure 竞态新增回归。没有验证长时间慢 SSE 消费者、恶意连接洪泛或真实网络故障。
- 主代理补查发布路径：[发布资产实现](../scripts/release-assets.ts) 的未知 ACK 不盲重试、精确 asset hash/size 校验、release/tag/commit 身份及 ID-based mutation；两个离线 release 测试文件 24/24 通过（约 1.6 秒），没有调用真实 GitHub。
- 后续整组 installer/uninstall 串行复跑仍 exit 1：至少两个 canonical readiness rollback 组合（disabled=true，loaded=false/true）触发原有 40 秒外层 watchdog，exit status 为 null，不能声称安装路径已稳定。该轮与实现者活动重叠；随后单独对 loaded=false/disabled=true 加 shell trace 的离线用例 1/1 通过（约 7.3 秒），未重现失败、未定位原因。没有修改原断言或超时，仍需最终稳定全量结果。
- 主代理存储/runtime 回归 514/514（约 6.9 秒）；进一步强化 deferred-intent 后，专项 64/64（约 0.44 秒），8 文件 Biome/diff 检查通过。
- 再次以只记录 spawnSync 结果的临时 Node hook + BASH_ENV trace 跑完整 installer 单文件：46/46，约 135 秒；未修改生产安装逻辑、测试断言或超时。未重现先前 watchdog，故仍不能宣称已定位或修复其根因。
- 主代理新增的 5 个权限边界回归文件共 28 条失败，均为预期的业务断言失败，不是编译失败；新文件 Biome、当前全仓 TypeScript 与 git diff 空白检查通过。当时仍等待实现者交付后修复与复核，不把红测留存当作实现完成。
- 恢复后旧 plain subagent 句柄一度无法通过消息/取消接口调度，主代理没有并发覆盖其源文件。随后用户确认旧任务已结束/停止并授权重派，dispatch 也收到正式停止编辑的交付；坏记录修复拆为两个独立写范围重新交官方 DeepSeek，dispatch 的 9 项新增红测另交第三个不重叠范围。待全部交付后冻结验收。
- 后续未加跟踪、未修改安装断言的 deploy 两文件复跑：55 条中 33 通过、22 失败，约 729 秒；失败仍为原有 10/30/40 秒 spawnSync watchdog 的 status=null。该轮其他实现者仍在活动，不属于最终全仓冻结检查。既不将单测曾通过等同于稳定，也不把并发负载当已证根因；已交官方 DeepSeek 单独诊断。
- 主代理收尾专项（追加附件决议反例之前）55/55：20 个 dispatch 与 35 个权限边界用例，约 3.4 秒；TypeScript 与相关 Biome 通过。其后新增的 7 条附件红测当时尚未修复，专项暂增至 62，不能把旧 55/55 作为新增用例也已通过的结论。
- 附件授权后续交付并经主代理补充历史角色约束后，当前 63 个主审查验收用例与全部 storage/tasks 等合并回归独立 455/455。当时应用/编排/存储实现者已停止编辑，仅安装器诊断尚在进行。567 源文件长度、226 TypeScript 模块边界及 diff 空白检查通过。
- 安装器诊断已交付且没有修改代码：实现者的隔离测试未重现原失败。定向实验支持“子进程启动耗时放大会累积越过 watchdog”的解释，但没有证明历史失败的根因；纯 Node 测试快、子进程测试慢也不能单独排除不同控制流。维持原超时/断言，不接受“扩大预算是唯一剩余手段”的推论。SIGKILL 后 EXIT trap 无法清理临时目录属于另一个残余风险，未做越界清理。
- 所有实现者停止编辑后，冻结完整 `npm run check` 最终 exit 1：2633 项、2626 通过、7 失败、0 跳过/取消，839678.853833ms。静态检查全部通过。6 个安装器测试仍在原 10/40 秒 watchdog 返回 status=null；工作区恢复测试得到 timed_out 而非 passed。本轮没有实现者并发修改，不能用先前的并发编辑解释这些失败，更不能用专项通过替代全量结果。
- 主代理核对工作区失败：先前取消的运行仍正确保持无 PID、无 marker，失败发生在恢复工作区后新 run 的实际命令阶段。测试配置原有 5000ms deadline，计时器在 spawn 后建立；没有找到本轮读取校验导致该命令超时的证据。未改代码/超时/断言立即单项复跑 1/1 通过（用例约 527ms，进程总约 866ms），故继续记为未定位的全量执行稳定性问题。证据保存在本机的 [冻结全量日志](/tmp/herdr-final-frozen-check-20261002.log) 与 [工作区单项复核日志](/tmp/herdr-final-worktree-recheck-20261002.log)。

已完成的主代理复跑命令（没有扩大超时或放宽断言）：

```sh
node --import tsx --test --test-concurrency=1 \
  tests/herdr/*.test.ts tests/config/*.test.ts \
  tests/app/model-config-save.test.ts tests/deploy/uninstall.test.ts

node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='canonical (bootstrap|readiness) failure|install failure preserves|a stuck replacement|pause/resume retries|verification retry resolves|workspace changes during log preparation' \
  tests/deploy/install.test.ts tests/orchestration/workflow-safety.test.ts \
  tests/orchestration/workflow-worktree.test.ts

node --import tsx --test --test-concurrency=1 \
  tests/onboarding/*.test.ts tests/feishu/*.test.ts

node --import tsx --test --test-concurrency=1 \
  tests/orchestration/leader-checkpoint*.test.ts \
  tests/orchestration/leader-context*.test.ts \
  tests/orchestration/leader-read-boundaries.review.test.ts

node --import tsx --test --test-concurrency=1 tests/web/*.test.ts
node --import tsx --test --test-concurrency=1 tests/cli/*.test.ts
node --import tsx --test --test-concurrency=1 tests/transcripts/*.test.ts
node --import tsx --test --test-concurrency=1 \
  tests/build/release-assets.test.ts tests/build/release-cli.test.ts
```

## 未通过的最终验收与后续建议

| 位置 | 失败范围 | 本轮最终结果 |
| --- | --- | --- |
| [安装回滚:643](../tests/deploy/install.test.ts#L643) | canonical readiness，loaded=true，disabled=false/true 两种组合 | 2 项触发原 40 秒 watchdog，status=null |
| [新安装失败恢复:687](../tests/deploy/install.test.ts#L687) | fresh bootstrap/readiness 失败 | 2 项触发原 40 秒 watchdog，status=null |
| [既有部署保全:728](../tests/deploy/install.test.ts#L728) | replacement bootstrap 前保留既有 canonical bridge | 原 10 秒 watchdog，status=null |
| [卡死替换恢复:779](../tests/deploy/install.test.ts#L779) | 保留两个旧 label 的私有备份且不重启 | 原 10 秒 watchdog，status=null |
| [工作区恢复验证:299](../tests/orchestration/workflow-worktree.test.ts#L299) | 取消旧 run、恢复工作区后启动新 run | 新运行 timed_out，不是预期 passed；隔离复跑通过 |

下一步应单独跟进子进程执行稳定性：保留完整失败记录，在可观察子进程生命周期和宿主调度的环境中记录 spawn、实际入口、exit/close、probe 与回滚耗时，再区分脚本控制流、进程启动或 I/O 等待。本轮尝试读取无命令参数的进程快照被沙箱拒绝，没有绕行或提权。没有证据时不扩大 watchdog、不删除失败用例，也不反复跑到偶然通过便关闭问题。

## 已知边界与未验收项

- model 模式的显式 retry 仍被 Leader journal 的 operation_unconfirmed 保守拦截；workflow 模式的一次性重试通过，不等于 model 路径已经打通。本轮没有放宽 unknown 日志屏障。
- [已有运行时复盘](runtime-reliability-review.md) 中的设计债没有在本轮擅自改语义：自动审批的语义授权范围、owner verify 执行可变工作区脚本且不是沙箱、unknown verify 的人工解锁边界、过时人工审批生命周期。
- 基础审计发现任务级资源创建（remote/group/worktree/start）的 unknown receipt 不在现有 close/input 决议卡片分类中；缺失远端 ID 时不能凭空构造 treat_done result。任务可能只能放弃/销毁重建且留下待核对远端资源。修正 resolved resetFailed 只解决已决议历史的阻塞，不等于提供了任务资源的身份绑定/人工确认入口；这一恢复功能仍待设计，不能用盲目重发替代。
- malformed operations 扫描仍需 fail-closed：类型化诊断不等于隔离坏行后让其他任务正常推进。要缩小损坏影响范围，需能证明坏记录归属且保留其 unknown 效果屏障；本轮不通过跳过坏行伪造可用性。
- 描述 PATCH 的 unknown 只有精确 readback 才可确认；审计用会规范化正文的假平台复现了长期 pending。尚未证明真实 Feishu 会作该类变换，也未建立可靠的语义等价规则，因此不采纳自动再次 PATCH/模糊比较。需要人工证据出口或明确的规范化契约，终态投影可能持续显示同步未知。
- 历史消息、回执、checkpoint/tool result 等多数命名空间缺少全局保留/清理策略，长期磁盘和扫描成本增长仍在。不能在本轮随意删除审计证据。
- NUL 分隔旧迁移键在 SQLite 枚举时可能截断；目前审计指出的 legacyOperation 无生产调用，ImportPlan 的字符串拼接碰撞还取决于 namespace 边界，未证明当前固定 namespace 的真实碰撞路径。另有 canonical 对 undefined/null 同值的问题，但无已证明的差异副作用调用；直接修改会改变既有持久 fingerprint，需兼容方案，不当作“简单修正”。
- planning 工具标为 readOnly 却保存提案属于待设计复核项：审计未证明会触发不可重放的业务副作用，不将纯持久投影一律认定为外部写权限绕过。
- onboarding HTTP 依赖生产原生 fetch 遵循 AbortSignal；故意忽略 signal 的测试替身可无限等待，这属于可选硬化，不将其列为已证明的生产缺陷。
- 真正的 Feishu/herdr 互操作、真实 launchd 行为、Linux/其他架构和发布包端到端未在本机验证。
- 不降低 unknown 防重放、审批身份检查或既有断言，也不靠放大测试超时制造通过结论。

## 2026-10-02 后续：启动窗口与冻结环境对照

以下全量对照均针对冻结的 `e92c890`，不是后续改动的验收。除明确标出的诊断选项外，保持原 292 个测试文件、2637 项测试、并发 2 和原有预算；没有通过改写环境作为产品修复。

| 启动方式 | 通过 / 失败 | 耗时 | 限定结论 |
| --- | --- | --- | --- |
| 默认 `npm run check` | 2628 / 9 | 835.9 秒 | 静态检查通过；8 个安装器失败、1 个长验证启动 marker 失败 |
| 直接 Node，无观测器，并发 2 | 2637 / 0 | 405.5 秒 | 诊断通过，不替代默认入口验收；fresh readiness 已接近 40 秒预算 |
| 单独 `npm test` | 2633 / 4 | 615.1 秒 | 4 个安装器 watchdog；外层静态检查不是这些失败的必要条件 |
| 重建 npm 风格环境后直接 exec，无存活 npm 父进程 | 2632 / 5 | 619.2 秒 | 5 个安装器 watchdog；存活 npm 祖先进程不是必要条件 |
| 仅将继承的 SHLVL 从 1 改为 2 | 2636 / 1 | 416.0 秒 | 安装器全部通过；长验证在恢复后的新 run 得到 timed_out，不是 marker 断言失败 |
| 仅加入捕获的 20 个 npm_* 变量，其余保留基线 | 2636 / 1 | 403.5 秒 | fresh readiness 在 bootstrap 后触发 40 秒 watchdog；长验证通过 |

所有行均无跳过/取消。环境捕获经过私有 nonce 校验、输出大小限制及固定文件参数校验；只公开键名和允许公开的元数据，不发布原始环境。重建的是 `npm run env` 环境并校正已知生命周期字段，未直接捕获失败 npm worker 的完整环境，因此不能声称字节级等同。相邻实验仍存在时间、缓存及负载混杂；上述结果没有证明 npm、SHLVL、某个 npm_* 键或宿主调度机制就是根因。

该冻结提交的 [三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/37037128570) 已通过默认检查、SEA 构建和 smoke：macOS ARM64 2637 通过；两个 Linux 平台各 2636 通过、1 个既有 Darwin-only 跳过。这不能追认本地默认失败，也不覆盖后续提交。

### 独立收紧命令启动窗口

官方 DeepSeek 按主代理明确的边界准备实现：单命令期限从调用 spawn **之前**开始，启动前准备/授权不计入；同步启动工作消耗预算，子进程创建后只安排剩余预算。保留关闭后的单调时钟复查、未确认退出屏障、超时优先于取消以及所有原配置限制。合同同步到 [S4 验证规格](specifications/S4-ingress-verification.md)。

主代理独立审查并修正回归测试：剩余预算反例使用一致的 99ms + 1ms 时钟推进，并在 close 能正常结束后检查 TERM 记录，避免只靠最终状态证明计时器生效。全部使用合成子进程、假时钟和受控信号替身，没有真实进程或休眠：

- 旧生产代码：7 项中 5 通过、2 按预期失败。同步 spawn 消耗 501ms 后仍被判 passed；消耗 400ms 后又获得完整 500ms 定时器，剩余 100ms 到期未尝试终止。
- 修复后：7/7。499ms 启动仍可通过；beforeStart 消耗 501ms 不侵占命令预算。
- 独立变异：把起点移回 spawn 后，恰好 2 个新增反例失败；把计时器恢复为完整预算，恰好剩余预算反例失败。每次运行后恢复源文件并核对 SHA-256。
- 四个验证/工作区测试文件：34/34，约 5.8 秒。文件长度、模块边界、TypeScript 通过；修正一处格式换行后零警告 Biome 通过。

这些是确定性的边界证据，不是测得操作系统 spawn 卡住 501ms 的声明，也没有解释或修复安装器 watchdog。该修复作为 `ecc7b0685cdaf452e7275ecb957c8d479db8e198` 提交并推送。

### ecc7b06 的完整验收及后续边界

- 本地冻结、不插桩、默认并发与原命令 `npm run check`：**2641 项，2633 通过、8 失败、0 跳过/取消，837891.1ms**。文件长度、模块边界、TypeScript、零警告 lint 全通过。
- 七项安装器失败均为外层 `spawnSync /bin/bash` 的 `ETIMEDOUT`、`SIGKILL`、空退出状态：canonical readiness（loaded=true/disabled=true）、fresh readiness、成功升级、安装失败回滚、legacy-disable 失败回滚、缺 plist 的不安全原状态、stuck replacement。不能将超时归为已执行成功。
- 两个 40 秒 readiness 用例都已打印 bootstrap 与恢复提示，各记录三个探测子进程 TERM。成功升级的 30 秒失败和安装失败路径的 10 秒失败则 stdout/stderr 全空；这些输出不足以确定具体停顿位置，尤其不能把所有失败都定位为 Node 探测逻辑。
- 工作区验证用例再次失败于**启动标记**断言（第 336 行，6222.4ms），不是 SHLVL 单变量对照中的恢复结果断言。启动期限修复没有消除这项全量失败。
- [精确 ecc7b06 的三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/37071951803) 全通过，含默认完整检查及 SEA 构建/smoke：Darwin ARM64 **2641 通过、0 跳过，365084.4ms**；Linux ARM64 **2640 通过、1 个既有 Darwin-only 跳过，256310.1ms**；Linux AMD64 **2640 通过、同一跳过，300767.7ms**。此结果不覆盖之后的工作区改动，也不取代本地失败记录。
- 后续补充分数启动耗时 400.4ms 的确定性反例：剩余 99.6ms 不得向下舍入成 99ms 而提前 TERM。扩展后 **8/8**；移回启动后起点、恢复完整预算、向下舍入计时器三个独立变异分别触发 **3、2、1** 个预期失败，随后恢复生产源文件并核对 SHA-256；补一处格式换行后改动文件 Biome 通过。生产代码未再变化。

下一步仅评估降低假 CLI 的重复 VM 启动成本，不能预先宣称根因已解决：真实外部子进程、探测边界、watchdog、所有原断言/预算保持不变；Node/npm 启动器选择用例保留原 Node 实现，其余假 CLI 若换实现，必须核对协议、文件副作用、JSON 转义与错误路径。不采用把 CLI 直接内联到测试进程的捷径。任何新改动还需独立审查、回归及冻结默认全量验收；PR 保持 Draft，不合并。

### 假独立 CLI 候选的完整验收与撤回

- 官方 DeepSeek 提出把默认独立 CLI 换成真实外部 Bash 子进程，以减少重复 Node VM 启动；生产安装器、原预算/断言和真实探测边界未改。四组 npm/explicit/alias/legacy 选择用例保留原 Node launcher，其 JS payload 与 `ecc7b06` 按字节一致。
- 主代理 review 修正了错误的 30 次生命周期上限、跨 XML 段取值以及无超时的新增合同调用；另删除“非法 UTF-8 必然被消费者拒绝”的未证明结论。候选合同与期限回归合计 **26/26**，两个夹具变异各触发恰好一个预期失败；静态检查全通过。
- 原预算、并发 2 的安装器/卸载回归 **56/56，130883.5ms**。这只是独立回归结果，不代表全量已绿，也不是跨次运行的因果性能证明。
- 冻结候选的原样 `npm run check`：**2660 项，2652 通过、8 失败、0 跳过/取消，868832.3ms**。293 个测试文件，参数摘要 `b7595ee565c903c69b8e613eedef952e128937757b1224c74ae651bd29b64d20`；运行前后核对 666 个跟踪及未跟踪文件的内容摘要完全一致。
- 失败仍是与 `ecc7b06` 同名的七个安装器 watchdog，以及工作区 readiness 变化用例的**启动标记**断言（5816.4ms），不是恢复后状态断言。成功升级、install failure、legacy-disable failure、missing-plist 四项的 stdout/stderr 全空；stuck replacement 已完成 pre-flight。这些阶段差异继续限制因果推断。
- **撤回而不提交该候选的三个夹具文件改动**：它引入两套协议实现及转义/整数/输入域维护成本，却未消除本轮全量失败。实验源文件、整合补丁、冻结清单和日志保存在本地诊断材料中；不能把失败候选包装成修复，也不能断言 Node 启动成本在其他路径完全无关。
- 保留已验证的分数期限回归与复盘记录；[安装器测试](../tests/deploy/install.test.ts) 恢复为提交前内容。下一步针对共同的延迟边界收集可区分证据，不扩大超时、放松断言或直接重复全量刷绿。

### c15f0fa：入口诊断、脚本体边界与原样基线

以下运行均冻结在 `c15f0fa340fef64071297333443cf451cb2eecdd`，保留原默认并发 2、292 个测试文件及全部原预算/断言。参数摘要为 `b54802ff7f87ae2b6ecef059ec8d91faeeb3c49a1f59ccf2557dc1ce5b18982f`。每次只启用一个诊断 preload；诊断文件不进入产品或测试提交。插桩结果不是原样验收，也不能把跨次失败数量变化解释为性能改进或因果证明。

| 冻结运行 | 总数 / 通过 / 失败 | 耗时 | 新增观察边界 |
| --- | --- | --- | --- |
| v2：BASH_ENV 入口 | 2642 / 2634 / 8 | 880.2s | 44 个匹配调用均观察到两条入口标记 |
| v3：命令调用前 | 2642 / 2634 / 8 | 881.3s | 区分 dirname、id、uname 调用前的完整标记行 |
| v4：uname 调用后 | 2642 / 2637 / 5 | 837.3s | 42/44 观察到命令返回及状态捕获后的标记 |
| v5：mock uname 脚本体 | 2642 / 2634 / 8 | 872.8s | 43/44 同时观察到脚本体及调用后标记 |
| **无插桩原样 npm run check** | **2642 / 2634 / 8** | **854.1s** | 不加载诊断，不对未采集的边界作推断 |

各次均无跳过或取消；原样运行和 v5 全量的静态检查全通过。v5 与原样运行前后分别核对 664 个仓库文件、15 个诊断/合同文件未变，且确认原样进程未继承 `NODE_OPTIONS`。原样检查不是在插桩结果上追认的通过。

诊断本身也接受反例审查：官方 DeepSeek 的 v5 初稿存在守卫失败后仍调用原生执行、丢失原 shebang、复用 fd 游标读空、放行特殊权限位等问题。主代理先以 13 项合同得到 12 个失败，再修正为 13/13；随后真实安装器回归暴露 PATH 合法前缀被误拒绝，47 项中仅该项失败。新增五项 PATH 合同先得到 17/18，再实现严格的两种布局守卫：mock-tools 首位，或规范 home/.local/bin 紧接 mock-tools 且前者不存在任何 uname 目录项，包括悬空符号链接。变更前、写入前及写入后均复核；这仍是独立系统调用组成的尽力检查，不是原子安全保证。

修正后的守卫合同 **18/18**；另有 **34 个真实独立子进程**的语义等价检查，以及严格汇总器接受 1 个有效输入、拒绝 6 类无效输入。注入保留实际路径、inode、精确 0755、原 shebang 和 echo；部分写入失败不能宣称文件未变。失败关闭且不在潜在存活后代读取期间恢复文件。修正后的真实安装器独立回归 **47/47，146697.1ms**，44 个唯一夹具均具有完整的 begin/applied/returned 三阶段记录、脚本体及返回标记；外层 watchdog 为零。此结果不代表全量通过。

v5 全量严格汇总验证 44 个唯一夹具的全部 132 条三阶段记录，无诊断覆盖缺口：

- 六个外层 watchdog 中，序号 37 的 fresh bootstrap 用例在 40 秒结束时仅观察到 `[1,2,3,4,5]`，业务 stdout/stderr 皆空。只能说**没有观察到完整脚本体标记行**；不能说 exec、解释器、脚本体或 printf 一定未进入，更不能据此断言 OS/dyld 根因。
- 其余五个 watchdog（36、38、39、40、44）均越过脚本体和调用后标记，并有后续业务输出；不能合并解释为同一个早期停顿。
- 序号 34 的 canonical readiness（loaded=true/disabled=false）在 version preflight 被终止后以状态 1 返回，11132.0ms，不是外层 watchdog；失败是缺少预期恢复消息，不能据此认定恢复已经执行。
- 第八项失败仍为工作区验证的**启动标记**断言，6262.7ms，而不是恢复结果断言。

随后首次补齐该精确提交的本地**无插桩原样全量**：六个安装器外层 watchdog，加一个成功升级用例在 status preflight 被终止后返回状态 1（28650.9ms），以及工作区启动标记失败（5787.6ms）。五个 10 秒安装器失败的业务输出皆空；无插桩运行没有脚本体标记证据，不能移用 v5 的边界结论。该结果与 v5 失败数量相同，但具体用例集合和阶段不同。

官方 DeepSeek 另对工作区启动链路做只读复盘，未证明错误的取消、持久化排序或 worktree 授权阻止启动。主代理复核确认：启动标记窗口包含命令期限之外的准备工作；该夹具路径上的两次工作区摘要至少涉及四次 git 清单子进程；tick 的错误处理记录日志，而测试 logger 默认无输出。下一步只补充失败时的有界状态快照，保持原断言/预算，区分已有记录和错误，不能把未知包装成根因。特别是 shell pid 不证明配置的 Node 已初始化，未知或缺失记录也不证明从未执行。

[精确 c15f0fa 的三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/37084450470) 已完成默认检查、SEA 构建和 smoke：Darwin ARM64 **2642/2642**，Linux ARM64 和 AMD64 各 **2641 通过、1 个既有 Darwin-only 跳过**。该 CI 不覆盖后续提交，也不抹去本地原样失败。PR 继续保持 Draft；本轮根因及完整验收仍未解决，不合并。

### 启动失败状态快照：先审查诊断，再收集证据

官方 DeepSeek 提交只改测试的候选。主代理没有直接套用：独立提取其纯函数执行两项反例，**0/2**，分别证明 code getter 抛错会阻止原 logger 转发，以及 signal 字段可产生超过 20KB 的未限长输出。随后收紧为验证夹具本地的 logger 包装及失败时快照，删除额外目录探测和未请求的完整工作流摘要；原 logger 的 receiver、参数和包括 falsey 值的抛出语义保持不变。只留最近八个错误 code，不记录日志消息或完整字段。

[工作区测试](../tests/orchestration/workflow-worktree.test.ts) 的快照只在原有启动标记检查已经失败后、finally 取消之前读取：任务 readiness、最多六条运行记录、四条事件及已采集错误 code。所有输出字段都是限长标量；各读段独立兜底。记录顺序只表示存储枚举的前几项，不宣称最新或完整历史；快照不是执行证明，也不是安全授权依据。读取或格式化失败不得覆盖原始 AssertionError。

- 同一对反例对修订实现得到 **2/2**；仓库内新增三个无外部子进程的确定性合同，覆盖 logger 转发/读取失败/原异常身份、字段限长/falsey 保留/载荷排除，以及局部不可读与空记录的区分。
- 主代理初次类型检查发现测试 spy 的 rest 参数缺少类型，补显式 Logger 参数元组后，文件长度、模块边界、TypeScript 和全库零警告 Biome 全通过。
- 期限与工作区两文件独立回归 **25/25，5685.0ms**，包括两个原有 readiness/directories 取消恢复场景。此结果不替代全量验收。
- 独立逐字反向比对确认：除类型导入、诊断/合同新增、局部 logger 连接及失败消息外，整个原测试文件内容未变。原 1000×5ms 轮询、5000ms 命令预算、真实 Node 子进程、最后一次 existsSync、所有后续断言及清理顺序保留；成功分支不读取快照。

这是失败可观测性的补充，不是启动问题修复。后续冻结全量应为 **2645 项、同一 292 文件参数列表**；不得把新增合同或诊断消息误计为原有失败已解决。

### a9a37c9：执行尝试已记录超时，而非只有前置准备未完成

提交 `a9a37c9715a40880e5a65c1a10efda7f02478ae4` 的无 preload 原 `npm run check` 再次冻结验证：664 个仓库文件、20 个辅助材料、同一 292 文件参数列表前后不变；**2645 项，2637 通过、8 失败、0 跳过/取消，853529.454042ms**。静态检查通过。七项安装器失败均为原外层 watchdog：canonical readiness（loaded=true/disabled=true）40s、fresh readiness 40s、成功升级 30s，以及 install/legacy-disable/missing-plist/stuck-replacement 各 10s。升级和 install/legacy-disable/missing-plist 的业务 stdout/stderr 皆空；两个 readiness 已到 bootstrap/恢复阶段；stuck-replacement 已输出部分 preflight。没有入口或 uname 标记，不能把此前插桩的阶段结论移植过来。

第八项仍为 readiness 变更场景的启动断言，5825.884459ms。失败前的新快照显示：

- 任务仍 `worktreeReady=true`，status 为 `review`；一个运行记录已经 `timed_out`，有 pid、startedAt/finishedAt（相差 5001ms）、`signal=SIGTERM`、`exitConfirmed=true`，无 error 字段。
- 一个编排事件已 `done`、attempts=1、无 error code；本地 logger 没有捕获错误 code。原标记仍不存在。
- 因而**本次**不能只解释成“尚未走到执行尝试的准备阶段拖慢了轮询”；已存在实际运行及超时收尾记录。但 pid 不证明 Node 初始化，5001ms 是记录时间差而非每个阶段的精确耗时，空日志 code 不证明所有路径均无异常。仍不能定位到 shell exec、Node 启动或标记写入，也不能给安装器指定同一根因。
- 主代理发现本版显示器把 `null` 和对象一起显示为 `<non-scalar>`，故旧快照的 exitCode **不能反推为 null**。补精确 null/undefined 区分合同先得到 **2/3（新增断言失败）**，再修正标量显示器并补测试数组的类型收窄；静态全通过、两文件回归 **25/25，6085.573584ms**。不修改旧快照，不宣称此诊断修订修复了启动问题。

[该精确提交 CI](https://github.com/hewenyu/herdr-agent/actions/runs/37106270714) 三平台全通过，包含默认全量、SEA 构建与 smoke：Darwin ARM64 **2645/2645，358887.497459ms**；Linux AMD64 **2644 通过/1 跳过，195050.236647ms**；Linux ARM64 **2644 通过/1 跳过，248011.536067ms**。CI 不覆盖此后诊断修订，亦不推翻同提交本地八项失败。PR 继续 Draft，不合并；下一步须增加能区分剩余阶段的新证据，不能无变化重跑或放宽预算。

### 失败现场的有界日志：候选必须经过反例审查

`c7b9ae356d0ff9f0a2c48d4c2d06d1db99c8d568` 的 [精确 HEAD CI](https://github.com/hewenyu/herdr-agent/actions/runs/37108011458) 三平台全通过：Darwin 2645 通过，Linux 两平台各 2644 通过、1 跳过，均无失败/取消，并通过 SEA/smoke。它只修订 null 显示，不证明此前本地八项失败解决。

官方 DeepSeek 给出 [日志读取器](../tests/orchestration/verification-log-tail.ts) 及测试候选；主代理没有直接套用。独立四项反例先得到 **1/4**：stdout 异常的 code getter 抛错会吞掉 stderr 观察、打开前后 inode 不一致仍读取、注入 NaN 读取数量会输出非法 bytes；正常 falsey 读取异常是通过的对照。修订后同四项 **4/4**。随后另一个红测证明 id getter 被读取三次，校验值与使用值可能不同；改为捕获一次再校验/使用。这里是诊断防御及注入 seam 的缺陷，不是已复现的生产启动根因。

- 只在原启动断言已经失败时读取已有日志；不新增探针子进程、不写子进程脚本、不改变真实 Node、5000ms 预算、1000×5ms 轮询、原断言或取消清理顺序。
- 复用已有运行记录的前六项，不再执行第二次全表读取；只选择其中首个属于当前任务、id 为小写 SHA-256、终态且 exitConfirmed=true 的记录，输出 rowIndex 关联观察。不是最新/完整历史；原 store.list 本身仍非有界 SQL。
- 路径由可信夹具根派生，持久化路径只作一致性核对；拒绝静态路径/祖先符号链接、硬链接和非普通文件。只读 no-follow/nonblocking 打开，再核对 dev/ino。**这不是对并发祖先替换的原子约束**。
- 每条流最多读取末尾 512 字节，字节转义后最多 512 字符；JSON 再编码可能扩大，不能称“最终 JSON 512 字节”。保留读取量、截取/渲染截取标识及 empty/missing/rejected/unreadable 的区别；短读只展示实际读取字节。
- stdout/stderr 独立兜底；打开的 fd 总会尝试关闭，close 本身失败不等于已释放，也不危险重试。同步文件系统操作仍可能延迟 finally 清理，字节上限不是时延上限。空日志不证明任何执行阶段；非空日志只按可归属内容解释，始终视为不可信数据。
- 仓库新增四个测试，覆盖尾部/转义上限、身份与静态路径拒绝、八类 IO/关闭场景、仅在格式化时读取一对日志、六项选择窗口及失败隔离。文件系统写入与经路径/身份核对的清理放在独立 [夹具模块](../tests/orchestration/verification-log-fixture.ts)，不混入只读读取器；不新增测试 argv 文件或额外命令行子进程。
- 首次集成触及 1000 行限制，抽离上述夹具后静态检查通过；已有测试和夹具的 AST 与 c7 基线比对一致（只排除显式审查的诊断函数、局部第二参数及四个新增测试，另行审查导入）。不是声称整文件逐字一致。

主代理最终静态检查全通过；期限与工作区两文件回归 **29/29，6116.484875ms**，无跳过/取消；其中新身份捕获断言已由红转绿。此结果不替代完整验收。

DeepSeek 披露违反“禁止 shell”的委派范围，运行过检查/格式化探测并写外部临时副本；这些自报验证不作为验收，主代理独立运行检查。此变更仍然只是失败可观测性：初次提交时计划冻结 **2649 项、同一 292 文件参数列表**，有新现场信息后再更新本地结论，PR 继续 Draft。

### `8b908ce`：真实运行日志已读到，原始全量仍有九项失败

提交 `8b908ce9a24bf2a39e4faef06299de665d0981ea` 后执行无 preload 的原始 `npm run check`。运行前后冻结核对 **666 个仓库文件、29 个辅助材料、相同 292 文件 argv** 一致；原始全量 **2649 项：2640 通过、9 失败、0 跳过/取消，874955.554041ms**，检查退出 1，冻结核对退出 0。行数/边界/类型/零警告 lint 通过。

八项安装器失败均为外层 spawnSync 超时：status=null、SIGKILL、ETIMEDOUT。canonical readiness（loaded=true/disabled=true）和 fresh readiness 各约 40s；canonical upgrade 约 30s；install failure、legacy-disable、missing-plist、both-loaded、stuck replacement 各约 10s。这是相对上次七项安装器失败的又一次现场，不以计数变化推断诊断改动导致退化，也不放宽任何预算。

工作区 readiness 用例在约 6325ms 启动断言失败。实际快照选中 **rowIndex=0**：task worktreeReady=true/status=review；唯一 run timed_out，pid=40445，startedAt=`2026-10-03T10:04:00.464Z`，finishedAt=`2026-10-03T10:04:05.465Z`，exitCode=null，signal=SIGTERM，exitConfirmed=true；唯一 event done/attempts=1；错误码数组为空。**stdout、stderr 均成功读到 size=0 的普通文件，状态 empty、bytes=0、两类截取标识 false**，不是路径拒绝、未选择或不可读。

这验证了当前真实 Service 的运行记录/路径与读取器兼容，且 null 展示修复生效；但未证明 Node 初始化、require、文件写入或 shell exec 到达哪一步。5001ms 墙钟差仍不是子进程实际运行时长；空流不证明无执行。本地失败仍未解决，下一项有价值的观察是同一失败运行的在途进程阶段，而不是再次无变化重跑。

该精确 HEAD [三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/37114387849) 全通过，包括 check、SEA/smoke：Darwin **2649 通过，289104.599541ms**；Linux AMD64 **2648 通过/1 跳过，331044.325215ms**；Linux ARM64 **2648 通过/1 跳过，248085.061062ms**。不能把这些绿灯替代上述本地红灯，亦不覆盖其后修订。

官方 DeepSeek 第二次仅用指定文件的只读工具复核，主代理逐条复判：

- 接受设备号分支覆盖不足，给原 IO 合同增加 device 变化模式；这属于测试缺口，不是已发现缺失的 dev 检查。
- 接受选择器重复 eligibility 求值的一致性问题。主代理把身份捕获断言移到选择器入口，先得到 **2≠1** 的红测，再让选择器直接把已验证快照传给内部读取器。原生 JSON Store 行不可执行 getter，因此不宣称生产泄漏或原始失败根因。
- “未断言真实路径兼容”的未来回归缺口仍存在；本次全量现场已补足当前运行确实兼容的观察，但它不是永久合同测试。假设存在另一方 realpath 规范化时的原始路径不一致会 fail closed；复核范围没有生产源码，不能把这一条件场景当成当前真实路径错误。
- 修订后静态检查再次全通过、四项独立反例 **4/4**，期限与工作区回归 **29/29，6238.274542ms**，无跳过/取消；这些不替代下一次完整验收。

### `49dbfc1`：原生观察器通过独立审查后，仍未捕获失败工作流的栈

选择器修订提交 `49dbfc1a71e124e3dc3584e281ba3b3e1e893dc4` 的 [精确 HEAD CI](https://github.com/hewenyu/herdr-agent/actions/runs/37116309749) 三平台通过 check、SEA/smoke：Darwin **2649 通过，327514.561292ms**；Linux AMD64 **2648 通过/1 跳过，297854.913305ms**；Linux ARM64 **2648 通过/1 跳过，269792.074581ms**，均无失败/取消。Linux 跳过的是 Darwin plutil 合同，不是诊断合同。此提交未再次运行原始本地全量；最近的原始结果仍是上述 `8b908ce` 九项失败。

官方 DeepSeek 的临时观察器候选没有直接启用。主代理的 17 项假进程/假时钟合同对冻结草稿、最终 498 行稿均得到 **13 通过/4 失败**：时钟异常后错误重置观察预算、十字段上限丢失关联字段、观察窗口结束时未停止尚在运行的采样器、把 watchdog 完成误计为已观察到退出。作者还披露越过“只读写文件”范围运行语法/行数检查与压缩脚本；其自报结果不作为验收。

主代理在独立临时副本修复上述问题，增加异步 lstat（仅 ENOENT 表示不存在）、晚到/重复回调隔离、身份新鲜度和监听安装失败清理；扩展到 **28/28** 模拟合同，包括最多四个目标/四次 ps/两次采样、只向自有观察子进程尝试发信号。工具未入仓库；不修改原始 Node 命令、5000ms 预算、轮询或断言。实际退出事件不等于清理保证，JavaScript 计时器不保证硬墙钟期限，异步 IO 不能强制取消，ps 身份也不是原子 PID 固定。

两次实际诊断均在运行前后核对 **666 个仓库文件、43 个辅助材料、292 文件 argv** 一致，测试以 CLI preload 激活，未使用 NODE_OPTIONS：

- 单文件 **21/21，6188.54025ms**。真实安装钩子记录了四个精确长命令启动，均在 1500ms 首次检查前退出；其余两个启动被四目标上限拒绝。零次 ps/采样，故只证明匹配及退出路径兼容，不证明实际采样路径。
- 全量 **2649 项：2648 通过、1 失败、0 跳过/取消，422986.184ms**；诊断退出 1，冻结核对退出 0。唯一失败是 fresh readiness 的 40s 外层 ETIMEDOUT：status=null/SIGKILL，stdout 已到 bootstrapped，stderr 只有 claude/codex PATH 警告，不能据此确定阻塞位置。
- 本次工作流通过。观察器匹配四个长启动；首个在约 1503ms 经真实异步 lstat 观察到 marker 存在而停止，其余提前退出，另外两个受目标上限排除。仍为 **零次 ps、零次采样**，没有同次失败工作流子进程的栈，也不能借旧的通过用例栈补足。

全量诊断使用直接 Node 命令，不是原始 npm 生命周期/嵌套上下文；添加 preload 也会扰动执行。**失败由九变一不是根因修复、不能宣称性能改善或验收通过。** 后续须先验证怎样在 npm 上下文中仅向测试工作进程加入 CLI preload，再决定是否做有新证据价值的诊断；不修改 npm 脚本或让 preload 继承到被观察的真实 Node 子进程。尾部追加 `--import` 已由独立小探针否定：它未进入 execArgv，反而把模块作为第二个测试文件，不能用这种方式进行全量实验。PR 继续 Draft，不合并。

### npm 上下文诊断与真实日志兼容性永久合同

`da0a080e1a90f7667a956d7aae54b65bc4e8e76c` 的 [精确 HEAD CI](https://github.com/hewenyu/herdr-agent/actions/runs/37126758311) 三平台 check、SEA/smoke 全通过：Darwin **2649 通过，380197.951958ms**；Linux AMD64 **2648 通过/1 跳过，301343.477268ms**；Linux ARM64 **2648 通过/1 跳过，260525.071662ms**，均无失败/取消。该提交仅记录证据，不是启动根因修复。

在私有 0700 临时目录中，通过 npm 的 script-shell 配置精确匹配原始 test 命令及 cwd/lifecycle；非目标脚本仍交给 `/bin/sh`，目标分支移除该配置后只前插 CLI preload。未修改仓库 npm 脚本、292 文件 argv、2649 项计数、并发或任何预算，未设置 NODE_OPTIONS。独立合同中的假 node **只捕获包装层参数，不执行项目测试**；实际全量使用原始 PATH 和真实 Node。

官方 DeepSeek 逻辑复核后，主代理增加实际 npm 基线对照，发现直接 `exec node` 会改变 SHLVL（2→1）及 `_`。新增环境相等断言使旧版 **7/8、失败一项**；改为保留 `/bin/sh -c 'node …'` 启动形式后 **8/8**，包括原始 argv 顺序、指定环境字段、非零退出、SIGTERM、错误 scope/shape 拒绝。没有手工伪造 SHLVL，也不宣称整个进程拓扑或所有环境完全相同。观察器在非目标模块加载时仍读临时目录元数据；零采样不代表无扰动。

该一次性 npm 上下文诊断得到 **2649/2649，0 失败/跳过/取消，1010409.160583ms**，所有静态检查通过。诊断退出 0，但原始冻结后检 **退出 1**：运行期间 HEAD 从 `da0a080` 变为用户新增委派规则的 `5fc0b48`。保留这一失败，不追改冻结基准。独立事后核对证实原先冻结的 **666 个仓库文件及 53 个辅助文件，合计 719 项哈希全部未变**，唯一新增仓库文件为 [AGENTS.md](../AGENTS.md)；包装层轨迹恰好新增五次 passthrough 和一次 matched_test。此事后内容核对不等于精确 HEAD 冻结通过。

观察器正常退出记录为 worker 65628、四个匹配子进程 71066/71376/72232/72565；四个窗口均在首次 1500ms 检查前因目标退出关闭（约 200/41/200/92ms），另两个长启动仍受四目标上限排除。**零次 marker 检查、ps、采样，没有同次失败子进程栈**。因此诊断全绿也不证明启动问题已修复，更不是原始无观察器验收；最近一次原始全量仍是 `8b908ce` 的九项失败。

随后补足第 380 行所述永久正向兼容性覆盖缺口：在 [现有真实验证测试](../tests/orchestration/verify.test.ts) 内，从 Store 的真实 `verification_runs` 行调用默认原生日志读取器，断言选择行、stdout 状态/字节上限/截取标识/转义换行尾部以及完整 stderr 对象。不增加测试、子进程或修改原有命令、fixture、期限及断言。DeepSeek 提供候选，主代理移除其“临时路径必为短 ASCII、无转义字符”的假设；`Store.list` API 已独立核对。

- 验证器、期限、工作区回归 **38/38，6264.612542ms**，无跳过/取消；570 文件行数、226 模块边界、typecheck、565 文件零警告 lint 通过。
- 独立临时路径验收分别使用引号、反斜杠、中文、换行，以及会明显扩张转义长度的路径；两次均执行同一个真实既有测试，**各 1/1**，不是新增项目用例。最初的超长路径探针在 SQLite 打开数据库时即失败，未到达读取器；不把它计作日志读取失败或宣称支持该长度。
- 独立临时副本将读取器根路径改错，真实集成断言以 **missing≠readable** 拒绝（1 项测试、1 失败）；原仓库未应用此变异。它验证新断言的敏感性，不代表整个变异套件或路径原子安全。

这些改动是测试覆盖与证据整理，**没有新的启动根因修复声明**。本地原始验收与最终精确 HEAD CI 仍须分别核实；PR 保持 Draft，不合并。

### `47c4c06` 原始验收、窄入口诊断及汇总入口纠错

`47c4c06469652b6e464c29d7d518b070cb26ef30` 原始 `npm run check` 得到 **2649 项、2642 通过、7 失败，874052.198417ms**，无跳过/取消；667 仓库文件及 66 辅助文件冻结通过。六项 installer 仍为原始 watchdog 超时，另一项工作流 readiness 记录了 pid 14429 的 `timed_out`、SIGTERM、已确认退出及实际空 stdout/stderr。没有该失败子进程的同次原生栈，不能解释为“未执行”。该 HEAD 的 [三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/37131017609) check、SEA、实际 `SEA smoke passed` 均通过；Linux 各跳过一项 Darwin 专用 plutil 测试，不能用 CI 绿抵消原始本地红。

随后官方 DeepSeek 提供窄入口候选，主代理纠正“导入完成等于安装成功”及旧入口错误传播的表述；独立合同 **11/11**。非目标工作进程只解析小入口，不加载原 603 行观察器及其顶层临时目录 I/O；目标仍使用原观察器。私有 npm 包装层合同 **8/8**，真实隔离工作流 **21/21** 且 741 项冻结通过。仍有入口解析/异步求值开销，不宣称零干扰。

复核输出发现旧临时汇总 CLI 在 macOS `/tmp`→`/private/tmp` 规范化时，入口字符串比较失败，竟以 **exit 0、空输出** 结束。因此此前该 CLI 的退出码不构成解析验证。保留旧空产物及冻结记录，另建专用 CLI：真实回归旧版 **0/4**、新版 **4/4**。重新解析四组保留日志/事件后，计数与此前人工检查一致；这是现在完成的解析验证，不追认过去空输出或失败的 HEAD 冻结为成功。

只做一次减少非目标模块导入的全量诊断：仍用真实 npm 上下文、原始 292 文件/2649 项、预算、并发及真实子进程；结果 **2649/2649，1048251.613167ms**，无跳过/取消，667 仓库文件及其余辅助文件合计 **759 项冻结通过**。新 CLI 的非空 JSON 另经显式断言。worker 14071 的四个目标窗口均先于首次检查关闭，另两个目标受上限排除；**零 marker 检查、ps、采样**，没有同次失败观测。不重复该实验，不据此推断时序因果或宣称启动问题修复。

### 脚本入口经符号链接静默成功：独立确认并修复

同类检查进一步发现 [build](../scripts/build.ts)、[binary](../scripts/binary.ts)、[release-assets](../scripts/release-assets.ts)、[smoke](../scripts/smoke.ts) 都使用词法 `resolve(argv[1])` 与模块 URL 比较。带目录/文件符号链接的入口可能不执行 CLI 主体，却退出 0；普通 import 在 argv 恰好命名该模块时也可能误执行主体。普通相对 cwd 规范化并不必然复现，不能拿它代替真实 alias 测试；也没有证据说明某次历史发布已因此失败。

采用官方 DeepSeek 建议的 Node 原生 `import.meta.main`，只改四个守卫及删除不再使用的 import，不改变业务主体。项目已要求 Node >=24.13.0；主代理用真实 Node type stripping、tsx loader、tsx CLI、canonical/alias、`--preserve-symlinks-main` 及非入口 import 共 **24 组私有对照** 验证，而非只相信版本推测。发布脚本仍可单文件复制执行，不增加依赖、文件系统规范化或错误吞没逻辑。

新增 [永久入口合同](../tests/build/script-entry.test.ts)：六项测试在旧代码 **0/6**；修复后全体 build 回归 **55/55，4211.418041ms**，无跳过/取消，571 文件行数、226 模块边界、typecheck 及 566 文件零警告 lint 通过。测试用真实无参发布 CLI 的 Usage 错误证明主体实际执行，先于任何网络/发布效果；覆盖目录/文件 alias、含空格路径、三种运行方式、preserve flag、普通 import 与伪装 argv。其余三个守卫采用显式结构合同，并仍须由最终 HEAD CI 执行真实 build/SEA/smoke 主体。初版测试数组索引被严格类型检查拒绝，改为只读元组后上述检查通过。

**这是明确的脚本入口修复，不是那七项启动超时的根因修复。** 测试新增六项，后续原始全量应为 293 文件、2655 项；最终提交仍需独立原始全量及精确 HEAD CI 验收。PR 继续 Draft，不合并。

### `6c48d40`：完整输入诊断仍失败，首次启动与恢复必须区分

后续期限与 Shell 启动隔离合同纳入后，`6c48d405770393522ef76ec41b2caf8f88da06a9` 的原始全量为 **295 文件、2666 项：2658 通过、8 失败，882834.900416ms**。其中六项安装器原生超时、一项导入超时，以及一项工作流首次启动断言失败；此处不把历史不同提交的失败集合合并成一次运行。该 HEAD 的 [三平台 CI](https://github.com/hewenyu/herdr-agent/actions/runs/37186818999) 通过 check、SEA/smoke，不能代替上述本地结果。

一次经版本冻结和独立审查的完整输入诊断保留这 295 文件、原有并发和超时，得到 **2666 个真实测试体、2659 个唯一标题、零文件级合成通过项：2665 通过、1 失败，404307.024084ms**。原八项本次均通过；唯一失败是 fresh readiness 的 40s 外层 ETIMEDOUT/SIGKILL，输出到 replacement bootstrap。该调用不在固定的 10/30s 安装器观察范围内，因此没有它的采样；两份身份/窗口有效的调用方采样属于未导致测试失败的被选调用，不能解释该失败。运行前后 884 项冻结哈希、671 个仓库文件及用户原有改动均核对一致。此运行直接启动 Node 且带观察器，不是原始 npm 验收，也不是根因修复。

重新核对原始失败栈，工作流明确失败于 [首次启动断言](../tests/orchestration/workflow-worktree.test.ts)：消息为 `configured child is executing before workspace changes`，仅一个 timed_out 记录，SIGTERM、exitConfirmed=true、实际空日志。测试尚未执行 readiness 变更、取消检查或 release 写入；不能归因于恢复握手，也不需要再次运行来决定失败属于首次还是恢复阶段。5001ms 记录差与现有 5000ms 预算相符，但不能定位 Shell、Node 初始化或标记写入阶段。

主代理复核官方 DeepSeek 的两份只读分析，拒绝将无关的字段提取优化当作此 40s 失败修复，并纠正两项测试提议：命令替换子 Shell 中修改计数/时钟不反馈父 Shell；当前输入仍有效的 timed_out 应保留失败证据，不能断言“任何超时都不写 evidence”。尚无支持修改生产时限或证据规则的根因证据，PR 继续 Draft。

### 两条测试端启动标记：先验证诊断不会阻断原流程

官方 DeepSeek 实现 [长命令夹具构造器](../tests/orchestration/verification-startup-fixture.ts)：Shell builtin `printf` 在原 `exec` 前尝试写固定 stderr 标记；真实 Node 在加载 `node:fs` 后、原 cwd 标记写入前尝试写第二条。不新增外部探针、额外文件或逐轮日志，不输出环境/argv；保留真实 Node、exec、5s 期限、1000×5ms 启动轮询、10ms release 轮询和原断言。短命令分支不变。存在标记只能证明相应语句到达；缺失不能证明未执行，同步日志写入也可能扰动时序，因此仍是诊断增强而非超时根因修复。

主代理没有直接采纳作者结果：作者原有纯测试实际 **8/8**，不是报告中的九项；独立 VM 反例发现 stderr 写失败会阻断原 marker/interval，真实 `/bin/sh -e` 反例发现仅用分号不能隔离失败的 `printf`。新增 [永久回归](../tests/orchestration/verification-startup-fixture.test.ts) 先得到 **8 通过、1 失败**，再将 Node 写入单独 try/catch、Shell 写入改为 `|| :`。仅诊断写入失败可忽略，真实 marker 失败继续传播。作者还披露在禁止 Shell 的委派范围外运行了四次只读 Shell 调用；其“零原生命令”表述不成立，未报告测试、仓库外写入或用户文件改动。

修订后永久纯测试 **9/9**；独立 VM 写失败对照通过；真实私有 Shell/Node 对照 **3/3**，覆盖引号/换行/元字符路径、关闭 stderr 且启用 errexit、真实 marker 写失败。三文件工作流/期限/新夹具集成 **38/38，7262.965541ms**；576 文件行数、226 模块边界、typecheck 和 571 文件零警告 lint 通过。新增九项使下一次完整输入应为 **296 文件、2675 个真实测试体**，不能把这些局部结果称作最终全量通过；仍需原始 `npm run check` 与精确最终 HEAD CI。
