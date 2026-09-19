# E37：创建答复与初始投递阶段的真实复验

日期：2026-09-19；时间均为 UTC。本记录覆盖 E36 创建答复误拒的限定复验，最终输出、用户确认与清理证据见末节。**创建回合子项 R-P，整体仍 R-部分。** E36 原失败保留，不能据此声称全部通知质量和业务组合通过。

## 部署与资源

`.cache/live/e37-deployment.json` 记录：`0.3.13-dev`，提交 `772163dc8be0095a4bcacdaa0764731059f5e049`，构建时间 `2026-09-19T11:44:55.001Z`，运行 `build/e37/herdr-agent`、PID `22233`，SHA256 `4902e422a18ffd0b3e7ee2ab8173b6b0f4577576143cf6f78ad845d7f5a08110`。完整检查含 609 项测试、格式/lint/类型/行数、SEA 烟测和三平台 CI 已通过。

- 本地任务：`task_508cbf5b5fcde67e9a5bb1564ce1eaff`，标题 `MYRIX-E37-CREATE-20260919`。
- 飞书任务：`a90492ea-47b7-4cf8-90d0-2753a1156301`；群：`oc_90a0af04d09a34a8642f2f6414db6b62`。
- Codex：`w22:p1`，原生 session `01a0b97f-0856-7430-987e-44b9b4341e3b`。
- 创建快照：`.cache/live/e37-state-created.json`。

## 真实入口、工具与用户答复

真实主私聊消息 `om_x100b65d32b3cfca0b1f4ee298efd375` 于 `11:47:43.638Z` 入站：用户明确要求让带引号的“Codex”参与新的无项目单人讨论，仅回复 `MYRIX_E37_OK`，禁止工具/编码/写文件/测试，建飞书任务和测试群，沿用 Bypass，仅自动处理新目录信任，其他确认由群用户选择，输出后等待用户确认。

checkpoint `8e4f6e32a56cd3bbab923a89cf1841af9c2c8748cfa05ddccd87c9e002055faa` 的工具顺序为 `tasks_list` → `task_create` → `task_get`，只有一次创建调用。远端任务、群操作分别在 `11:47:59.123Z` / `11:48:00.016Z` done。

主私聊 inbox 最终 done，回复 outbox `reply_8e4f6e32a56cd3bbab923a89cf1841af9c2c8748cfa05ddccd87c9e002055faa` 在 `11:48:13.103Z` 为 delivered，消息 `om_x100b65d3291a50a4b22e1623d357614`。答复同时保留了以下阶段事实：

- 飞书任务和专属群已建立，任务为 starting。
- Codex 已登记但尚未启动，`started=false/initialSent=false`，初始投递尚未确认。
- 约束随任务登记，不能把登记当成已转交；不会自动验收或完成。

该答复没有重现 E36 的误拒，也没有为获取成功答复重建任务。用户可见回复仍较长并含诊断字段，此结果不关闭 B10 全部简洁措辞要求。

## 目录信任和初始输入

`:p1:directory-trust:246` 在 `11:48:17.365Z` 返回 stale_guard/not_executed；新现场 `:247` 在 `11:48:28.790Z` done/confirmed=true。`:p1:initial` 在 `11:48:48.694Z` done，delivered/acked=true/verified=true/attempts=1，receipt 为 `HERDR_RECEIPT_972768c4c9fe42308cf2d4993ec1237e`。

创建快照此时记录 task running、participant working。本轮执行者随后通过真实飞书 CUA 看到 `MYRIX_E37_OK`，并在群中发出完成确认；该创建快照尚不含最终收尾；后续独立快照与回读结果见末节。

## 保留的通知边界

`notice:9648093e4221b42611aad44d13a4f875` 在 `11:48:11.567Z` delivered，消息 `om_x100b65d3297364a8b3c243a974e04f5`。对单参与者任务仍写“轮到他人才会继续”，与实际仅一名 Codex 不一致；该措辞问题继续记录在 B10 的通知边界，不因创建主回合通过而消失，也不在本次限定修复中扩展实现。

## 11:49–11:51 UTC：输出、群确认与清理最终回读

最终证据为 `.cache/live/e37-state-final.json`、`.cache/live/e37-remote-after.json`、`.cache/live/e37-native-evidence.json`。原生 transcript `~/.codex/sessions/2026/09/19/rollout-2026-09-19T19-48-25-01a0b97f-0856-7430-987e-44b9b4341e3b.jsonl` 记录零工具调用、assistant 仅回复 `MYRIX_E37_OK`，与真实群可见 marker 一致。

用户群消息 `om_x100b65d32395bca4b2251f99caea249` 于 `11:49:41.911Z` 入站，明确确认 marker 并要求完成飞书任务、herdr 关闭 Codex 及解散群。完成 checkpoint `f227968023e4d957ed87c566c793914562d58e8da5aff9c8fb130de32a8ec5f2` 顺序为 `task_action complete` → `task_get`。创建和完成两条 inbox 均 done；完成回复消息 `om_x100b65d3205d84a4b4c2870d8f5ba89` 于 `11:50:00.632Z` delivered，区分了已确认业务完成与尚未返回最终删群回执的收尾阶段。

| 阶段 | UTC 时间 | 证据 |
| --- | --- | --- |
| completion | `11:49:49.472Z` | `:completion:c_1939ee498db74acbb629b757af39e160` done |
| before_close 通知 | `11:50:00.548Z` | `notice:3d66c8612983b03c633d4aac1c974593` delivered；“已完成并进入收尾……即将……解散”；消息 `om_x100b65d32043f4a4b4b41bb69aa468f` |
| herdr close | `11:50:01.281Z` | `:p1:close` done；participant gone |
| before_group_delete 通知 | `11:50:07.376Z` | `notice:102b644368f44d32ca235a3a2c75e5c1` delivered；“已完成……即将解散”；消息 `om_x100b65d3203650a0b295796fc4cb4f9` |
| 删除群 | `11:50:08.776Z` | `:delete-group` done |
| 最终 task | `11:50:10.320Z` | destroyed、groupDeleted=true |

两个通知阶段均 processed，没有本轮通知 rejection，且通知先于对应执行器关闭/群删除。真实 CUA 截图看到两条通知、阶段回复与退出群提示。生产应用真实 REST 于 `11:51:04.164Z` 回读远端任务 `completedAt=1789818588000`、群 dissolved，最终描述 destroyed/gone 且保留 marker；不把任务/群 REST 当作消息正文 GET。herdr agent 列表为空；全库 active tasks/pending inbox 均为零，这仅描述回读时资源状态，不代替全矩阵验收。

提交 `772163d` 对 E36 创建误拒的修复，已通过本样本的 **真实创建→正确答复送达→初始投递→marker→群内确认→完成通知→清理限定复验**。E36 原 R-F 保留为修复前证据，不再将该限定误拒写为仍未修复。E37 仍有上节单参与者 welcome 的措辞边界，其他项目/参与者/权限/未知结果和通知质量组合未扩大验证，整体目标保持 active。


补充保留性回读：`.cache/live/e37-preservation.json` 实测五条旧消息内容完整不变，讨论目录仍存在、文件数为零；该样本不扩展为非空项目代码保护已全验。
