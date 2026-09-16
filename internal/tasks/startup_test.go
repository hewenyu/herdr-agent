package tasks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestInitialPromptWaitsForUnsentApprovalAndResumesOnce(t *testing.T) {
	for _, refusal := range []error{agents.ErrCannotUnblock, agents.ErrDialogOnScreen, agents.ErrAgentBusy} {
		t.Run(refusal.Error(), func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			h.controller.delivery = agents.Delivery{FinalStatus: agents.StatusBlocked}
			h.controller.sayErr = fmt.Errorf("startup preflight: %w", refusal)
			r := h.reconcile(t, h.create(t, "approval-refusal").ID, 1)
			if r.Status != Blocked || r.Pending != "" || r.Error != "" || r.PromptSent || !r.Started || len(h.controller.says) != 1 || !h.controller.says[0].guard.RequireUnblocked {
				t.Fatalf("known unsent prompt became an ambiguous permanent failure: %+v", r)
			}
			h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "blocked" })
			h.restart(t)
			r = h.reconcile(t, r.ID, 2)
			if len(h.controller.says) != 1 || r.Pending != "" || r.Status != Blocked {
				t.Fatalf("blocked startup resent text before approval: %+v", r)
			}
			h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) {
				a.AgentStatus = "idle"
				a.LaunchPending = false
				a.InteractiveReady = true
			})
			h.controller.delivery = agents.Delivery{Attempts: 1, Acked: true, Verified: true}
			h.controller.sayErr = nil
			r = h.reconcile(t, r.ID, 1)
			if !r.PromptSent || r.Status != Running || r.Pending != "" || len(h.controller.says) != 2 || h.controller.says[0].text != h.controller.says[1].text {
				t.Fatalf("approval did not resume the original prompt exactly once: %+v", r)
			}
			h.restart(t)
			h.reconcile(t, r.ID, 2)
			if len(h.controller.says) != 2 || len(h.lifecycle.starts) != 1 || len(h.lifecycle.workspaces) != 1 {
				t.Fatal("resume or restart repeated prompt/agent creation")
			}
		})
	}
}

func TestInitialPromptUnknownDeliveryIsNeverAutomaticallyRetried(t *testing.T) {
	cases := []struct {
		name string
		d    agents.Delivery
		err  error
	}{
		{"after-write", agents.Delivery{Attempts: 1}, agents.ErrCannotUnblock},
		{"dialog-after-write", agents.Delivery{Attempts: 1}, agents.ErrDialogOnScreen},
		{"unknown-timeout", agents.Delivery{}, context.DeadlineExceeded},
		{"acknowledged", agents.Delivery{Acked: true}, agents.ErrCannotUnblock},
		{"escaped", agents.Delivery{Escaped: true}, agents.ErrCannotUnblock},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newTaskTestHarness(t, "claude")
			h.controller.delivery, h.controller.sayErr = tc.d, tc.err
			r := h.create(t, tc.name)
			if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
				t.Fatal("ambiguous delivery was hidden")
			}
			h.controller.delivery, h.controller.sayErr = agents.Delivery{Acked: true, Verified: true}, nil
			h.restart(t)
			r = h.reconcile(t, r.ID, 2)
			if r.Pending != "prompt" || r.Error == "" || r.Status != Attention || r.PromptSent || len(h.controller.says) != 1 {
				t.Fatalf("unknown prompt was automatically repeated: %+v", r)
			}
		})
	}
}

func TestRepeatedScreenApprovalRefusalDoesNotOscillateProgress(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error { reports = append(reports, r); return nil }
	h.controller.delivery = agents.Delivery{}
	h.controller.sayErr = agents.ErrDialogOnScreen
	r := h.reconcile(t, h.create(t, "screen-stays-idle").ID, 1)
	count := len(reports)
	h.reconcile(t, r.ID, 2)
	if len(reports) != count || reports[len(reports)-1].Status != Blocked {
		t.Fatalf("idle status with an on-screen dialog flooded progress: %+v", reports)
	}
}

func TestProjectPreparationRunsBeforeWorkspaceAndCanRetry(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	prepareCalls := 0
	prepareErr := errors.New("git initialization failed")
	h.manager.opts.PrepareProject = func(_ context.Context, primary string) error {
		prepareCalls++
		if primary != "/configured/repo" || len(h.lifecycle.workspaces) != 0 || len(h.lifecycle.starts) != 0 {
			t.Fatal("project preparation ran after workspace/agent launch or with wrong path")
		}
		return prepareErr
	}
	r := h.create(t, "prepare-repository")
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("project preparation failure was ignored")
	}
	r, _ = h.store.Get(r.ID)
	if r.Pending != "" || r.Status != Attention || len(h.lifecycle.workspaces) != 0 || len(h.controller.says) != 0 {
		t.Fatalf("failed local preparation launched a workspace or became ambiguous: %+v", r)
	}
	prepareErr = nil
	if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if prepareCalls != 2 || !r.PromptSent || len(h.platform.created) != 1 || len(h.platform.chats) != 1 || len(h.lifecycle.workspaces) != 1 || len(h.lifecycle.starts) != 1 {
		t.Fatalf("preparation retry failed or duplicated external resources: %+v", r)
	}
}

type cwdReportingLifecycle struct {
	*taskTestLifecycle
	cwd string
}

func (l cwdReportingLifecycle) WorkspaceCreate(ctx context.Context, cwd, label string) (herdrapi.WorkspaceInfo, error) {
	w, err := l.taskTestLifecycle.WorkspaceCreate(ctx, cwd, label)
	w.Cwd = l.cwd
	return w, err
}

