package projects

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
)

func newCatalog(t *testing.T) (*Catalog, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	stateDir := t.TempDir()
	c, err := Open(stateDir, config.Default().Tasks)
	if err != nil {
		t.Fatal(err)
	}
	return c, stateDir
}

func TestCatalogPersistenceAndSnapshotIsolation(t *testing.T) {
	c, stateDir := newCatalog(t)
	front, back := t.TempDir(), t.TempDir()
	project := config.Project{Directories: []string{front, back}, Agent: "claude"}
	if err := c.Put("app", project, true); err != nil {
		t.Fatal(err)
	}
	project.Directories[0] = "/caller-mutated"
	snapshot := c.Snapshot()
	snapshot.Projects["app"].Directories[0] = "/snapshot-mutated"
	delete(snapshot.Projects, "app")
	if err := c.SetBypass(false); err != nil {
		t.Fatal(err)
	}
	seed := config.Default().Tasks
	seed.Enabled, seed.PollInterval = true, 5*time.Second
	seed.Projects = map[string]config.Project{"ignored-after-save": {Path: "/missing"}}
	reopened, err := Open(stateDir, seed)
	if err != nil {
		t.Fatal(err)
	}
	got := reopened.Snapshot()
	wantProject, err := config.NormalizeProject(config.Project{Directories: []string{front, back}, Agent: "claude"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Projects) != 1 || !reflect.DeepEqual(got.Projects["app"], wantProject) || got.DefaultProject != "app" || !got.Enabled || got.PollInterval != 5*time.Second || got.Bypass {
		t.Fatalf("reopened catalog = %+v", got)
	}
	info, err := os.Stat(filepath.Join(stateDir, FileName))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("catalog mode = %v, error = %v", info, err)
	}
}

