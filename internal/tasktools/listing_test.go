package tasktools

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func TestTaskQueryDoesNotDescribeProcessedClosingDecisionAsDelivery(t *testing.T) {
	s, m, _ := harness(t)
	processedAt := time.Date(2026, time.September, 17, 9, 0, 0, 0, time.UTC)
	r := m.records["owned"]
	r.Status, r.CloseRequested, r.CloseNotifiedAt = tasks.Completed, true, processedAt
	m.records[r.ID] = r
	result, err := call(s, "herdr_get", map[string]any{"task_id": r.ID})
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var facts map[string]json.RawMessage
	if err := json.Unmarshal(data, &facts); err != nil {
		t.Fatal(err)
	}
	if _, claimsNotice := facts["close_notified_at"]; claimsNotice {
		t.Fatal("processed closing decision was exposed as a delivered notification")
	}
	var got time.Time
	if err := json.Unmarshal(facts["close_decision_processed_at"], &got); err != nil || !got.Equal(processedAt) {
		t.Fatalf("closing decision checkpoint lost: %s, %v", data, err)
	}
	if !m.records[r.ID].CloseNotifiedAt.Equal(processedAt) {
		t.Fatal("query changed the internal closing grace-period checkpoint")
	}
}

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
