package notify

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// TestEdgesThatNotify pins the edge filter (S2 §3.7).
//
// The load-bearing rows are the ones that push nothing: `-> idle` means the
// desktop UI has already looked at that pane, which is the only thing that
// distinguishes idle from done (G11), and `-> working` is not actionable.
func TestEdgesThatNotify(t *testing.T) {
	tests := []struct {
		name    string
		from    agents.Status
		to      agents.Status
		want    []pushKind
		extract []extractCall
	}{
		{
			name:    "working to blocked pushes a card with the dialog",
			from:    agents.StatusWorking,
			to:      agents.StatusBlocked,
			want:    []pushKind{pushBlocked},
			extract: []extractCall{{op: "dialog", pane: "w1:p1"}},
		},
		{
			name:    "working to done pushes the tail",
			from:    agents.StatusWorking,
			to:      agents.StatusDone,
			want:    []pushKind{pushDone},
			extract: []extractCall{{op: "tail", pane: "w1:p1", n: DefaultTailLines}},
		},
		{
			name: "blocked to gone pushes without reading the pane",
			from: agents.StatusBlocked,
			to:   agents.StatusGone,
			want: []pushKind{pushGone},
		},
		{
			name: "done to idle pushes nothing",
			from: agents.StatusDone,
			to:   agents.StatusIdle,
		},
		{
			name: "working to idle pushes nothing",
			from: agents.StatusWorking,
			to:   agents.StatusIdle,
		},
		{
			name: "idle to working pushes nothing",
			from: agents.StatusIdle,
			to:   agents.StatusWorking,
		},
		{
			name: "anything to unknown pushes nothing",
			from: agents.StatusIdle,
			to:   agents.StatusUnknown,
		},
		{
			// herdr's detector runs at 300ms while the registry polls at 1s
			// (G10): a dialog answered at the keyboard and immediately replaced
			// by the next one arrives as blocked -> blocked. The card already on
			// the phone is pinned to the old sequence and is therefore dead
			// (G17), so this has to push.
			name:    "blocked to blocked with a new sequence still pushes",
			from:    agents.StatusBlocked,
			to:      agents.StatusBlocked,
			want:    []pushKind{pushBlocked},
			extract: []extractCall{{op: "dialog", pane: "w1:p1"}},
		},
		{
			name:    "first sighting of an already blocked agent pushes",
			from:    agents.StatusUnknown,
			to:      agents.StatusBlocked,
			want:    []pushKind{pushBlocked},
			extract: []extractCall{{op: "dialog", pane: "w1:p1"}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.send(transition(tc.from, tc.to, "w1:p1", 7))

			if got := kinds(h.sink.recorded()); !slices.Equal(got, tc.want) {
				t.Fatalf("pushes = %v, want %v", got, tc.want)
			}
			if got := h.ex.recorded(); !slices.Equal(got, tc.extract) {
				t.Fatalf("screen reads = %+v, want %+v", got, tc.extract)
			}
		})
	}
}

// TestPushCarriesAgentAndScreen checks that what reaches the Sink is the agent
// that transitioned and the screen fetched for it.
func TestPushCarriesAgentAndScreen(t *testing.T) {
	h := newHarness(t, WithTailLines(3))

	h.send(blockedAt("w1:p1", 11))
	h.advance(DefaultCooldown)
	h.send(transition(agents.StatusWorking, agents.StatusDone, "w1:p2", 12))

	got := h.sink.recorded()
	if len(got) != 2 {
		t.Fatalf("pushes = %d, want 2", len(got))
	}
	if got[0].agent.PaneID != "w1:p1" || got[0].agent.StateSeq != 11 {
		t.Errorf("blocked push carried %+v", got[0].agent)
	}
	if want := h.ex.dialog.Text(); got[0].screen.Text() != want {
		t.Errorf("blocked push screen = %q, want %q", got[0].screen.Text(), want)
	}
	if got[1].agent.PaneID != "w1:p2" {
		t.Errorf("done push carried %+v", got[1].agent)
	}
	if want := h.ex.tail.Text(); got[1].screen.Text() != want {
		t.Errorf("done push screen = %q, want %q", got[1].screen.Text(), want)
	}

	// WithTailLines must reach the extractor, otherwise a done card can be a
	// whole 49-row pane (G5).
	reads := h.ex.recorded()
	if len(reads) != 2 || reads[1].op != "tail" || reads[1].n != 3 {
		t.Fatalf("screen reads = %+v, want a tail of 3 lines", reads)
	}
}

