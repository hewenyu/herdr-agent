package tasks

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

type taskTestLog struct {
	mu    sync.Mutex
	calls []string
}

func (l *taskTestLog) add(call string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, call)
}
func (l *taskTestLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.calls...)
}

type taskTestUpdate struct {
	guid, description string
	completedAt       *string
}

type taskTestPlatform struct {
	mu               sync.Mutex
	log              *taskTestLog
	tasks            map[string]RemoteTask
	created          []TaskSpec
	chats            []ChatSpec
	deleted          []string
	updates          []taskTestUpdate
	reads            []string
	updateErr        error
	createErr        error
	getErr           error
	ignoreCompletion bool
}

func (p *taskTestPlatform) CreateTask(_ context.Context, spec TaskSpec) (RemoteTask, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.log.add("create-task")
	p.created = append(p.created, spec)
	if p.createErr != nil {
		return RemoteTask{}, p.createErr
	}
	id := fmt.Sprintf("guid-%d", len(p.created))
	r := RemoteTask{GUID: id, URL: "https://example.test/task/" + id, Description: spec.Description}
	p.tasks[id] = r
	return r, nil
}
func (p *taskTestPlatform) GetTask(_ context.Context, id string) (RemoteTask, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reads = append(p.reads, id)
	if p.getErr != nil {
		return RemoteTask{}, p.getErr
	}
	r, ok := p.tasks[id]
	if !ok {
		return RemoteTask{}, fmt.Errorf("task %s missing", id)
	}
	return r, nil
}
func (p *taskTestPlatform) UpdateTask(_ context.Context, guid, desc string, completedAt *string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.log.add("update-task")
	if p.updateErr != nil {
		return p.updateErr
	}
	r, ok := p.tasks[guid]
	if !ok {
		return fmt.Errorf("task %s missing", guid)
	}
	var value *string
	if completedAt != nil {
		copy := *completedAt
		value = &copy
		if !p.ignoreCompletion {
			r.CompletedAt = copy
		}
	}
	r.Description = desc
	p.tasks[guid] = r
	p.updates = append(p.updates, taskTestUpdate{guid: guid, description: desc, completedAt: value})
	return nil
}
func (p *taskTestPlatform) CreateTaskChat(_ context.Context, spec ChatSpec) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.log.add("create-chat")
	p.chats = append(p.chats, spec)
	return fmt.Sprintf("oc_%d", len(p.chats)), nil
}
func (p *taskTestPlatform) DeleteTaskChat(_ context.Context, id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.log.add("delete-chat")
	p.deleted = append(p.deleted, id)
	return nil
}
func (p *taskTestPlatform) SubscribeTasks(context.Context) error { return nil }
func (p *taskTestPlatform) setCompletion(guid, completion string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	r := p.tasks[guid]
	r.CompletedAt = completion
	p.tasks[guid] = r
}

type taskTestLifecycle struct {
	mu               sync.Mutex
	log              *taskTestLog
	workspaces       []herdrapi.WorkspaceInfo
	agents           map[string]herdrapi.AgentInfo
	starts           []string
	closed           []string
	startupStatus    string
	startupErr       error
	workspaceCreated func()
}

