package agents

import (
	"context"
	"errors"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestSayRevalidatesGuardImmediatelyBeforeEveryPaste(t *testing.T) {
	for _, attempt := range []int{1, 2} {
		for _, tc := range []struct {
			name   string
			change func(*fakePane)
			want   error
		}{
			{"agent-replaced", func(p *fakePane) { p.kind = "codex" }, ErrAgentReplaced},
			{"target-resolved-by-name", func(p *fakePane) { p.reportPaneID = "w2:p1" }, ErrPaneGone},
			{"launch-pending", func(p *fakePane) { p.launchPending = true }, ErrAgentBusy},
		} {
			t.Run(tc.name+string(rune('0'+attempt)), func(t *testing.T) {
				p := &fakePane{status: StatusIdle, seq: 2, screen: claudeScreen("  earlier", "")}
				if attempt == 2 {
					p.promptResults = []error{stalled(), nil}
				}
				h := newInputHarness(t, p)
				inner := h.client.OnAgentRead
				reads := 0
				h.client.OnAgentRead = func(ctx context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
					reads++
					if reads == attempt {
						p.mu.Lock()
						tc.change(p)
						p.mu.Unlock()
					}
					return inner(ctx, target, src, lines)
				}
				d, err := h.ctrl.Say(context.Background(), h.guard(), "continue the original task")
				if !errors.Is(err, tc.want) {
					t.Fatalf("Say error = %v, want %v", err, tc.want)
				}
				if n := h.client.Count("agent.prompt"); n != attempt-1 || d.Attempts != attempt-1 || d.Acked {
					t.Fatalf("wrote after target changed: prompts=%d delivery=%+v", n, d)
				}
			})
		}
	}
}
