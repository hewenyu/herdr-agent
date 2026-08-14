package notify

import (
	"context"
	"testing"
	"time"
)

// Every other test in this package swaps n.newTimer for a fake, which is the
// only way to exercise a 30s cooldown in milliseconds. The two tests here are
// the ones that must not: the whole coalescing feature rests on the production
// timer actually firing and actually re-arming, and a regression there would
// leave the rest of the suite green while coalesced cards silently vanished.
//
// They are the only place in the package that spends real time, and they spend
// tens of milliseconds of it.

// TestRealTimerDrivesTheCooldown runs the loop end to end on the production
// timer and the real clock: a transition coalesced into a cooldown must come
// out the other side without anything else waking the loop up.
func TestRealTimerDrivesTheCooldown(t *testing.T) {
	const cooldown = 50 * time.Millisecond

	reg := newFakeRegistry()
	sink := &recordingSink{}
	pushed := make(chan time.Time, 4)
	sink.setOn(func(push) error {
		pushed <- time.Now()
		return nil
	})

	n := New(reg, newFakeExtractor(), sink, WithCooldown(cooldown)).(*notifier)
	n.log = discardLogger()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- n.Run(ctx) }()

	select {
	case <-reg.subscribed:
	case <-time.After(testTimeout):
		t.Fatal("notifier did not subscribe to the registry")
	}

	reg.ch <- blockedAt("w1:p1", 1)
	reg.ch <- blockedAt("w1:p1", 2)

	at := make([]time.Time, 0, 2)
	for len(at) < 2 {
		select {
		case ts := <-pushed:
			at = append(at, ts)
		case <-time.After(testTimeout):
			t.Fatalf("only %d pushes arrived; the real cooldown timer never fired", len(at))
		}
	}

	// The second push waited: nothing else was ever fed to the loop, so only
	// the timer could have released it. The slack absorbs the microseconds
	// between stamping lastPush and the sink call it paces.
	if gap := at[1].Sub(at[0]); gap < cooldown-10*time.Millisecond {
		t.Errorf("gap between pushes = %v, want at least the %v cooldown", gap, cooldown)
	}
	if got := sink.recorded(); got[1].agent.StateSeq != 2 {
		t.Errorf("coalesced push carried seq %d, want the latest (2)", got[1].agent.StateSeq)
	}

	cancel()
	select {
	case <-done:
	case <-time.After(testTimeout):
		t.Fatal("Run did not return after cancel")
	}
}

// TestRealTimerArmsAndDisarms drives realTimer directly through the sequence
// the Run loop puts it through — arm, fire, arm again, stop — because a stale
// tick leaking between passes is a flush nobody asked for, and a Stop that
// silently disarms nothing is a coalesced card that never arrives.
func TestRealTimerArmsAndDisarms(t *testing.T) {
	tm := newRealTimer()
	t.Cleanup(tm.Stop)

	// The loop selects on C() before anything is pending.
	assertNoTick(t, tm, "a fresh timer")

	for i := range 20 {
		tm.Reset(time.Millisecond)
		select {
		case <-tm.C():
		case <-time.After(testTimeout):
			t.Fatalf("iteration %d: the timer never fired", i)
		}
		assertNoTick(t, tm, "a timer whose tick was consumed")
	}

	// A tick nobody consumed must not satisfy the next arming; that is what
	// drain exists for. Go 1.23+ timer channels already guarantee it, and this
	// pins that the package does not depend on which semantics it gets.
	tm.Reset(time.Millisecond)
	time.Sleep(10 * time.Millisecond) // real time is this test's subject
	tm.Stop()
	assertNoTick(t, tm, "a stopped timer")
	tm.Reset(time.Hour)
	assertNoTick(t, tm, "a timer armed an hour out")
	tm.Stop()

	// arm clamps a backwards clock to a non-positive duration rather than
	// leaving a pending push unscheduled, so that must still fire.
	tm.Reset(-time.Second)
	select {
	case <-tm.C():
	case <-time.After(testTimeout):
		t.Fatal("a negative duration never fired")
	}
}

func assertNoTick(t *testing.T, tm timer, what string) {
	t.Helper()
	select {
	case <-tm.C():
		t.Fatalf("%s delivered a tick", what)
	default:
	}
}