// TestSamePaneSeqPushedOnce covers the idempotency key. The clock is pushed
// well past the cooldown between the two transitions so that a regression here
// cannot hide behind throttling.
func TestSamePaneSeqPushedOnce(t *testing.T) {
	h := newHarness(t)

	h.send(blockedAt("w1:p1", 7))
	h.advance(10 * DefaultCooldown)
	// A reconnect makes the registry reconcile from scratch, so the same agent
	// is announced again with the sequence it already had.
	h.send(transition(agents.StatusUnknown, agents.StatusBlocked, "w1:p1", 7))

	if n := h.sink.count(); n != 1 {
		t.Fatalf("pushes = %d, want 1 for one (pane, seq)", n)
	}
}

// TestDifferentPaneSameSeqBothPush proves the key is the pair, not the
// sequence: herdr's state_change_seq is one server-global counter, so two panes
// can legitimately carry the same value.
func TestDifferentPaneSameSeqBothPush(t *testing.T) {
	h := newHarness(t)

	h.send(blockedAt("w1:p1", 7))
	h.send(blockedAt("w1:p2", 7))

	if n := h.sink.count(); n != 2 {
		t.Fatalf("pushes = %d, want 2 (one per pane)", n)
	}
}

// TestCoalescesInsideCooldown is the throttling contract: transitions arriving
// inside the window are merged into the most recent one and delivered when it
// expires — not dropped, and not replayed one card at a time.
func TestCoalescesInsideCooldown(t *testing.T) {
	h := newHarness(t)

	h.send(blockedAt("w1:p1", 1))
	if n := h.sink.count(); n != 1 {
		t.Fatalf("first push count = %d, want 1", n)
	}

	h.advance(5 * time.Second)
	if e := h.send(transition(agents.StatusBlocked, agents.StatusDone, "w1:p1", 2)); e.stopped || e.d != 25*time.Second {
		t.Fatalf("armed %+v, want a 25s cooldown", e)
	}
	h.advance(5 * time.Second)
	if e := h.send(blockedAt("w1:p1", 3)); e.stopped || e.d != 20*time.Second {
		t.Fatalf("armed %+v, want a 20s cooldown", e)
	}

	if n := h.sink.count(); n != 1 {
		t.Fatalf("pushes during cooldown = %d, want 1", n)
	}
	// The screen for a coalesced push must not be read until it is delivered:
	// what the pane shows now is what belongs on the card.
	if reads := h.ex.recorded(); len(reads) != 1 {
		t.Fatalf("screen reads during cooldown = %+v, want only the first", reads)
	}

	h.advance(20 * time.Second)
	if e := h.fire(); !e.stopped {
		t.Errorf("timer armed again with nothing pending: %+v", e)
	}

	got := h.sink.recorded()
	if len(got) != 2 {
		t.Fatalf("pushes = %d, want 2 (the first plus one coalesced)", len(got))
	}
	if got[1].kind != pushBlocked || got[1].agent.StateSeq != 3 {
		t.Fatalf("coalesced push = %v seq %d, want blocked seq 3 (the latest)", got[1].kind, got[1].agent.StateSeq)
	}
	if want := h.ex.dialog.Text(); got[1].screen.Text() != want {
		t.Errorf("coalesced push screen = %q, want the dialog %q", got[1].screen.Text(), want)
	}
}

// TestTransitionWithoutPaneIDIsDropped: pane_id is the only routing key that
// survives a herdr restart (G10) and the only thing a card's buttons can aim
// at, so a transition without one has nowhere to go.
func TestTransitionWithoutPaneIDIsDropped(t *testing.T) {
	h := newHarness(t)

	h.send(blockedAt("", 1))

	if n := h.sink.count(); n != 0 {
		t.Fatalf("pushes = %d, want none for an unroutable transition", n)
	}
}

