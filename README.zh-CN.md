# herdr-agent

[English](README.md) · **简体中文**

编码 agent 干到一半停下来要权限，而你人不在电脑前。herdr-agent 把这个问题推到飞书：弹窗原文照搬，
选项做成按钮。你点一下，或者随手回一句，指令就回到终端里，agent 接着干。

它通过 [herdr](https://herdr.dev) 驱动 `claude` 和 `codex`。定位很窄，只服务你一个人：一台机器、
一个飞书应用、白名单里一个 `open_id`。

不需要公网 IP，不需要内网穿透，也没有 webhook。桥是主动连出去的飞书 WebSocket，笔记本待在 NAT 后面
照样能用。

## 开始之前：herdr

**[herdr](https://herdr.dev) 是前置依赖，先把它装好跑起来。** 真正托管你 agent 的终端是它，本项目
只负责跟它说话，所以这里不重复它的文档：

```sh
brew install herdr                          # 或者：curl -fsSL https://herdr.dev/install.sh | sh
```

照 [herdr 的 quick start](https://herdr.dev/docs/quick-start/) 走一遍，直到 `herdr server` 起来、
某个 pane 里有活着的 `claude` 或 `codex`。下面的内容都从这一步往后算。

herdr 那边还有两件事，漏了会直接影响这里：

- 装 agent 集成：`herdr integration install claude` / `herdr integration install codex`。codex 还得
  在它界面里按一次 `t` 信任 hook，否则 herdr 拿不到 session id，transcript 镜像也就无从跟起（G8）。
- herdr 要 **0.8.0 以上**。协议 19 是这边的 wire 类型实测过的下限。

再就是一个飞书账号。应用不用你手工建，`herdr-agent setup` 会准备好 —— 新建也行，挑你已有的也行。
真走不通还有[手动控制台清单](#飞书控制台清单--手动兜底路径)兜底。

这套东西全部在 macOS 上实测，现成的服务单元是 launchd。Go 代码本身跨平台，Linux 二进制也随版本发布，
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

桥从不启动 agent。哪个 agent 跑在哪、在哪个目录，始终由你说了算；本程序只负责把对话运过去。

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
凭据不在里面 —— 那个文件压根没有放密钥的字段，想误存都存不进去。真正会动的就两项：
`feishu.allowed_open_ids`（必填）和 `feishu.notify_chat_id`（留空就是不主动推送，agent 照样能驱动，
只是没人会提醒你它卡住了）。

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
- **版本已经发布了。** 在我们做任何发布动作之前，应用的 `online_version_id` 就已经非空。**所以 `setup`
  跑完之后你没有任何东西需要发布。** 这跟控制台流程教的正好相反，值得明说：让你去找一个根本不需要的
  发布按钮，最后的结果一定是你以为自己哪儿配错了。

两次往返，少一次都不算成功：

| 退出码 | 含义 |
|---|---|
| 0 | 端到端已验证：你的消息到了，你的按钮回调也回来了 |
| 3 | 应用存在、凭据已落盘，但往返没有被证明。会打印一份编号清单，每项配一个 URL 说明还差什么；重跑 `setup` 会跳过注册直接重验 |
| 1 | 没产出任何可用的东西 |

**重跑 `setup` 是预期中的修复手段**，不是重新装一遍。桥能读到的任何位置上已有的凭据都会被采纳并验证，
所以重跑不开页面、不建应用，只告诉你两次往返里坏的是哪一次。三个参数用于它推断不出来的场景，首次运行
一个都用不上：

| 参数 | 什么时候用 |
|---|---|
| `--app cli_…` | 指定用**那个**应用。桥能读到的文件里已经有它的 secret，就完全不开页面。没有的话 —— 飞书的 app secret 只显示一次，所以你手工建的应用基本都属于这种 —— 确认页会*针对那个应用*打开，把桥需要的东西重新授一遍，并交回一个可用的 secret。两种情况都不会新建应用 |
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

机制上有一条得交代清楚：`setup` 用的设备授权端点是**未公开的**，在 open.feishu.cn 上根本查不到，随时
可能变更或消失。所以下面那份手动清单是一条正经的备选路径，不是脚注。

## 在手机上用

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
| `/close` | 结束跟当前 agent 的对话；在你重新选之前不瞄准任何人 |
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
卡片回调、镜像 —— 而推送目标只从配置里读，绝不从收到的消息里取，任何能跟机器人说话的人都无法把你 agent
的屏幕重定向给自己。

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
| 桥每 30 秒重启一次 | 它在启动阶段就退了，原因在 `log/herdr-agent.err.log`，通常是 `allowed_open_ids` 为空，或者凭据没加载上 |
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

**权限管理** —— 四项全加，少一项就会出现「消息到了但没有内容」或者「回复失败」：

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`

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
机器人能力已开启，同样是实测的（G18），所以它跑完之后没有任何东西要发布。

最后无论如何还是跑一次 `herdr-agent setup` —— 先把上面晾着的那个连接停掉，它们共用一把锁。桥能读到的
文件里已经有凭据时，它不开页面也不建应用，只是采纳凭据，并用同样的两次往返把上面每一项不可见的配置
都验一遍。这比从「一片寂静」里去反推问题便宜得多。

## 杂项

**复用一个应用，好过再注册一个。** `setup` 会在你的租户里创建一个真实的飞书应用，而我们找不到任何 API
能删掉它（G18），所以每注册一次就是一份永久的垃圾。这就是为什么 `--reregister` 是显式参数而不是兜底
行为，也是为什么在确认页上挑一个已有的应用（或者用 `--app cli_…` 点名）值得多花那一秒。

**状态存在哪。** 桥拥有的一切都在 `~/.herdr-agent/` 下（权限 0700）：`config.toml`、`.env`、
`dedup.json`、`routes.json`、`selection.json`、`herdr-agent.pid` 和 `log/`。镜像开关**故意**不在其中，
它只活在内存里 —— 重启后回到 `mirror.default_on`，而不是恢复一条你早就忘了的流。app secret 只存在于
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
