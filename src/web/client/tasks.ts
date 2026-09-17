import type { Participant, Task } from "../../core/types.js";
import type { WebState } from "../contracts.js";
import type { Action } from "./api.js";
import {
  actions,
  ask,
  badge,
  button,
  closeModal,
  el,
  empty,
  field,
  heading,
  modal,
  time,
} from "./dom.js";
import { createTaskForm, participantFields } from "./task-form.js";

function taskAction(
  task: Task,
  operation: string,
  label: string,
  action: Action,
  destructive = false,
) {
  return button(
    label,
    async () => {
      const run = async () =>
        Boolean(await action("task.action", { id: task.id, action: operation }));
      if (destructive)
        ask(
          label,
          operation === "close"
            ? "验收完成后将同步任务状态并清理执行会话；群是否保留按此任务的设置处理。请确认参与者的实际结果。"
            : "将关闭本任务拥有的执行会话，按任务设置处理群与历史。此操作不会删除项目代码，也不代表验收通过。",
          run,
        );
      else await run();
    },
    `small ${destructive ? "danger" : ""}`,
  );
}

async function showScreen(participant: Participant, action: Action): Promise<void> {
  const result = await action("participant.screen", {
    taskId: participant.taskId,
    participantId: participant.id,
  });
  if (!result?.screen) return;
  const screen = result.screen;
  const body = modal(`${participant.name} · 执行现场`);
  body.append(badge(screen.agent.status), el("pre", "screen", screen.text));
  const controls = actions(button("刷新现场", () => showScreen(participant, action)));
  if (result.approval) {
    const nonce = result.approval.nonce;
    body.append(
      el("p", "subtle", "以下操作只回答本次显示的问题。卡片过期或目标改变时，服务端会拒绝旧操作。"),
    );
    for (const choice of result.approval.options ?? screen.options) {
      controls.append(
        button(
          choice.label,
          async () => {
            if (
              await action("participant.answer", {
                taskId: participant.taskId,
                nonce,
                key: choice.key,
              })
            )
              closeModal();
          },
          "primary",
        ),
      );
    }
    controls.append(
      button(
        "Esc · 取消当前问题",
        async () => {
          if (await action("participant.answer", { taskId: participant.taskId, nonce, key: "esc" }))
            closeModal();
        },
        "danger",
      ),
    );
  }
  body.append(controls);
}

function participantCard(participant: Participant, action: Action): HTMLElement {
  const card = el("article", "card");
  const top = el("div", "card-top");
  top.append(el("strong", "card-title", participant.name), badge(participant.status));
  card.append(
    top,
    el("p", "subtle", `${participant.kind.toUpperCase()} · ${participant.role || "任务参与者"}`),
  );
  if (participant.error) card.append(el("p", "notice error", participant.error));
  if (participant.lastOutput) card.append(el("p", "task-results", participant.lastOutput));
  const controls = actions();
  if (participant.execution && participant.status !== "removed") {
    controls.append(
      button(
        "发送要求",
        () => {
          const body = modal(`发给 ${participant.name}`);
          const content = field("消息内容", "", "textarea");
          body.append(
            content.wrapper,
            actions(
              button("取消", closeModal),
              button(
                "发送",
                async () => {
                  if (
                    content.input.value.trim() &&
                    (await action("participant.send", {
                      taskId: participant.taskId,
                      participantId: participant.id,
                      text: content.input.value.trim(),
                    }))
                  )
                    closeModal();
                },
                "primary",
              ),
            ),
          );
        },
        "small",
      ),
      button("查看现场 / 审批", () => showScreen(participant, action), "small"),
      button(
        "中断",
        async () => {
          await action("participant.interrupt", {
            taskId: participant.taskId,
            participantId: participant.id,
          });
        },
        "small danger",
      ),
    );
  }
  if (participant.status !== "removed")
    controls.append(
      button(
        "移除参与者",
        () =>
          ask(
            "移除参与者",
            `停止将新要求发给 ${participant.name} 并清理其托管执行资源；已有讨论记录保留。`,
            async () =>
              Boolean(
                await action("participant.remove", {
                  taskId: participant.taskId,
                  participantId: participant.id,
                }),
              ),
          ),
        "small danger",
      ),
    );
  card.append(controls);
  return card;
}

