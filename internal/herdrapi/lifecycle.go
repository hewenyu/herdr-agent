package herdrapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type workspaceWireInfo struct {
	ID       string `json:"workspace_id"`
	Label    string `json:"label"`
	Worktree *struct {
		CheckoutPath string `json:"checkout_path"`
	} `json:"worktree"`
}

func (w workspaceWireInfo) info() WorkspaceInfo {
	info := WorkspaceInfo{ID: w.ID, Label: w.Label}
	if w.Worktree != nil {
		info.Cwd = w.Worktree.CheckoutPath
	}
	return info
}

// WorkspaceCreate creates an unfocused workspace. The protocol has no terminal
// rows/columns parameter: herdr chooses its current estimated pane size. Do not
// focus the workspace to try to resize it, since that changes the desktop UI.
func (c *socketClient) WorkspaceCreate(ctx context.Context, cwd, label string) (WorkspaceInfo, error) {
	if strings.TrimSpace(cwd) == "" || strings.TrimSpace(label) == "" {
		return WorkspaceInfo{}, fmt.Errorf("herdrapi: workspace.create requires cwd and label")
	}
	params := struct {
		Cwd   string `json:"cwd"`
		Label string `json:"label"`
		Focus bool   `json:"focus"`
	}{Cwd: cwd, Label: label, Focus: false}
	var out struct {
		Workspace workspaceWireInfo `json:"workspace"`
		RootPane  PaneInfo          `json:"root_pane"`
	}
	if err := c.callLifecycle(ctx, methodWorkspaceCreate, params, &out); err != nil {
		return WorkspaceInfo{}, err
	}
	info := out.Workspace.info()
	info.PaneID = out.RootPane.PaneID
	if out.RootPane.Cwd != nil {
		info.Cwd = *out.RootPane.Cwd
	}
	if info.ID == "" || info.PaneID == "" {
		return info, fmt.Errorf("herdrapi: workspace.create response omitted workspace or root pane ID")
	}
	return info, nil
}

func (c *socketClient) WorkspaceList(ctx context.Context) ([]WorkspaceInfo, error) {
	var out struct {
		Workspaces []workspaceWireInfo `json:"workspaces"`
	}
	if err := c.callLifecycle(ctx, methodWorkspaceList, nil, &out); err != nil {
		return nil, err
	}
	workspaces := make([]WorkspaceInfo, 0, len(out.Workspaces))
	for _, workspace := range out.Workspaces {
		workspaces = append(workspaces, workspace.info())
	}
	return workspaces, nil
}

const agentStartupPollInterval = 100 * time.Millisecond

// AgentStart deliberately accepts no initial task or arbitrary command-line
// arguments. Startup can stop at a trust/permission dialog: only the separate
// guarded permission flow may approve it, after which the task can be sent.
func (c *socketClient) AgentStart(ctx context.Context, paneID, kind, name string) (AgentInfo, error) {
	return c.AgentStartWithOptions(ctx, paneID, kind, name, AgentStartOptions{})
}

type agentStartResult struct {
	Agent AgentInfo `json:"agent"`
	Argv  []string  `json:"argv"`
}

// AgentStartWithOptions passes directories as separate native argv values.
// herdr quotes each value for the pane's shell; never concatenate a shell command
// or pre-quote a directory here, including names with spaces or single quotes.
func (c *socketClient) AgentStartWithOptions(ctx context.Context, paneID, kind, name string, opts AgentStartOptions) (AgentInfo, error) {
	if strings.TrimSpace(paneID) == "" || strings.TrimSpace(kind) == "" || strings.TrimSpace(name) == "" {
		return AgentInfo{}, &APIError{Code: CodeInvalidParams, Message: "herdrapi: agent.start requires pane ID, kind and name"}
	}
	args, err := managedAgentArgs(kind, opts)
	if err != nil {
		// No RPC has been attempted. Report a definitive refusal so a task can
		// retry after an unavailable directory is restored, without treating the
		// local validation failure as an ambiguously launched agent.
		return AgentInfo{}, &APIError{Code: CodeInvalidParams, Message: err.Error()}
	}
	params := struct {
		PaneID    string   `json:"pane_id"`
		Kind      string   `json:"kind"`
		Name      string   `json:"name"`
		Args      []string `json:"args,omitempty"`
		TimeoutMs uint64   `json:"timeout_ms"`
	}{PaneID: paneID, Kind: kind, Name: name, Args: args, TimeoutMs: uint64(AgentStartupTimeout / time.Millisecond)}
	var out agentStartResult
	if err := c.startAgentWhenShellReady(ctx, paneID, params, &out); err != nil {
		return AgentInfo{}, err
	}
	agent := out.Agent
	if len(args) > 0 && (len(out.Argv) != len(args)+1 || !slices.Equal(out.Argv[1:], args)) {
		return agent, &APIError{Code: CodeAgentOptionsUnconfirmed, Message: "herdr did not confirm the requested startup arguments; task must not be submitted"}
	}
	if agent.TerminalID == "" {
		return agent, fmt.Errorf("herdrapi: agent.start response omitted terminal ID")
	}
	expectedTerminal := agent.TerminalID
	waitCtx, cancel := context.WithTimeout(ctx, AgentStartupTimeout)
	defer cancel()
	for {
		ready, err := startedAgentReady(agent, paneID, kind, name, expectedTerminal)
		if err != nil || ready {
			return agent, err
		}
		if err := waitCtx.Err(); err != nil {
			return agent, agentStartupWaitError(err)
		}
		current, err := c.AgentGet(waitCtx, paneID)
		if err != nil {
			if waitCtx.Err() != nil {
				return agent, agentStartupWaitError(waitCtx.Err())
			}
			return agent, err
		}
		agent = current
		ready, err = startedAgentReady(agent, paneID, kind, name, expectedTerminal)
		if err != nil || ready {
			return agent, err
		}
		timer := time.NewTimer(agentStartupPollInterval)
		select {
		case <-waitCtx.Done():
			timer.Stop()
			return agent, agentStartupWaitError(waitCtx.Err())
		case <-timer.C:
		}
	}
}

