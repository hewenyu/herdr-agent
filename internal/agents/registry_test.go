package agents

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// testWaitTimeout is a failure deadline, not a sleep: the happy path never
// reaches it, because the fake clock hands control back and forth explicitly.
const testWaitTimeout = 2 * time.Second

var epoch = time.Date(2026, 8, 14, 1, 0, 0, 0, time.UTC)

// ---------- fake clock ----------

// stepClock is the registry's time source and its pacemaker. The poll loop
// blocks in wait() until the test releases it, which makes every poll a
// deterministic step instead of a race against a real timer.
type stepClock struct {
	mu     sync.Mutex
	now    time.Time
	waits  chan time.Duration
	resume chan struct{}
}

func newStepClock(start time.Time) *stepClock {
	return &stepClock{now: start, waits: make(chan time.Duration), resume: make(chan struct{})}
}

func (c *stepClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *stepClock) wait(ctx context.Context, d time.Duration) bool {
	select {
	case c.waits <- d:
	case <-ctx.Done():
		return false
	}
	select {
	case <-c.resume:
		c.mu.Lock()
		c.now = c.now.Add(d)
		c.mu.Unlock()
		return true
	case <-ctx.Done():
		return false
	}
}

// ---------- scripted herdr ----------

type pollStep struct {
	agents []herdrapi.AgentInfo
	err    error
}

type script struct {
	mu    sync.Mutex
	steps []pollStep
	calls int
}

// next returns the step for this poll, repeating the last one once the script
// runs out so that an extra poll during shutdown cannot fail a test.
func (s *script) next() ([]herdrapi.AgentInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.calls
	s.calls++
	if i >= len(s.steps) {
		i = len(s.steps) - 1
	}
	return s.steps[i].agents, s.steps[i].err
}

func (s *script) polls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// info builds an agent.list entry. terminal_id is filled in on purpose: the
// registry must ignore it (G10).
func info(pane, kind, status string, seq uint64) herdrapi.AgentInfo {
	return herdrapi.AgentInfo{
		PaneID:         pane,
		WorkspaceID:    "w1",
		TabID:          "t1",
		TerminalID:     "term-" + pane,
		Agent:          strp(kind),
		AgentStatus:    status,
		StateChangeSeq: seq,
	}
}

// ---------- harness ----------

type harness struct {
	t      *testing.T
	clk    *stepClock
	client *herdrapi.RecordingClient
	script *script
	reg    *registry
	subs   []<-chan Transition
}

func newHarness(t *testing.T, steps []pollStep, opts ...RegistryOption) *harness {
	return newHarnessSubs(t, steps, 1, opts...)
}

func newHarnessSubs(t *testing.T, steps []pollStep, nsubs int, opts ...RegistryOption) *harness {
	t.Helper()
	if len(steps) == 0 {
		t.Fatal("empty script")
	}
	sc := &script{steps: steps}
	client := &herdrapi.RecordingClient{
		OnAgentList: func(context.Context) ([]herdrapi.AgentInfo, error) { return sc.next() },
	}
	clk := newStepClock(epoch)

	base := []RegistryOption{WithClock(clk.Now), withWaiter(clk.wait)}
	r, err := NewRegistry(client, append(base, opts...)...)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	h := &harness{t: t, clk: clk, client: client, script: sc, reg: r.(*registry)}
	for i := 0; i < nsubs; i++ {
		h.subs = append(h.subs, h.reg.Subscribe())
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.reg.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("Run returned %v, want context.Canceled", err)
			}
		case <-time.After(testWaitTimeout):
			t.Error("Run did not return after cancel")
		}
	})
	return h
}

// settle blocks until the poller has finished a poll and asked how long to
// wait. Everything that poll published is already in the subscriber buffers.
func (h *harness) settle() time.Duration {
	h.t.Helper()
	select {
	case d := <-h.clk.waits:
		return d
	case <-time.After(testWaitTimeout):
		h.t.Fatal("poller never reached its next wait")
		return 0
	}
}

// advance releases the poller to run the next poll.
func (h *harness) advance() {
	h.t.Helper()
	select {
	case h.clk.resume <- struct{}{}:
	case <-time.After(testWaitTimeout):
		h.t.Fatal("poller never picked up the next tick")
	}
}