func (l *taskTestLifecycle) WorkspaceCreate(_ context.Context, cwd, label string) (herdrapi.WorkspaceInfo, error) {
	l.mu.Lock()
	l.log.add("create-workspace")
	n := len(l.workspaces) + 1
	w := herdrapi.WorkspaceInfo{ID: fmt.Sprintf("w%d", n), PaneID: fmt.Sprintf("w%d:p1", n), Cwd: cwd, Label: label}
	l.workspaces = append(l.workspaces, w)
	l.agents[w.PaneID] = herdrapi.AgentInfo{PaneID: w.PaneID, WorkspaceID: w.ID, Cwd: &cwd, TerminalID: fmt.Sprintf("terminal-%d", n)}
	l.mu.Unlock()
	if l.workspaceCreated != nil {
		l.workspaceCreated()
	}
	return w, nil
}
func (l *taskTestLifecycle) WorkspaceList(context.Context) ([]herdrapi.WorkspaceInfo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]herdrapi.WorkspaceInfo(nil), l.workspaces...), nil
}
func (l *taskTestLifecycle) AgentStart(_ context.Context, pane, kind, name string) (herdrapi.AgentInfo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.log.add("start-agent")
	l.starts = append(l.starts, pane)
	if l.startupErr != nil {
		return herdrapi.AgentInfo{}, l.startupErr
	}
	a := l.agents[pane]
	a.Agent, a.Name = &kind, &name
	a.AgentStatus = l.startupStatus
	if a.AgentStatus == "" {
		a.AgentStatus = "idle"
	}
	a.InteractiveReady = a.AgentStatus != "blocked"
	a.LaunchPending = a.AgentStatus == "blocked"
	a.StateChangeSeq = 1
	a.AgentSession = &herdrapi.SessionRef{Agent: kind, Kind: "id", Value: "session-" + pane}
	l.agents[pane] = a
	return a, nil
}
func (l *taskTestLifecycle) PaneClose(_ context.Context, pane string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.log.add("close-pane")
	l.closed = append(l.closed, pane)
	delete(l.agents, pane)
	return nil
}
func (l *taskTestLifecycle) agent(pane string) (herdrapi.AgentInfo, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a, ok := l.agents[pane]
	if !ok {
		return herdrapi.AgentInfo{}, &herdrapi.APIError{Code: herdrapi.CodeNotFound, Message: "pane missing"}
	}
	return a, nil
}
func (l *taskTestLifecycle) setAgent(pane string, change func(*herdrapi.AgentInfo)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	a := l.agents[pane]
	change(&a)
	l.agents[pane] = a
}

type taskTestSay struct {
	guard agents.Guard
	text  string
}
type taskTestController struct {
	mu       sync.Mutex
	log      *taskTestLog
	says     []taskTestSay
	delivery agents.Delivery
	sayErr   error
}

func (c *taskTestController) Say(_ context.Context, guard agents.Guard, text string) (agents.Delivery, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.log.add("say")
	c.says = append(c.says, taskTestSay{guard, text})
	return c.delivery, c.sayErr
}
func (*taskTestController) SendKey(context.Context, agents.Guard, string) (agents.Agent, error) {
	return agents.Agent{}, errors.New("task startup must not answer approval prompts")
}
func (*taskTestController) Interrupt(context.Context, agents.Guard) (agents.Agent, error) {
	return agents.Agent{}, errors.New("task startup must not dismiss approval prompts")
}

type taskTestRegistry struct{}

func (taskTestRegistry) Run(context.Context) error           { return nil }
func (taskTestRegistry) Snapshot() []agents.Agent            { return nil }
func (taskTestRegistry) Get(string) (agents.Agent, bool)     { return agents.Agent{}, false }
func (taskTestRegistry) Subscribe() <-chan agents.Transition { return nil }
func (taskTestRegistry) Degraded() bool                      { return false }

type taskTestHarness struct {
	manager    *Manager
	store      *Store
	path       string
	platform   *taskTestPlatform
	lifecycle  *taskTestLifecycle
	controller *taskTestController
	log        *taskTestLog
}

