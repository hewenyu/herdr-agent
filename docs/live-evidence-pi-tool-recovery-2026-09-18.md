# pi 工具事实护栏现场证据（2026-09-18）

本记录对应当前后续修正分支 `fix/pi-tool-recovery`。它只记录离线协议替身和本地状态检查，不能替代真实飞书用户入站、真实模型服务、herdr 资源和任务群的端到端验收。

## 发现的问题

在修正前，模型可以直接输出“已创建/已安排”等完成性文字而不发出工具调用。`PiEngine` 会把任意非空文字视为成功，`SessionService` 随后保存 assistant 消息、标记 turn finished，并创建 outbox 投递候选。此时 `pi_checkpoints` 没有 `toolCall`，`pi_operations` 为空，用户却可能收到成功式回执。

该问题已用本地协议替身重现；没有使用真实业务 marker，也没有创建本次记录对应的飞书任务、群或 herdr 执行器。

## 修正后的行为

- 普通无工具闲聊仍直接返回模型文字。
- 相关业务工具可用、但模型输出可识别的业务完成性声称且本轮没有工具调用时，pi 只要求模型再检查一次并强制选择工具；程序不生成或改写业务答复。
- 重试产生真实工具调用后，返回模型根据工具结果生成的最终文字，并在 `EngineResult` 暴露 `toolCalls` / `writeCalls`。
- 重试仍没有工具调用时，本轮以 `model_failed`、`not_executed` 失败；不保存成功 assistant 消息、不标记 finished，也不创建成功 outbox 候选。
- `SessionService` 对其他引擎再次检查工具事实，防止非 pi 引擎绕过这条边界。

## 自动化证据

`tests/runtime/claims.test.ts`、`tests/runtime/engine.test.ts` 和 `tests/runtime/sessions.test.ts` 覆盖：

- 普通无工具回复保持成功；
- 无工具的“已创建任务”先触发工具受限重试；
- 重试仍无工具时失败且不进入 assistant 消息或投递候选；
- 真实工具调用返回调用数、写调用数，并保留 checkpoint；
- 现有会话、投递、清理和协议回归。

截至本记录生成时，`npm run check` 通过 427/427 项；macOS arm64 的 `npm run build`、`npm run binary` 和 `npm run smoke` 均通过。

## 真实验收边界

唯一现场 marker `LIVE-001-R3-20260918` 尚未从主入口飞书私聊发现。当前状态库的 inbox、messages、pi_checkpoints、pi_operations、tasks、participants 和 outbox 均没有该 marker，也没有为它执行外部写操作。因此 LIVE-001 仍保持未验收。

真实验收必须由用户从主入口私聊发送唯一请求，然后只读核对：真实 assistant `toolCall` checkpoint、operation/task/group、herdr agent/workspace/pane、用户可见回复、项目目录和 HTML 产物；完成后再按用户选择清理专用任务、群和 Claude/Codex session，并回读所有清理事实。