// tick returns one poll's requested interval and the transitions it published.
func (h *harness) tick() (time.Duration, []Transition) {
	h.t.Helper()
	d := h.settle()
	return d, drain(h.subs[0])
}

func drain(ch <-chan Transition) []Transition {
	var out []Transition
	for {
		select {
		case t, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, t)
		default:
			return out
		}
	}
}

type edge struct {
	pane string
	from Status
	to   Status
	seq  uint64
}

// synthSeq stands in for a Gone sequence in a wanted edge. Those numbers are
// invented by the registry from the top of uint64 rather than taken from
// herdr's counter, so they are asserted by range: see goneTransition, and
// maxSynthGone below.
const synthSeq uint64 = 0

// maxSynthGone is how far down from MaxUint64 a synthesised sequence may sit
// and still be recognisably out of herdr's reach.
const maxSynthGone = 16

func isSynthSeq(seq uint64) bool { return seq >= math.MaxUint64-maxSynthGone }

func edgesOf(ts []Transition) []edge {
	out := make([]edge, 0, len(ts))
	for _, t := range ts {
		out = append(out, edge{t.Agent.PaneID, t.From, t.To, t.Seq})
	}
	return out
}

func wantEdges(t *testing.T, poll int, got []Transition, want []edge) {
	t.Helper()
	g := edgesOf(got)
	if len(g) != len(want) {
		t.Fatalf("poll %d: got %d transitions %+v, want %d %+v", poll, len(g), g, len(want), want)
	}
	for i := range want {
		if want[i].to == StatusGone && want[i].seq == synthSeq {
			if got := (edge{g[i].pane, g[i].from, g[i].to, synthSeq}); got != want[i] {
				t.Fatalf("poll %d transition %d: got %+v, want %+v", poll, i, g[i], want[i])
			}
			// The notifier's idempotency key is (pane_id, state_seq) and pane
			// ids survive a herdr restart while its counter does not (G10), so
			// an invented sequence has to come from where that counter can
			// never reach.
			if !isSynthSeq(g[i].seq) {
				t.Fatalf("poll %d transition %d: gone seq = %d, want a synthesised one near MaxUint64",
					poll, i, g[i].seq)
			}
			continue
		}
		if g[i] != want[i] {
			t.Fatalf("poll %d transition %d: got %+v, want %+v", poll, i, g[i], want[i])
		}
	}
	for _, tr := range got {
		if tr.Agent.Status != tr.To {
			t.Errorf("poll %d: Transition.Agent.Status = %q but To = %q", poll, tr.Agent.Status, tr.To)
		}
		if tr.Agent.StateSeq != tr.Seq {
			t.Errorf("poll %d: Transition.Seq = %d but Agent.StateSeq = %d", poll, tr.Seq, tr.Agent.StateSeq)
		}
	}
}

// ---------- tests ----------

func TestNewRegistryRejectsNilClient(t *testing.T) {
	if _, err := NewRegistry(nil); !errors.Is(err, ErrNoClient) {
		t.Fatalf("NewRegistry(nil) error = %v, want ErrNoClient", err)
	}
}

func TestDefaultPollIntervalIsUsed(t *testing.T) {
	h := newHarness(t, []pollStep{{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 1)}}})
	if d := h.settle(); d != DefaultPollInterval {
		t.Fatalf("poll interval = %v, want %v", d, DefaultPollInterval)
	}
}

func TestTransitionKinds(t *testing.T) {
	steps := []pollStep{
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "working", 1)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "blocked", 2)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 3)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "done", 4)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 5)}},
		// Status flipped without the sequence moving: still a transition.
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "done", 5)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "unknown", 6)}},
		{agents: []herdrapi.AgentInfo{}},
	}
	want := [][]edge{
		{{"w1:p1", StatusUnknown, StatusWorking, 1}}, // first sighting
		{{"w1:p1", StatusWorking, StatusBlocked, 2}},
		{{"w1:p1", StatusBlocked, StatusIdle, 3}},
		// done is idle-not-yet-seen; the edge exists even though the agent
		// condition is unchanged, because only `-> done` is a notify edge (G11).
		{{"w1:p1", StatusIdle, StatusDone, 4}},
		{{"w1:p1", StatusDone, StatusIdle, 5}},
		{{"w1:p1", StatusIdle, StatusDone, 5}},
		{{"w1:p1", StatusDone, StatusUnknown, 6}},
		{{"w1:p1", StatusUnknown, StatusGone, synthSeq}},
	}

	h := newHarness(t, steps, WithPollInterval(time.Second))
	for i, w := range want {
		d, got := h.tick()
		if d != time.Second {
			t.Fatalf("poll %d: interval = %v, want 1s", i+1, d)
		}
		wantEdges(t, i+1, got, w)
		h.advance()
	}
}