func newTaskTestHarness(t *testing.T, kind string) *taskTestHarness {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tasks.json")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	log := &taskTestLog{}
	p := &taskTestPlatform{log: log, tasks: map[string]RemoteTask{}}
	l := &taskTestLifecycle{log: log, agents: map[string]herdrapi.AgentInfo{}}
	c := &taskTestController{log: log, delivery: agents.Delivery{Acked: true, Verified: true}}
	client := &herdrapi.RecordingClient{
		OnAgentGet: func(_ context.Context, pane string) (herdrapi.AgentInfo, error) { return l.agent(pane) },
		OnPaneGet: func(_ context.Context, pane string) (herdrapi.PaneInfo, error) {
			a, err := l.agent(pane)
			return herdrapi.PaneInfo{PaneID: a.PaneID, WorkspaceID: a.WorkspaceID}, err
		},
	}
	m, err := New(store, Options{
		Config:   config.Tasks{Enabled: true, DefaultProject: "repo", PollInterval: time.Hour, Projects: map[string]config.Project{"repo": {Path: "/configured/repo", Agent: kind}}},
		Platform: p, Client: client, Lifecycle: l, Controller: c, Registry: taskTestRegistry{},
		Announce: func(_ context.Context, r Record) error { log.add("announce"); return nil },
		Follow:   func(string) error { log.add("follow"); return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &taskTestHarness{m, store, path, p, l, c, log}
}

func (h *taskTestHarness) create(t *testing.T, message string) Record {
	t.Helper()
	r, err := h.manager.Create("ou_owner", "oc_entry", message, "", "", "修复登录错误并验证")
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func (h *taskTestHarness) reconcile(t *testing.T, id string, count int) Record {
	t.Helper()
	for i := 0; i < count; i++ {
		if err := h.manager.reconcile(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	r, ok := h.store.Get(id)
	if !ok {
		t.Fatal("record disappeared")
	}
	return r
}
func (h *taskTestHarness) restart(t *testing.T) {
	t.Helper()
	store, err := Open(h.path)
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(store, h.manager.opts)
	if err != nil {
		t.Fatal(err)
	}
	h.store, h.manager = store, m
}

func TestManagerRetriesRejectedAgentStartWithoutDuplicatingResources(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	h.lifecycle.startupErr = &herdrapi.APIError{Code: herdrapi.CodeAgentPaneBusy, Message: "shell initializing"}
	r := h.create(t, "busy-shell")
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("busy shell should report an interrupted startup")
	}
	r, _ = h.manager.Get(r.ID)
	if r.Pending != "" || r.Error == "" || r.Started {
		t.Fatalf("explicit launch refusal became ambiguous: %+v", r)
	}
	h.lifecycle.startupErr = nil
	if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 2)
	if !r.PromptSent || len(h.platform.created) != 1 || len(h.platform.chats) != 1 || len(h.lifecycle.workspaces) != 1 || len(h.controller.says) != 1 {
		t.Fatalf("retry must reuse resources and send the task once: record=%+v calls=%v", r, h.log.snapshot())
	}
}

func TestManagerDoesNotReplayAmbiguousAgentStart(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	h.lifecycle.startupErr = context.DeadlineExceeded
	r := h.create(t, "unknown-start")
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("expected startup timeout")
	}
	if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err == nil {
		t.Fatal("timeout cannot authorize another agent launch")
	}
	if len(h.lifecycle.starts) != 1 || len(h.controller.says) != 0 {
		t.Fatalf("unconfirmed start was replayed: %v", h.log.snapshot())
	}
}

func TestManagerCreatesTaskChatWorkspaceAndEitherAgentOnce(t *testing.T) {
	for _, kind := range []string{"codex", "claude"} {
		t.Run(kind, func(t *testing.T) {
			h := newTaskTestHarness(t, kind)
			r := h.create(t, "message-1")
			duplicate, err := h.manager.Create("ou_owner", "oc_entry", "message-1", "repo", kind, "duplicate must not replace original")
			if err != nil || duplicate.ID != r.ID || duplicate.Title != r.Title {
				t.Fatalf("duplicate = %+v, %v", duplicate, err)
			}
			r = h.reconcile(t, r.ID, 1)
			if r.Status != Running || !r.Started || !r.PromptSent || r.Pending != "" || r.GUID == "" || r.ChatID == "" || r.WorkspaceID == "" || r.PaneID == "" || r.SessionID == "" {
				t.Fatalf("creation did not yield a tracked running task: %+v", r)
			}
			if h.platform.created[0].OwnerID != "ou_owner" || h.platform.chats[0].OwnerID != "ou_owner" || h.platform.created[0].Key != r.ID || h.platform.chats[0].Key != r.ID {
				t.Fatal("owner or idempotency key lost across Feishu resources")
			}
			if h.lifecycle.workspaces[0].Cwd != "/configured/repo" || h.lifecycle.workspaces[0].Label != r.ID {
				t.Fatalf("workspace not bound to configured project: %+v", h.lifecycle.workspaces)
			}
			if say := h.controller.says[0]; !strings.Contains(say.text, r.Title) || !strings.Contains(say.text, r.Path) || say.guard.PaneID != r.PaneID || say.guard.Kind != kind || say.guard.StateSeq != 1 || !say.guard.RequireUnblocked {
				t.Fatalf("initial task bypassed guarded delivery: %+v", say)
			}
			h.reconcile(t, r.ID, 2)
			if len(h.platform.created) != 1 || len(h.platform.chats) != 1 || len(h.lifecycle.workspaces) != 1 || len(h.lifecycle.starts) != 1 || len(h.controller.says) != 1 {
				t.Fatalf("reconcile repeated resource creation or initial prompt: %v", h.log.snapshot())
			}
		})
	}
}

func TestManagerOwnerIsolation(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	one := h.create(t, "same-message")
	two, err := h.manager.Create("ou_other", "oc_other", "same-message", "repo", "claude", "另一个人的任务")
	if err != nil || one.ID == two.ID {
		t.Fatalf("owners share a task: %+v, %v", two, err)
	}
	if got := h.manager.List("ou_owner", true); len(got) != 1 || got[0].ID != one.ID {
		t.Fatalf("owner list leaked another owner's task: %+v", got)
	}
	for _, action := range []string{"close", "complete", "reopen", "retry", "destroy"} {
		if _, err := h.manager.Request("ou_other", one.ID, action); err == nil {
			t.Errorf("foreign owner could %s task", action)
		}
	}
	after, _ := h.store.Get(one.ID)
	if !reflect.DeepEqual(after, one) {
		t.Fatalf("unauthorized requests mutated task: %+v", after)
	}
	if got := h.manager.List("ou_unknown", true); len(got) != 0 {
		t.Fatalf("unknown owner sees tasks: %+v", got)
	}
}

func TestManagerWaitsForStartupApprovalBeforeInitialPrompt(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	h.lifecycle.startupStatus = "blocked"
	r := h.create(t, "blocked-start")
	r = h.reconcile(t, r.ID, 2)
	if r.Status != Blocked || r.PromptSent || len(h.controller.says) != 0 {
		t.Fatalf("startup approval was bypassed: %+v, calls %v", r, h.log.snapshot())
	}
	remote, _ := h.platform.GetTask(context.Background(), r.GUID)
	if !strings.Contains(remote.Description, Blocked.Label()) || !strings.Contains(remote.Description, "尚未发送") {
		t.Fatalf("Feishu task cannot explain startup blocker: %s", remote.Description)
	}
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) {
		a.AgentStatus = "idle"
		a.InteractiveReady = true
		a.LaunchPending = false
		a.StateChangeSeq++
	})
	r = h.reconcile(t, r.ID, 1)
	if !r.PromptSent || r.Status != Running || len(h.controller.says) != 1 {
		t.Fatalf("approved startup did not deliver held task once: %+v", r)
	}
}

func TestManagerPublishesProgressAndDoesNotAutoCompleteDone(t *testing.T) {
	h := newTaskTestHarness(t, "claude")
	r := h.reconcile(t, h.create(t, "progress").ID, 1)
	progress, result := "正在验证登录重试逻辑", "已修复过期令牌处理，8 项回归测试通过"
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "working"; a.TerminalTitleStripped = &progress })
	if err := h.manager.Observe(r.PaneID, Running, progress, result); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	remote, _ := h.platform.GetTask(context.Background(), r.GUID)
	for _, want := range []string{Running.Label(), progress, result, r.Project, r.Title} {
		if !strings.Contains(remote.Description, want) {
			t.Errorf("AI-readable task state lacks %q: %s", want, remote.Description)
		}
	}
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "done" })
	r = h.reconcile(t, r.ID, 2)
	remote, _ = h.platform.GetTask(context.Background(), r.GUID)
	if r.Status != Review || (remote.CompletedAt != "" && remote.CompletedAt != "0") || !strings.Contains(remote.Description, Review.Label()) {
		t.Fatalf("a completed agent turn was treated as accepted task: %+v / %+v", r, remote)
	}
	for _, update := range h.platform.updates {
		if update.completedAt != nil && *update.completedAt != "0" {
			t.Fatal("agent done wrote a completion timestamp without user acceptance")
		}
	}
}

