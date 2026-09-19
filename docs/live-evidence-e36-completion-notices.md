# E36：真实完成通知通过，创建答复仍失败

日期：2026-09-19；时间均为 UTC。**完成通知子链为 R-P，E36 整体为 R-部分并保留创建阶段 R-F。** 资源最终完成和清理不能覆盖主私聊创建答复被拒的故障。

## 基线与资源

部署记录 `.cache/live/e36-deployment.json`：`0.3.13-dev`，提交 `2e621e151167cbc0882115a62513fdbedb6d2aa6`，构建时间 `2026-09-19T11:33:06.399Z`，PID `16335`；运行二进制 `build/e36/herdr-agent`，SHA256 `12b94e248a0eef225e1fbc4cc3662b97e998c7918e012acf473da88c9e4c69b9`。完整检查含 602 项测试、格式/lint/类型/行数、SEA 烟测及三平台 CI 已通过，这些不代替下面的真实业务结果。

- 本地任务：`task_53dbc3f2899b8fb0c719be0c5d96b91b`，标题 `MYRIX-E36-COMPLETE-20260919`。
- 飞书任务：`78e579af-47c3-4121-bde2-59d9e99c014d`；群：`oc_0211e7b2e6c1c30869aeed041d04d718`。
- Codex：`w21:p1`，原生 session `01a0b973-8a61-7cc1-a192-d0d702076dfc`。
- 状态及 checkpoint 证据：`.cache/live/e36-state-final.json`。

## 创建回合失败与真实资源效果分开记录

真实主私聊入站 `om_x100b65d378b98ca8b1ae8b6a6bbd1d5` 于 `11:35:03.755Z` 创建，用户说“请让‘Codex’讨论这个需求”，明确无项目单 Codex、只回复 `MYRIX_E36_OK`、禁止工具/开发/测试、保留 Bypass、新目录信任由 pi 处理、其他确认由用户在群里处理、等待用户验收。

checkpoint `1c151246262c73379de53335d6765155566d597af5b1c40656c83be0df61b409` 顺序为 `task_create` → 两次 `task_get` → 第一份候选答复 → 事实恢复 → `task_get` → `participant_screen` → 第二份候选。整轮只创建一次任务。真实远端任务/群操作于 `11:35:24.804Z` / `11:35:25.704Z` 为 done。

两份候选均区分了群已创建和初始输入未确认，恢复后的候选还明确“不能声称要求已经转交”。但创建 inbox 最终为 **failed/model_failed**，错误为“pi 调度模型的答复缺少对应工具事实；已登记操作保留，请查询实际状态。”，`outcome=not_executed`。没有对应创建成功回复 outbox，后台建群通知不代替主回合答复。后续按原 checkpoint 重建两次快照，已定位为投递断言误拒：首稿把“已加入”与“初始要求的投递尚未确认”关联；终稿把“群已建立”与“初始要求投递确认前”关联。两者均没有声称已送达。修复按局部分句核验投递断言，真实复验结果后续单独记录，原回合失败不改写。

## 目录信任、输出与用户验收

- `:p1:directory-trust:240` 于 `11:35:43.059Z` 失败为 `stale_guard/not_executed`；`:241` 于 `11:35:55.642Z` done/confirmed=true，未确认陈旧现场。
- `:p1:initial` 于 `11:36:22.437Z` done，delivered/acked=true/verified=true/attempts=1。
- Codex marker 的署名群 outbox 为 delivered，消息 `om_x100b65d3756530a0b3ff806757c5710`，时间 `11:36:26.223Z`；真实飞书桌面 CUA 可见。
- `.cache/live/e36-native-evidence.json` 记录原生 transcript `~/.codex/sessions/2026/09/19/rollout-2026-09-19T19-35-52-01a0b973-8a61-7cc1-a192-d0d702076dfc.jsonl`，零工具调用、assistant 仅输出指定 marker。该证据不代表实际需求讨论质量或普通审批完整覆盖。

用户于任务群发送 `om_x100b65d3739d14a0b1b822aa535390b`，`11:36:53.525Z` 入站，确认 marker 并要求完成远端任务、herdr 关闭 Codex、解散群和保留目录/历史。完成 checkpoint `1db35447e22602257b1ac42547a6f5fd6f51ce17acb0a0c9fa8792b7aa43b981` 调用 `task_action complete` → `task_get`，该 inbox 为 done；阶段答复消息 `om_x100b65d37027dca0b279fea1a7149df` 于 `11:37:18.255Z` delivered，说明“已完成验收、收尾进行中、清理回执尚未全部返回”。

## 完成通知与清理子链

| 阶段 | UTC 时间 | 实际证据 |
| --- | --- | --- |
| completion | `11:37:04.262Z` | `:completion:c_b5c8ee90efef4117ad6df6ceea74a610` done |
| before_close 通知 | `11:37:24.239Z` | `notice:08d486ebd8b8a8e387ddf99bbde0902f` delivered；“任务已完成并进入收尾流程……目前群尚未删除”；消息 `om_x100b65d3718428a4b3dd4edc050083a` |
| herdr close | `11:37:25.045Z` | `:p1:close` done；participant gone |
| before_group_delete 通知 | `11:37:30.604Z` | `notice:ca5315fc0893b08170e5fad218de0aaa` delivered；“任务已完成……配套群聊即将解散”；消息 `om_x100b65d37162a8a0b1cca0e22c406b9` |
| 删除群 | `11:37:32.193Z` | `:delete-group` done |
| 最终任务 | `11:37:33.068Z` | destroyed、groupDeleted=true |

两个通知阶段均 processed。真实飞书 CUA 截图看到两条通知、主回合回复及退出群提示；herdr agent 列表为空。通知先于对应资源删除，明确区分业务完成和资源收尾阶段。

`.cache/live/e36-remote-after.json` 于 `11:38:20.357Z` 经生产应用真实 REST 确认远端任务 `completedAt=1789817823000`、群 dissolved，描述为 destroyed/gone 且包含 marker。该资源回读不冒充对通知消息正文的 REST 回读。

限定结论：用户群内确认之后的 complete→正确阶段答复/两条通知送达→herdr 关闭→群解散子链为 **R-P**。与 E35 的 destroy 通知分别成立；E34 无候选正文的失败历史不被覆盖。E36 创建回合仍 **R-F，待修复与真实复验**，其他入口、身份、审批和未知结果组合继续分验，完整目标 active。
