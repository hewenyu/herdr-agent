package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/schema"
	"github.com/cloudwego/eino/schema/claude"
	"github.com/cloudwego/eino/schema/openai"
	"github.com/hewenyu/herdr-agent/internal/config"
)

func summaryRequestHasTools(t *testing.T, body []byte) bool {
	t.Helper()
	var request struct {
		Tools []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatal(err)
	}
	return len(request.Tools) > 0
}

func writeTruncatedSummary(w http.ResponseWriter, provider string) {
	response := httptest.NewRecorder()
	writeModelResponse(response, provider, false, "用户要求不测试。")
	var body map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if provider == "openai-responses" {
		body["status"] = "incomplete"
		body["incomplete_details"] = map[string]string{"reason": "max_output_tokens"}
	} else {
		body["stop_reason"] = "max_tokens"
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func TestSummaryRequiresCompletedProviderMetadata(t *testing.T) {
	for _, test := range []struct {
		name  string
		meta  *schema.AgenticResponseMeta
		valid bool
	}{
		{name: "metadata-free local model", valid: true},
		{name: "responses completed", meta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{Status: openai.ResponseStatusCompleted}}, valid: true},
		{name: "responses incomplete", meta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{Status: openai.ResponseStatusIncomplete}}},
		{name: "responses incomplete details despite completed", meta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{Status: openai.ResponseStatusCompleted, IncompleteDetails: &openai.IncompleteDetails{Reason: "max_output_tokens"}}}},
		{name: "responses error despite completed", meta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{Status: openai.ResponseStatusCompleted, Error: &openai.ResponseError{Message: "failed"}}}},
		{name: "responses failed", meta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{Status: openai.ResponseStatusFailed}}},
		{name: "responses in progress", meta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{Status: openai.ResponseStatusInProgress}}},
		{name: "responses missing completion", meta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{}}},
		{name: "messages completed", meta: &schema.AgenticResponseMeta{ClaudeExtension: &claude.ResponseMetaExtension{StopReason: "end_turn"}}, valid: true},
		{name: "messages output limit", meta: &schema.AgenticResponseMeta{ClaudeExtension: &claude.ResponseMetaExtension{StopReason: "max_tokens"}}},
		{name: "messages paused", meta: &schema.AgenticResponseMeta{ClaudeExtension: &claude.ResponseMetaExtension{StopReason: "pause_turn"}}},
		{name: "messages tool use", meta: &schema.AgenticResponseMeta{ClaudeExtension: &claude.ResponseMetaExtension{StopReason: "tool_use"}}},
		{name: "messages refused", meta: &schema.AgenticResponseMeta{ClaudeExtension: &claude.ResponseMetaExtension{StopReason: "refusal"}}},
		{name: "messages stop sequence", meta: &schema.AgenticResponseMeta{ClaudeExtension: &claude.ResponseMetaExtension{StopReason: "stop_sequence"}}},
		{name: "messages missing completion", meta: &schema.AgenticResponseMeta{ClaudeExtension: &claude.ResponseMetaExtension{}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			message := &schema.AgenticMessage{Role: schema.AgenticRoleTypeAssistant, ResponseMeta: test.meta,
				ContentBlocks: []*schema.ContentBlock{schema.NewContentBlock(&schema.AssistantGenText{Text: "不测试。"})}}
			err := validSummary(message, 1024)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v error=%v", test.valid, err)
			}
		})
	}
}

func TestSummaryRejectsPartialTextFollowedByRefusal(t *testing.T) {
	message := &schema.AgenticMessage{Role: schema.AgenticRoleTypeAssistant,
		ResponseMeta: &schema.AgenticResponseMeta{OpenAIExtension: &openai.ResponseMetaExtension{Status: openai.ResponseStatusCompleted}},
		ContentBlocks: []*schema.ContentBlock{
			schema.NewContentBlock(&schema.AssistantGenText{Text: "只整理了部分要求。"}),
			schema.NewContentBlock(&schema.AssistantGenText{OpenAIExtension: &openai.AssistantGenTextExtension{Refusal: &openai.OutputRefusal{Reason: "cannot complete"}}}),
		}}
	if !errors.Is(validSummary(message, 1024), errMemoryFailed) {
		t.Fatal("partial text with a refusal was accepted as complete memory")
	}
}