func TestManagerAcceptsRemoteCompletionAndReopen(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "complete-reopen").ID, 1)
	h.platform.setCompletion(r.GUID, "1726500000000")
	if err := h.manager.Event(context.Background(), TaskEvent{GUID: r.GUID}); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Completed || r.CompletedAt != "1726500000000" || len(h.manager.List(r.OwnerID, false)) != 0 {
		t.Fatalf("panel completion not reflected locally: %+v", r)
	}
	if err := h.manager.Observe(r.PaneID, Running, "late status update", ""); err != nil {
		t.Fatal(err)
	}
	still, _ := h.store.Get(r.ID)
	if still.Status != Completed {
		t.Fatal("late agent status reopened a task accepted by its owner")
	}
	h.platform.setCompletion(r.GUID, "0")
	if err := h.manager.Event(context.Background(), TaskEvent{GUID: r.GUID}); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Review || r.CompletedAt != "" || len(h.manager.List(r.OwnerID, false)) != 1 || len(h.controller.says) != 1 {
		t.Fatalf("panel reopen did not preserve session for continued conversation: %+v", r)
	}
}

func TestManagerFailedCompletionRemainsActiveUntilFeishuAcknowledges(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "completion-update-failure").ID, 1)
	h.platform.updateErr = errors.New("Feishu temporarily unavailable")
	if _, err := h.manager.Request(r.OwnerID, r.ID, "complete"); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("failed completion update reported success")
	}
	r, _ = h.store.Get(r.ID)
	active := h.manager.List(r.OwnerID, false)
	if r.Status == Completed || r.CompletedAt != "" || r.CompletionRequest != "complete" || r.SyncError == "" || len(active) != 1 || active[0].ID != r.ID {
		t.Fatalf("failed Feishu completion disappeared from active task list: %+v / %+v", r, active)
	}
	if summary := Summary(active); strings.Contains(summary, Completed.Label()) {
		t.Fatalf("failed completion was presented to the user as complete: %s", summary)
	}
	remote, err := h.platform.GetTask(context.Background(), r.GUID)
	if err != nil || (remote.CompletedAt != "" && remote.CompletedAt != "0") {
		t.Fatalf("failed patch changed remote completion: %+v, %v", remote, err)
	}
	h.platform.updateErr = nil
	r = h.reconcile(t, r.ID, 1)
	remote, err = h.platform.GetTask(context.Background(), r.GUID)
	if err != nil || r.Status != Completed || r.CompletionRequest != "" || r.SyncError != "" || remote.CompletedAt == "" || remote.CompletedAt == "0" || r.CompletedAt != remote.CompletedAt || len(h.manager.List(r.OwnerID, false)) != 0 {
		t.Fatalf("completion retry did not converge after successful patch: %+v / %+v, %v", r, remote, err)
	}
}

