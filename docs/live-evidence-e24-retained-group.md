# E24：保留群后续清理与 pi 通知回归

日期：2026-09-19（Asia/Shanghai）。本轮使用本机真实飞书配置、pi 模型和 herdr，在独立状态目录中创建专用资源。业务动作由组件验收脚本调用 `Application/TaskService`，未伪造飞书入站事件，也未建立第二条飞书长连接；因此本记录不能关闭 LIVE-001 或替代 B/N 的飞书用户入口验收。

## 复现与修复范围

- 任务完成并明确保留群后，执行器已关闭、状态为 `destroyed`。再次显式解散该群被无条件 `task_destroyed` 拒绝。修复允许 `destroy + keepGroup:false`；已确认完成的任务也允许 `close + keepGroup:false`，复用关闭回执与消息投递屏障，不重启执行器、不改写验收事实。
- 已关闭执行器的保留群仍需回读外部解散状态。普通轮询应遵守远端查询间隔，真实群事件可即时核对；未知读取不能被解释为已解散。
- 真实 Kimi `kimi-k2.5` 的三次生命周期通知分别执行 12 次 `task_get`，随后失败，耗时 78,351、82,330、79,625 ms。恢复轮一直使用强制工具选择，使模型无法正常生成最终答复；此外生命周期通知只有只读工具，却被套用用户写操作的证据要求。修复将强制选择限定到恢复轮首次工具调用；通知依据程序提供的当前状态快照，继续仅暴露只读工具，普通用户请求保留原事实校验。

## 现场资源与证据

第一轮使用 Web 所选历史测试身份，已创建远端任务 `c7e91b4f-cf2f-4022-9ba2-425ba7c729f0`，建群被 HTTP 400 拒绝，未启动原生执行器。随后已通过任务完成/关闭流程收尾，远端 `completedAt=1789753569000`，本地 `destroyed`。不把该准备失败改记为通过。

第二轮改用历史真实飞书链路验证过的允许用户。专用任务 `task_837c5b4d960fdb3954e74c019ca4996f`，远端任务 `0ff0db20-b6e6-446c-94a6-e56ce3ffe67f`，群 `oc_279ea92810ca1df9afb9cc5582e8b85f`，herdr pane `w1S:p1`。初始要求只输出 `RETAINED_GROUP_0919_OK`，不调用工具、不读写项目文件。

本地原始记录：

- `.cache/retained-group-live.ts`：可分阶段运行的验收脚本，每阶段重新打开隔离数据库。
- `.cache/live/retained-group-0919-owner-verified.json`：资源归属和真实外部调用日志。
- `.cache/live/retained-group-0919-owner-verified-*.json`：任务、执行器、远端任务、群、operations、outbox 回读。
- `.cache/live/retained-group-notification-baseline.json`：修复前通知循环的实际日志摘要。
- `.cache/live/retained-group-0919-owner-verified.log.ndjson`：后续阶段真实模型及工具日志。

## 真实组件复验结果

第一条正常样本经过独立进程重新打开状态：实际 Codex 输出 `RETAINED_GROUP_0919_OK`，随后 `complete + keepGroup:true`，远端任务完成时间为 `1789754428000`、pane `w1S:p1` 经 herdr 关闭、群仍 `normal`。再由新进程调用 `destroy + keepGroup:false`，群回读为 `dissolved`，任务仍 `destroyed`，完成时间不变。建任务、建群、启动、首次输入、herdr 关闭、任务完成写入、群 DELETE 均各一次；4 条 outbox 均已送达，最终远端描述不再包含群链接。群解散后的消息列表/单条 GET 返回 HTTP 400，因此该样本只有发送回执，未据此声称完成可见消息独立回读。

