# herdr-agent

[English](README.md) · **简体中文**

你的编码 agent 干到一半停下来问权限，而你不在键盘前。herdr-agent 把这个问题推到飞书 —— 真实的弹窗文字，
真实的选项做成按钮 —— 你点一下，或者打一行字，回到终端里，agent 继续干。它通过
[herdr](https://herdr.dev) 驱动 `claude` 和 `codex`，并且从设计上就是单用户的：一台机器、一个飞书应用、
白名单里一个 `open_id`。

不需要公网 URL，不需要内网穿透，不需要 webhook。桥是主动拨出去连飞书的 WebSocket，所以笔记本在 NAT
后面也能用。

## 开始之前：herdr

**[herdr](https://herdr.dev) 是前置依赖。** 它是真正跑你的 agent 的终端，本桥只跟它说话。按它自己的
文档装好、跑起来 —— 那不是本项目的事，本文也不重复：

```sh
brew install herdr                          # 或：curl -fsSL https://herdr.dev/install.sh | sh
```

然后照 [herdr 的 quick start](https://herdr.dev/docs/quick-start/) 走，直到你有一个 `herdr server`
在跑、并且某个 pane 里有活着的 `claude` 或 `codex`。下面的一切都假设你已经到了这一步。

herdr 那边还有两件事，因为它们在这里是承重的：

- `herdr integration install claude` / `herdr integration install codex`。codex 还要在它里面按一次
  `t` 信任 hook，否则 herdr 拿不到 session id，transcript 镜像就没有东西可跟（G8）。
- herdr **0.8.0 或更新**。协议 19 是这些 wire 类型实测过的最低版本。

你还需要一个飞书账号。`herdr-agent setup` 会帮你准备应用 —— 新建一个，或者用你已有的 ——
[手动控制台清单](#飞书控制台清单--手动兜底路径) 是受支持的兜底方案。

所有东西都是在 macOS 上实测的，现成的服务单元是 launchd。Go 代码本身可移植，Linux 二进制也随版本发布；
`serve` 在哪儿都只是一个普通前台进程。

herdr 那边有几项配置是**静默失败**的 —— 那是 herdr 的配置，不是本桥的，所以 `herdr-agent doctor` 会
逐条点名并打印修复命令，而不是由本文来教你怎么运行 herdr。机制写在
[故障排查](#故障排查)。

## 安装

两种方式，都受支持。

**下载 release。** 从 [Releases 页面](https://github.com/hewenyu/herdr-agent/releases/latest) 拿对应
你机器的产物 —— Apple Silicon 用 `darwin_arm64`，Linux 用 `linux_arm64` 或 `linux_amd64` —— 解开，
把 `herdr-agent` 放到 `PATH` 上任意位置。每个 release 还带一份 `SHA256SUMS` 供你校验，release notes
里有确切命令。

macOS 上这些二进制未签名，所以 Gatekeeper 会拒绝运行一个下载来的并说开发者无法验证。那看起来跟项目坏了
一模一样，其实不是：`xattr -d com.apple.quarantine ~/.local/bin/herdr-agent`。

**或者自己编译**，需要 Go 1.24 或更新：

```sh
go install github.com/hewenyu/herdr-agent/cmd/herdr-agent@latest
```

两种方式装完后，`herdr-agent version` 会告诉你手上到底是哪个构建。

## 快速开始

herdr 已经在跑，某个 pane 里有活着的 agent。三条命令：

```sh
herdr-agent setup     # 准备飞书应用：一个确认页，手机上点两下
herdr-agent doctor    # 在你信任它之前，先体检这台机器
herdr-agent serve     # 跑桥
```

然后在手机上给机器人发 `/ls`，点 **Select**，开始打字。

`setup` 不需要任何参数。它授权 scope、订阅事件、以 0600 写 `~/.herdr-agent/.env`、填好白名单和
`notify_chat_id` —— 然后**要求你真的发一条消息、真的按一个按钮**，因为上面每一项配错时的失败方式都同样
不可见。[关于 setup 的更多细节](#关于-setup-的更多细节)。

`doctor` 查的是两边那些会静默把桥搞坏的东西。一个健康的安装也会有几条非 PASS 的结果，所以要**读**而不是
数 —— [故障排查](#故障排查) 说明哪些是预期内的。

桥从不启动 agent。哪个 agent 跑在哪、在哪个目录，仍然由你决定；本程序只负责把对话运过去。

### 让它一直跑着

`serve` 是前台进程；塞进你已经在用的任何 supervisor，或者用 `deploy/` 里的服务单元。那些单元在 git
仓库里，不在 release 压缩包里（压缩包只有二进制、两份 README 和 `LICENSE`），所以要 clone：

```sh
git clone https://github.com/hewenyu/herdr-agent && cd herdr-agent
deploy/install.sh          # macOS：装两个 LaunchAgent 并启动
herdr-agent doctor         # 装完验证
```

这一步不需要编译。`install.sh` 会把绝对路径写死进单元文件（因为 launchd 没有可用的 `PATH`），并用
`command -v herdr-agent` 找到你已经装好的那个二进制；想用别的就传 `HERDR_AGENT_BIN=/path/to/herdr-agent`。

| job | 跑什么 |
|---|---|
| `com.hewenyu.herdr-server` | `herdr server`，从一个**洗干净的**环境启动（`env -i` 加上 `HOME`、`PATH`、`SHELL`、`TERM`、`LANG`） |
| `com.hewenyu.herdr-agent` | `herdr-agent serve`，也就是桥 |

`install.sh` 是幂等的：重写两个单元文件、把 job 停掉再启动、不动已有的 `config.toml`。加
`--bridge-only` 可以跳过 herdr server，如果你更愿意自己起它。Linux 上同一对以 systemd **user** 单元
发布：`deploy/herdr-agent.service` 和 `deploy/herdr-server.service`。`install.sh` 驱动的是 launchctl，
所以在 Linux 上它什么都不写，只打印出复制-启用的步骤 —— 包括 `loginctl enable-linger "$USER"`，没有它
两个单元会在你登出时停掉、开机也不会起。环境洗白也一并带过去了，因为那是承重的（G7），不是装饰。

环境洗白有两个后果值得在 agent 给你惊喜之前先知道：任何 pane 都拿不到 `SSH_AUTH_SOCK`，所以 agent 里
走 SSH 的 `git push` 会卡在密码短语提示上；任何 pane 都拿不到 `XDG_CONFIG_HOME`，所以如果你在 shell
里设过它，你终端里的 `herdr` CLI 和这个 server 会用两个不同的 socket。两条都带修复方案注释在
`deploy/com.hewenyu.herdr-server.plist` 顶部。

所有开关都在 `~/.herdr-agent/config.toml`，`deploy/config.example.toml` 逐条写了默认值和它所做的取舍。
凭据不在其中：那个文件根本没有放密钥的字段，所以密钥不可能被误存进去。你真正会想改的是两项：
`feishu.allowed_open_ids`（必填）和 `feishu.notify_chat_id`（留空 = 不主动推送，你仍然能驱动 agent，
只是没人会告诉你它需要你了）。

### 关于 setup 的更多细节

`setup` 不需要任何参数。它打印一个确认链接，本机有浏览器时会自动打开，然后等待。在那个页面上你有两个
同样好的选择：新建一个应用 —— 名字预填了 `herdr-agent` —— 或者**挑一个你已经有的**，因为页面也会列出
你租户里的应用。按下"确认"会给你选中的那个应用**授予**四项 scope、订阅 `im.message.receive_v1`、
申请 `card.action.trigger` 回调。整个协议就这些：注册数据块携带一个 preset、scope、事件和回调，没有
放别的东西的字段（G18）。

因此有两件事它无法设置、而应用却已经带着 —— 两条都是实测到的结果，不是谁执行的步骤（G18）：

- **事件已经在通过长连接投递。** 手机上一条真实私聊消息在零次控制台操作的情况下就到达了桥。协议里没有
  任何字段选择投递方式，所以这是 `setup` **观察到**的而不是它**配置**的：这正是它必须以一次真实往返
  收尾而不是给个断言的原因，也是
  [手动清单](#飞书控制台清单--手动兜底路径) 里仍然把「订阅方式 → 长连接」列为需要你亲手确认的一项的原因。
- **已经发布的版本。** 在我们做任何发布动作之前，应用的 `online_version_id` 就已经非空了。**所以
  `setup` 跑完之后你没有任何东西要发布** —— 这跟控制台流程教你的正好相反，值得明说，因为让你去找一个
  你根本不需要的发布按钮，结果就是你以为自己哪里配错了。

少于两次往返都不算成功：

| 退出码 | 含义 |
|---|---|
| 0 | 端到端已验证：你的消息到了，你的按钮回调也回来了 |
| 3 | 应用存在、凭据已落盘，但往返没有被证明。会打印一份编号清单，每项带一个 URL 说明还差什么；重跑 `setup` 会跳过注册直接重新验证 |
| 1 | 没有产出任何可用的东西 |

**重跑 `setup` 是预期的修复路径**，而不是第二次安装：桥能读到的任何位置上已有的凭据都会被采纳并验证，
所以重跑不开页面、不建应用，只告诉你两次往返里哪一次坏了。三个参数用于它推断不出来的情况，首次运行
一个都不需要：

| 参数 | 何时用 |
|---|---|
| `--app cli_…` | 用**那个**应用。如果桥能读到的某个文件里已经有它的 secret，那就完全不开页面。如果没有 —— 飞书的 app secret 只显示一次，所以你手工建的应用属于这种常见情况 —— 确认页会*针对那个应用*打开，重新授予桥需要的东西，并交回一个可用的 secret。两种情况都不会新建应用 |
| `--reregister` | 故意建**第二个**应用。你已有的那个原封不动，之后 `~/.herdr-agent/.env` 指向新的那个 |
| `--yes` | 绝不交互提问：给脚本和 launchd 用。配好了两个应用却不给 `--app` 会报错并点名两个文件，因为猜错会让桥指向一个你从没发过消息的机器人，而症状是「什么都没有」。等你消息或按钮的时长不受任何参数延长；清单打印出来，运行以退出码 3 结束，应用和凭据都已落盘 |

**跑 setup 之前先停掉桥。** 飞书的长连接是集群模式 —— 每个应用最多 50 条连接，事件在它们之间**随机**
分发 —— 所以同一个 `app_id` 上的第二个客户端不会干净地失败，它会静默地分走你一部分真实消息（G15）。
`setup` 拿的是跟 `serve` 同一把单实例锁，会直接拒绝而不是共享。`install.sh` 跑过之后，桥就是那个第二
客户端：

```sh
launchctl bootout gui/$(id -u)/com.hewenyu.herdr-agent
herdr-agent setup
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hewenyu.herdr-agent.plist
```

机制上有一条需要说明：`setup` 用的设备授权端点是**未公开的**。它在 open.feishu.cn 上根本查不到，可能
随时变更或消失 —— 这就是为什么下面的手动清单是一条受支持的路径，而不是脚注。

## 在手机上用

在跟机器人的私聊里发 `/ls`。你会拿到一张**选择卡片**：每个 agent 一行，被阻塞的排在最前，每行显示 kind、
目录、pane id、状态，以及 agent 自己说它在干什么。

```
🔴 claude · herdr-agent           [ Select ]      [ Screen ]
   w1:p1 · blocked · Create hello.txt with touch
▶ ⏳ codex · api                  [ ✓ Selected ]  [ Screen ]
   w1:p2 · working · refactor the router
```

点 **Select**，然后直接打字。纯文本就发给选中的那个 agent —— 不用 pane id、不用长按、不用命令。每次
选择变化卡片都会**就地重绘**，所以切换 agent 是在你已有的卡片上点一下，而不是再发一次 `/ls`。`▶`
标记当前行。

**选择会一直有效，直到你发 `/close`。** 不是十二小时，不是到桥重启为止，也不是到 agent 做了什么为止：
一次有意的点击打开通道，一次有意的命令关闭它，「我为什么又要重新选一次？」只有一个答案 —— 因为你自己
要求的。具体来说，下面这些**过去会**结束它的情况，现在都不会：

- agent 里的 `/clear` 或一次 compaction。还是同一个窗口里的同一个 agent，你的输入照样过去；只会告诉你
  一次：它不记得你们之前聊过什么了。
- agent 退出、又在同一个 pane 上按同样的活重新启动。它不在的时候你得到的是「什么都没发出去，本会话仍然
  瞄准 claude · herdr-agent · w1:p1」而不是一张选择卡，等它回来打字就继续。
- 桥被 kill 掉再重启 —— 这本来就是家常便饭。
- 一个晚上、一个周末、一个假期。安静十二小时之后下一条消息照样投递，只多一行告诉你是多久以前选的 ——
  只说一次，所以天天在用的会话根本看不到它。

**你锚定的是窗口。** herdr 从不复用 pane id —— 公开 pane 编号只增不减，pane 关掉也不释放，而且计数器
跨重启持久化 —— 所以 `w2:p2` 在整个安装周期里只指同一个窗口。这就是为什么别的都不需要再校验，也是为什么
校验别的东西是个错误：真机上两个 agent 完全可能共用一个目录（`w2:p1 codex` 和 `w2:p2 claude` 都在
`~/code/yuebanhome`），而同一个项目里的两个 claude 连 kind 都一样。**只有 pane 能区分它们，而且永远能。**

唯一仍然会拒绝投递的情况是**那个窗口里换成了别的程序** —— 你在 `w1:p1` 里退出了 claude 又起了 codex。
窗口活得比 agent 长。此时什么都不发，告诉你变了什么，瞄准点留在原处直到你自己挪动它。

如果你在同一个窗口里把 agent 重启到了**另一个项目**上，消息照样投递 —— 那还是你的窗口 —— 并且多一行
告诉你它挪了：「w1:p1 里的 claude 现在工作在 ~/other，你选它的时候它在 ~/project」。是**告知不是拒绝**：
herdr 报的目录也会跟着 Bash 工具调用跑进子目录，拿它来拒绝就会在任务干到一半时丢消息。

**回复某条消息可以为这一条消息覆盖当前选择。** 这就是你如何用一个会话同时驱动多个 agent 而又保有一个
默认目标：回复会路由到那条消息所关于的 agent，并且不改变纯文本的瞄准点。（被镜像的 agent 回合是流式
消息，飞书不给流式消息任何桥能登记的 id，所以回复它们无法路由 —— 这一点会明确告诉你，而不是让你猜。）

斜杠命令作为逃生口一直可用：

| 命令 | 作用 |
|---|---|
| `/ls` | 选择卡片：所有 agent、状态、pane、kind、cwd、标题 |
| `/card <pane>` | 把该 pane 当前屏幕推成可操作卡片 |
| `/say <pane> <text>` | 走安全路径给那个 agent 发文字 |
| `/stop <pane>` | 发 `esc` —— 从弹窗里安全退出的方式 |
| `/mirror <pane> on\|off` | 在会话里跟随该 agent 的 transcript（默认关） |
| `/close` | 停止跟当前选中的 agent 对话；在你重新选之前不瞄准任何人 |
| `/doctor` | 跟 `herdr-agent doctor` 相同的检查 |
| `/help` | 这张表 |

解析不了的斜杠命令会回一条明确的错误，**绝不**降级成自由文本：`/stpo w1:p1` 当作正文发给一个被阻塞的
agent 就是一次误批准（G1）。

### 阻塞卡片

agent 停下来等你的时候，你会收到一张红色卡片：它的 kind、目录、任务标题，弹窗原文放在代码块里，以及
**弹窗实际提供的每个选项各一个按钮** —— 从屏幕上读出来的，不是写死的，因为选项数量随 agent 和版本变化。
每个带编号的按钮都用中性样式，包括 `1. Yes`：卡片上最显眼的东西不该是「同意」。它们下面、用看起来最
危险的样式画的是 `Esc · back out` —— 那才是安全键，故意画得吓人，因为退出弹窗是你随时可以反悔的选择。

按下之后卡片立刻被改写成一张灰色的、没有按钮的版本，写明谁在什么时候按了什么、结果如何。agent 干完时
你会收到一张绿色卡片，显示**agent 说了什么** —— 取自它自己的 transcript，不是终端截图 —— 完整屏幕在
`Screen` 后面一点即达。

给正在忙的 agent 打字，消息**直接送进去**。工作中的 agent 自己有输入队列 —— 文字落进它的输入框，本轮
结束时提交 —— 所以桥不扣任何东西，你连着发的几句会按发送顺序到达，而不是一句一句挤牙膏。

### 在机器上

同样的能力也是一套 CLI，同时也是控制层的验收面：

```
herdr-agent setup                   注册飞书应用，或复用一个，并证明它能工作
herdr-agent doctor                  检查那些会静默搞坏桥的东西
herdr-agent ls                      列出 herdr 能看到的每个 agent 及其状态
herdr-agent dialog <pane>           打印 agent 正在问什么
herdr-agent tail <pane> [-n 18]     打印可见视口的最后几行
herdr-agent key <pane> <key>        回答一个菜单，走完整的 guard 校验
herdr-agent say <pane> <text...>    走安全路径发送文字
herdr-agent transcript <pane>       打印该 agent 原生 transcript 文件的路径
herdr-agent watch                   流式输出状态迁移，每条一行带时间戳
herdr-agent serve                   跑桥，直到 SIGINT 或 SIGTERM
herdr-agent version                 打印烧进这个二进制的版本、commit 和构建日期
```

## 安全模型

你正要让一个聊天软件在你的终端里按键。有四条规则让这件事站得住脚。

**正文永远不会到达被阻塞的 agent。** herdr 的 `agent.prompt` 会粘贴你的文字然后按回车，而权限弹窗是
**菜单不是文本框** —— 粘贴的文字被丢弃，那个回车选中了高亮的默认项，通常就是 `1. Yes`。实测（G1）：
给一个被阻塞的 claude 发「absolutely not, do NOT run this command」，*结果它把那个它正在拒绝的文件建出来了*。
所以桥会先发 `esc`，等 agent 稳定下来，然后才投递你的话。它也从不宣称超出自己所知的事：`agent.prompt`
在字节进入 PTY 队列时就返回成功，所以事后在屏幕上找不到的消息会被报成「已发送但未确认」（G3），而不是
「已投递」。

**旧卡片会被解除武装。** 飞书消息永不过期，三天后按下的按钮照样会往那个 pane 今天跑着的任何东西里打一个
键 —— 实测（G17）。所以每个按钮都携带 pane、agent kind、它的原生 session id 以及它被铸造时的状态序号，
通过 nonce 保证单次使用，并且卡片在被用掉的瞬间就被改写成静态的「已处理」版本。过期的按下不会发出任何
按键，并会告诉你为什么。够不到键盘的按钮 —— `Select`、`Screen` —— 跳过这一整套，因为它们没有什么可解除的。

**白名单是强制的，且默认拒绝。** herdr 的 socket 没有任何形式的认证，只靠文件权限保护，所以能连上它
就等同于在这台机器上有一个 shell（G10）。`allowed_open_ids` 上的任何人都能批准这台机器上任何 agent
正在请求执行的任何命令。所以空列表是启动即硬失败，而不是安静地放行所有人；每一个入口都校验它 ——
消息、卡片回调、镜像 —— 而推送目标只从配置里读，绝不从收到的消息里取，所以任何能跟机器人说话的人都
无法把你 agent 的屏幕重定向给自己。

**每一条回复都点名它发给了谁。** 不是「已发送」，而是「Delivered to claude · herdr-agent · w1:p1.
It is now idle.」—— kind、目录、pane。pane id 是座位不是身份：一个 agent 可能退出，另一个在同一个窗口
里启动，所以任何被记住的目标 —— 一次选择、一条回复绑定 —— 在投递任何东西之前都会重新对照现在坐在那个
pane 里的是谁，变了就告诉你，而不是悄悄改投。校验的是 **pane 和 kind**：pane 是因为 herdr 从不复用它，
kind 是因为窗口活得比里面的 agent 长。session id 和工作目录只记录、只上报，**从不比对** —— 前者每次
`/clear` 都变，后者在两个不同 agent 之间可能相等、还会跟着 Bash 工具调用移动，拿任何一个来比对都结束过
本不该结束的对话。

## 故障排查

| 症状 | 原因 |
|---|---|
| macOS 拒绝运行二进制：「无法打开，因为无法验证开发者」 | 这是一个下载来的、未签名的二进制，被 Gatekeeper 隔离了：`xattr -d com.apple.quarantine <path>`。安装本身没有任何问题 |
| 消息**时好时坏** | 有两个进程在用同一个 `app_id`。飞书长连接是集群模式 —— 每个应用最多 50 条 —— 它把事件在所有打开的连接之间**随机**分发，所以不报错也不断连：每个进程只收到大约一半消息（G15）。这就是为什么单实例是被强制而不只是被建议的，也是为什么在活着的桥旁边跑一个诊断探针会静默偷走你一半真实流量。检查有没有多余的 `herdr-agent serve`，以及任何其他指向同一个应用的工具 |
| 桥每 30 秒重启一次 | 它在启动时就退出了；原因在 `log/herdr-agent.err.log`，通常是 `allowed_open_ids` 为空，或者凭据没加载上 |
| `serve: not implemented yet` | 二进制早于桥的实现 —— 重新编译，或下载当前的 release |
| 手机上什么都收不到 | 日志里有 `feishu long connection up` 但从来没有 `first feishu event delivered`：凭据是好的，问题出在应用的事件上。**如果你是在控制台手工配的应用，多半是最后一次改动之后没有发布版本** —— 这只在手动路径上需要；`herdr-agent setup` 产出的应用自带已发布版本（G18）。无论哪种情况，对着已有凭据跑一次 `herdr-agent setup`：它会采纳凭据、不开页面，并告诉你哪一次往返是坏的 |
| 卡片按钮报 `200340` | 卡片通路确实是关的 —— 这跟「卡片没人按」是两回事。手工建的应用要同时检查两个原因：交互卡片开关，以及 `card.action.trigger` 订阅，因为代码分辨不出这两者，然后发布一个版本。通过 `setup` 确认页配好的应用，卡片通路是开箱可用的（实测），所以去看订阅 |
| agent 明明在等，却被报成 `idle` | herdr 靠在屏幕上匹配英文字符串来识别 claude 的弹窗，匹配不上时报 `idle` —— pane 窄于 60 列会让那些字符串换行从而匹配失败（G5、G11）。`doctor` 对从未被 client 附着过的 pane 会 FAIL 并以 1 退出；把终端附着到那个 pane 一次以加宽它 |
| 你认为健康的安装上 `doctor` 却 FAIL 并以 1 退出 | 有一条 FAIL 是预期的：`claude integration installed` 和 `codex integration installed` 是两个独立检查，你不跑的那个 agent 对应的那条会 FAIL。另一条容易踩到的 FAIL 是真的 —— 从未被 client 附着过的 pane（G5），加宽一次即可 |
| `herdr detection manifests pinned` 一直是 WARN | 在 **herdr 自己的** `config.toml` 里设 `[update] manifest_check = false`；doctor 会打印确切命令。不钉死的话，决定「agent 是否被阻塞」的那些字符串会在每次 server 启动时从 herdr.dev 拉取，可能在你本地毫无改动的情况下变化 |
| 镜像什么都不显示 | herdr server 的环境里有 `CLAUDE_CODE_*`，所以 claude 把 transcript 保存关掉了（G7）；`herdr-agent doctor` 会指出来，`install.sh` 会修好 |
| 桥起来了但看不到 agent | 它连的 socket 跟你终端里的 `herdr` CLI 不是同一个 —— 检查 `XDG_CONFIG_HOME` 和 `HERDR_SESSION` |

## 飞书控制台清单 —— 手动兜底路径

**先试 `herdr-agent setup`**，包括对你已有的应用（那正是 `--app cli_…` 的用途）。本节存在的原因是：
那条命令依赖的设备授权端点是未公开的、可能毫无预告地消失，而且租户可能拒绝它。真发生的时候你需要的是
把整件事写下来，而不是一句「过会儿再试」—— 所以这被当作一等路径保留。

在开放平台控制台，针对你的**自建应用**：

**权限管理** —— 四项全加，否则消息到达时没有内容，或者回复失败：

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`

**凭证与基础信息 —— 现在就把凭据放到这台机器上，在下一步之前。** 两个值都在那个页面上：

```sh
mkdir -p ~/.herdr-agent && chmod 700 ~/.herdr-agent
cat > ~/.herdr-agent/.env <<'ENV'
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ENV
chmod 600 ~/.herdr-agent/.env
$EDITOR ~/.herdr-agent/config.toml   # allowed_open_ids = ["ou_..."]  <- 必填
```

你自己的 `open_id` 不在那个页面上。去开放平台 API 调试台读，或者先在白名单里放任意 `ou_…` 占位值，等
事件通了之后给机器人发一条消息：`~/.herdr-agent/log/herdr-agent.err.log` 里那条「拒绝发送者」的 WARN
会点名真正的那个。`serve` 在白名单为空时拒绝启动；`setup` 则完全不需要预先填，因为它会自己写进去。

**事件订阅** —— 订阅方式选 长连接（WebSocket）。不需要请求 URL、不需要加密 key、不需要 verification
token；桥是主动向外连的。

- `im.message.receive_v1`
- `card.action.trigger`

**在保存「订阅方式 = 长连接」之前，先让一条长连接开着。** 飞书要求在你保存那个设置的那一刻，该应用
已经存在一条活着的长连接（G15）—— 这把显而易见的顺序颠倒了过来：连接需要凭据，所以凭据要先落盘 ——
这正是上一步排在这一步前面的原因。在另一个终端里起 `herdr-agent serve` 并让它开着，同时去保存；白名单
里有个占位值就足以让它启动，而它会一直连着直到你停掉它。`herdr-agent setup` 也会持有一条连接，但只在它
等你消息的那 150 秒内 —— 而且两者拿的是同一把单实例锁，所以只跑其中一个，不要两个都跑。

**应用能力 → 机器人** —— 启用机器人，并把**交互卡片**开关打**开**。忘了这一步在按下按钮之前完全不可见：
卡片照样发得好好的，只有按下会失败，报 `200340`，读起来像是桥的 bug 而它不是。`card.action.trigger`
没订阅时也会出现同一个错误码，两者从外部无法区分，所以下结论前两个都要检查。

**版本管理与发布 —— 创建一个版本并发布。** 在这条路径上这是必需的，而且是实测出来的、不是传说：在
控制台改动的权限、事件或开关，在版本发布之前不会在线上应用生效。这里**每改一次就要重新发布一次**。
如果机器人的行为跟你改动之前一模一样，原因就在这里。

这一步**只属于这条路径**。通过 `herdr-agent setup` 确认页配好的应用，拿到手时版本已发布、scope 已授予、
机器人能力已开启 —— 同样是实测的（G18）—— 所以它跑完之后没有任何东西要发布。

然后无论如何也跑一次 `herdr-agent setup` —— 先把上面留着连接的那个停掉，因为它们共用同一把锁。当桥能
读到的文件里已经有凭据时，它不开页面也不建应用：它采纳凭据，并用同样的两次往返证明上面每一项不可见的
配置 —— 这比从「一片寂静」里去发现问题便宜得多。

## 杂项

**复用一个应用好过再注册一个。** `setup` 会在你的租户里创建一个真实的飞书应用，而我们找不到任何 API
能删掉它（G18），所以每一次注册都是永久的垃圾。这就是为什么 `--reregister` 是一个显式参数而不是兜底
行为，也是为什么在确认页上挑一个已有的应用 —— 或者用 `--app cli_…` 点名它 —— 值得多花那一秒。

**状态存在哪。** 桥拥有的一切都在 `~/.herdr-agent/` 下（权限 0700）：`config.toml`、`.env`、
`dedup.json`、`routes.json`、`selection.json`、`herdr-agent.pid` 和 `log/`。镜像开关**故意**不在其中：
它只在内存里，所以重启后回到 `mirror.default_on`，而不是恢复一个你早就忘了的流。app secret 只存在于
`.env`（权限 0600）或进程环境里，从不写日志，而 `config.toml` 根本没有能装下它的字段。日志不做轮转。

**代码里那些 `(G1)` / `(G17)` 引用指向哪。** 它们是在这套确切的技术栈上**实测**出来的事实，不是从文档
里读来的，代码里每一条约束都能追溯到其中之一。承重的那些在本文里都引用过了：G1 正文会批准被阻塞的弹窗，
G3 `agent.prompt` 在 TUI 拿到之前就报成功，G5/G11 窄 pane 把 blocked 降级成静默的 `idle`，G7 server
的环境会到达每一个 pane，G8 transcript 里没有待批准权限的记录所以屏幕和 transcript 是两个不同的信息源，
G10 herdr socket 等同于一个无认证的 shell，G14 飞书会重投 handler 失败的事件（约 5 分钟后、逐字节相同，
在这里意味着往一个活着的 agent 里再注入一遍命令），G15 两条连接会静默瓜分你的事件，G17 消息永不过期
所以旧卡片是上了膛的，G18 一键注册的应用到手就已发布，G20 herdr 的 pane id 永不复用所以窗口就是身份。
完整记录 —— spec、设计决策和手动验收脚本 —— 保存在 checkout 旁边而不公开，因为它们引用了绝对路径和某个
操作者的飞书应用配置。

## 许可证

MIT。见 [LICENSE](LICENSE)。
