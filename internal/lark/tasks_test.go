package lark

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/tasks"
	larktask "github.com/larksuite/oapi-sdk-go/v3/service/task/v2"
)

type taskHTTP struct {
	mu        sync.Mutex
	calls     []stubCall
	responses map[string]string
	err       error
	fallback  stubHTTP
}

func (s *taskHTTP) Do(r *http.Request) (*http.Response, error) {
	if strings.Contains(r.URL.Path, "tenant_access_token") || r.URL.Path == "/open-apis/bot/v3/info" {
		return s.fallback.Do(r)
	}
	var body []byte
	if r.Body != nil {
		body, _ = io.ReadAll(r.Body)
	}
	s.mu.Lock()
	s.calls = append(s.calls, stubCall{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: string(body)})
	response, ok := s.responses[r.Method+" "+r.URL.Path]
	err := s.err
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("unexpected task HTTP request: %s %s", r.Method, r.URL.Path)
	}
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}},
		Body: io.NopCloser(strings.NewReader(response)), Request: r}, nil
}

func (s *taskHTTP) snapshot() []stubCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]stubCall(nil), s.calls...)
}

func taskBody(t *testing.T, c stubCall) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal([]byte(c.Body), &body); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	return body
}

func TestCreateTaskIncludesHumanAndApplicationAssignees(t *testing.T) {
	h := &taskHTTP{responses: map[string]string{
		"POST /open-apis/task/v2/tasks": `{"code":0,"data":{"task":{"guid":"task-1","url":"https://example.test/task-1","description":"进行中：修复登录\n下一步：运行测试","completed_at":"0"}}}`,
	}}
	b, _ := newTestBot(t, WithHTTPClient(h))
	description := "进行中：修复登录\n下一步：运行测试"
	got, err := b.CreateTask(context.Background(), tasks.TaskSpec{
		Title: "修复登录", Description: description, OwnerID: "ou_owner", Key: "stable-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.GUID != "task-1" || got.URL != "https://example.test/task-1" || got.Description != description || got.CompletedAt != "0" {
		t.Fatalf("task = %+v", got)
	}
	calls := h.snapshot()
	if len(calls) != 1 {
		t.Fatalf("calls = %+v", calls)
	}
	body := taskBody(t, calls[0])
	if body["summary"] != "修复登录" || body["description"] != description || body["client_token"] != "stable-key" || body["mode"] != float64(2) {
		t.Fatalf("task body = %+v", body)
	}
	wantMembers := []any{
		map[string]any{"id": "ou_owner", "type": "user", "role": "assignee"},
		map[string]any{"id": "cli_test", "type": "app", "role": "assignee"},
	}
	if !reflect.DeepEqual(body["members"], wantMembers) {
		t.Fatalf("members = %#v", body["members"])
	}
	origin := body["origin"].(map[string]any)["platform_i18n_name"].(map[string]any)
	if origin["zh_cn"] != "herdr" || origin["en_us"] != "herdr" {
		t.Fatalf("origin = %#v", origin)
	}
	query, _ := url.ParseQuery(calls[0].Query)
	if query.Get("user_id_type") != "open_id" {
		t.Fatalf("query = %s", calls[0].Query)
	}
}

func TestUpdateTaskLimitsFieldsAndSkipsRepeatedCompletion(t *testing.T) {
	for _, tc := range []struct {
		name, current string
		requested     *string
		wantComplete  bool
	}{
		{name: "progress only"},
		{name: "complete", current: "0", requested: strptr("12345"), wantComplete: true},
		{name: "already complete", current: "10000", requested: strptr("12345")},
		{name: "reopen", current: "10000", requested: strptr("0"), wantComplete: true},
		{name: "already open", current: "0", requested: strptr("0")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &taskHTTP{responses: map[string]string{
				"GET /open-apis/task/v2/tasks/task-1":   fmt.Sprintf(`{"code":0,"data":{"task":{"guid":"task-1","completed_at":%q}}}`, tc.current),
				"PATCH /open-apis/task/v2/tasks/task-1": `{"code":0,"data":{"task":{"guid":"task-1"}}}`,
			}}
			b, _ := newTestBot(t, WithHTTPClient(h))
			if err := b.UpdateTask(context.Background(), "task-1", "待验收：测试已通过 ✅", tc.requested); err != nil {
				t.Fatal(err)
			}
			calls := h.snapshot()
			wantCalls := 1
			if tc.requested != nil {
				wantCalls = 2
			}
			if len(calls) != wantCalls {
				t.Fatalf("calls = %+v", calls)
			}
			body := taskBody(t, calls[len(calls)-1])
			input := body["task"].(map[string]any)
			wantFields := []any{"description"}
			if tc.wantComplete {
				wantFields = append(wantFields, "completed_at")
				if input["completed_at"] != *tc.requested {
					t.Fatalf("completion = %#v", input)
				}
			} else if _, ok := input["completed_at"]; ok {
				t.Fatalf("duplicate/unrequested completion was included: %#v", input)
			}
			if !reflect.DeepEqual(body["update_fields"], wantFields) || input["description"] != "待验收：测试已通过 ✅" || len(input) != len(wantFields) {
				t.Fatalf("patch = %#v", body)
			}
		})
	}
}