第二条外部解散样本：任务 `task_006443066c003e9dc6ebabee4da5ee6e`，远端任务 `2fab7333-294d-420a-9b63-c0d64001f935`，群 `oc_d622284a621b84d82c8eba90f96f83cc`，pane `w1T:p1`。Codex 结果生成后，在群解散前实际 GET 读取到 5 条消息，包含署名及 `RETAINED_GROUP_0919_OK`。完成并保留群后，pane 已缺失、群仍正常；再在服务之外通过飞书 API 解散专用群，执行普通 `tasks.tick()`，实际更新 `groupDeleted=true`、状态保持 `destroyed`、远端描述移除群链接。完成时间 `1789754727000` 未改变，herdr 启动/关闭各一次，没有由调度器再次 DELETE。该样本补足外部群状态与周期调度路径，不代表真实用户群事件已验收。

修复后的真实模型通知耗时约 5–15 秒，均正常结束、没有反复强制查询，也没有虚构写工具回执。第一样本仍有通知直接显示 `review` 字段，B10 简洁措辞的完整要求尚未闭合。独立回读确认用户原有 `w1:p1`、`w2:p1`、`w2:p2` 均保留。两条新建测试群均已解散，对应 Codex pane 均已关闭；准备失败的远端测试任务也已完成清理。

补充证据：`.cache/live/retained-group-0919-external*.json`、`.cache/live/retained-group-0919-external.log.ndjson`、`.cache/live/retained-group-0919-independent.json`。专用状态库没有导入生产数据；脚本通过受管记录限制 herdr 控制目标和飞书消息目标。

## 本轮自动化与文档核对

定向运行 engine、notification-evidence 与 retained-group-cleanup 共 27 项通过。首次完整 `npm run check` 为 452/453，通过行数、typecheck 与 Biome，但原有 terminal-description 的未知完成回读测试发现：终态描述已核对后又恢复了过期的“完成未确认”错误。该失败属于本轮新增清错逻辑的回归，不能作为已有基线失败忽略；修正为已关闭任务仅读取仍有效的群查询错误，不再复用废弃的任务完成查询错误；原断言保留。修正后 `npm run check` 453/453 通过，1000 行限制、TypeScript、Biome 格式/lint 均通过。

中英文 README 同步更新产品名 myrix、npm 主包与平台依赖、指定版本安装、独立包命令名、pi/herdr 分工、Web 配置范围、主私聊 `/clear`、群与执行器清理。移除 README 中过期的本机进程与旧入口标记；现场细节继续由本文件和矩阵记录。全部 README 本地链接及 Markdown 代码围栏检查通过，npm registry 当前 `latest=0.3.11` 已只读核对。

## 二进制与运行回读

2026-09-19 E24 部署：功能提交 `15f29b31383adfd0cda416bb59eaaa71fafd6939` 构建的 macOS arm64 SEA `0.3.12-dev` 已通过独立烟测并重启为 PID `37384`，构建时间 `2026-09-18T18:20:23.267Z`，SHA256 `3620789d387f5b5bea4f6f496732f72c88f63f8b41080fc9388c7e79d7649122`。运行路径 `build/e24/herdr-agent`，`dist/herdr-agent` 已同步同一产物；`version --json`、`doctor --json`、HTTP runtime/authorization ready 均回读。生产 SQLite 中 23 任务 destroyed、23 群 groupDeleted=true、25 参与者 gone/2 removed、177 outbox delivered；这些是本地状态读回，不冒充本轮逐群远端验证。herdr agent 列表为空，原有 `w1:p1`、`w2:p1`、`w2:p2` 保持。PR [#39](https://github.com/hewenyu/herdr-agent/pull/39) 已创建；真实用户入口标记仍未观察到，相关场景继续待验。

原始运行证据：`.cache/live/e24-deployment.json`、`.cache/live/e24-production-readback.json`、`.cache/e24-doctor.json` 与 `.cache/e24-smoke.log`。该源码提交之后的部署记录文档不改变运行代码。

## 尚未关闭的验收

LIVE-001-R4/R5 需要真实飞书用户私聊入站，再核对模型自主工具调用和项目/任务/群/产物。当前 lark-cli 用户 token 缺失，原生飞书窗口也未能读取；已向主私聊发送 R5 请求，监听窗口在 10 分钟内收到 0 条用户事件，机器人私聊历史也只有该提示，尚未观察到入站记录。B01–B18/N01–N07 的其他未测组合继续保留，不以本次修复或服务组件测试代替全量验收。
