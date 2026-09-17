package tasktools

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func groupHarness(t *testing.T) (*Service, *Service, *fakeManager, *fakeController) {
	t.Helper()
	s, m, c := harness(t)
	r := m.records["owned"]
	r.ChatID = "task-chat"
	m.records[r.ID] = r
	m.records["same-owner"] = tasks.Record{ID: "same-owner", OwnerID: "alice", ChatID: "other-chat", Title: "other-project-private"}
	group, err := s.ForTask("alice", "task-chat", "owned")
	if err != nil {
		t.Fatal(err)
	}
	return s, group, m, c
}

func TestGroupRequiresActualOwnerAndChatBinding(t *testing.T) {
	s, group, _, _ := groupHarness(t)
	for _, input := range []struct{ owner, chat, task string }{
		{"alice", "task-chat", ""},
		{"alice", "wrong-chat", "owned"},
		{"bob", "task-chat", "owned"},
		{"alice", "task-chat", "same-owner"},
		{"stranger", "task-chat", "owned"},
	} {
		if _, err := s.ForTask(input.owner, input.chat, input.task); err == nil {
			t.Fatalf("accepted false group binding: %+v", input)
		}
	}
	if _, err := group.ForOwner("bob"); err == nil {
		t.Fatal("group scope escaped through owner rebinding")
	}
	if _, err := group.ForChat("alice", "other-chat"); err == nil {
		t.Fatal("group scope escaped through chat rebinding")
	}
	if _, err := group.ForTask("alice", "other-chat", "same-owner"); err == nil {
		t.Fatal("group scope switched to another task")
	}
	bound, err := group.ForOwner("alice")
	if err != nil || len(bound.Tools()) != 7 {
		t.Fatal("same-owner rebinding lost the group scope")
	}
}

func TestGroupToolSurfaceAndArgumentsCannotEscapeCurrentTask(t *testing.T) {
	_, group, m, c := groupHarness(t)
	want := map[string]bool{"herdr_get": true, "herdr_send": true, "herdr_complete": true, "herdr_reopen": true, "herdr_retry": true, "herdr_destroy": true, "herdr_close": true}
	for _, tool := range group.Tools() {
		if !want[tool.Name] {
			t.Fatalf("unexpected group tool: %s", tool.Name)
		}
		delete(want, tool.Name)
		for _, required := range tool.InputSchema["required"].([]string) {
			if required == "task_id" {
				t.Fatalf("%s requires user to supply the already bound task", tool.Name)
			}
		}
	}
	if len(want) != 0 {
		t.Fatalf("missing group tools: %v", want)
	}
	for _, attempt := range []struct {
		name string
		args map[string]any
	}{
		{"herdr_projects", map[string]any{}},
		{"herdr_list", map[string]any{"all": true}},
		{"herdr_create", map[string]any{"text": "new task", "request_id": "create-001"}},
		{"herdr_get", map[string]any{"task_id": "same-owner"}},
		{"herdr_get", map[string]any{"task_id": "foreign"}},
		{"herdr_send", map[string]any{"task_id": "same-owner", "request_id": "send-0001", "text": "cross-task input"}},
		{"herdr_close", map[string]any{"task_id": "same-owner", "request_id": "close-001"}},
		{"herdr_get", map[string]any{"owner_id": "bob"}},
	} {
		result, err := call(group, attempt.name, attempt.args)
		if err == nil || result != nil {
			t.Fatalf("accepted group escape: %+v => %v, %v", attempt, result, err)
		}
	}
	result, err := call(group, "herdr_get", map[string]any{})
	if err != nil || result.(Task).ID != "owned" {
		t.Fatalf("implicit current task did not resolve: %v, %v", result, err)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "other-project-private") || strings.Contains(string(data), "/private/repo") {
		t.Fatalf("current task leaked another project or repository path: %s", data)
	}
	if m.creates != 0 || m.requests != 0 || c.count != 0 || len(group.journal.ops) != 0 {
		t.Fatal("rejected group calls caused side effects")
	}
}

func TestGroupBindingIsRecheckedForReadsWritesAndSavedReceipts(t *testing.T) {
	for _, change := range []string{"owner", "chat", "deleted", "allowlist"} {
		t.Run(change, func(t *testing.T) {
			_, group, m, c := groupHarness(t)
			args := map[string]any{"request_id": "complete-001"}
			if _, err := call(group, "herdr_complete", args); err != nil {
				t.Fatal(err)
			}
			r := m.records["owned"]
			switch change {
			case "owner":
				r.OwnerID = "bob"
			case "chat":
				r.ChatID = "replacement-chat"
			case "deleted":
				r.ChatDeleted = true
			case "allowlist":
				m.allowed = false
			}
			m.records[r.ID] = r
			for _, attempt := range []struct {
				name string
				args map[string]any
			}{
				{"herdr_get", map[string]any{}},
				{"herdr_send", map[string]any{"request_id": "send-0001", "text": "new input"}},
				{"herdr_complete", args},
			} {
				if _, err := call(group, attempt.name, attempt.args); err == nil {
					t.Fatalf("stale %s binding accepted %s", change, attempt.name)
				}
			}
			if m.requests != 1 || c.count != 0 {
				t.Fatal("stale binding caused another effect")
			}
		})
	}
}

func TestGroupCloseUsesCompositeOperationAndSharedDurableJournal(t *testing.T) {
	s, group, m, _ := groupHarness(t)
	args := map[string]any{"request_id": "close-001"}
	x, err := call(group, "herdr_close", args)
	if err != nil || x.(receipt).Task.CompletionRequest != "close" {
		t.Fatalf("close did not use manager composite operation: %v, %v", x, err)
	}
	if group.journal != s.journal || group.mu != s.mu {
		t.Fatal("group copied rather than shared operation synchronization")
	}
	restarted, err := New(s.opts)
	if err != nil {
		t.Fatal(err)
	}
	rebound, err := restarted.ForTask("alice", "task-chat", "owned")
	if err != nil {
		t.Fatal(err)
	}
	args["task_id"] = "owned"
	x, err = call(rebound, "herdr_close", args)
	if err != nil || !x.(receipt).Replayed || m.requests != 1 {
		t.Fatalf("omitted and explicit bound ID failed to deduplicate across restart: %v, %v, requests=%d", x, err, m.requests)
	}
	if _, err := call(s, "herdr_close", args); err == nil {
		t.Fatal("private tool surface unexpectedly gained group closure")
	}
}
