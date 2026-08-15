package bridge

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/screen"
	"github.com/hewenyu/herdr-agent/internal/selection"
)

// epoch is the fixed "now" every test runs at, so a card's issued-at is an
// assertable constant rather than whatever the clock said.
var epoch = time.Date(2026, 8, 14, 3, 4, 5, 0, time.UTC)

const (
	testChat     = "oc_notify"
	testOwner    = "ou_00000000000000000000000000000001" // the allowlisted open_id (G17 product decision)
	testNonce    = "n0nce-0123456789abcdef"
	testStranger = "ou_somebody_else"
)

// discardLogger keeps the expected WARN/ERROR lines out of the test output.
func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// ---------- lark.Bot ----------

type sendCall struct {
	Out lark.Out
	ID  string
	Err error
}

type cardUpdate struct {
	MessageID string
	Card      string
}

type fakeBot struct {
	mu sync.Mutex

	// sendErrs is consumed one entry per Send; a nil entry (or an exhausted
	// queue) means the send succeeds.
	sendErrs []error
	calls    []sendCall
	updates  []cardUpdate
	streams  []*fakeStream
	nextID   int

	onMessage func(context.Context, lark.Msg) error
	onAction  func(context.Context, lark.Action) error
	life      lark.Lifecycle

	// handlersAtStart records what was registered by the time Start ran, which
	// is the ordering the lark contract requires.
	handlersAtStart int
	started         chan struct{}
	startErr        error
	openID          string
}

var _ lark.Bot = (*fakeBot)(nil)

func newFakeBot() *fakeBot {
	return &fakeBot{started: make(chan struct{}), openID: "ou_bot"}
}

func (f *fakeBot) Start(ctx context.Context) error {
	f.mu.Lock()
	if f.onMessage != nil {
		f.handlersAtStart++
	}
	if f.onAction != nil {
		f.handlersAtStart++
	}
	err := f.startErr
	f.mu.Unlock()

	close(f.started)
	if err != nil {
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}

func (f *fakeBot) Stop(context.Context) error { return nil }

func (f *fakeBot) OnMessage(h func(context.Context, lark.Msg) error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onMessage = h
}

func (f *fakeBot) OnCardAction(h func(context.Context, lark.Action) error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onAction = h
}

func (f *fakeBot) SetLifecycle(l lark.Lifecycle) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.life = l
}

func (f *fakeBot) Send(_ context.Context, o lark.Out) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	var err error
	if len(f.sendErrs) > 0 {
		err, f.sendErrs = f.sendErrs[0], f.sendErrs[1:]
	}
	if err != nil {
		f.calls = append(f.calls, sendCall{Out: o, Err: err})
		return "", err
	}
	f.nextID++
	id := fmt.Sprintf("om_%d", f.nextID)
	f.calls = append(f.calls, sendCall{Out: o, ID: id})
	return id, nil
}

func (f *fakeBot) UpdateCard(_ context.Context, messageID, cardJSON string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updates = append(f.updates, cardUpdate{MessageID: messageID, Card: cardJSON})
	return nil
}

func (f *fakeBot) Stream(_ context.Context, o lark.Out) (lark.Stream, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := &fakeStream{out: o}
	f.streams = append(f.streams, s)
	return s, nil
}

func (f *fakeBot) BotOpenID(context.Context) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.openID
}

func (f *fakeBot) sends() []sendCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sendCall(nil), f.calls...)
}

func (f *fakeBot) cardUpdates() []cardUpdate {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]cardUpdate(nil), f.updates...)
}

func (f *fakeBot) failNext(errs ...error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sendErrs = append(f.sendErrs, errs...)
}

func (f *fakeBot) handlers() (msg func(context.Context, lark.Msg) error, act func(context.Context, lark.Action) error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.onMessage, f.onAction
}

type fakeStream struct {
	out    lark.Out
	chunks []string
	closed bool
}

func (s *fakeStream) Append(_ context.Context, chunk string) error {
	s.chunks = append(s.chunks, chunk)
	return nil
}
func (s *fakeStream) Flush(context.Context) error { return nil }
func (s *fakeStream) Close(context.Context) error { s.closed = true; return nil }

