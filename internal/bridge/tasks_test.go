package bridge

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/screen"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

// These tests exercise the real persistent task bindings and installed bridge
// handlers. Provisioning is deliberately not run: any unexpected platform or
// lifecycle operation panics through these unused embedded interfaces.
type bridgeTaskPlatform struct{ tasks.Platform }
type bridgeTaskLifecycle struct{ herdrapi.LifecycleClient }

func attachTaskManager(t *testing.T, h *harness, records ...tasks.Record) (*tasks.Manager, *tasks.Store) {
	t.Helper()
	store, err := tasks.Open(filepath.Join(t.TempDir(), "tasks.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records {
		if _, err := store.Update(record.ID, func(r *tasks.Record) error { *r = record; return nil }); err != nil {
			t.Fatal(err)
		}
	}
	m, err := tasks.New(store, tasks.Options{
		Config: config.Tasks{Enabled: true, DefaultProject: "demo", PollInterval: time.Minute,
			Projects: map[string]config.Project{"demo": {Path: "/tmp/herdr-accept", Agent: "claude"}}},
		Platform: bridgeTaskPlatform{}, Client: &herdrapi.RecordingClient{}, Lifecycle: bridgeTaskLifecycle{},
		Controller: h.ctrl, Registry: h.reg,
	})
	if err != nil {
		t.Fatal(err)
	}
	WithTasks(m)(h.b)
	return m, store
}

func taskBinding(id, chat, pane string) tasks.Record {
	return tasks.Record{ID: id, GUID: "guid-" + id, OwnerID: testOwner,
		ChatID: chat, EntryChatID: testChat, PaneID: pane, WorkspaceID: "task-workspace-" + id,
		Project: "demo", Path: "/tmp/herdr-accept", Agent: "claude", Title: "修复 " + id,
		Status: tasks.Running, Started: true, PromptSent: true, CreatedAt: epoch, UpdatedAt: epoch}
}

func taskAgent(r tasks.Record) agents.Agent {
	a := idleAgent(r.PaneID)
	a.WorkspaceID = r.WorkspaceID
	return a
}

func taskInbound(r tasks.Record, text string) lark.Msg {
	m := inbound(text)
	m.ChatID, m.ChatType = r.ChatID, lark.ChatGroup
	return m
}

func sendTaskMessage(t *testing.T, h *harness, m lark.Msg) {
	t.Helper()
	h.b.installHandlers()
	message, _ := h.bot.handlers()
	if err := message(context.Background(), m); err != nil {
		t.Fatal(err)
	}
}

func TestTaskCreationAuthorizesBeforePersisting(t *testing.T) {
	h := newHarness(t)
	m, store := attachTaskManager(t, h)
	message := inbound("新建任务：修复登录，保留中文说明")
	message.UserID = testStranger
	sendTaskMessage(t, h, message)
	if len(store.List()) != 0 || len(h.bot.sends()) != 0 {
		t.Fatal("unauthorized creation wrote state or disclosed a response")
	}
	message.UserID = testOwner
	message.EventID = "authorized-create"
	sendTaskMessage(t, h, message)
	list := m.List(testOwner, true)
	if len(list) != 1 || list[0].Title != "修复登录，保留中文说明" || list[0].Project != "demo" || list[0].Agent != "claude" || list[0].EntryChatID != testChat {
		t.Fatalf("created task = %+v", list)
	}
	if len(h.ctrl.said()) != 0 {
		t.Fatal("the task creation command was also forwarded to an existing agent")
	}
	// A redelivery with a different event id still refers to the same message.
	message.EventID = "redelivered-create"
	sendTaskMessage(t, h, message)
	if len(store.List()) != 1 {
		t.Fatal("same source message created multiple task records")
	}
}

func TestTaskGroupRequiresItsOwnerEvenForAllowlistedUsers(t *testing.T) {
	for _, text := range []string{"继续测试", "/screen", "/tasks", "/task destroy"} {
		t.Run(text, func(t *testing.T) {
			h := newHarness(t, func(d *Deps) { d.AllowedOpenIDs = []string{testOwner, testStranger} })
			r := taskBinding("owned", "oc_task", testPane)
			_, store := attachTaskManager(t, h, r)
			h.reg.setAgents(taskAgent(r))
			m := taskInbound(r, text)
			m.UserID = testStranger
			sendTaskMessage(t, h, m)
			current, _ := store.Get(r.ID)
			if len(h.ctrl.said()) != 0 || len(h.ctrl.sentKeys()) != 0 || len(h.bot.sends()) != 0 || current.Status != tasks.Running {
				t.Fatal("a different allowlisted user acted on or read another owner's task")
			}
		})
	}
}

func TestTaskGroupListsOnlyItsBoundTask(t *testing.T) {
	for _, input := range []string{"/tasks", "/tasks all", "/projects"} {
		t.Run(input, func(t *testing.T) {
			h := newHarness(t)
			r := taskBinding("current", "oc_current", testPane)
			r.Status = tasks.Completed
			other := taskBinding("other", "oc_other", secondPane)
			attachTaskManager(t, h, r, other)
			sendTaskMessage(t, h, taskInbound(r, input))
			text := lastText(t, h)
			if !strings.Contains(text, r.ID) || strings.Contains(text, other.ID) || strings.Contains(text, other.ChatID) {
				t.Fatalf("group summary escaped task scope: %s", text)
			}
		})
	}

}

func TestUnboundUnmentionedGroupCannotForwardOrCreateTasks(t *testing.T) {
	for _, text := range []string{"继续执行", "/say " + testPane + " 执行", "新建任务：不应创建"} {
		t.Run(text, func(t *testing.T) {
			h := newHarness(t)
			_, store := attachTaskManager(t, h)
			a := idleAgent(testPane)
			h.reg.setAgents(a)
			h.selectAgent("oc_unrelated", a)
			m := inbound(text)
			m.ChatID, m.ChatType = "oc_unrelated", lark.ChatGroup
			sendTaskMessage(t, h, m)
			if len(h.ctrl.said()) != 0 || len(h.bot.sends()) != 0 || len(store.List()) != 0 {
				t.Fatal("an unmentioned message from an unrelated group reached task/agent handling")
			}
		})
	}
}

func TestTaskGroupIgnoresForeignReplyAndSelectionTargets(t *testing.T) {
	h := newHarness(t)
	first, other := taskBinding("first", "oc_first", testPane), taskBinding("other", "oc_other", secondPane)
	attachTaskManager(t, h, first, other)
	a, foreign := taskAgent(first), taskAgent(other)
	h.reg.setAgents(a, foreign)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true}, nil)
	h.routes.bindAbout("om_foreign_reply", foreign)
	h.selectAgent(first.ChatID, foreign)
	m := taskInbound(first, "只修改当前任务")
	m.ReplyToMessageID = "om_foreign_reply"
	sendTaskMessage(t, h, m)
	said := h.ctrl.said()
	if len(said) != 1 || said[0].Guard.PaneID != first.PaneID || said[0].Text != m.Text {
		t.Fatalf("task group escaped to the reply/selection target: %+v", said)
	}
	for _, text := range []string{"/say " + secondPane + " 不要投递", "/card " + secondPane, "/ls", "/task destroy " + other.ID} {
		h.ctrl.reset()
		m.Text, m.EventID = text, "attempt-"+text
		sendTaskMessage(t, h, m)
		if len(h.ctrl.said()) != 0 || len(h.ctrl.sentKeys()) != 0 {
			t.Fatalf("task group command escaped its binding: %s", text)
		}
	}
	current, _ := h.b.tasks.Get(other.ID)
	if current.Status != tasks.Running {
		t.Fatal("a task group destroyed a different task")
	}
}