func TestTransitionCarriesAgentAndClock(t *testing.T) {
	ref := herdrapi.SessionRef{Source: "herdr:claude", Agent: "claude", Kind: "id", Value: "abc"}
	first := info("w1:p1", "claude", "blocked", 7)
	first.Cwd = strp("/tmp/proj")
	first.TerminalTitleStripped = strp("Create hello.txt with touch")
	first.AgentSession = &ref
	first.InteractiveReady = true

	h := newHarness(t, []pollStep{{agents: []herdrapi.AgentInfo{first}}}, WithPollInterval(time.Second))
	_, got := h.tick()
	if len(got) != 1 {
		t.Fatalf("got %d transitions, want 1", len(got))
	}
	tr := got[0]
	if tr.At != epoch {
		t.Errorf("At = %v, want %v", tr.At, epoch)
	}
	if tr.Agent.SeenAt != epoch {
		t.Errorf("SeenAt = %v, want %v", tr.Agent.SeenAt, epoch)
	}
	if tr.Agent.Cwd != "/tmp/proj" || tr.Agent.Title != "Create hello.txt with touch" || !tr.Agent.Interactive {
		t.Errorf("agent not mapped from the wire: %+v", tr.Agent)
	}
	if tr.Agent.SessionRef == nil || tr.Agent.SessionRef.Value != "abc" {
		t.Errorf("SessionRef = %+v, want value abc", tr.Agent.SessionRef)
	}

	// Snapshot and Get agree with what was published, and hand out copies.
	snap := h.reg.Snapshot()
	if len(snap) != 1 || snap[0].PaneID != "w1:p1" || snap[0].Status != StatusBlocked {
		t.Fatalf("Snapshot = %+v", snap)
	}
	if snap[0].SessionRef == tr.Agent.SessionRef {
		t.Error("Snapshot aliases the published SessionRef")
	}
	if a, ok := h.reg.Get("w1:p1"); !ok || a.StateSeq != 7 {
		t.Fatalf("Get = %+v, %v", a, ok)
	}
	if _, ok := h.reg.Get("nope"); ok {
		t.Error("Get returned an agent for an unknown pane")
	}
}

func TestUnchangedPollEmitsNothingButRefreshesSeenAt(t *testing.T) {
	same := []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 3)}
	h := newHarness(t, []pollStep{{agents: same}, {agents: same}, {agents: same}}, WithPollInterval(time.Second))

	if _, got := h.tick(); len(got) != 1 {
		t.Fatalf("first poll: got %d transitions, want 1", len(got))
	}
	h.advance()

	for i := 2; i <= 3; i++ {
		_, got := h.tick()
		if len(got) != 0 {
			t.Fatalf("poll %d: got %+v, want no transitions", i, edgesOf(got))
		}
		h.advance()
	}
	// The last poll observed is poll 3, stamped two intervals after the epoch;
	// poll 4 may already have run, so accept anything strictly later.
	a, ok := h.reg.Get("w1:p1")
	if !ok {
		t.Fatal("agent disappeared")
	}
	if !a.SeenAt.After(epoch) {
		t.Fatalf("SeenAt = %v, want later than %v: a quiet agent is still being seen", a.SeenAt, epoch)
	}
}

