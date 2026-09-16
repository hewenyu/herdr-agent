package tasktools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

type fakeManager struct {
	mu                sync.Mutex
	records           map[string]tasks.Record
	creates, requests int
	allowed           bool
}

func (m *fakeManager) OwnerAllowed(owner string) bool {
	return m.allowed && (owner == "alice" || owner == "bob")
}
func (m *fakeManager) Get(id string) (tasks.Record, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.records[id]
	return r, ok
}
func (m *fakeManager) List(owner string, _ bool) []tasks.Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	var rs []tasks.Record
	for _, r := range m.records {
		if r.OwnerID == owner {
			rs = append(rs, r)
		}
	}
	return rs
}
func (m *fakeManager) Create(owner, entry, key, project, kind, title string) (tasks.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.creates++
	r := tasks.Record{ID: fmt.Sprintf("task%d", m.creates), OwnerID: owner, EntryChatID: entry, Title: title, Project: project, Agent: kind, Status: tasks.Queued}
	m.records[r.ID] = r
	return r, nil
}
func (m *fakeManager) Request(owner, id, action string) (tasks.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests++
	r := m.records[id]
	r.CompletionRequest = action
	if action == "destroy" {
		r.Status = tasks.Destroying
	}
	m.records[id] = r
	return r, nil
}
func (m *fakeManager) AcceptInput(_ string, _ bool) error { return nil }

type fakeRegistry struct{ agent agents.Agent }

func (r *fakeRegistry) Get(string) (agents.Agent, bool) { return r.agent, true }

type fakeController struct {
	count int
	err   error
	d     agents.Delivery
	guard agents.Guard
	onSay func()
}

func (c *fakeController) Say(_ context.Context, g agents.Guard, _ string) (agents.Delivery, error) {
	c.count++
	c.guard = g
	if c.onSay != nil {
		c.onSay()
	}
	return c.d, c.err
}

func harness(t *testing.T) (*Service, *fakeManager, *fakeController) {
	t.Helper()
	m := &fakeManager{records: map[string]tasks.Record{
		"owned":   {ID: "owned", OwnerID: "alice", GUID: "guid", Agent: "codex", WorkspaceID: "workspace", PaneID: "pane", Started: true, Status: tasks.Running},
		"foreign": {ID: "foreign", OwnerID: "bob", Title: "private", Status: tasks.Running},
	}, allowed: true}
	c := &fakeController{d: agents.Delivery{Acked: true, Verified: true}}
	s, err := New(Options{OwnerID: "alice", EntryChatID: "entry", StatePath: filepath.Join(t.TempDir(), "ops.json"), Manager: m, Registry: &fakeRegistry{agents.Agent{PaneID: "pane", WorkspaceID: "workspace", Kind: "codex", Status: agents.StatusIdle}}, Controller: c, Config: config.Tasks{DefaultProject: "project", Projects: map[string]config.Project{"project": {Path: "/private/repo", Agent: "codex"}}}})
	if err != nil {
		t.Fatal(err)
	}
	return s, m, c
}
func call(s *Service, name string, args any) (any, error) {
	b, _ := json.Marshal(args)
	return s.Call(context.Background(), name, b)
}

func TestIdentityAndModelArgumentsCannotEscapeTaskScope(t *testing.T) {
	s, m, _ := harness(t)
	for _, tc := range []struct {
		name string
		args any
	}{
		{"herdr_get", map[string]any{"task_id": "foreign"}},
		{"herdr_destroy", map[string]any{"task_id": "foreign", "request_id": "destroy-001"}},
		{"herdr_create", map[string]any{"text": "hi", "request_id": "create-001", "owner_id": "bob"}},
		{"herdr_create", map[string]any{"text": "hi", "request_id": "create-001", "path": "/tmp"}},
		{"herdr_create", map[string]any{"text": "hi", "request_id": "create-001", "project": "unconfigured"}},
	} {
		if _, err := call(s, tc.name, tc.args); err == nil {
			t.Fatalf("accepted %#v", tc)
		}
	}
	if m.creates != 0 || m.requests != 0 {
		t.Fatal("unauthorized effects")
	}
	projects, err := call(s, "herdr_projects", map[string]any{})
	b, _ := json.Marshal(projects)
	if err != nil || strings.Contains(string(b), "/private") {
		t.Fatalf("projects leaked path: %s %v", b, err)
	}
	m.allowed = false
	if _, err := call(s, "herdr_list", map[string]any{}); err == nil {
		t.Fatal("revoked owner can read")
	}
}

