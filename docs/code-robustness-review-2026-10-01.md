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
