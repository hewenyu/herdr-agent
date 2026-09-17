package assistant

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func writeTaskToolResponse(w http.ResponseWriter, provider, name string, arguments map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	if provider == "openai-responses" {
		args, _ := json.Marshal(arguments)
		json.NewEncoder(w).Encode(map[string]any{"id": "resp", "object": "response", "status": "completed", "model": "configured-model", "created_at": 1,
			"output": []any{map[string]any{"type": "function_call", "id": "fc", "call_id": "call", "name": name, "arguments": string(args), "status": "completed"}}})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"id": "msg", "type": "message", "role": "assistant", "model": "configured-model", "stop_reason": "tool_use",
		"content": []any{map[string]any{"type": "tool_use", "id": "call", "name": name, "input": arguments}},
		"usage":   map[string]int{"input_tokens": 1, "output_tokens": 1}})
}

func TestModelCanCorrectRejectedWriteThroughBothProtocolToolLoops(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			h := newServiceHarness(t)
			var requests atomic.Int32
			const final = "  已根据项目查询结果登记任务。\n"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				switch requests.Add(1) {
				case 1:
					writeTaskToolResponse(w, provider, "herdr_create", map[string]any{"project": "missing", "text": "build SVG"})
				case 2:
					if !strings.Contains(string(body), "项目未配置") || !strings.Contains(string(body), `\"execution\":\"not_executed\"`) || len(h.manager.created()) != 0 {
						t.Error("model did not receive the rejected write and its execution certainty")
					}
					writeTaskToolResponse(w, provider, "herdr_projects", map[string]any{})
				case 3:
					writeTaskToolResponse(w, provider, "herdr_create", map[string]any{"project": "project", "text": "build SVG"})
				case 4:
					if len(h.manager.created()) != 1 || !strings.Contains(string(body), "created-1") {
						t.Error("corrected model call was frozen or its receipt was lost")
					}
					writeModelResponse(w, provider, false, final)
				default:
					t.Error("unexpected extra model call")
					writeModelResponse(w, provider, false, "unexpected")
				}
			}))
			defer server.Close()
			e, err := NewEngine(engineConfig(provider, server.URL))
			if err != nil {
				t.Fatal(err)
			}
			answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "correction", "在配置的项目中创建 SVG 任务"))
			if answer != final || requests.Load() != 4 || len(h.manager.created()) != 1 {
				t.Fatalf("model correction or final answer changed: %q requests=%d", answer, requests.Load())
			}
		})
	}
}
