# myrix

[English](README.md) · [npm](https://www.npmjs.com/package/@yuebanlaosiji/myrix) · [下载 Release](https://github.com/hewenyu/herdr-agent/releases)

基于 **Node、TypeScript 和 pi** 的本地调度工具，通过 **@yuebanlaosiji/myrix** 分发。在飞书中创建项目、组织需求讨论和开发任务、跟进结果；本机 Web 用于配置项目和模型、查看会话记录。

**myrix 是飞书里的原生 agent 远程驾驶舱：pi 作为 leader 管理项目、任务、参与者和会话；herdr 托管 Claude/Codex 及其原生 session。** 每个任务通常对应一个飞书群和一个飞书任务；讨论得出结论后，再创建子任务让 Codex 依据父任务冻结报告与已确认文档执行。用户项目的需求讨论、设计、开发、测试和评审交给 Claude/Codex；myrix 另可运行项目显式配置的本机验证命令。可以让它们进入同一个任务群，也可以启动同类模型的多个参与者，为不同项目分别创建任务。

AI 入口采用 **规则 → Jev → LLM**：程序先执行身份、作用域、去重和 exact `/clear` 等确定性协议。私聊 Jev 分类独立开关、默认关闭，普通文本仍进入原 pi 对话及工具路径；开启后 Jev 只选择 intent 和已登记 project，只有高置信度且参数完整的请求才用用户完整原文与固定模板默认值创建任务，其余交给 pi。业务完成性声称仍须真实操作证据，文本确认不能算明确执行请求完成。新 workflow 的生命周期通知直接依据当前任务事实，不在后台调用 pi。

前后端均使用 TypeScript，连同 Node 和原生锁扩展一体打包为可执行文件。独立二进制、版本输出、运行提示和服务名称统一使用 `myrix`。GitHub 仓库地址保持不变。全新安装使用 `~/.myrix`；检测到已有 `~/.herdr-agent` 时原地沿用，保留配置和对话。

任务和 AI 已启用时，无论是否配置 Jev key，新任务默认保存 `orchestration.mode = "workflow"` 和 v3 参与者协议；显式手动模式仍可选择。每个 v3 任务具有独立的持久化 pi Leader，通过任务看板和受限调度工具决策。程序负责合法动作、修订、依赖、独立评审和原生投递回执门禁，不用一次性枚举选择替代 Leader。规划协助、文档授权与合同变更仍分别核验；无效或失败的决策不能授权派发或扩大权限。

飞书 / Web 外层会话默认只获得有界任务状态，不接收完整任务 transcript 和决策快照。完整要求、输出与审计通过有作用域的 `task_detail` 分页及持久化结果引用按需读取。强制约束必须完整保留；未知操作不会为了恢复上下文而重放。详见[持久化 Leader 与上下文边界](docs/durable-task-leader-context.md)。

Jev 不再负责 workflow 主选择，只保留原生审批菜单自动选择与可选私聊分类。已有 v2 workflow、`model`、`manual` 及存量 `round_robin` 任务保留执行协议；存量 model 编排也接入独立任务 Leader。新建 `round_robin` 已弃用，无 AI 的多参与者讨论默认 `manual`。

v3 讨论由参与者按序回应，详细材料及独立回执保存在任务状态目录，原生聊天只作简短自然交接。用户已明确要求的讨论文档可以在批准的路径落盘并由另一位参与者复核，无需再次询问，也不会自动开始业务代码开发。中间输出保留在内部；飞书只接收必要的开始、真实阻塞通知和最终摘要及 `report.md` 附件，本机记录页可下载冻结报告。用户要求的讨论文档会连同哈希收录在报告附件中，可直接在飞书阅读。开发交付展示实际采集的分支、commit 和可核验的对应 PR。用户主动问进度时，pi 用 `task_progress` 读取该任务绑定的原生 session 及当前证据后自然总结。交付仍等待用户验收。见[v3 行为和验收记录](docs/workflow-natural-collaboration-2026-09-28.md)、[初版编排设计](docs/myrix-jev-llm-orchestration-design.md)和[历史调度审计](docs/ai-orchestration-audit-2026-09-25.md)。

普通首轮讨论使用固定计划，由受限 pi 选择只讨论、交付默认项目文档，或交付文档并让每位参与者明确确认同版文件哈希。自定义文档路径和必要参数交由 pi 在授权范围内规划；自定义节点图留给重规划，不因讨论结束自动进入实现。

## 安装

Node/pi 重构版本从 **v0.3.0** 开始，支持 macOS arm64、Linux x64 和 Linux arm64。npm 启动器需要 Node >=18；独立二进制已内置 Node。

```sh
npm install -g @yuebanlaosiji/myrix
myrix version --json
myrix help
```

npm 自动选择当前平台的原生依赖：`@yuebanlaosiji/myrix-darwin-arm64`、`@yuebanlaosiji/myrix-linux-x64` 或 `@yuebanlaosiji/myrix-linux-arm64`。请保留 optional dependencies。平台包负责提供二进制，**用户统一安装 @yuebanlaosiji/myrix**；安装过程没有 postinstall 下载或编译。npm 同时提供 `myrix` 和兼容命令 `herdr-agent`。

查看可用版本、安装指定版本或升级稳定版：

```sh
npm view @yuebanlaosiji/myrix versions --json
npm install -g @yuebanlaosiji/myrix@0.3.12
npm install -g @yuebanlaosiji/myrix@latest
```

无需安装 Node 的方式：从 [Releases](https://github.com/hewenyu/herdr-agent/releases) 下载对应平台压缩包，解压并核对随包发布的 `SHA256SUMS`，再使用包内可执行文件：

```sh
./myrix version --json
./myrix setup
./myrix serve
```

启用任务调度前请完成下文配置。两种安装方式都需要本机 herdr、Git，以及已登录的 Claude/Codex CLI。Linux 需要兼容的系统库；macOS 包使用 ad-hoc 签名，尚未公证。平台要求和校验命令见对应 Release 说明。

## 发布与验收状态

最新稳定版见 [Releases](https://github.com/hewenyu/herdr-agent/releases/latest)，安装版本、源码提交和构建时间通过 `myrix version --json` 查看。本文说明当前源码行为，各已发布版本包含的改动以对应 Release 为准。根目录的 `package.json` 是私有源码包，不是公开发布的 npm 主入口包。

推送 `v*` tag 后，GitHub Actions 自动完成三平台原生构建与烟测、完整 npm 分发的离线安装验证、平台包及主入口包发布，最后创建 GitHub Release。npm 发布使用 GitHub environment `NPM` 的 `TOKEN`。Actions 内部的 artifact 下载只是组装发布包的工作流步骤；用户直接从 npm 安装 `@yuebanlaosiji/myrix` 或下载 Release 压缩包，不需要选择 workflow 的 download 选项。版本规则与失败恢复见[发布说明](docs/releasing.md)。

全量真实验收仍为 **R-部分，持续进行中**。[现场验收矩阵](docs/live-validation.md) 分开记录实现、自动化检查和真实飞书/herdr 证据。[E32](docs/live-evidence-e32-manual-discussion.md) 覆盖 Claude/Codex 手动讨论及资源清理；[E34](docs/live-evidence-e34-runtime-recovery.md) 覆盖用户审批、参与者输出、清理，以及错误任务编号明确失败后同轮恢复完成。历史失败继续保留，包括 [E33](docs/live-evidence-e33-n02-codex.md)。[E35](docs/live-evidence-e35-destroy-notices.md) 已验证明确取消任务时的两条收尾通知与资源销毁，远端任务仍保持未完成；[E36](docs/live-evidence-e36-completion-notices.md) 也已限定验证确认完成后的通知与清理，其创建答复误拒随后已修复，并经 [E37](docs/live-evidence-e37-create-delivery.md) 从创建到清理的限定链路复验通过；整体仍为部分通过。

本地接受或排队不代表远端任务、群聊已创建，也不代表要求已送达参与者；回复必须以工具回执为依据。发布版本与本地开发二进制可能不同，对照行为前请用 `myrix version --json` 核对。

本次修复、兼容策略与离线验证边界见[pi leader 迭代记录](docs/pi-leader-iteration-2026-09-29.md)，不代表真实全链验收通过。

## 运行前置

- 本机 herdr 可用，其 Unix socket 可访问；需要的 Claude/Codex CLI 已安装并完成登录，Git 可用。
- 飞书国内版自建应用，通过 `setup` 注册或复用；当前 CLI 不接纳 Lark 海外应用。
- 使用 pi 时配置支持工具调用的 OpenAI Responses 或 Anthropic Messages 模型服务。
- 这是单人单机工具，Web 只监听 loopback IP。Web 身份选择仅用于已有授权范围内的历史和配置，不改变飞书发送者或活跃会话。

## 从源码构建

需要 Node **24.13 或更新版本**、npm，以及构建 `fs-ext` 所需的 Python/C++/make 工具链（macOS 安装 Command Line Tools）。

```sh
npm ci
npm run check
npm run build
npm run binary
npm run smoke
./dist/myrix version --json
```

`check` 执行 1000 行上限检查、TypeScript、Biome 格式/lint 和测试。`build` 生成带静态资源的 `dist/myrix.cjs`；`binary` 会重新构建应用并在当前系统生成 `dist/myrix`，包含 Node 和原生扩展。`smoke` 将单个可执行文件复制到空临时目录，验证嵌入资源、锁、SQLite、历史浏览、受保护的配置写入和业务写请求拒绝。模型烟测先在隔离状态中排入飞书适配器事件，再由复制后的 SEA 执行 pi 循环和本地 Responses/Anthropic 协议替身；GET 查看记录不 ACK，没有飞书连接时回复保持未送达。这属于打包验证，不连接真实飞书/herdr/模型服务。macOS 本机烟测通过不代表 Linux 已通过；各平台证据见验收文档。

开发时可用 `npm run dev -- help`；本地 Web 资源以构建后的程序为验收入口。后续示例使用 npm 安装后的 `myrix`；源码构建时可替换为 `./dist/myrix`。

## 配置与启动

1. 将 [配置示例](deploy/config.example.toml) 放入状态目录（全新安装为 `~/.myrix/config.toml`；已有 `~/.herdr-agent` 时优先沿用），仅本人可读。需要任务/pi 时先设置 `tasks.enabled = true`，使 setup 检查任务与群权限。
2. 运行 `myrix setup`，复用已有应用或按链接完成授权，再发送一条私聊并点击验证卡片。只有两次往返通过才算完整验证。setup 会保存 `.env` 和允许用户。
3. Web 可添加、编辑或删除项目登记，设置默认项目、默认参与者及新任务的 Bypass。按顺序填写已存在的目录；保存时检查全部目录，首目录需要时自动初始化 Git，附加目录按原顺序传给 Claude/Codex。删除登记不删除代码；项目目录和 Bypass 默认值用于新任务，不改动已有执行会话；验证配置在每次新运行前重新核对。模型连接也可在 Web 保存，启用时必须显式填写 `base_url`，模型配置修改后重启服务。任务、讨论和审批仍通过飞书提出。
4. 运行 `myrix serve --open`，打开日志打印的本机地址。Web 用于维护本机配置和查看已有会话记录；先停止 serve 再运行 setup，它们使用同一把状态锁。

```sh
myrix setup --app cli_EXISTING_APP
myrix setup --update-permissions
myrix serve --config-listen 127.0.0.1:18790
myrix doctor --json
```

已有应用启用任务功能时，需在飞书开发者后台配置事件订阅方式，添加 `task.task.update_user_access_v2` 并发布应用版本，才能让手动完成任务的事件送达服务。逐任务调用 API 订阅不能替代后台事件配置与应用发布；setup 的 scope 检查不检查后台事件订阅。

`myrix configure --listen 127.0.0.1:0 --open` 继续保留，用于不连接飞书地启动本机配置和会话记录页；网页及 HTTP 接口只开放受保护的本机配置写入口，不开放业务操作。该 CLI 启动仍会打开和迁移本地状态，并可能由既有调度器处理已排队工作；只读承诺针对浏览行为，不表示整个服务启动没有业务副作用。业务操作从飞书发起，安装维护仍用 CLI 与配置文件；连接不可用不能静默取消远端资源意图。端口 0 会打印实际可用地址。`myrix serve --no-config-ui` 可关闭页面。启动补授权只更新同一个 App ID，不以网络故障自动新建应用。`setup --reregister --yes` 才明确要求创建替代应用。

飞书凭据优先级为进程环境 → 状态目录 `.env` → 仓库 `.env`。`.env` 使用字面 `KEY=VALUE`：引号、`#`、`=` 都是值的一部分，不支持 shell `export`。模型、Jev 与 memory key 只从 TOML 读取。不要把包含 key 的配置提交到仓库。

可选 `[jev]` 配置包括 `api_key`、`base_url`（默认 `https://api.typesafe.ai`）、`model`（`jev-1.13.0`）、`timeout`（默认 `10s`，最多 `2m`）、`confidence_threshold`（`0.8`）、`ingress_enabled`（`false`）、`approvals_enabled`（`true`）和 `stall_rounds`（`3`），修改后重启服务。开启私聊分类会把适用私聊原文和已登记项目名称发给第三方 Jev，不默认发送全量历史、仓库或附件。仅配置 key 不会开启这条数据外发路径。低置信度、失败、项目不确定、引用上下文或复杂安排保留原 pi 路径。

AI 已启用且配置 Jev key 时，`approvals_enabled = true` 默认启用受管参与者的阻塞菜单自动选择，适用于新旧任务及所有调度模式。它把完整可见终端屏幕、任务要求和用户修订发给第三方 Jev；Jev 选择一个受支持按键，程序核验任务、执行器身份和屏幕后执行，每次按键后重新观察。Jev 失败或低置信度时，pi 只能用 `approval_decide` 从同一组候选选择。菜单文案和布局可以变化；未知账号、验证码、业务取舍、不可读界面以及写入结果不确定时保留现场交给用户。此开关不启用私聊分类、不改变 Bypass、不代替用户验收。设为 `false` 后恢复普通审批手选及旧的启动目录信任流程，修改后重启生效。详见[修复与验证范围](docs/native-approvals-2026-09-28.md)。

项目所有者可以在初始项目种子中显式设置 `verify = ["npm run check"]` 和可选 `verify_timeout = "2m"`；SQLite 已有项目目录时，通过本机 Web 项目设置修改命令与毫秒超时。缺失或空数组均不启动本机命令。执行器只运行配置命令，固定在任务实际主 cwd（包括 worktree），单命令超时最多 10 分钟。命令使用服务账户的本机权限，固定 cwd 不代表 OS 沙箱。`npm run check` 等已配置命令仍可能执行参与者可修改的工作区脚本、依赖或配置；固定命令字符串不代表这些内容可信或不可变。只有信任该工作区可使用服务账户权限执行时，才应开启验证。模型不能提供任意命令或另选 cwd，已配置验证的项目变更目录须走本机设置。超时、取消会停止 POSIX 进程组；退出未确认时继续阻塞冲突目录，不自动重跑。证据保存 stdout/stderr、退出事实及配置/代码版本。报告区分“myrix 配置命令验证”“agent 复核”“参与者自述”和“未运行”；无配置时的独立 agent 重跑不标成 myrix 已验证。清空命令阻止新运行，但不自动撤销已经启动的运行。 用户明确禁止测试时，工作流保存用户原文约束、关闭验证命令并保留独立只读评审，报告明确标注“未运行”。

长期运行使用 [deploy](deploy/) 中的 launchd/systemd user 模板与安装脚本；先检查路径与运行账户。服务 stdout/stderr 由服务管理器收集。停止桥接程序不等于销毁已在 herdr 中运行的任务。

### 升级与已有实例

不带参数的 `myrix` 等同于 `myrix serve`，会尝试启动服务。若已有实例持有同一状态目录的锁，它会拒绝再开一条飞书连接。先检查当前实例：

```sh
myrix status
myrix status --json
```

`status` 不连接飞书、不打开数据库，也不要求配置文件有效。它检查内核状态锁并提供进程及服务管理器的诊断信息；PID 文件中的数字仅为记录，锁被占用也不代表飞书连接健康。不要删除持锁进程的 PID 文件来绕过检查。前台启动的实例在原终端按 Ctrl+C 停止，再用新版本启动；后台实例按 `status` 核实的服务指引操作。

`npm install -g @yuebanlaosiji/myrix@latest` 更新磁盘上的包，不会替换运行中的进程；`myrix version --json` 显示本次命令使用的安装版本，不代表后台实例已经升级。若 launchd 仍指向以前下载的二进制，请从包含本修复的源码目录，用当前 npm 命令重新安装桥接服务：

```sh
MYRIX_BIN="$(command -v myrix)" bash deploy/install.sh --bridge-only
launchctl print "gui/$(id -u)/com.hewenyu.myrix"
```

该安装会保留配置和 herdr 服务，卸载旧桥接标签并注册、重启 `com.hewenyu.myrix`；npm 包本身不包含 `deploy/install.sh`。已经绑定相同 npm 全局目录的服务，后续更新后可用 `launchctl kickstart -k "gui/$(id -u)/com.hewenyu.myrix"` 重启。切换 nvm Node 版本或 npm 全局目录时需重新运行安装脚本，更新可执行路径和 Node PATH。

SQLite 的 `ExperimentalWarning` 是内置 Node 对 SQLite API 的提示，不是状态锁故障。`help`、`version`、`status` 和拒绝重复启动不再为此加载 SQLite；真正打开数据库时仍保留运行时警告。需要完整警告调用栈时使用 `myrix --trace-warnings serve`，不要把提示中的省略号 `...` 当作参数。

## 使用方式

在飞书主私聊中创建项目、任务或切换 pi session，在对应任务群中续聊和处理审批。讨论可以不绑定项目；开发、评审和测试任务使用已配置项目。可对 pi 说：“开个讨论任务，让 Claude 和 Codex 一起讨论这个需求”“把已确认方案交给 Codex 实现，Claude 评审”“切回昨天的调度会话”。pi 调用工具组织工作，参与者负责业务内容。一个机器人在群内标明发言来源，Claude/Codex 不是另两个飞书账号。

任务创建时冻结调度模式。AI 已启用时（与是否配置 Jev key 无关），新自动任务使用由 pi leader 选择的 `workflow`，旧工具显式传入 `model` 也会归一为 workflow；已有任务及其创建重试保持记录模式。无 AI 的多参与者讨论默认 `manual`；新建任务显式指定 `round_robin` 返回弃用错误，普通轮流讨论使用默认 workflow。应用不设置决策次数、讨论轮次、累计时长或工具调用次数配额，AI 预算交由网关管理。workflow 中当前版本 open 问题集合连续 `stall_rounds` 个已结束批次保持不变时转用户裁决，不强制综合或收尾；存量 `round_robin` 持续到暂停或结束。单操作超时和模型上下文管理用于恢复卡住的调用与过长请求。可以指定参与者或暂停，同类实例有不同 participant ID。普通文本不是权限菜单批准，审批使用实际卡片/屏幕选项。pane 关闭、输入投递和报告附件结果未知时不自动重发：每轮先只读补证（pane 是否存在、原生 transcript 与完整 prompt 精确匹配），再按操作修订版本询问一次受限 pi，最后向任务所有者发送不含“交人工”的一次性群卡片。决议保留原回执，代码限制每个操作最多重试一次，未知的 pane 关闭只能由所有者放弃。详见[pi leader 迭代记录](docs/pi-leader-iteration-2026-09-29.md)。

任务身份和创建锁都绑定当前 pi session。在另一个 session 中复用 request/message ID 会创建独立任务，不会把无关项目的创建串行阻塞。任务群解散后，程序仍保留任务和会话历史记录，但迟到消息和卡片回调会在入口以及 inbox 执行前再次拒绝，不会回落到主 pi session，也不会消费审批。飞书断线重连时，旧任务调度器会先停止，再由新连接启动调度器重新核对当前记录；旧连接不会继续对新连接的同一批记录执行操作。

参与者执行现场自然消失（原生进程退出、窗口丢失）但任务仍需继续时，后台观察会自动重建执行器：保持同一参与者身份和任务名册，在新工作区启动干净实例，不关闭也不复用仅因 `agent_not_found` 而存疑的旧 shell，不重放也不改写旧输入与未知回执。重建只修复执行位置，不表示旧要求已送达或原工作已恢复：重建后 `initialDelivery` 回到 `pending`、自动调度保持暂停，必须由用户发送新的安排才会继续；未知投递仍走原有只读补证流程。明确的业务暂停会保留，但不再阻断执行器生命周期维护；完成（含保留执行现场）、移除或明确停止的参与者、收尾中的任务和正在执行的用户显式重启仍禁止自动维护；`timeout`/`not_found` 等非确定性读取失败不构成执行器确实缺失的证据。详见[两个彼此独立的状态机](docs/agent-lifecycle-readiness.md)。

### 业务调度与执行器生命周期相互独立

业务调度与执行器是两个独立状态机，任务状态不等于执行状态：

- **业务调度**决定新的业务输入与转交能否下发。显式业务暂停停止自动业务输入，不停止执行器维护；`interrupt` 额外停止所选执行器，移除、完成/关闭/销毁也会约束原生副作用。
- **执行器生命周期 / 就绪度**描述被托管的执行现场：`unallocated`、`provisioning`、`starting`、`awaiting_trust`、`awaiting_manual`、`ready`、`busy`、`missing`、`uncertain`、`stopped`、`removed`。它在 `task_get` 和参与者视图上按参与者暴露为 `readiness`（以及 `readinessReason`）。`created`/`started` 只证明已分配，二者都不是 `ready`；`ready` 表示执行器可以接收输入，既不表示"业务正在运行"，也不代表用户已验收。

因此，业务暂停仍然允许首次分配、执行器丢失后的重建，以及受限的启动目录信任确认，但绝不会自动下发业务提示。用户明确发送新安排只作用于所选执行器，不会解除其他执行器的停止状态或真正的任务级业务暂停。就绪度绑定到执行代际（`executionRecovery`），新替换的执行器不会被已退役实例的观察结果判定。

启动目录信任是用户的长期授权而非业务轮次：当原生菜单上识别到精确的已授权目录信任提示时，受限流程会直接确认，无需用户发送"继续"，且与 Jev 开关、业务暂停无关。只有这一受限流程被豁免；普通权限菜单仍受业务暂停约束。

结果未知的启动信任效果会冻结该执行代际，跨重启、`stateSeq` 变化与 Jev 启停均有效：绝不自动重放，通用审批流程和业务输入也无法绕过。确定的新代际（重建后的执行器）从干净状态开始，旧回执保留用于审计。排队中的用户控制或已撤销的所有者会否决本次进行中的信任写入，但只否决这一次尝试——启动维护不会被永久禁用。

无论 Jev 是否启用，参与者启动均由独立的 pi 受限流程处理：只会在目录确实属于授权任务项目、且现场是 Claude/Codex 原生目录信任提示时自动确认。未启用模型调度的 `manual` 讨论只自动尝试向首位参与者发送初始业务提示；其他执行器仍独立启动和完成目录信任，业务输入等待用户或调度器安排。只有当前事实明确显示任务群已经发布仍有效的审批卡时，`blocked` 参与者才提示用户去群里处理；没有群或卡片发布事实时只说明参与者处于 blocked，不能假定存在审批卡。只有上一位参与者产生已核验输出后，存量 `round_robin` 才会自动转交下一位。自动审批关闭或未配置 Jev 时，其他审批提示留在任务群中，由用户明确选择。`tasks.bypass` 默认仍为 `true`，项目或任务的 Bypass 保持可配置；目录信任的自动处理不会隐式开启 Bypass。

新任务在 completed 完成确认后默认自动解散群；用户明确保留时使用 `keepGroup: true`。review 不触发解散，明确保留证据继续有效；旧默认或来源不明的保留值在完成/关闭时采用解散，不批量改写活跃旧任务。`complete`（含飞书手动完成）默认通过 herdr 关闭对应执行器并按快照处理群；无论因何种原因解散群，都会关闭对应的 herdr Claude/Codex session。明确 `keepExecution: true` 保留执行器是例外，有群任务必须同时 `keepGroup: true`；`close` 确认完成后关闭受管执行资源；`destroy` 不自动验收；`reopen` 用于保留现场的已完成任务。若执行器已关闭而群仍保留，之后可明确要求解散该群：pi 使用 `destroy` 加 `keepGroup: false`，已验收任务也可使用 `close`。这不会重启执行器或改写原验收事实。任务结束和 pi session 归档是独立操作。默认共享项目目录；显式 worktree 只隔离首目录，其余附加目录仍共享，关闭时不删除代码或 worktree。

主入口飞书私聊达到配置的上下文容量时会自动压缩 pi 历史，保留原始记录和持久化操作回执。只有用户需要手动开启新会话时，才在主入口私聊单独发送 `/clear`；程序直接归档旧 pi session 并创建、选中新 session，事务成功后只回复 `CLEAR_NEW_SESSION_OK`。关闭 AI 或模型不可用时也可用；保留历史、任务和 herdr session，群聊拒绝。只匹配实际正文去掉前后空白后恰好为 `/clear` 的消息；引用内容、`/CLEAR`、`／clear`、`/clear now` 或正文中提到 `/clear` 不触发。Web 没有聊天框、`/clear` 或清空按钮；查看另一段历史不改变飞书活跃 session。

AI 开启时，其余聊天文本按上述 opt-in 分类边界处理；exact `/clear` 以外的斜杠形式仍交给 pi。关闭 AI 后仍保留任务模式的 `/new /tasks /projects /task /screen /stop` 等兼容入口；关闭 tasks 后，旧桥仅为已有 pane 选择保留 `/card /say /stop /mirror /close`，不再建立新接管绑定。旧桥 `/close` 仅解除选择，不销毁任务。

旧桥 `/ls` 只提示弃用，不再发送选择卡；卡片选择和 `/mirror` 不能建立新绑定，也不再隐式接管唯一 agent。已经选中的 pane 仍可继续使用，普通 shell pane 仍不属于桥接目标。

日常 CLI 为 `serve / setup / configure / doctor / version / help`；`configure` 现用于本地配置和会话记录页，旧 Web 业务管理控件已移除，维护入口为 `migrate` 与只读 `debug ls|screen|transcript`。旧顶层 `key / say / watch / dialog / tail` 等已退出，终端输入通过飞书参与者调度，普通审批由已启用的 Jev 自动流程处理，需要人工时在飞书群内选择。`help` 列出有效参数。退出码：0 成功、1 失败、2 用法错误、3 setup 凭据已保存但验证未完成、130 取消；旧 Go 的所有退出码并非逐项兼容。

## 升级与旧数据

**停止旧服务及自动重启后再迁移；同一应用不要运行两条事件消费连接。**

```sh
myrix migrate --state-dir /absolute/state --dry-run
myrix migrate --state-dir /absolute/state
myrix serve --state-dir /absolute/state
```

迁移先校验，再备份到 `backups/`，事务导入任务、资源引用、可见会话与防重放回执；旧文件不改写。服务启动执行同一幂等导入，显式维护使用 `migrate`。坏状态或迁移后变化的旧业务源会拒绝覆盖。旧 pending 操作保持待核对，不重放旧模型工具或历史结果。

新版持久状态在 `state.sqlite`（含 WAL/SHM）；项目目录和 bypass 的后续修改写 SQLite，旧 `projects.json` 仅为导入/初始化来源。回退前保留数据库与备份，核对新版已创建/关闭的真实资源；新增状态不回写 Go JSON，没有自动反向迁移。完整流程见 [设计中的迁移与回退](docs/node-pi-design.md#迁移与回退)。

## 验证边界

[Jev/LLM 编排设计 v1.1](docs/myrix-jev-llm-orchestration-design.md) 对应 PR #54 已合并的 S3/S4，用户已确认验收通过。[真实 Jev Choice 记录](docs/jev-choice-live-evidence-2026-09-27.json) 使用合成输入；开发者实际执行的链路与未取得的具体证据分别记账，见[合并后补齐记录](docs/workflow-completion-2026-09-27.md)。

前述 v2 讨论、新需求和 Bug 修复三套隔离本地工作流已使用真实 Jev、pi、Claude 与 Codex 跑通；该历史证据不代替本次 v3 验收。可运行 `node --import tsx scripts/live/jev-ingress-probe.ts` 复测合成入口分类，或 `node --import tsx scripts/live/workflow-acceptance.ts --template all` 复测隔离本地工作流。这两个手工脚本使用本机模型凭据，保留失败与回退记录，不发送飞书消息或修改常驻配置。

自动化覆盖真实 pi 循环、协议替身、SQLite/flock/Git、迁移与独立二进制，业务验收必须有真实飞书用户入站、群内交互和实际回读，并关联模型工具回执及 herdr 现场；直接 Web/API 操作不能替代该链路。Web 配置写入与历史浏览另行验收。当前支持文字和富文本中的文字；图片理解、语音转写、通用文件制品托管不在首版范围；v3 支持报告附件和限定任务的本机报告下载。

[当前业务场景与命令取舍](docs/current-business-scenarios.md) 汇总现行入口、职责和遗漏检查。[需求盘点](docs/node-pi-refactor-requirements.md) 是 Go 基线历史快照；[旧代码审计](docs/code-audit.md) 等历史材料已标注版本，不能当作 Node 当前能力说明。B/N 场景的早期离线证据见 [acceptance.md](docs/acceptance.md)，当前尚待核对项目和部署证据见[现场验收矩阵](docs/live-validation.md)。

当前模块边界、复用原则和 PR 检查清单见[Node/TypeScript 代码质量约定](<docs/code-quality.md>)。`npm run check` 会执行选定架构边界检查，并把 lint 警告视为失败。

本项目采用 MIT，见 [LICENSE](LICENSE)。发布包另带 `LICENSES/`，保留嵌入 npm 依赖、原生扩展和 Node 的许可及第三方声明；重新分发请一并保留。生成规则见 [licenses](licenses/README.md)。

本次实现映射、自动检查、真实模型证据及现场验收缺口见[本地交付与复核记录](docs/workflow-implementation-2026-09-27.md)。
