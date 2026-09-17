package notify

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync/atomic"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// DefaultTailLines is how much of a finished agent's screen goes into a `done`
// notification.
//
// A card that has to be scrolled on a phone is a card that does not get read.
// The tail exists to say WHICH job finished, not to reproduce the session; the
// transcript mirror (S2 §3.9) is where the conversation itself lives.
const DefaultTailLines = 12

// maxDelivered bounds how many (pane, seq) pairs are remembered as pushed.
//
// It cannot be collapsed into "highest seq seen per pane". herdr's
// state_change_seq is one server-global counter that restarts at 0 when the
// server does, so a sequence BELOW one already delivered is routine after a
// herdr restart while pane ids stay stable (G10) — treating it as old would
// silently swallow the card that says an agent needs a human. Disappearances
// are numbered downwards from MaxUint64 for the same reason
// (agents/registry.go), so the two ranges are not even ordered together.
//
// Evicting the oldest key can at worst re-push a transition from thousands of
// pushes ago; never evicting is an unbounded map in a process meant to stay up
// for weeks.
const maxDelivered = 4096

// maxPushAttempts bounds how many times one transition is handed to the Sink.
//
// The obvious mitigation for a failed push — "the pane's next transition will
// try again" — is vacuous for the case that matters most. A pane that has just
// gone blocked produces no further transition: the registry only emits on a
// status change or a higher state sequence, and an agent sitting at a dialog
// generates neither until a human answers it, which is the very thing the push
// was supposed to ask for. One transient Feishu error would otherwise mean the
// user is never told and the agent waits forever (S2 acceptance 2). Terminal
// `done` has the same shape.
//
// Retries are paced by the cooldown, because lastPush is stamped on the attempt
// rather than on success, so this cannot become a hot loop against a dead
// channel: three attempts span two cooldowns.
//
// The cost is that an error which actually meant "delivered, but the reply
// timed out" (S2 §3.8) buys a second copy of the card. That is noise, not
// danger: retrying a notification injects nothing into an agent, and the second
// copy's buttons are inert once the first has been acted on, because S1's Guard
// pins (pane, seq) and burns a one-shot nonce (G17). Silence, by contrast, is
// unrecoverable — nothing else will ever mention this agent again.
const maxPushAttempts = 3

var (
	// ErrNoRegistry, ErrNoExtractor and ErrNoSink report wiring mistakes. New
	// has no error return, so they surface from Run — at bridge startup, which
	// is when a missing dependency can still be fixed.
	ErrNoRegistry  = errors.New("notify: nil registry")
	ErrNoExtractor = errors.New("notify: nil screen extractor")
	ErrNoSink      = errors.New("notify: nil sink")

	// ErrRunOnce rejects a second Run: two loops would race over the same
	// cooldown and idempotency state.
	ErrRunOnce = errors.New("notify: Run may be called only once")

	// ErrRegistryStopped is returned when the transition feed closes while the
	// notifier's own context is still live. Nothing further can ever arrive, so
	// silently blocking forever would leave a bridge that looks healthy and
	// notifies nobody.
	ErrRegistryStopped = errors.New("notify: registry stopped")
)

// WithCooldown overrides the minimum gap between pushes about one pane.
// Values <= 0 are ignored, leaving DefaultCooldown.
func WithCooldown(d time.Duration) Option {
	return func(o *options) {
		if d > 0 {
			o.cooldown = d
		}
	}
}

// WithClock injects the time source used for cooldown arithmetic. A nil
// function is ignored.
func WithClock(f func() time.Time) Option {
	return func(o *options) {
		if f != nil {
			o.clock = f
		}
	}
}

// WithTailLines overrides how many lines of the viewport a `done` push carries.
// Values <= 0 are ignored: screen.Tail reads that as "keep everything", and a
// whole 49-row pane (G5) is not a notification.
func WithTailLines(n int) Option {
	return func(o *options) {
		if n > 0 {
			o.tailLines = n
		}
	}
}

// paneState is one pane's throttling state. Owned by the Run goroutine.
type paneState struct {
	// lastPush is when this pane last reached the Sink, successful or not.
	lastPush time.Time
	// pending is the transition waiting for the cooldown to expire, already
	// coalesced down to the most recent one.
	pending *agents.Transition
	// attempts counts consecutive failed deliveries of the current pending
	// transition. Reset whenever a push succeeds, whenever a new transition
	// supersedes the pending one (a fresh event deserves a fresh budget), and
	// when the transition is abandoned.
	attempts int
}

// notifier is the Notifier.
//
// Every field below is touched only from the Run goroutine, so there are no
// locks: the whole point of this package is that one loop decides what to push.
type notifier struct {
	reg  agents.Registry
	ex   screen.Extractor
	sink Sink
	cfg  options

	log *slog.Logger
	// newTimer builds the cooldown timer. It is a field so tests can expire a
	// cooldown by hand instead of sleeping through 30 real seconds.
	newTimer func() timer

	started atomic.Bool
	panes   map[string]*paneState
	seen    *seenSet
}

