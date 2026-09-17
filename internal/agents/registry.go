package agents

import (
	"context"
	"errors"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// DegradedPollInterval is the back-off used after a failed poll. herdr is
// either down or its single UI thread is wedged behind a modal dialog (G10);
// either way, retrying at the normal rate buys nothing and fills the log.
const DegradedPollInterval = 5 * time.Second

// defaultSubscriberBuffer is how far a subscriber may fall behind before it
// starts losing transitions. Dropping is the deliberate choice: the poller must
// not be stalled by a consumer that is mid Feishu round-trip.
const defaultSubscriberBuffer = 64

var (
	// ErrNoClient is returned by NewRegistry when it is handed no client.
	// Failing at wiring time beats a nil dereference on the first poll.
	ErrNoClient = errors.New("agents: nil herdr client")

	// ErrRunOnce rejects a second Run. Run closes every subscriber channel when
	// it returns, so a registry cannot be restarted; the caller must build a
	// new one.
	ErrRunOnce = errors.New("agents: Run may be called only once")
)

// waitFunc blocks for d, reporting false if ctx was cancelled first. It is a
// field on the registry so tests can step the poll loop deterministically
// instead of sleeping.
type waitFunc func(ctx context.Context, d time.Duration) bool

func sleepWait(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// RegistryOption configures a Registry.
type RegistryOption func(*registry)

// WithPollInterval overrides how often agent.list is called. Values <= 0 are
// ignored, leaving DefaultPollInterval.
func WithPollInterval(d time.Duration) RegistryOption {
	return func(r *registry) {
		if d > 0 {
			r.interval = d
		}
	}
}

// WithClock injects the time source used for Transition.At and Agent.SeenAt.
// A nil function is ignored.
func WithClock(now func() time.Time) RegistryOption {
	return func(r *registry) {
		if now != nil {
			r.now = now
		}
	}
}

func withWaiter(w waitFunc) RegistryOption {
	return func(r *registry) {
		if w != nil {
			r.wait = w
		}
	}
}

func withSubscriberBuffer(n int) RegistryOption {
	return func(r *registry) {
		if n >= 0 {
			r.subBuf = n
		}
	}
}

// registry is the polling Registry.
//
// Why polling and not events.subscribe (G10):
//
//   - pane.agent_status_changed must be subscribed with a concrete pane_id;
//     there is no wildcard. Watching "every agent" would mean one connection
//     per pane, opened and closed as panes come and go — and a pane that
//     appears between two subscribe calls is invisible until we notice it some
//     other way, which is a poll.
//   - The event ring holds 512 entries and overflows silently, so a bridge that
//     was briefly slow cannot tell that it missed anything.
//   - A reconnect replays from sequence 0, i.e. every historical event again.
//     Fed into the notifier that is a phone full of stale approval cards, each
//     one a live keystroke aimed at a pane that has moved on (G17).
//   - Subscription connections also cannot be pinged: any byte written to them
//     is read as the peer closing.
//
// herdr's own detector ticks at 300ms, so polling agent.list once a second
// costs at most a second of latency, against S1's 1.5s budget for `-> blocked`.
type registry struct {
	client   herdrapi.Client
	interval time.Duration
	backoff  time.Duration
	now      func() time.Time
	wait     waitFunc
	subBuf   int

	started atomic.Bool
	drops   atomic.Uint64

	mu sync.RWMutex
	// agents is the last published view, keyed by pane_id. Never terminal_id:
	// that is not stable across a herdr restart (G10).
	agents map[string]Agent
	// goneSeq counts synthesised disappearances; see goneTransition.
	goneSeq  uint64
	degraded bool
	subs     []chan Transition
	closed   bool
}

var _ Registry = (*registry)(nil)

// NewRegistry returns a Registry that polls c.
func NewRegistry(c herdrapi.Client, opts ...RegistryOption) (Registry, error) {
	if c == nil {
		return nil, ErrNoClient
	}
	r := &registry{
		client:   c,
		interval: DefaultPollInterval,
		backoff:  DegradedPollInterval,
		now:      time.Now,
		wait:     sleepWait,
		subBuf:   defaultSubscriberBuffer,
		agents:   map[string]Agent{},
	}
	for _, opt := range opts {
		opt(r)
	}
	return r, nil
}

// Run polls until ctx is cancelled, then closes every subscriber channel and
// returns ctx.Err(). It may be called once.
func (r *registry) Run(ctx context.Context) error {
	if !r.started.CompareAndSwap(false, true) {
		return ErrRunOnce
	}
	defer r.closeSubs()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		next := r.pollOnce(ctx)
		if !r.wait(ctx, next) {
			return ctx.Err()
		}
	}
}

// pollOnce runs one agent.list and returns how long to wait before the next.
func (r *registry) pollOnce(ctx context.Context) time.Duration {
	list, err := r.client.AgentList(ctx)
	if err != nil {
		if ctx.Err() != nil {
			// Shutting down. Not a herdr fault, so do not brand the registry
			// degraded on the way out.
			return r.backoff
		}
		// A failed poll says nothing about the agents: herdr is unreachable,
		// not empty. Reconciling against "no agents" here would emit Gone for
		// every pane and push "agent disappeared" to the phone every time the
		// desktop UI opens a modal dialog and wedges the socket (G10).
		r.setDegraded(true)
		return r.backoff
	}
	r.setDegraded(false)
	r.reconcile(list)
	return r.interval
}

// reconcile diffs a fresh agent.list against the last published view and
// publishes what actually changed.
//
// This is the only path that ever emits, degraded or not: recovery from an
// outage is a full reconcile against the new snapshot, not a replay of what
// happened while we were blind. An agent that came back exactly as we left it
// produces nothing, so a herdr restart does not repopulate the phone.
func (r *registry) reconcile(list []herdrapi.AgentInfo) {
	now := r.now()

	fresh := make(map[string]Agent, len(list))
	for _, in := range list {
		if in.PaneID == "" {
			// pane_id is the only identifier we can route on and the only one
			// that survives a restart (G10). An entry without one is not
			// addressable, so tracking it would only produce transitions
			// nobody can act on.
			continue
		}
		a := fromWire(in)
		a.SeenAt = now
		fresh[a.PaneID] = a
	}

	var out []Transition

	r.mu.Lock()
	defer r.mu.Unlock()
	for id, a := range fresh {
		prev, known := r.agents[id]
		switch {
		case !known:
			// A first sighting is reported as a transition out of unknown, so
			// a bridge that started after the agent did still learns about a
			// pane that is already blocked.
			out = append(out, Transition{Agent: a.clone(), From: StatusUnknown, To: a.Status, Seq: a.StateSeq, At: now})
		case changed(prev, a):
			out = append(out, Transition{Agent: a.clone(), From: prev.Status, To: a.Status, Seq: a.StateSeq, At: now})
		}
	}
	for id, prev := range r.agents {
		if _, ok := fresh[id]; ok {
			continue
		}
		out = append(out, r.goneTransition(prev, now))
	}
	r.agents = fresh

	// Map iteration order is random; sort so that one poll's transitions reach
	// every subscriber in the same order they reach the next one. Publish under
	// the snapshot lock so a new subscriber cannot replay a newer snapshot and
	// then receive transitions from this earlier poll.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Agent.PaneID != out[j].Agent.PaneID {
			return out[i].Agent.PaneID < out[j].Agent.PaneID
		}
		return out[i].To < out[j].To
	})
	for _, t := range out {
		r.publishLocked(t)
	}
}