func TestNativeMemoryRejectsShortTruncatedSummariesWithoutDiscardingHistory(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		for _, recover := range []bool{false, true} {
			t.Run(provider+"/recover="+map[bool]string{true: "true", false: "false"}[recover], func(t *testing.T) {
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					body, _ := io.ReadAll(r.Body)
					if summaryRequestHasTools(t, body) {
						t.Error("summary request exposed tools")
					}
					if requests.Add(1) == 2 && recover {
						writeModelResponse(w, provider, false, "用户要求不测试；还有未回答的项目名称问题。")
						return
					}
					writeTruncatedSummary(w, provider)
				}))
				defer server.Close()
				engine, err := NewEngine(engineConfig(provider, server.URL))
				if err != nil {
					t.Fatal(err)
				}
				history := memoryTestHistory(20)
				original := append([]Message(nil), history...)
				const previous = "原摘要：使用 Codex，项目名待确认。"
				fixed := ContextInputBudget(32768) - memoryHistoryCost(previous, history)
				summary, recent, err := memoryPrepare(context.Background(), engine, previous, history, fixed, 32768)
				if requests.Load() != 2 || !reflect.DeepEqual(history, original) {
					t.Fatalf("unexpected retries or source mutation: requests=%d err=%v", requests.Load(), err)
				}
				if recover {
					if err != nil || summary != "用户要求不测试；还有未回答的项目名称问题。" || len(recent) != 9 {
						t.Fatalf("complete retry not committed: summary=%q recent=%d err=%v", summary, len(recent), err)
					}
				} else if !errors.Is(err, errMemoryFailed) || summary != previous || !reflect.DeepEqual(recent, original) {
					t.Fatalf("truncated prefix replaced complete history: summary=%q err=%v", summary, err)
				}
			})
		}
	}
}

func TestNativeRuntimeRejectsShortTruncatedSummariesWithoutReplayingTools(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			var summaryRequests, ordinaryRequests, operations atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if summaryRequestHasTools(t, body) {
					ordinaryRequests.Add(1)
					writeModelResponse(w, provider, true, "execute-once")
					return
				}
				summaryRequests.Add(1)
				writeTruncatedSummary(w, provider)
			}))
			defer server.Close()
			cfg := engineConfig(provider, server.URL)
			cfg.ContextTokens = config.MinAIContextTokens
			engine, err := NewEngine(cfg)
			if err != nil {
				t.Fatal(err)
			}
			definitions := engineTools()
			definitions[0].ReadOnly = false
			_, err = engine.Reply(context.Background(), []Message{{Role: "user", Content: "只创建一次任务"}}, definitions,
				func(context.Context, string, json.RawMessage) (any, error) {
					operations.Add(1)
					return map[string]string{"receipt": "created-task-1", "details": strings.Repeat("详细记录", 2000)}, nil
				})
			if !errors.Is(err, ErrContextBudget) || summaryRequests.Load() != 2 || ordinaryRequests.Load() != 1 || operations.Load() != 1 {
				t.Fatalf("truncated runtime summary continued/replayed: ordinary=%d summaries=%d operations=%d err=%v", ordinaryRequests.Load(), summaryRequests.Load(), operations.Load(), err)
			}
			// Exercise the rewrite hook directly as well: rejection must leave
			// the complete source state available for reporting and recovery.
			initial, _ := agenticHistory([]Message{{Role: "user", Content: "只创建一次任务"}})
			var compressed atomic.Bool
			mw, err := engine.(*einoEngine).runtimeSummarizer(context.Background(), initial, nil, &compressed)
			if err != nil {
				t.Fatal(err)
			}
			state := &adk.TypedChatModelAgentState[*schema.AgenticMessage]{Messages: append(initial, schema.UserAgenticMessage(strings.Repeat("已执行的工具结果", 1000)))}
			before, _ := json.Marshal(state)
			_, next, err := mw.BeforeModelRewriteState(context.Background(), state, &adk.TypedModelContext[*schema.AgenticMessage]{})
			after, _ := json.Marshal(state)
			if !errors.Is(err, ErrContextBudget) || next != nil || compressed.Load() || string(before) != string(after) {
				t.Fatalf("truncated summary modified source state: %v", err)
			}
		})
	}
}

func TestNativeMemorySummaryKeepsCompleteInputAndRetriesOnlyOnce(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		for _, recover := range []bool{false, true} {
			t.Run(provider+"/recover="+map[bool]string{true: "true", false: "false"}[recover], func(t *testing.T) {
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					body, _ := io.ReadAll(r.Body)
					if summaryRequestHasTools(t, body) || !strings.Contains(string(body), "MIDDLE_REQUIREMENT_NO_TESTS") || !strings.Contains(string(body), "之前决定：使用 Codex") {
						t.Error("native summary lost full source or exposed tools")
					}
					if requests.Add(1) == 2 && recover {
						writeModelResponse(w, provider, false, "使用 Codex，不测试，项目名待确认。")
					} else {
						writeModelResponse(w, provider, false, strings.Repeat("长摘要", 1000))
					}
				}))
				defer server.Close()
				engine, err := NewEngine(engineConfig(provider, server.URL))
				if err != nil {
					t.Fatal(err)
				}
				parts := []memoryExcerpt{{Role: "user", Content: strings.Repeat("原始要求", 1000) + "MIDDLE_REQUIREMENT_NO_TESTS" + strings.Repeat("后续要求", 1000)}}
				summary, err := memorySummarize(context.Background(), engine, "之前决定：使用 Codex", parts, 2048, 50000)
				if requests.Load() != 2 {
					t.Fatalf("native retry count=%d", requests.Load())
				}
				if recover {
					if err != nil || summary != "使用 Codex，不测试，项目名待确认。" {
						t.Fatalf("native summary=%q error=%v", summary, err)
					}
				} else if !errors.Is(err, errMemoryFailed) || summary != "" {
					t.Fatalf("oversized native summary silently truncated: %q %v", summary, err)
				}
			})
		}
	}
}

