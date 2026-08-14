package notify

import (
	"context"
	"slices"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// TestNeverFocusesAPane is the G10 regression guard.
//
// Marking a notification "read" by focusing the pane is the obvious thing to
// reach for and the one thing this package must never do: agent.focus /
// pane.focus clear `done` back to `idle` and yank the desktop user's UI to
// another tab. `done` is the most reliable trigger there is (G11), so a
// read-receipt implemented that way would destroy the signal it is
// acknowledging. There is no read-receipt.
//
// The notifier is driven here over the REAL screen.Extractor against a
// RecordingClient, so this asserts what actually goes out on the herdr socket
// rather than what a fake was asked for.
func TestNeverFocusesAPane(t *testing.T) {
	client := &herdrapi.RecordingClient{
		OnAgentRead: func(_ context.Context, _ string, _ herdrapi.ReadSource, _ int) (string, error) {
			return "Do you want to proceed?\n❯ 1. Yes\n  2. No\n", nil
		},
	}
	ex, err := screen.NewExtractor(client)
	if err != nil {
		t.Fatalf("NewExtractor: %v", err)
	}

	h := newHarnessEx(t, ex)
	h.send(blockedAt("w1:p1", 1))
	h.advance(DefaultCooldown)
	h.send(transition(agents.StatusWorking, agents.StatusDone, "w1:p1", 2))
	h.advance(DefaultCooldown)
	h.send(transition(agents.StatusDone, agents.StatusGone, "w1:p1", 3))

	if n := h.sink.count(); n != 3 {
		t.Fatalf("pushes = %d, want 3", n)
	}

	methods := client.Methods()
	if len(methods) == 0 {
		t.Fatal("no herdr calls were made at all; this test would pass vacuously")
	}
	for _, m := range methods {
		if slices.Contains(herdrapi.ForbiddenMethods, m) {
			t.Errorf("notifier called forbidden method %q (calls: %v)", m, methods)
		}
	}
	// agent.read with source=recent makes herdr inject synthetic scroll events
	// into the user's live pane for up to 15s (G9). The client refuses those
	// rather than sending them; nothing here should even be trying.
	if rejected := client.Rejected(); len(rejected) != 0 {
		t.Errorf("notifier attempted rejected reads: %+v", rejected)
	}
}