func TestTerminalIDIsNeverTheKey(t *testing.T) {
	// Same pane, same agent, same state — but herdr handed out a new
	// terminal_id, which happens across a restart (G10). Keying on it would
	// produce a spurious gone+appear pair here.
	before := info("w1:p1", "claude", "blocked", 5)
	after := info("w1:p1", "claude", "blocked", 5)
	after.TerminalID = "term-brand-new"

	h := newHarness(t, []pollStep{{agents: []herdrapi.AgentInfo{before}}, {agents: []herdrapi.AgentInfo{after}}},
		WithPollInterval(time.Second))
	if _, got := h.tick(); len(got) != 1 {
		t.Fatalf("first poll: got %d transitions, want 1", len(got))
	}
	h.advance()
	if _, got := h.tick(); len(got) != 0 {
		t.Fatalf("terminal_id change produced %+v, want nothing", edgesOf(got))
	}
}

func TestKindChangeIsAnAgentReplacement(t *testing.T) {
	h := newHarness(t, []pollStep{
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 4)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "codex", "idle", 4)}},
	}, WithPollInterval(time.Second))

	h.tick()
	h.advance()
	_, got := h.tick()
	wantEdges(t, 2, got, []edge{{"w1:p1", StatusIdle, StatusIdle, 4}})
	if got[0].Agent.Kind != "codex" {
		t.Fatalf("kind = %q, want codex", got[0].Agent.Kind)
	}
}

func TestEntriesWithoutPaneIDAreIgnored(t *testing.T) {
	nameless := info("", "claude", "blocked", 1)
	h := newHarness(t, []pollStep{{agents: []herdrapi.AgentInfo{nameless, info("w1:p1", "claude", "idle", 2)}}},
		WithPollInterval(time.Second))
	_, got := h.tick()
	wantEdges(t, 1, got, []edge{{"w1:p1", StatusUnknown, StatusIdle, 2}})
	if n := len(h.reg.Snapshot()); n != 1 {
		t.Fatalf("Snapshot has %d agents, want 1", n)
	}
}

func TestGoneIsEmittedExactlyOnce(t *testing.T) {
	steps := []pollStep{
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "blocked", 9), info("w1:p2", "codex", "working", 10)}},
		{agents: []herdrapi.AgentInfo{info("w1:p2", "codex", "working", 10)}},
		{agents: []herdrapi.AgentInfo{info("w1:p2", "codex", "working", 10)}},
		{agents: []herdrapi.AgentInfo{info("w1:p2", "codex", "working", 10)}},
	}
	h := newHarness(t, steps, WithPollInterval(time.Second))

	_, got := h.tick()
	wantEdges(t, 1, got, []edge{
		{"w1:p1", StatusUnknown, StatusBlocked, 9},
		{"w1:p2", StatusUnknown, StatusWorking, 10},
	})
	h.advance()

	_, got = h.tick()
	// The seq is synthesised, and it comes from a range herdr's counter cannot
	// reach: the notifier's key is (pane, seq) and it pushes that pair once
	// ever, so a value the counter will hand out again for this pane after a
	// restart would silently swallow a future card for it.
	wantEdges(t, 2, got, []edge{{"w1:p1", StatusBlocked, StatusGone, synthSeq}})
	if got[0].Agent.Kind != "claude" {
		t.Fatalf("gone transition lost the agent it describes: %+v", got[0].Agent)
	}
	if !isSynthSeq(got[0].Agent.StateSeq) {
		t.Fatalf("gone Agent.StateSeq = %d, want a synthesised sequence", got[0].Agent.StateSeq)
	}
	if _, ok := h.reg.Get("w1:p1"); ok {
		t.Error("a gone agent is still in the registry")
	}
	h.advance()

	for i := 3; i <= 4; i++ {
		_, got := h.tick()
		if len(got) != 0 {
			t.Fatalf("poll %d: gone repeated: %+v", i, edgesOf(got))
		}
		h.advance()
	}
}