// goneTransition synthesises the disappearance of an agent. Because the pane is
// dropped from the tracked map in the same pass, it can only be built once per
// disappearance. Callers must hold r.mu.
//
// The sequence is invented, so it is taken from the top of uint64 and never
// from herdr's counter. The notifier's idempotency key is (pane_id, state_seq)
// and that pair is pushed once, ever (internal/notify/contract.go), while
// herdr's state_change_seq is a single server-global counter that restarts at 0
// with the server (src/app/state.rs) and pane ids ARE restart-stable (G10).
// Anything derived from the last real value — prev+1 included — is therefore a
// number herdr will eventually hand out again for this same pane, and the
// colliding push, which may be the one card that says an agent needs a human
// (G11), would be dropped silently. MaxUint64 counting down is a range that
// counter cannot reach in any lifetime, and the counter makes each Gone
// distinct so a pane that disappears twice produces two keys.
func (r *registry) goneTransition(prev Agent, now time.Time) Transition {
	gone := prev.clone()
	gone.Status = StatusGone
	r.goneSeq++
	gone.StateSeq = math.MaxUint64 - r.goneSeq
	return Transition{Agent: gone, From: prev.Status, To: StatusGone, Seq: gone.StateSeq, At: now}
}

// changed reports whether a poll saw something worth telling subscribers about.
func changed(prev, next Agent) bool {
	if prev.Status != next.Status {
		return true
	}
	if prev.Kind != next.Kind {
		// Same pane, different agent: whoever holds a Guard for this pane is
		// now holding it against a stranger.
		return true
	}
	// state_change_seq is a single server-global counter that starts at 0 with
	// the server, so a value going *backwards* means herdr restarted, not that
	// this agent did anything. Adopting it silently is what keeps a restart
	// from re-announcing every pane that is still exactly where we left it.
	return next.StateSeq > prev.StateSeq
}

