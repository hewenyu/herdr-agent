package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

func TestUnconfirmedReplyNeverBecomesVisibleHistoryAfterRestart(t *testing.T) {
	for _, mode := range []string{"prepared", "sending", "partial", "unknown", "retryable"} {
		t.Run(mode, func(t *testing.T) {
			h := newServiceHarness(t)
			const proposal = "建议项目名为 NEVER_SEEN_PROJECT，确认后开始。"
			e := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) { return proposal, nil }}
			s := h.service(t, e)
			in := serviceMessage("alice", "entry", "proposal", "先讨论名称")
			answer, err := s.Reply(context.Background(), in)
			if err != nil || answer != proposal {
				t.Fatalf("generation: %q %v", answer, err)
			}
			if mode != "prepared" {
				if start, err := s.BeginReplyDelivery(context.Background(), in, answer); err != nil || !start {
					t.Fatalf("start: %v %v", start, err)
				}
				if mode != "sending" {
					outcome := bridge.AssistantReplyDelivery{Retryable: mode == "retryable"}
					if mode == "partial" {
						outcome.MessageIDs = []string{"part-one"}
					}
					if err := s.RecordReplyDelivery(context.Background(), in, answer, outcome); err != nil {
						t.Fatal(err)
					}
				}
			}
			data, _ := os.ReadFile(onlySessionFile(t, h))
			if !strings.Contains(string(data), proposal) {
				t.Fatal("raw unsent reply was lost from durable audit data")
			}
			next := &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
				for _, m := range history {
					if strings.Contains(m.Content, "NEVER_SEEN_PROJECT") {
						t.Fatal("unconfirmed proposal entered model history")
					}
				}
				if !strings.Contains(history[len(history)-2].Content, "尚未确认完整送达") {
					t.Fatal("delivery uncertainty was omitted")
				}
				return "请告诉我你确认的名称。", nil
			}}
			serviceReply(t, h.service(t, next), serviceMessage("alice", "entry", "short", "就叫这个"))
			if len(h.manager.created()) != 0 {
				t.Fatal("unconfirmed dialogue caused an operation")
			}
		})
	}
}

func TestReplyOutboxResumesKnownUnsentRepliesWithoutRepeatingTools(t *testing.T) {
	h := newServiceHarness(t)
	e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
		_, err := call(ctx, "herdr_create", json.RawMessage(`{"project":"project","text":"create once"}`))
		return "已登记任务。", err
	}}
	in := serviceMessage("alice", "entry", "create", "创建任务")
	answer, err := h.service(t, e).Reply(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	restarted := h.service(t, &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		t.Fatal("replay invoked the model")
		return "", nil
	}})
	if replay, err := restarted.Reply(context.Background(), in); err != nil || replay != answer {
		t.Fatalf("prepared replay: %q %v", replay, err)
	}
	if start, err := restarted.BeginReplyDelivery(context.Background(), in, answer); err != nil || !start {
		t.Fatalf("prepared delivery: %v %v", start, err)
	}
	if err := restarted.RecordReplyDelivery(context.Background(), in, answer, bridge.AssistantReplyDelivery{Retryable: true}); err != nil {
		t.Fatal(err)
	}
	if start, err := restarted.BeginReplyDelivery(context.Background(), in, answer); err != nil || !start {
		t.Fatalf("definitely unsent retry: %v %v", start, err)
	}
	if start, err := restarted.BeginReplyDelivery(context.Background(), in, answer); err != nil || start {
		t.Fatal("in-flight delivery was duplicated")
	}
	outcome := bridge.AssistantReplyDelivery{MessageIDs: []string{"part-1", "part-2"}, Complete: true}
	for range 2 {
		if err := restarted.RecordReplyDelivery(context.Background(), in, answer, outcome); err != nil {
			t.Fatal(err)
		}
	}
	if start, err := h.service(t, e).BeginReplyDelivery(context.Background(), in, answer); err != nil || start {
		t.Fatal("confirmed delivery replayed after restart")
	}
	if len(h.manager.created()) != 1 || len(e.calls()) != 1 {
		t.Fatal("outbox recovery repeated a task or model call")
	}
}

