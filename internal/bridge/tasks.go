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
			if !b.tasks.OwnerAllowed(r.OwnerID) || r.Status == tasks.Destroying || r.Status == tasks.Destroyed {
				return ""
			}
			return r.ChatID
		}
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
	// WithTaskChats disables the SDK's global @ requirement. Unbound groups
	// retain it so unrelated conversations never become terminal input.
	if !bound && m.ChatType == lark.ChatGroup && !m.MentionedBot {
		return true, nil
	}
	if command {
		if cmd.Error != "" {
			return true, b.reply(ctx, m, "", cmd.Error)
		}
		switch cmd.Kind {
		case "projects":
			return true, b.reply(ctx, m, "", b.tasks.Projects())
		case "list":
			return true, b.reply(ctx, m, "", tasks.Summary(b.tasks.List(m.UserID, cmd.All)))
		case "new":
			if bound {
				return true, b.reply(ctx, m, "", "请回入口机器人私聊新建任务，当前群只处理绑定的任务。")
			}
			created, err := b.tasks.Create(m.UserID, m.ChatID, m.MessageID, cmd.Project, cmd.Agent, cmd.Text)
			if err != nil {
				return true, b.reply(ctx, m, "", err.Error())
			}
			return true, b.reply(ctx, m, "", fmt.Sprintf("任务已登记：%s\n项目：%s · %s\n编号：%s\n正在创建飞书任务和执行会话，可用 /tasks 查看进展。", created.Title, created.Project, created.Agent, created.ID))
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
			updated, err := b.tasks.Request(m.UserID, id, cmd.Action)
			if err != nil {
				return true, b.reply(ctx, m, "", err.Error())
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
	case "/help":
		return true, b.reply(ctx, m, "", tasks.Help+"\n/screen — 查看当前任务屏幕\n/stop — 中断当前 agent")
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
