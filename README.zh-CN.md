# herdr-agent

[English](README.md)

用 pi 调度本工具的项目、任务、参与者和多个会话，通过 **herdr 托管的 Claude/Codex** 讨论需求、开发、测试和评审。飞书是远程入口，本机 Web 管理会话、任务、参与者和项目。

**pi 只做 herdr-agent 的业务调度。** 用户项目的需求讨论和实际开发交给 Claude/Codex；它们的原生 session 由 herdr 管理。AI 开启时，模型决定普通业务沟通和工具调用，程序提供工具、身份与状态约束。exact `/clear` 是直接执行、不调用模型的会话命令。

后端、前端均为 TypeScript，使用 Node SEA 一体打包。普通用户运行可执行文件，无需另装 Node 或放置前端资源。设计与取舍见 [实施设计](docs/node-pi-design.md)，实际验证范围见 [验收证据](docs/acceptance.md)。

## 运行前置

- 本机 herdr 可用，其 Unix socket 可访问。
- 需要的 Claude/Codex CLI 已安装并完成登录；Git 可用。
- 飞书国内版自建应用，通过 `setup` 注册或复用。当前 CLI 不接纳 Lark 海外应用。
- 使用 pi 时配置支持工具调用的 OpenAI Responses 或 Anthropic Messages 模型服务。
- 目标平台：macOS arm64、Linux x64/arm64。使用对应平台的原生构建；不能把 macOS 包复制到 Linux 使用。原生 flock 扩展仍依赖兼容的系统 C++ 运行库。

这是单人单机工具。本机页面只监听 loopback IP，可在配置白名单中的身份之间切换，默认使用首个允许身份；这不是远程 Web 登录或多租户管理。

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

`check` 执行 1000 行上限检查、TypeScript、Biome 格式/lint 和测试。`build` 生成带静态资源的 `dist/herdr-agent.cjs`；`binary` 在当前系统生成 `dist/herdr-agent`，包含 Node 和原生扩展。`smoke` 将单个可执行文件复制到空临时目录，用临时状态验证页面、锁及 API，并用本地 Responses/Anthropic 替身验证二进制内 pi 调度和 Web 送达回执，不连接真实飞书/herdr/模型服务。macOS 本机烟测通过不代表 Linux 已通过；各平台证据见验收文档。

开发时可用 `npm run dev -- help`；本地 Web 资源以构建后的程序为验收入口。后续示例假定可执行文件已放入 PATH；也可把 `herdr-agent` 替换为 `./dist/herdr-agent`。

## 配置与启动

1. 将 [配置示例](deploy/config.example.toml) 放入状态目录（默认 `~/.herdr-agent/config.toml`），仅本人可读。需要任务/pi 时先设置 `tasks.enabled = true`，使 setup 检查任务与群权限。
2. 运行 `herdr-agent setup`，复用已有应用或按链接完成授权，再发送一条私聊并点击验证卡片。只有两次往返通过才算完整验证。setup 会保存 `.env` 和允许用户。
3. 在配置或本机项目页登记目录；设置 `[ai]` 的 `enabled/provider/model/base_url/api_key`。AI 要求任务功能启用；保存模型配置后重启。
4. 运行 `herdr-agent serve --open`，打开日志打印的本机地址。飞书未配置时 Web 仍可用于查看状态；先停止 serve 再运行 setup，它们使用同一把状态锁。

```sh
herdr-agent setup --app cli_EXISTING_APP
herdr-agent setup --update-permissions
herdr-agent serve --config-listen 127.0.0.1:18790
herdr-agent configure --listen 127.0.0.1:0 --open
herdr-agent doctor --json
```

`configure` 启动本机管理模式，不连接飞书，可执行显式本地任务操作。创建纯本地任务需关闭“创建飞书任务群”和“同步创建飞书任务”；默认远端意图不会因连接不可用而静默取消。端口 0 会打印实际可用地址。`serve --no-config-ui` 可关闭页面。启动补授权只更新同一个 App ID，不以网络故障自动新建应用。`setup --reregister --yes` 才明确要求创建替代应用。

飞书凭据优先级为进程环境 → 状态目录 `.env` → 仓库 `.env`。`.env` 使用字面 `KEY=VALUE`：引号、`#`、`=` 都是值的一部分，不支持 shell `export`。模型 key 与 memory key 只从 TOML 读取。不要把包含 key 的配置提交到仓库。

长期运行使用 [deploy](deploy/) 中的 launchd/systemd user 模板与安装脚本；先检查路径与运行账户。服务 stdout/stderr 由服务管理器收集。停止桥接程序不等于销毁已在 herdr 中运行的任务。

## 使用方式

