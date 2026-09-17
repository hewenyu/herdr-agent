package tasks

import (
	"context"
	"errors"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestManagerRecoversAgentReadsWithoutRetryingProvisioning(t *testing.T) {
	for _, stage := range []string{"initial-prompt", "running"} {
		t.Run(stage, func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			r := h.create(t, "read-recovery")
			if stage == "running" {
				r = h.reconcile(t, r.ID, 1)
			}
			client := h.manager.opts.Client.(*herdrapi.RecordingClient)
			readAgent := client.OnAgentGet
			client.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
				return herdrapi.AgentInfo{}, errors.New("herdr socket temporarily unavailable")
			}
			if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
				t.Fatal("read failure was not reported")
			}
			r, _ = h.store.Get(r.ID)
			if r.Status != Attention || r.Pending != "" {
				t.Fatalf("read failure created an ambiguous side effect: %+v", r)
			}
			client.OnAgentGet = readAgent
			h.restart(t)
			r = h.reconcile(t, r.ID, 1)
			if !r.PromptSent || r.Error != "" || r.Status == Attention {
				t.Fatalf("a successful read did not resume the task: %+v", r)
			}
			if len(h.lifecycle.starts) != 1 || len(h.controller.says) != 1 || len(h.lifecycle.workspaces) != 1 || len(h.platform.created) != 1 {
				t.Fatalf("read recovery repeated provisioning or task input: %v", h.log.snapshot())
			}
		})
	}
}

func TestManagerMissingAgentStillRequiresExplicitRecovery(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "missing-agent").ID, 1)
	client := h.manager.opts.Client.(*herdrapi.RecordingClient)
	client.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		return herdrapi.AgentInfo{}, &herdrapi.APIError{Code: "agent_not_found", Message: "agent missing"}
	}
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("missing agent was not reported")
	}
	r, _ = h.store.Get(r.ID)
	if r.Status != Attention || r.Error == "" || len(h.controller.says) != 1 {
		t.Fatalf("definitive agent loss did not preserve a stopped task: %+v", r)
	}
}

func TestManagerRejectsAgentResolvedToAnotherPaneInItsWorkspace(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "target-alias").ID, 1)
	client := h.manager.opts.Client.(*herdrapi.RecordingClient)
	client.OnAgentGet = func(_ context.Context, pane string) (herdrapi.AgentInfo, error) {
		a, err := h.lifecycle.agent(pane)
		// herdr falls back to agent names if the target pane no longer has
		// an agent. A matching workspace and kind do not establish identity.
		a.PaneID = "w1:p2"
		a.AgentStatus = "working"
		return a, err
	}
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("another pane's agent was adopted as this task")
	}
	r, _ = h.store.Get(r.ID)
	if r.Status != Attention || r.Error == "" || len(h.controller.says) != 1 {
		t.Fatalf("task continued tracking the wrong pane: %+v", r)
	}
}