func TestReappearingPaneIsANewSighting(t *testing.T) {
	h := newHarness(t, []pollStep{
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 2)}},
		{agents: []herdrapi.AgentInfo{}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "working", 8)}},
		{agents: []herdrapi.AgentInfo{}},
	}, WithPollInterval(time.Second))

	h.tick()
	h.advance()
	_, got := h.tick()
	wantEdges(t, 2, got, []edge{{"w1:p1", StatusIdle, StatusGone, synthSeq}})
	first := got[0].Seq
	h.advance()

	_, got = h.tick()
	wantEdges(t, 3, got, []edge{{"w1:p1", StatusUnknown, StatusWorking, 8}})
	h.advance()

	// The same pane disappearing twice must produce two different keys, or the
	// notifier — which pushes each (pane, seq) once, ever — would announce only
	// the first of the two disappearances.
	_, got = h.tick()
	wantEdges(t, 4, got, []edge{{"w1:p1", StatusWorking, StatusGone, synthSeq}})
	if second := got[0].Seq; second == first {
		t.Fatalf("both disappearances of w1:p1 got seq %d; the second push would be deduplicated away", second)
	}
}

func TestSlowSubscriberDropsInsteadOfStallingThePoller(t *testing.T) {
	steps := []pollStep{
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "working", 1)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "blocked", 2)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 3)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "done", 4)}},
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "working", 5)}},
	}
	// Two subscribers with room for 2 transitions each: the first keeps up, the
	// second never reads.
	h := newHarnessSubs(t, steps, 2, WithPollInterval(time.Second), withSubscriberBuffer(2))

	var fast []Transition
	for i := 1; i <= len(steps); i++ {
		if d := h.settle(); d != time.Second {
			t.Fatalf("poll %d: interval = %v, want 1s: a full subscriber must not slow the poller", i, d)
		}
		fast = append(fast, drain(h.subs[0])...)
		h.advance()
	}
	if got := h.script.polls(); got < len(steps) {
		t.Fatalf("only %d polls ran, want at least %d", got, len(steps))
	}
	// The attentive subscriber saw every edge, in order, undisturbed by the
	// other one being full.
	wantEdges(t, 0, fast, []edge{
		{"w1:p1", StatusUnknown, StatusWorking, 1},
		{"w1:p1", StatusWorking, StatusBlocked, 2},
		{"w1:p1", StatusBlocked, StatusIdle, 3},
		{"w1:p1", StatusIdle, StatusDone, 4},
		{"w1:p1", StatusDone, StatusWorking, 5},
	})
	if n := len(h.subs[1]); n != 2 {
		t.Errorf("slow subscriber holds %d transitions, want its full buffer of 2", n)
	}
	if got, want := h.reg.dropped(), uint64(len(steps)-2); got != want {
		t.Errorf("dropped = %d, want %d (everything the slow subscriber had no room for)", got, want)
	}
	// What it kept is the oldest unread news, in order: a non-blocking send
	// drops the newest rather than evicting.
	wantEdges(t, 0, drain(h.subs[1]), []edge{
		{"w1:p1", StatusUnknown, StatusWorking, 1},
		{"w1:p1", StatusWorking, StatusBlocked, 2},
	})
}