func TestManagerRefusesCompletionActionsBeforeRemoteTaskExists(t *testing.T) {
	for _, action := range []string{"close", "complete", "reopen"} {
		t.Run(action, func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			r := h.create(t, "before-guid-"+action)
			if _, err := h.manager.Request(r.OwnerID, r.ID, action); err == nil {
				t.Fatalf("%s accepted before task exists remotely", action)
			}
			after, _ := h.store.Get(r.ID)
			if after.CompletionRequest != "" || after.Status != Queued {
				t.Fatalf("rejected action left a request that blocks provisioning: %+v", after)
			}
			after = h.reconcile(t, r.ID, 1)
			if after.Status != Running || !after.PromptSent || after.GUID == "" {
				t.Fatalf("rejected premature action left task stuck: %+v", after)
			}
		})
	}
}

func TestManagerDestroyPreservesTaskAndPublishesResultBeforeDeletingChat(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "destroy").ID, 1)
	if err := h.manager.Observe(r.PaneID, Review, "等待验收", "最终交付：修复与测试均完成"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.manager.Request(r.OwnerID, r.ID, "destroy"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Destroyed || !r.PaneClosed || !r.ChatDeleted || len(h.lifecycle.closed) != 1 || h.lifecycle.closed[0] != r.PaneID || len(h.platform.deleted) != 1 || h.platform.deleted[0] != r.ChatID {
		t.Fatalf("destroyed wrong or incomplete resources: %+v", r)
	}
	remote, err := h.platform.GetTask(context.Background(), r.GUID)
	if err != nil || !strings.Contains(remote.Description, "最终交付") || !strings.Contains(remote.Description, Destroyed.Label()) || strings.Contains(remote.Description, ChatURL(r.ChatID)) {
		t.Fatalf("destroy lost durable task/result or left stale chat: %+v, %v", remote, err)
	}
	if remote.CompletedAt != "" && remote.CompletedAt != "0" {
		t.Fatal("destroy silently marked an unaccepted task complete")
	}
	log := h.log.snapshot()
	resultSaved := false
	for _, call := range log {
		if call == "update-task" {
			resultSaved = true
		}
		if (call == "delete-chat" || call == "close-pane") && !resultSaved {
			t.Fatalf("session erased before durable task summary was saved: %v", log)
		}
	}
	h.reconcile(t, r.ID, 1)
	if len(h.lifecycle.closed) != 1 || len(h.platform.deleted) != 1 {
		t.Fatal("destroy reconciliation repeated completed teardown")
	}
}

func TestManagerDestroyRefusesPaneMovedToDifferentWorkspace(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "foreign-pane").ID, 1)
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.WorkspaceID = "someone-elses-workspace" })
	if _, err := h.manager.Request(r.OwnerID, r.ID, "destroy"); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("foreign workspace was accepted for teardown")
	}
	if len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 0 {
		t.Fatal("ownership check happened after destructive effects")
	}
}