// TestCooldownIsPerPane: one noisy agent must not silence another.
func TestCooldownIsPerPane(t *testing.T) {
	h := newHarness(t)

	h.send(blockedAt("w1:p1", 1))
	h.send(blockedAt("w1:p2", 2)) // same instant, different pane

	if got := kinds(h.sink.recorded()); !slices.Equal(got, []pushKind{pushBlocked, pushBlocked}) {
		t.Fatalf("pushes = %v, want both panes pushed immediately", got)
	}
}

// TestCoalescedFlushIsDeterministic checks that a flush covering several panes
// reaches the sink in pane order rather than map order.
func TestCoalescedFlushIsDeterministic(t *testing.T) {
	h := newHarness(t)

	for _, pane := range []string{"w1:p3", "w1:p1", "w1:p2"} {
		h.send(blockedAt(pane, 1))
	}
	h.advance(time.Second)
	for i, pane := range []string{"w1:p3", "w1:p1", "w1:p2"} {
		h.send(blockedAt(pane, uint64(10+i)))
	}
	h.advance(DefaultCooldown)
	h.fire()

	var flushed []string
	for _, p := range h.sink.recorded()[3:] {
		flushed = append(flushed, p.agent.PaneID)
	}
	if want := []string{"w1:p1", "w1:p2", "w1:p3"}; !slices.Equal(flushed, want) {
		t.Fatalf("flush order = %v, want %v", flushed, want)
	}
}

// TestSinkErrorLeavesPairUndelivered: a failed push must not consume the
// idempotency key, so the next transition — including the same pair re-emitted
// after a reconnect — gets another chance.
func TestSinkErrorLeavesPairUndelivered(t *testing.T) {
	h := newHarness(t)
	boom := errors.New("feishu is down")
	h.sink.setOn(func(push) error { return boom })

	h.send(blockedAt("w1:p1", 5))
	if n := h.sink.count(); n != 1 {
		t.Fatalf("attempts = %d, want 1", n)
	}

	h.advance(DefaultCooldown)
	h.sink.setOn(nil)
	h.send(blockedAt("w1:p1", 5))
	if n := h.sink.count(); n != 2 {
		t.Fatalf("attempts = %d, want the failed pair to be retried", n)
	}

	// And once it succeeds, it is spent.
	h.advance(DefaultCooldown)
	h.send(blockedAt("w1:p1", 5))
	if n := h.sink.count(); n != 2 {
		t.Fatalf("attempts = %d, want no push after a successful one", n)
	}
}

// TestFailedPushIsRetriedThenAbandoned covers the case "the next transition
// will retry" cannot: a pane that has just gone blocked emits no next
// transition. The registry only speaks on a status change or a higher state
// sequence, and an agent parked at a dialog produces neither until a human
// answers it — which is the thing this push was supposed to ask for. Without a
// retry, one transient Feishu error means the user is never told and the agent
// waits forever (S2 acceptance 2).
func TestFailedPushIsRetriedThenAbandoned(t *testing.T) {
	h := newHarness(t)
	h.sink.setOn(func(push) error { return errors.New("feishu is down") })

	if e := h.send(blockedAt("w1:p1", 1)); e.stopped || e.d != DefaultCooldown {
		t.Fatalf("armed %+v, want a retry one cooldown out", e)
	}

	// Retries are paced by the cooldown, because lastPush is stamped on the
	// attempt: an outage costs one call per cooldown, not a hot loop.
	h.advance(DefaultCooldown)
	if e := h.fire(); e.stopped || e.d != DefaultCooldown {
		t.Fatalf("armed %+v after attempt 2, want a third", e)
	}
	h.advance(DefaultCooldown)
	if e := h.fire(); !e.stopped {
		t.Fatalf("armed %+v after the last attempt, want it abandoned", e)
	}

	got := h.sink.recorded()
	if len(got) != maxPushAttempts {
		t.Fatalf("attempts = %d, want %d", len(got), maxPushAttempts)
	}
	for i, p := range got {
		if p.kind != pushBlocked || p.agent.StateSeq != 1 {
			t.Errorf("attempt %d = %v seq %d, want the same blocked transition", i, p.kind, p.agent.StateSeq)
		}
	}

	// Abandoned for good: later passes of the loop do not resurrect it.
	h.advance(10 * DefaultCooldown)
	h.sink.setOn(nil)
	h.send(blockedAt("w1:p2", 9))
	if n := h.sink.count(); n != maxPushAttempts+1 {
		t.Fatalf("pushes = %d, want only the new pane after the give-up", n)
	}
}

