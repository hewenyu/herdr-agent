# E39：Web 复验、需求原文、会话归档与审批菜单

日期：2026-09-19，时间均为 UTC。**本轮修复已部署，测试资源已清理；真实按钮点击、修复后新创建答复及剩余会话组合仍待验。已通过步骤、原失败和离线修复分别记录，完整目标保持 active。** 正式 npm 版本仍为 `0.3.13`，本轮运行基线是 E38 的 `0.3.14-dev`，不能把未发布改动当成正式版能力。

## 运行基线和证据边界

现场二进制为 `build/e38/herdr-agent`，提交 `261771d6eea4810a58acb8f44e45d606bf0756fc`、构建时间 `12:47:29.100Z`、SHA256 `1b6f1ebdef91bd7f0819a7f94e7a329a4055ee641ac9db3d79399c64beed307f`；bridge PID `42319`，herdr PID `39037`。配置页监听 `127.0.0.1:18790`。部署凭据见 `.cache/live/e38-r2-deployment.json`，运行日志为 `~/.herdr-agent/e38-r2-runtime.log`。

本轮先恢复了真实桌面：Chrome 中操作项目配置，飞书客户端中发送用户消息。后台证据来自生产 SQLite **只读**快照、herdr 只读观察、原生 transcript 和专用产物。隔离模型探针没有外部写入，不能替代真实入口或卡片点击。

专用根目录由 `.cache/live/e39-baseline.json` 记录，下文简称 `ROOT`。基线保存了原有 12 个项目、默认项目 `herdr-agent` 和 Bypass=true；只登记了 `MYRIX-E39-WEB-A`，预备 B/C 目录尚未构成多项目验收。测试资源须最终清理，原目录和输出保留。

## Web 配置：E38 错误反馈独立复验通过

真实 Chrome 添加项目时提交 `[ROOT/a/main, ROOT/a/not-created]`，服务拒绝，错误在弹窗内可见，名称、Claude 和输入目录保留。此时未登记项目，主目录和附加目录均未初始化 Git。修正为 `ROOT/a/extra` 后保存关闭弹窗，主目录 `.git` 存在、附加目录 `.git` 不存在；重开弹窗没有旧错误。随后将其设为默认项目，Bypass 保持 true。

证据：`.cache/live/e39-web-invalid-add.json`、`e39-web-saved.json`、`e39-web-saved-git.json`。这是当前二进制上的独立成功复验，E38 原 UI R-F 保留。

A1 创建后，再通过真实编辑弹窗提交非法附加目录，错误仍在弹窗内显示且保留输入。修正附加目录为 `ROOT/a/extra-new`，默认参与者改为 Codex 后保存。`e39-after-web-edit.json` 及后续任务证据确认：旧 A1 保持原目录和 Claude，新 A2 使用修改后目录及 Codex。

## Claude A1 与 Codex A2：原文与产物限定通过

| 项目 | A1 | A2 |
| --- | --- | --- |
| 本地任务 | `task_6f6b0cdc3bed91bfce7fc550cba59c7f` | `task_69ff137a5f2ca656950eadd7462194f9` |
| 原始 pi 会话 | `MYRIX-E39-S1` | `MYRIX-E39-S2` |
| 飞书任务 | `eef99b2c-8c5a-404a-9005-085f8b8eed31` | `2eb5d0f6-e42e-4db1-8f51-7cfcf8716895` |
| 飞书群 | `oc_f55461133595fc4e70499d73ce0bbfca` | `oc_04ca0c639314409cd040eb84050ed038` |
| 参与者 / 目录 | Claude；main + extra | Codex；main + extra-new |
| 输出 | 主目录 `brief.md` | 主目录 `brief-new.md` |

A1 真实创建消息 `om_x100b65dcdf55b4a0b2ae1b2557345be` 要求读取两份 `input.txt`，按目录顺序将两行原文写入主目录 `brief.md`，回读后询问红/蓝并等待用户。原始用户请求及身份快照准确传入 Claude；原文没有被 pi 的整理摘要取代。目录信任首次陈旧现场被拒，随后对新现场自动确认，`13:09:00.348Z` 初始投递 verified。Claude 的第一次 `cat -A` 因 macOS 不支持而失败，后续改用 `cat`，最终 `diff` 为 MATCH；两行内容准确，原输入未改，附加目录未生成 `brief.md`。任务停在 review，真实群 UI 可见输出和问题。