func TestTaskGroupRefusesAReplacedAgent(t *testing.T) {
	for _, replacement := range []string{"kind", "workspace", "gone"} {
		t.Run(replacement, func(t *testing.T) {
			h := newHarness(t)
			r := taskBinding("owned", "oc_task", testPane)
			attachTaskManager(t, h, r)
			a := taskAgent(r)
			if replacement == "kind" {
				a.Kind = "codex"
			} else if replacement == "workspace" {
				a.WorkspaceID = "different-workspace"
			}
			if replacement != "gone" {
				h.reg.setAgents(a)
			}
			sendTaskMessage(t, h, taskInbound(r, "继续"))
			if len(h.ctrl.said()) != 0 {
				t.Fatal("task input was sent to an unavailable/replaced agent")
			}
			if len(h.bot.sends()) == 0 {
				t.Fatal("owner received no explanation for refusing task input")
			}
		})
	}
}

func TestTaskCardCannotControlAnotherTaskOrBypassOwnership(t *testing.T) {
	for _, scenario := range []string{"foreign pane", "different owner", "completed", "destroyed", "own card"} {
		t.Run(scenario, func(t *testing.T) {
			h := newHarness(t, func(d *Deps) { d.AllowedOpenIDs = []string{testOwner, testStranger} })
			r := taskBinding("owned", "oc_task", testPane)
			if scenario == "completed" {
				r.Status = tasks.Completed
			} else if scenario == "destroyed" {
				r.Status = tasks.Destroyed
			}
			attachTaskManager(t, h, r)
			a := taskAgent(r)
			a.Status, a.StateSeq = agents.StatusBlocked, 42
			if scenario == "foreign pane" {
				a.PaneID = secondPane
			}
			h.reg.setAgents(a)
			press := cardPress(t, a, "1")
			press.ChatID = r.ChatID
			if scenario == "different owner" {
				press.Operator = testStranger
			}
			pressed(t, h, press)
			if scenario == "own card" {
				if keys := h.ctrl.sentKeys(); len(keys) != 1 || keys[0].Guard.PaneID != r.PaneID {
					t.Fatalf("valid task approval failed: %+v", keys)
				}
			} else if len(h.ctrl.sentKeys()) != 0 || len(h.bot.cardUpdates()) != 0 || len(h.bot.sends()) != 0 {
				t.Fatal("isolated task card was acted on or disclosed information")
			}
		})
	}
}