// TestRetrySucceedsAndSpendsThePair: a retry that lands is a delivery like any
// other, so it consumes the idempotency key.
func TestRetrySucceedsAndSpendsThePair(t *testing.T) {
	h := newHarness(t)
	h.sink.setOn(func(push) error { return errors.New("feishu is down") })
	h.send(blockedAt("w1:p1", 1))

	h.sink.setOn(nil)
	h.advance(DefaultCooldown)
	if e := h.fire(); !e.stopped {
		t.Fatalf("armed %+v after a successful retry, want nothing pending", e)
	}
	got := h.sink.recorded()
	if len(got) != 2 || got[1].agent.StateSeq != 1 || got[1].kind != pushBlocked {
		t.Fatalf("pushes = %+v, want the same blocked transition retried once", kinds(got))
	}

	h.advance(DefaultCooldown)
	h.send(transition(agents.StatusUnknown, agents.StatusBlocked, "w1:p1", 1))
	if n := h.sink.count(); n != 2 {
		t.Fatalf("pushes = %d, want the delivered pair to stay spent", n)
	}
}

// TestPaneStateIsReleased: n.panes must not grow for the life of a process that
// is meant to stay up for weeks. seenSet is bounded for the same reason.
func TestPaneStateIsReleased(t *testing.T) {
	t.Run("a gone pane is released at once", func(t *testing.T) {
		h := newHarness(t)
		h.send(blockedAt("w1:p1", 1))
		h.advance(DefaultCooldown)
		h.send(transition(agents.StatusBlocked, agents.StatusGone, "w1:p1", 2))

		if got := h.paneCount(); got != 0 {
			t.Fatalf("panes tracked after the pane disappeared = %d, want 0", got)
		}
	})

	t.Run("a quiet pane is released once its cooldown is spent", func(t *testing.T) {
		h := newHarness(t)
		h.send(blockedAt("w1:p1", 1))
		if !h.hasPaneState("w1:p1") {
			t.Fatal("the pane that was just pushed is not being throttled")
		}

		// Past the cooldown the entry can no longer change any decision: a new
		// transition would flush immediately either way.
		h.advance(DefaultCooldown)
		h.send(blockedAt("w1:p2", 2))
		if h.hasPaneState("w1:p1") {
			t.Error("throttling state outlived the cooldown it was holding")
		}
		if got := h.paneCount(); got != 1 {
			t.Fatalf("panes tracked = %d, want only the one still inside its cooldown", got)
		}
	})

	t.Run("a superseded pane leaves nothing behind", func(t *testing.T) {
		h := newHarness(t)
		h.send(blockedAt("w1:p1", 1))
		h.send(blockedAt("w1:p1", 2)) // pending, inside the cooldown
		h.send(transition(agents.StatusBlocked, agents.StatusWorking, "w1:p1", 3))
		if got := h.paneCount(); got != 1 {
			t.Fatalf("panes tracked = %d, want the cooldown still held", got)
		}

		h.advance(DefaultCooldown)
		h.send(blockedAt("w1:p2", 4))
		if h.hasPaneState("w1:p1") {
			t.Error("a superseded pane kept its entry")
		}
	})

	t.Run("a transition that pushes nothing creates nothing", func(t *testing.T) {
		h := newHarness(t)
		h.send(transition(agents.StatusIdle, agents.StatusWorking, "w1:p1", 1))

		if got := h.paneCount(); got != 0 {
			t.Fatalf("panes tracked = %d, want none for a pane with nothing to say", got)
		}
	})
}

// TestSinkErrorStartsTheCooldown: a failing sink is rate-limited like a working
// one, so a burst of transitions cannot turn an outage into a hot loop.
func TestSinkErrorStartsTheCooldown(t *testing.T) {
	h := newHarness(t)
	h.sink.setOn(func(push) error { return errors.New("feishu is down") })

	h.send(blockedAt("w1:p1", 1))
	h.send(blockedAt("w1:p1", 2))

	if n := h.sink.count(); n != 1 {
		t.Fatalf("attempts = %d, want the second held by the cooldown", n)
	}
}

