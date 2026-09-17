package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/schema"
	"github.com/hewenyu/herdr-agent/internal/config"
)

func TestEngineRejectsOversizedHistoryAndSchemasBeforeHTTP(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				writeModelResponse(w, provider, false, "unexpected")
			}))
			defer server.Close()
			cfg := engineConfig(provider, server.URL)
			cfg.ContextTokens = config.MinAIContextTokens
			engine, err := NewEngine(cfg)
			if err != nil {
				t.Fatal(err)
			}
			_, err = engine.Reply(context.Background(), []Message{{Role: "user", Content: strings.Repeat("项目", cfg.ContextTokens)}}, nil, nil)
			if !errors.Is(err, ErrContextBudget) || requests.Load() != 0 {
				t.Fatalf("oversized history: requests=%d error=%v", requests.Load(), err)
			}
			definitions := engineTools()
			definitions[0].InputSchema["description"] = strings.Repeat("large tool schema", cfg.ContextTokens)
			_, err = engine.Reply(context.Background(), []Message{{Role: "user", Content: "列任务"}}, definitions,
				func(context.Context, string, json.RawMessage) (any, error) {
					t.Error("tool ran despite oversized initial request")
					return nil, nil
				})
			if !errors.Is(err, ErrContextBudget) || requests.Load() != 0 {
				t.Fatalf("oversized tools: requests=%d error=%v", requests.Load(), err)
			}
		})
	}
}

func TestEngineFailedCompactionAfterToolResultDoesNotRepeatOperation(t *testing.T) {
	for _, provider := range []string{"openai-responses", "anthropic-messages"} {
		t.Run(provider, func(t *testing.T) {
			var requests, operations atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				if requests.Add(1) > 1 && summaryRequestHasTools(t, body) {
					t.Error("summary request exposed tools")
				}
				// The summarizer deliberately receives an invalid tool-call
				// response. It may retry once, but cannot execute that call.
				writeModelResponse(w, provider, true, "execute-once")
			}))
			defer server.Close()
			cfg := engineConfig(provider, server.URL)
			cfg.ContextTokens = config.MinAIContextTokens
			engine, err := NewEngine(cfg)
			if err != nil {
				t.Fatal(err)
			}
			_, err = engine.Reply(context.Background(), []Message{{Role: "user", Content: "新建任务"}}, engineTools(),
				func(context.Context, string, json.RawMessage) (any, error) {
					operations.Add(1)
					return map[string]string{"receipt": "created", "details": strings.Repeat("too much context", cfg.ContextTokens)}, nil
				})
			if !errors.Is(err, ErrContextBudget) || requests.Load() != 3 || operations.Load() != 1 {
				t.Fatalf("requests=%d operations=%d error=%v", requests.Load(), operations.Load(), err)
			}
		})
	}
}

func TestEngineContextBudgetStreamRejectsBeforeProvider(t *testing.T) {
	// A nil provider makes reaching the delegate a failure, including for Stream
	// which the current non-streaming service does not otherwise exercise.
	model := &contextBudgetModel{inputBudget: ContextInputBudget(config.MinAIContextTokens)}
	_, err := model.Stream(context.Background(), []*schema.AgenticMessage{schema.UserAgenticMessage(strings.Repeat("x", config.MinAIContextTokens))})
	if !errors.Is(err, ErrContextBudget) {
		t.Fatalf("stream budget error=%v", err)
	}
}

func TestContextEstimateAccountsForUTF8AndSchemas(t *testing.T) {
	history := []Message{{Role: "user", Content: "先讨论需求，暂时不要执行。", Kind: "dialogue"}}
	small := EstimateContextTokens(history, nil)
	history[0].Content += strings.Repeat("中文", 100)
	large := EstimateContextTokens(history, nil)
	if large-small < len(strings.Repeat("中文", 100)) {
		t.Fatal("UTF-8 history growth was undercounted")
	}
	if EstimateContextTokens(history, engineTools()) <= large {
		t.Fatal("tool schemas were omitted from context estimate")
	}
	if ContextInputBudget(0) != config.DefaultAIContextTokens {
		t.Fatal("zero configuration did not use the default input threshold")
	}
}