func TestManagerDestroyRecoversAlreadyClosedPaneUsingActualHerdrError(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "already-closed").ID, 1)
	// herdr's pane.get and pane.close return pane_not_found, whereas agent
	// lookup also has the more general not_found code. This is the observable
	// state after a successful close whose local checkpoint was lost.
	h.manager.opts.Client.(*herdrapi.RecordingClient).OnPaneGet = func(context.Context, string) (herdrapi.PaneInfo, error) {
		return herdrapi.PaneInfo{}, &herdrapi.APIError{Code: "pane_not_found", Message: "pane already gone"}
	}
	if _, err := h.manager.Request(r.OwnerID, r.ID, "destroy"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Destroyed || !r.PaneClosed || len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 1 {
		t.Fatalf("already closed pane blocked resumable teardown: %+v", r)
	}
}

func TestManagerDestroyKeepsChatUntilFinalSummaryCanBeSaved(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "summary-failure").ID, 1)
	if err := h.manager.Observe(r.PaneID, Review, "待验收", "完整交付摘要"); err != nil {
		t.Fatal(err)
	}
	h.platform.updateErr = errors.New("temporary task update failure")
	if _, err := h.manager.Request(r.OwnerID, r.ID, "destroy"); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("failure to persist final summary was hidden")
	}
	r, _ = h.store.Get(r.ID)
	if r.Status != Destroying || r.PaneClosed || r.SyncError == "" || r.ChatDeleted || len(h.platform.deleted) != 0 || len(h.lifecycle.closed) != 0 {
		t.Fatalf("chat/result lost before summary was saved: %+v", r)
	}
	h.platform.updateErr = nil
	h.restart(t)
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Destroyed || len(h.lifecycle.closed) != 1 || len(h.platform.deleted) != 1 {
		t.Fatalf("teardown did not resume from persisted close checkpoint: %+v", r)
	}
	remote, err := h.platform.GetTask(context.Background(), r.GUID)
	if err != nil || !strings.Contains(remote.Description, "完整交付摘要") {
		t.Fatalf("recovered teardown lost result: %+v, %v", remote, err)
	}
}

func TestManagerRestartKeepsBindingsAndNeverResendsInitialTask(t *testing.T) {
	h := newTaskTestHarness(t, "claude")
	r := h.reconcile(t, h.create(t, "restart").ID, 1)
	h.restart(t)
	after := h.reconcile(t, r.ID, 2)
	if after.GUID != r.GUID || after.ChatID != r.ChatID || after.PaneID != r.PaneID || after.SessionID != r.SessionID || !after.PromptSent {
		t.Fatalf("restart lost session/task binding: %+v -> %+v", r, after)
	}
	if len(h.platform.created) != 1 || len(h.lifecycle.starts) != 1 || len(h.controller.says) != 1 {
		t.Fatalf("restart replayed a side effect: %v", h.log.snapshot())
	}
}

func TestManagerDoesNotReplayPersistedPendingSideEffects(t *testing.T) {
	for _, pending := range []string{"task", "chat", "workspace", "agent", "prompt"} {
		t.Run(pending, func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			r := h.create(t, "pending-"+pending)
			if _, err := h.store.Update(r.ID, func(r *Record) error { r.Pending = pending; r.Status = Starting; return nil }); err != nil {
				t.Fatal(err)
			}
			h.restart(t)
			r = h.reconcile(t, r.ID, 2)
			if r.Pending != pending || r.Status != Attention || r.Error == "" || len(h.log.snapshot()) != 0 {
				t.Fatalf("ambiguous side effect was replayed: %+v, calls %v", r, h.log.snapshot())
			}
			if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err == nil {
				t.Fatal("blind retry would duplicate an operation whose result is unknown")
			}
		})
	}
}