// TestScreenErrorStillPushes: a blocked agent stays blocked until a human
// answers, so failing to read its screen must cost the card's body, not the
// card.
func TestScreenErrorStillPushes(t *testing.T) {
	tests := []struct {
		name string
		to   agents.Status
		set  func(h *harness)
		want pushKind
	}{
		{
			name: "dialog read fails",
			to:   agents.StatusBlocked,
			set:  func(h *harness) { h.ex.setDialogErr(errors.New("agent_not_idle")) },
			want: pushBlocked,
		},
		{
			name: "tail read fails",
			to:   agents.StatusDone,
			set:  func(h *harness) { h.ex.setTailErr(errors.New("pane gone")) },
			want: pushDone,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			tc.set(h)

			h.send(transition(agents.StatusWorking, tc.to, "w1:p1", 4))

			got := h.sink.recorded()
			if len(got) != 1 || got[0].kind != tc.want {
				t.Fatalf("pushes = %v, want one %s", kinds(got), tc.want)
			}
			if len(got[0].screen.Lines) != 0 {
				t.Errorf("screen = %+v, want empty after a failed read", got[0].screen)
			}

			// It counts as delivered: retrying would only fail the same way.
			h.advance(DefaultCooldown)
			h.send(transition(agents.StatusWorking, tc.to, "w1:p1", 4))
			if n := h.sink.count(); n != 1 {
				t.Fatalf("pushes = %d, want the pair to stay spent", n)
			}
		})
	}
}

// TestRunExitsOnContextCancel: cancelling must return, not leak the loop.
func TestRunExitsOnContextCancel(t *testing.T) {
	h := newHarness(t)
	h.send(blockedAt("w1:p1", 1))

	if err := h.stop(); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run returned %v, want context.Canceled", err)
	}
	if got := h.reg.subs.Load(); got != 1 {
		t.Errorf("Subscribe called %d times, want exactly 1", got)
	}
}

// TestRunExitsWhenRegistryStops: the feed closing while our own context is live
// means nothing can ever arrive again. Blocking forever there would leave a
// bridge that looks healthy and notifies nobody.
func TestRunExitsWhenRegistryStops(t *testing.T) {
	h := newHarness(t)
	h.reg.stop()

	if err := h.wait(); !errors.Is(err, ErrRegistryStopped) {
		t.Fatalf("Run returned %v, want ErrRegistryStopped", err)
	}
}

// TestPendingIsDroppedOnCancel: nothing pending may reach the Sink once the
// bridge is going down. A card that arrives after the process that could act on
// its buttons has exited is a live keystroke aimed at a pane nobody is watching
// (G17), and the button press would find no bridge to route it.
func TestPendingIsDroppedOnCancel(t *testing.T) {
	t.Run("cooldown has not expired", func(t *testing.T) {
		h := newHarness(t)
		h.send(blockedAt("w1:p1", 1))
		h.send(blockedAt("w1:p1", 2)) // pending, inside the cooldown

		if err := h.stop(); !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
		if n := h.sink.count(); n != 1 {
			t.Fatalf("pushes = %d, want the pending one dropped at shutdown", n)
		}
	})

	// The previous case passes for the wrong reason on its own: the cooldown
	// would have held that push back anyway. Here both panes are due, so only
	// the shutdown check can stop the second one.
	t.Run("cancelled part way through a flush", func(t *testing.T) {
		h := newHarness(t)
		h.send(blockedAt("w1:p1", 1))
		h.send(blockedAt("w1:p2", 1))
		h.send(blockedAt("w1:p1", 2)) // both queue behind their cooldowns
		h.send(blockedAt("w1:p2", 2))
		h.advance(DefaultCooldown)

		h.sink.setOn(func(push) error {
			h.cancel() // the bridge goes down while the flush is in progress
			return nil
		})
		h.fire()

		got := h.sink.recorded()
		if len(got) != 3 {
			t.Fatalf("pushes = %v, want the flush to stop after the first", kinds(got))
		}
		if got[2].agent.PaneID != "w1:p1" || got[2].agent.StateSeq != 2 {
			t.Fatalf("flushed %+v, want w1:p1 seq 2 first", got[2].agent)
		}
		if err := h.stop(); !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
	})
}

