# E31：真实飞书主入口 `/clear` 机械轮转

日期：2026-09-19（Asia/Shanghai）。本记录覆盖当前 `cfc7d16` 构建的 `0.3.12-dev` macOS arm64 服务实例，以及主入口私聊 exact `/clear` 的真实用户入口。

## 真实操作

用户在已登录的飞书桌面端主私聊 `oc_51206f1905fd3d9d445222e9ac805cc3` 中直接发送 `/clear`。服务没有调用模型，程序按命令事务归档旧 pi session、创建并选中新 session，再投递唯一成功标记。

本地状态回读如下：

- 旧 session `s_2d0d2bc7-9ecf-457a-afb7-79cbae585505`：`archived=true`。
- 新 session `s_26c0b10c-8999-411d-939a-ecd6b768dbc7`：`archived=false`，`session_selection` 已切换到该 session。
- `session_rotations` 记录了旧、新 session 和对应 reply；`pi_operations` 未新增模型工具调用。
- `/clear` 用户消息与 `CLEAR_NEW_SESSION_OK` 回复均为 `delivered`；outbox 只有一片，真实 message ID 为 `om_x100b65e905ef80a4b1b8a10edbdfd4c`。
- 飞书客户端真实可见回复严格为 `CLEAR_NEW_SESSION_OK`，没有附加状态说明。

旧任务、任务群和 herdr 托管 session 未因 `/clear` 被关闭；该命令只切换当前主入口 pi session。服务进程仍为验收期间的单一实例。

## 判定和边界

本次关闭 FSH05 的“真实主私聊 exact `/clear`、不调用模型、归档旧 session、选中新 session、精确成功标记和可见送达”子项，判定为 **R-P**。事务失败、旧队列拒绝、重复 event、群聊拒绝和重启恢复仍以自动化证据或既有部分现场证据覆盖，不能据此把整行 FSH05 标为全量通过。
