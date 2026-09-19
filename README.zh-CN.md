# myrix

[English](README.md) · [npm](https://www.npmjs.com/package/@yuebanlaosiji/myrix) · [下载 Release](https://github.com/hewenyu/herdr-agent/releases)

基于 **Node、TypeScript 和 pi** 的本地调度工具，通过 **@yuebanlaosiji/myrix** 分发。在飞书中创建项目、组织需求讨论和开发任务、跟进结果；本机 Web 用于配置项目和模型、查看会话记录。

**pi 管理本工具的项目、任务、参与者和会话；herdr 托管 Claude/Codex 及其原生 session。** 用户项目的需求讨论、设计、开发、测试和评审交给 Claude/Codex。可以让它们进入同一个任务群，也可以启动同类模型的多个参与者，为不同项目分别创建任务。

pi 会话保存调度上下文；任务中的 Claude/Codex session 是通过 herdr 管理的独立执行资源。切换或清空主入口 pi 会话，不会关闭这些执行器。

AI 开启时，普通回复、生命周期通知和工具选择由模型决定。程序提供工具、权限检查和持久化操作回执；明确的业务请求至少要尝试一次工具调用，模型只回复“收到”等确认文字时不能算请求完成；能力说明或解释性问题仍按普通对话处理。对已经执行的业务动作要求真实写入证据，生命周期通知以当前任务与参与者快照为依据，仅开放只读工具。精确的 `/clear` 命令由程序直接轮转主私聊 pi session，不调用模型。

前后端均使用 TypeScript，连同 Node 和原生锁扩展一体打包为可执行文件。仓库名、独立二进制名和状态目录继续保留 `herdr-agent`、`~/.herdr-agent`，兼容已有安装。

从飞书创建任务或向参与者续聊时，程序保留并转交当前用户原文，将其与 pi 整理的分派摘要分开。路径、顺序、禁止项等明确约束以用户原文为准；远端任务描述超出长度限制时会提示截断，完整原文仍保存在本地记录并交给参与者。旧任务不自动重写或重新投递。

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
npm install -g @yuebanlaosiji/myrix@0.3.13
npm install -g @yuebanlaosiji/myrix@latest
```

`0.3.13` 是已发布版本示例，npm 版本号不带 tag 的 `v` 前缀。全局安装会替换当前安装版本；也可以在本地 npm 项目中固定版本：

```sh
npm install --save-exact @yuebanlaosiji/myrix@0.3.13
npx --no-install myrix version --json
```

无需安装 Node 的方式：从 [Releases](https://github.com/hewenyu/herdr-agent/releases) 下载对应平台压缩包，解压并核对随包发布的 `SHA256SUMS`，再使用包内可执行文件：

```sh
./herdr-agent version --json
./herdr-agent setup
./herdr-agent serve
```

启用任务调度前请完成下文配置。两种安装方式都需要本机 herdr、Git，以及已登录的 Claude/Codex CLI。Linux 需要兼容的系统库；macOS 包使用 ad-hoc 签名，尚未公证。平台要求和校验命令见对应 Release 说明。

## 发布与验收状态

最新稳定版见 [Releases](https://github.com/hewenyu/herdr-agent/releases/latest)，安装版本、源码提交和构建时间通过 `myrix version --json` 查看。本文说明当前源码行为，各已发布版本包含的改动以对应 Release 为准。根目录的 `package.json` 是私有源码包，不是公开发布的 npm 主入口包。

推送 `v*` tag 后，GitHub Actions 自动完成三平台原生构建与烟测、完整 npm 分发的离线安装验证、平台包及主入口包发布，最后创建 GitHub Release。npm 发布使用 GitHub environment `NPM` 的 `TOKEN`。Actions 内部的 artifact 下载只是组装发布包的工作流步骤；用户直接从 npm 安装 `@yuebanlaosiji/myrix` 或下载 Release 压缩包，不需要选择 workflow 的 download 选项。版本规则与失败恢复见[发布说明](docs/releasing.md)。

全量真实验收仍为 **R-部分，持续进行中**。[现场验收矩阵](docs/live-validation.md) 按 B/N 场景分开记录实现、自动化检查和真实飞书/herdr 证据，保留通过项与未解决的失败。构建通过或某个任务完成，都不代表所有场景通过。[E37](docs/live-evidence-e37-create-delivery.md) 记录了从创建到确认完成、资源清理的限定链路复验，之前的失败仍保留在关联证据中。

[E38](docs/live-evidence-e38-multi-project.md) 记录了 Web 多目录配置、独立 pi 会话，以及前一任务阻塞时继续创建第二个项目的结果；同时暴露了配置反馈、需求原文传递和目录信任问题。修复后的开发版已恢复第二项目的真实 Codex 执行，核对产物并清理测试资源。随后 [E39](docs/live-evidence-e39-source-approval.md) 已限定复验 Web 添加/编辑错误反馈、旧任务配置冻结，以及 Claude/Codex 新任务的原文传递和产物；同时发现创建回复、审批选项与通知措辞问题。这些修复后的真实复验、剩余会话组合及 E39 测试资源清理仍未完成。

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
./dist/herdr-agent version --json
```

`check` 执行 1000 行上限检查、TypeScript、Biome 格式/lint 和测试。`build` 生成带静态资源的 `dist/herdr-agent.cjs`；`binary` 会重新构建应用并在当前系统生成 `dist/herdr-agent`，包含 Node 和原生扩展。`smoke` 将单个可执行文件复制到空临时目录，验证嵌入资源、锁、SQLite、历史浏览、受保护的配置写入和业务写请求拒绝。模型烟测先在隔离状态中排入飞书适配器事件，再由复制后的 SEA 执行 pi 循环和本地 Responses/Anthropic 协议替身；GET 查看记录不 ACK，没有飞书连接时回复保持未送达。这属于打包验证，不连接真实飞书/herdr/模型服务。macOS 本机烟测通过不代表 Linux 已通过；各平台证据见验收文档。

开发时可用 `npm run dev -- help`；本地 Web 资源以构建后的程序为验收入口。后续示例使用 npm 安装后的 `myrix`；源码构建时可替换为 `./dist/herdr-agent`。

## 配置与启动

1. 将 [配置示例](deploy/config.example.toml) 放入状态目录（默认 `~/.herdr-agent/config.toml`），仅本人可读。需要任务/pi 时先设置 `tasks.enabled = true`，使 setup 检查任务与群权限。
2. 运行 `myrix setup`，复用已有应用或按链接完成授权，再发送一条私聊并点击验证卡片。只有两次往返通过才算完整验证。setup 会保存 `.env` 和允许用户。
3. 运行 `myrix serve --open`，打开日志打印的本机页面，配置项目目录和 pi 模型连接。模型启用时必须显式填写 `base_url`，保存模型配置后重启服务。
4. 在飞书主私聊创建任务，在任务群中续聊和审批。Web 用于本机配置和会话记录；需要重新运行 setup 时先停止 serve，它们使用同一把状态锁。

```sh
myrix setup --app cli_EXAMPLE123
myrix setup --update-permissions
myrix serve --config-listen 127.0.0.1:18790
myrix doctor --json
```

已有应用启用任务功能时，需在飞书开发者后台配置事件订阅方式，添加 `task.task.update_user_access_v2` 并发布应用版本，才能让手动完成任务的事件送达服务。逐任务调用 API 订阅不能替代后台事件配置与应用发布；setup 的 scope 检查不检查后台事件订阅。

Web 页面分为三个区域：

| 页面 | 可用操作 | 生效范围 |
| --- | --- | --- |
| 项目配置 | 添加、编辑、删除本机项目登记，选择默认项目及其 Claude/Codex 参与者，设置 Bypass | 新任务采用保存后的配置，已有任务快照不变 |
| 模型设置 | 保存 pi 的协议、模型、明确的 Base URL、API Key 和启用状态 | 保存后重启服务 |
| 会话记录 | 浏览主入口与任务会话、消息和已记录的工具活动 | 浏览不发送消息、不确认送达、不切换飞书活跃会话 |

项目目录**每行填写一个已存在的绝对路径**，第一项是主工作目录。保存时检查全部目录，主目录需要时自动初始化 Git；附加目录按保存的顺序传递给 Claude/Codex。删除项目登记不会删除代码。飞书权限、轮询、记忆等其他服务配置通过 `setup` 或文档所列配置文件维护。

`myrix configure --listen 127.0.0.1:0 --open` 可不连接飞书地启动本机页面；端口 0 会打印实际可用地址，Web 只接受 loopback IP。网页及 HTTP 接口开放受保护的本机配置写入口，任务创建、讨论与审批在飞书进行。启动 `configure` 仍会打开和迁移本地状态，也可能由调度器处理已排队工作；浏览记录本身是只读操作。`myrix serve --no-config-ui` 可关闭页面。启动补授权只更新同一个 App ID，不以网络故障自动新建应用；`setup --reregister --yes` 才明确创建替代应用。

飞书凭据优先级为进程环境 → 状态目录 `.env` → 仓库 `.env`。`.env` 使用字面 `KEY=VALUE`：引号、`#`、`=` 都是值的一部分，不支持 shell `export`。模型 key 与 memory key 只从 TOML 读取。不要把包含 key 的配置提交到仓库。

长期运行使用 [deploy](deploy/) 中的 launchd/systemd user 模板与安装脚本；先检查路径与运行账户。服务 stdout/stderr 由服务管理器收集。停止桥接程序不等于销毁已在 herdr 中运行的任务。

## 使用方式

在飞书主私聊中创建项目、任务或切换 pi session，在对应任务群中续聊和处理审批。讨论可以不绑定项目；开发、评审和测试任务使用已配置项目。可对 pi 说：“开个讨论任务，让 Claude 和 Codex 一起讨论这个需求”“把已确认方案交给 Codex 实现，Claude 评审”“切回昨天的调度会话”。pi 调用工具组织工作，参与者负责业务内容。一个机器人在群内标明发言来源，Claude/Codex 不是另两个飞书账号。

首位参与者在执行环境就绪后自动接收初始要求。单参与者任务没有下一位接棒者，输出后等待用户续聊或验收。多参与者讨论默认最多 4 轮、30 分钟；可以指定参与者或暂停。多个同种模型实例有不同 participant ID。普通文本不是权限菜单批准，审批使用实际卡片/屏幕选项；结果未知时不能自动重发。

任务身份和创建锁都绑定当前 pi session。在另一个 session 中复用 request/message ID 会创建独立任务，不会把无关项目的创建串行阻塞。任务群解散后，程序仍保留任务和会话历史记录，但迟到消息和卡片回调会在入口以及 inbox 执行前再次拒绝，不会回落到主 pi session，也不会消费审批。飞书断线重连时，旧任务调度器会先停止，再由新连接启动调度器重新核对当前记录；旧连接不会继续对新连接的同一批记录执行操作。

参与者启动时，pi 只会在目录确实属于授权任务项目、且现场是 Claude/Codex 原生目录信任提示时自动确认。`manual` 讨论只自动尝试首位参与者；后续参与者等待用户或调度器安排。只有当前事实明确显示任务群已经发布仍有效的审批卡时，`blocked` 参与者才提示用户去群里处理；没有群或卡片发布事实时只说明参与者处于 blocked，不能假定存在审批卡。只有上一位参与者产生已核验输出后，`round_robin` 才会自动转交下一位。其他审批提示都留在任务群中，由用户明确选择。项目或任务的 Bypass 仍是显式配置；目录信任的自动处理不会隐式开启 Bypass。

**任务确认完成后，默认一起关闭任务群与对应 Claude/Codex session。** 在飞书手动确认完成也适用，执行器由 herdr 关闭。参与者输出或进入 `review` 本身不等于任务已完成，也不触发解散；无论因何种原因解散群，关联的 herdr 执行 session 都要关闭。

用户明确要求保留时可以覆盖默认行为：`keepGroup: true` 保留群；`keepExecution: true` 还保留执行器，有群任务必须同时保留群。`close` 确认完成后清理，`destroy` 清理但不自动验收，`reopen` 用于仍保留执行资源的已完成任务。保留群可以之后再明确解散：使用 `destroy` 加 `keepGroup: false`，已验收任务也可使用 `close`，不会重启执行器或改写原验收事实。旧默认或来源不明的保留值在开始关闭时处理，不批量改写活跃旧任务。

任务清理与 pi session 归档是独立操作，代码、会话历史和 worktree 保留。默认共享项目目录；显式 worktree 只隔离首目录，其余附加目录仍共享。

主入口飞书私聊达到配置的上下文预算时会自动压缩 pi 历史，保留原始记录和持久化操作回执。只有用户需要手动开启新会话时，才在主入口私聊单独发送 `/clear`；程序直接归档旧 pi session 并创建、选中新 session，事务成功后只回复 `CLEAR_NEW_SESSION_OK`。关闭 AI 或模型不可用时也可用；保留历史、任务和 herdr session，群聊拒绝。只匹配实际正文去掉前后空白后恰好为 `/clear` 的消息；引用内容、`/CLEAR`、`／clear`、`/clear now` 或正文中提到 `/clear` 不触发。Web 没有聊天框、`/clear` 或清空按钮；查看另一段历史不改变飞书活跃 session。

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
