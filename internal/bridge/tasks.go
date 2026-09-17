package bridge

import (
	"context"
	"fmt"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/commands"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func WithTasks(m *tasks.Manager) Option { return func(b *bridge) { b.tasks = m } }
func (b *bridge) notifyChat(pane string) string {
	if b.tasks != nil {
		if r, ok := b.tasks.ByPane(pane); ok {
			if !b.tasks.OwnerAllowed(r.OwnerID) || r.ChatDeleted || r.Status == tasks.Destroying || r.Status == tasks.Destroyed {
				return ""
			}
			return r.ChatID
		}
		// Task mode owns its group destinations. Other local agents, including
		// temporary development panes, must not post into the entry chat.
		return ""
	}
	return b.deps.NotifyChatID
}
func (b *bridge) taskMessage(ctx context.Context, m lark.Msg) (bool, error) {
	cmd, command := tasks.Parse(m.Text)
	if b.tasks == nil {
		if command {
			return true, b.reply(ctx, m, "", "任务管理尚未启用；请配置 tasks.enabled 和项目仓库映射。")
		}
		return false, nil
	}
	r, bound := b.tasks.ByChat(m.ChatID)
	if bound && r.OwnerID != m.UserID {
		return true, ErrUnauthorized
	}
	if bound {
		parsed := commands.Parse(m.Text)
		if parsed.Kind == commands.KindClear {
			return true, b.reply(ctx, m, "", "/clear 仅用于主应用私聊。任务群保持独立会话，通过自动压缩和记忆延续上下文。")
		}
		if parsed.Kind == commands.KindBadArgs && strings.HasPrefix(parsed.Reason, "/clear:") {
			return true, b.handleMessage(ctx, m)
		}
		if groupCommand, ok := tasks.GroupCloseCommand(m.Text); ok {
			cmd, command = groupCommand, true
		}
		if strings.TrimSpace(m.Text) == "/help" {
			return true, b.reply(ctx, m, "", tasks.GroupCloseHint+"\n\n"+tasks.Help+"\n/screen — 查看当前任务屏幕\n/stop — 中断当前 agent")
		}
	}
	// WithTaskChats disables the SDK's global @ requirement. Unbound groups
	// retain it so unrelated conversations never become terminal input.
	if !bound && m.ChatType == lark.ChatGroup && !m.MentionedBot {
		return true, nil
	}
	if !bound {
		if _, groupCommand := tasks.GroupCloseCommand(m.Text); groupCommand {
			return true, b.reply(ctx, m, "", "请进入对应任务群发送 /关闭项目，查看说明后回复“确认关闭”。该命令只关闭所在任务群绑定的任务。")
		}
	}
	if command {
		if cmd.Error != "" {
			return true, b.reply(ctx, m, "", cmd.Error)
		}
		switch cmd.Kind {
		case "close_prompt":
			return true, b.reply(ctx, m, "", fmt.Sprintf("关闭本群任务：%s\n项目：%s\n\n确认已完成后，请回复“确认关闭”。系统会同步飞书任务完成、保存结果、关闭对应 Agent 会话，并自动解散本群。\n代码、项目配置和飞书任务结果保留；解散后的群聊天记录不保留。", r.Title, r.Project))
		case "projects":
			if bound {
				return true, b.reply(ctx, m, "", "本群只处理当前任务。\n"+tasks.Summary([]tasks.Record{r}))
			}
			return true, b.reply(ctx, m, "", b.tasks.Projects())
		case "list":
			if bound {
				return true, b.reply(ctx, m, "", tasks.Summary([]tasks.Record{r})+"\n\n"+tasks.GroupCloseHint)
			}
			records := b.tasks.List(m.UserID, cmd.All)
			if !cmd.All {
				// The manager also tracks cleanup and uncertain resource creation
				// on terminal records. Those are history in a user task overview.
				active := records[:0]
				for _, record := range records {
					if record.Status != tasks.Completed && record.Status != tasks.Destroyed {
						active = append(active, record)
					}
				}
				records = active
			}
			return true, b.reply(ctx, m, "", tasks.Summary(records))
		case "new":
			if bound {
				return true, b.reply(ctx, m, "", "请回入口机器人私聊新建任务，当前群只处理绑定的任务。")
			}
			created, err := b.tasks.Create(m.UserID, m.ChatID, m.MessageID, cmd.Project, cmd.Agent, cmd.Text)
			if err != nil {
				return true, b.reply(ctx, m, "", err.Error())
			}
			return true, b.reply(ctx, m, "", fmt.Sprintf("任务已登记：%s\n项目：%s · %s\n编号：%s\n任务群建立后会在此发送入口；后续进度、审批和验收均在任务群内处理。", created.Title, created.Project, created.Agent, created.ID))
		case "action":
			id := cmd.ID
			if id == "" && bound {
				id = r.ID
			}
			if bound && id != r.ID {
				return true, b.reply(ctx, m, "", "此群只能操作它绑定的任务。")
			}
			if id == "" {
				return true, b.reply(ctx, m, "", "请填写任务编号，或在对应任务群执行。")
			}
			if bound && cmd.Action == "close" && r.Status == tasks.Destroying {
				return true, b.reply(ctx, m, "", "关闭正在处理中，系统会继续清理对应 Agent 和执行窗口，然后自动解散本群。")
			}
			updated, err := b.tasks.Request(m.UserID, id, cmd.Action)
			if err != nil {
				return true, b.reply(ctx, m, "", err.Error())
			}
			if cmd.Action == "close" {
				return true, b.reply(ctx, m, "", fmt.Sprintf("已收到关闭确认：%s\n正在同步任务完成并保存结果，随后会关闭 Agent 会话并自动解散任务群。代码和飞书任务记录保留。\n%s", updated.Title, updated.URL))
			}
			return true, b.reply(ctx, m, "", fmt.Sprintf("已登记操作 %s：%s\n%s", cmd.Action, updated.Title, updated.URL))
		}
	}
	if !bound {
		if strings.TrimSpace(m.Text) == "/help" {
			return true, b.reply(ctx, m, "", tasks.Help+"\n\n"+commands.Help())
		}
		return false, nil
	}
	if r.Status == tasks.Completed || r.Status == tasks.Destroying || r.Status == tasks.Destroyed {
		return true, b.reply(ctx, m, "", "任务已完成或会话正在关闭。继续任务请先 /task reopen；关闭执行窗口和群请用 /task destroy。")
	}
	if r.PaneID == "" || !r.Started {
		return true, b.reply(ctx, m, "", "agent 正在启动；用 /tasks 查看状态。")
	}
	a, ok := b.deps.Registry.Get(r.PaneID)
	if !ok || a.Kind != r.Agent || a.WorkspaceID != r.WorkspaceID {
		return true, b.reply(ctx, m, "", "任务的 agent 当前不可用或已被替换；不会转发到其他窗口。")
	}
	// A task group has one target. Keep screen/stop/help escape hatches, but
	// never let /ls, /say, a stale reply binding or a selection switch its pane.
	switch strings.TrimSpace(m.Text) {
	case "/screen":
		return true, b.commandCard(ctx, m, r.PaneID)
	case "/stop":
		return true, b.commandStop(ctx, m, r.PaneID)
	}
	if strings.HasPrefix(strings.TrimSpace(m.Text), "/") {
		return true, b.reply(ctx, m, "", "任务群支持 /screen、/stop 和任务命令。\n"+tasks.Help)
	}
	err := b.deliver(ctx, m.ChatID, m.MessageID, aim{agent: a}, m.Text)
	return true, err
}
func (b *bridge) taskObserve(a agents.Agent, status tasks.Status, detail, result string) {
	if b.tasks != nil {
		if err := b.tasks.Observe(a.PaneID, status, detail, result); err != nil {
			b.log.Error("bridge: persist task progress", "err", err)
		}
	}
}
