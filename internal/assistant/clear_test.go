package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	localmemory "github.com/hewenyu/herdr-agent/internal/memory"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

func TestClearStartsEmptySessionAndPreservesTasksAndArchive(t *testing.T) {
	h := newGroupServiceHarness(t)
	e := &serviceTestEngine{}
	s := h.service(t, e)
	in := serviceMessage("alice", "entry", "old", "旧会话的错误建议")
	serviceReply(t, s, in)
	path := onlySessionFile(t, h)
	before, err := readSession(path, in.OwnerID, in.ChatID, in.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	before.Memory = localmemory.Entry{Summary: "旧摘要也必须隔离"}
	if err := writeSession(path, before); err != nil {
		t.Fatal(err)
	}
	recordsBefore, _ := json.Marshal(h.manager.records)
	clear := in
	clear.MessageID, clear.Text = "clear", "/clear"
	// The command must work even when both AI and memory are offline.
	memory := &recordingMemory{entries: map[localmemory.Scope]localmemory.Entry{
		{OwnerID: in.OwnerID, ChatID: in.ChatID, TaskID: in.TaskID}: before.Memory,
	}, err: errors.New("provider unavailable")}
	s.memoryProvider = memory
	if got := serviceReply(t, s, clear); got != clearedReply || len(e.calls()) != 1 || len(memory.recalls) != 0 {
		t.Fatal("clear used the model/provider or omitted its acknowledgement")
	}
	after, err := readSession(path, in.OwnerID, in.ChatID, in.TaskID)
	if err != nil || len(after.Messages) != 0 || after.Memory.Summary != "" || after.Generation != 1 || after.ClearedAt.IsZero() {
		t.Fatalf("new conversation retained context: %+v, %v", after, err)
	}
	archive, err := filepath.Glob(filepath.Join(h.dir, "archive", "*", "clear-*.json"))
	if err != nil || len(archive) != 1 {
		t.Fatalf("missing old session archive: %v %v", archive, err)
	}
	old, err := readSession(archive[0], in.OwnerID, in.ChatID, in.TaskID)
	if err != nil || !reflect.DeepEqual(old, before) {
		t.Fatal("old conversation or its summary was lost")
	}
	memory.err = nil
	restarted := h.service(t, &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		if len(history) != 2 || history[1].Content != "新的完整需求" || strings.Contains(history[0].Content, before.Memory.Summary) {
			t.Fatalf("old context restored after restart: %+v", history)
		}
		return "新会话的答复", nil
	}})
	restarted.memoryProvider = memory
	in.MessageID, in.Text = "new", "新的完整需求"
	serviceReply(t, restarted, in)
	if memory.entries[localmemory.Scope{OwnerID: in.OwnerID, ChatID: in.ChatID, TaskID: in.TaskID}].Summary != "" {
		t.Fatal("provider retained the active old summary")
	}
	recordsAfter, _ := json.Marshal(h.manager.records)
	if string(recordsBefore) != string(recordsAfter) || len(h.controller.texts) != 0 || len(h.manager.requests) != 0 {
		t.Fatal("clearing assistant context affected existing tasks or coding agents")
	}
}

func TestClearIsolatesEachChatAndOwner(t *testing.T) {
	h := newGroupServiceHarness(t)
	s := h.service(t, &serviceTestEngine{})
	inputs := []bridge.AssistantMessage{
		serviceMessage("alice", "entry", "private", "私聊内容"),
		groupMessage("group-one", "第一个群的内容"),
		{OwnerID: "alice", ChatID: "other-group", TaskID: "same-owner", MessageID: "group-two", Text: "第二个群的内容"},
		serviceMessage("bob", "entry", "other-owner", "另一个用户的内容"),
	}
	before := map[string][]byte{}
	for _, in := range inputs {
		serviceReply(t, s, in)
		path := filepath.Join(h.dir, digest(in.OwnerID+"\x00"+in.ChatID)+".json")
		before[path], _ = os.ReadFile(path)
	}
	serviceReply(t, s, serviceMessage("alice", "entry", "clear-private", "/clear"))
	for _, in := range inputs {
		path := filepath.Join(h.dir, digest(in.OwnerID+"\x00"+in.ChatID)+".json")
		if in.ChatID == "entry" && in.OwnerID == "alice" {
			state, err := readSession(path, in.OwnerID, in.ChatID, in.TaskID)
			if err != nil || len(state.Messages) != 0 || state.Generation != 1 {
				t.Fatal("target private conversation was not cleared")
			}
			continue
		}
		after, err := os.ReadFile(path)
		if err != nil || string(after) != string(before[path]) {
			t.Fatalf("clear changed another conversation: %s", in.ChatID)
		}
	}
}

func TestClearRejectsTaskGroupWithoutChangingItsSession(t *testing.T) {
	h := newGroupServiceHarness(t)
	e := &serviceTestEngine{}
	s := h.service(t, e)
	serviceReply(t, s, groupMessage("old", "群聊继续使用自己的记忆"))
	path := onlySessionFile(t, h)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reply(context.Background(), groupMessage("clear", "/clear")); err == nil {
		t.Fatal("task group accepted a conversation reset")
	}
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) || len(e.calls()) != 1 {
		t.Fatal("rejected reset affected group context or invoked the model")
	}
}