// Snapshot returns the last polled view, sorted by pane id. While Degraded, it
// is the last view that was actually observed.
func (r *registry) Snapshot() []Agent {
	r.mu.RLock()
	out := make([]Agent, 0, len(r.agents))
	for _, a := range r.agents {
		out = append(out, a.clone())
	}
	r.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].PaneID < out[j].PaneID })
	return out
}

func (r *registry) Get(paneID string) (Agent, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.agents[paneID]
	if !ok {
		return Agent{}, false
	}
	return a.clone(), true
}

// Subscribe atomically replays the current agents before registering for new
// transitions. Startup order cannot hide an already-blocked or finished agent.
// A subscriber that falls behind loses subsequent events rather than blocking
// the poller; the channel is closed when Run returns.
func (r *registry) Subscribe() <-chan Transition {
	r.mu.Lock()
	defer r.mu.Unlock()
	ch := make(chan Transition, len(r.agents)+r.subBuf)
	if r.closed {
		close(ch)
		return ch
	}
	panes := make([]string, 0, len(r.agents))
	for pane := range r.agents {
		panes = append(panes, pane)
	}
	sort.Strings(panes)
	for _, pane := range panes {
		a := r.agents[pane].clone()
		ch <- Transition{Agent: a, From: StatusUnknown, To: a.Status, Seq: a.StateSeq, At: a.SeenAt}
	}
	r.subs = append(r.subs, ch)
	return ch
}

func (r *registry) Degraded() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.degraded
}

func (r *registry) setDegraded(v bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.degraded = v
}

// publishLocked performs only nonblocking channel writes. The caller holds
// r.mu, keeping publication ordered with snapshots and channel closure.
func (r *registry) publishLocked(t Transition) {
	if r.closed {
		return
	}
	for _, ch := range r.subs {
		select {
		case ch <- t:
		default:
			// Non-blocking on purpose: one slow subscriber must not stop the
			// registry from noticing that another agent needs a human.
			r.drops.Add(1)
		}
	}
}

// dropped counts transitions that no subscriber buffer had room for.
func (r *registry) dropped() uint64 { return r.drops.Load() }

func (r *registry) closeSubs() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	for _, ch := range r.subs {
		close(ch)
	}
	r.subs = nil
}
