package tasks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/projects"
	"github.com/hewenyu/herdr-agent/internal/projectweb"
)

type projectLifecycle struct {
	*taskTestLifecycle
	options     []herdrapi.AgentStartOptions
	unconfirmed bool
	invalid     bool
}

func (l *projectLifecycle) AgentStartWithOptions(ctx context.Context, pane, kind, name string, opts herdrapi.AgentStartOptions) (herdrapi.AgentInfo, error) {
	l.options = append(l.options, opts)
	if l.invalid {
		return herdrapi.AgentInfo{}, &herdrapi.APIError{Code: herdrapi.CodeInvalidParams, Message: "additional directory disappeared before launch"}
	}
	a, err := l.AgentStart(ctx, pane, kind, name)
	if l.unconfirmed {
		return a, &herdrapi.APIError{Code: herdrapi.CodeAgentOptionsUnconfirmed, Message: "startup args not confirmed"}
	}
	return a, err
}

// Exercise real HTTP save -> shared live catalog -> durable task -> launch
// options and prompt, including changes made while an older task is queued.
func TestLocalPageConfigurationControlsNewTasks(t *testing.T) {
	for _, kind := range []string{"codex", "claude"} {
		t.Run(kind, func(t *testing.T) {
			h := newTaskTestHarness(t, kind)
			seed := config.Default().Tasks
			catalog, err := projects.Open(t.TempDir(), seed)
			if err != nil {
				t.Fatal(err)
			}
			h.manager.opts.Projects = catalog
			lifecycle := &projectLifecycle{taskTestLifecycle: h.lifecycle}
			h.manager.opts.Lifecycle = lifecycle
			handler, err := projectweb.New(catalog)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(handler)
			defer server.Close()
			response, err := http.Get(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			page, _ := io.ReadAll(response.Body)
			response.Body.Close()
			match := regexp.MustCompile(`name="csrf-token" content="([a-f0-9]+)"`).FindSubmatch(page)
			if len(match) != 2 {
				t.Fatal("missing page CSRF token")
			}
			put := func(endpoint string, value any) {
				t.Helper()
				body, _ := json.Marshal(value)
				req, _ := http.NewRequest(http.MethodPut, server.URL+endpoint, bytes.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", server.URL)
				req.Header.Set("X-CSRF-Token", string(match[1]))
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					b, _ := io.ReadAll(resp.Body)
					t.Fatalf("save: %s %s", resp.Status, b)
				}
			}
			first, second, third := t.TempDir(), t.TempDir(), t.TempDir()
			put("/api/projects/app", map[string]any{"directories": []string{first, second, third}, "agent": kind, "make_default": true})
			original := h.create(t, "old-options")
			want, _ := config.NormalizeProject(config.Project{Directories: []string{first, second, third}, Agent: kind})
			put("/api/projects/app", map[string]any{"directories": []string{third, second}, "agent": kind})
			put("/api/settings", map[string]any{"bypass": false})
			next := h.create(t, "new-options")
			if !original.Bypass || next.Bypass || !reflect.DeepEqual(original.Directories, want.Directories) || next.Path != want.Directories[2] || len(next.Directories) != 2 {
				t.Fatalf("launch snapshots wrong: first=%+v next=%+v", original, next)
			}
			// Reload task storage before starting either, as after a process restart.
			reopened, err := Open(h.path)
			if err != nil {
				t.Fatal(err)
			}
			h.manager.store = reopened
			for _, r := range []Record{original, next} {
				if err := h.manager.reconcile(context.Background(), r.ID); err != nil {
					t.Fatal(err)
				}
			}
			if len(lifecycle.options) != 2 || !lifecycle.options[0].Bypass || lifecycle.options[1].Bypass || !reflect.DeepEqual(lifecycle.options[0].Directories, want.Directories[1:]) || !reflect.DeepEqual(lifecycle.options[1].Directories, want.Directories[1:2]) {
				t.Fatalf("wrong native launch options: %+v", lifecycle.options)
			}
			if h.lifecycle.workspaces[0].Cwd != want.Path || h.lifecycle.workspaces[1].Cwd != next.Path {
				t.Fatal("workspace did not use configured primary directory")
			}
			for _, dir := range want.Directories {
				if !strings.Contains(h.controller.says[0].text, dir) {
					t.Fatalf("agent context omitted %s", dir)
				}
			}
			if !strings.Contains(h.controller.says[0].text, original.Title) {
				t.Fatal("original task requirement lost")
			}
			// Removing a configured directory rejects a new task, not the UI startup.
			if err := os.Remove(second); err != nil {
				t.Fatal(err)
			}
			if _, err := h.manager.Create("ou_owner", "oc_entry", "missing-dir", "", "", "task"); err == nil {
				t.Fatal("accepted missing project directory")
			}
		})
	}
}

func TestUnconfirmedConfiguredLaunchNeverReceivesTaskAfterRecovery(t *testing.T) {
	for _, bypass := range []bool{false, true} {
		h := newTaskTestHarness(t, "codex")
		h.manager.opts.Config.Projects["repo"] = config.Project{Path: "/primary", Directories: []string{"/primary", "/extra"}, Agent: "codex"}
		h.manager.opts.Config.Bypass = bypass
		l := &projectLifecycle{taskTestLifecycle: h.lifecycle, unconfirmed: true}
		h.manager.opts.Lifecycle = l
		r := h.create(t, "unconfirmed-options")
		if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
			t.Fatal("missing unconfirmed launch error")
		}
		reopened, err := Open(h.path)
		if err != nil {
			t.Fatal(err)
		}
		h.manager.store = reopened
		if err := h.manager.reconcile(context.Background(), r.ID); err != nil {
			t.Fatal(err)
		}
		got, _ := h.manager.Get(r.ID)
		if got.Started || got.PromptSent || got.Pending != "agent" || got.Status != Attention || len(h.controller.says) != 0 || len(l.options) != 1 {
			t.Fatalf("unconfirmed options recovered unsafely: %+v", got)
		}
	}
}

