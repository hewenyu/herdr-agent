package tasktools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/projects"
)

func TestProjectToolsReadLatestLocalCatalog(t *testing.T) {
	s, _, _ := harness(t)
	catalog, err := projects.Open(t.TempDir(), config.Default().Tasks)
	if err != nil {
		t.Fatal(err)
	}
	s.opts.Projects = catalog
	if err := catalog.Put("frontend", config.Project{Directories: []string{t.TempDir(), t.TempDir()}, Agent: "claude"}, true); err != nil {
		t.Fatal(err)
	}
	if err := catalog.SetBypass(false); err != nil {
		t.Fatal(err)
	}
	result, err := call(s, "herdr_projects", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(result)
	var rows []struct {
		Name    string `json:"name"`
		Agent   string `json:"default_agent"`
		Default bool   `json:"default"`
		Count   int    `json:"directory_count"`
		Bypass  bool   `json:"bypass"`
	}
	if err := json.Unmarshal(body, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Name != "frontend" || rows[0].Agent != "claude" || !rows[0].Default || rows[0].Count != 2 || rows[0].Bypass {
		t.Fatalf("stale catalog: %s", body)
	}
	if strings.Contains(string(body), catalog.Snapshot().Projects["frontend"].Path) {
		t.Fatal("local path exposed to conversational model")
	}
	if _, err := call(s, "herdr_create", map[string]any{"request_id": "use-new-config-1", "project": "frontend", "text": "implement task"}); err != nil {
		t.Fatal(err)
	}
	if err := catalog.Delete("frontend"); err != nil {
		t.Fatal(err)
	}
	if _, err := call(s, "herdr_create", map[string]any{"request_id": "use-deleted-config", "project": "frontend", "text": "implement task"}); err == nil {
		t.Fatal("deleted project remained available")
	}
}

func TestOnlyExplicitNewProjectCreatesDirectoryAndReplayIsDurable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s, m, _ := harness(t)
	stateDir := t.TempDir()
	catalog, err := projects.Open(stateDir, config.Default().Tasks)
	if err != nil {
		t.Fatal(err)
	}
	s.opts.Projects = catalog
	args := map[string]any{"request_id": "create-new-project", "project": "my-new-app", "agent": "claude", "text": "build an app"}
	if _, err := call(s, "herdr_create", args); err == nil {
		t.Fatal("unknown project silently created")
	}
	if _, err := os.Stat(catalog.Root()); !os.IsNotExist(err) {
		t.Fatalf("implicit directory creation: %v", err)
	}
	args["new_project"] = true
	first, err := call(s, "herdr_create", args)
	if err != nil {
		t.Fatal(err)
	}
	wantPath := filepath.Join(catalog.Root(), "my-new-app")
	info, err := os.Stat(wantPath)
	if err != nil || !info.IsDir() {
		t.Fatalf("new project directory absent: %v", err)
	}
	if m.creates != 1 {
		t.Fatalf("task creates=%d", m.creates)
	}
	reopenedCatalog, err := projects.Open(stateDir, config.Default().Tasks)
	if err != nil {
		t.Fatal(err)
	}
	opts := s.opts
	opts.Projects = reopenedCatalog
	restarted, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	second, err := call(restarted, "herdr_create", args)
	if err != nil {
		t.Fatal(err)
	}
	if !second.(receipt).Replayed || first.(receipt).Task.ID != second.(receipt).Task.ID || m.creates != 1 {
		t.Fatal("replay created duplicate task or project")
	}
	args["request_id"] = "separate-create-project"
	if _, err := call(restarted, "herdr_create", args); err == nil {
		t.Fatal("explicit new project adopted an existing project")
	}
	args["project"] = "../escape"
	if _, err := call(restarted, "herdr_create", args); err == nil {
		t.Fatal("accepted project traversal")
	}
	args["project"] = "second-app"
	args["directories"] = []string{"/arbitrary"}
	if _, err := call(restarted, "herdr_create", args); err == nil {
		t.Fatal("model supplied arbitrary directory")
	}
}