var _ Notifier = (*notifier)(nil)

// New builds a Notifier.
//
// Nil dependencies are accepted here and reported by Run, because the contract
// gives New no error return.
func New(reg agents.Registry, ex screen.Extractor, sink Sink, opts ...Option) Notifier {
	o := options{
		cooldown:  DefaultCooldown,
		clock:     time.Now,
		tailLines: DefaultTailLines,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(&o)
		}
	}
	return &notifier{
		reg:      reg,
		ex:       ex,
		sink:     sink,
		cfg:      o,
		log:      slog.Default(),
		newTimer: newRealTimer,
		panes:    map[string]*paneState{},
		seen:     newSeenSet(maxDelivered),
	}
}

// Run consumes registry transitions until ctx is cancelled, then returns
// ctx.Err(). It may be called once.
//
// The loop is deliberately single-threaded and synchronous: a push happens on
// this goroutine, so a slow Sink delays later pushes rather than reordering
// them, and the registry drops transitions into its own buffer meanwhile
// (agents/registry.go) instead of being stalled by chat latency.
func (n *notifier) Run(ctx context.Context) error {
	switch {
	case n.reg == nil:
		return ErrNoRegistry
	case n.ex == nil:
		return ErrNoExtractor
	case n.sink == nil:
		return ErrNoSink
	}
	if !n.started.CompareAndSwap(false, true) {
		return ErrRunOnce
	}

	// Subscribed here rather than in New: the channel is buffered and starts
	// dropping when nobody reads it, so a subscription taken at wiring time
	// would throw away the transitions that happened before Run was scheduled.
	feed := n.reg.Subscribe()

	tm := n.newTimer()
	defer tm.Stop()

	for {
		select {
		case <-ctx.Done():
			// Nothing is flushed on the way out. A push needs a live context to
			// reach Feishu, and a card that arrives after the bridge that could
			// act on its buttons has exited is worse than no card.
			return ctx.Err()

		case t, ok := <-feed:
			if !ok {
				if err := ctx.Err(); err != nil {
					return err
				}
				return ErrRegistryStopped
			}
			n.observe(t)

		case <-tm.C():
			// A cooldown expired; flushDue works out whose.
		}

		n.flushDue(ctx)
		n.arm(tm)
	}
}

// notifies reports whether arriving in s deserves a push.
//
// What matters is what is absent: idle. idle and done are the same agent
// condition — it is waiting for a human — and differ only in whether the
// desktop UI has already looked at that pane (G11). Reaching idle therefore
// means the user is already sitting in front of it, so pushing it to their
// phone tells them something they can see. done is herdr-derived and depends on
// no screen regex, which makes it the most reliable trigger available (G11);
// blocked comes from fragile English-string matching but is the one the user
// must answer. working is not actionable, and neither is unknown.
func notifies(s agents.Status) bool {
	switch s {
	case agents.StatusBlocked, agents.StatusDone, agents.StatusGone:
		return true
	default:
		return false
	}
}

// observe applies the edge filter and the idempotency key, then coalesces what
// survives into the pane's pending slot.
//
// The filter is on the transition's DESTINATION, not on From != To. A pane can
// go blocked -> blocked with a higher sequence, because herdr's detector ticks
// at 300ms while the registry polls at 1s (G10 forces polling): a dialog
// answered at the keyboard and replaced by the next one inside one poll shows
// up as a single transition. That is a different question, and the card already
// on the phone is now disarmed — its Guard pins the old sequence (G17) — so
// skipping it would leave the user holding a dead card and no live one.
//
// The same reasoning runs backwards: a transition that does not itself deserve a
// push still says the pane has moved on, so it invalidates whatever is waiting
// for that pane's cooldown. Answering the dialog at the keyboard takes the pane
// blocked -> working, and flushing the queued blocked card afterwards would put
// a "needs your approval" card on the phone half a minute after the approval
// already happened. It is not dangerous (S1's SendKey guard rejects the
// keystroke, because the pane is no longer blocked at that sequence, G17), but
// it is a dead card, which is the noise the cooldown exists to remove.
func (n *notifier) observe(t agents.Transition) {
	pane := t.Agent.PaneID
	if !notifies(t.To) {
		// Looked up without the create path: a pane that has never had anything
		// worth pushing must not earn an entry just for passing through working.
		if st, ok := n.panes[pane]; ok && st.pending != nil {
			n.log.Debug("notify: pending superseded by a later transition",
				"pane", pane, "dropped_seq", st.pending.Seq, "to", string(t.To), "seq", t.Seq)
			st.pending = nil
			st.attempts = 0
		}
		return
	}
	if pane == "" {
		// pane_id is the only key that routes anywhere and the only one stable
		// across a herdr restart (G10). A card whose buttons aim at no pane
		// cannot be acted on.
		n.log.Warn("notify: dropping transition with no pane id", "to", string(t.To), "seq", t.Seq)
		return
	}

	k := key{pane: pane, seq: t.Seq}
	if n.seen.has(k) {
		// A reconnect makes the registry reconcile from scratch, and every
		// agent it then sees for the "first" time is announced with the
		// sequence it already had. Without this the phone gets a burst of cards
		// for dialogs answered hours ago, each one a live keystroke aimed at a
		// pane that has moved on (G17).
		n.log.Debug("notify: already delivered, ignoring", "pane", pane, "seq", t.Seq, "to", string(t.To))
		return
	}

	st, ok := n.panes[pane]
	if !ok {
		st = &paneState{}
		n.panes[pane] = st
	}
	if st.pending != nil {
		n.log.Debug("notify: coalescing into cooldown",
			"pane", pane, "dropped_seq", st.pending.Seq, "seq", t.Seq)
	}
	// Coalesce to the latest. Not a queue: three transitions inside one
	// cooldown describe one agent's current situation, and delivering all three
	// afterwards would be three cards of which two are already wrong.
	st.pending = &t
	// A new event is a new thing to tell the user about, so it does not inherit
	// the retry budget already spent on whatever it replaced.
	st.attempts = 0
}

