# E35：真实销毁与收尾通知复验

日期：2026-09-19；时间均为 UTC。任务通过真实飞书主私聊创建，完成后续部署后再从相同入口发起销毁。销毁不代替业务验收，远端任务应保持未完成。

## 测试资源与准备证据

- 标题：`MYRIX-E35-DESTROY-20260919`。
- 本地任务：`task_889c9ac6ebb58997d15106fb1969add4`。
- 飞书任务：`d9791dbc-7d1e-4548-9148-1419d2c8ca13`。
- 群：`oc_fdcd923c7adad168b5703ae9d3905367`。
- Codex：`w10:p1`，原生 session `01a0b95b-2b9c-7fe2-badb-3420904aba76`。
- 创建入站消息：`om_x100b65d29dd464a8b12797ac1ac14c7`。

创建要求为无项目讨论、仅一名 Codex、等待后续指令，不调用工具、不编码、不写文件、不运行测试，不自行确认完成。创建和初始投递使用 E34 的 `0b3c457` 开发二进制。

本地记录确认：远端创建 `11:08:48.566Z`、建群 `11:08:49.714Z`；目录信任旧现场 `235` 被拒为 `stale_guard/not_executed`，新现场 `236` 自动确认；初始投递于 `11:09:32.547Z` 为 `delivered/acked/verified/attempts=1`。普通审批未被本轮执行者代点。

`11:15:49.877Z` 使用生产应用只读 REST 回读，飞书任务 `completedAt=0`、群 `normal`。同期本地任务 `review`、参与者 `done`，herdr 仍列出 `w10:p1`；这些不代表业务验收或执行资源已关闭。讨论目录存在且无文件；本地历史已留存。准备证据：`.cache/live/e35-remote-before.json`、`.cache/live/e35-state-before.json`。

## 本轮修复与验证边界

E34 收尾通知被拒时未持久化正文，无法认定具体原因。本轮独立复现了正常的“已完成任务并进入收尾阶段”“随后将解散已创建的任务群”等语句被误拒，以及“群即将解散且 Codex 已关闭”“收尾完成”漏检。修复限定动作阶段及独立断言，保留真实群/执行器/收尾事实校验，不替模型生成回复。相邻回归保证测试、发言和讨论轮次完成不等同资源收尾。

拒绝记录保存在本地 `notice_rejections`，包括候选正文、尝试序号、失败类别和精简事实快照；不复制配置或完整要求，不进入可见消息和日志。生成失败仍遵守已授权清理、未知投递及最后输出的既有屏障。

以上为准备时点记录；后续部署、真实销毁和通知投递结果见下节，不用准备证据替代真实销毁。

## 11:21–11:25 UTC：部署与真实销毁通过

- 部署提交：`259b37778d08bd184f6db50b35760ef4c7f09819`；版本 `0.3.13-dev`；构建时间 `2026-09-19T11:21:06.517Z`。
- macOS arm64 SEA SHA256：`34156b8d6e625a2c9d2bd3acf69efb3f8012226a631a1fd17b2dccc9391a5d18`；运行 PID `10934`。
- 完整检查含 566 项测试、格式/lint/类型/行数检查通过；独立 SEA 烟测和三平台 CI 通过。发布版本与本次开发二进制分别记账。

真实主私聊消息 `om_x100b65d3478060a4b1cbce604d74f6e` 于 `11:23:01.480Z` 入站，明确要求只销毁 E35、使用 destroy 而非 complete、不替用户验收、远端任务保持未完成、保留目录与本地历史。

checkpoint `e05c44074753de060220967c02e4897c936235d2c1654ad199ced40e17103297` 的实际工具顺序为 `tasks_list` → `task_action(action=destroy, taskId=task_889c9ac6ebb58997d15106fb1969add4)` → `task_get`。inbox 为 `done`，turn receipt 为 `finished`；主私聊回复 outbox 为 `delivered`，时间 `11:23:39.244Z`，消息 `om_x100b65d345744ca0b2612dee90425a2`。回复按查询快照说明销毁进行中、尚未确认执行器和群清理，没有提前声称全部完成。

| 阶段 | UTC 时间 | 实际事实 |
| --- | --- | --- |
| `before_close` 通知 | `11:23:38.504Z` | `notice:89bf0e3bbad90f1b7d94053b363e69f3` delivered，消息 `om_x100b65d3456078a8b3c959065ae3560`；正文“已进入销毁收尾阶段……将按默认策略清理” |
| herdr close | `11:23:39.245Z` | `:p1:close` done，participant gone |
| `before_group_delete` 通知 | `11:23:42.985Z` | `notice:28e10ed415ee569aee20284a4ba4d4ed` delivered，消息 `om_x100b65d3453894a8b24f0a343957f8f`；正文“即将……解散任务群”，已保存内容保留 |
| 删除群 | `11:23:44.306Z` | `:delete-group` done |
| 最终任务 | `11:23:45.317Z` | destroyed、groupDeleted=true |

两个通知阶段均为 `processed`，本任务无 `notice_rejections`，没有把未知投递或不可用生成记成成功。真实飞书桌面 CUA 截图看到两条通知和“你已不在该群组”的提示。两个通知按实际先后阶段发送，不能把它们扩展为所有模型措辞或 complete 路径均通过。群解散后补充尝试读取两条消息的单条 REST GET，均返回 `feishu_http_400`，原因未确定（`.cache/live/e35-notice-readback.json`）；这次 REST 消息正文读取不算通过，通知可见性依据实际 CUA 观察及 outbox 回执，任务/群的 REST 状态另有成功回读。

`.cache/live/e35-remote-after.json` 在 `11:25:00.999Z` 通过生产应用真实 REST 回读：飞书任务 `completedAt=0`、群 `dissolved`；最终描述为 destroyed/gone，已移除群链接。没有 completion 操作；本地 `closeRequested=false` 是直接 destroy 路径的状态，不能误判未清理。真实 herdr 列表 `agents=[]`，目标 `w10:p1` 已关闭。

`.cache/live/e35-state-after.json` 对比销毁前记录：四条旧历史内容不变、讨论目录仍存在、前后文件数均为零。该样本证明目录和已有历史未被删，不证明非空代码文件保护的所有组合。审批记录数量为零，不能据此声称验证了旧审批失效。

E35 的限定 **destroy 子场景为 R-P**：真实入口→正确工具与阶段答复→两条通知生成/送达→herdr 关闭→群解散→远端保持未完成→历史与空目录保留。整体矩阵仍为 **R-部分**；E34 被拒正文丢失及失败历史保留，修复后的 complete 全路径通知、其他审批/故障/资源组合继续分验。