// ---------- dedup.Store ----------

type dedupOp struct{ Op, NS, Key string }

type fakeDedup struct {
	mu   sync.Mutex
	seen map[string]bool
	ops  []dedupOp
}

func newFakeDedup() *fakeDedup { return &fakeDedup{seen: map[string]bool{}} }

func (f *fakeDedup) SeenOrMark(ns, key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, dedupOp{"SeenOrMark", ns, key})
	k := ns + ":" + key
	if f.seen[k] {
		return true
	}
	f.seen[k] = true
	return false
}

func (f *fakeDedup) Unmark(ns, key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, dedupOp{"Unmark", ns, key})
	delete(f.seen, ns+":"+key)
}

func (f *fakeDedup) Flush() error { return nil }
func (f *fakeDedup) Close() error { return nil }

func (f *fakeDedup) history() []dedupOp {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]dedupOp(nil), f.ops...)
}

// ---------- routes.Store ----------

type bindCall struct{ MessageID, PaneID string }

type fakeRoutes struct {
	mu    sync.Mutex
	binds []bindCall
	table map[string]string
}

func newFakeRoutes() *fakeRoutes { return &fakeRoutes{table: map[string]string{}} }

func (f *fakeRoutes) Bind(messageID, paneID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.binds = append(f.binds, bindCall{messageID, paneID})
	f.table[messageID] = paneID
}

func (f *fakeRoutes) Lookup(messageID string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.table[messageID]
	return p, ok
}

func (f *fakeRoutes) Flush() error { return nil }
func (f *fakeRoutes) Close() error { return nil }

func (f *fakeRoutes) bound() []bindCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bindCall(nil), f.binds...)
}

// boundPanes is bound() with each value read back the way the routing path
// reads it, so a test can assert WHERE a message points without knowing that
// the identity of the agent travels in the same string.
func (f *fakeRoutes) boundPanes() []bindCall {
	out := f.bound()
	for i := range out {
		bd, ok := decodeBinding(out[i].PaneID)
		if !ok {
			out[i].PaneID = ""
			continue
		}
		out[i].PaneID = bd.Pane
	}
	return out
}

// bindAbout registers a message the way the bridge does: pointing at the agent,
// not merely at the seat it is sitting in.
func (f *fakeRoutes) bindAbout(messageID string, a agents.Agent) {
	f.Bind(messageID, encodeBinding(a))
}

// ---------- agents.Registry ----------

type fakeRegistry struct {
	mu       sync.Mutex
	agents   []agents.Agent
	ch       chan agents.Transition
	degraded bool
}

var _ agents.Registry = (*fakeRegistry)(nil)

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{ch: make(chan agents.Transition, 8)}
}

func (f *fakeRegistry) Run(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }

func (f *fakeRegistry) Snapshot() []agents.Agent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agents.Agent(nil), f.agents...)
}

func (f *fakeRegistry) Get(paneID string) (agents.Agent, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, a := range f.agents {
		if a.PaneID == paneID {
			return a, true
		}
	}
	return agents.Agent{}, false
}

func (f *fakeRegistry) Subscribe() <-chan agents.Transition { return f.ch }

func (f *fakeRegistry) Degraded() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.degraded
}

// ---------- agents.Controller ----------

type keyCall struct {
	Guard agents.Guard
	Key   string
}

type sayCall struct {
	Guard agents.Guard
	Text  string
}

type fakeController struct {
	mu sync.Mutex

	keys       []keyCall
	says       []sayCall
	interrupts []agents.Guard

	keyResult agents.Agent
	keyErr    error
	sayResult agents.Delivery
	sayErr    error
}

var _ agents.Controller = (*fakeController)(nil)

func (f *fakeController) SendKey(_ context.Context, g agents.Guard, key string) (agents.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.keys = append(f.keys, keyCall{g, key})
	return f.keyResult, f.keyErr
}