function addParticipant(task: Task, action: Action) {
  const body = modal("添加任务参与者");
  const container = el("div");
  const get = participantFields(container);
  body.append(
    el("p", "subtle", "新参与者加入当前任务。具体上下文和执行权限由任务状态核验。"),
    container,
    actions(
      button("取消", closeModal),
      button(
        "添加",
        async () => {
          const input = get();
          if (input && (await action("participant.add", { taskId: task.id, ...input })))
            closeModal();
        },
        "primary",
      ),
    ),
  );
}

export function renderTasks(
  state: WebState,
  action: Action,
  selectedId: string,
  selectTask: (id: string) => void,
): HTMLElement {
  const root = el("div", "stack");
  root.append(
    heading(
      "任务与参与者",
      "讨论、开发和评审共享同一套任务管理；每位参与者都有明确的执行位置。",
      button("＋ 创建任务", () => createTaskForm(state, action), "primary"),
    ),
  );
  const tasks = state.tasks ?? [];
  if (!tasks.length) {
    root.append(
      empty("任务清单还是空的", "创建一个讨论任务，或者在 pi 会话里描述你希望如何组织工作。"),
    );
    return root;
  }
  const task = tasks.find((item) => item.id === selectedId) ?? tasks[0];
  if (!task) return root;
  const split = el("div", "split");
  const list = el("div", "list");
  for (const item of [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const node = el("button", `list-item ${item.id === task.id ? "active" : ""}`);
    node.type = "button";
    node.append(
      el("strong", "", item.title),
      el("small", "", `${item.project ?? "讨论任务"} · ${time(item.updatedAt)}`),
      badge(item.status),
    );
    node.addEventListener("click", () => selectTask(item.id));
    list.append(node);
  }
  const detail = el("div", "stack");
  const overview = el("section", "panel");
  overview.append(
    heading(
      task.title,
      `${task.project ?? "未绑定项目"} · ${task.kind} · ${task.directoryMode === "worktree" ? "独立 worktree" : "共享目录"}`,
    ),
    actions(badge(task.status), el("span", "subtle", `群保留：${task.keepGroup ? "是" : "否"}`)),
    el("div", "divider"),
    el("p", "details", task.requirements),
  );
  if (task.remoteTaskUrl) {
    const link = el("a", "button small", "查看飞书任务 ↗");
    if (/^https:\/\//.test(task.remoteTaskUrl)) {
      link.href = task.remoteTaskUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      overview.append(link);
    }
  }
  if (task.error || task.syncError || task.pending)
    overview.append(
      el(
        "div",
        "notice error",
        [
          task.error,
          task.syncError,
          task.pending ? `待核对操作：${task.pending}。先查看状态与现场，结果未知时请勿重试。` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
  if (task.result) {
    overview.append(el("h3", "", "已记录结果"), el("div", "task-results", task.result));
  }
  const controls = actions();
  if (task.status !== "destroyed") {
    controls.append(
      taskAction(task, "complete", "仅标记完成", action),
      taskAction(task, "close", "验收并关闭", action, true),
      taskAction(task, "reopen", "重新打开", action),
      taskAction(task, "retry", "重试明确失败", action),
      taskAction(task, "pause", "暂停调度", action),
      taskAction(task, "resume", "恢复调度", action),
      taskAction(task, "destroy", "销毁执行会话", action, true),
      button(
        "中断所有参与者",
        async () => {
          await action("participant.interrupt", { taskId: task.id, participantId: "all" });
        },
        "small danger",
      ),
    );
  }
  overview.append(el("div", "divider"), controls);
  detail.append(overview);
  detail.append(
    heading(
      "参与者",
      `轮次 ${task.discussion.rounds} / ${task.discussion.maxRounds} · ${task.discussion.mode === "manual" ? "手动调度" : "轮流讨论"}`,
      ...(task.status !== "destroyed"
        ? [button("＋ 添加", () => addParticipant(task, action), "small")]
        : []),
    ),
  );
  for (const participant of (state.participants ?? []).filter((item) => item.taskId === task.id))
    detail.append(participantCard(participant, action));
  split.append(list, detail);
  root.append(split);
  return root;
}
