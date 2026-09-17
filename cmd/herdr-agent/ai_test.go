package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// Exercise the configured serve wiring, Eino's real Responses adapter, the
// actual task query tool, and the Feishu reply path without external services.
func TestServeNaturalLanguageQueriesActualConfiguredProjects(t *testing.T) {
	// A fresh installation has no repository .env. An obsolete process-level
	// key must not override the model credential saved in config.toml.
	t.Chdir(t.TempDir())
	t.Setenv("HERDR_AGENT_AI_API_KEY", "obsolete-environment-key")
	h, hooks, p := newServeHarness(t)
	enableServeTasks(t, h)
	h.d.Client = &taskServeClient{RecordingClient: h.rc}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer test-model-key" {
			t.Errorf("unexpected provider request: %s", r.URL.Path)
		}
		data, _ := io.ReadAll(r.Body)
		if strings.Contains(string(data), h.d.Cfg.Tasks.Projects["demo"].Path) {
			t.Error("query exported private project path")
		}
		var output any
		if calls.Add(1) == 1 {
			if !strings.Contains(string(data), "herdr_projects") || !strings.Contains(string(data), "现在可以操作哪些项目") {
				t.Error("model did not receive message and task tools")
			}
			output = []any{map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "herdr_projects", "arguments": "{}", "status": "completed"}}
		} else {
			if !strings.Contains(string(data), "function_call_output") || !strings.Contains(string(data), "demo") {
				t.Error("real configured projects were not returned to the model")
			}
			output = []any{map[string]any{"id": "msg_final", "type": "message", "status": "completed", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "可以操作 demo 项目，默认使用 Claude。", "annotations": []any{}}}}}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "resp_test", "object": "response", "created_at": 1, "status": "completed", "model": "test-model", "output": output, "usage": map[string]any{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}})
	}))
	defer provider.Close()
	modelConfig := `[ai]
enabled = true
provider = "openai-responses"
model = "test-model"
base_url = "` + provider.URL + `/v1"
api_key = "test-model-key"
timeout = "1m"
`
	if err := os.WriteFile(filepath.Join(h.d.StateDir, config.ConfigFileName), []byte(modelConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(h.d.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	h.d.Cfg.AI = loaded.AI
	bot := taskBotForServe(p)
	hooks.newBot = func(config.Config, *slog.Logger) (lark.Bot, error) { return bot, nil }
	ctx, cancel := context.WithCancel(context.Background())
	s := buildForTest(t, ctx, h, hooks)
	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("shutdown: %v", err)
			}
		case <-time.After(waitFor):
			t.Error("serve did not stop")
		}
	})
	select {
	case <-bot.started:
	case <-time.After(waitFor):
		t.Fatal("bot never started")
	}
	bot.taskMu.Lock()
	message := bot.message
	bot.taskMu.Unlock()
	in := lark.Msg{EventID: "ai-event", MessageID: "ai-message", ChatID: h.d.Cfg.Feishu.NotifyChatID, ChatType: lark.ChatP2P, UserID: h.d.Cfg.Feishu.AllowedOpenIDs[0], Text: "现在可以操作哪些项目"}
	if err := message(ctx, in); err != nil {
		t.Fatal(err)
	}
	select {
	case out := <-bot.replies:
		if out.ChatID != in.ChatID || !strings.Contains(out.Markdown+out.Text, "demo") {
			t.Fatalf("AI reply lost: %+v", out)
		}
	case <-time.After(waitFor):
		t.Fatal("no AI reply")
	}
	if calls.Load() != 2 {
		t.Fatalf("model calls = %d, want tool call and final response", calls.Load())
	}
	// Feishu can deliver one message under another event ID. Its saved turn
	// receipt must prevent a second inference or second task operation.
	in.EventID = "ai-event-redelivered"
	if err := message(ctx, in); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("redelivered message repeated model/tool work")
	}
}