// TestFlushIntoADeadContextPushesNothing pins the ordering inside flushDue: the
// shutdown check runs BEFORE the Sink call, not after it.
//
// Driven directly rather than through Run, because the interleaving that
// exposes it — the loop reaching flushDue with ctx already cancelled — is a
// select race between ctx.Done() and a timer that is due right now, and a test
// that only reproduces it half the time is not a regression guard. A Sink that
// pushes on its own background context, as any client with an internal timeout
// might, would deliver a card here.
func TestFlushIntoADeadContextPushesNothing(t *testing.T) {
	clk := &fakeClock{now: epoch}
	sink := &recordingSink{}
	n := New(newFakeRegistry(), newFakeExtractor(), sink, WithClock(clk.Now)).(*notifier)
	n.log = discardLogger()

	// Two panes pending, neither throttled.
	n.observe(blockedAt("w1:p1", 1))
	n.observe(blockedAt("w1:p2", 2))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	n.flushDue(ctx)

	if got := sink.count(); got != 0 {
		t.Fatalf("pushes = %d, want none into a cancelled context", got)
	}
	// And nothing was silently consumed on the way out.
	for _, pane := range []string{"w1:p1", "w1:p2"} {
		if st := n.panes[pane]; st == nil || st.pending == nil {
			t.Errorf("%s: pending was consumed by a flush that pushed nothing", pane)
		}
	}
}

// TestArmFiresImmediatelyWhenAlreadyOverdue: a transition left pending past its
// due time must be scheduled, not stranded.
//
// A flush cut short by shutdown is the one way to get there, and the clock only
// ever moves further past the deadline afterwards. Arming with a negative gap
// would be a card that waits for an unrelated pane to wake the loop up, which
// for the last agent of the day never happens.
func TestArmFiresImmediatelyWhenAlreadyOverdue(t *testing.T) {
	clk := &fakeClock{now: epoch}
	n := New(newFakeRegistry(), newFakeExtractor(), &recordingSink{}, WithClock(clk.Now)).(*notifier)
	n.log = discardLogger()

	n.observe(blockedAt("w1:p1", 1))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	n.flushDue(ctx) // leaves the transition pending

	clk.advance(2 * DefaultCooldown)
	tm := newFakeTimer()
	n.arm(tm)

	select {
	case e := <-tm.arms:
		if e.stopped || e.d != 0 {
			t.Fatalf("armed %+v, want an immediate fire", e)
		}
	default:
		t.Fatal("arm did nothing with a pending transition")
	}
}

// TestSupersededPendingIsNeverPushed: a queued card is invalidated by the pane
// moving on, even though the transition that moved it pushes nothing itself.
//
// The scenario is the ordinary one: the user answers the dialog at the Mac
// while the card is still waiting for its cooldown. Pushing it afterwards puts
// "needs your approval" on the phone long after the approval happened. S1's
// SendKey guard makes the buttons inert (G17), so this is noise rather than
// danger — but the cooldown exists to remove exactly this noise.
func TestSupersededPendingIsNeverPushed(t *testing.T) {
	h := newHarness(t)

	h.send(transition(agents.StatusWorking, agents.StatusDone, "w1:p1", 1))
	h.advance(2 * time.Second)
	h.send(blockedAt("w1:p1", 2)) // queued behind the cooldown

	h.advance(2 * time.Second)
	e := h.send(transition(agents.StatusBlocked, agents.StatusWorking, "w1:p1", 3))
	if !e.stopped {
		t.Fatalf("armed %+v, want the timer stopped once nothing is pending", e)
	}

	// Well past the cooldown, and with another pane flushing, so the loop
	// really does visit w1:p1 and find nothing to say.
	h.advance(DefaultCooldown)
	h.send(blockedAt("w1:p2", 4))

	got := h.sink.recorded()
	if len(got) != 2 {
		t.Fatalf("pushes = %d, want 2 (the done card and the other pane)", len(got))
	}
	if got[1].agent.PaneID != "w1:p2" {
		t.Fatalf("second push = %+v, want the stale w1:p1 card gone", got[1].agent)
	}
}

