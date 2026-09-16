package tasks

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// The launch args grant access; this context also tells the coding agent where
// the other parts of a multi-directory project actually live.
func initialPrompt(r Record) string {
	var b strings.Builder
	fmt.Fprintf(&b, "项目：%s\n主目录 / 工作目录：%q\n", r.Project, r.Path)
	b.WriteString("请在此主目录内完成开发并保存新建代码和项目产物；先检查当前工作目录，不要在其他位置另建项目。\n")
	if len(r.Directories) > 1 {
		b.WriteString("已通过 --add-dir 授权的附加目录，可读取并按任务要求修改：\n")
		for _, dir := range r.Directories[1:] {
			fmt.Fprintf(&b, "- %q\n", dir)
		}
	}
	b.WriteString("\n任务要求：\n")
	b.WriteString(r.Title)
	return b.String()
}

type preparationFailure struct{ error }

func (preparationFailure) DefinitiveFailure() bool { return true }

// A zero-attempt refusal is safe to resume only for these explicit transient
// preflight states. A timeout or any attempted/acknowledged write stays unknown.
func initialPromptDeferred(d agents.Delivery, err error) bool {
	return err != nil && d.Attempts == 0 && !d.Acked && !d.Verified && !d.Escaped && !d.Queued && !d.MayHaveAnsweredADialog &&
		(errors.Is(err, agents.ErrCannotUnblock) || errors.Is(err, agents.ErrDialogOnScreen) || errors.Is(err, agents.ErrAgentBusy))
}

func initialAgentDirectory(a herdrapi.AgentInfo) string {
	// foreground_cwd is herdr's current PTY foreground process directory;
	// cwd may still describe the parent shell. Prefer the running agent when
	// both are available rather than rejecting a correct agent for stale shell
	// metadata. Older servers can expose only cwd, or neither field.
	for _, path := range []*string{a.ForegroundCwd, a.Cwd} {
		if path != nil && strings.TrimSpace(*path) != "" {
			return *path
		}
	}
	return ""
}

func verifyWorkspaceDirectory(expected, actual string) error {
	canonical := func(path string) (string, error) {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return "", err
		}
		resolved, err := filepath.EvalSymlinks(absolute)
		if err != nil {
			return "", err
		}
		return filepath.Clean(resolved), nil
	}
	// Identical paths also support clients/tests that cannot expose filesystem
	// metadata. Different spellings must prove they name the same real directory.
	want, wantErr := filepath.Abs(expected)
	got, gotErr := filepath.Abs(actual)
	if wantErr == nil && gotErr == nil && want == got {
		return nil
	}
	want, wantErr = canonical(expected)
	got, gotErr = canonical(actual)
	if wantErr != nil || gotErr != nil || want != got {
		return fmt.Errorf("执行会话目录 %q 与项目主目录 %q 不一致，已停止发送任务要求；请检查工作区配置后销毁该会话并重新创建任务", actual, expected)
	}
	return nil
}
