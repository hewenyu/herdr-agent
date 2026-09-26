# myrix

[English](README.md) · [npm](https://www.npmjs.com/package/@yuebanlaosiji/myrix) · [下载 Release](https://github.com/hewenyu/herdr-agent/releases)

基于 **Node、TypeScript 和 pi** 的本地调度工具，通过 **@yuebanlaosiji/myrix** 分发。在飞书中创建项目、组织需求讨论和开发任务、跟进结果；本机 Web 用于配置项目和模型、查看会话记录。

**pi 管理本工具的项目、任务、参与者和会话；herdr 托管 Claude/Codex 及其原生 session。** 用户项目的需求讨论、设计、开发、测试和评审交给 Claude/Codex。可以让它们进入同一个任务群，也可以启动同类模型的多个参与者，为不同项目分别创建任务。

AI 开启时，普通回复、生命周期通知和工具选择由模型决定。程序提供工具、权限检查和持久化操作回执；明确的业务请求至少要尝试一次工具调用，模型只回复“收到”等确认文字时不能算请求完成；能力说明或解释性问题仍按普通对话处理。对已经执行的业务动作要求真实写入证据，生命周期通知以当前任务与参与者快照为依据，仅开放只读工具。精确的 `/clear` 命令由程序直接轮转主私聊 pi session，不调用模型。

前后端均使用 TypeScript，连同 Node 和原生锁扩展一体打包为可执行文件。独立二进制、版本输出、运行提示和服务名称统一使用 `myrix`。GitHub 仓库地址保持不变。全新安装使用 `~/.myrix`；检测到已有 `~/.herdr-agent` 时原地沿用，保留配置和对话。

新建 AI 任务默认由 pi 根据真实执行结果持续调度：自主分派、复核、返工并委托参与者汇总交付，不再要求每一步人工接力。历史任务及显式手动/轮转策略保留调度模式；交付仍等待用户验收，普通审批仍由用户选择。中断、投递核验和本分支验证边界见[持续调度审计](docs/ai-orchestration-audit-2026-09-25.md)。

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
3. Web 可添加、编辑或删除项目登记，设置默认项目、默认参与者及新任务的 Bypass。按顺序填写已存在的目录；保存时检查全部目录，首目录需要时自动初始化 Git，附加目录按原顺序传给 Claude/Codex。删除登记不删除代码；项目和 Bypass 修改用于新任务，不改动已有执行会话。模型连接也可在 Web 保存，启用时必须显式填写 `base_url`，模型配置修改后重启服务。任务、讨论和审批仍通过飞书提出。
4. 运行 `myrix serve --open`，打开日志打印的本机地址。Web 用于维护本机配置和查看已有会话记录；先停止 serve 再运行 setup，它们使用同一把状态锁。

```sh
myrix setup --app cli_EXISTING_APP
myrix setup --update-permissions
myrix serve --config-listen 127.0.0.1:18790
myrix doctor --json
```

已有应用启用任务功能时，需在飞书开发者后台配置事件订阅方式，添加 `task.task.update_user_access_v2` 并发布应用版本，才能让手动完成任务的事件送达服务。逐任务调用 API 订阅不能替代后台事件配置与应用发布；setup 的 scope 检查不检查后台事件订阅。

`myrix configure --listen 127.0.0.1:0 --open` 继续保留，用于不连接飞书地启动本机配置和会话记录页；网页及 HTTP 接口只开放受保护的本机配置写入口，不开放业务操作。该 CLI 启动仍会打开和迁移本地状态，并可能由既有调度器处理已排队工作；只读承诺针对浏览行为，不表示整个服务启动没有业务副作用。业务操作从飞书发起，安装维护仍用 CLI 与配置文件；连接不可用不能静默取消远端资源意图。端口 0 会打印实际可用地址。`myrix serve --no-config-ui` 可关闭页面。启动补授权只更新同一个 App ID，不以网络故障自动新建应用。`setup --reregister --yes` 才明确要求创建替代应用。

飞书凭据优先级为进程环境 → 状态目录 `.env` → 仓库 `.env`。`.env` 使用字面 `KEY=VALUE`：引号、`#`、`=` 都是值的一部分，不支持 shell `export`。模型 key 与 memory key 只从 TOML 读取。不要把包含 key 的配置提交到仓库。

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

AI 新建任务默认使用模型调度。应用不设置决策次数、讨论轮次、累计时长或工具调用次数配额，AI 预算交由配置的网关统一管理；显式 `round_robin` 讨论持续到暂停或结束。单次操作超时和模型上下文容量管理用于恢复卡住的调用及处理过长请求。可以指定参与者或暂停。多个同种模型实例有不同 participant ID。普通文本不是权限菜单批准，审批使用实际卡片/屏幕选项；结果未知时不能自动重发。

任务身份和创建锁都绑定当前 pi session。在另一个 session 中复用 request/message ID 会创建独立任务，不会把无关项目的创建串行阻塞。任务群解散后，程序仍保留任务和会话历史记录，但迟到消息和卡片回调会在入口以及 inbox 执行前再次拒绝，不会回落到主 pi session，也不会消费审批。飞书断线重连时，旧任务调度器会先停止，再由新连接启动调度器重新核对当前记录；旧连接不会继续对新连接的同一批记录执行操作。

参与者启动时，pi 只会在目录确实属于授权任务项目、且现场是 Claude/Codex 原生目录信任提示时自动确认。未启用模型调度的 `manual` 讨论只自动尝试首位参与者；后续参与者等待用户或调度器安排。只有当前事实明确显示任务群已经发布仍有效的审批卡时，`blocked` 参与者才提示用户去群里处理；没有群或卡片发布事实时只说明参与者处于 blocked，不能假定存在审批卡。只有上一位参与者产生已核验输出后，`round_robin` 才会自动转交下一位。其他审批提示都留在任务群中，由用户明确选择。项目或任务的 Bypass 仍是显式配置；目录信任的自动处理不会隐式开启 Bypass。

新任务在 completed 完成确认后默认自动解散群；用户明确保留时使用 `keepGroup: true`。review 不触发解散，明确保留证据继续有效；旧默认或来源不明的保留值在完成/关闭时采用解散，不批量改写活跃旧任务。`complete`（含飞书手动完成）默认通过 herdr 关闭对应执行器并按快照处理群；无论因何种原因解散群，都会关闭对应的 herdr Claude/Codex session。明确 `keepExecution: true` 保留执行器是例外，有群任务必须同时 `keepGroup: true`；`close` 确认完成后关闭受管执行资源；`destroy` 不自动验收；`reopen` 用于保留现场的已完成任务。若执行器已关闭而群仍保留，之后可明确要求解散该群：pi 使用 `destroy` 加 `keepGroup: false`，已验收任务也可使用 `close`。这不会重启执行器或改写原验收事实。任务结束和 pi session 归档是独立操作。默认共享项目目录；显式 worktree 只隔离首目录，其余附加目录仍共享，关闭时不删除代码或 worktree。

主入口飞书私聊达到配置的上下文容量时会自动压缩 pi 历史，保留原始记录和持久化操作回执。只有用户需要手动开启新会话时，才在主入口私聊单独发送 `/clear`；程序直接归档旧 pi session 并创建、选中新 session，事务成功后只回复 `CLEAR_NEW_SESSION_OK`。关闭 AI 或模型不可用时也可用；保留历史、任务和 herdr session，群聊拒绝。只匹配实际正文去掉前后空白后恰好为 `/clear` 的消息；引用内容、`/CLEAR`、`／clear`、`/clear now` 或正文中提到 `/clear` 不触发。Web 没有聊天框、`/clear` 或清空按钮；查看另一段历史不改变飞书活跃 session。

AI 开启时，其余聊天文本由模型理解，包括斜杠形式。关闭 AI 后仍保留任务模式的 `/new /tasks /projects /task /screen /stop` 等兼容入口；关闭 tasks 后可以用 `/ls /card /say /stop /mirror /close` 接管已有 agent。旧桥 `/close` 仅解除选择，不销毁任务。

旧桥 `/ls` 只列出由 herdr 托管的 Claude/Codex agent；普通 shell pane 不属于可接管目标，也不会出现在选择卡片中。

日常 CLI 为 `serve / setup / configure / doctor / version / help`；`configure` 现用于本地配置和会话记录页，旧 Web 业务管理控件已移除，维护入口为 `migrate` 与只读 `debug ls|screen|transcript`。旧顶层 `key / say / watch / dialog / tail` 等已退出，终端输入通过飞书参与者调度，普通审批在飞书群内由用户选择。`help` 列出有效参数。退出码：0 成功、1 失败、2 用法错误、3 setup 凭据已保存但验证未完成、130 取消；旧 Go 的所有退出码并非逐项兼容。

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

自动化覆盖真实 pi 循环、协议替身、SQLite/flock/Git、迁移与独立二进制，业务验收必须有真实飞书用户入站、群内交互和实际回读，并关联模型工具回执及 herdr 现场；直接 Web/API 操作不能替代该链路。Web 配置写入与历史浏览另行验收。当前支持文字和富文本中的文字；图片理解、语音转写、文件制品托管不在首版范围。

[当前业务场景与命令取舍](docs/current-business-scenarios.md) 汇总现行入口、职责和遗漏检查。[需求盘点](docs/node-pi-refactor-requirements.md) 是 Go 基线历史快照；[旧代码审计](docs/code-audit.md) 等历史材料已标注版本，不能当作 Node 当前能力说明。B/N 场景的早期离线证据见 [acceptance.md](docs/acceptance.md)，当前尚待核对项目和部署证据见[现场验收矩阵](docs/live-validation.md)。

本项目采用 MIT，见 [LICENSE](LICENSE)。发布包另带 `LICENSES/`，保留嵌入 npm 依赖、原生扩展和 Node 的许可及第三方声明；重新分发请一并保留。生成规则见 [licenses](licenses/README.md)。