func TestManagerAmbiguousCreateFailureIsNotReplayedAfterRestart(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	h.platform.createErr = errors.New("connection reset after request accepted")
	r := h.create(t, "ambiguous-create")
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("ambiguous creation failure reported success")
	}
	h.platform.createErr = nil
	h.restart(t)
	r = h.reconcile(t, r.ID, 2)
	if r.Status != Attention || r.Pending != "task" || r.Error == "" || len(h.platform.created) != 1 || len(h.lifecycle.workspaces) != 0 {
		t.Fatalf("retry after connection loss duplicated task creation: %+v, calls %v", r, h.log.snapshot())
	}
}

func TestManagerUnverifiedPromptStaysAmbiguousAcrossRestart(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	h.controller.delivery = agents.Delivery{Acked: true, Verified: false}
	r := h.create(t, "unverified")
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("unverified initial prompt reported success")
	}
	h.restart(t)
	r = h.reconcile(t, r.ID, 1)
	if r.Pending != "prompt" || r.PromptSent || r.Status != Attention || len(h.controller.says) != 1 {
		t.Fatalf("unconfirmed delivery was silently accepted or resent: %+v", r)
	}
}

func TestManagerDestroyRequestSurvivesInflightWorkspaceCreation(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	entered, release := make(chan struct{}), make(chan struct{})
	h.lifecycle.workspaceCreated = func() { close(entered); <-release }
	r := h.create(t, "destroy-during-start")
	reconciled := make(chan error, 1)
	go func() { reconciled <- h.manager.reconcile(context.Background(), r.ID) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("provisioning did not reach workspace creation")
	}
	requested := make(chan error, 1)
	go func() { _, err := h.manager.Request(r.OwnerID, r.ID, "destroy"); requested <- err }()
	requestAppliedBeforeRelease := false
	select {
	case err := <-requested:
		if err != nil {
			close(release)
			t.Fatal(err)
		}
		requestAppliedBeforeRelease = true
	case <-time.After(50 * time.Millisecond):
		// A manager may serialize the request behind provisioning. Both designs
		// must retain the owner's destroy intent once the request succeeds.
	}
	close(release)
	select {
	case err := <-reconciled:
		if err != nil {
			// Pausing provisioning on the concurrent lifecycle change may be
			// reported as an error. The durable state and effects below decide
			// whether the owner's request was actually respected.
			t.Logf("provisioning interrupted: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("provisioning stuck after its external call returned")
	}
	if !requestAppliedBeforeRelease {
		select {
		case err := <-requested:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("destroy request never completed")
		}
	}
	after, _ := h.store.Get(r.ID)
	if after.Status != Destroying && after.Status != Destroyed {
		t.Fatalf("successful destroy request overwritten by provisioning: %+v", after)
	}
	if requestAppliedBeforeRelease && len(h.lifecycle.starts) != 0 {
		t.Fatal("agent started after the owner's destroy request had been applied")
	}
	after = h.reconcile(t, r.ID, 1)
	if after.Status != Destroyed || len(h.lifecycle.closed) != 1 {
		t.Fatalf("inflight-created workspace escaped requested cleanup: %+v", after)
	}
}

func TestManagerDestroyPreservesUnknownCreationDiagnostics(t *testing.T) {
	for _, pending := range []string{"task", "chat", "workspace"} {
		t.Run(pending, func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			r := h.create(t, "destroy-unknown-"+pending)
			// Reconstruct only resources whose IDs were durably confirmed before
			// a create response was lost. The unknown resource must not be guessed.
			if pending != "task" {
				remote, err := h.platform.CreateTask(context.Background(), TaskSpec{Title: r.Title, OwnerID: r.OwnerID, Key: r.ID})
				if err != nil {
					t.Fatal(err)
				}
				r.GUID, r.URL = remote.GUID, remote.URL
			}
			if pending == "workspace" {
				chat, err := h.platform.CreateTaskChat(context.Background(), ChatSpec{OwnerID: r.OwnerID, Key: r.ID})
				if err != nil {
					t.Fatal(err)
				}
				r.ChatID = chat
			}
			r.Pending, r.Status, r.Error = pending, Attention, "创建请求结果未确认"
			if _, err := h.store.Update(r.ID, func(stored *Record) error { *stored = r; return nil }); err != nil {
				t.Fatal(err)
			}
			h.restart(t)
			if _, err := h.manager.Request(r.OwnerID, r.ID, "destroy"); err != nil {
				t.Fatal(err)
			}
			r = h.reconcile(t, r.ID, 1)
			if r.Pending != pending || r.Error == "" || !strings.Contains(r.Error, pending) || len(h.lifecycle.closed) != 0 || len(h.lifecycle.workspaces) != 0 {
				t.Fatalf("destroy hid or guessed an unconfirmed resource: %+v", r)
			}
			for label, text := range map[string]string{"description": Description(r), "notice": Notice(r)} {
				if !strings.Contains(text, "核对") || !strings.Contains(text, "未确认") || !strings.Contains(text, "已绑定资源") {
					t.Errorf("%s does not distinguish cleaned bindings from unknown resources: %s", label, text)
				}
				if strings.Contains(text, "执行窗口和临时群已关闭") || strings.Contains(text, "全部销毁") {
					t.Errorf("%s claims full destruction despite unknown creation: %s", label, text)
				}
			}
			h.restart(t)
			active := h.manager.List(r.OwnerID, false)
			if len(active) != 1 || active[0].ID != r.ID || active[0].Pending != pending || active[0].Error == "" {
				t.Fatalf("restart hid the record still requiring manual verification: %+v", active)
			}
		})
	}
}

func TestManagerRepeatedObservationDoesNotWakeReconciler(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "stable-observation").ID, 1)
	drain := func() {
		for {
			select {
			case <-h.manager.wake:
			default:
				return
			}
		}
	}
	drain()
	if err := h.manager.Observe(r.PaneID, r.Status, r.Detail, r.Result); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.manager.wake:
		t.Fatal("unchanged observation woke the reconciler and can create a busy loop")
	default:
	}
	if err := h.manager.Observe(r.PaneID, r.Status, "新进展：登录测试通过", ""); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.manager.wake:
	default:
		t.Fatal("a changed progress update did not wake the reconciler")
	}
	drain()
	if err := h.manager.Observe(r.PaneID, r.Status, "新进展：登录测试通过", ""); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.manager.wake:
		t.Fatal("the same new progress woke the reconciler a second time")
	default:
	}
}

