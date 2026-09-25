import { fail, safeError } from "../core/errors.js";
import type { HerdrPort } from "../core/ports.js";
import type { ActorContext } from "../core/types.js";
import type { ProjectCatalog } from "../projects/catalog.js";
import type { RuntimeTool, SessionService } from "../runtime/index.js";
import type { Store } from "../storage/store.js";
import type { TaskAction } from "../tasks/lifecycle.js";
import type { TaskService } from "../tasks/service.js";
import { agentKind, boolean, optionalString, string, strings, taskInput } from "./validation.js";

interface Services {
  tasks: TaskService;
  projects: ProjectCatalog;
  sessions: SessionService;
  herdr: HerdrPort;
  store: Store;
}
const text = (description: string) => ({ type: "string", description });
const taskId = text("任务列表或创建结果中的任务编号；任务群可省略，始终限定本群");
const participantId = text("当前任务中的参与者编号或唯一名称，多参与者时必须明确");
const taskActions = ["complete", "close", "destroy", "reopen", "retry", "pause", "resume"];
const mutationGuard = (signal?: AbortSignal) => () => {
  if (signal?.aborted) fail("cancelled", "本轮已取消，尚未开始排队的任务操作。");
};

export function applicationTools(services: Services, actor: ActorContext): RuntimeTool[] {
  const tool = (
    name: string,
    description: string,
    readOnly: boolean,
    properties: Record<string, unknown>,
    required: string[],
    execute: RuntimeTool["execute"],
  ): RuntimeTool => ({
    name,
    description,
    readOnly,
    parameters: { type: "object", properties, required, additionalProperties: false },
    execute,
  });
  const id = (args: Record<string, unknown>, ctx: ActorContext) =>
    optionalString(args, "taskId") ?? ctx.taskId ?? string(args, "taskId");
  const tools = [
    tool(
      "tasks_list",
      "查询实际任务。默认未结束，all=true含已完成/销毁历史；群内只返回绑定任务。",
      true,
      { all: { type: "boolean" } },
      [],
      async (args, ctx) => services.tasks.list(ctx, boolean(args, "all")),
    ),
    tool(
      "task_get",
      "查询当前任务事实、参与者和错误。remoteTaskId证明飞书任务存在；chatId且未groupDeleted证明群已建立；参与者started仅证明启动，initialSent才证明初始要求投递已确认。缺失字段或queued不能报告资源已创建、已转交。回复结束不等于验收，输出不是独立验证。" +
        "收尾时groupDeleted:false不能概括全部收尾完成，也不证明删群指令已发出。若群等待最后输入或通知送达，本轮群回复自身也在等待范围内；简短说明即将解散并结束本轮，不重复查询等待自己的回复。其他错误或unknown不视作仅等回复。",
      true,
      { taskId },
      [],
      async (args, ctx) => {
        const task = services.tasks.get(ctx, id(args, ctx));
        const participants = await Promise.all(
          task.participants.map(async (participant) => {
            if (!participant.execution) return participant;
            try {
              const runtime = await services.herdr.get(participant.execution.paneId);
              const ref = participant.execution;
              if (runtime.workspaceId !== ref.workspaceId || runtime.kind !== ref.kind) {
                return { ...participant, readError: "执行目标已变化，请检查现场。" };
              }
              return { ...participant, runtime, observedAt: new Date().toISOString() };
            } catch (error) {
              return { ...participant, readError: safeError(error).message };
            }
          }),
        );
        const orchestrationHistory = services.store
          .list<{ taskId: string; createdAt: string }>("task_orchestration_events")
          .filter((event) => event.taskId === task.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return { ...task, participants, orchestrationHistory };
      },
    ),
    tool(
      "participant_screen",
      "读取指定参与者的真实屏幕与权限问题，只读，不选择审批选项。",
      true,
      { taskId, participantId },
      [],
      async (args, ctx) =>
        services.tasks.screen(ctx, id(args, ctx), optionalString(args, "participantId")),
    ),
    tool(
      "participant_send",
      "将用户项目需求、讨论或后续指令交给指定Claude/Codex。pi不代做项目需求讨论。未知投递不得重发。",
      false,
      { taskId, participantId, text: text("完整用户要求和上下文，保留否定约束") },
      ["text"],
      async (args, ctx, signal) =>
        services.tasks.send(
          ctx,
          id(args, ctx),
          optionalString(args, "participantId"),
          string(args, "text"),
          mutationGuard(signal),
        ),
    ),
    tool(
      "task_action",
      "管理本工具任务：任务、群、herdr执行session统一生命周期，complete确认完成后默认通过herdr关闭对应Codex/Claude并解散群，任何原因群解散都须清对应执行资源。明确保留群传keepGroup:true；明确保留执行现场传keepExecution:true（仅complete支持），有群任务还必须同时keepGroup:true，无群任务除外。保留群不自动保留执行器。keepGroup省略按策略来源处理，明确保留证据有效，旧默认/来源不明值在收尾时采用解散。close验收后清理；destroy不验收；reopen仅适用仍保留执行资源的已完成任务；retry仅明确失败；pause停止调度；resume恢复。review不是完成，不收尾。清理成功须查询实际回执。" +
        "执行资源已关闭但群仍保留时，用户明确要求解散该群可用destroy并传keepGroup:false；已经确认完成的任务也可用close并传keepGroup:false。这只清理剩余群，不重启执行器或改写验收事实。" +
        "completed/closeRequested仅确认任务完成或收尾意图，不证明执行器关闭、删群请求已发或全部收尾完成。答复按实际阶段简短说明，群待解散时首句不得抢报全部完成，也不展示completed/gone/排队回执等字段。",
      false,
      {
        taskId,
        action: { type: "string", enum: taskActions },
        keepGroup: {
          type: "boolean",
          description:
            "用户明确保留群时为true，明确解散此前保留群时为false；省略由服务按明确保留证据或默认解散策略处理",
        },
        keepExecution: {
          type: "boolean",
          description: "仅complete支持；明确保留执行器才为true，有群任务必须同时keepGroup:true",
        },
      },
      ["action"],
      async (args, ctx, signal) =>
        services.tasks.action(
          ctx,
          id(args, ctx),
          string(args, "action") as TaskAction,
          {
            keepGroup: args.keepGroup === undefined ? undefined : boolean(args, "keepGroup"),
            keepExecution:
              args.keepExecution === undefined ? undefined : boolean(args, "keepExecution"),
          },
          mutationGuard(signal),
        ),
    ),
    tool(
      "participant_interrupt",
      "用户要求时中断指定参与者，all为全部；不会代替人批准菜单。",
      false,
      { taskId, participantId },
      [],
      async (args, ctx, signal) => {
        await services.tasks.interrupt(
          ctx,
          id(args, ctx),
          optionalString(args, "participantId"),
          mutationGuard(signal),
        );
        return { accepted: true };
      },
    ),
    tool(
      "participant_add",
      "向当前任务添加讨论/执行参与者。参与者由herdr托管，新增后等待安排发言。",
      false,
      {
        taskId,
        kind: { type: "string", enum: ["claude", "codex"] },
        name: text("名称"),
        role: text("角色"),
      },
      ["kind"],
      async (args, ctx, signal) =>
        services.tasks.addParticipant(
          ctx,
          id(args, ctx),
          {
            kind: agentKind(args.kind),
            name: optionalString(args, "name"),
            role: optionalString(args, "role"),
          },
          mutationGuard(signal),
        ),
    ),
    tool(
      "participant_remove",
      "按用户要求让指定参与者退出并关闭其受管窗口，保留历史。",
      false,
      { taskId, participantId },
      ["participantId"],
      async (args, ctx, signal) => {
        await services.tasks.removeParticipant(
          ctx,
          id(args, ctx),
          string(args, "participantId"),
          mutationGuard(signal),
        );
        return { accepted: true };
      },
    ),
  ];
  if (actor.taskId) return tools;
  tools.push(
    tool(
      "project_save",
      "按用户要求登记已有项目目录与默认agent；目录列表首项为主目录。",
      false,
      {
        name: text("项目名"),
        directories: { type: "array", items: { type: "string" }, minItems: 1 },
        agent: { type: "string", enum: ["codex", "claude"] },
        makeDefault: { type: "boolean" },
      },
      ["name", "directories", "agent"],
      async (args) =>
        services.projects.save(
          {
            name: string(args, "name"),
            directories: strings(args.directories),
            agent: agentKind(args.agent),
          },
          boolean(args, "makeDefault"),
        ),
    ),
    tool(
      "project_create",
      "仅当用户明确新建项目时创建主目录、初始化Git并登记。新建任务无需调用此工具。",
      false,
      { name: text("项目名"), agent: { type: "string", enum: ["codex", "claude"] } },
      ["name", "agent"],
      async (args) => services.projects.create(string(args, "name"), agentKind(args.agent)),
    ),
    tool(
      "project_remove",
      "按用户要求移除项目登记，保留代码目录和既有任务快照。",
      false,
      { name: text("项目名") },
      ["name"],
      async (args) => services.projects.remove(string(args, "name")),
    ),
    tool(
      "session_clear",
      "用户以自然语言明确要求开启全新主入口上下文时调用。单独发送/clear由程序直接处理，无需模型或此工具；引用或讨论命令不等于执行授权。飞书主机器人私聊：本轮回复持久后归档旧pi session并创建、选中新session；旧历史/回执保留，未执行的旧会话排队消息拒绝，不改投新会话；群聊禁止。真实返回scheduled:true、mode:new_session和confirmation后，仅原样回复confirmation；程序在切换事务持久成功后送达。未调用、失败或未确认不得回复成功。Web仅展示会话记录，不提供操作入口。自动压缩无需调用此工具，任务和herdr执行session不变。",
      false,
      {},
      [],
      async (_args, ctx) => {
        const result = services.sessions.requestReset(ctx);
        return result.scheduled && result.mode === "new_session"
          ? { ...result, confirmation: "CLEAR_NEW_SESSION_OK" }
          : result;
      },
    ),
    tool(
      "projects_list",
      "查询配置项目、有序目录、默认agent及Bypass；不读写业务源代码。",
      true,
      {},
      [],
      async () => services.projects.snapshot(),
    ),
    tool(
      "task_create",
      "登记讨论/开发/评审/测试任务，实际项目业务全交Claude/Codex。新任务默认在completed确认后解散群；明确保留群须传keepGroup:true，review不触发解散。返回accepted:true/status:queued只证明本地登记；飞书任务、群、执行器启动与初始投递由后续异步provision完成，不可立即声称这些资源已创建或已转交。要报告外部创建成功，先task_get核验remoteTaskId/chatId；要报告要求已转交，核验参与者initialSent。讨论可无项目；多参与者讨论默认有界轮流发言。newProject仅用于用户明确新建项目。",
      false,
      {
        kind: { type: "string", enum: ["discussion", "development", "review", "test"] },
        title: text("任务名称"),
        requirements: text("完整用户要求，不能只传标题"),
        project: text("已配置项目名称"),
        newProject: { type: "boolean" },
        parentTaskId: text("先前讨论任务编号，关联已确认结论"),
        participants: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["codex", "claude"] },
              name: text("参与者名称"),
              role: text("参与角色"),
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        directoryMode: { type: "string", enum: ["shared", "worktree"] },
        keepGroup: {
          type: "boolean",
          description:
            "仅明确要求验收完成后仍保留群时为true；等待验收/不自动完成不构成保留群要求，默认解散",
        },
        createGroup: { type: "boolean" },
        createRemoteTask: { type: "boolean" },
        orchestration: {
          type: "object",
          description:
            "model让pi根据执行结果自主分工、继续、返工和委托汇总；manual仅按用户逐次安排。默认model；明确指定discussion.mode时沿用该策略。",
          properties: {
            mode: { type: "string", enum: ["model", "manual"] },
            maxDecisions: {
              type: "integer",
              minimum: 1,
              maximum: 256,
              description: "默认32次，含分派、复核和返工；到限保留进度并说明阻塞",
            },
            maxMinutes: {
              type: "number",
              minimum: 1,
              maximum: 1440,
              description: "默认240分钟；不会越过普通人工审批",
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        discussion: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["manual", "round_robin"] },
            maxRounds: { type: "integer", minimum: 1, maximum: 50 },
            maxMinutes: { type: "number", minimum: 1, maximum: 240 },
          },
          additionalProperties: false,
        },
      },
      ["kind", "title", "requirements", "participants"],
      async (args, ctx, signal) => ({
        accepted: true,
        task: await services.tasks.create(
          ctx,
          taskInput({
            ...args,
            orchestration:
              args.orchestration ??
              (args.discussion && typeof args.discussion === "object" && "mode" in args.discussion
                ? undefined
                : { mode: "model" }),
          }),
          mutationGuard(signal),
        ),
      }),
    ),
    tool(
      "sessions_list",
      "列出当前用户的pi调度会话。编码session仍由herdr托管。",
      true,
      { archived: { type: "boolean" } },
      [],
      async (args, ctx) =>
        services.sessions.list(ctx.ownerId, { archived: boolean(args, "archived") }),
    ),
    tool(
      "session_create",
      "用户要求新pi调度会话时创建；可指定select让后续消息进入新会话，不创建编码任务。",
      false,
      { name: text("会话名称"), select: { type: "boolean" } },
      ["name"],
      async (args, ctx) => {
        const session = services.sessions.create(ctx.ownerId, { name: string(args, "name") });
        if (boolean(args, "select")) {
          if (ctx.source === "web") services.store.set("web_selection", ctx.ownerId, session.id);
          else services.sessions.select(ctx.ownerId, ctx.chatId, session.id);
        }
        return session;
      },
    ),
    tool(
      "session_select",
      "为当前入口切换后续消息使用的pi会话；任务群不可切换。",
      false,
      { sessionId: text("已有主入口会话编号") },
      ["sessionId"],
      async (args, ctx) => {
        const selected = services.sessions.select(
          ctx.ownerId,
          ctx.chatId,
          string(args, "sessionId"),
        );
        if (ctx.source === "web") services.store.set("web_selection", ctx.ownerId, selected.id);
        return selected;
      },
    ),
    tool(
      "session_rename",
      "重命名用户已有pi会话。",
      false,
      { sessionId: text("会话编号"), name: text("新名称") },
      ["sessionId", "name"],
      async (args, ctx) =>
        services.sessions.rename(ctx.ownerId, string(args, "sessionId"), string(args, "name")),
    ),
    tool(
      "session_archive",
      "按用户要求归档主入口pi会话。归档当前会话会在本轮答复生成后生效，保留历史和任务；不关闭herdr执行资源。",
      false,
      { sessionId: text("待归档的主入口会话编号") },
      ["sessionId"],
      async (args, ctx) => services.sessions.requestArchive(ctx, string(args, "sessionId")),
    ),
    tool(
      "session_restore",
      "恢复当前用户已归档的主入口pi会话，保留原历史；需要切换时再使用session_select。",
      false,
      { sessionId: text("待恢复的主入口会话编号") },
      ["sessionId"],
      async (args, ctx) => {
        const session = services.sessions.get(ctx.ownerId, string(args, "sessionId"));
        if (session.taskId) fail("task_session", "任务会话由任务生命周期管理，不能在主入口恢复。");
        return services.sessions.restore(ctx.ownerId, session.id);
      },
    ),
  );
  return tools;
}