A2 真实创建消息 `om_x100b65dce9528ca0b4a53b6a7b84b9e` 使用已编辑默认配置，要求只新建 `brief-new.md` 并用 Python 断言两份输入的字节拼接。`13:17:30.811Z` 快照确认输出为 39 字节，原生 Python exit 0，独立读取一致；旧 `brief.md` 和全部输入 hash 未变，任务停在 review。A1 此时等待普通审批，未阻止 A2 创建和执行。

证据：`e39-a1-native.json`、`e39-a1-a2-native.json` 及对应原生 transcript。只证明同一项目编辑前后配置冻结、真实原文传递及两个执行器独立推进；不代替三个不同项目同时运行/阻塞的完整组合，也不代替完成清理验收。

## 新发现的真实失败及修复边界

1. **A1 创建主答复 R-F。** 任务资源和执行成功，但创建 inbox 为 failed/model_failed。首次漏参 `task_get({})` 明确未执行，后续三次正确查询成功；运行时仍把漏参失败计为未解决，拒绝了准确说明投递尚未确认的答复。后台群就绪通知不能代替主答复。修复限定为同工具只读 input 查询补齐参数并成功后解除对应失败，原失败计数保留，既有 selector 和绑定任务不得改变，写入及 unknown 不受此规则影响。
2. **A2 创建答复事实 R-F。** 当轮查询仍是 started=false / initialSent=false，主答复却写“约束已完整转交”。投递护栏漏掉“约束”上下文；后来执行成功不能证明更早的表述正确。修复增加该投递语义，仍允许待确认、否定和疑问表述。
3. **普通审批选项 R-F。** A1 群内明确要求 Claude 使用原生 AskUserQuestion 提供红/蓝，原文准确送达同一执行器，未自动作答。解析器却读入屏幕上方历史提示的 `4. 不要完成任务…`，挤掉真实 `4. Chat about this`，旧卡 keys 为 `[4,1,2,3,esc]`。未点击错误按钮，也未选择其他答案。修复限定当前原生菜单区域，后续须验证正确卡片与真实用户选择。
4. **通知含误导。** 开发 welcome 使用“手动讨论模式/请安排开始”，后续通知又把内部 discussion.paused 当成业务已停止。提示已按 task.kind、自动首位启动、实际参与者及送达事实修正；任务链接不能标成群入口。通知继续由模型生成。

原现场审计：`e39-a1-create-reply-audit.json`、`e39-a2-create-reply-audit.json`、`e39-a1-approval-screen.json`。`e39-create-reply-fixed-replay.json` 是保存的 A1 checkpoint/工具结果在内存中重放，准确候选可通过，A2 原虚报被拒；没有重新投递生产消息。

`e39-single-notice-after.json` 保留第一轮隔离真实模型仍出现的链接错标等失败；提示修正后 `e39-single-notice-after-r2.json` 的七个样本符合核对边界。此探针使用真实模型配置及重建的只读快照，未写生产，不算部署后通知全链路通过。

独立代码复核另以脚本复现：会话 A 的重命名失败后，会话 B 的成功会覆盖失败键，使对 A 的虚报通过。这不是本轮真实会话中观察到的故障；已为会话、项目、任务创建和参与者创建补齐目标标识，保留同目标参数纠正。新增回归验证不同目标不能相互抵消失败。

审批卡修复同时存储选项指纹：仅未消费且发送结果已知的旧卡可以因菜单变化安全更换；事务内停用旧 nonce，之后禁用远端旧卡并发布新卡。已消费或发送结果未知不因到期复活；解析版本升级让同一 blocked 现场重查一次，不发送原生控制键。旧记录缺少标签时只依据实际 keys/顺序差异迁移，不虚构旧标签。

集成后 `npm run check` 通过 **702/702**，包含 TypeScript、Biome 格式/lint 及每个手写文件不超过 1000 行检查；日志 `.cache/e39-check.log`。独立复核没有发现本次审批刷新阻断问题。中英文 README 同步安装、Web/飞书边界和实际验收状态，32 个本地链接及 24 个 CLI 示例已核对；Web Base URL 提示同步为启用 pi 时须显式填写。

## pi 会话：创建、改名、切换和非当前归档

真实私聊创建并选中 S1 `s_90f47592-bc08-43af-8598-e5e788b3c723`，A1 下一条入站绑定 S1；随后创建并选中 S2 `s_0da1de4b-b5d8-495a-a834-1e1155d7334d`，A2 入站绑定 S2。