func TestConcurrentCreateAndRestartReplayRunOnce(t *testing.T) {
	s, m, _ := harness(t)
	args := map[string]any{"request_id": "create-001", "text": "修复登录", "project": "project"}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := call(s, "herdr_create", args); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if m.creates != 1 {
		t.Fatalf("created %d times", m.creates)
	}
	if m.records["task1"].EntryChatID != "entry" {
		t.Fatal("lost real entry chat")
	}
	reopened, err := New(s.opts)
	if err != nil {
		t.Fatal(err)
	}
	r, err := call(reopened, "herdr_create", args)
	if err != nil || !r.(receipt).Replayed || m.creates != 1 {
		t.Fatalf("restart replay: %v %v", r, err)
	}
	args["text"] = "another task"
	if _, err := call(reopened, "herdr_create", args); err == nil {
		t.Fatal("request id conflict accepted")
	}
	info, err := os.Stat(s.journal.path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("journal mode: %v %v", info, err)
	}
}

func TestToolSchemasRejectNullAndUnexpectedParametersBeforeEffects(t *testing.T) {
	s, m, c := harness(t)
	for _, tc := range []struct{ name, raw string }{
		{"herdr_create", `{"request_id":"create-001","text":"work","project":null}`},
		{"herdr_create", `{"request_id":"create-001","text":"work","agent":null}`},
		{"herdr_create", `{"request_id":"create-001","text":"work","agent":""}`},
		{"herdr_create", `{"request_id":"create-001","text":"work","task_id":"foreign"}`},
		{"herdr_list", `{"all":null}`},
		{"herdr_list", `{"all":"true"}`},
		{"herdr_send", `{"request_id":"send-0001","task_id":"owned","text":"work","pane_id":"another"}`},
		{"herdr_get", `{"task_id":null}`},
		{"herdr_get", `{"task_id":"owned"} {"task_id":"foreign"}`},
		{"herdr_projects", `[]`},
	} {
		if _, err := s.Call(context.Background(), tc.name, json.RawMessage(tc.raw)); err == nil {
			t.Fatalf("accepted %s %s", tc.name, tc.raw)
		}
	}
	if m.creates != 0 || m.requests != 0 || c.count != 0 || len(s.journal.ops) != 0 {
		t.Fatal("schema rejection recorded an effect")
	}
}

func TestOldCompleteReplayCannotOverwriteNewReopen(t *testing.T) {
	s, m, _ := harness(t)
	complete := map[string]any{"request_id": "complete-001", "task_id": "owned"}
	if _, err := call(s, "herdr_complete", complete); err != nil {
		t.Fatal(err)
	}
	if _, err := call(s, "herdr_reopen", map[string]any{"request_id": "reopen-001", "task_id": "owned"}); err != nil {
		t.Fatal(err)
	}
	if _, err := call(s, "herdr_complete", complete); err != nil {
		t.Fatal(err)
	}
	r, _ := m.Get("owned")
	if m.requests != 2 || r.CompletionRequest != "reopen" {
		t.Fatalf("old completion replayed: %#v", r)
	}
}

func TestUnknownDeliveryIsNotRepeatedAfterRestart(t *testing.T) {
	s, _, c := harness(t)
	c.err = errors.New("lost response")
	args := map[string]any{"request_id": "send-0001", "task_id": "owned", "text": "继续"}
	if _, err := call(s, "herdr_send", args); err == nil {
		t.Fatal("missing send error")
	}
	reopened, err := New(s.opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call(reopened, "herdr_send", args); err == nil {
		t.Fatal("missing saved send error")
	}
	if c.count != 1 {
		t.Fatalf("input repeated %d times", c.count)
	}
}

func TestVerifiedAndUnverifiedDeliveryRemainDistinct(t *testing.T) {
	s, _, c := harness(t)
	c.d = agents.Delivery{Acked: true, Verified: false, Queued: true, Escaped: true, MayHaveAnsweredADialog: true}
	x, err := call(s, "herdr_send", map[string]any{"request_id": "send-0001", "task_id": "owned", "text": "继续"})
	if err != nil {
		t.Fatal(err)
	}
	r := x.(receipt)
	if r.Outcome != "unconfirmed" || r.Delivery.Verified || !r.Delivery.CancelledDialog || !r.Delivery.MayHaveAnsweredDialog {
		t.Fatalf("misreported delivery: %#v", r)
	}
	if !c.guard.RequireUnblocked {
		t.Fatal("AI input can cancel an approval that appears after its snapshot")
	}
	reopened, err := New(s.opts)
	if err != nil {
		t.Fatal(err)
	}
	x, err = call(reopened, "herdr_send", map[string]any{"request_id": "send-0001", "task_id": "owned", "text": "继续"})
	if err != nil || x.(receipt).Outcome != "unconfirmed" || !x.(receipt).Replayed || c.count != 1 {
		t.Fatalf("unconfirmed delivery was repeated or changed after restart: %v, %v", x, err)
	}
}

func TestSendRequiresAcknowledgementAndOwnedPane(t *testing.T) {
	t.Run("verified without acknowledgement", func(t *testing.T) {
		s, _, c := harness(t)
		c.d = agents.Delivery{Verified: true}
		x, err := call(s, "herdr_send", map[string]any{"request_id": "send-0001", "task_id": "owned", "text": "continue"})
		if err != nil || x.(receipt).Outcome != "unconfirmed" {
			t.Fatalf("unacknowledged delivery reported as success: %v, %v", x, err)
		}
	})
	for _, scenario := range []string{"pane replaced", "blocked"} {
		t.Run(scenario, func(t *testing.T) {
			s, _, c := harness(t)
			r := s.opts.Registry.(*fakeRegistry)
			if scenario == "pane replaced" {
				r.agent.PaneID = "other-pane"
			} else {
				r.agent.Status = agents.StatusBlocked
			}
			if _, err := call(s, "herdr_send", map[string]any{"request_id": "send-0001", "task_id": "owned", "text": "continue"}); err == nil || c.count != 0 {
				t.Fatalf("unsafe input reached controller: %v", err)
			}
		})
	}
}

func TestSharedJournalSeparatesOwners(t *testing.T) {
	s, m, _ := harness(t)
	bob, err := s.ForChat("bob", "bob-entry")
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"request_id": "create-001", "text": "do work"}
	if _, err := call(s, "herdr_create", args); err != nil {
		t.Fatal(err)
	}
	if _, err := call(bob, "herdr_create", args); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(s.opts)
	if err != nil {
		t.Fatal(err)
	}
	bobAgain, err := reopened.ForChat("bob", "bob-entry")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call(bobAgain, "herdr_create", args); err != nil {
		t.Fatal(err)
	}
	if m.creates != 2 {
		t.Fatalf("shared journal lost owner: %d", m.creates)
	}
	if _, err := bobAgain.ForOwner("mallory"); err == nil {
		t.Fatal("unknown sender accepted")
	}
}

