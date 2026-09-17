package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

func notificationTestSetup(t *testing.T, engine Engine) (*Service, tasks.NotificationEvent, string) {
	t.Helper()
	h := newServiceHarness(t)
	r := h.manager.records["owned"]
	r.ChatID, r.PromptSent = "task-chat", true
	r.URL, r.Result = "https://example.test/task/owned", "agent 实际结果"
	h.manager.records[r.ID] = r
	return h.service(t, engine), tasks.NewNotificationEvent(r, tasks.NotificationProgress, r.ChatID), filepath.Join(t.TempDir(), "notifications")
}

func notificationJSON(notify bool, text string) string {
	data, _ := json.Marshal(map[string]any{"notify": notify, "text": text})
	return string(data)
}

func TestNotificationsPreserveModelChoiceAndSurviveRestart(t *testing.T) {
	for _, notify := range []bool{false, true} {
		t.Run(fmt.Sprint(notify), func(t *testing.T) {
			text := ""
			if notify {
				text = "模型决定的通知。\n保留原文和换行。"
			}
			engine := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
				return notificationJSON(notify, text), nil
			}}
			svc, event, dir := notificationTestSetup(t, engine)
			sends, recorded := 0, 0
			recorder := func(_ context.Context, in bridge.AssistantMessage) error {
				recorded++
				if in.Text != text || in.TaskID != event.Task.ID || in.ChatID != event.ChatID {
					t.Fatalf("wrong delivered history: %+v", in)
				}
				return nil
			}
			sender := func(_ context.Context, chat, body string) (string, error) {
				sends++
				if chat != event.ChatID || body != text {
					t.Fatalf("model reply rewritten: %q", body)
				}
				return "om_notice", nil
			}
			for i := 0; i < 2; i++ {
				n, err := NewNotifier(engine, svc.backend, dir, time.Second, recorder)
				if err != nil {
					t.Fatal(err)
				}
				if err := n.Notify(context.Background(), event, sender); err != nil {
					t.Fatal(err)
				}
			}
			want := 0
			if notify {
				want = 1
			}
			if sends != want || recorded != want || len(engine.calls()) != 1 {
				t.Fatalf("duplicate decision/delivery: sends=%d recorded=%d models=%d", sends, recorded, len(engine.calls()))
			}
		})
	}
}

func TestNotificationToolsCannotMutateOrReadAnotherTask(t *testing.T) {
	engine := &serviceTestEngine{run: func(ctx context.Context, history []Message, tools []tasktools.Tool, call ToolCall) (string, error) {
		if len(tools) != 1 || tools[0].Name != "herdr_get" || !tools[0].ReadOnly {
			t.Fatalf("unexpected notification tools: %+v", tools)
		}
		for _, name := range []string{"herdr_create", "herdr_send", "herdr_close", "herdr_list"} {
			if _, err := call(ctx, name, json.RawMessage(`{}`)); err == nil {
				t.Fatalf("notification accepted %s", name)
			}
		}
		if _, err := call(ctx, "herdr_get", json.RawMessage(`{"task_id":"other"}`)); err == nil {
			t.Fatal("notification queried another task")
		}
		result, err := call(ctx, "herdr_get", json.RawMessage(`{}`))
		if err != nil || result.(tasktools.Task).ID != "owned" {
			t.Fatalf("bound query failed: %v, %v", result, err)
		}
		if !strings.Contains(history[1].Content, "agent 实际结果") || !strings.Contains(history[1].Content, `"kind":"progress"`) {
			t.Fatal("model did not receive structured facts")
		}
		for _, internal := range []string{"close_notified_at", "reported_at", "reported_notice", "reported_state_key"} {
			if strings.Contains(history[1].Content, `"`+internal+`"`) {
				t.Fatalf("model received internal notification checkpoint %s", internal)
			}
		}
		return notificationJSON(false, ""), nil
	}}
	svc, event, dir := notificationTestSetup(t, engine)
	n, _ := NewNotifier(engine, svc.backend, dir, time.Second, nil)
	if err := n.Notify(context.Background(), event, func(context.Context, string, string) (string, error) {
		t.Fatal("skipped decision sent a message")
		return "", nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationModelFailureDoesNotInventOrCheckpointDelivery(t *testing.T) {
	for _, answer := range []string{"", "普通回复不能假装结构化成功", "null", `{}`, `{"notify":true,"text":""}`, `{"notify":false,"text":"ignored"}`} {
		t.Run(answer, func(t *testing.T) {
			engine := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) { return answer, nil }}
			svc, event, dir := notificationTestSetup(t, engine)
			n, _ := NewNotifier(engine, svc.backend, dir, time.Second, nil)
			sends := 0
			send := func(context.Context, string, string) (string, error) { sends++; return "om_success", nil }
			if err := n.Notify(context.Background(), event, send); err == nil || sends != 0 {
				t.Fatal("invalid model result became a successful notification")
			}
			engine.run = func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
				return notificationJSON(true, "恢复后的真实通知"), nil
			}
			if err := n.Notify(context.Background(), event, send); err != nil || sends != 1 {
				t.Fatalf("model failure blocked a safe retry: %v", err)
			}
		})
	}
}