消息 `om_x100b65dce3a104a8b3ed7ebfe41d700` 将 S2 改名为 `MYRIX-E39-S2-R` 并切回 S1，客户端可见成功回复。消息 `om_x100b65dcf18638a4b228af18164639c` 于 `13:19:49.242Z` 请求归档非当前 S2-R，保持 S1 选中且不操作任务；`13:20:11.956Z` S2-R archived=true，回复 `om_x100b65dc8f8600acb4c494aa337646c` delivered，任务群和执行器绑定未改变。后一个结果由 `e39-resumed.json` 只读回读，尚未再次观察客户端正文。

恢复原 ID、不自动选中、恢复后显式切换、当前 session 延迟归档和下一条入站隔离等组合仍待真实验证；不能用上述非当前归档成功关闭 T19/T20 全行。

## 当前未完成项

`13:24Z` 左右工具两次获取飞书窗口及一次获取 Chrome 窗口均返回 `cgWindowNotFound`。这是桌面恢复并完成上述操作之后的新中断；不能沿用 E38 的中断状态否认本轮已发生的真实 UI 操作。已请求恢复可见桌面，继续可独立完成的修复与文档。

截至 `e39-resumed.json`：A1 blocked、审批未作答；A2 review；两个群仍存续，默认项目仍是专用 A。正确审批卡点击、后续改稿和用户完成、会话恢复/当前归档、修复后新建任务答复、三项目组合及资源清理仍未验收。最终必须恢复默认 `herdr-agent`、删除专用项目登记并通过 herdr 关闭测试执行器和测试群，保留目录、产物与历史。


## 修复部署、审批刷新和资源收尾

功能提交 `a3978c097aba137e857a2af5d39eb538d53dbde2` 的完整检查 **702/702**、独立 macOS SEA 烟测通过；[CI 35446043195](https://github.com/hewenyu/herdr-agent/actions/runs/35446043195) 的 darwin arm64、Linux x64、Linux arm64 三个平台检查与 SEA 构建全部成功。此 CI 只证明该提交，不代替用户入口验收。

新二进制 `build/e39/herdr-agent` / `dist/herdr-agent` 已部署，版本 `0.3.14-dev`，构建时间 `13:31:37.795Z`，SHA256 `cb9a000ab4bd6e19aef35702353a06878d1ea1543f553a2f7c3df5fdbbbc242d`，bridge PID `53372`，日志 `~/.herdr-agent/e39-runtime.log`。重启前无 queued/processing inbox；只重启 bridge，herdr PID `39037` 和两执行器原现场保留。`e39-deployment.json` 保存 stamp，HTTP runtime/authorization 回读 ready。

生产调度器在原 `stateSeq=274` 上自动重新观察审批，没有发送控制键。旧 nonce `approval_6c26c683a6254a5f8a75728c101242b6` 变为 consumed，原因是菜单已更新；新 nonce `approval_1af3aed0b4e3463ca7d7a10229906ac4` 未消费，keys 为 `[1,2,3,4,esc]`，消息 `om_x100b65dca17650a8b3fe0037bddccfa` publication=sent。原生屏幕仍 blocked，解析结果是红色、蓝色、Type something、Chat about this。

独立真实 Feishu GET 确认旧卡 updated、新卡存在，但 API 正文只返回“请升级至最新版本客户端，以查看内容”的交互卡占位，不能检查真实按钮文字。首个探针错误地要求 GET 含按钮文字，断言失败保留在 `e39-approval-refresh-readback.json`；纠正证据边界后的 `e39-approval-refresh-scoped.json` 只判定后台刷新、远端存在和原生未作答，**客户端按钮显示与点击仍未通过**。没有通过删除断言把同一 UI 场景改称成功。

桌面持续 `cgWindowNotFound`，因此按专用测试资源清理授权，外部删除 A1/A2 群；不模拟用户完成或审批。`e39-external-group-cleanup.json` 记录两个远端群 `dissolved`、任务 `completedAt=0`。生产调度器随后通过 herdr 关闭两执行器：A2 `13:35:31.881Z`、A1 `13:35:34.094Z` 的 close 操作 done；`e39-after-group-delete.json` 确认两个任务 destroyed、groupDeleted=true，两参与者 gone。

`e39-config-cleanup.json` 通过受保护的 loopback 配置 API 恢复默认 `herdr-agent`、只删除 `MYRIX-E39-WEB-A` 登记，最终 catalog 与原 12 项基线完全一致、Bypass=true。herdr agent 列表为空，原输入、两个产物和历史保留；这不是浏览器删除操作验收。

本轮不合并/发布：修复后新创建主答复、生产通知语义、真实普通审批选择与续聊、session restore/当前归档以及三项目完整组合仍待独立复验。PR #48 保持草稿；历史 R-F 不因离线回放、最终执行或测试清理而改写。
