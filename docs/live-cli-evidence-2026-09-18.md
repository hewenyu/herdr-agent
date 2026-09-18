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
| C10 doctor | R-部分 | 真实宿主 `doctor --json` 输出检查列表并退出 1；11 项 pass，`pane-width` fail，退出码与失败状态一致。诊断命令行为通过，不能声称宿主全部健康 | 文本模式、每种 unknown／不可读条件、全部脱敏边界；pane-width 现场整改后复验 |
| C11 debug ls | R-P | 真实 herdr `debug ls` 退出 0，返回当时 1 个 agent；只查询已有执行器 | herdr 不可用／身份未知分支未在本组验证 |
| C12 debug screen | R-部分 | 读取已授权验证用 Codex pane 退出 0，返回身份匹配、464 字符现场；缺失 pane 退出 1；未保存正文 | 非 coding agent、身份替换、Guard 使用完整菜单的功能须看其他专门证据 |
| C13 debug transcript | R-P | 同一真实 Codex pane 退出 0，返回 0 entries 且 cursor 存在，符合初读默认取尾部基线的语义 | 此结果不证明返回全部历史，也不证明之后的增量事件或 Claude transcript 路径 |
| C14 migrate dry-run | R-P（隔离数据） | `migrate --state-dir=<isolated> --dry-run --json` 退出 0，返回 planned；此前不存在的 DB 和 backups 未创建，源文件 hash 未变；已有 DB 的 dry-run 前后记录相同 | 生产旧状态、所有损坏输入／缺失身份分支未在本组执行 |
| C15 migrate | R-部分（隔离数据） | 实际导入 task/participant/session/receipt/message/memory；备份源 hash 一致。再次执行返回 already_migrated，DB 相同且仅一个备份；源变化时退出 1 且 DB 不变。导入未知写入保持 uncertain，configure 重启未改写任务或重放操作 | 生产迁移、真实 herdr 旧 final 基线与所有历史数据变体 |
| C16 全局参数 | R-部分 | 独立 `--state-dir`、`--state-dir=...`、version/doctor/migrate 的 JSON 有实际运行；不适用 flag、单横线旧 flag、缺值、布尔 flag 附值、多余位置参数退出 2 | 路径展开、所有命令错误的 JSON 契约与全部组合未在本组验证 |

## 恢复和失败证据

状态锁验证用了两个真实 configure 进程：第二进程因同 state 锁拒绝；第一进程 SIGKILL 后，以同目录重启恢复 session 并清除失效 PID。另以损坏 SQLite 文件启动 configure，退出 1，文件字节 hash 不变且锁释放。它们分别支持 B02／B18 的具体恢复分支，不代表完整灾难恢复验收。

C05 第一次失败来自测试提交空 model，被 HTTP 400 正确拒绝；没有据此判定产品故障。第二次提交非空 model 但使用无效 provider `openai`，HTTP 保存曾成功，随后 configure 重启失败。代码核对发现保存路径遗漏 provider 枚举验证，与启动读取只接受 `openai-responses`／`anthropic-messages` 不一致。这是真实暴露的输入验证缺陷；工作区已加入修复和 `tests/app/model-config.test.ts`，本报告中的旧 SHA 不包含该后续修复，不能把合法 provider 补验当成修复的真实二进制验收。

doctor 的 PASS 指检查程序正确报告了现场失败。原始检查结果是 config、herdr、codex、claude、authorization、owner、pi、claude-hook、codex-hook、server-environment、detection-manifest 通过，pane-width 失败。没有将失败项改写为通过。

## 对主矩阵的更新建议

CLI 章节原来的“本轮执行与真实状态均 U”已经过期，应引用本表逐项状态。C06、C07 继续 U；C08、C09 仅参数拒绝分支有证据，不能写成 setup 流程通过。C01、C02、C11、C13、C14 可在上述限定范围标 R-P，其余行标 R-部分并保留未覆盖项。当前发布候选重新构建后，应至少重新执行受代码变更影响的配置保存／启动、状态恢复和迁移检查，再注明新的 SHA。