func TestTaskDirectorySnapshotsCannotBeMutatedOutsideStore(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "tasks.json"))
	if err != nil {
		t.Fatal(err)
	}
	input := Record{ID: "t_dirs", OwnerID: "owner", Directories: []string{"/primary", "/extra"}}
	result, err := store.Update(input.ID, func(r *Record) error { *r = input; return nil })
	if err != nil {
		t.Fatal(err)
	}
	input.Directories[0] = "/bad-input"
	result.Directories[0] = "/bad-result"
	got, _ := store.Get(input.ID)
	got.Directories[1] = "/bad-get"
	store.List()[0].Directories[0] = "/bad-list"
	_, _ = store.Update(input.ID, func(r *Record) error { r.Directories[0] = "/bad-failed-update"; return errors.New("refused") })
	got, _ = store.Get(input.ID)
	if !reflect.DeepEqual(got.Directories, []string{"/primary", "/extra"}) {
		t.Fatalf("mutated snapshot: %v", got.Directories)
	}
}

func TestDefinitiveDirectoryFailureCanRetryWithoutDuplicatingResources(t *testing.T) {
	h := newTaskTestHarness(t, "claude")
	h.manager.opts.Config.Projects["repo"] = config.Project{Directories: []string{"/primary", "/extra"}, Agent: "claude"}
	l := &projectLifecycle{taskTestLifecycle: h.lifecycle, invalid: true}
	h.manager.opts.Lifecycle = l
	r := h.create(t, "directory-disappeared")
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("missing local validation error")
	}
	failed, _ := h.manager.Get(r.ID)
	if failed.Pending != "" || failed.Status != Attention || len(h.lifecycle.starts) != 0 || len(h.controller.says) != 0 {
		t.Fatalf("preflight error treated as launch: %+v", failed)
	}
	l.invalid = false
	if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.reconcile(context.Background(), r.ID); err != nil {
		t.Fatal(err)
	}
	done, _ := h.manager.Get(r.ID)
	if !done.Started || !done.PromptSent || len(h.lifecycle.starts) != 1 || len(h.lifecycle.workspaces) != 1 || len(h.platform.created) != 1 || len(h.platform.chats) != 1 {
		t.Fatalf("retry duplicated resources or failed: %+v", done)
	}
}