func (f *fakeController) Say(_ context.Context, g agents.Guard, text string) (agents.Delivery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.says = append(f.says, sayCall{g, text})
	return f.sayResult, f.sayErr
}

func (f *fakeController) Interrupt(_ context.Context, g agents.Guard) (agents.Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.interrupts = append(f.interrupts, g)
	return f.keyResult, f.keyErr
}

func (f *fakeController) sentKeys() []keyCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]keyCall(nil), f.keys...)
}

// ---------- screen.Extractor ----------

type fakeExtractor struct {
	mu      sync.Mutex
	dialog  screen.Screen
	tail    screen.Screen
	dialErr error
	tailErr error
}

var _ screen.Extractor = (*fakeExtractor)(nil)

func (f *fakeExtractor) Dialog(string) (screen.Screen, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.dialog, f.dialErr
}

func (f *fakeExtractor) Tail(string, int) (screen.Screen, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tail, f.tailErr
}

// ---------- agents.TranscriptResolver ----------

type fakeResolver struct {
	paths map[string]string
}

var _ agents.TranscriptResolver = (*fakeResolver)(nil)

func (f *fakeResolver) Resolve(a agents.Agent) (string, bool) {
	p, ok := f.paths[a.PaneID]
	return p, ok
}

// transcript registers a pane's transcript file. A pane with no entry is the
// state every claude session starts in — herdr has detected the agent but no
// session id has been published yet (G8) — so the zero harness resolves
// nothing on purpose.
func (h *harness) transcript(paneID, path string) {
	h.res.paths[paneID] = path
}

// ---------- mirror.Watcher ----------

type fakeWatcher struct {
	mu        sync.Mutex
	on        map[string]bool
	turns     chan mirror.PaneTurn
	enabled   []string
	enableErr error
}

var _ mirror.Watcher = (*fakeWatcher)(nil)

func newFakeWatcher() *fakeWatcher {
	return &fakeWatcher{on: map[string]bool{}, turns: make(chan mirror.PaneTurn, 8)}
}

func (f *fakeWatcher) Run(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }

func (f *fakeWatcher) Enable(paneID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.enableErr != nil {
		return f.enableErr
	}
	f.on[paneID] = true
	f.enabled = append(f.enabled, paneID)
	return nil
}

func (f *fakeWatcher) Disable(paneID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.on, paneID)
}

func (f *fakeWatcher) Enabled(paneID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on[paneID]
}

func (f *fakeWatcher) Turns() <-chan mirror.PaneTurn { return f.turns }

// ---------- harness ----------

type harness struct {
	t *testing.T
	b *bridge

	bot     *fakeBot
	dedup   *fakeDedup
	routes  *fakeRoutes
	reg     *fakeRegistry
	ctrl    *fakeController
	ex      *fakeExtractor
	res     *fakeResolver
	watcher *fakeWatcher
	// sel is the real selection store on a temp file, not a fake: its rules — a
	// target with no identity refused, nothing ever expiring — are half of what
	// the routing tests are asserting, and a fake would only assert my idea of
	// them. It is nil for a harness built without one.
	sel *selection.FileStore

	mu     sync.Mutex
	sleeps []time.Duration
}

// newHarness builds a bridge over fakes, with every seam pinned: a frozen
// clock, a fixed nonce, a sleep that records instead of waiting, and a logger
// that goes nowhere.
func newHarness(t *testing.T, mutate ...func(*Deps)) *harness {
	t.Helper()
	return buildHarness(t, true, mutate...)
}

// newHarnessWithoutSelection builds the bridge exactly as New does — no options
// — which is the configuration a caller that never opened a selection store
// gets. It must route, not panic.
func newHarnessWithoutSelection(t *testing.T, mutate ...func(*Deps)) *harness {
	t.Helper()
	return buildHarness(t, false, mutate...)
}

