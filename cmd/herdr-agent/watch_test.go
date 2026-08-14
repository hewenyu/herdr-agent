package main

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// timestampRe is the shape the acceptance script cuts a latency out of:
// RFC3339 with milliseconds. S1 §4 item 2 budgets 1.5s for `-> blocked`, which
// second resolution could not measure.
var timestampRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}`)

func TestWatchPrintsOneTimestampedLinePerTransition(t *testing.T) {
	h := newHarness(t)
	reg := newFakeRegistry()
	h.d.NewRegistry = func(time.Duration) (agents.Registry, error) { return reg, nil }

	at := baseTime.Add(1234 * time.Millisecond)
	reg.ch <- agents.Transition{
		Agent: agents.Agent{PaneID: "w1:p1", Kind: "claude", Title: "Create hello.txt"},
		From:  agents.StatusWorking, To: agents.StatusBlocked, Seq: 43, At: at,
	}
	reg.ch <- agents.Transition{
		Agent: agents.Agent{PaneID: "w1:p4", Kind: "codex"},
		From:  agents.StatusIdle, To: agents.StatusGone, Seq: 99, At: at,
	}

	// Cancelling before the command runs makes the fake registry close the
	// channel at once; buffered transitions are still delivered first.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := dispatch(ctx, h.d, []string{"watch", "-interval", "5ms"}); err != nil {
		t.Fatalf("watch: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(h.stdout()), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want one per transition:\n%s", len(lines), h.stdout())
	}
	for _, line := range lines {
		if !timestampRe.MatchString(line) {
			t.Errorf("line %q does not start with a millisecond timestamp", line)
		}
	}
	for _, want := range []string{"w1:p1", "claude", "working -> blocked", "seq=43", "Create hello.txt"} {
		if !strings.Contains(lines[0], want) {
			t.Errorf("line %q does not contain %q", lines[0], want)
		}
	}
	if !strings.Contains(lines[1], "idle -> gone") {
		t.Errorf("a disappearing agent must be reported: %q", lines[1])
	}
	if reg.subs != 1 {
		t.Errorf("Subscribe called %d times, want exactly one subscription", reg.subs)
	}
}

func TestWatchExitsQuietlyOnCancelAndLoudlyOnFailure(t *testing.T) {
	t.Run("ctrl-c is a normal end", func(t *testing.T) {
		h := newHarness(t)
		reg := newFakeRegistry()
		h.d.NewRegistry = func(time.Duration) (agents.Registry, error) { return reg, nil }
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := dispatch(ctx, h.d, []string{"watch"}); err != nil {
			t.Errorf("watch after Ctrl-C returned %v, want nil", err)
		}
	})

	t.Run("a registry that refuses to run is reported", func(t *testing.T) {
		h := newHarness(t)
		reg := newFakeRegistry()
		// Run may be called only once and returns without closing the channel,
		// so a watch that waited for the channel would hang forever.
		reg.runErr = agents.ErrRunOnce
		h.d.NewRegistry = func(time.Duration) (agents.Registry, error) { return reg, nil }

		done := make(chan error, 1)
		go func() { done <- dispatch(context.Background(), h.d, []string{"watch", "-interval", "5ms"}) }()
		select {
		case err := <-done:
			if !errors.Is(err, agents.ErrRunOnce) {
				t.Errorf("err = %v, want ErrRunOnce", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("watch hung waiting for a channel that will never close")
		}
	})
}

func TestWatchAnnouncesDegradedHerdr(t *testing.T) {
	// A watch that printed nothing while herdr was unreachable looks exactly
	// like a machine where nothing is happening (G10: the single UI thread
	// wedges behind any modal dialog).
	h := newHarness(t)
	reg := newFakeRegistry()
	reg.degraded = true
	h.d.NewRegistry = func(time.Duration) (agents.Registry, error) { return reg, nil }

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := dispatch(ctx, h.d, []string{"watch", "-interval", "5ms"}); err != nil {
		t.Fatalf("watch: %v", err)
	}
	if !strings.Contains(h.stderr(), "not answering") {
		t.Errorf("no degraded notice on stderr:\n%s", h.stderr())
	}
	if h.stdout() != "" {
		t.Errorf("the degraded notice must stay off the transition stream, got %q", h.stdout())
	}
}