func TestTaskChatIsPrivateBotOwnedAndCanBeDissolved(t *testing.T) {
	h := &taskHTTP{responses: map[string]string{
		"POST /open-apis/im/v1/chats":           `{"code":0,"data":{"chat_id":"oc_task"}}`,
		"DELETE /open-apis/im/v1/chats/oc_task": `{"code":0}`,
	}}
	b, _ := newTestBot(t, WithHTTPClient(h))
	chat, err := b.CreateTaskChat(context.Background(), tasks.ChatSpec{Name: "任务：修复登录", OwnerID: "ou_owner", Key: "chat-key"})
	if err != nil || chat != "oc_task" {
		t.Fatalf("create = %q, %v", chat, err)
	}
	if err := b.DeleteTaskChat(context.Background(), chat); err != nil {
		t.Fatal(err)
	}
	calls := h.snapshot()
	if len(calls) != 2 || calls[1].Method != http.MethodDelete || calls[1].Path != "/open-apis/im/v1/chats/oc_task" {
		t.Fatalf("calls = %+v", calls)
	}
	body := taskBody(t, calls[0])
	if _, ok := body["owner_id"]; ok {
		t.Fatal("owner_id must be omitted so the bot owns the chat")
	}
	if body["name"] != "任务：修复登录" || body["chat_type"] != "private" || body["chat_mode"] != "group" || body["group_message_type"] != "chat" || body["external"] != false || !reflect.DeepEqual(body["user_id_list"], []any{"ou_owner"}) {
		t.Fatalf("chat body = %#v", body)
	}
	query, _ := url.ParseQuery(calls[0].Query)
	if query.Get("uuid") != "chat-key" || query.Get("user_id_type") != "open_id" {
		t.Fatalf("query = %s", calls[0].Query)
	}
}