func TestWorkspaceDirectoryMustMatchPrimaryBeforeLaunching(t *testing.T) {
	for _, mode := range []string{"different", "symlink", "empty"} {
		t.Run(mode, func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			primary := t.TempDir()
			reported := t.TempDir()
			if mode == "empty" {
				reported = ""
			}
			if mode == "symlink" {
				reported = filepath.Join(t.TempDir(), "linked-project")
				if err := os.Symlink(primary, reported); err != nil {
					t.Fatal(err)
				}
			}
			h.manager.opts.Config.Projects["repo"] = config.Project{Path: primary, Agent: "codex"}
			h.manager.opts.Lifecycle = cwdReportingLifecycle{h.lifecycle, reported}
			r := h.create(t, "workspace-cwd")
			err := h.manager.reconcile(context.Background(), r.ID)
			r, _ = h.store.Get(r.ID)
			if mode != "different" {
				if err != nil || !r.PromptSent || len(h.lifecycle.starts) != 1 {
					t.Fatalf("compatible working directory blocked launch: %+v, %v", r, err)
				}
				return
			}
			if err == nil || r.Status != Attention || r.WorkspaceCwd != reported || r.PaneID == "" || r.Pending != "" || len(h.lifecycle.starts) != 0 || len(h.controller.says) != 0 {
				t.Fatalf("wrong cwd launched agent or lost the known workspace: %+v, %v", r, err)
			}
			h.restart(t)
			if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err != nil {
				t.Fatal(err)
			}
			if err := h.manager.reconcile(context.Background(), r.ID); err == nil || len(h.lifecycle.starts) != 0 || len(h.lifecycle.workspaces) != 1 {
				t.Fatal("retry bypassed persisted cwd mismatch or duplicated its workspace")
			}
		})
	}
}

func TestInitialPromptAlwaysNamesPrimaryOutputDirectoryAndOriginalRequirements(t *testing.T) {
	for _, directories := range [][]string{{"/primary"}, {"/primary", "/shared/api", "/shared/web"}} {
		r := Record{Project: "demo", Path: "/primary", Directories: directories, Title: "实现登录页面\n并验证输入错误"}
		prompt := initialPrompt(r)
		for _, text := range append([]string{r.Title, "主目录 / 工作目录", "保存新建代码和项目产物"}, directories...) {
			if !strings.Contains(prompt, text) {
				t.Fatalf("agent prompt omitted %q: %s", text, prompt)
			}
		}
	}
}

func TestInitialPromptChecksLiveAgentDirectoryAfterWorkspaceCreation(t *testing.T) {
	for _, source := range []string{"foreground", "shell", "legacy-workspace"} {
		t.Run(source, func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			primary, changed := t.TempDir(), t.TempDir()
			h.manager.opts.Config.Projects["repo"] = config.Project{Path: primary, Agent: "codex"}
			if source == "legacy-workspace" {
				h.manager.opts.Lifecycle = cwdReportingLifecycle{h.lifecycle, ""}
			}
			client := h.manager.opts.Client.(*herdrapi.RecordingClient)
			client.OnAgentGet = func(_ context.Context, pane string) (herdrapi.AgentInfo, error) {
				a, err := h.lifecycle.agent(pane)
				if source == "foreground" {
					a.ForegroundCwd = &changed
				} else {
					a.Cwd = &changed
				}
				return a, err
			}
			r := h.create(t, "changed-agent-cwd")
			if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
				t.Fatal("agent in another directory received initial task")
			}
			r, _ = h.store.Get(r.ID)
			if r.AgentCwd != changed || r.Status != Attention || !r.Started || r.PromptSent || r.Pending != "" || len(h.controller.says) != 0 || !strings.Contains(r.Error, changed) {
				t.Fatalf("live cwd mismatch was lost or task sent: %+v", r)
			}
			if source != "legacy-workspace" && r.WorkspaceCwd != primary {
				t.Fatal("agent cwd replaced the original workspace cwd")
			}
			h.restart(t)
			r, _ = h.store.Get(r.ID)
			if r.AgentCwd != changed {
				t.Fatal("actual agent directory was not persisted")
			}
			if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err != nil {
				t.Fatal(err)
			}
			if err := h.manager.reconcile(context.Background(), r.ID); err == nil || len(h.controller.says) != 0 || len(h.lifecycle.starts) != 1 {
				t.Fatal("retry skipped live directory validation or duplicated startup")
			}
		})
	}
}

func TestInitialAgentDirectoryUsesForegroundAndAllowsCanonicalPath(t *testing.T) {
	h := newTaskTestHarness(t, "claude")
	primary, staleShell := t.TempDir(), t.TempDir()
	alias := filepath.Join(t.TempDir(), "project-alias")
	if err := os.Symlink(primary, alias); err != nil {
		t.Fatal(err)
	}
	h.manager.opts.Config.Projects["repo"] = config.Project{Path: primary, Agent: "claude"}
	client := h.manager.opts.Client.(*herdrapi.RecordingClient)
	client.OnAgentGet = func(_ context.Context, pane string) (herdrapi.AgentInfo, error) {
		a, err := h.lifecycle.agent(pane)
		a.Cwd, a.ForegroundCwd = &staleShell, &alias
		return a, err
	}
	r := h.reconcile(t, h.create(t, "foreground-cwd").ID, 1)
	if !r.PromptSent || r.AgentCwd != alias || len(h.controller.says) != 1 {
		t.Fatalf("correct foreground cwd was rejected due to stale shell cwd: %+v", r)
	}
	// Once task input has been sent, a working agent may legitimately cd to a
	// project subdirectory or an authorized additional directory.
	alias = t.TempDir()
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "working" })
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Running || r.Error != "" || len(h.controller.says) != 1 {
		t.Fatalf("working agent directory change interrupted the task: %+v", r)
	}
}
