# 2026-09-18 CLI 二进制实测证据

本记录补充 [CLI 验收矩阵](live-validation.md#5-cli-全入口矩阵)。结论只对应下述二进制及实际执行的分支；后续代码修改和重新构建不自动继承通过状态。setup 注册、补授权及真实消息／卡片往返未在本组执行。

## 运行对象与原始记录

| 项目 | 实测值 |
| --- | --- |
| 平台 | macOS `darwin/arm64` |
| 二进制版本 | `0.3.0-live-validation` |
| 嵌入 commit | `8b6bc6a0b30d0f845c5af9d5e15fafde78ab7557`；包含当时工作区修改，commit 本身不能唯一定位内容 |
| 构建时间 | `2026-09-18T00:13:08.752Z` |
| 二进制 SHA256 | `793b9006aaf8f56a7fe5d4de90fd2dfe5a3eebaaa20f0aa5df9e7ad2c982c098` |
| 主执行区间 | 2026-09-18 00:16:12.657–00:16:22.193 UTC，即北京时间 08:16 |
| C05 修正输入后复验 | 2026-09-18 00:24:53.942–00:24:56.156 UTC，即北京时间 08:24 |
| 执行方式 | 将真实 SEA 可执行文件复制到独立临时目录运行；目录没有源码和 `node_modules`；配置和迁移使用独立 state |

原始证据为本地文件，不保证随仓库提交：

- [CLI 主报告](../.cache/live/cli-2026-09-18T00-16-12.656Z.json)：11 组中 10 组通过，配置恢复组因测试输入的空 model 被拒而未完成。
- [无效 provider 重启失败报告](../.cache/live/cli-2026-09-18T00-16-40.525Z.json)：保存 `provider=openai` 后 configure 重启退出 1。
- [配置恢复补验](../.cache/live/cli-2026-09-18T00-24-53.941Z.json)：改为合法 `provider=openai-responses`，同一 SHA 二进制通过保存、要求重启和重启恢复。
- 执行脚本：`.cache/cli-live-validation.mjs`。记录保存退出码、字节数、输出 hash 和必要状态，不保存生产凭据或终端／会话正文。

两份成功报告合计覆盖原计划的 11 组检查。这个计数不代表 C01–C16 的全部分支均已验证。

## C01–C16 状态对照

状态沿用主矩阵：R-P 为表中明确范围的真实执行通过，R-部分为只验证部分入口，U 为未执行。迁移使用合成旧数据，但执行的是上述独立二进制的真实文件、数据库与备份流程；不计为生产状态迁移验收。

| ID | 本组状态 | 实际执行与观察 | 仍未覆盖的范围 |
| --- | --- | --- | --- |
| C01 帮助 | R-P | `help`、`-h`、`--help` 均退出 0，输出一致且含 `debug transcript`；指定的不存在 state 路径未创建。未知命令和多余位置参数退出 2 | 全部帮助文字逐项与实现比对仍属于文档审查 |
| C02 版本 | R-P | `version`、`-v`、`--version`、`version --json` 均退出 0；JSON 核验 version/commit/date，独立文件 SHA 如上 | 后续新构建及安装路径须另外核对 |
| C03 默认启动／serve | R-部分 | 显式 `serve --state-dir <isolated> --config-listen 127.0.0.1:0` 在无凭据时提供 Web；authorization=`setup_required`、runtime=`waiting`；SIGTERM 退出 0 | 无命令默认入口、带真实凭据的唯一 WS 连接、herdr 断线分支未在本组验证 |
| C04 serve 选项 | R-部分 | `--config-listen` 回环动态端口可访问；`--no-config-ui` 无 stdout 且 SIGTERM 退出 0。以 configure 验证实际端口占用和 `0.0.0.0` 拒绝均退出 1，随后合法启动成功 | `--open` 及浏览器打开失败；serve 自身的占用／非回环分支未单独复验 |
| C05 configure | R-部分 | `configure --listen 127.0.0.1:0` 显示 offline/ready；同 state 第二实例退出 1。创建本地 session 后 SIGKILL，残留 PID 经重启恢复，session 保留；SIGTERM 退出 0 并移除锁。合法模型设置保存后提示重启，重启恢复 ready | `--open` 未测；无效 provider 接受保存的缺陷见下文，修复后新二进制待复验 |
| C06 setup | U | 本组没有执行注册、复用应用授权或验证往返 | 新注册、复用、取消、权限延迟、凭据已存但验证未完的退出码 3，以及消息／卡片回调 |
| C07 setup 选应用／补授权 | U | 本组没有执行 `setup --app` 的有效流程或 `--update-permissions` | 应用选择、凭据来源冲突与真实补授权流程 |
| C08 setup 替代注册 | R-部分 | `setup --reregister` 缺 `--yes` 退出 2；`--reregister --yes --app cli_test` 冲突退出 2，均在参数解析阶段拒绝 | 有效替代注册、与 `--update-permissions` 冲突、失败后旧凭据保留未在本组实测 |
| C09 setup 超时／不打开浏览器 | R-部分 | `--timeout 0`、`--timeout 2h` 退出 2；`--timeout invalid` 非零退出（该二进制为 1）；均未开始注册 | 负数、合法时长、`--no-open` 的有效授权流程、实际到期停止后台操作 |
| C10 doctor | R-部分 | 旧二进制 `doctor --json` 输出 11 项 pass、`pane-width` fail 并退出 1；保留这个实际输出。E17 后续确认旧宽度算法仅测可见内容，不能据此判定终端过窄 | E17 补文本／JSON及无 agent 正常分支；真实终端列数、每种 unknown／不可读条件、全部脱敏边界仍未覆盖 |
| C11 debug ls | R-P | 真实 herdr `debug ls` 退出 0，返回当时 1 个 agent；只查询已有执行器 | herdr 不可用／身份未知分支未在本组验证 |
| C12 debug screen | R-部分 | 读取已授权验证用 Codex pane 退出 0，返回身份匹配、464 字符现场；缺失 pane 退出 1；未保存正文 | 非 coding agent、身份替换、Guard 使用完整菜单的功能须看其他专门证据 |
| C13 debug transcript | R-P | 同一真实 Codex pane 退出 0，返回 0 entries 且 cursor 存在，符合初读默认取尾部基线的语义 | 此结果不证明返回全部历史，也不证明之后的增量事件或 Claude transcript 路径 |
| C14 migrate dry-run | R-P（隔离数据） | `migrate --state-dir=<isolated> --dry-run --json` 退出 0，返回 planned；此前不存在的 DB 和 backups 未创建，源文件 hash 未变；已有 DB 的 dry-run 前后记录相同 | 生产旧状态、所有损坏输入／缺失身份分支未在本组执行 |
| C15 migrate | R-部分（隔离数据） | 实际导入 task/participant/session/receipt/message/memory；备份源 hash 一致。再次执行返回 already_migrated，DB 相同且仅一个备份；源变化时退出 1 且 DB 不变。导入未知写入保持 uncertain，configure 重启未改写任务或重放操作 | 生产迁移、真实 herdr 旧 final 基线与所有历史数据变体 |
| C16 全局参数 | R-部分 | 独立 `--state-dir`、`--state-dir=...`、version/doctor/migrate 的 JSON 有实际运行；不适用 flag、单横线旧 flag、缺值、布尔 flag 附值、多余位置参数退出 2 | 路径展开、所有命令错误的 JSON 契约与全部组合未在本组验证 |

## 恢复和失败证据

状态锁验证用了两个真实 configure 进程：第二进程因同 state 锁拒绝；第一进程 SIGKILL 后，以同目录重启恢复 session 并清除失效 PID。另以损坏 SQLite 文件启动 configure，退出 1，文件字节 hash 不变且锁释放。它们分别支持 B02／B18 的具体恢复分支，不代表完整灾难恢复验收。

C05 第一次失败来自测试提交空 model，被 HTTP 400 正确拒绝；没有据此判定产品故障。第二次提交非空 model 但使用无效 provider `openai`，HTTP 保存曾成功，随后 configure 重启失败。代码核对发现保存路径遗漏 provider 枚举验证，与启动读取只接受 `openai-responses`／`anthropic-messages` 不一致。这是真实暴露的输入验证缺陷；工作区已加入修复和 `tests/app/model-config.test.ts`，本报告中的旧 SHA 不包含该后续修复，不能把合法 provider 补验当成修复的真实二进制验收。

doctor 的原始记录确实为 config、herdr、codex、claude、authorization、owner、pi、claude-hook、codex-hook、server-environment、detection-manifest 通过，pane-width 失败，退出码与该输出一致。但 E17 代码核对发现，旧算法把最长可见内容行不超过 60 列直接判 fail，并未读取终端实际列数；短文本也可能出现在宽终端。因此撤回“正确报告现场过窄”的解释，保留旧 fail 输出，不能反向把它改写为通过或要求据此调整窗口。

## E17：当前二进制只读补验与宽度诊断修正

`.cache/live/cli-e17-readonly.json`（03:05:30–03:05:35 UTC）固定 `5d1e96f1698af95ad0fa2317b34b73441518e968`，SEA SHA256 `c165c6424037337cda912bc4471731fb7d0dfdc250c9e083148e8922b2c39ec5`，当时服务 PID26077。实际执行 help/version 别名、debug ls、缺失 pane 的 screen/transcript、参数拒绝和 doctor 的 JSON／文本入口；报告全部检查通过，生产数据库／配置与二进制前后 hash 不变。

当时真实 herdr agent 数为 0，doctor 两种格式均为 12 项 pass、退出 0；pane-width 的含义只是“没有运行中的 agent，无需测量”。这不证明旧 pane 已调整宽度，也不提供本版本成功读取真实 screen/transcript 的新证据。缺失 pane 均退出 1，错误仍为文本；help 带 `--json` 仍输出文本，debug 成功默认即为 JSON，不宣称全局统一 JSON 错误协议。setup、serve、配置写入及断线恢复未在这组执行。

`.cache/live/cli-e17-pane-width-before.json` 与 `cli-e17-pane-width-fixed.json` 使用合成屏幕文本验证源码 helper：短文本 `ready` 从 fail 改为 unknown，空白与 60 列为 unknown，61 列 ASCII／62 列 CJK 为可见内容估算通过。修复源码 SHA256 为 `67902a772e7bec02929c08dd7e2eb9d453e51cd23eb78f10de9dc2dbb5f1306b`；此处记 O-P，不是已部署二进制真实终端几何验证。报告中的运行 5d1e96f stamp 仅用于区分当时部署，不表示该部署包含宽度修复。

后续 `.cache/live/cli-e17-pane-width-live.json`（03:15:49 UTC）只读访问本轮明确授权的 `w1E:p1`：agent.get 返回 agent_not_found／not_executed，pane.get 确认 pane 存在、目录匹配、agent=null。未读取 screen，诊断 unknown，不能计作真实宽度测量或当前二进制成功 screen/transcript 复验。该空 pane 来自正式 LIVE-001 请求：群／远端任务已创建，但显示名 `Codex` 被 herdr 以 invalid_agent_name 拒绝，程序误分类 unknown；该业务链路保留 R-F。完整证据与同群 `/clear` 拒绝的独立通过分支见 E17 主记录。

迁移另见 [E17 本地副本证据](live-evidence-2026-09-18.md#e17当前-cli-与真实旧状态副本迁移)。它使用同一 5d1e96f 二进制和真实旧 JSON 的隔离副本；C14/C15 可补限定的 R-local-copy，不能写成生产迁移或完整回退已通过。

## 对主矩阵的更新建议

CLI 章节原来的“本轮执行与真实状态均 U”已经过期，应引用本表逐项状态。C06、C07 继续 U；C08、C09 仅参数拒绝分支有证据，不能写成 setup 流程通过。C01、C02、C11、C13、C14 可在上述限定范围标 R-P，其余行标 R-部分并保留未覆盖项。当前发布候选重新构建后，应至少重新执行受代码变更影响的配置保存／启动、状态恢复和迁移检查，再注明新的 SHA。


### E17 修复后的真实专用 pane

源码 `a6018ec`、运行 PID32000、SEA SHA256 `87cfcebabb4957380713b7aa57440d3d79357727f1d8d33b0b06dfd2de168505` 已包含宽度诊断修复。`.cache/live/cli-e17-r2-native.json`（03:30:17 UTC）仅核验本轮 B 任务 `w1F:p1`：agent.get/read 与 pane process-info 证实原生名称、专用目录、Bypass／add-dir 启动参数及 working 状态；短内容估算 54 列正确返回 unknown。此为真实受管 pane 的专用读取，不是全部 doctor 或 debug CLI 入口重跑，也没有读取 PTY 实际 columns；原 C12/C13 缺口按入口保留。


## E19 之后的范围纠正

用户已明确 Web 只用于会话记录，业务从飞书发起。本文旧 C05 `configure` 页面、配置写入及 Web/API 业务检查保留为当时事实，不再作为当前产品入口或飞书业务通过证据；旧 Web 管理流程退出范围，不能把原 `configure` 的调度/写配置行为称为只读查看。安装维护仍通过 CLI/本地配置处理。新的只读 Web 验收见现场矩阵 WR01–WR09，当前不凭文档更新宣称实现或检查通过。