// flushDue emits every pane whose cooldown has expired.
func (n *notifier) flushDue(ctx context.Context) {
	now := n.cfg.clock()
	// Collect only the panes that are actually due, then sort those: a flush
	// covering several panes must hit the sink in the same order every time
	// (map order would make the chat non-deterministic), but the cost of
	// ordering should scale with what is pending, not with every pane the
	// bridge has ever seen.
	var due []string
	for pane, st := range n.panes {
		if st.pending == nil {
			continue
		}
		if !st.lastPush.IsZero() && now.Sub(st.lastPush) < n.cfg.cooldown {
			continue
		}
		due = append(due, pane)
	}
	slices.Sort(due)

	for _, pane := range due {
		if ctx.Err() != nil {
			// Shutting down. Checked BEFORE the push, not after: a card that
			// arrives after the bridge that could act on its buttons has exited
			// is worse than no card, and a Sink that pushes on its own
			// background context would happily deliver one. The pending slot is
			// left untouched so nothing is silently consumed on the way out.
			return
		}
		st := n.panes[pane]
		t := *st.pending
		st.pending = nil
		// The cooldown starts on the attempt, not on success: a sink that is
		// failing must not be retried at the speed of the transition stream.
		st.lastPush = now

		if n.deliver(ctx, t) {
			st.attempts = 0
			if t.To == agents.StatusGone {
				// The pane is dead, so nothing about it will ever need
				// throttling again. Without this, n.panes grows for the life of
				// a process meant to stay up for weeks; seenSet is bounded for
				// the same reason.
				delete(n.panes, pane)
			}
			continue
		}
		st.attempts++
		if st.attempts >= maxPushAttempts {
			n.log.Warn("notify: giving up on a push",
				"pane", pane, "seq", t.Seq, "to", string(t.To), "attempts", st.attempts)
			st.attempts = 0
			continue
		}
		// Put it back: for a pane that has just gone blocked there is no "next
		// transition" to carry it (see maxPushAttempts). arm() will re-arm one
		// cooldown out, since lastPush was stamped above.
		st.pending = &t
	}
}

// deliver fetches whatever screen the push needs and hands it to the Sink.
//
// Nothing here focuses anything. agent.focus / pane.focus would clear `done`
// back to `idle` and yank the desktop user's UI to another tab (G10) — using
// them as a read-receipt would destroy the very signal this package exists to
// forward. There is no read-receipt, by construction: the Client this package
// reaches through (screen.Extractor) has no method that can express one.
// It reports whether the push landed, so the caller can decide between spending
// the idempotency key and re-arming a retry.
func (n *notifier) deliver(ctx context.Context, t agents.Transition) bool {
	a := t.Agent
	var err error
	switch t.To {
	case agents.StatusBlocked:
		// Use the same source as status detection: Codex's startup trust
		// fallback uses the visible viewport; ordinary dialogs use detection.
		err = n.sink.PushBlocked(ctx, a, n.dialog(a))
	case agents.StatusDone:
		err = n.sink.PushDone(ctx, a, n.tail(a.PaneID))
	case agents.StatusGone:
		// No screen read: the pane is gone, so the read can only fail, and
		// herdr's socket is served by a single UI thread (G10) — calls whose
		// answer is already known are not free.
		err = n.sink.PushGone(ctx, a)
	default:
		// Unreachable: observe filtered the destination. Reported as delivered
		// so that a destination this package grows later cannot become an
		// invisible retry loop.
		return true
	}
	if err != nil {
		// Not recorded as delivered, so the same (pane, seq) may be attempted
		// again — by the bounded retry in flushDue, and by the pane's next
		// transition if it has one. Retries are paced by the cooldown, so a
		// chat channel that is simply down costs one call per cooldown rather
		// than one per transition.
		n.log.Warn("notify: push failed",
			"pane", a.PaneID, "seq", t.Seq, "to", string(t.To), "err", err)
		return false
	}
	n.seen.add(key{pane: a.PaneID, seq: t.Seq})
	n.log.Debug("notify: pushed", "pane", a.PaneID, "seq", t.Seq, "to", string(t.To))
	return true
}

