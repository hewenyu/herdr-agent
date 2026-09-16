package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

// Only subscription is expected in these startup tests. Embedded interfaces
// make an unexpected provisioning call fail immediately instead of faking a
// successful remote side effect.
type taskServeBot struct {
	*fakeBot
	tasks.Platform
	taskMu     sync.Mutex
	message    func(context.Context, lark.Msg) error
	taskEvent  func(context.Context, tasks.TaskEvent) error
	replies    chan lark.Out
	subscribed chan struct{}
}

func (b *taskServeBot) OnMessage(h func(context.Context, lark.Msg) error) {
	b.taskMu.Lock()
	b.message = h
	b.taskMu.Unlock()
}

func (b *taskServeBot) OnTaskEvent(h func(context.Context, tasks.TaskEvent) error) {
	b.taskMu.Lock()
	b.taskEvent = h
	b.taskMu.Unlock()
}

func (b *taskServeBot) SubscribeTasks(context.Context) error {
	select {
	case b.subscribed <- struct{}{}:
	default:
	}
	return nil
}

func (b *taskServeBot) Send(_ context.Context, out lark.Out) (string, error) {
	b.replies <- out
	return "om_task_reply", nil
}

type taskServeClient struct {
	*herdrapi.RecordingClient
	herdrapi.LifecycleClient
}

func enableServeTasks(t *testing.T, h *harness) {
	t.Helper()
	project := t.TempDir()
	if err := os.Mkdir(filepath.Join(project, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	h.d.Cfg.Tasks = config.Tasks{Enabled: true, DefaultProject: "demo", PollInterval: time.Minute,
		Projects: map[string]config.Project{"demo": {Path: project, Agent: "claude"}}}
}

func taskBotForServe(p *serveParts) *taskServeBot {
	return &taskServeBot{fakeBot: p.bot, replies: make(chan lark.Out, 4), subscribed: make(chan struct{}, 1)}
}

func TestTaskServeRejectsMissingCapabilitiesBeforeConnecting(t *testing.T) {
	for _, missing := range []string{"platform", "lifecycle"} {
		t.Run(missing, func(t *testing.T) {
			h, hooks, p := newServeHarness(t)
			enableServeTasks(t, h)
			want := "bot does not support task management"
			if missing == "lifecycle" {
				bot := taskBotForServe(p)
				hooks.newBot = func(config.Config, *slog.Logger) (lark.Bot, error) { return bot, nil }
				want = "herdr client does not support managed task sessions"
			} else {
				h.d.Client = &taskServeClient{RecordingClient: h.rc}
			}
			s, err := buildServe(context.Background(), h.d, newServeLogger(&h.errb), hooks)
			if s != nil {
				_ = s.shutdown()
			}
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("missing %s: error = %v, want diagnostic %q", missing, err, want)
			}
			if p.bot.startCount() != 0 || p.lock.held() {
				t.Fatal("failed task startup connected a bot or leaked its singleton lock")
			}
		})
	}
}

func TestTaskServeActuallyWiresManagerEventsAndProjectCommands(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	enableServeTasks(t, h)
	h.d.Client = &taskServeClient{RecordingClient: h.rc}
	bot := taskBotForServe(p)
	hooks.newBot = func(cfg config.Config, _ *slog.Logger) (lark.Bot, error) {
		if !cfg.Tasks.Enabled {
			t.Error("task enablement was lost before constructing the bot")
		}
		return bot, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := buildForTest(t, ctx, h, hooks)
	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("task-enabled serve shutdown: %v", err)
			}
		case <-time.After(waitFor):
			t.Error("task-enabled serve did not stop")
		}
	})
	select {
	case <-bot.started:
	case <-time.After(waitFor):
		t.Fatal("bot never started")
	}
	select {
	case <-bot.subscribed:
	case <-time.After(waitFor):
		t.Fatal("task manager was not run or did not subscribe on the existing platform")
	}
	bot.taskMu.Lock()
	message, taskEvent := bot.message, bot.taskEvent
	bot.taskMu.Unlock()
	if message == nil || taskEvent == nil {
		t.Fatal("task-enabled bridge did not install both message and task event handlers")
	}
	if err := taskEvent(ctx, tasks.TaskEvent{GUID: "unrelated-task"}); err != nil {
		t.Fatalf("unrelated task event: %v", err)
	}
	if err := message(ctx, lark.Msg{EventID: "projects-event", MessageID: "projects-message",
		ChatID: h.d.Cfg.Feishu.NotifyChatID, ChatType: lark.ChatP2P,
		UserID: h.d.Cfg.Feishu.AllowedOpenIDs[0], Text: "/projects"}); err != nil {
		t.Fatal(err)
	}
	select {
	case out := <-bot.replies:
		if !strings.Contains(out.Text, "demo") || !strings.Contains(out.Text, "claude") || !strings.Contains(out.Text, h.d.Cfg.Tasks.Projects["demo"].Path) {
			t.Fatalf("task manager option was not behaviorally wired: %+v", out)
		}
		if out.ChatID != h.d.Cfg.Feishu.NotifyChatID {
			t.Fatalf("project reply went to the wrong chat: %+v", out)
		}
	case <-time.After(waitFor):
		t.Fatal("task-enabled /projects received no response")
	}
}

