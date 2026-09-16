package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

const testAPIKey = "test-provider-key-must-never-appear-in-errors"

func engineTools() []tasktools.Tool {
	return []tasktools.Tool{{
		Name: "list_tasks", Description: "List the current user's tasks", ReadOnly: true,
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{"marker": map[string]any{"type": "string"}}, "additionalProperties": false},
	}}
}

func engineConfig(provider, root string) config.AI {
	return config.AI{Enabled: true, Provider: provider, Model: "configured-model", BaseURL: root + "/v1", APIKey: testAPIKey, Timeout: 5 * time.Second}
}

func writeModelResponse(w http.ResponseWriter, provider string, toolCall bool, marker string) {
	w.Header().Set("Content-Type", "application/json")
	if provider == "openai-responses" {
		output := []any{map[string]any{
			"id": "msg_final", "type": "message", "status": "completed", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": marker, "annotations": []any{}}},
		}}
		if toolCall {
			args, _ := json.Marshal(map[string]string{"marker": marker})
			output = []any{map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "list_tasks", "arguments": string(args), "status": "completed"}}
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": "resp_1", "object": "response", "created_at": 1, "status": "completed", "model": "configured-model", "output": output,
			"usage": map[string]int{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
		})
		return
	}
	content := []any{map[string]any{"type": "text", "text": marker}}
	stop := "end_turn"
	if toolCall {
		content = []any{map[string]any{"type": "tool_use", "id": "call_1", "name": "list_tasks", "input": map[string]string{"marker": marker}}}
		stop = "tool_use"
	}
	json.NewEncoder(w).Encode(map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant", "model": "configured-model", "content": content, "stop_reason": stop,
		"usage": map[string]int{"input_tokens": 1, "output_tokens": 1},
	})
}

func TestEngineRealProtocolsToolRoundTripAndHistory(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				path, header := "/proxy/v1/responses", "Authorization"
				key := "Bearer " + testAPIKey
				if provider == "anthropic-messages" {
					path, header, key = "/proxy/v1/messages", "X-Api-Key", testAPIKey
				}
				if r.Method != http.MethodPost || r.URL.Path != path || r.Header.Get(header) != key {
					t.Errorf("wrong method/path/auth (method=%s path=%s)", r.Method, r.URL.Path)
				}
				var request map[string]any
				if err := json.Unmarshal(body, &request); err != nil {
					t.Error(err)
				}
				if request["model"] != "configured-model" || !strings.Contains(string(body), "之前的问题") || !strings.Contains(string(body), "之前的答复") {
					t.Error("configured model or conversation history was lost")
				}
				if !strings.Contains(string(body), "list_tasks") || !strings.Contains(string(body), "marker") {
					t.Error("dynamic tool schema was lost")
				}
				if requests.Add(1) == 1 {
					writeModelResponse(w, provider, true, "request-marker")
				} else {
					if !strings.Contains(string(body), "current-task-1") || !strings.Contains(string(body), "call_1") {
						t.Error("tool result and correlation ID missing from follow-up")
					}
					writeModelResponse(w, provider, false, "正在进行：current-task-1")
				}
			}))
			defer server.Close()
			engine, err := NewEngine(engineConfig(provider, server.URL+"/proxy"))
			if err != nil {
				t.Fatal(err)
			}
			var calls int
			answer, err := engine.Reply(context.Background(), []Message{
				{Role: "system", Content: "使用工具查询任务。"}, {Role: "user", Content: "之前的问题"},
				{Role: "assistant", Content: "之前的答复"}, {Role: "user", Content: "现在正在进行哪些任务？"},
			}, engineTools(), func(_ context.Context, name string, args json.RawMessage) (any, error) {
				calls++
				var input map[string]string
				if err := json.Unmarshal(args, &input); err != nil || name != "list_tasks" || input["marker"] != "request-marker" {
					t.Errorf("wrong tool dispatch: name=%s args=%s", name, args)
				}
				return map[string]any{"tasks": []string{"current-task-1"}}, nil
			})
			if err != nil || answer != "正在进行：current-task-1" || calls != 1 || requests.Load() != 2 {
				t.Fatalf("answer=%q err=%v calls=%d requests=%d", answer, err, calls, requests.Load())
			}
		})
	}
}

