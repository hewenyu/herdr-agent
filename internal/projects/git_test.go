package projects

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/config"
)

func testGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	output, err := runGit(context.Background(), git, dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(output)
}

func assertRepositoryRoot(t *testing.T, dir string) {
	t.Helper()
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := testGit(t, dir, "rev-parse", "--show-toplevel"); got != want {
		t.Fatalf("Git root = %q, want %q", got, want)
	}
}

func TestPutInitializesOnlyPrimaryAndPreservesFiles(t *testing.T) {
	c, _ := newCatalog(t)
	main, extra := t.TempDir(), t.TempDir()
	source := filepath.Join(main, "main.go")
	if err := os.WriteFile(source, []byte("package main\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.Put("app", config.Project{Directories: []string{main, extra}}, true); err != nil {
		t.Fatal(err)
	}
	assertRepositoryRoot(t, main)
	if _, err := os.Stat(filepath.Join(extra, ".git")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("extra directory was initialized: %v", err)
	}
	if content, err := os.ReadFile(source); err != nil || string(content) != "package main\n" {
		t.Fatalf("existing file changed: %q, %v", content, err)
	}
}

func TestCreateOwnRepositoryInsideParentRepository(t *testing.T) {
	c, _ := newCatalog(t)
	testGit(t, c.home, "init", "--quiet")
	project, err := c.Create(context.Background(), "nested", "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	assertRepositoryRoot(t, project.Path)
}

func TestPutPreservesCommittedRepositoryAndLinkedWorktree(t *testing.T) {
	c, _ := newCatalog(t)
	repo := t.TempDir()
	testGit(t, repo, "init", "--quiet")
	testGit(t, repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "existing commit")
	wantHead := testGit(t, repo, "rev-parse", "HEAD")
	configPath := filepath.Join(repo, ".git", "config")
	configBefore, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Put("existing", config.Project{Path: repo}, true); err != nil {
		t.Fatal(err)
	}
	configAfter, err := os.ReadFile(configPath)
	if err != nil || string(configAfter) != string(configBefore) || testGit(t, repo, "rev-parse", "HEAD") != wantHead {
		t.Fatalf("existing repository changed: %v", err)
	}
	worktree := filepath.Join(t.TempDir(), "linked")
	testGit(t, repo, "worktree", "add", "--quiet", "--detach", worktree)
	gitFile := filepath.Join(worktree, ".git")
	before, err := os.ReadFile(gitFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Put("linked", config.Project{Path: worktree}, false); err != nil {
		t.Fatal(err)
	}
	assertRepositoryRoot(t, worktree)
	after, err := os.ReadFile(gitFile)
	if err != nil || string(after) != string(before) || testGit(t, worktree, "rev-parse", "HEAD") != wantHead {
		t.Fatalf("linked worktree changed: %v", err)
	}
}

func TestEnsureRepositoryIgnoresInheritedGitOverrides(t *testing.T) {
	_, _ = newCatalog(t)
	outside, primary := t.TempDir(), t.TempDir()
	testGit(t, outside, "init", "--quiet")
	before, err := os.ReadFile(filepath.Join(outside, ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_DIR", filepath.Join(outside, ".git"))
	t.Setenv("GIT_WORK_TREE", outside)
	t.Setenv("GIT_INDEX_FILE", filepath.Join(outside, "redirected-index"))
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "core.worktree")
	t.Setenv("GIT_CONFIG_VALUE_0", outside)
	if err := EnsureRepository(context.Background(), primary); err != nil {
		t.Fatal(err)
	}
	assertRepositoryRoot(t, primary)
	after, err := os.ReadFile(filepath.Join(outside, ".git", "config"))
	if err != nil || string(after) != string(before) {
		t.Fatalf("inherited repository changed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "redirected-index")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("inherited index was written: %v", err)
	}
}

func TestPutRejectsMalformedGitAndPreservesIt(t *testing.T) {
	c, _ := newCatalog(t)
	main := t.TempDir()
	gitPath := filepath.Join(main, ".git")
	const malformed = "not a valid Git worktree\n"
	if err := os.WriteFile(gitPath, []byte(malformed), 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.Put("broken", config.Project{Path: main}, true); err == nil || !strings.Contains(err.Error(), "invalid Git") {
		t.Fatalf("malformed .git accepted: %v", err)
	}
	if content, err := os.ReadFile(gitPath); err != nil || string(content) != malformed {
		t.Fatalf("malformed .git overwritten: %q, %v", content, err)
	}
	if len(c.Snapshot().Projects) != 0 {
		t.Fatal("invalid project was published")
	}
}

func TestEnsureRepositoryRejectsRedirectedWorktree(t *testing.T) {
	_, _ = newCatalog(t)
	main, other := t.TempDir(), t.TempDir()
	testGit(t, main, "init", "--quiet")
	testGit(t, main, "config", "core.worktree", other)
	if err := EnsureRepository(context.Background(), main); err == nil || !strings.Contains(err.Error(), "working directory") {
		t.Fatalf("redirected worktree accepted: %v", err)
	}
}

func TestCreateWithoutGitFailsBeforePublishingProject(t *testing.T) {
	c, _ := newCatalog(t)
	t.Setenv("PATH", t.TempDir())
	if _, err := c.Create(context.Background(), "no-git", "codex", true); err == nil || !strings.Contains(err.Error(), "install git") {
		t.Fatalf("missing Git error = %v", err)
	}
	if len(c.Snapshot().Projects) != 0 {
		t.Fatal("project without Git was published")
	}
	if _, err := os.Stat(filepath.Join(c.Root(), "no-git")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("empty failed directory was retained: %v", err)
	}
}

func TestOpenDoesNotInitializeLegacyProject(t *testing.T) {
	_, state := newCatalog(t)
	main := t.TempDir()
	seed := config.Default().Tasks
	seed.Projects = map[string]config.Project{"legacy": {Path: main}}
	if _, err := Open(state, seed); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(main, ".git")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read-only catalog open initialized Git: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := EnsureRepository(ctx, main); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled ensure = %v", err)
	}
	if _, err := os.Stat(filepath.Join(main, ".git")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled initialization wrote Git: %v", err)
	}
}