func managedAgentArgs(kind string, opts AgentStartOptions) ([]string, error) {
	if len(opts.Directories) == 0 && !opts.Bypass {
		return nil, nil
	}
	if kind != "codex" && kind != "claude" {
		return nil, fmt.Errorf("herdrapi: configured startup options are supported only for codex and claude, got %q", kind)
	}
	args := make([]string, 0, len(opts.Directories)*2+1)
	if opts.Bypass {
		if kind == "codex" {
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		} else {
			args = append(args, "--dangerously-skip-permissions")
		}
	}
	for i, directory := range opts.Directories {
		if !utf8.ValidString(directory) || strings.IndexFunc(directory, unicode.IsControl) >= 0 || !filepath.IsAbs(directory) {
			return nil, fmt.Errorf("herdrapi: additional directory %d must be an absolute path without control characters", i+1)
		}
		info, err := os.Stat(directory)
		if err != nil {
			return nil, fmt.Errorf("herdrapi: additional directory %d: %w", i+1, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("herdrapi: additional directory %d is not a directory", i+1)
		}
		args = append(args, "--add-dir", directory)
	}
	return args, nil
}

// A new workspace can return before its shell becomes the foreground process.
// herdr returns agent_pane_busy before reserving a managed agent or sending any
// bytes. Only that explicit refusal can be retried; a lost start response could
// already have launched the agent and must never be replayed.
func (c *socketClient) startAgentWhenShellReady(ctx context.Context, paneID string, params any, out *agentStartResult) error {
	waitCtx, cancel := context.WithTimeout(ctx, AgentStartupTimeout)
	defer cancel()
	var terminalID string
	var rejected error
	for {
		if rejected != nil {
			timer := time.NewTimer(agentStartupPollInterval)
			select {
			case <-waitCtx.Done():
				timer.Stop()
				return fmt.Errorf("herdrapi: shell readiness wait: %w: %w", rejected, waitCtx.Err())
			case <-timer.C:
			}
			pane, readErr := c.PaneGet(waitCtx, paneID)
			if readErr != nil {
				return errors.Join(rejected, fmt.Errorf("herdrapi: inspect rejected start target: %w", readErr))
			}
			if pane.PaneID != paneID || pane.Agent != nil || pane.TerminalID != terminalID {
				return fmt.Errorf("%w: target terminal changed or became occupied while waiting for its shell", rejected)
			}
		}
		err := c.callLifecycle(waitCtx, methodAgentStart, params, out)
		if !IsCode(err, CodeAgentPaneBusy) {
			return err
		}
		rejected = err
		if terminalID != "" {
			continue
		}
		pane, readErr := c.PaneGet(waitCtx, paneID)
		if readErr != nil {
			return errors.Join(err, fmt.Errorf("herdrapi: inspect rejected start target: %w", readErr))
		}
		if pane.PaneID != paneID || pane.TerminalID == "" || pane.Agent != nil {
			return err
		}
		terminalID = pane.TerminalID
	}
}

func startedAgentReady(agent AgentInfo, paneID, kind, name, terminalID string) (bool, error) {
	if agent.PaneID != paneID || agent.TerminalID != terminalID || agent.Name == nil || *agent.Name != name {
		return false, &APIError{Code: "agent_name_not_found", Message: "started agent no longer owns the target terminal"}
	}
	if agent.Agent != nil && *agent.Agent != kind {
		return false, &APIError{Code: "agent_kind_mismatch", Message: fmt.Sprintf("expected %s, detected %s", kind, *agent.Agent)}
	}
	if agent.AgentStatus == "blocked" {
		return true, nil
	}
	if agent.AgentStatus == "idle" || agent.AgentStatus == "done" {
		if agent.InteractiveReady && !agent.LaunchPending && agent.Agent != nil {
			return true, nil
		}
		if !agent.LaunchPending {
			return false, &APIError{Code: "agent_start_failed", Message: "agent process exited before becoming interactive"}
		}
	}
	return false, nil
}

func agentStartupWaitError(err error) error {
	return fmt.Errorf("herdrapi: agent startup wait: %w: %w", &APIError{Code: CodeTimeout, Message: "agent did not become interactive before the startup deadline"}, err)
}

func (c *socketClient) PaneClose(ctx context.Context, paneID string) error {
	if strings.TrimSpace(paneID) == "" {
		return fmt.Errorf("herdrapi: pane.close requires a pane ID")
	}
	return c.callLifecycle(ctx, methodPaneClose, paneTargetParams{PaneID: paneID}, nil)
}
