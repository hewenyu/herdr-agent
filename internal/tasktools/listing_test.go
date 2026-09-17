package tasktools

import (
	"testing"

	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func TestListDefaultsToUnfinishedTasksEvenDuringCleanup(t *testing.T) {
	s, m, _ := harness(t)
	m.records["completed"] = tasks.Record{ID: "completed", OwnerID: "alice", Status: tasks.Completed, CloseRequested: true}
	m.records["destroyed"] = tasks.Record{ID: "destroyed", OwnerID: "alice", Status: tasks.Destroyed, Pending: "workspace"}
	for _, all := range []bool{false, true} {
		result, err := call(s, "herdr_list", map[string]any{"all": all})
		if err != nil {
			t.Fatal(err)
		}
		listed := result.([]Task)
		if !all && (len(listed) != 1 || listed[0].ID != "owned") || all && len(listed) != 3 {
			t.Fatalf("all=%t list: %+v", all, listed)
		}
	}
}

func TestDestroyedTaskViewRetainsResultWithoutPendingClosureOrChatLink(t *testing.T) {
	r := tasks.Record{ID: "closed", Status: tasks.Destroyed, CloseRequested: true, ChatID: "old-chat", Result: "saved-result"}
	got := view(r)
	if got.CloseRequested || got.ChatURL != "" || got.LatestReply != r.Result || got.Status != tasks.Destroyed {
		t.Fatalf("destroyed tool view: %+v", got)
	}
	if !r.CloseRequested || r.Result != "saved-result" {
		t.Fatal("rendering rewrote persisted task history")
	}
}
