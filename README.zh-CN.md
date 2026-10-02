# myrix

**在飞书中指挥本机的 Claude 与 Codex 协作。**

[English](<README.md>) · [npm](https://www.npmjs.com/package/@yuebanlaosiji/myrix) · [下载 Release](https://github.com/hewenyu/herdr-agent/releases)

myrix 把飞书对话变成讨论需求、开发功能、修复问题和评审结果的工作入口。它使用 **pi 编排任务**，通过 **herdr 托管本机的 Claude／Codex 原生会话**。代码仓库和执行环境留在你的机器上，你在飞书中下达要求、查看进展并验收交付。

仓库名是 `herdr-agent`，当前应用与命令名是 **myrix**。

## 能做什么

- **先讨论，再实现。** 让 Claude 和 Codex 比较方案、相互质疑并形成结论；需要把讨论结果写入项目时，明确要求交付文档。
- **安排开发与修复。** 将任务绑定到已登记项目，分配实现者与独立评审者，也可以把讨论上下文带入关联的新任务。
- **在飞书中掌握进展。** 查询状态、修改要求、暂停调度、中断指定参与者或处理审批卡片。
- **获取完整交付。** 当前工作流发送简短摘要和 Markdown 报告附件，不把每一轮内部交流都转发到群里。
- **保留可追溯记录。** 任务状态、会话和操作回执存入 SQLite；重启恢复依据已确认的事实，不盲目重复外部操作。

```text
飞书私聊 / 任务群
       ↓
myrix · pi 任务编排
       ↓
herdr · 原生 Claude / Codex
       ↓
本机项目目录

本机 Web：配置、会话历史、报告下载
```

Web **不是另一个聊天或任务控制入口**。业务要求、审批和验收都在飞书完成。当前工作流为每个任务维护独立、持久化的 pi Leader；可选的 Jev 用于私聊分类和原生审批菜单辅助，不负责工作流调度。

> 本文说明当前源码的行为，已安装版本可能不同；请通过 `myrix version --json` 和 Release 说明核对。完整真实链路验收仍是部分完成，范围见[现场验收矩阵](<docs/live-validation.md>)。

## 安装

### 前置条件

- **macOS Apple Silicon**、**Linux x64** 或 **Linux arm64**。Linux 要求 **glibc**，不支持 Alpine/musl；不提供 Windows 和 Intel macOS 二进制产物。
- 正在运行的 **herdr server，协议版本至少为 19**；**Git**；以及准备使用且已在本机完成认证的 **Claude 和／或 Codex CLI**。双执行器讨论需要两者都可用。
- **国内飞书**账号，以及注册或授权应用的权限。当前接入流程不支持 Lark 应用。
- 用于 pi 编排的模型和 API 端点，支持 **OpenAI Responses** 或 **Anthropic Messages** 协议及工具调用。这与原生 Claude／Codex 的登录配置相互独立。

为需要使用的 CLI 安装 herdr 集成：

```sh
herdr integration install claude
herdr integration install codex
```

完成原生 CLI 要求的 hook／信任确认，尤其是 Codex。从普通终端或经过检查的服务配置启动 herdr，不要从 coding agent 会话内部启动：继承的 agent 环境变量可能让 transcript 停止记录。详见[herdr 服务配置](<deploy/herdr-server.service>)。

### 使用 npm

启动器要求 **Node.js 18 或以上**；实际应用二进制自带 Node 运行时。

```sh
npm install -g @yuebanlaosiji/myrix
myrix version --json
myrix help
```

请保留 npm 的 optional dependencies：对应平台的原生程序通过可选平台包分发。

### 不安装 Node.js

从 [Releases](https://github.com/hewenyu/herdr-agent/releases) 下载对应平台压缩包，核对发布的 `SHA256SUMS` 后解压。下文的 `myrix` 可替换为 `./myrix`，也可以将程序放入 `PATH`。

压缩包包含运行时和 Web 资源，但不包含 herdr、Git 或 agent CLI。Linux 仍需兼容的系统库；macOS 二进制使用 ad-hoc 签名，未公证。具体平台要求以 Release 说明为准。

## 首次运行

### 1. 配置调度模型

新安装默认使用 `~/.myrix`。如果已有 `~/.herdr-agent`，程序会优先沿用它；升级时请继续使用原目录。需要其他位置时，为各条命令统一指定 `--state-dir /绝对路径`。

创建状态目录，在其中保存以下 `config.toml`。将三个 `YOUR_…` 占位值替换为模型服务的实际配置；`base_url` 必须显式填写 API 版本根地址，例如 OpenAI 的 `https://api.openai.com/v1`。

```toml
[tasks]
enabled = true
bypass = false

[ai]
enabled = true
provider = "openai-responses"
base_url = "YOUR_API_BASE_URL"
model = "YOUR_MODEL_ID"
api_key = "YOUR_API_KEY"
```

使用 Anthropic 兼容服务时，改为 `provider = "anthropic-messages"`，并填写对应的 API 版本根地址。仅支持 Chat Completions 的端点不能替代这两种协议。请保护状态目录和凭据文件，例如目录权限 `0700`、文件权限 `0600`。

**示例特意关闭了 Bypass，但程序的实际默认值是 `true`。** Bypass 会使用原生 agent 的权限／沙箱绕过参数启动执行器，只应在可信执行环境中启用。任务编排和 AI 则默认关闭，需要显式启用。

更多选项见[配置示例](<deploy/config.example.toml>)。项目可以等 Web 页面启动后再登记；普通 pi 工作流不需要 Jev key。

### 2. 接入飞书

先确认已设置 `tasks.enabled = true`，再运行：

```sh
myrix setup
```

按提示完成授权，向机器人发送一条真实私聊消息，再点击它发送的 **“确认连接”** 按钮。Setup 会保存应用凭据，并把验证通过的用户加入允许名单；允许名单为空时，不授予任何飞书用户访问权限。

Setup 通常会复用已有应用。需要明确选择应用或补充任务／群权限时：

```sh
myrix setup --app cli_YOUR_APP_ID
myrix setup --update-permissions
```

运行 setup 前先停止正在运行的 myrix。不要为了修复权限而重新注册应用。退出码 `3` 表示凭据已保存，但消息／卡片验证尚未完成。

已有应用启用任务功能后，还需在飞书开发者后台订阅 `task.task.update_user_access_v2`，并**发布应用版本**，否则用户手动完成飞书任务的事件可能无法到达 myrix。Setup 的 scope 检查不会验证后台事件订阅。

### 3. 启动服务并登记项目

```sh
myrix doctor
myrix serve --open
```

本机页面默认位于 **http://127.0.0.1:18790**。登记已有项目、选择目录与默认执行器，并在开始工作前检查 Bypass 设置。保存项目时，如果首目录还不是 Git 仓库，程序会执行 Git 初始化。

首目录是主工作目录，其他目录作为附加目录传给原生 agent。首次初始化后，项目目录库和 Bypass 设置以 SQLite 为准；请通过本机页面修改，不要再编辑最初的 TOML 种子来更新它们。修改模型或 Jev 连接设置后需要重启。

`doctor` 检查配置、主机集成与飞书权限，**不会**请求模型，也不能证明 CLI 已登录。请用一个小型真实任务验证完整链路。

### 4. 给机器人一个任务

下面是自然语言示例，不是特殊命令语法。将 `demo` 换成你登记的项目名：

| 目标 | 在飞书中发送 |
| --- | --- |
| 比较方案 | “为 demo 创建一个讨论任务，让 Claude 和 Codex 比较两种缓存方案，不要修改文件。” |
| 交付设计文档 | “讨论缓存设计，把达成一致的方案保存到 docs/DESIGN.md，不要实现业务代码。” |
| 开发功能 | “为 demo 创建开发任务：实现刚才确定的缓存方案，Codex 负责实现，Claude 负责评审。” |
| 修复问题 | “为 demo 创建修复任务：复现登录超时，修复并评审改动。” |
| 查询进度 | “现在进展怎样？卡在哪里？哪些结果已经实际验证？” |
| 验收交付 | “我确认这个任务验收完成。保留任务群，关闭执行会话。” |

请在私聊中创建新任务，每个任务支持 **1–8 名 Claude／Codex 参与者**。任务群固定绑定对应任务，可以补充要求和查询状态，但不能在群内另建任务。群内由同一个飞书机器人代表参与者，不会创建独立的 Claude、Codex 机器人账号。当前工作流保留内部交流，仅发送必要的开始／阻塞通知和最终交付；需要了解过程时，直接询问进度。

**任务已排队不等于执行器已启动，报告已送达不等于任务已验收，终端空闲也不等于工作完成。** 请阅读报告后明确确认验收。

## 默认行为与安全边界

| 项目 | 需要了解的行为 |
| --- | --- |
| 完成与清理 | 确认完成后，默认关闭该任务的 herdr 执行会话并解散任务群。需要保留群时请明确提出，或用 `runtime.group_retention = "retain"` 配置新任务。存在任务群时，保留执行会话也必须同时保留群。 |
| 暂停与中断 | 暂停停止后续调度，不一定停止正在运行的 agent；需要立即中断时，请指定参与者。 |
| 工作目录 | 任务默认使用共享项目目录。显式 worktree 模式只隔离首目录，附加目录仍共享；关闭任务不会删除项目代码或 worktree。 |
| 执行权限 | Bypass 不是操作系统沙箱，关闭 Bypass 也不意味着 myrix 提供沙箱。讨论／只读要求和工作流检查不能替代原生文件系统权限。 |
| 验证命令 | myrix 验证器只执行本机配置的项目 `verify` 命令，在任务工作目录中使用服务账号权限运行，也可能执行被 agent 修改的脚本。仅对可信工作区启用。报告会区分命令结果、独立 agent 评审、参与者自述和未执行的检查。 |
| 重启恢复 | 状态与回执会持久保存。外部结果未知时不会盲目重放，需要核对，必要时请用户决定。仅停止 myrix 不会销毁 herdr 会话。 |
| 本机 Web | 只监听回环地址，面向可信的本机用户，不是公开或多用户 Web 服务；没有业务聊天、参与者控制或验收按钮。 |

### 可选的 Jev 集成

任务编排**不要求**配置 Jev。添加 Jev key 前，请了解：

- `jev.ingress_enabled` 默认 **false**。启用后，会把适用的私聊原文和已登记项目名发送给 Jev 分类。
- `jev.approvals_enabled` 默认 **true**，在 AI 已启用且存在 Jev key 时生效。它会把可见终端屏幕和任务／用户要求发送给 Jev，辅助处理原生菜单，必要时回退到受限 pi。设为 `false` 并重启后，普通审批保留手动处理；独立的受限启动目录信任流程仍会保留。
- 自动菜单处理不会替你验收任务，也不能代替账号登录或用户业务决策。

添加密钥前请确认能接受这些数据流向，细节见[原生审批说明](<docs/native-approval-recovery-2026-09-29.md>)。配置的 AI 服务也会接收调度所需的对话与任务上下文；本机执行不等于所有数据都离线处理。

## 日常运行

| 命令 | 用途 |
| --- | --- |
| `myrix serve --open` | 连接飞书并打开本机页面；不指定子命令时默认执行 `serve`。 |
| `myrix serve --no-config-ui` | 不启动本机 Web 监听。 |
| `myrix serve --config-listen 127.0.0.1:18791` | 更换回环监听地址／端口。 |
| `myrix configure --open` | 不连接飞书，打开配置和历史页面。共用状态锁；已有本机任务的后台对账仍可能运行。 |
| `myrix status` | 检查状态锁、进程，以及可用的停止／重启指引。 |
| `myrix doctor` | 只读检查配置与主机环境。 |
| `myrix version --json` | 查看当前安装命令的版本与构建身份。 |
| `myrix debug ls` | 列出原生 agent；`debug screen PANE`、`debug transcript PANE` 也仅用于只读诊断。 |
| `myrix help` | 查看全部命令与选项，包括 `--state-dir` 和 `--json`。 |

在机器人的**主入口私聊**中，单独发送 `/clear`，可归档当前 pi 会话并选中新会话。该操作无需模型回复，保留任务状态、历史和原生会话；成功后返回 `CLEAR_NEW_SESSION_OK`，群聊不支持。长 pi 上下文也会自动压缩，不删除原始历史。

### 常见问题

- **提示已有实例运行：** 先看 `myrix status`，停止实际前台进程或服务，再运行 setup、迁移或新实例。不要删除仍被持有的锁文件来强行启动第二份。
- **机器人无法连接，或收不到任务完成事件：** 检查 `doctor`、用户授权、所需权限和已发布的飞书事件订阅。
- **Agent 启动但没有进展：** 检查 CLI 登录、herdr hooks、目录信任提示和 herdr server 环境。先查询任务的真实阻塞状态，不要反复提交相同任务。
- **模型配置无效：** 停止服务，用 `myrix configure --open` 修复支持恢复的配置错误，再重启。模型失败不会把用户原文悄悄转交给终端。
- **需要查日志：** 启动时会打印日志位置，服务日志在所选状态目录的 `log/` 下，详见[日志指南](<docs/local-service-logs.md>)。`status` 显示持锁不代表服务健康；新安装命令的版本也可能不同于尚未重启的进程。

需要后台常驻时，请先阅读 [macOS 安装脚本](<deploy/install.sh>) 或 [Linux myrix 单元](<deploy/myrix.service>)、[herdr 单元](<deploy/herdr-server.service>)，核对可执行文件路径、环境和状态目录设置。前台快速开始不需要安装这些服务。

### 升级与旧版迁移

停止服务及自动重启，备份状态目录，更新包或二进制，然后使用**原状态目录**重新启动。不要让两个进程同时消费同一个飞书应用的事件。

从旧 Go 版本迁移时，先预览，再执行导入：

```sh
myrix migrate --state-dir /absolute/state --dry-run
myrix migrate --state-dir /absolute/state
```

迁移会备份旧 JSON，再导入 SQLite；正常启动也会执行幂等导入。没有自动反向迁移，仅恢复旧 JSON 无法撤销升级后创建的外部任务、群和会话。详见[迁移设计](<docs/node-pi-design.md>)与[发布指南](<docs/releasing.md>)。

## 开发

源码构建要求 **Node.js ≥24.13.0**、npm、Python，以及构建原生依赖 `fs-ext` 所需的 C++／make 工具链；macOS 需要 Command Line Tools。

```sh
git clone https://github.com/hewenyu/herdr-agent.git
cd herdr-agent
npm ci
npm run check
npm run binary
npm run smoke
./dist/myrix version --json
```

- `npm run check`：源文件大小、模块边界、TypeScript、Biome 零警告检查与自动化测试。
- `npm run build`：打包程序和 Web 资源；`npm run binary` 包含此构建步骤，并生成当前平台的独立可执行文件。
- `npm run smoke`：使用隔离替身验证独立程序的打包结果，不能证明真实飞书／模型／herdr 部署已经可用。
- `npm run dev -- help`：从源码运行 CLI；验证内嵌 Web 资源时请使用构建后的程序。

各目标平台必须分别原生构建。打包还需要 Node 发行版的完整许可证文件；若构建提示缺失，请使用保留该文件的官方 Node 发行版。根目录的[包清单](<package.json>)是私有源码包，不是公开发布的 npm 启动器包。

## 延伸阅读

专题文档主要使用中文。带日期的记录说明对应阶段的实现与验证，不代表整个发布版本已经获得同等保证。

| 主题 | 文档 |
| --- | --- |
| 配置选项 | [配置示例](<deploy/config.example.toml>) |
| 产品行为与边界 | [业务场景盘点](<docs/current-business-scenarios.md>) |
| 当前任务编排 | [持久化任务 Leader](<docs/durable-task-leader-context.md>) |
| 工作流、报告与交付 | [Workflow v3](<docs/workflow-natural-collaboration-2026-09-28.md>) · [后续 pi 与恢复调整](<docs/pi-leader-iteration-2026-09-29.md>) |
| 原生执行器启动与恢复 | [Agent 生命周期](<docs/agent-lifecycle-readiness.md>) |
| 离线与现场证据 | [验收映射](<docs/acceptance.md>) · [现场验收矩阵](<docs/live-validation.md>) |
| 贡献与发布 | [代码质量指南](<docs/code-quality.md>) · [发布操作](<docs/releasing.md>) |

当前消息输入支持文本和富文本帖子中的文本。图片理解、语音转写和通用产物托管不在当前范围内；已支持报告附件及受作用域限制的本机报告下载。

## 许可证

[MIT](<LICENSE>)。Release 压缩包还附带第三方许可证，再分发时请一并保留，详见[许可证打包说明](<licenses/README.md>)。