func TestReplyOutboxDoesNotRetryPartialOrUnknownDelivery(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(fmt.Sprint(partial), func(t *testing.T) {
			h := newServiceHarness(t)
			s := h.service(t, &serviceTestEngine{})
			in := serviceMessage("alice", "entry", "reply", "讨论方案")
			answer, err := s.Reply(context.Background(), in)
			if err != nil {
				t.Fatal(err)
			}
			if start, err := s.BeginReplyDelivery(context.Background(), in, answer); err != nil || !start {
				t.Fatal("missing initial send reservation")
			}
			if partial {
				if err := s.RecordReplyDelivery(context.Background(), in, answer, bridge.AssistantReplyDelivery{MessageIDs: []string{"partial-1"}}); err != nil {
					t.Fatal(err)
				}
			}
			// For the unknown case, simulate loss of the process after the
			// network call but before any outcome could be persisted.
			restarted := h.service(t, &serviceTestEngine{})
			if start, err := restarted.BeginReplyDelivery(context.Background(), in, answer); err != nil || start {
				t.Fatal("unknown send was automatically repeated")
			}
			if err := restarted.RecordReplyDelivery(context.Background(), in, answer, bridge.AssistantReplyDelivery{Complete: true}); err == nil {
				t.Fatal("missing message IDs were accepted as delivery proof")
			}
		})
	}
}

func TestDeliveredNotificationSupportsShortRepliesAndCompaction(t *testing.T) {
	h := newGroupServiceHarness(t)
	s := h.service(t, &serviceTestEngine{})
	notice := groupMessage("notice-id", "agent 建议采用蓝色背景，请确认。")
	for range 2 {
		if err := s.RecordDeliveredMessage(context.Background(), notice); err != nil {
			t.Fatal(err)
		}
	}
	path := onlySessionFile(t, h)
	state, err := readSession(path, "alice", "task-group", "owned")
	if err != nil || len(state.Messages) != 1 {
		t.Fatalf("notification dedup: %v", err)
	}
	// More independently delivered notifications are valid assistant messages,
	// including before the first user turn; they must be summarized as such.
	for i := 0; i < 12; i++ {
		state.Messages = append(state.Messages, Message{Role: "assistant", Kind: "dialogue", Content: fmt.Sprintf("通知 %d：%s", i, strings.Repeat("保留需求背景和进展。", 300))})
	}
	if err := writeSession(path, state); err != nil {
		t.Fatal(err)
	}
	summaries := 0
	e := &serviceTestEngine{run: func(_ context.Context, history []Message, tools []tasktools.Tool, _ ToolCall) (string, error) {
		if len(tools) == 0 {
			summaries++
			return "agent 建议采用蓝色背景，尚待用户确认；此前进展是历史通知。", nil
		}
		if history[len(history)-1].Content != "同意这个方案" || !strings.Contains(history[0].Content, "蓝色背景") {
			t.Fatal("notification referent lost during compaction")
		}
		return "已理解你的反馈。", nil
	}}
	serviceReply(t, h.service(t, e), groupMessage("short-reply", "同意这个方案"))
	if summaries == 0 {
		t.Fatal("notification-heavy conversation did not compact")
	}
}