func TestDegradedBacksOffAndRecoversByFullReconcile(t *testing.T) {
	down := errors.New("dial unix: connection refused")
	steps := []pollStep{
		{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "blocked", 10), info("w1:p2", "codex", "working", 11)}},
		{err: down},
		{err: down},
		{agents: []herdrapi.AgentInfo{
			// herdr restarted: the global state_change_seq counter is back near
			// zero and terminal ids are new, but this pane is exactly where we
			// left it. Nothing must be published for it.
			func() herdrapi.AgentInfo {
				a := info("w1:p1", "claude", "blocked", 2)
				a.TerminalID = "term-fresh"
				return a
			}(),
			// A pane that appeared while we were blind.
			info("w1:p3", "claude", "done", 3),
			// w1:p2 did not come back.
		}},
		{agents: []herdrapi.AgentInfo{
			info("w1:p1", "claude", "blocked", 2),
			info("w1:p3", "claude", "done", 3),
		}},
	}
	h := newHarness(t, steps, WithPollInterval(time.Second))

	d, got := h.tick()
	wantEdges(t, 1, got, []edge{
		{"w1:p1", StatusUnknown, StatusBlocked, 10},
		{"w1:p2", StatusUnknown, StatusWorking, 11},
	})
	if d != time.Second {
		t.Fatalf("healthy interval = %v, want 1s", d)
	}
	if h.reg.Degraded() {
		t.Fatal("degraded after a successful poll")
	}
	h.advance()

	for i := 2; i <= 3; i++ {
		d, got := h.tick()
		if d != DegradedPollInterval {
			t.Fatalf("poll %d: interval = %v, want the %v back-off", i, d, DegradedPollInterval)
		}
		if !h.reg.Degraded() {
			t.Fatalf("poll %d: Degraded() = false after a failed poll", i)
		}
		// A poll that failed tells us nothing about the agents. It must not be
		// read as "they all vanished".
		if len(got) != 0 {
			t.Fatalf("poll %d published %+v while herdr was unreachable", i, edgesOf(got))
		}
		if n := len(h.reg.Snapshot()); n != 2 {
			t.Fatalf("poll %d: Snapshot has %d agents, want the last observed 2", i, n)
		}
		h.advance()
	}

	d, got = h.tick()
	if d != time.Second {
		t.Fatalf("interval after recovery = %v, want 1s", d)
	}
	if h.reg.Degraded() {
		t.Fatal("still degraded after a successful poll")
	}
	// Full reconcile against the fresh snapshot: the unchanged pane is silent
	// even though its sequence number moved, the pane that never came back is
	// gone, and the new one is announced.
	wantEdges(t, 4, got, []edge{
		{"w1:p2", StatusWorking, StatusGone, synthSeq},
		{"w1:p3", StatusUnknown, StatusDone, 3},
	})
	if a, ok := h.reg.Get("w1:p1"); !ok || a.StateSeq != 2 {
		t.Fatalf("the surviving agent kept a stale sequence: %+v (ok=%v)", a, ok)
	}
	h.advance()

	if _, got := h.tick(); len(got) != 0 {
		t.Fatalf("poll 5 published %+v, want nothing", edgesOf(got))
	}
}

func TestRegistryOnlyEverCallsAgentList(t *testing.T) {
	h := newHarness(t, []pollStep{{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 1)}}},
		WithPollInterval(time.Second))
	for i := 0; i < 3; i++ {
		h.settle()
		h.advance()
	}
	forbidden := map[string]bool{}
	for _, m := range herdrapi.ForbiddenMethods {
		forbidden[m] = true
	}
	for _, m := range h.client.Methods() {
		if m != "agent.list" {
			t.Errorf("registry called %q; polling needs nothing else", m)
		}
		if forbidden[m] {
			t.Errorf("registry called forbidden method %q", m)
		}
	}
}

func TestSubscribersAreClosedWhenRunReturns(t *testing.T) {
	sc := &script{steps: []pollStep{{agents: []herdrapi.AgentInfo{info("w1:p1", "claude", "idle", 1)}}}}
	client := &herdrapi.RecordingClient{
		OnAgentList: func(context.Context) ([]herdrapi.AgentInfo, error) { return sc.next() },
	}
	clk := newStepClock(epoch)
	r, err := NewRegistry(client, WithClock(clk.Now), withWaiter(clk.wait))
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	reg := r.(*registry)
	sub := reg.Subscribe()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- reg.Run(ctx) }()

	select {
	case <-clk.waits: // first poll finished
	case <-time.After(testWaitTimeout):
		t.Fatal("no first poll")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
	case <-time.After(testWaitTimeout):
		t.Fatal("Run did not return after cancel")
	}

	// Drain the one transition, then the channel must be closed rather than
	// left dangling.
	for {
		_, ok := <-sub
		if !ok {
			break
		}
	}
	select {
	case _, ok := <-reg.Subscribe():
		if ok {
			t.Fatal("Subscribe after Run returned a live channel")
		}
	case <-time.After(testWaitTimeout):
		t.Fatal("Subscribe after Run returned an open channel")
	}

	if err := reg.Run(context.Background()); !errors.Is(err, ErrRunOnce) {
		t.Fatalf("second Run returned %v, want ErrRunOnce", err)
	}
}

func TestSleepWaitHonoursContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sleepWait(ctx, time.Hour) {
		t.Error("sleepWait returned true for a cancelled context")
	}
	if sleepWait(ctx, 0) {
		t.Error("sleepWait returned true for a cancelled context with no delay")
	}
	if !sleepWait(context.Background(), 0) {
		t.Error("sleepWait(0) should return immediately")
	}
}