func buildHarness(t *testing.T, withSelection bool, mutate ...func(*Deps)) *harness {
	t.Helper()

	h := &harness{
		t:       t,
		bot:     newFakeBot(),
		dedup:   newFakeDedup(),
		routes:  newFakeRoutes(),
		reg:     newFakeRegistry(),
		ctrl:    &fakeController{},
		ex:      &fakeExtractor{},
		res:     &fakeResolver{paths: map[string]string{}},
		watcher: newFakeWatcher(),
	}

	d := Deps{
		Bot:            h.bot,
		Registry:       h.reg,
		Controller:     h.ctrl,
		Extractor:      h.ex,
		Resolver:       h.res,
		Dedup:          h.dedup,
		Routes:         h.routes,
		Watcher:        h.watcher,
		AllowedOpenIDs: []string{testOwner},
		NotifyChatID:   testChat,
		Now:            func() time.Time { return epoch },
	}
	for _, m := range mutate {
		m(&d)
	}

	var opts []Option
	if withSelection {
		// The store shares the harness clock, so a test can walk past
		// selection.StaleAfter without sleeping. Auto-flush is off because
		// nothing here reopens the file and an fsync per Set would slow every
		// test that selects an agent.
		sel, err := selection.OpenWith(filepath.Join(t.TempDir(), "selection.json"),
			selection.WithClock(func() time.Time { return d.Now() }),
			selection.WithAutoFlush(false))
		if err != nil {
			t.Fatalf("selection.OpenWith: %v", err)
		}
		t.Cleanup(func() { _ = sel.Close() })
		h.sel = sel
		opts = append(opts, WithSelection(sel))
	}

	b, err := newBridge(d, opts...)
	if err != nil {
		t.Fatalf("newBridge: %v", err)
	}
	b.log = discardLogger()
	b.newNonce = func() (string, error) { return testNonce, nil }
	b.sleep = func(_ context.Context, d time.Duration) error {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.sleeps = append(h.sleeps, d)
		return nil
	}
	h.b = b
	return h
}

// selectAgent aims a chat at an agent the way a Select press will: by what the
// agent IS (kind, working directory and native session id), not only by the
// seat it occupies.
func (h *harness) selectAgent(chatID string, a agents.Agent) {
	h.t.Helper()
	if h.sel == nil {
		h.t.Fatal("this harness has no selection store")
	}
	h.sel.Set(chatID, selection.Target{
		Pane:       a.PaneID,
		Kind:       a.Kind,
		Session:    sessionID(a),
		Cwd:        a.Cwd,
		SelectedAt: h.b.now(),
	})
	if _, ok := h.sel.Get(chatID); !ok {
		// selection.Store refuses a target it could only honour blind. A test
		// that thought it had selected something and had not would pass for the
		// wrong reason.
		h.t.Fatalf("the selection store refused %s; it has no identity to check", a.PaneID)
	}
}

func (h *harness) selected(chatID string) (selection.Target, bool) {
	if h.sel == nil {
		return selection.Target{}, false
	}
	return h.sel.Get(chatID)
}

func (h *harness) backoffs() []time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]time.Duration(nil), h.sleeps...)
}

// ---------- error fixtures ----------

// larkFail impersonates one of lark's failure sentinels without constructing
// the SDK type behind it: errors.Is consults this Is method, which is exactly
// how classifySend recognises a real *lark.Failure. Keeping the Feishu SDK out
// of this package's tests is the point — nothing but internal/lark imports it.
type larkFail struct{ sentinel error }

func (e larkFail) Error() string        { return "fake feishu failure: " + e.sentinel.Error() }
func (e larkFail) Is(target error) bool { return errors.Is(e.sentinel, target) }

// failing builds a write failure that classifies as sentinel does.
func failing(sentinel error) error { return larkFail{sentinel} }

// timeoutError is a net.Error that timed out. The request may already have
// reached Feishu, so it must never be retried: a duplicate here is a second
// card with a second live button aimed at an agent (G14, G17).
type timeoutError struct{}

func (timeoutError) Error() string   { return "write tcp 10.0.0.1:443: i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

// dialFailure never left this machine, so resending it cannot duplicate.
func dialFailure() error {
	return fmt.Errorf("dial tcp open.feishu.cn:443: %w", syscall.ECONNREFUSED)
}