func TestDeleteOnlyConfigurationAndDefaultFallback(t *testing.T) {
	c, stateDir := newCatalog(t)
	directory := t.TempDir()
	for _, name := range []string{"z-last", "a-first", "b-middle"} {
		if err := c.Put(name, config.Project{Path: directory}, false); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Delete("z-last"); err != nil {
		t.Fatal(err)
	}
	if got := c.Snapshot().DefaultProject; got != "a-first" {
		t.Fatalf("replacement default = %q", got)
	}
	for _, name := range []string{"a-first", "b-middle"} {
		if err := c.Delete(name); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Delete("a-first"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Delete = %v", err)
	}
	seed := config.Default().Tasks
	seed.Projects = map[string]config.Project{"z-last": {Path: directory}}
	c, err := Open(stateDir, seed)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Snapshot(); len(got.Projects) != 0 || got.DefaultProject != "" {
		t.Fatalf("deleted projects reappeared: %+v", got)
	}
	if _, err := os.Stat(directory); err != nil {
		t.Fatalf("Delete removed project directory: %v", err)
	}
}

func TestCreateExplicitDirectoryAndRejectExisting(t *testing.T) {
	c, _ := newCatalog(t)
	project, err := c.Create(context.Background(), "新项目", "claude", true)
	if err != nil {
		t.Fatal(err)
	}
	wantPath, err := filepath.EvalSymlinks(filepath.Join(c.Root(), "新项目"))
	if err != nil {
		t.Fatal(err)
	}
	if project.Path != wantPath || !reflect.DeepEqual(project.Directories, []string{wantPath}) || project.Agent != "claude" || c.Snapshot().DefaultProject != "新项目" {
		t.Fatalf("created project = %+v", project)
	}
	if _, err := c.Create(context.Background(), "新项目", "codex", false); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate project = %v", err)
	}
	if err := os.Mkdir(filepath.Join(c.Root(), "existing"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Create(context.Background(), "existing", "codex", false); !errors.Is(err, ErrExists) {
		t.Fatalf("existing directory = %v", err)
	}
	if _, ok := c.Snapshot().Projects["existing"]; ok {
		t.Fatal("existing directory was adopted")
	}
}

func TestPutNeverCreatesDirectories(t *testing.T) {
	c, _ := newCatalog(t)
	missing := filepath.Join(t.TempDir(), "missing")
	if err := c.Put("missing", config.Project{Path: missing}, false); !errors.Is(err, config.ErrTaskProjectPath) {
		t.Fatalf("Put = %v", err)
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Put created directory: %v", err)
	}
	if _, err := os.Stat(c.Root()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Put created new-project root: %v", err)
	}
}

func TestCreateRejectsTraversalAndSymlinkRoot(t *testing.T) {
	c, _ := newCatalog(t)
	for _, name := range []string{"", "..", "../escape", "a/b", "a\\b", "a;pwd", "a\nfoo"} {
		if _, err := c.Create(context.Background(), name, "codex", false); !errors.Is(err, config.ErrTaskProjectName) {
			t.Errorf("name %q: %v", name, err)
		}
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, c.Root()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Create(context.Background(), "escape", "codex", false); !errors.Is(err, config.ErrTaskProjectPath) {
		t.Fatalf("symlink root = %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "escape")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("created outside root: %v", err)
	}
}

func TestCreateRejectsChildSymlink(t *testing.T) {
	c, _ := newCatalog(t)
	if err := os.Mkdir(c.Root(), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(c.Root(), "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Create(context.Background(), "alias", "codex", false); !errors.Is(err, ErrExists) {
		t.Fatalf("symlink project = %v", err)
	}
}

func TestMutationFailuresKeepPreviousSnapshot(t *testing.T) {
	c, stateDir := newCatalog(t)
	directory := t.TempDir()
	if err := c.Put("existing", config.Project{Path: directory}, true); err != nil {
		t.Fatal(err)
	}
	before := c.Snapshot()
	// A directory cannot be replaced by the atomic catalog file rename.
	if err := os.Remove(filepath.Join(stateDir, FileName)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(stateDir, FileName), 0700); err != nil {
		t.Fatal(err)
	}
	if err := c.Put("other", config.Project{Path: directory}, true); err == nil {
		t.Fatal("Put succeeded with unwritable catalog destination")
	}
	if err := c.Delete("existing"); err == nil {
		t.Fatal("Delete succeeded with unwritable catalog destination")
	}
	if err := c.SetBypass(false); err == nil {
		t.Fatal("SetBypass succeeded with unwritable catalog destination")
	}
	if _, err := c.Create(context.Background(), "uncommitted", "codex", false); err == nil {
		t.Fatal("Create succeeded with unwritable catalog destination")
	}
	if got := c.Snapshot(); !reflect.DeepEqual(got, before) {
		t.Fatalf("failed mutation changed snapshot: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(c.Root(), "uncommitted")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uncommitted new directory was not removed: %v", err)
	}
}

func TestCancelledCreateHasNoSideEffects(t *testing.T) {
	c, _ := newCatalog(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Create(ctx, "cancelled", "codex", false); !errors.Is(err, context.Canceled) {
		t.Fatalf("Create = %v", err)
	}
	if _, err := os.Stat(c.Root()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled Create made root: %v", err)
	}
}

func TestConcurrentCatalogMutationsAndReads(t *testing.T) {
	c, stateDir := newCatalog(t)
	directory := t.TempDir()
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := c.Put(fmt.Sprintf("project-%02d", i), config.Project{Path: directory}, false); err != nil {
				t.Error(err)
			}
			_ = c.Snapshot()
		}(i)
	}
	wg.Wait()
	reopened, err := Open(stateDir, config.Default().Tasks)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.Snapshot().Projects) != 16 {
		t.Fatal("concurrent mutation was lost")
	}
}

func TestCorruptCatalogFailsClosed(t *testing.T) {
	for _, data := range []string{"{", `{}`, `{"version":2,"projects":{}}`, `{"version":1,"projects":{},"unknown":true}`, `{"version":1,"projects":{}} {}`} {
		t.Run(data, func(t *testing.T) {
			_, stateDir := newCatalog(t)
			if err := os.WriteFile(filepath.Join(stateDir, FileName), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Open(stateDir, config.Default().Tasks); err == nil {
				t.Fatal("corrupt catalog was accepted")
			}
		})
	}
}

func TestUnavailableDirectoryCanBeRepairedAfterRestart(t *testing.T) {
	c, stateDir := newCatalog(t)
	directory := t.TempDir()
	if err := c.Put("app", config.Project{Path: directory}, true); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	c, err := Open(stateDir, config.Default().Tasks)
	if err != nil {
		t.Fatalf("missing folder prevented repair: %v", err)
	}
	if _, err := config.NormalizeProject(c.Snapshot().Projects["app"]); !errors.Is(err, config.ErrTaskProjectPath) {
		t.Fatalf("missing project remained runnable: %v", err)
	}
	if err := c.Put("app", config.Project{Path: t.TempDir()}, true); err != nil {
		t.Fatal(err)
	}
}