func TestRunRejectsMisWiring(t *testing.T) {
	reg := newFakeRegistry()
	ex := newFakeExtractor()
	sink := &recordingSink{}

	tests := []struct {
		name string
		n    Notifier
		want error
	}{
		{"no registry", New(nil, ex, sink), ErrNoRegistry},
		{"no extractor", New(reg, nil, sink), ErrNoExtractor},
		{"no sink", New(reg, ex, nil), ErrNoSink},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.n.Run(context.Background()); !errors.Is(err, tc.want) {
				t.Fatalf("Run = %v, want %v", err, tc.want)
			}
			if got := reg.subs.Load(); got != 0 {
				t.Fatalf("a mis-wired notifier subscribed %d times", got)
			}
		})
	}
}

func TestRunOnce(t *testing.T) {
	h := newHarness(t)
	if err := h.n.Run(context.Background()); !errors.Is(err, ErrRunOnce) {
		t.Fatalf("second Run = %v, want ErrRunOnce", err)
	}
}

func TestOptions(t *testing.T) {
	tests := []struct {
		name string
		opts []Option
		want options
	}{
		{
			name: "defaults",
			want: options{cooldown: DefaultCooldown, tailLines: DefaultTailLines},
		},
		{
			name: "overrides",
			opts: []Option{WithCooldown(time.Second), WithTailLines(4)},
			want: options{cooldown: time.Second, tailLines: 4},
		},
		{
			name: "non-positive values are ignored",
			opts: []Option{WithCooldown(0), WithTailLines(-1), WithClock(nil)},
			want: options{cooldown: DefaultCooldown, tailLines: DefaultTailLines},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			n := New(newFakeRegistry(), newFakeExtractor(), &recordingSink{}, tc.opts...).(*notifier)
			if n.cfg.cooldown != tc.want.cooldown {
				t.Errorf("cooldown = %v, want %v", n.cfg.cooldown, tc.want.cooldown)
			}
			if n.cfg.tailLines != tc.want.tailLines {
				t.Errorf("tailLines = %d, want %d", n.cfg.tailLines, tc.want.tailLines)
			}
			if n.cfg.clock == nil {
				t.Error("clock is nil")
			}
		})
	}
}

func TestSeenSetIsBounded(t *testing.T) {
	s := newSeenSet(3)
	for i := uint64(0); i < 10; i++ {
		s.add(key{pane: "w1:p1", seq: i})
	}
	if s.len() != 3 {
		t.Fatalf("len = %d, want the set capped at 3", s.len())
	}
	if !s.has(key{pane: "w1:p1", seq: 9}) {
		t.Error("newest key was evicted")
	}
	if s.has(key{pane: "w1:p1", seq: 0}) {
		t.Error("oldest key survived eviction")
	}
	// Re-adding a known key must not reorder or grow anything.
	s.add(key{pane: "w1:p1", seq: 9})
	if s.len() != 3 {
		t.Fatalf("len = %d after re-add, want 3", s.len())
	}

	// A nonsense bound still has to remember the last push, or every reconnect
	// re-fires every card it replays (G17).
	z := newSeenSet(0)
	z.add(key{pane: "w1:p1", seq: 1})
	if !z.has(key{pane: "w1:p1", seq: 1}) {
		t.Error("a zero-sized set forgot the key it was just given")
	}
}

func TestNotifiesCoversEveryStatus(t *testing.T) {
	tests := []struct {
		s    agents.Status
		want bool
	}{
		{agents.StatusBlocked, true},
		{agents.StatusDone, true},
		{agents.StatusGone, true},
		{agents.StatusIdle, false},
		{agents.StatusWorking, false},
		{agents.StatusUnknown, false},
		{agents.Status("something herdr grows later"), false},
	}
	for _, tc := range tests {
		if got := notifies(tc.s); got != tc.want {
			t.Errorf("notifies(%q) = %v, want %v", tc.s, got, tc.want)
		}
	}
}
