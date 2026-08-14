package notify

import "time"

// timer is the slice of time.Timer this package uses.
//
// It is an interface for one reason: a test that has to wait 30 real seconds
// for a cooldown is a test nobody runs. The Run loop selects on C() and rearms
// through Reset/Stop, so a fake can expire a cooldown the instant the fake
// clock says it has.
type timer interface {
	// Reset arms the timer to fire once, d from now.
	Reset(d time.Duration)
	// Stop disarms the timer. Safe to call when it is not armed.
	Stop()
	// C is the channel the expiry arrives on.
	C() <-chan time.Time
}

// realTimer wraps time.Timer, starting disarmed.
type realTimer struct{ t *time.Timer }

func newRealTimer() timer {
	t := time.NewTimer(time.Hour)
	if !t.Stop() {
		<-t.C
	}
	return &realTimer{t: t}
}

func (r *realTimer) Reset(d time.Duration) {
	r.drain()
	if d < 0 {
		d = 0
	}
	r.t.Reset(d)
}

func (r *realTimer) Stop() { r.drain() }

func (r *realTimer) C() <-chan time.Time { return r.t.C }

// drain disarms the timer and discards an expiry that fired before Stop got
// there, so that the next arming cannot be satisfied by a stale tick.
func (r *realTimer) drain() {
	if r.t.Stop() {
		return
	}
	select {
	case <-r.t.C:
	default:
	}
}
