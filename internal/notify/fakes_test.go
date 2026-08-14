package notify

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// testTimeout is a failure deadline, not a sleep. The happy path never reaches
// it: the loop hands control back to the test at the end of every pass.
const testTimeout = 2 * time.Second

var epoch = time.Date(2026, 8, 14, 1, 0, 0, 0, time.UTC)

// discardLogger keeps the expected WARN lines (failed pushes, abandoned
// transitions) out of the test output.
func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// ---------- clock ----------

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// ---------- timer ----------

// armEvent is one Reset or Stop. The Run loop ends every pass by arming, so
// these double as the "the notifier has finished reacting" signal that keeps
// these tests free of sleeps.
type armEvent struct {
	d       time.Duration
	stopped bool
}

type fakeTimer struct {
	ch   chan time.Time
	arms chan armEvent
}

func newFakeTimer() *fakeTimer {
	return &fakeTimer{ch: make(chan time.Time), arms: make(chan armEvent, 256)}
}

func (f *fakeTimer) Reset(d time.Duration) { f.arms <- armEvent{d: d} }
func (f *fakeTimer) Stop()                 { f.arms <- armEvent{stopped: true} }
func (f *fakeTimer) C() <-chan time.Time   { return f.ch }

// ---------- registry ----------

type fakeRegistry struct {
	ch   chan agents.Transition
	subs atomic.Int64
	// subscribed closes on the first Subscribe, which is how the harness knows
	// the loop is up before a test starts making assertions about it.
	subscribed chan struct{}
	once       sync.Once
}

var _ agents.Registry = (*fakeRegistry)(nil)

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{ch: make(chan agents.Transition, 16), subscribed: make(chan struct{})}
}

func (f *fakeRegistry) Run(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

func (f *fakeRegistry) Snapshot() []agents.Agent { return nil }

func (f *fakeRegistry) Get(string) (agents.Agent, bool) { return agents.Agent{}, false }

func (f *fakeRegistry) Subscribe() <-chan agents.Transition {
	f.subs.Add(1)
	f.once.Do(func() { close(f.subscribed) })
	return f.ch
}

func (f *fakeRegistry) Degraded() bool { return false }

// stop closes the feed, as the real registry does when its Run returns.
func (f *fakeRegistry) stop() { close(f.ch) }

// ---------- extractor ----------

type extractCall struct {
	op   string // "dialog" | "tail"
	pane string
	n    int
}

type fakeExtractor struct {
	mu        sync.Mutex
	dialog    screen.Screen
	tail      screen.Screen
	dialogErr error
	tailErr   error
	calls     []extractCall
}

var _ screen.Extractor = (*fakeExtractor)(nil)

func newFakeExtractor() *fakeExtractor {
	return &fakeExtractor{
		dialog: screen.Screen{Lines: []string{"Do you want to proceed?", "❯ 1. Yes", "  2. No"}, Rows: 23, Cols: 40},
		tail:   screen.Screen{Lines: []string{"Done.", "$"}, Rows: 23, Cols: 12},
	}
}

func (e *fakeExtractor) Dialog(paneID string) (screen.Screen, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, extractCall{op: "dialog", pane: paneID})
	if e.dialogErr != nil {
		return screen.Screen{}, e.dialogErr
	}
	return e.dialog, nil
}

func (e *fakeExtractor) Tail(paneID string, n int) (screen.Screen, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, extractCall{op: "tail", pane: paneID, n: n})
	if e.tailErr != nil {
		return screen.Screen{}, e.tailErr
	}
	return e.tail, nil
}

func (e *fakeExtractor) recorded() []extractCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]extractCall(nil), e.calls...)
}

func (e *fakeExtractor) setDialogErr(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.dialogErr = err
}

func (e *fakeExtractor) setTailErr(err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.tailErr = err
}

// ---------- sink ----------

type pushKind string

const (
	pushBlocked pushKind = "blocked"
	pushDone    pushKind = "done"
	pushGone    pushKind = "gone"
)

type push struct {
	kind   pushKind
	agent  agents.Agent
	screen screen.Screen
}

type recordingSink struct {
	mu     sync.Mutex
	pushes []push
	// on decides what a push returns. nil means success.
	on func(p push) error
}

var _ Sink = (*recordingSink)(nil)

func (s *recordingSink) record(p push) error {
	s.mu.Lock()
	s.pushes = append(s.pushes, p)
	on := s.on
	s.mu.Unlock()
	if on == nil {
		return nil
	}
	return on(p)
}

func (s *recordingSink) PushBlocked(_ context.Context, a agents.Agent, dialog screen.Screen) error {
	return s.record(push{kind: pushBlocked, agent: a, screen: dialog})
}

func (s *recordingSink) PushDone(_ context.Context, a agents.Agent, tail screen.Screen) error {
	return s.record(push{kind: pushDone, agent: a, screen: tail})
}

