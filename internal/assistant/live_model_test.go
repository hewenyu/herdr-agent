package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

// Explicit opt-in: this test calls the configured model using synthetic input.
// Its task manager and project catalog are isolated; no Feishu messages, real
// workspaces, or user tasks can be created. Ordinary CI remains offline.
func TestLiveConfiguredModelCreatesIndependentProjects(t *testing.T) {
	configDir := os.Getenv("HERDR_AGENT_LIVE_CONFIG")
	if configDir == "" {
		t.Skip("set HERDR_AGENT_LIVE_CONFIG to opt into configured-model validation")
	}
	cfg, err := config.Load(configDir)
	if err != nil {
		t.Fatal("cannot load live model configuration")
	}
	if strings.TrimSpace(cfg.AI.APIKey) == "" {
		t.Fatal("live configuration is missing [ai].api_key; configure it locally, never paste credentials into test output")
	}
	engine, err := NewEngine(cfg.AI)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if parent := os.Getenv("HERDR_AGENT_LIVE_ARTIFACTS"); parent != "" {
		if err := os.MkdirAll(parent, 0700); err != nil {
			t.Fatal(err)
		}
		root, err = os.MkdirTemp(parent, "model-projects-")
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("isolated artifacts: %s", root)
	}
	h := newServiceHarness(t)
	h.manager.records = map[string]tasks.Record{}
	catalog := &serviceProjectCatalog{root: root, cfg: config.Tasks{Projects: map[string]config.Project{}}}
	backend, err := tasktools.New(tasktools.Options{OwnerID: "alice", EntryChatID: "entry", StatePath: h.operations,
		Projects: catalog, Manager: h.manager, Registry: serviceTestRegistry{}, Controller: h.controller})
	if err != nil {
		t.Fatal(err)
	}
	requests := []string{
		"创建一个新项目，使用codex，创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画，不用进行测试",
		"创建一个新项目，使用codex，创建一个HTML，内容是SVG绘制一个宇宙飞船的2D动画，不用进行测试",
	}
	type outcome struct {
		Request       string `json:"request"`
		Reply         string `json:"reply"`
		Project       string `json:"project"`
		TaskText      string `json:"task_text"`
		CodexExecuted bool   `json:"codex_executed"`
	}
	var outcomes []outcome
	for i, request := range requests {
		// Re-open the conversation between requests, as after a service restart.
		s, err := New(engine, backend, h.dir, cfg.AI.Timeout)
		if err != nil {
			t.Fatal(err)
		}
		answer := serviceReply(t, s, serviceMessage("alice", "entry", fmt.Sprintf("live-create-%d", i), request))
		if len(h.manager.created()) != i+1 || len(catalog.cfg.Projects) != i+1 {
			t.Fatalf("request %d did not create one independent project; model reply: %s", i+1, answer)
		}
		r, ok := h.manager.Get(fmt.Sprintf("created-%d", i+1))
		if !ok || r.Agent != "codex" || r.Project == "" {
			t.Fatal("created task did not retain the requested coding agent")
		}
		if i > 0 && outcomes[0].Project == r.Project {
			t.Fatal("second request reused the previous project")
		}
		result := outcome{Request: request, Reply: answer, Project: r.Project, TaskText: r.Title}
		if os.Getenv("HERDR_AGENT_LIVE_CODEX") == "1" {
			runLiveCodexArtifact(t, catalog.cfg.Projects[r.Project].Path, r.Title)
			result.CodexExecuted = true
		}
		outcomes = append(outcomes, result)
		data, _ := json.MarshalIndent(outcomes, "", "  ")
		if err := os.WriteFile(filepath.Join(root, "report.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("real model completed %d independent task creations; provider=%s model=%s", len(outcomes), cfg.AI.Provider, cfg.AI.Model)
}

func TestLiveCodexProducesSVG(t *testing.T) {
	if os.Getenv("HERDR_AGENT_LIVE_CODEX") != "1" {
		t.Skip("set HERDR_AGENT_LIVE_CODEX=1 to opt into isolated Codex execution")
	}
	dir := t.TempDir()
	if parent := os.Getenv("HERDR_AGENT_LIVE_ARTIFACTS"); parent != "" {
		if err := os.MkdirAll(parent, 0700); err != nil {
			t.Fatal(err)
		}
		var err error
		dir, err = os.MkdirTemp(parent, "codex-svg-")
		if err != nil {
			t.Fatal(err)
		}
	}
	runLiveCodexArtifact(t, dir, "创建一个HTML，内容是SVG绘制一个宇宙飞船的2D动画，不用进行测试")
}

func TestLiveConfiguredModelNotification(t *testing.T) {
	configDir := os.Getenv("HERDR_AGENT_LIVE_CONFIG")
	if configDir == "" {
		t.Skip("set HERDR_AGENT_LIVE_CONFIG to opt into configured-model validation")
	}
	cfg, err := config.Load(configDir)
	if err != nil {
		t.Fatal("cannot load live model configuration")
	}
	engine, err := NewEngine(cfg.AI)
	if err != nil {
		t.Fatal(err)
	}
	svc, event, dir := notificationTestSetup(t, engine)
	event.Kind = tasks.NotificationWelcome
	var sent []string
	sender := func(_ context.Context, chat, text string) (string, error) {
		if chat != event.ChatID || strings.TrimSpace(text) == "" {
			t.Fatal("invalid model-selected notification")
		}
		sent = append(sent, text)
		return fmt.Sprintf("isolated-notice-%d", len(sent)), nil
	}
	firstCount := 0
	for i := 0; i < 2; i++ {
		n, err := NewNotifier(engine, svc.backend, dir, cfg.AI.Timeout, svc.RecordDeliveredMessage)
		if err != nil {
			t.Fatal(err)
		}
		if err := n.Notify(context.Background(), event, sender); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			firstCount = len(sent)
		}
	}
	if len(sent) != firstCount {
		t.Fatal("reopened notifier repeated its model-selected notification")
	}
	t.Logf("real model notification decision persisted; isolated deliveries=%d, no Feishu send", len(sent))
}

func runLiveCodexArtifact(t *testing.T, dir, task string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	// Keep the configured provider and its authentication together; only disable
	// hooks for this execution. Files stay in the isolated project directory.
	cmd := exec.CommandContext(ctx, "codex", "exec", "--disable", "hooks", "--ephemeral", "--skip-git-repo-check",
		"--sandbox", "workspace-write", "-c", `approval_policy="never"`, "--json", "-")
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(task + "\n在当前隔离目录直接创建 index.html，所有 SVG/CSS/动画内嵌，不用外部资源。不要运行测试，不启动服务或浏览器。")
	output, err := cmd.CombinedOutput()
	if writeErr := os.WriteFile(filepath.Join(dir, "codex-execution.jsonl"), output, 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	if err != nil {
		t.Fatalf("isolated Codex execution failed: %v; see codex-execution.jsonl", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "index.html"))
	if err != nil || !strings.Contains(strings.ToLower(string(data)), "<svg") {
		t.Fatal("Codex did not produce the requested HTML containing SVG")
	}
	t.Logf("Codex produced %s (%d bytes); no browser or local server was started", filepath.Join(dir, "index.html"), len(data))
}
