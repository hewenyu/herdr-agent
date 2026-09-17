package projects

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// EnsureRepository makes primary the root of a working Git repository. A parent
// directory's repository does not count. Existing repositories and linked
// worktrees are validated without reinitializing or changing their contents.
// Callers may use this when launching projects loaded from an older catalog;
// reading a catalog itself never changes project directories.
func EnsureRepository(ctx context.Context, primary string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if primary == "" {
		return errors.New("projects: primary directory is required for Git initialization")
	}
	primary, err := filepath.Abs(primary)
	if err != nil {
		return fmt.Errorf("projects: resolve primary directory: %w", err)
	}
	primary, err = filepath.EvalSymlinks(primary)
	if err != nil {
		return fmt.Errorf("projects: resolve primary directory: %w", err)
	}
	info, err := os.Stat(primary)
	if err != nil {
		return fmt.Errorf("projects: inspect primary directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("projects: primary directory must exist: %s", primary)
	}
	git, err := exec.LookPath("git")
	if err != nil {
		return fmt.Errorf("projects: Git is required to initialize or validate the primary directory; install git and retry: %w", err)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	gitPath := filepath.Join(primary, ".git")
	info, err = os.Lstat(gitPath)
	switch {
	case errors.Is(err, os.ErrNotExist):
		// An explicit destination creates this directory's own repository even
		// when an ancestor is already a repository. Empty templates prevent a
		// user's init.templateDir from copying unrelated hooks into new projects.
		if _, err := runGit(ctx, git, primary, "init", "--quiet", "--template=", primary); err != nil {
			return fmt.Errorf("projects: initialize Git in %s: %w", primary, err)
		}
	case err != nil:
		return fmt.Errorf("projects: inspect %s: %w", gitPath, err)
	case info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()):
		return fmt.Errorf("projects: %s must be a Git directory or a linked-worktree file, not a symlink or special file", gitPath)
	}
	output, err := runGit(ctx, git, primary, "rev-parse", "--is-bare-repository", "--show-toplevel")
	if err != nil {
		return fmt.Errorf("projects: primary directory has an invalid Git repository at %s: %w", gitPath, err)
	}
	parts := strings.SplitN(strings.TrimSpace(output), "\n", 2)
	if len(parts) != 2 || parts[0] != "false" {
		return fmt.Errorf("projects: primary directory must be a working Git repository: %s", primary)
	}
	top, err := filepath.EvalSymlinks(strings.TrimSpace(parts[1]))
	if err != nil || top != primary {
		return fmt.Errorf("projects: Git working directory must be the project primary directory: %s", primary)
	}
	return nil
}

func runGit(ctx context.Context, git, directory string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, git, args...)
	cmd.Dir = directory
	// Launches from a Git hook or another repository may inherit GIT_DIR,
	// GIT_WORK_TREE, GIT_INDEX_FILE, or injected GIT_CONFIG_* values. None may
	// redirect initialization or repository checks outside this project.
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GIT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		return "", fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return string(output), nil
}