func (s *recordingSink) PushGone(_ context.Context, a agents.Agent) error {
	return s.record(push{kind: pushGone, agent: a})
}

func (s *recordingSink) recorded() []push {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]push(nil), s.pushes...)
}

func (s *recordingSink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pushes)
}

func (s *recordingSink) setOn(f func(p push) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.on = f
}

// ---------- harness ----------

type harness struct {
	t      *testing.T
	clk    *fakeClock
	reg    *fakeRegistry
	ex     *fakeExtractor
	sink   *recordingSink
	tm     *fakeTimer
	n      *notifier
	cancel context.CancelFunc
	errCh  chan error
	once   sync.Once
	err    error
}

func newHarness(t *testing.T, opts ...Option) *harness {
	t.Helper()
	ex := newFakeExtractor()
	h := newHarnessEx(t, ex, opts...)
	h.ex = ex
	return h
}

// newHarnessEx starts a notifier over an arbitrary Extractor, so that the
// forbidden-method test can drive the real one over a RecordingClient.
func newHarnessEx(t *testing.T, ex screen.Extractor, opts ...Option) *harness {
	t.Helper()
	clk := &fakeClock{now: epoch}
	reg := newFakeRegistry()
	sink := &recordingSink{}
	tm := newFakeTimer()

	n := New(reg, ex, sink, append([]Option{WithClock(clk.Now)}, opts...)...).(*notifier)
	n.newTimer = func() timer { return tm }
	n.log = discardLogger()

	ctx, cancel := context.WithCancel(context.Background())
	h := &harness{t: t, clk: clk, reg: reg, sink: sink, tm: tm, n: n, cancel: cancel, errCh: make(chan error, 1)}
	go func() { h.errCh <- n.Run(ctx) }()
	t.Cleanup(func() { h.stop() })

	// Run subscribes before it does anything else, so this is the point after
	// which the loop is guaranteed to exist.
	select {
	case <-reg.subscribed:
	case <-time.After(testTimeout):
		t.Fatal("notifier did not subscribe to the registry")
	}
	return h
}

// send feeds one transition and blocks until the loop has finished acting on
// it, so assertions never race the notifier. It returns how the loop armed the
// cooldown timer on the way out of that pass.
func (h *harness) send(tr agents.Transition) armEvent {
	h.t.Helper()
	select {
	case h.reg.ch <- tr:
	case <-time.After(testTimeout):
		h.t.Fatal("notifier is not reading transitions")
	}
	return h.waitPass()
}

// fire expires the cooldown timer and waits for the resulting pass.
func (h *harness) fire() armEvent {
	h.t.Helper()
	select {
	case h.tm.ch <- h.clk.Now():
	case <-time.After(testTimeout):
		h.t.Fatal("notifier is not waiting on the cooldown timer")
	}
	return h.waitPass()
}

// waitPass returns how the loop armed the timer at the end of the pass.
func (h *harness) waitPass() armEvent {
	h.t.Helper()
	select {
	case e := <-h.tm.arms:
		return e
	case <-time.After(testTimeout):
		h.t.Fatal("notifier did not finish a pass")
		return armEvent{}
	}
}

func (h *harness) advance(d time.Duration) { h.clk.advance(d) }

// paneCount and hasPaneState read the notifier's throttling state.
//
// Safe from the test goroutine only between passes: send and fire return by
// receiving the pass's arm event, and that channel handoff publishes every
// write the pass made. The loop is parked in its select until the test feeds
// it again.
func (h *harness) paneCount() int { return len(h.n.panes) }

func (h *harness) hasPaneState(pane string) bool {
	_, ok := h.n.panes[pane]
	return ok
}

// wait blocks until Run returns, without cancelling it first.
func (h *harness) wait() error {
	h.t.Helper()
	h.once.Do(func() {
		select {
		case h.err = <-h.errCh:
		case <-time.After(testTimeout):
			h.t.Error("Run did not return")
		}
	})
	return h.err
}

func (h *harness) stop() error {
	h.cancel()
	return h.wait()
}

// ---------- transitions ----------

func transition(from, to agents.Status, pane string, seq uint64) agents.Transition {
	return agents.Transition{
		Agent: agents.Agent{
			PaneID:      pane,
			WorkspaceID: "w1",
			TabID:       "t1",
			Kind:        "claude",
			Status:      to,
			Cwd:         "/tmp/herdr-accept",
			Title:       "Create hello.txt with touch",
			StateSeq:    seq,
			SeenAt:      epoch,
		},
		From: from,
		To:   to,
		Seq:  seq,
		At:   epoch,
	}
}

func blockedAt(pane string, seq uint64) agents.Transition {
	return transition(agents.StatusWorking, agents.StatusBlocked, pane, seq)
}

func kinds(ps []push) []pushKind {
	out := make([]pushKind, len(ps))
	for i, p := range ps {
		out[i] = p.kind
	}
	return out
}
