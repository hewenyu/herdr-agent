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
      "查询当前任务事实、参与者和错误。remoteTaskId证明飞书任务存在；chatId且未groupDeleted证明群已建立；参与者started仅证明启动，initialSent才证明初始要求投递已确认。缺失字段或queued不能报告资源已创建、已转交。回复结束不等于验收，输出不是独立验证。",
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
        return { ...task, participants };
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
      async (args, ctx) =>
        services.tasks.send(
          ctx,
          id(args, ctx),
          optionalString(args, "participantId"),
          string(args, "text"),
        ),
    ),
    tool(
      "task_action",
      "管理本工具任务：complete仅完成保留现场；close验收后清理；destroy不验收；reopen重开；retry仅明确失败；pause停止调度；resume恢复。仅执行用户授权动作。",
      false,
      { taskId, action: { type: "string", enum: taskActions } },
      ["action"],
      async (args, ctx) =>
        services.tasks.action(ctx, id(args, ctx), string(args, "action") as TaskAction),
    ),
    tool(
      "participant_interrupt",
      "用户要求时中断指定参与者，all为全部；不会代替人批准菜单。",
      false,
      { taskId, participantId },
      [],
      async (args, ctx) => {
        await services.tasks.interrupt(ctx, id(args, ctx), optionalString(args, "participantId"));
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
      async (args, ctx) =>
        services.tasks.addParticipant(ctx, id(args, ctx), {
          kind: agentKind(args.kind),
          name: optionalString(args, "name"),
          role: optionalString(args, "role"),
        }),
    ),
    tool(
      "participant_remove",
      "按用户要求让指定参与者退出并关闭其受管窗口，保留历史。",
      false,
      { taskId, participantId },
      ["participantId"],
      async (args, ctx) => {
        await services.tasks.removeParticipant(ctx, id(args, ctx), string(args, "participantId"));
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
      "用户明确要求清空当前主入口pi上下文时调用；本轮回复生成后生效，保留历史、任务和herdr执行session。",
      false,
      {},
      [],
      async (_args, ctx) => services.sessions.requestReset(ctx),
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
      "登记讨论/开发/评审/测试任务，实际项目业务全交Claude/Codex。返回accepted:true/status:queued只证明本地登记；飞书任务、群、执行器启动与初始投递由后续异步provision完成，不可立即声称这些资源已创建或已转交。要报告外部创建成功，先task_get核验remoteTaskId/chatId；要报告要求已转交，核验参与者initialSent。讨论可无项目；多参与者讨论默认有界轮流发言。newProject仅用于用户明确新建项目。",
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
        keepGroup: { type: "boolean" },
        createGroup: { type: "boolean" },
        createRemoteTask: { type: "boolean" },
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
      async (args, ctx) => ({
        accepted: true,
        task: await services.tasks.create(ctx, taskInput(args)),
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
