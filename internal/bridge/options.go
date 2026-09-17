package bridge

import (
	"time"

	"github.com/hewenyu/herdr-agent/internal/selection"
)

// Option is an optional dependency of the bridge.
//
// It exists because Deps is fixed by contract.go and the sticky selection
// arrived after it. Everything in Deps is required — validateDeps refuses a nil
// — while a selection store is genuinely optional: without one the bridge falls
// back to the routing it shipped with (reply-to, then the single agent), which
// is degraded but safe. Those are two different kinds of dependency and putting
// the second one behind an Option keeps the distinction visible.
type Option func(*bridge)

// WithNotifyCooldown sets the minimum interval between proactive notifications
// about a pane. Values <= 0 leave notify.DefaultCooldown in effect.
func WithNotifyCooldown(d time.Duration) Option {
	return func(b *bridge) {
		if d > 0 {
			b.notifyCooldown = d
		}
	}
}

// WithSelection gives the bridge the store that remembers which agent a chat is
// currently talking to.
//
// This is what makes plain typing reach an agent without a reply or a pane id,
// which is the whole point of the card-first interaction: typing is the cheapest
// thing a phone can do and every other gesture costs taps.
//
// A nil store is ignored rather than stored, so `WithSelection(nil)` degrades to
// the old routing instead of panicking on the first message.
func WithSelection(s selection.Store) Option {
	return func(b *bridge) {
		if s == nil {
			return
		}
		b.sel = s
	}
}

// NewWith is New plus the optional dependencies.
//
// New keeps the exact signature contract.go fixes for it, so this is the
// constructor cmd/herdr-agent calls once it has opened the selection store.
func NewWith(d Deps, opts ...Option) (Bridge, error) {
	b, err := newBridge(d, opts...)
	if err != nil {
		// Explicitly nil, not b: a typed nil pointer in an interface is not nil,
		// and a caller that checks the interface before the error would get a
		// Bridge that panics on first use.
		return nil, err
	}
	return b, nil
}