可对 pi 说：“开个讨论任务，让 Claude 和 Codex 一起讨论这个需求”“把已确认方案交给 Codex 实现，Claude 评审”“切回昨天的调度会话”。pi 调用工具组织工作，参与者负责业务内容。一个机器人在群内标明发言来源，Claude/Codex 不是另两个飞书账号。

多参与者讨论默认最多 4 轮、30 分钟；可以指定参与者或暂停。多个同种模型实例有不同 participant ID。普通文本不是权限菜单批准，审批使用实际卡片/屏幕选项；结果未知时不能自动重发。

新任务在 completed 完成确认后默认自动解散群；用户明确保留时使用 `keepGroup: true`。review 不触发解散，明确保留证据继续有效；旧默认或来源不明的保留值在完成/关闭时采用解散，不批量改写活跃旧任务。`complete`（含飞书手动完成）默认通过 herdr 关闭对应执行器并按快照处理群；任何原因群解散均清对应执行资源。明确 `keepExecution: true` 保留执行器是例外，有群任务必须同时 `keepGroup: true`；`close` 确认完成后关闭受管执行资源；`destroy` 不自动验收；`reopen` 用于保留现场的已完成任务。任务结束和 pi session 归档是独立操作。默认共享项目目录；显式 worktree 只隔离首目录，其余附加目录仍共享，关闭时不删除代码或 worktree。

在主入口私聊或 Web 聊天发送 `/clear`，程序直接归档旧 pi session 并创建、选中新 session，事务成功后只回复 `CLEAR_NEW_SESSION_OK`。关闭 AI 或模型不可用时也可用；保留历史、任务和 herdr session，群聊拒绝。只匹配实际正文去掉前后空白后恰好为 `/clear` 的消息；引用内容、`/CLEAR`、`／clear`、`/clear now` 或正文中提到 `/clear` 不触发。Web 显式清空按钮另行重置同一 session 的上下文。

AI 开启时，其余聊天文本由模型理解，包括斜杠形式。关闭 AI 后仍保留任务模式的 `/new /tasks /projects /task /screen /stop` 等兼容入口；关闭 tasks 后可以用 `/ls /card /say /stop /mirror /close` 接管已有 agent。旧桥 `/close` 仅解除选择，不销毁任务。

日常 CLI 保留 `serve / setup / configure / doctor / version / help`，维护入口为 `migrate` 与只读 `debug ls|screen|transcript`。旧顶层 `key / say / watch / dialog / tail` 等已退出，终端输入与审批通过参与者界面处理。`help` 列出有效参数。退出码：0 成功、1 失败、2 用法错误、3 setup 凭据已保存但验证未完成、130 取消；旧 Go 的所有退出码并非逐项兼容。

## 升级与旧数据

**停止旧服务及自动重启后再迁移；同一应用不要运行两条事件消费连接。**

```sh
herdr-agent migrate --state-dir /absolute/state --dry-run
herdr-agent migrate --state-dir /absolute/state
herdr-agent serve --state-dir /absolute/state
```

迁移先校验，再备份到 `backups/`，事务导入任务、资源引用、可见会话与防重放回执；旧文件不改写。`serve/configure` 自动执行同一幂等导入。坏状态或迁移后变化的旧业务源会拒绝覆盖。旧 pending 操作保持待核对，不重放旧模型工具或历史结果。

新版持久状态在 `state.sqlite`（含 WAL/SHM）；项目目录和 bypass 的后续修改写 SQLite，旧 `projects.json` 仅为导入/初始化来源。回退前保留数据库与备份，核对新版已创建/关闭的真实资源；新增状态不回写 Go JSON，没有自动反向迁移。完整流程见 [设计中的迁移与回退](docs/node-pi-design.md#迁移与回退)。

## 验证边界

自动化覆盖真实 pi 循环、协议替身、SQLite/flock/Git、迁移与独立二进制，不宣称已完成生产飞书、真实模型和真实 herdr 的全链路验收。当前支持文字和富文本中的文字；图片理解、语音转写、文件制品托管不在首版范围。

[当前业务场景与命令取舍](docs/current-business-scenarios.md) 汇总现行入口、职责和遗漏检查。[需求盘点](docs/node-pi-refactor-requirements.md) 是 Go 基线历史快照；[旧代码审计](docs/code-audit.md) 等历史材料已标注版本，不能当作 Node 当前能力说明。所有 B/N 场景、尚待核对项目和部署证据见 [acceptance.md](docs/acceptance.md)。

本项目采用 MIT，见 [LICENSE](LICENSE)。发布包另带 `LICENSES/`，保留嵌入 npm 依赖、原生扩展和 Node 的许可及第三方声明；重新分发请一并保留。生成规则见 [licenses](licenses/README.md)。