func TestRebindingOwnerDoesNotLeakNotificationsToPreviousChat(t *testing.T) {
	s, m, _ := harness(t)
	bob, err := s.ForOwner("bob")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call(bob, "herdr_create", map[string]any{"request_id": "create-001", "text": "private bob task"}); err != nil {
		t.Fatal(err)
	}
	if m.records["task1"].EntryChatID != "" || s.opts.EntryChatID != "entry" {
		t.Fatal("identity rebinding retained or mutated another owner's entry chat")
	}
}

func TestDestroyAlreadyClosedSessionIsIdempotent(t *testing.T) {
	s, m, _ := harness(t)
	r := m.records["owned"]
	r.Status = tasks.Destroyed
	r.ChatDeleted = true
	m.records["owned"] = r
	args := map[string]any{"request_id": "destroy-001", "task_id": "owned"}
	for i := 0; i < 2; i++ {
		x, err := call(s, "herdr_destroy", args)
		if err != nil || x.(receipt).Outcome != "already_destroyed" {
			t.Fatalf("repeat destruction = %v, %v", x, err)
		}
	}
	if m.requests != 0 {
		t.Fatal("already destroyed resources were requested again")
	}
}

func TestReceiptWriteFailureNeverRepeatsInput(t *testing.T) {
	s, _, c := harness(t)
	savedIntent := s.journal.path + ".saved"
	c.onSay = func() {
		// The input has reached the controller. Make receipt replacement fail,
		// retaining the pre-effect intent so the next process can recover it.
		if err := os.Rename(s.journal.path, savedIntent); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(s.journal.path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	args := map[string]any{"request_id": "send-0001", "task_id": "owned", "text": "continue"}
	if _, err := call(s, "herdr_send", args); err == nil || !strings.Contains(err.Error(), "无法保存回执") {
		t.Fatalf("receipt failure not reported: %v", err)
	}
	if _, err := call(s, "herdr_send", args); err == nil || c.count != 1 {
		t.Fatal("receipt failure repeated input before restart")
	}
	if err := os.Remove(s.journal.path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(savedIntent, s.journal.path); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(s.opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call(reopened, "herdr_send", args); err == nil || c.count != 1 {
		t.Fatal("receipt failure repeated input after restart")
	}
}

func TestInterruptedOperationAndCorruptJournalFailClosed(t *testing.T) {
	s, _, _ := harness(t)
	a := arguments{RequestID: "send-0001", TaskID: "owned", Text: "continue"}
	// Simulate a process interruption between intent persistence and receipt.
	b, _ := json.Marshal(a)
	_, _ = s.Call(context.Background(), "herdr_send", b)
	key := "alice\x00send-0001"
	op := s.journal.ops[key]
	op.Done = false
	op.Result = nil
	if err := s.journal.put(key, op); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(s.opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.Call(context.Background(), "herdr_send", b); err == nil || !strings.Contains(err.Error(), "尚未确认") {
		t.Fatalf("pending op replayed: %v", err)
	}
	if err := os.WriteFile(s.journal.path, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(s.opts); err == nil {
		t.Fatal("corrupt journal silently reset")
	}
}