func TestNotificationResumesOnlyUnsentChunksAfterRestart(t *testing.T) {
	text := strings.Repeat("完整通知。", 2000)
	engine := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		return notificationJSON(true, text), nil
	}}
	svc, event, dir := notificationTestSetup(t, engine)
	var sent []string
	recorded, attempts := 0, 0
	recorder := func(_ context.Context, in bridge.AssistantMessage) error {
		recorded++
		if in.Text != text {
			t.Fatal("history lost full notification")
		}
		return nil
	}
	sender := func(_ context.Context, _, body string) (string, error) {
		attempts++
		if attempts == 2 {
			return "", &lark.Failure{Kind: lark.FailRateLimited}
		}
		sent = append(sent, body)
		return fmt.Sprintf("om_%d", attempts), nil
	}
	n, _ := NewNotifier(engine, svc.backend, dir, time.Second, recorder)
	if err := n.Notify(context.Background(), event, sender); err == nil || len(sent) != 1 || recorded != 0 {
		t.Fatal("partial send was recorded as visible")
	}
	n, _ = NewNotifier(engine, svc.backend, dir, time.Second, recorder)
	if err := n.Notify(context.Background(), event, sender); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 3 || recorded != 1 || len(engine.calls()) != 1 || sent[0] == sent[1] {
		t.Fatalf("retry duplicated a confirmed chunk: sent=%d recorded=%d models=%d", len(sent), recorded, len(engine.calls()))
	}
}

func TestNotificationUnknownSendDoesNotRepeatOrEnterHistory(t *testing.T) {
	engine := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		return notificationJSON(true, "未知送达"), nil
	}}
	svc, event, dir := notificationTestSetup(t, engine)
	sends := 0
	sender := func(context.Context, string, string) (string, error) {
		sends++
		return "", errors.New("connection lost after sending")
	}
	recorder := func(context.Context, bridge.AssistantMessage) error {
		t.Fatal("unconfirmed delivery entered history")
		return nil
	}
	n, _ := NewNotifier(engine, svc.backend, dir, time.Second, recorder)
	if err := n.Notify(context.Background(), event, sender); err == nil {
		t.Fatal("unknown send became success")
	}
	n, _ = NewNotifier(engine, svc.backend, dir, time.Second, recorder)
	if err := n.Notify(context.Background(), event, sender); !errors.Is(err, ErrNotificationUnconfirmed) || sends != 1 {
		t.Fatalf("unknown send replayed: sends=%d err=%v", sends, err)
	}
}