func TestTaskSubscriptionAndAPIErrorPropagation(t *testing.T) {
	h := &taskHTTP{responses: map[string]string{
		"POST /open-apis/task/v2/task_v2/task_subscription": `{"code":0,"data":{}}`,
		"GET /open-apis/task/v2/tasks/task-1":               `{"code":99991672,"msg":"task scope missing"}`,
		"DELETE /open-apis/im/v1/chats/oc_task":             `{"code":232003,"msg":"caller is not owner"}`,
	}}
	b, _ := newTestBot(t, WithHTTPClient(h))
	if err := b.SubscribeTasks(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, err := b.GetTask(context.Background(), "task-1")
	if code, ok := APICode(err); !ok || code != 99991672 || !strings.Contains(err.Error(), "task scope missing") {
		t.Fatalf("lost API error: %v", err)
	}
	err = b.DeleteTaskChat(context.Background(), "oc_task")
	if code, ok := APICode(err); !ok || code != 232003 {
		t.Fatalf("lost delete error: %v", err)
	}
}

func TestCreateTaskDistinguishesScopeRefusalFromUncertainFailure(t *testing.T) {
	for _, tc := range []struct {
		name       string
		response   string
		transport  error
		definitive bool
	}{
		{name: "missing scope", response: `{"code":99991672,"msg":"task:task:write is required"}`, definitive: true},
		{name: "unknown server error", response: `{"code":99999999,"msg":"unknown server failure"}`},
		{name: "network failure", transport: errors.New("connection reset by peer")},
		{name: "timeout", transport: context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &taskHTTP{responses: map[string]string{"POST /open-apis/task/v2/tasks": tc.response}, err: tc.transport}
			b, _ := newTestBot(t, WithHTTPClient(h))
			spec := tasks.TaskSpec{Title: "测试任务", OwnerID: "ou_owner", Key: "stable-key"}
			_, err := b.CreateTask(context.Background(), spec)
			var failure interface{ DefinitiveFailure() bool }
			if !errors.As(err, &failure) || failure.DefinitiveFailure() != tc.definitive {
				t.Fatalf("creation error = %v; want definitive refusal = %v", err, tc.definitive)
			}
			if !tc.definitive {
				return
			}
			// Replay the same request only after an explicit refusal and a
			// permission fix. The real HTTP/SDK wrapping must retain enough
			// information for task provisioning to permit this retry.
			h.mu.Lock()
			h.responses["POST /open-apis/task/v2/tasks"] = `{"code":0,"data":{"task":{"guid":"task-after-grant"}}}`
			h.mu.Unlock()
			created, err := b.CreateTask(context.Background(), spec)
			if err != nil || created.GUID != "task-after-grant" {
				t.Fatalf("create after granting scope = %+v, %v", created, err)
			}
		})
	}
}

func TestTaskEventUsesExistingDispatcher(t *testing.T) {
	b, _ := newTestBot(t)
	var got tasks.TaskEvent
	b.OnTaskEvent(func(_ context.Context, event tasks.TaskEvent) error { got = event; return nil })
	payload := []byte(`{"schema":"2.0","header":{"event_id":"event-task","event_type":"task.task.update_user_access_v2"},"event":{"task_guid":"task-1","event_types":["task_completed_update"]}}`)
	if _, err := b.ws.EventHandler().Do(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	if got.GUID != "task-1" {
		t.Fatalf("event = %+v", got)
	}
	want := errors.New("reconcile failed")
	b.OnTaskEvent(func(context.Context, tasks.TaskEvent) error { return want })
	if _, err := b.ws.EventHandler().Do(context.Background(), payload); !errors.Is(err, want) {
		t.Fatalf("lost callback error: %v", err)
	}
	for _, event := range []*larktask.P2TaskUpdateUserAccessV2{nil, {}, {Event: &larktask.P2TaskUpdateUserAccessV2Data{}}} {
		if err := b.handleTaskEvent(context.Background(), event); err != nil {
			t.Fatalf("empty event: %v", err)
		}
	}
}

func TestTaskChatsAllowUnmentionedMessagesOnlyWhenEnabled(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprint(enabled), func(t *testing.T) {
			b, _ := newTestBot(t, WithTaskChats(enabled))
			messages := make(chan Msg, 2)
			b.OnMessage(func(_ context.Context, m Msg) error { messages <- m; return nil })
			group := messagePayload("task-group", "ou_owner", "继续运行测试", map[string]string{"message_id": "om_task_group", "chat_type": "group"})
			if _, err := b.ws.EventHandler().Do(context.Background(), group); err != nil {
				t.Fatal(err)
			}
			if enabled {
				select {
				case m := <-messages:
					if m.Text != "继续运行测试" || m.ChatType != ChatGroup || m.MentionedBot {
						t.Fatalf("message = %+v", m)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("unmentioned task chat message was dropped")
				}
			} else {
				// A following DM proves the dispatcher/pipeline are running. The
				// group policy gate executes synchronously before enqueueing.
				if _, err := b.ws.EventHandler().Do(context.Background(), messagePayload("dm-after-group", "ou_owner", "dm", map[string]string{"message_id": "om_after_group"})); err != nil {
					t.Fatal(err)
				}
				select {
				case m := <-messages:
					if m.ChatType != ChatP2P {
						t.Fatalf("disabled task chats admitted group: %+v", m)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("no DM received")
				}
			}
		})
	}
}