func TestManagerRunSkipsPersistedOwnersRemovedFromAllowlist(t *testing.T) {
	for _, status := range []Status{Queued, Running, Destroying} {
		t.Run(string(status), func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			r := h.create(t, "revoked-owner-"+string(status))
			if _, err := h.store.Update(r.ID, func(r *Record) error {
				r.Status = status
				if status != Queued {
					r.GUID, r.ChatID, r.WorkspaceID, r.PaneID = "existing-task", "existing-chat", "w1", "w1:p1"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			checked := make(chan string, 8)
			h.manager.opts.AllowedOwner = func(owner string) bool {
				select {
				case checked <- owner:
				default:
				}
				return false
			}
			h.restart(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stopped := make(chan error, 1)
			go func() { stopped <- h.manager.Run(ctx) }()
			for i := 0; i < 2; i++ {
				if i > 0 {
					h.manager.Wake()
				}
				select {
				case owner := <-checked:
					if owner != r.OwnerID {
						t.Errorf("checked unrelated owner %q", owner)
					}
				case <-time.After(2 * time.Second):
					cancel()
					t.Fatal("Run did not check the persisted owner's current authorization")
				}
			}
			cancel()
			select {
			case err := <-stopped:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("Run did not stop")
			}
			if calls := h.log.snapshot(); len(calls) != 0 {
				t.Fatalf("revoked owner triggered task/lifecycle effects: %v", calls)
			}
			if calls := h.manager.opts.Client.(*herdrapi.RecordingClient).Calls(); len(calls) != 0 {
				t.Fatalf("revoked owner triggered herdr calls: %+v", calls)
			}
			if len(h.platform.reads) != 0 {
				t.Fatalf("revoked owner triggered Feishu task reads: %v", h.platform.reads)
			}
		})
	}
}