func TestPendingReplyCompactionAndLateDeliveryKeepCorrectVisibility(t *testing.T) {
	h := newServiceHarness(t)
	const proposal = "LATE_VISIBLE_NAME 可以作为项目名。"
	s := h.service(t, &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) { return proposal, nil }})
	in := serviceMessage("alice", "entry", "late", "讨论名称")
	answer, err := s.Reply(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if start, err := s.BeginReplyDelivery(context.Background(), in, answer); err != nil || !start {
		t.Fatal("late delivery did not start")
	}
	path := onlySessionFile(t, h)
	state, err := readSession(path, "alice", "entry", "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		state.Messages = append(state.Messages, Message{Role: "user", Content: strings.Repeat("补充细节。", 250)}, Message{Role: "assistant", Kind: "dialogue", Content: "收到要求。"})
	}
	if err := writeSession(path, state); err != nil {
		t.Fatal(err)
	}
	summaries := 0
	e := &serviceTestEngine{run: func(_ context.Context, history []Message, tools []tasktools.Tool, _ ToolCall) (string, error) {
		for _, m := range history {
			if strings.Contains(m.Content, "LATE_VISIBLE_NAME") {
				t.Fatal("pending proposal leaked through summary or recent history")
			}
		}
		if len(tools) == 0 {
			summaries++
			return "用户在讨论名称；此前答复未确认送达。", nil
		}
		return "继续讨论。", nil
	}}
	restarted := h.service(t, e)
	serviceReply(t, restarted, serviceMessage("alice", "entry", "during-send", "继续讨论"))
	if summaries == 0 {
		t.Fatal("pending dialogue was not compacted")
	}
	if err := restarted.RecordReplyDelivery(context.Background(), in, answer, bridge.AssistantReplyDelivery{Complete: true, MessageIDs: []string{"late-delivered"}}); err != nil {
		t.Fatal(err)
	}
	next := &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		if got := history[len(history)-2]; got.Role != "assistant" || got.Content != proposal {
			t.Fatalf("late confirmation did not restore its actual delivery position: %+v", got)
		}
		return "名称已经确认。", nil
	}}
	serviceReply(t, h.service(t, next), serviceMessage("alice", "entry", "after-delivery", "就用这个名称"))
}

func TestLateAcknowledgementFollowsInterveningVisibleReply(t *testing.T) {
	h := newServiceHarness(t)
	first := serviceMessage("alice", "entry", "first", "讨论第一个方案")
	s := h.service(t, &serviceTestEngine{})
	answer, err := s.Reply(context.Background(), first)
	if err != nil {
		t.Fatal(err)
	}
	if start, err := s.BeginReplyDelivery(context.Background(), first, answer); err != nil || !start {
		t.Fatal("first delivery did not start")
	}
	serviceReply(t, s, serviceMessage("alice", "entry", "second", "先看第二个方案"))
	if err := s.RecordReplyDelivery(context.Background(), first, answer, bridge.AssistantReplyDelivery{Complete: true, MessageIDs: []string{"late-first"}}); err != nil {
		t.Fatal(err)
	}
	e := &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		if history[len(history)-2].Content != answer || history[len(history)-3].Content != "答复：先看第二个方案" {
			t.Fatal("reply order reflected generation rather than confirmed delivery")
		}
		return "收到。", nil
	}}
	serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "third", "按最后收到的方案做"))
}

func TestPartialDeliveryCannotLoseAcknowledgementsOrBecomeRetryable(t *testing.T) {
	h := newServiceHarness(t)
	s := h.service(t, &serviceTestEngine{})
	in := serviceMessage("alice", "entry", "partial", "请回复方案")
	answer, err := s.Reply(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	if start, err := s.BeginReplyDelivery(context.Background(), in, answer); err != nil || !start {
		t.Fatal("delivery did not start")
	}
	partial := bridge.AssistantReplyDelivery{MessageIDs: []string{"first-part"}}
	if err := s.RecordReplyDelivery(context.Background(), in, answer, partial); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []bridge.AssistantReplyDelivery{{Retryable: true}, {Complete: true, MessageIDs: []string{"different-part"}}, {}} {
		if err := s.RecordReplyDelivery(context.Background(), in, answer, invalid); err == nil {
			t.Fatalf("unsafe delivery transition accepted: %+v", invalid)
		}
	}
	if err := s.RecordReplyDelivery(context.Background(), in, answer, bridge.AssistantReplyDelivery{Complete: true, MessageIDs: []string{"first-part", "second-part"}}); err != nil {
		t.Fatal(err)
	}
}