func TestTaskServeDisabledDoesNotRequireNewInterfaces(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	if h.d.Cfg.Tasks.Enabled {
		t.Fatal("task management must be opt-in")
	}
	s := buildForTest(t, context.Background(), h, hooks)
	if s == nil || p.bot.startCount() != 0 {
		t.Fatal("ordinary bridge failed to build without task/lifecycle capabilities")
	}
	if _, err := os.Stat(filepath.Join(h.d.StateDir, "tasks.json")); !os.IsNotExist(err) {
		t.Fatalf("disabled task management created state: %v", err)
	}
}

func TestTaskNotificationRouting(t *testing.T) {
	for _, tc := range []struct {
		name   string
		record tasks.Record
		want   string
	}{
		{"active group", tasks.Record{ChatID: "group", EntryChatID: "entry"}, "group"},
		{"before group creation", tasks.Record{EntryChatID: "entry"}, "entry"},
		{"deleted group", tasks.Record{ChatID: "group", EntryChatID: "entry", ChatDeleted: true}, "entry"},
		{"group without entry", tasks.Record{ChatID: "group"}, "group"},
		{"no surviving destination", tasks.Record{ChatID: "group", ChatDeleted: true}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := taskNotificationChat(tc.record); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestTaskGroupWelcomeAndClosingMessages(t *testing.T) {
	r := tasks.Record{Title: "修复动画", Project: "demo", Agent: "codex", URL: "https://example.test/task"}
	for _, part := range []string{r.Title, r.Project, r.URL, "无需 @", "验收通过", "保留群"} {
		if !strings.Contains(taskWelcomeMessage(r), part) {
			t.Errorf("welcome missing %q", part)
		}
	}
	if strings.Contains(taskClosingMessage(r), "已确认飞书任务完成") {
		t.Fatal("destroy without acceptance claimed task completion")
	}
	r.CloseRequested = true
	for _, part := range []string{"已确认飞书任务完成", "代码保留", "群聊天记录不会保留", r.URL} {
		if !strings.Contains(taskClosingMessage(r), part) {
			t.Errorf("close notice missing %q", part)
		}
	}
}

type announcementBot struct {
	lark.Bot
	failChat string
	chats    []string
}

func (b *announcementBot) Send(_ context.Context, out lark.Out) (string, error) {
	b.chats = append(b.chats, out.ChatID)
	if out.ChatID == b.failChat {
		return "", errors.New("chat unavailable")
	}
	return "message", nil
}

func TestTaskGroupAnnouncementDoesNotStallOnEntryFailure(t *testing.T) {
	r := tasks.Record{ChatID: "group", EntryChatID: "entry", Project: "demo"}
	bot := &announcementBot{failChat: r.EntryChatID}
	if err := announceTaskGroup(context.Background(), bot, slog.Default(), r); err != nil {
		t.Fatalf("entry receipt blocked an already announced task: %v", err)
	}
	if strings.Join(bot.chats, ",") != "group,entry" {
		t.Fatalf("announcement destinations = %v", bot.chats)
	}
	bot = &announcementBot{failChat: r.ChatID}
	if err := announceTaskGroup(context.Background(), bot, slog.Default(), r); err == nil || len(bot.chats) != 1 {
		t.Fatal("failed group welcome was not reported")
	}
}