func TestTaskNotificationsAndMirrorsStayInTheirTaskChats(t *testing.T) {
	h := newHarness(t)
	first, second := taskBinding("first", "oc_first", testPane), taskBinding("second", "oc_second", secondPane)
	_, store := attachTaskManager(t, h, first, second)
	a, b := taskAgent(first), taskAgent(second)
	h.reg.setAgents(a, b)
	ctx := context.Background()
	if err := h.b.PushBlocked(ctx, a, permissionDialog()); err != nil {
		t.Fatal(err)
	}
	if err := h.b.PushDone(ctx, b, screen.Screen{Lines: []string{"任务已处理，请验收"}, Cols: 100}); err != nil {
		t.Fatal(err)
	}
	sends := h.bot.sends()
	if len(sends) != 2 || sends[0].Out.ChatID != first.ChatID || sends[1].Out.ChatID != second.ChatID {
		t.Fatalf("notification destinations = %+v", sends)
	}
	firstState, _ := store.Get(first.ID)
	secondState, _ := store.Get(second.ID)
	if firstState.Status != tasks.Blocked || secondState.Status != tasks.Review || secondState.CompletedAt != "" {
		t.Fatalf("runtime completion must mean review, not panel completion: %+v / %+v", firstState, secondState)
	}
	streams := map[string]*mirrorStream{}
	defer h.b.closeAllMirrorStreams(ctx, streams)
	for _, r := range []tasks.Record{first, second} {
		h.b.mirrorTurn(ctx, streams, mirror.PaneTurn{PaneID: r.PaneID, Turn: mirror.Turn{Role: "assistant", Text: "进度 " + r.ID, At: epoch}})
	}
	opened := h.bot.openStreams()
	if len(opened) != 2 || opened[0].out.ChatID != first.ChatID || opened[1].out.ChatID != second.ChatID {
		t.Fatalf("mirror destinations = %+v", opened)
	}
	// Non-task panes retain the configured notification target.
	outside := idleAgent("w99:p99")
	if err := h.b.PushGone(ctx, outside); err != nil {
		t.Fatal(err)
	}
	last := h.bot.sends()[len(h.bot.sends())-1]
	if last.Out.ChatID != testChat {
		t.Fatalf("legacy notification target changed: %+v", last)
	}
}

func TestDisabledTasksKeepExistingAgentConversation(t *testing.T) {
	h := newHarness(t)
	a := idleAgent(testPane)
	h.reg.setAgents(a)
	h.selectAgent(testChat, a)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true}, nil)
	sendTaskMessage(t, h, inbound("继续修复登录"))
	if calls := h.ctrl.said(); len(calls) != 1 || calls[0].Guard.PaneID != testPane {
		t.Fatalf("existing selected-agent conversation changed: %+v", calls)
	}
	m := inbound("/tasks")
	m.EventID = "disabled-tasks"
	sendTaskMessage(t, h, m)
	if len(h.ctrl.said()) != 1 || !strings.Contains(strings.Join(h.bot.texts(), "\n"), "尚未启用") {
		t.Fatal("disabled task command should explain configuration, never become agent input")
	}
}
