# herdr-agent

[English](README.md) · **简体中文**

编码 agent 干到一半停下来要权限，而你人不在电脑前。herdr-agent 把这个问题推到飞书：弹窗原文照搬，
选项做成按钮。你点一下，或者随手回一句，指令就回到终端里，agent 接着干。

它通过 [herdr](https://herdr.dev) 驱动 `claude` 和 `codex`。定位很窄，只服务你一个人：一台机器、
一个飞书应用、白名单里一个 `open_id`。

启用可选的任务管理后，你可以在飞书里发一句话，自动创建飞书任务、在独立的 herdr 工作区启动 agent，
并开一个专属任务群继续对话。本地配置负责把一个项目对应到多个目录，并选择 `codex` 或 `claude`。
启用[AI 任务入口](#用自然语言操作任务)后，可以直接私聊本项目机器人，用自然语言创建任务和主动查询任务总览。
单个任务的进度、补充要求和确认在对应任务群里处理。

桥主动连接飞书 WebSocket，笔记本待在 NAT 后面照样能用，无需部署公网回调或隧道。AI 入口由本项目
通过你配置的 API 地址和 key 调用模型。

## 开始之前：herdr

**[herdr](https://herdr.dev) 是前置依赖，先把它装好跑起来。** 真正托管你 agent 的终端是它，本项目
只负责跟它说话，所以这里不重复它的文档：

```sh
brew install herdr                          # 或者：curl -fsSL https://herdr.dev/install.sh | sh
```

照 [herdr 的 quick start](https://herdr.dev/docs/quick-start/) 走一遍，先让 `herdr server` 运行。
接管已有 agent 时，还需要某个 pane 里有活着的 `claude` 或 `codex`。下文的任务功能会启动自己的 agent，
但仍依赖运行中的 herdr server，以及这台机器上已经安装并登录的对应 agent CLI。

herdr 那边还有两件事，漏了会直接影响这里：

- 装 agent 集成：`herdr integration install claude` / `herdr integration install codex`。codex 还得
  在它界面里按一次 `t` 信任 hook，否则 herdr 拿不到 session id，transcript 镜像也就无从跟起（G8）。
- herdr 要 **0.8.0 以上**。协议 19 是这边的 wire 类型实测过的下限。

再就是一个飞书账号。应用不用你手工建，`herdr-agent setup` 会准备好 —— 新建也行，挑你已有的也行。
真走不通还有[手动控制台清单](#飞书控制台清单--手动兜底路径)兜底。

已有聊天桥在 macOS 上实测，现成的服务单元是 launchd。Go 代码本身跨平台，Linux 二进制也随版本发布，
`serve` 在哪儿都只是个普通前台进程。

herdr 那边有几项配置属于**静默失败**：配错了不报错，只是某个功能悄悄不工作。那是 herdr 的配置，不归
本桥管，所以交给 `herdr-agent doctor` 逐条点名并给出修复命令，本文不越俎代庖去教你怎么运行 herdr。
机制写在[故障排查](#故障排查)。

## 安装

两种方式，都受支持。

**下载 release。** 去 [Releases 页面](https://github.com/hewenyu/herdr-agent/releases/latest) 挑对应
你机器的包：Apple Silicon 选 `darwin_arm64`，Linux 选 `linux_arm64` 或 `linux_amd64`。解开，把
`herdr-agent` 扔到 `PATH` 上任意位置就行。想校验的话每个 release 都带 `SHA256SUMS`，release notes 里
有现成命令。

macOS 上这些二进制没有签名，Gatekeeper 会拦下来说「无法验证开发者」。这看着像项目坏了，其实不是，
清掉隔离标记即可：`xattr -d com.apple.quarantine ~/.local/bin/herdr-agent`。

**或者自己编译**，需要 Go 1.24 以上：

```sh
go install github.com/hewenyu/herdr-agent/cmd/herdr-agent@latest
```

不论哪种方式，装完跑一下 `herdr-agent version`，它会告诉你手上到底是哪个构建。

## 快速开始

herdr 在跑，pane 里有活着的 agent。剩下三条命令：

```sh
herdr-agent setup     # 准备飞书应用：一个确认页，手机上点两下
herdr-agent doctor    # 在你把它当回事之前，先体检这台机器
herdr-agent serve     # 跑桥
```

然后手机上给机器人发 `/ls`，点 **Select**，开始打字。

`setup` 不用带参数。它会授权 scope、订阅事件、以 0600 权限写好 `~/.herdr-agent/.env`、填上白名单和
`notify_chat_id`，最后还要求你真发一条消息、真按一个按钮才算数 —— 因为上面每一项配错了，症状都一样：
什么都没有。详见[关于 setup 的更多细节](#关于-setup-的更多细节)。

`doctor` 查的是两边那些会把桥静默搞坏的地方。健康的安装也会有几条非 PASS，所以要读内容而不是数条数，
[故障排查](#故障排查)里说明了哪些属于预期之内。

每次启动 `serve` 都会检查当前应用已授予的权限。需要补授权时，按本地页面或启动日志中的链接登录确认；
程序会等待权限生效，然后自动继续启动。详见[启动时检查飞书权限](#启动时检查飞书权限)。

未启用任务管理时，桥只转发你已经启动的 agent 的对话。启用[飞书任务与项目仓库](#飞书任务与项目仓库)
后，可以从飞书选择已配置项目创建并启动 agent，也可以明确要求新建项目。

### 让它一直跑着

`serve` 是个前台进程，塞进你手头任何 supervisor 都行，也可以直接用 `deploy/` 下的服务单元。那些单元
只在 git 仓库里，release 压缩包里没有（里面只有二进制、两份 README 和 `LICENSE`），所以得 clone 一下：

```sh
git clone https://github.com/hewenyu/herdr-agent && cd herdr-agent
deploy/install.sh          # macOS：装两个 LaunchAgent 并拉起
herdr-agent doctor         # 装完验一下
```

这一步不用编译。launchd 拿不到有用的 `PATH`，所以 `install.sh` 把绝对路径写死进单元文件，并用
`command -v herdr-agent` 找到你已经装好的那个二进制；想指定别的就传 `HERDR_AGENT_BIN=/path/to/herdr-agent`。

| job | 跑什么 |
|---|---|
| `com.hewenyu.herdr-server` | `herdr server`，从**洗干净的**环境启动（`env -i` 加 `HOME`、`PATH`、`SHELL`、`TERM`、`LANG`） |
| `com.hewenyu.herdr-agent` | `herdr-agent serve`，也就是桥本身 |

`install.sh` 是幂等的：重写两个单元文件、把 job 停掉再拉起、不碰已有的 `config.toml`。想自己起 herdr
server 就加 `--bridge-only` 跳过它。Linux 上同一对以 systemd **user** 单元发布，即
`deploy/herdr-agent.service` 和 `deploy/herdr-server.service`；`install.sh` 驱动的是 launchctl，所以在
Linux 上它什么都不写，只把复制和启用的步骤打印出来，其中包括 `loginctl enable-linger "$USER"` —— 少了
这条，两个单元会在你登出时停掉，开机也不会自启。环境洗白在 Linux 那边同样保留，因为它是承重的（G7），
不是摆设。

环境洗白有两个副作用，最好赶在 agent 给你惊喜之前知道：pane 里拿不到 `SSH_AUTH_SOCK`，所以在 agent
里走 SSH 的 `git push` 会卡在密码短语上；pane 里也拿不到 `XDG_CONFIG_HOME`，如果你在 shell 里设过它，
终端里的 `herdr` CLI 和这个 server 会连到两个不同的 socket。两条在
`deploy/com.hewenyu.herdr-server.plist` 顶部都有注释和解法。

所有开关都在 `~/.herdr-agent/config.toml`，`deploy/config.example.toml` 逐条写了默认值和它做的取舍。
模型密钥使用该文件的 `[ai].api_key`。飞书凭据仍通过 `setup` / `.env` 配置，TOML 没有飞书 App Secret 字段。基本聊天配置常用两项：
`feishu.allowed_open_ids`（必填）和 `feishu.notify_chat_id`（留空时，任务功能之外的 agent 不主动
推送；仅在未启用任务管理时使用）。启用任务管理后，只向对应任务群推送执行通知，
即使填写了此项，也不会把无关本地 agent 的通知推到入口私聊。

### 关于 setup 的更多细节

`setup` 不用带参数。它打印一个确认链接，本机有浏览器就直接打开，然后等你。页面上两个选择一样好：
新建一个应用（名字预填了 `herdr-agent`），或者**挑一个你已经有的** —— 页面会把你租户里的应用一并列出来。
按下「确认」，它会给你选中的那个应用授予四项 scope、订阅 `im.message.receive_v1`、申请
`card.action.trigger` 回调。整个协议就这些：注册数据块里只有 preset、scope、事件和回调，没有别的
字段可填（G18）。

正因如此，有两件事它设置不了，可应用到手却已经带着 —— 两条都是实测结果，不是谁执行的步骤（G18）：

- **事件已经在走长连接投递了。** 手机上一条真实私聊，在零次控制台操作的情况下就到达了桥。协议里没有
  任何字段能选投递方式，所以这是 `setup` **观察到**的，不是它**配置**的。这也正是它非要以一次真实往返
  收尾、而不是给你一句断言的原因，同时也是[手动清单](#飞书控制台清单--手动兜底路径)里仍然把「订阅方式
  → 长连接」列为需要你亲手确认的一项的原因。
- **版本已经发布了。** 在我们做任何发布动作之前，应用的 `online_version_id` 就已经非空。**所以基础 `setup`
  完成后不需要额外发布。** 这跟控制台流程教的正好相反，值得明说：让你去找一个根本不需要的
  发布按钮，最后的结果一定是你以为自己哪儿配错了。之后添加任务权限仍需按流程审批和发布。

两次往返，少一次都不算成功：

| 退出码 | 含义 |
|---|---|
| 0 | 端到端已验证：你的消息到了，你的按钮回调也回来了 |
| 3 | 应用存在、凭据已落盘，但往返没有被证明。会打印一份编号清单，每项配一个 URL 说明还差什么；重跑 `setup` 会跳过注册直接重验 |
| 1 | 没产出任何可用的东西 |

**重跑 `setup` 用于核验消息和按钮投递**。桥能读到的任何位置上已有的凭据都会被采纳并验证，
所以重跑不开页面、不建应用，只告诉你两次往返里坏的是哪一次。三个参数用于它推断不出来的场景，首次运行
一个都用不上：

| 参数 | 什么时候用 |
|---|---|
| `--app cli_…` | 指定用**那个**应用。桥能读到的文件里已经有它的 secret，就完全不开页面。没有的话 —— 飞书的 app secret 只显示一次，所以你手工建的应用基本都属于这种 —— 确认页会*针对那个应用*打开，把桥需要的东西重新授一遍，并交回一个可用的 secret。两种情况都不会新建应用 |
| `--update-permissions` | 为已有应用生成新的确认链接，补齐任务和任务群权限；已有凭据也会打开确认页。可以同时指定 `--app cli_…` |
| `--reregister` | 故意再建**第二个**应用。已有的那个原封不动，之后 `~/.herdr-agent/.env` 指向新的 |
| `--yes` | 绝不交互提问，给脚本和 launchd 用。配了两个应用却不给 `--app` 会直接报错并点名两个文件：猜错会让桥指向一个你从没发过消息的机器人，而症状是一片寂静。等你消息、等你按钮的时长不受任何参数延长；清单照常打印，运行以退出码 3 结束，应用和凭据都已落盘 |

**跑 setup 之前先把桥停掉。** 飞书长连接是集群模式：每个应用最多 50 条连接，事件在它们之间**随机**
分发。所以同一个 `app_id` 上的第二个客户端不会干净地失败，它会静默分走你一部分真实消息（G15）。
`setup` 拿的是跟 `serve` 同一把单实例锁，宁可拒绝也不共享。`install.sh` 跑过之后，桥就是那个第二
客户端：

```sh
launchctl bootout gui/$(id -u)/com.hewenyu.herdr-agent
herdr-agent setup
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hewenyu.herdr-agent.plist
```

机制上有一条得交代清楚：`setup` 和启动补授权使用的设备授权端点是**未公开的**，在 open.feishu.cn 上根本查不到，随时
可能变更或消失。所以下面那份手动清单是一条正经的备选路径，不是脚注。

### 启动时检查飞书权限

每次运行 `herdr-agent serve`，程序会先取得单实例锁，用新获取的应用 token 读取当前应用已授予的
scope，通过后才建立飞书长连接、处理 agent 任务。检查包括四项基本聊天权限；启用 `tasks.enabled = true`
时，再检查下文列出的五项任务权限。查询权限列表不需要额外申请权限。该检查只覆盖已授予的 scope；
事件订阅、卡片回调和应用可用范围仍需通过 setup 的真实消息/按钮往返或手动核验。

已有 App ID 的 Secret 缺失、失效，或缺少所需 scope 时，程序会为**同一个 App ID** 生成飞书登录补授权
链接。点击链接，登录并确认更新即可。刷新后的凭据会保存在本机，白名单和已有项目配置保留；不会新建
应用，也不会额外建立一条飞书连接。

等待授权期间，本地配置页面（默认 **http://127.0.0.1:18790/**）仍可访问。页面顶部显示授权状态、
缺少的权限、当前登录链接；程序会自动打开本地页面一次，同时在日志中打印授权 URL。
使用 `--no-config-ui` 时从日志获取链接，程序也会尝试直接打开授权页。链接过期后会重新检查权限并自动生成新链接；登录确认后还会再次
核对权限确实生效，再继续启动桥。网络或服务错误会显示为检查未确认并重试，不会误报成权限不足。

官方登录链接也可能使用 `https://open.feishu.cn/page/launcher`，不只使用飞书账号域名。
尚未发出登录链接时，状态会明确提示生成失败，不再误报链接失效。程序继续自动重试，
日志不输出远端原始响应或凭据。

这一恢复流程用于已配置应用。尚无有效 App ID 或白名单时，仍需先运行 `herdr-agent setup` 完成初次配置。
`setup --update-permissions` 保留为手动维护入口，单独运行它之前仍需停桥；正常启动时的补授权在
`serve` 内完成，确认后无需另外执行 setup 或重启。

## 飞书任务与项目仓库

任务功能默认关闭，可以继续使用已有的飞书应用、凭据和白名单。在 `~/.herdr-agent/config.toml`
启用 `[tasks]` 后启动 `herdr-agent serve`，程序会检查下文权限，缺少时提供补授权链接。本机配置页面
默认地址为 **http://127.0.0.1:18790/**，在等待授权期间也可使用。

页面支持添加、编辑项目、选择默认项目和 agent，以及按顺序配置一个项目的多个文件夹。第一个目录作为
工作目录，其余目录通过 `--add-dir` 传给 Codex 或 Claude。保存或启动时，主目录自动初始化 Git；已有仓库
和合法 worktree 保留，附加目录不要求 Git。本机需安装 Git。保存后，新任务
立即使用新配置，无需重启；已经创建的任务保留原来的目录和 agent 模式。

尚未启动桥时，也可以单独运行并打开页面：

```sh
herdr-agent configure --open
```

这个命令与 `serve` 共用实例锁。如果桥已经运行，直接打开它的配置网址。
需要持久修改地址时，在 `~/.herdr-agent/config.toml` 已有的 `[ui]` 段中设置：

```toml
[ui]
config_listen = "127.0.0.1:18791"
```

`serve` 和 `configure` 都读取这个配置，默认值为 `127.0.0.1:18790`。
`serve --config-listen 127.0.0.1:18792` 和 `configure --listen 127.0.0.1:18792` 可以覆盖本次启动的
TOML 配置。地址只允许使用 loopback IP，修改 TOML 中的地址后需要重启正在运行的命令。
端口被占用时，可以在配置中换一个可用端口，或用 `serve --no-config-ui` 关闭页面，从日志获取授权链接。

前端和 API 都由 Go 程序提供。HTML、CSS 和 JavaScript 通过 Go 的 `embed` 在编译时打进二进制，
下载后只需该二进制即可打开页面，无需 Node.js 或额外分发资源目录。CI 会把二进制单独复制到空目录，
检查页面、样式、脚本和项目 API；release 工作流在发布前还会从 Linux amd64 压缩包中提取二进制，
再次执行同样的检查。

全局 **Bypass** 勾选框默认开启：新启动的 Codex 带上 `--dangerously-bypass-approvals-and-sandbox`，
Claude 带上 `--dangerously-skip-permissions`，跳过其常规执行审批。取消勾选后，新 agent 使用正常权限
处理。首次保存本地目录配置前，可用 `tasks.bypass = false` 设置初始关闭；之后以页面保存的开关为准。

也可以先在 TOML 中配置项目：

```toml
[tasks]
enabled = true
bypass = true
default_project = "herdr-agent"
poll_interval = "30s"

[tasks.projects.herdr-agent]
directories = ["~/code/github/herdr-agent", "~/code/github/herdr"]
agent = "codex"

[tasks.projects.website]
path = "~/code/website" # 兼容原来的单目录写法
agent = "claude"
```

页面首次保存后，会生成 `~/.herdr-agent/projects.json`（权限 0600），保存完整项目列表、默认项目和
Bypass 开关。此后项目配置以该文件为准，TOML 仅作为初始项目来源；`[tasks].enabled` 和 `poll_interval`
仍从 TOML 读取。后续项目修改在页面完成。首次配置允许项目列表为空；有项目时，`default_project`
必须对应其中一个项目，页面会自动把首个项目设为默认。

项目名称允许字母（包括中文）、数字、`_` 和 `-`，不能包含空格或斜杠。路径支持展开 `~/`。省略 `agent`
时默认使用 `codex`，可选 `codex` 和 `claude`。`directories` 表示完整有序目录列表，设置后优先于旧的
`path`。轮询间隔默认 `30s`，必须为正数。目录被移动或删除时，仍可启动配置页面修复；新任务启动前会
检查它的所有目录是否存在。

普通新建任务直接使用已配置项目，不创建目录。只有在页面或 AI 对话中明确要求**新建项目**时，才创建
`~/herder-agent-code/<项目名>/` 并登记项目。这里的 `~` 是运行桥的本机操作系统用户目录，不是每个飞书
用户各自的目录。新项目的主目录自动执行 `git init`，不自动提交或创建 worktree，也不自动接管已存在的同名目录。
删除项目配置只删除关联信息，保留本地文件和正在运行的任务。

每个任务创建独立的 **herdr workspace 和 pane**，直接使用配置的目录。多个任务使用同一目录时会共享
文件；需要隔离并发修改时，可先准备不同的 Git worktree 再配置。聊天通过项目名称选择目录，不接受任意
本地路径。页面管理项目与 Bypass；模型 API、模型名和 key 按下文通过 TOML 配置。

在现有应用的基本聊天权限之外，还需要增加以下权限：

| 权限 | 用途 |
|---|---|
| `task:task:write` | 以应用身份创建、读取和更新飞书任务 |
| `task:task:read` | 订阅任务实时更新；订阅接口独立要求此权限，写权限不能代替 |
| `im:chat:create` | 创建包含你和机器人的私有任务群 |
| `im:chat:delete` | 销毁会话时解散任务群 |
| `im:message.group_msg` | 接收任务群消息，无需每句 @ 机器人 |

已有应用缺少这些权限时，按 `serve` [启动权限检查](#启动时检查飞书权限)提供的链接补授权即可，无需
单独运行 setup。需要手动维护时，仍可停桥后运行 `herdr-agent setup --update-permissions`，也可以加
`--app cli_…` 指定应用。该命令在页面确认后保存凭据，再按提示完成消息和按钮验证；应用 ID 不一致时
拒绝覆盖原配置。也可以在开发者后台按租户审批和发布流程开通。
修改 `config.toml` 不会自动授予权限；scope 检查通过或基础 setup 往返成功，都不代表任务流程已完成验证。
机器人是它创建的任务群的群主。飞书任务同时把你和应用设为负责人，完成模式
使用 `mode = 2`（任一负责人完成即可），让任务进入你的任务面板，也落在应用订阅可见的范围内。
桥会请求 Task v2 任务订阅，通过已有的同一条 WebSocket 接收 `task.task.update_user_access_v2` 事件；
订阅失败、事件不可用或连接中断后，仍按配置间隔轮询核对任务状态。

完整流程如下：

1. 在入口机器人私聊里说 `新建任务：修复登录问题`，使用默认项目；也可以说
   `/new herdr-agent claude 修复登录问题`，指定项目并覆盖其默认 agent。
2. 机器人创建飞书任务和私有任务群，创建 herdr 工作区并启动 agent。点击群链接进入该任务的独立会话。
3. agent 就绪后发送初始要求。需要处理启动确认或权限请求时，使用已有的屏幕卡片；后续补充要求、回复和
   进展都留在对应任务群。
4. 启用 AI 后，直接在任务群问“现在项目进度如何”或补充开发要求，无需 @。启动、执行、阻塞和待验收
   等进展也会主动发到群里。
5. 验收后在任务群发送 `/关闭项目`，查看说明后回复“确认关闭”，或直接在飞书任务面板勾选完成。系统确认飞书任务完成、保存结果、发出关闭通知，
   再关闭执行会话与任务群。**解散群后不保留群聊天记录。** 本地代码和飞书任务记录保留。
   若要保留群，请明确说明，或使用 `/task complete`；继续工作前先重开任务。

`/task close` 和飞书面板勾选完成都会触发验收结单并清理会话、群。关闭通知后的宽限期内从面板重新打开任务，会取消关闭；清理失败时自动重试。明确使用 `/task complete` 仅标记完成，保留群和 Agent；销毁会话不会把尚未完成的任务自动勾选完成。已经销毁
的会话不能重新打开，需要新建任务继续。入口聊天里的 `/close` 仍然只取消当前 agent 选择，不销毁任务会话。

| 消息 | 作用 |
|---|---|
| `/projects` | 查看项目名称、目录和默认 agent |
| `/new <项目> [codex\|claude] <任务内容>` | 新建任务，可覆盖项目默认 agent |
| `新建任务：<任务内容>` | 使用默认项目和 agent 新建任务 |
| `/tasks` 或 `现在有哪些任务在进行？` | 查看自己正在追踪的任务、进展和链接 |
| `/tasks all` | 一并查看已完成、已销毁的任务记录 |
| `/task complete [编号]` / `/task reopen [编号]` | 同步完成或重新打开飞书任务 |
| 任务群 `/关闭项目` → `确认关闭` | 查看关闭说明，确认后完成任务、关闭 Agent 并自动解散当前群 |
| `/task close [编号]` | 验收结单，确认任务完成后关闭执行会话和群 |
| `/task destroy [编号]` | 关闭执行 pane 并解散任务群 |
| `/task retry [编号]` | 修复原因后重试可恢复的失败 |
| 任务群中的 `/screen` / `/stop` | 查看该任务屏幕，或中断 agent |

任务编号从 `/tasks` 查看，在对应任务群内可以省略。如果操作中断且无法确认是否已经执行，桥会报告需要
检查，不会自动再建一套资源或重复发送初始要求；`/task retry` 也不会重放这类结果不明的操作。

飞书任务本身只有 `todo` / `done` 两种完成状态。「执行中」「等待你处理」「待验收」等运行状态写入
**任务的普通描述字段**，同时包含项目、agent、进展、最近回复、更新时间和任务群链接。agent 的 `idle`
或 `done` 只表示当前一轮结束，不会直接把飞书任务勾选完成。描述属于 Task API 的正式资源字段，按原有
任务权限访问。拥有该资源读取能力的飞书 AI 可以据此总结，但这不保证每个飞书客户端或 AI 工具都开放了任务
访问能力。启用下文的 AI 入口后，本项目机器人可以直接查询任务状态，不必等待任务描述被搜索索引。
机器人自己的 `/tasks` 查询不依赖客户端 AI 集成。

新增任务流程仍需用你的真实飞书应用和 agent 环境联调。尤其是完全在后台创建的 pane，可能需要先连接一次
终端，给它足够的屏幕宽度，让 herdr 正确识别首次启动、信任和审批弹窗。依赖无人值守启动前，先用 `/screen`
检查实际屏幕并处理提示。Bypass 控制 agent 的执行审批，不替代首次环境设置，也不会替你启动 herdr server。

## 用自然语言操作任务

本项目基于 [Eino](docs/ai-framework.md) 的 Go AI 入口让你直接私聊现有飞书机器人，由模型理解需求并调用受控的任务工具。配置你自己的
模型 API、模型名和 key 即可；飞书应用、项目到多个目录的映射，以及 Codex/Claude 执行环境沿用上节配置。

先启用 `[tasks]` 并配置项目，在 `~/.herdr-agent/config.toml` 已有的 `[ai]` 段中填写
（不存在时才新增，避免重复定义）：

```toml
[ai]
enabled = true
provider = "openai-responses"
model = "你的服务支持的模型ID"
base_url = "https://你的模型服务/v1"
api_key = "你的模型服务API密钥"
timeout = "2m"
context_tokens = 50000
```

`provider` 指 API 协议，仅支持 `openai-responses`（默认）和 `anthropic-messages`。填写模型服务提供的
模型 ID 和版本根地址：Responses 示例为 `https://api.openai.com/v1`，请求使用 `/responses`；Anthropic
示例为 `https://api.anthropic.com/v1`，请求使用 `/messages`。必须使用支持工具调用的模型。`base_url`
不能包含用户名、密码、查询参数或片段，要求 HTTPS；仅本机 loopback 地址允许 HTTP，例如
`http://127.0.0.1:8080/v1`。`timeout` 必须大于零且不超过 `10m`，默认 `2m`。

`context_tokens` 是输入上下文上限和自动压缩阈值，默认 `50000`，允许 `16384..1048576`。
系统按 UTF-8/JSON 字节和消息、工具结构开销保守估算 tokens，计入系统指令、任务快照、对话、工具定义及工具结果。
达到阈值时，Eino 自动摘要旧上下文并保留近期问答。模型实际上下文窗口还需留出额外 `4096` tokens
用于输出；修改此配置不会扩大模型本身的窗口。不再按固定 40 条消息静默丢弃历史。
压缩失败时保留已有历史并反馈错误；模型明确标记为不完整或截断的输出不能作为成功摘要。

将模型服务的 key 直接写入同一个 `[ai]` 段的 `api_key`，然后重启 `herdr-agent serve`。
新电脑无需设置模型密钥环境变量，也无需克隆仓库。模型 key 只从 TOML 读取，不再读取环境变量或
`.env` 中的 `HERDR_AGENT_AI_API_KEY`；老用户需要将模型 key 迁移到 `[ai].api_key` 后再重启。
执行 `chmod 600 ~/.herdr-agent/config.toml` 限制文件访问，共享配置时隐去 `api_key`。

TOML `api_key` 需要包含本次修改的二进制，`v0.2.2` 尚不支持该字段。该 key 用于你选择的模型服务；
飞书凭据仍沿用 `setup` / `.env` 流程中的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。
整个入口在 Go 服务中运行，无需额外 JavaScript 运行时。

在机器人**入口私聊**中直接说：

- “看看有哪些项目，现在有哪些任务正在进行？”
- “在 herdr-agent 项目里创建任务，排查登录失败并验证修复。”
- “新建一个 demo-api 项目，实现健康检查接口。”
- “现在各个任务进展如何？”

入口私聊支持需求沟通、澄清、创建任务和任务总览。普通自然语言回复和追问保留原文；例如机器人询问
项目名后，回复“就叫 pelican-bike-svg”能承接前面的创建要求，重启后也能继续已有对话。
创建任务后，入口接收简短回执和就绪后的任务群入口，不重复接收执行进展、审批卡片或待验收通知。
具体实现反馈、单个任务的进度和验收，在对应任务群直接沟通。主动在入口询问时，仍可查询任务总览。
默认只列出未结束任务；明确询问“所有任务”“已完成任务”或历史记录时，才包含已完成、已销毁记录。
已销毁会话按已关闭展示。

机器人按实际消息发送者检查白名单和任务归属。模型只能通过受控工具选择已配置项目、查询任务、创建
会话、补充要求、完成、重开、重试或销毁，不能在工具参数中切换操作者身份或传入任意本地路径。
只有用户明确要求新建项目时，`herdr_create` 才使用 `new_project=true`；仅仅说“新建任务”仍复用已有项目。
机器人会向配置的模型服务发送本轮对话及所需任务摘要和工具结果；不会为了理解意图上传整个代码仓库。

任务创建后有对应飞书任务和私有任务群。群助手只能操作本群任务：询问进度读取实时记录，补充要求发给
对应 Codex/Claude，明确验收结单则完成任务并关闭会话。“没有验收通过”“先不要关闭”等不会触发结单。
启动确认和审批也在群内处理；入口私聊负责创建任务和跨任务总览。

应用私聊和任务群都使用连续对话与自动压缩机制，记忆按用户、聊天和绑定任务隔离。
摘要保留需求、否定约束和未决问题，但不是新的用户授权，也不能证明当前任务进度。

摘要的存储、召回 provider 与模型 API 分开配置。默认 `file` 将对话摘要保存在
`~/.herdr-agent/memory/`；`http` 可接入实现按 scope 隔离的 Recall/Store/Forget 协议的服务。
例如保留全局本地存储，仅为一个用户配置其他 provider：

```toml
[memory]
provider = "file"
timeout = "10s"

[memory.users."ou_REPLACE_WITH_YOUR_OPEN_ID"]
provider = "http"
base_url = "https://memory.example.com/api"
api_key = "你的记忆存储服务密钥"
timeout = "10s"
```

每个用户覆盖项使用独立配置，不继承全局地址或密钥。记忆服务密钥只从 TOML 读取。
远端 HTTP provider 必须使用 HTTPS 和 API key；本机 loopback 允许 HTTP 和空 key。
超时必须大于零且不超过 `2m`。provider 失败不会自动切换存储；使用 HTTP 时，近期问答原文、检查点、
归档及操作/消息回执仍保存在本地。切换 provider 后，下一轮使用记忆的对话会将本地检查点中的摘要同步到新存储，
不迁移问答原文，也不复制或删除旧服务的数据。外部服务需实现本项目的 HTTP 协议。
协议、保留内容与故障边界见[对话与记忆说明](docs/conversation-memory.md)。

进度和操作回执由实际任务数据渲染，旧 AI 回复不能作为执行证据。回复区分 agent 自述与已验证事实，
显示配置的产物目录及其当前顶层条目；目录现况也不等于本任务生成记录。首次要求未确认送达时明确说明，
agent 一轮结束不等于用户已验收。运行状态、最近回复和更新时间继续写回飞书任务，供其他有权限的 AI 总结。

先用“列出项目和进行中的任务”验证模型工具查询，再让它创建一个“不改任何文件，只回复 FEISHU_AI_OK”
的测试任务。核对飞书任务、任务群、本机执行窗口和实际回复，然后验证完成、重开与显式销毁。
本地测试通过不能替代使用你的模型 API、飞书应用和 agent 环境的完整验证。

## 在手机上用

下面的入口私聊选中 agent 后直接输入，适用于未启用 `[ai]` 的配置。启用 AI 后，入口私聊的普通文字由
任务助手处理；和指定 coding agent 直接交流请进入对应任务群。

跟机器人的私聊里发 `/ls`，会拿到一张**选择卡片**：一个 agent 一行，被阻塞的排最前，每行显示 kind、
目录、pane id、状态，以及 agent 自己报的当前任务。

```
🔴 claude · herdr-agent           [ Select ]      [ Screen ]
   w1:p1 · blocked · Create hello.txt with touch
▶ ⏳ codex · api                  [ ✓ Selected ]  [ Screen ]
   w1:p2 · working · refactor the router
```

点 **Select**，然后直接打字。纯文本就送到选中的那个 agent，不用 pane id，不用长按，不用命令。每次选择
变化，卡片都会**就地重绘**，所以换 agent 是在你已有的卡片上点一下，不用再发一次 `/ls`。`▶` 标的是
当前行。

**选中之后一直有效，直到你发 `/close`。** 不是十二小时，不是到桥重启为止，也不是到 agent 干了点什么
为止。一次有意的点击打开通道，一次有意的命令关掉它 ——「我怎么又要重新选一遍」这个问题只有一个答案：
因为你自己要求的。下面这些**过去会**把它掐断的情况，现在都不会：

- agent 里执行了 `/clear`，或者发生了一次 compaction。窗口没变、agent 没变，你的输入照样过去；只提醒
  你一次：它不记得你们之前聊过什么了。
- agent 退出，又在同一个 pane 上按同样的活重新起来。它不在的那段时间，你收到的是「什么都没发出去，
  本会话仍然瞄着 claude · herdr-agent · w1:p1」，而不是一张让你重选的卡片；等它回来，接着打字就是。
- 桥被 kill 掉再重启 —— 这本来就是家常便饭。
- 一个通宵、一个周末、一个假期。安静十二小时之后，下一条消息照样投递，只多一行告诉你是多久以前选的；
  而且只说一次，天天在用的会话根本碰不到它。

**你锚定的是窗口。** herdr 从不复用 pane id：公开 pane 编号只增不减，pane 关掉也不释放，计数器还跨
重启持久化。所以 `w2:p2` 在整个安装周期里只会指同一个窗口。这就是为什么别的都不需要再校验 —— 也是
为什么校验别的东西反而是错的：真机上两个 agent 完全可能共用一个目录（`w2:p1` 的 codex 和 `w2:p2` 的
claude 都在 `~/code/yuebanhome`），同一个项目里开两个 claude 更是连 kind 都一样。**能把它们分开的只有
pane，而且永远只有 pane。**

唯一还会拒绝投递的情况是**那个窗口里换成了别的程序**：你在 `w1:p1` 里退了 claude，起了 codex。窗口活
得比 agent 长。这时候什么都不发，告诉你变了什么，瞄准点留在原地，等你自己去动它。

如果你在同一个窗口里把 agent 重启到了**另一个项目**上，消息照样投递 —— 那还是你的窗口 —— 只多一行
告诉你它挪窝了：「w1:p1 里的 claude 现在工作在 ~/other，你选它的时候它在 ~/project」。**告知而不是
拒绝**：herdr 报的目录会跟着 Bash 工具调用跑进子目录，拿它当拒绝的理由，就会在任务干到一半时丢消息。

**回复某条消息，可以只为这一条消息改变目标。** 一个会话同时盯着几个 agent 就靠这个：回复会路由到那条
消息所关于的 agent，同时不改变纯文本的瞄准点。（被镜像的 agent 回合是流式消息，飞书不给流式消息任何
桥能登记的 id，所以回复它们没法路由 —— 这一点会明确告诉你，不会让你自己猜。）

斜杠命令作为逃生口一直在：

| 命令 | 作用 |
|---|---|
| `/ls` | 选择卡片：所有 agent、状态、pane、kind、cwd、标题 |
| `/card <pane>` | 把该 pane 当前屏幕推成一张可操作卡片 |
| `/say <pane> <text>` | 走安全路径给那个 agent 发一句 |
| `/stop <pane>` | 发 `esc`，从弹窗里安全退出 |
| `/mirror <pane> on\|off` | 在会话里跟随该 agent 的 transcript（默认关） |
| `/close` | 取消当前 agent 选择；不停止 agent，也不关闭 pane |
| `/doctor` | 跟 `herdr-agent doctor` 同一套检查 |
| `/help` | 这张表 |

解析不了的斜杠命令一律回一条明确的错误，**绝不**降级成自由文本 —— `/stpo w1:p1` 当正文发给一个被阻塞
的 agent，就是一次误批准（G1）。

### 阻塞卡片

agent 停下来等你的时候，你会收到一张红卡片：kind、目录、任务标题，弹窗原文放代码块里，**弹窗实际给了
几个选项就有几个按钮** —— 从屏幕上读出来的，不是写死的，因为选项数量随 agent 和版本变。所有带编号的
按钮一律中性配色，`1. Yes` 也不例外：一张卡片上最扎眼的东西不该是「同意」。它们下面那个用最危险的样式
画出来的是 `Esc · back out` —— 那才是安全键，故意画得吓人，因为退出弹窗是你随时能反悔的选择。

按下之后，卡片立刻被改写成灰色的、没有按钮的版本，写明谁、什么时候、按了什么、结果如何。agent 干完时
你会收到一张绿卡片，显示**它自己说了什么** —— 取自它的 transcript，不是终端截图 —— 完整屏幕在
`Screen` 后面，一点即达。

给正在忙的 agent 打字，消息**直接送进去**。工作中的 agent 自带输入队列，文字落进它的输入框，本轮结束
时提交。所以桥这边一句都不扣，你连着发几句就按发送顺序到达，不会一句一句挤牙膏。

### 在机器上

同一套能力也是一组 CLI，同时也是控制层的验收面：

```
herdr-agent setup                   注册飞书应用（或复用一个），并证明它真的能用
herdr-agent doctor                  检查那些会把桥静默搞坏的东西
herdr-agent ls                      列出 herdr 能看到的所有 agent 及其状态
herdr-agent dialog <pane>           打印 agent 正在问什么
herdr-agent tail <pane> [-n 18]     打印可见视口的最后几行
herdr-agent key <pane> <key>        回答一个菜单，走完整 guard 校验
herdr-agent say <pane> <text...>    走安全路径发文字
herdr-agent transcript <pane>       打印该 agent 原生 transcript 文件的路径
herdr-agent watch                   流式输出状态迁移，每条一行带时间戳
herdr-agent serve                   跑桥，直到 SIGINT 或 SIGTERM
herdr-agent version                 打印烧进这个二进制的版本、commit 和构建时间
```

## 安全模型

你正打算让一个聊天软件在自己的终端里按键。有四条规则让这件事站得住脚。

**正文永远到不了被阻塞的 agent。** herdr 的 `agent.prompt` 是先粘贴文字、再补一个回车，而权限弹窗是
**菜单不是输入框**：粘进去的字被丢掉，那个回车按在了高亮的默认项上，通常正是 `1. Yes`。实测（G1）：
给一个卡在弹窗上的 claude 发「absolutely not, do NOT run this command」，*结果它把那个正被拒绝的文件
建出来了*。所以桥的做法是先发 `esc`，等 agent 稳下来，再投递你的话。它也从不把话说满：`agent.prompt`
在字节进 PTY 队列时就返回成功，事后在屏幕上找不到的消息会被如实报成「已发送但未确认」（G3），而不是
「已投递」。

**旧卡片会被卸掉子弹。** 飞书消息永不过期，三天前那张卡片今天按下去，照样往那个 pane 今天跑着的东西
里打一个键 —— 实测（G17）。所以每个按钮都带着 pane、agent kind、原生 session id 和它被铸造时的状态
序号，靠 nonce 保证只能用一次，卡片在被用掉的瞬间就改写成静态的「已处理」版本。过期的按下一个键都不会
发出去，并且会告诉你为什么。够不着键盘的按钮 —— `Select`、`Screen` —— 整套跳过，因为它们没什么可卸的。

**白名单是强制的，且默认拒绝。** herdr 的 socket 没有任何认证，只靠文件权限保护，能连上它就等同于在这
台机器上拿到一个 shell（G10）。`allowed_open_ids` 上的任何人，都能批准这台机器上任何 agent 正在请求
执行的任何命令。所以空白名单是启动即硬失败，而不是安静地放行所有人；每一个入口都要校验它 —— 消息、
卡片回调、镜像。未启用任务管理时，普通 agent 使用配置中的推送目标；启用后只有托管任务主动推送，
使用通过授权检查后创建并持久绑定的私有任务群。
任务群输入还会校验任务所有者，不能切换到其他 pane 或重定向其他任务的输出。

**每条回复都点名它发给了谁。** 不是「已发送」，而是「Delivered to claude · herdr-agent · w1:p1.
It is now idle.」—— kind、目录、pane 一个不少。pane id 是座位不是身份：agent 会退出，另一个会在同一个
窗口里起来。所以任何被记住的目标（一次选择、一条回复绑定）在投递之前都要重新对一遍现在坐在那个 pane
里的是谁；变了就告诉你，绝不悄悄改投。对的是 **pane 和 kind**：pane 是因为 herdr 从不复用它，kind 是
因为窗口活得比里面的 agent 长。session id 和工作目录只记录、只上报，**从不参与比对** —— 前者每次
`/clear` 都变，后者在两个不同 agent 之间可能相等、还会跟着 Bash 工具调用移动。这两样拿来比对，都结束
过本不该结束的对话。

## 故障排查

| 症状 | 原因 |
|---|---|
| macOS 拒绝运行二进制，说「无法打开，因为无法验证开发者」 | 下载来的未签名二进制被 Gatekeeper 隔离了：`xattr -d com.apple.quarantine <path>`。安装本身没毛病 |
| 消息**时好时坏** | 有两个进程在用同一个 `app_id`。飞书长连接是集群模式，每个应用最多 50 条，事件在所有打开的连接之间**随机**分发，所以既不报错也不断连，每个进程只收到大约一半（G15）。这就是单实例被强制而不只是被建议的原因，也是为什么在活着的桥旁边跑个诊断探针，会静默偷走你一半真实流量。查一下有没有多余的 `herdr-agent serve`，以及其他指向同一应用的工具 |
| 桥每 30 秒重启一次 | 它在启动阶段就退出了，检查 `log/herdr-agent.err.log` 中是否提示 `allowed_open_ids` 为空、缺少 App ID 或其他配置错误。可补授权的问题会让 `serve` 保持等待 |
| 启动停在等待飞书授权 | 打开本地页面或启动日志里的授权 URL，登录并确认更新当前应用。过期链接会自动刷新，所需权限核验通过后 `serve` 自动继续；网络检查错误会重试，不会当成权限不足 |
| `serve: not implemented yet` | 这个二进制早于桥的实现，重新编译或下载当前 release |
| 手机上什么都收不到 | 日志里有 `feishu long connection up`，但从来没有 `first feishu event delivered`：凭据没问题，问题在应用的事件上。**如果应用是你在控制台手工配的，多半是最后一次改动之后没发布版本** —— 这只在手动路径上需要，`herdr-agent setup` 产出的应用自带已发布版本（G18）。无论哪种情况，对着已有凭据跑一次 `herdr-agent setup`：它会采纳凭据、不开页面，并告诉你坏的是哪一次往返 |
| 卡片按钮报 `200340` | 卡片通路确实是关的 —— 这跟「卡片没人按」是两码事。手工建的应用要同时查两处：交互卡片开关，以及 `card.action.trigger` 订阅，因为代码分辨不出这两者，查完记得发布版本。通过 `setup` 确认页配好的应用，卡片通路开箱可用（实测），所以直接去看订阅 |
| agent 明明在等，却被报成 `idle` | herdr 靠在屏幕上匹配英文字符串来识别 claude 的弹窗，匹配不上时报 `idle`；pane 窄于 60 列会让那些字符串换行，匹配自然就断了（G5、G11）。`doctor` 对从未被 client 附着过的 pane 会 FAIL 并以 1 退出；把终端附上去一次，把它撑宽 |
| 你认为健康的安装上，`doctor` 却 FAIL 并以 1 退出 | 有一条 FAIL 是预期的：`claude integration installed` 和 `codex integration installed` 是两个独立检查，你不跑的那个 agent 对应的那条必然 FAIL。另一条容易踩的是真问题 —— 从未被 client 附着过的 pane（G5），撑宽一次即可 |
| `herdr detection manifests pinned` 一直是 WARN | 在 **herdr 自己的** `config.toml` 里设 `[update] manifest_check = false`，doctor 会打印确切命令。不钉死的话，决定「agent 是否被阻塞」的那些字符串每次 server 启动都从 herdr.dev 拉一遍，可能在你本地毫无改动的情况下变掉 |
| 镜像什么都不显示 | herdr server 的环境里有 `CLAUDE_CODE_*`，claude 因此把 transcript 保存关掉了（G7）；`herdr-agent doctor` 会指出来，`install.sh` 会修好 |
| 桥起来了但看不到 agent | 它连的 socket 跟你终端里的 `herdr` CLI 不是同一个，查 `XDG_CONFIG_HOME` 和 `HERDR_SESSION` |

## 飞书控制台清单 —— 手动兜底路径

**先试 `herdr-agent setup`**，已有的应用也一样能用（那正是 `--app cli_…` 的用途）。这一节存在的理由
是：那条命令依赖的设备授权端点未公开、可能毫无预告地消失，租户也可能拒绝它。真出这种事的时候，你需要
的是把整件事写在这儿，而不是一句「过会儿再试」。所以它是一等路径，不是备注。

在开放平台控制台，针对你的**自建应用**：

**权限管理** —— 四项基本聊天权限全加，少一项就会出现「消息到了但没有内容」或者「回复失败」：

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`

启用任务管理还需要[飞书任务与项目仓库](#飞书任务与项目仓库)中的五项新增权限。基础 setup 不会授予或
验证这些额外权限。

**凭证与基础信息 —— 现在就把凭据放到这台机器上，赶在下一步之前。** 两个值都在那个页面上：

```sh
mkdir -p ~/.herdr-agent && chmod 700 ~/.herdr-agent
cat > ~/.herdr-agent/.env <<'ENV'
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ENV
chmod 600 ~/.herdr-agent/.env
$EDITOR ~/.herdr-agent/config.toml   # allowed_open_ids = ["ou_..."]  <- 必填
```

你自己的 `open_id` 不在那个页面上。去开放平台 API 调试台读，或者先在白名单里塞个 `ou_…` 占位值，等
事件通了给机器人发条消息 —— `~/.herdr-agent/log/herdr-agent.err.log` 里那条「拒绝发送者」的 WARN 会
把真正的 id 报出来。`serve` 在白名单为空时拒绝启动；`setup` 则完全不用你预先填，它自己会写。

**事件订阅** —— 订阅方式选长连接（WebSocket）。不要请求 URL，不要加密 key，不要 verification token，
桥是主动往外连的。

- `im.message.receive_v1`
- `card.action.trigger`

**保存「订阅方式 = 长连接」之前，先让一条长连接开着。** 飞书要求在你保存那个设置的那一刻，该应用已经
有一条活着的长连接（G15）。这把顺序整个颠倒了过来：连接需要凭据，所以凭据必须先落盘 —— 上一步排在这
一步前面就是这个道理。在另一个终端把 `herdr-agent serve` 起来晾着，同时去保存；白名单里有个占位值就
够它启动，它会一直连着直到你停掉。`herdr-agent setup` 也会持有一条连接，但只在它等你消息的那 150 秒
里；而且两者共用同一把单实例锁，所以只跑其中一个。

**应用能力 → 机器人** —— 启用机器人，并把**交互卡片**开关打**开**。忘了这一步，在按下按钮之前完全
看不出来：卡片照发不误，只有按下会失败，报 `200340` —— 读起来像桥的 bug，其实不是。`card.action.trigger`
没订阅时也是同一个错误码，两者从外面根本分不开，所以下结论前两个都得查。

**版本管理与发布 —— 建一个版本并发布。** 在这条路径上这是必需的，而且是实测出来的、不是传说：在控制台
改的权限、事件、开关，不发布版本就不会在线上应用生效。这里**每改一次就重新发布一次**。如果机器人的行为
跟你改之前一模一样，原因十有八九在这儿。

这一步**只属于这条路径**。通过 `herdr-agent setup` 确认页配好的应用，到手时版本已发布、scope 已授予、
机器人能力已开启，同样是实测的（G18），所以基础 setup 完成后不用额外发布。之后增加任务权限属于新的
应用变更，需要按控制台发布流程使其生效。

最后无论如何还是跑一次 `herdr-agent setup` —— 先把上面晾着的那个连接停掉，它们共用一把锁。桥能读到的
文件里已经有凭据时，它不开页面也不建应用，只是采纳凭据，并用同样的两次往返把上面每一项不可见的配置
都验一遍。这比从「一片寂静」里去反推问题便宜得多。

## 杂项

**代码结构与可靠性。** [代码审计记录](docs/code-audit.md) 说明模块职责、设计约束、已复现并修复的问题、
共享实现和仍待处理的边界，包含本地验证方法。

**复用一个应用，好过再注册一个。** `setup` 会在你的租户里创建一个真实的飞书应用，而我们找不到任何 API
能删掉它（G18），所以每注册一次就是一份永久的垃圾。这就是为什么 `--reregister` 是显式参数而不是兜底
行为，也是为什么在确认页上挑一个已有的应用（或者用 `--app cli_…` 点名）值得多花那一秒。

**状态存在哪。** 桥的配置和运行状态在 `~/.herdr-agent/` 下（权限 0700）：`config.toml`、`.env`、
`projects.json`、`dedup.json`、`routes.json`、`selection.json`、`tasks.json`、`herdr-agent.pid` 和 `log/`。
`projects.json` 保存本地编辑的项目列表和全局 Bypass 设置；明确创建的新项目目录位于
`~/herder-agent-code/`。`tasks.json`
保存任务、群、工作区、pane 的绑定及生命周期进度，供重启恢复。启用 AI 后，`assistant-operations.json`
保存工具操作回执，`conversations/` 保存按用户和聊天隔离的对话检查点与消息回执，文件权限为 0600。
默认 memory provider 将摘要保存在 `memory/`；选择 HTTP provider 不会迁移近期原文、本地检查点、归档与回执。
模型旧上下文达到配置阈值后自动摘要，进度查询仍读取实际任务。普通镜像开关仍只活在内存里，重启后回到
`mirror.default_on`；托管任务会从绑定恢复自己的 transcript 跟随。app secret 只存在于
`.env`（权限 0600）或进程环境，从不写日志，`config.toml` 根本没有能装下它的字段。日志不做轮转。

**代码里那些 `(G1)` / `(G17)` 引用指向哪。** 它们是在这套确切的技术栈上**实测**出来的事实，不是从文档
里抄的，代码里每一条约束都能追溯到其中一条。承重的那几条本文都引用过了：G1 正文会批准被阻塞的弹窗；
G3 `agent.prompt` 在 TUI 收到之前就报成功；G5/G11 窄 pane 把 blocked 降级成静默的 `idle`；G7 server
的环境会流到每一个 pane；G8 transcript 里没有待批准权限的记录，所以屏幕和 transcript 是两个不同的
信息源；G10 herdr socket 等同于一个无认证的 shell；G14 飞书会重投 handler 失败的事件（约 5 分钟后、
逐字节相同 —— 在这里的意思是往一个活着的 agent 里再注入一遍命令）；G15 两条连接会静默瓜分你的事件；
G17 消息永不过期，所以旧卡片是上了膛的；G18 一键注册的应用到手就已发布；G20 herdr 的 pane id 永不
复用，所以窗口就是身份。完整记录 —— spec、设计决策和手动验收脚本 —— 放在 checkout 旁边而不公开，因为
里面引用了绝对路径和某个操作者的飞书应用配置。

## 许可证

MIT，见 [LICENSE](LICENSE)。