func TestClearWaitsForActiveTurnBeforeSwitchingSession(t *testing.T) {
	h := newServiceHarness(t)
	entered, release := make(chan struct{}), make(chan struct{})
	e := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		close(entered)
		<-release
		return "旧会话的迟到答复", nil
	}}
	s := h.service(t, e)
	old := serviceMessage("alice", "entry", "old", "进行中的要求")
	type result struct {
		answer string
		err    error
	}
	oldDone := make(chan result, 1)
	go func() {
		answer, err := s.Reply(context.Background(), old)
		oldDone <- result{answer, err}
	}()
	<-entered
	clear := serviceMessage("alice", "entry", "clear", "/clear")
	clearDone := make(chan result, 1)
	go func() {
		answer, err := s.Reply(context.Background(), clear)
		clearDone <- result{answer, err}
	}()
	close(release)
	previous, reset := <-oldDone, <-clearDone
	if previous.err != nil || reset.err != nil || reset.answer != clearedReply {
		t.Fatalf("serialized reset failed: old=%+v clear=%+v", previous, reset)
	}
	if ok, err := s.BeginReplyDelivery(context.Background(), old, previous.answer); err != nil || ok {
		t.Fatal("old in-flight answer entered the new session")
	}
	state, err := readSession(onlySessionFile(t, h), "alice", "entry", "")
	if err != nil || len(state.Messages) != 0 || state.Pending != "" || state.Generation != 1 {
		t.Fatal("active turn overwrote the new session")
	}
}

func TestClearPreservesDeduplicationAndRejectsLateReplyHistory(t *testing.T) {
	h := newServiceHarness(t)
	e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
		_, err := call(ctx, "herdr_create", json.RawMessage(`{"project":"project","text":"只创建一次"}`))
		return "旧会话创建回执", err
	}}
	s := h.service(t, e)
	old := serviceMessage("alice", "entry", "old", "创建任务")
	answer, err := s.Reply(context.Background(), old)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := s.BeginReplyDelivery(context.Background(), old, answer); err != nil || !ok {
		t.Fatalf("start old delivery: %v %v", ok, err)
	}
	clear := serviceMessage("alice", "entry", "clear", "/clear")
	serviceReply(t, s, clear)
	restarted := h.service(t, &serviceTestEngine{})
	if err := restarted.RecordReplyDelivery(context.Background(), old, answer, bridge.AssistantReplyDelivery{
		Complete: true, MessageIDs: []string{"late-ack"},
	}); err != nil {
		t.Fatal(err)
	}
	if got, err := restarted.Reply(context.Background(), old); err != nil || got != answer {
		t.Fatal("old message lost its operation receipt")
	}
	if ok, err := restarted.BeginReplyDelivery(context.Background(), old, answer); err != nil || ok {
		t.Fatal("old generation replay was sent into the new conversation")
	}
	state, err := readSession(onlySessionFile(t, h), "alice", "entry", "")
	if err != nil || len(state.Messages) != 0 || len(h.manager.created()) != 1 {
		t.Fatal("late reply contaminated context or repeated a task")
	}
	serviceReply(t, restarted, serviceMessage("alice", "entry", "new", "新会话内容"))
	before, _ := os.ReadFile(onlySessionFile(t, h))
	serviceReply(t, restarted, clear)
	after, _ := os.ReadFile(onlySessionFile(t, h))
	if string(before) != string(after) {
		t.Fatal("redelivered clear erased the new conversation")
	}
}

func TestClearSuppressesUnsentOldReplyAndOldNotificationRepair(t *testing.T) {
	h := newServiceHarness(t)
	s := h.service(t, &serviceTestEngine{})
	old := serviceMessage("alice", "entry", "old", "旧需求")
	answer, err := s.Reply(context.Background(), old)
	if err != nil {
		t.Fatal(err)
	}
	delivered := time.Now().Add(-time.Minute)
	serviceReply(t, s, serviceMessage("alice", "entry", "clear", "/clear"))
	if start, err := s.BeginReplyDelivery(context.Background(), old, answer); err != nil || start {
		t.Fatal("clear did not suppress prepared old reply")
	}
	notice := serviceMessage("alice", "entry", "old-notice", "旧通知")
	notice.DeliveredAt = delivered
	if err := s.RecordDeliveredMessage(context.Background(), notice); err != nil {
		t.Fatal(err)
	}
	notice.MessageID, notice.DeliveredAt = "legacy-notice", time.Time{}
	if err := s.RecordDeliveredMessage(context.Background(), notice); err != nil {
		t.Fatal(err)
	}
	state, err := readSession(onlySessionFile(t, h), "alice", "entry", "")
	if err != nil || len(state.Messages) != 0 {
		t.Fatal("history repair restored a notification delivered before clear")
	}
	notice.MessageID, notice.Text, notice.DeliveredAt = "new-notice", "新通知", time.Now()
	if err := s.RecordDeliveredMessage(context.Background(), notice); err != nil {
		t.Fatal(err)
	}
	state, _ = readSession(onlySessionFile(t, h), "alice", "entry", "")
	if len(state.Messages) != 1 || state.Messages[0].Content != notice.Text {
		t.Fatal("new task notifications stopped entering the new conversation")
	}
}

func TestClearArchiveFailurePreservesCurrentSession(t *testing.T) {
	h := newServiceHarness(t)
	s := h.service(t, &serviceTestEngine{})
	serviceReply(t, s, serviceMessage("alice", "entry", "old", "保留旧会话"))
	path := onlySessionFile(t, h)
	before, _ := os.ReadFile(path)
	if err := os.WriteFile(filepath.Join(h.dir, "archive"), []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Reply(context.Background(), serviceMessage("alice", "entry", "clear", "/clear")); err == nil {
		t.Fatal("clear succeeded without archiving history")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("failed archive erased the current conversation")
	}
}