// dialog reads what a blocked agent is asking.
//
// A failed read is not a reason to stay quiet: the agent is stopped until a
// human answers, so a card with an empty body still beats no card at all. The
// card builder already has to degrade to "Esc only, reply in prose" when it
// cannot parse options off the screen (S2 §3.7), and an empty screen lands in
// exactly that path.
func (n *notifier) dialog(a agents.Agent) screen.Screen {
	pane := a.PaneID
	if a.Kind == "codex" && (a.SessionRef == nil || !a.Interactive || a.LaunchPend) {
		if ex, ok := n.ex.(interface {
			CodexTrustDialog(string) (screen.Screen, bool, error)
		}); ok {
			if s, found, err := ex.CodexTrustDialog(pane); err != nil {
				n.log.Warn("notify: cannot read Codex startup dialog", "pane", pane, "err", err)
			} else if found {
				return s
			}
		}
	}
	s, err := n.ex.Dialog(pane)
	if err != nil {
		n.log.Warn("notify: cannot read dialog, pushing without it", "pane", pane, "err", err)
		return screen.Screen{}
	}
	return s
}

// tail reads the end of a finished agent's viewport. As with dialog, a failed
// read costs the body of the message, not the message.
func (n *notifier) tail(pane string) screen.Screen {
	s, err := n.ex.Tail(pane, n.cfg.tailLines)
	if err != nil {
		n.log.Warn("notify: cannot read tail, pushing without it", "pane", pane, "err", err)
		return screen.Screen{}
	}
	return s
}

// arm points the timer at the earliest pending cooldown expiry, or stops it
// when nothing is waiting.
//
// Every pass ends here. A coalesced transition must not sit in its slot waiting
// for some unrelated pane to wake the loop up: for the last agent of the day,
// that unrelated event never comes.
//
// It is also where dead throttling state is dropped. An entry with nothing
// pending exists only to hold the pane's cooldown, and once that cooldown is
// past it cannot change any decision: a transition arriving later would create
// a fresh entry and flush immediately, which is exactly what the stale entry
// would have allowed. Deleting it is therefore behaviour-preserving, and it
// keeps n.panes proportional to the panes in play rather than to every pane the
// bridge has seen in weeks of uptime.
func (n *notifier) arm(tm timer) {
	now := n.cfg.clock()
	var next time.Time
	for pane, st := range n.panes {
		if st.pending == nil {
			if st.lastPush.IsZero() || !now.Before(st.lastPush.Add(n.cfg.cooldown)) {
				delete(n.panes, pane)
			}
			continue
		}
		due := st.lastPush.Add(n.cfg.cooldown)
		if next.IsZero() || due.Before(next) {
			next = due
		}
	}
	if next.IsZero() {
		tm.Stop()
		return
	}
	d := next.Sub(now)
	if d < 0 {
		// flushDue has just run, so anything already due was emitted; a
		// negative gap can only come from a clock that moved. Fire immediately
		// rather than never.
		d = 0
	}
	tm.Reset(d)
}

// key is the idempotency key: one pane, one herdr state sequence.
type key struct {
	pane string
	seq  uint64
}

// seenSet is a bounded FIFO of the keys already pushed. Not safe for concurrent
// use; it belongs to the Run goroutine.
type seenSet struct {
	max   int
	set   map[key]struct{}
	order []key
}

func newSeenSet(max int) *seenSet {
	if max < 1 {
		max = 1
	}
	return &seenSet{max: max, set: make(map[key]struct{}, max)}
}

func (s *seenSet) has(k key) bool {
	_, ok := s.set[k]
	return ok
}

func (s *seenSet) add(k key) {
	if _, ok := s.set[k]; ok {
		return
	}
	s.set[k] = struct{}{}
	s.order = append(s.order, k)
	for len(s.order) > s.max {
		delete(s.set, s.order[0])
		s.order = s.order[1:]
	}
}

func (s *seenSet) len() int { return len(s.set) }
