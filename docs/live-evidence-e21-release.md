# E21：订阅、轮询与异常执行器收尾

日期：2026-09-18。范围仅为专用验收任务，不更改其他任务或原生执行器。

## 审查整改

`8306480` 将任务订阅接入飞书连接成功后的启动流程；订阅失败先清理连接再重试，成功前不启动任务调度。后台远端 GET 按 `tasks.pollIntervalMs` 节流，失败尝试和重启保留冷却；显式操作与事件可强刷，首次终态描述独立即时同步。403 项自动化、类型、Biome、行数和三平台 CI 通过。

部署 PID88083，SEA SHA256 `0b89f2fad18b7cf80ea1502eed0da3c93f1b89e3866ec3bf512892175a4b1379`，构建时间 `2026-09-18T05:56:58.649Z`。独立回读 runtime/authorization ready。没有单独的订阅成功日志，ready 与启动调用顺序仅能证明订阅调用返回，不能证明事件送达。

## 真实失败与复现

从飞书主私聊创建“验收-E21-任务订阅与手动完成”，本地 `task_e0dcd4220ebfeaff78724d3267ba7fe6`，远端 `a66acef4-0d5b-49b7-a1a5-2298f6bc7fa2`，Codex `w1N:p1`。要求仅输出 `SUBSCRIPTION_E21_OK`，不调用工具或写文件，等待验收；默认 keepGroup=false。

首次投递成为 uncertain/delivery_unconfirmed。准确原生窗口屏幕显示 Codex 更新自身后提示重新启动并返回 zsh；没有采到投递前菜单、原始按键或对应原生用户输入，因此不能判定更新是否由任务正文的 Enter 触发，也不能声称是 pi 自动信任审批。未重发未知投递，未手动启动原生进程。当天已检查的默认 transcript metadata 无对应 cwd，不等于全局不存在记录。此次正常输出链路失败保留。

飞书原生任务详情点击“完成任务”后按钮变“任务已完成”；远端 completedAt 为 `1789711975648`（06:12:55.648Z）。06:15:17 回读本地仍 attention、closeRequested=false、groupDeleted=false，未有 task poll 记录或 task inbox。群 GET 持久时间采样间隔约30024–30032ms，符合30秒配置；本任务远端完成与执行器收尾仍被异常路径阻挡，不能称订阅事件已到达。

只读证据索引 `.cache/live/e21-evidence-index.json`；原生诊断 `e21-initial-unconfirmed-diagnostic.json`，操作时间线 `e21-trust-send-audit.json`，原生完成后远端与本地快照分别保存，不用后续成功覆盖原失败。

## 异常收尾修复

远端生命周期查询提前到首发恢复与执行器观察之前，查询结果用于随后最新描述同步，不增加每周期普通 GET。执行器明确不存在时，核对原 pane/workspace 后允许读取已有原生输入；只有精确 session、cwd、receipt 匹配的用户记录才能证明送达。缺失返回未知，身份替换、RPC、真实文件读取错误继续报错。既有最终输出投递和群消息屏障保留。

启动阶段末尾具有确认提示和选中编号选项的菜单标记为 blocked，禁止向其发送任务正文，并向人工审批提供完整可见屏幕。该菜单不属于自动目录信任白名单。新增启动菜单测试使用合成 fixture，不冒充缺失的 E21 投递前真实屏幕。

集成 421 项测试、严格类型、格式化、lint、1000 行限制通过，两个修复路径交叉评审通过。新版本部署、原任务收尾恢复、正常任务事件与发布结果另行追加；完整验收目标仍 active，未测边界沿用逐项矩阵。

## 真实事件闭环复验（R2）

本节追加的是订阅发布后的独立现场证据，保留上面的 E21 首次失败记录。运行实例为提交 `71ffd7a`、PID `8171`、SEA SHA256 `6ee3f05d65c413fd24f52be453cd2a8f624b0d7e64bc6fdb5b889a5e8c1a952`，本地时间 2026-09-18 16:11:58 启动；runtime 与 authorization 均为 `ready`。飞书应用版本 `1.0.3` 已发布并包含 `task.task.update_user_access_v2` 订阅。

R2 任务为“验收-E21-R2-任务事件与正常输出”：本地任务 `task_c187bda719bbd61e74d27b1a861e79f5`，远端 GUID `f9c4f240-0692-41bd-921c-7c3d92fb60b5`，群 `oc_f39bf17b46551403fec0440cc11d6245`，Codex pane `w1P:p1`。用户在飞书原生任务详情点击“完成任务”，页面随后显示“任务已完成”；飞书“已完成”列表可见该任务。

事件与收尾时间线（UTC；北京时间为 UTC+08:00）：

- 08:21:23.727：远端 `completedAt` 写入；
- 08:21:24.313：收到 `task.task.update_user_access_v2` 后写入 task inbox；
- 08:21:24.749：开始处理 task inbox；
- 08:21:25.054：事件触发的强制 `remote_poll task`，绕过约 30 秒普通轮询冷却；
- 08:21:25.710：远端完成状态读回并写入 `remoteCheckedAt`；
- 08:21:35.826：通过 herdr 关闭 Codex pane/session，参与者状态为 `gone`；
- 08:21:47.690：删除任务群完成，飞书群 `chat_status=dissolved`、`user_count=0`；
- 08:21:47.692：最终任务描述同步完成；
- 08:21:48.680：首个 task inbox 记录完成；随后重复事件在 08:21:48.722 入队并于 08:21:48.771 幂等完成。

最终本地任务状态为 `destroyed`、`closeRequested=true`、`groupDeleted=true`、参与者 `gone`，结果保留 `SUBSCRIPTION_E21_R2_OK`；对应 6 条群通知/输出及收尾通知全部 `delivered`。herdr `agent list` 为空，`api snapshot` 不再包含 `w1P`，证明 Codex/Claude 执行现场已关闭。只读证据来自 `build/serve-live.log`、`/Users/yueban/.herdr-agent/state.sqlite`、herdr API snapshot 和飞书群 GET；汇总快照见 `.cache/live/e21-r2-event-closure-2026-09-18.json`。

判定：**R-P（任务事件订阅、事件驱动强制刷新、默认收尾和资源清理均通过）**。本证据只关闭 R2 这条场景；旧 E21 首次未确认投递、其他任务类型、其他确认菜单、异常恢复和完整权限组合仍按逐项矩阵单独计账。