func TestNativeRuntimeSummarizationBothProtocolsKeepsInputAndDoesNotReplayMutation(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			var summaries, ordinary, operations atomic.Int32
			const currentInput = "创建任务，项目 pelican-bike-svg，使用 Codex，不要测试"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if !summaryRequestHasTools(t, body) {
					summaries.Add(1)
					if !strings.Contains(string(body), "工具调用与结果都已经发生") {
						t.Error("summary did not mark tools as already executed")
					}
					writeModelResponse(w, provider, false, "工具 list_tasks 已执行，返回 created-task-1；不得重复操作。用户要求不测试。")
					return
				}
				step := ordinary.Add(1)
				if !strings.Contains(string(body), currentInput) {
					t.Error("runtime compaction dropped or shortened current user input")
				}
				if step == 1 {
					writeModelResponse(w, provider, true, "execute-once")
					return
				}
				if !strings.Contains(string(body), "本轮执行记录摘要") || !strings.Contains(string(body), "created-task-1") {
					t.Error("native middleware did not resume with compact execution history")
				}
				if step == 2 {
					// Simulate a model repeating a mutation after compaction. The
					// recorded result must be returned without invoking the backend.
					writeModelResponse(w, provider, true, "execute-once")
					return
				}
				writeModelResponse(w, provider, false, "任务 created-task-1 已登记。")
			}))
			defer server.Close()
			cfg := engineConfig(provider, server.URL)
			cfg.ContextTokens = config.MinAIContextTokens
			engine, err := NewEngine(cfg)
			if err != nil {
				t.Fatal(err)
			}
			definitions := engineTools()
			definitions[0].ReadOnly = false
			answer, err := engine.Reply(context.Background(), []Message{{Role: "system", Content: "只处理用户明确要求。"}, {Role: "user", Content: currentInput}}, definitions,
				func(context.Context, string, json.RawMessage) (any, error) {
					operations.Add(1)
					return map[string]string{"receipt": "created-task-1", "details": strings.Repeat("历史记录", 2000)}, nil
				})
			if err != nil || answer != "任务 created-task-1 已登记。" || operations.Load() != 1 || ordinary.Load() != 3 || summaries.Load() < 2 {
				t.Fatalf("answer=%q error=%v mutations=%d model=%d summaries=%d", answer, err, operations.Load(), ordinary.Load(), summaries.Load())
			}
		})
	}
}

func TestNativeRuntimeSummaryFailureLeavesStateUntouched(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "failed summary "+testAPIKey, http.StatusUnauthorized)
	}))
	defer server.Close()
	configured, err := NewEngine(engineConfig("openai-responses", server.URL))
	if err != nil {
		t.Fatal(err)
	}
	engine := configured.(*einoEngine)
	engine.inputBudget = 8192
	initial, _ := agenticHistory([]Message{{Role: "system", Content: "规则"}, {Role: "user", Content: "创建一次"}})
	var compressed atomic.Bool
	mw, err := engine.runtimeSummarizer(context.Background(), initial, nil, &compressed)
	if err != nil {
		t.Fatal(err)
	}
	messages := append(append([]*schema.AgenticMessage(nil), initial...), schema.UserAgenticMessage(strings.Repeat("已经执行的工具结果", 1000)))
	state := &adk.TypedChatModelAgentState[*schema.AgenticMessage]{Messages: messages}
	before, _ := json.Marshal(state)
	_, next, err := mw.BeforeModelRewriteState(context.Background(), state, &adk.TypedModelContext[*schema.AgenticMessage]{})
	after, _ := json.Marshal(state)
	if !errors.Is(err, ErrContextBudget) || next != nil || compressed.Load() || string(before) != string(after) || strings.Contains(err.Error(), testAPIKey) {
		t.Fatalf("failed middleware mutated source state or leaked error: %v", err)
	}
}