func TestEngineToolBusinessErrorRemainsModelContext(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if requests.Add(1) == 1 {
			writeModelResponse(w, "openai-responses", true, "")
			return
		}
		if !strings.Contains(string(body), "unknown project") || strings.Contains(string(body), testAPIKey) {
			t.Error("tool error was not retained and redacted")
		}
		writeModelResponse(w, "openai-responses", false, "该项目尚未配置，请先选择项目。")
	}))
	defer server.Close()
	engine, err := NewEngine(engineConfig("openai-responses", server.URL))
	if err != nil {
		t.Fatal(err)
	}
	answer, err := engine.Reply(context.Background(), []Message{{Role: "user", Content: "建任务"}}, engineTools(),
		func(context.Context, string, json.RawMessage) (any, error) {
			return nil, errors.New("unknown project " + testAPIKey)
		})
	if err != nil || !strings.Contains(answer, "尚未配置") {
		t.Fatalf("answer=%q error=%v", answer, err)
	}
}

func TestEngineProviderErrorsAreSanitized(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(map[string]any{"type": "error", "error": map[string]string{"type": "authentication_error", "message": "echoed request key " + testAPIKey}})
			}))
			defer server.Close()
			engine, err := NewEngine(engineConfig(provider, server.URL))
			if err != nil {
				t.Fatal(err)
			}
			answer, err := engine.Reply(context.Background(), []Message{{Role: "user", Content: "查询任务"}}, nil, nil)
			if !errors.Is(err, errModelAuth) || answer != "" || strings.Contains(err.Error(), testAPIKey) || strings.Contains(err.Error(), server.URL) {
				t.Fatalf("unsafe or incorrectly classified provider error: %v", err)
			}
		})
	}
}

func TestEngineCancellation(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			entered := make(chan struct{})
			release := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				select {
				case <-r.Context().Done():
				case <-release:
				}
			}))
			defer server.Close()
			defer close(release)
			engine, err := NewEngine(engineConfig(provider, server.URL))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := engine.Reply(ctx, []Message{{Role: "user", Content: "查询任务"}}, nil, nil)
				done <- err
			}()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("provider was never called")
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation = %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("cancellation did not stop the model request")
			}
		})
	}
}

func TestEngineDoesNotFollowRedirects(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			var leaked atomic.Bool
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true) }))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
			}))
			defer server.Close()
			engine, err := NewEngine(engineConfig(provider, server.URL))
			if err != nil {
				t.Fatal(err)
			}
			_, err = engine.Reply(context.Background(), []Message{{Role: "user", Content: "查询任务"}}, nil, nil)
			if err == nil || leaked.Load() {
				t.Fatalf("redirect followed=%v, error=%v", leaked.Load(), err)
			}
		})
	}
}

func TestEngineToolLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeModelResponse(w, "openai-responses", true, "repeat")
	}))
	defer server.Close()
	engine, err := NewEngine(engineConfig("openai-responses", server.URL))
	if err != nil {
		t.Fatal(err)
	}
	var count atomic.Int32
	_, err = engine.Reply(context.Background(), []Message{{Role: "user", Content: "查询任务"}}, engineTools(),
		func(context.Context, string, json.RawMessage) (any, error) { count.Add(1); return "result", nil })
	if !errors.Is(err, errToolLimit) || count.Load() != maxToolCalls {
		t.Fatalf("calls=%d error=%v", count.Load(), err)
	}
}

func TestEngineConcurrentTurnsKeepToolBindingsSeparate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		marker := "turn-A"
		if strings.Contains(string(body), "turn-B") {
			marker = "turn-B"
		}
		writeModelResponse(w, "openai-responses", !strings.Contains(string(body), "function_call_output"), marker)
	}))
	defer server.Close()
	engine, err := NewEngine(engineConfig("openai-responses", server.URL))
	if err != nil {
		t.Fatal(err)
	}
	var entered atomic.Int32
	gate := make(chan struct{})
	var wg sync.WaitGroup
	for _, marker := range []string{"turn-A", "turn-B"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answer, err := engine.Reply(context.Background(), []Message{{Role: "user", Content: marker}}, engineTools(),
				func(ctx context.Context, _ string, args json.RawMessage) (any, error) {
					if !strings.Contains(string(args), marker) {
						t.Errorf("%s received another turn's tool arguments", marker)
						return nil, fmt.Errorf("wrong turn binding")
					}
					if entered.Add(1) == 2 {
						close(gate)
					}
					select {
					case <-gate:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
					return marker, nil
				})
			if err != nil || answer != marker {
				t.Errorf("%s answer=%q error=%v", marker, answer, err)
			}
		}()
	}
	wg.Wait()
}