func TestDeliveredNotificationIsAvailableToTheNextShortReply(t *testing.T) {
	text := "可以继续补充需要调整的颜色。"
	engine := &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		if history[0].Content == notificationPrompt {
			return notificationJSON(true, text), nil
		}
		found := false
		for _, message := range history {
			if message.Role == "assistant" && message.Content == text {
				found = true
			}
		}
		if !found {
			t.Fatal("delivered notification missing from conversation")
		}
		return "收到颜色调整。", nil
	}}
	svc, event, dir := notificationTestSetup(t, engine)
	n, _ := NewNotifier(engine, svc.backend, dir, time.Second, svc.RecordDeliveredMessage)
	if err := n.Notify(context.Background(), event, func(context.Context, string, string) (string, error) { return "om_color", nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Reply(context.Background(), bridge.AssistantMessage{OwnerID: event.OwnerID, ChatID: event.ChatID, TaskID: event.Task.ID, MessageID: "reply-color", Text: "那就用蓝色"}); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationRecoversDeliveredHistoryAfterStateChangesAndRestart(t *testing.T) {
	for _, taskGroup := range []bool{true, false} {
		t.Run(fmt.Sprintf("task-group=%t", taskGroup), func(t *testing.T) {
			const text = "已送达的旧阶段通知，后续反馈需要这条上下文。"
			nextEvent := false
			engine := &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
				if history[0].Content == notificationPrompt {
					if nextEvent {
						return notificationJSON(false, ""), nil
					}
					return notificationJSON(true, text), nil
				}
				seen := 0
				for _, message := range history {
					if message.Role == "assistant" && message.Content == text {
						seen++
					}
				}
				if seen != 1 {
					t.Fatalf("previous delivered notification should appear once after recovery, got %d", seen)
				}
				return "根据之前的通知继续处理。", nil
			}}
			svc, event, dir := notificationTestSetup(t, engine)
			conversationTaskID := event.Task.ID
			if !taskGroup {
				event = tasks.NewNotificationEvent(event.Task, tasks.NotificationProgress, "entry-chat")
				conversationTaskID = ""
			}
			recordAttempts, sends := 0, 0
			recorder := func(ctx context.Context, in bridge.AssistantMessage) error {
				recordAttempts++
				if in.TaskID != conversationTaskID || in.ChatID != event.ChatID {
					t.Fatalf("history recovered into the wrong scope: %+v", in)
				}
				if recordAttempts == 1 {
					return errors.New("conversation lock unavailable")
				}
				return svc.RecordDeliveredMessage(ctx, in)
			}
			send := func(context.Context, string, string) (string, error) {
				sends++
				return "om_delivered", nil
			}
			n, _ := NewNotifier(engine, svc.backend, dir, time.Second, recorder)
			if err := n.Notify(context.Background(), event, send); err == nil {
				t.Fatal("failed history write was not surfaced")
			}
			oldID := event.ID
			event.Task.Status, event.Task.ReviewVersion = tasks.Review, event.Task.ReviewVersion+1
			event = tasks.NewNotificationEvent(event.Task, tasks.NotificationProgress, event.ChatID)
			if oldID == event.ID {
				t.Fatal("test did not advance to a new lifecycle event")
			}
			nextEvent = true
			n, _ = NewNotifier(engine, svc.backend, dir, time.Second, recorder)
			if err := n.Notify(context.Background(), event, send); err != nil {
				t.Fatal(err)
			}
			if err := n.Notify(context.Background(), event, send); err != nil {
				t.Fatal(err)
			}
			if sends != 1 || recordAttempts != 2 {
				t.Fatalf("history recovery repeated sends or recording: sends=%d records=%d", sends, recordAttempts)
			}
			if _, err := svc.Reply(context.Background(), bridge.AssistantMessage{OwnerID: event.OwnerID, ChatID: event.ChatID, TaskID: conversationTaskID, MessageID: "followup", Text: "按刚才说的继续"}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNotificationRecordsAcknowledgedDeliveryAfterSendContextExpires(t *testing.T) {
	engine := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		return notificationJSON(true, "最后一刻确认送达的通知"), nil
	}}
	svc, event, dir := notificationTestSetup(t, engine)
	recorded := false
	n, _ := NewNotifier(engine, svc.backend, dir, time.Second, func(ctx context.Context, in bridge.AssistantMessage) error {
		if err := ctx.Err(); err != nil {
			t.Fatalf("history inherited the exhausted send context: %v", err)
		}
		recorded = true
		return svc.RecordDeliveredMessage(ctx, in)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := n.Notify(ctx, event, func(context.Context, string, string) (string, error) {
		cancel()
		return "om_at_deadline", nil
	}); err != nil {
		t.Fatal(err)
	}
	if !recorded {
		t.Fatal("confirmed delivery was omitted from history")
	}
}

func TestNotificationHistoryRecoveryPreservesDeliveryOrder(t *testing.T) {
	engine := &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		if history[0].Content == notificationPrompt {
			return notificationJSON(false, ""), nil
		}
		var delivered []string
		for _, message := range history {
			if message.Role == "assistant" {
				delivered = append(delivered, message.Content)
			}
		}
		if !slices.Equal(delivered, []string{"先送达的通知", "后送达的通知"}) {
			t.Fatalf("recovered notifications lost their delivery order: %v", delivered)
		}
		return "继续。", nil
	}}
	svc, event, dir := notificationTestSetup(t, engine)
	n, err := NewNotifier(engine, svc.backend, dir, time.Second, svc.RecordDeliveredMessage)
	if err != nil {
		t.Fatal(err)
	}
	first, second := "old-event-a", "old-event-b"
	if digest(first) < digest(second) {
		first, second = second, first
	}
	base := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)
	for i, id := range []string{first, second} {
		r := notificationReceipt{Version: 1, EventID: id, OwnerID: event.OwnerID, ChatID: event.ChatID, TaskID: event.Task.ID, ConversationTaskID: event.Task.ID,
			Decided: true, Notify: true, Text: []string{"先送达的通知", "后送达的通知"}[i], Delivered: true, DeliveredAt: base.Add(time.Duration(i) * time.Second), MessageIDs: []string{fmt.Sprintf("om_old_%d", i)}}
		if err := writeNotificationReceipt(filepath.Join(dir, digest(id)+".json"), r); err != nil {
			t.Fatal(err)
		}
	}
	if err := n.Notify(context.Background(), event, func(context.Context, string, string) (string, error) {
		t.Fatal("history recovery must not resend a message")
		return "", nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Reply(context.Background(), bridge.AssistantMessage{OwnerID: event.OwnerID, ChatID: event.ChatID, TaskID: event.Task.ID, MessageID: "ordered-followup", Text: "继续"}); err != nil {
		t.Fatal(err)
	}
}
