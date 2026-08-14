package main

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// baseTime is the wall clock every test starts from.
var baseTime = time.Date(2026, 8, 13, 23, 16, 17, 0, time.FixedZone("CST", 8*3600))

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// advancingClock moves forward by step on every read. It lets the controller's
// waitSettle finish without a real sleep: the loop exits once the status has
// held still for a second of *its* clock.
func advancingClock(start time.Time, step time.Duration) func() time.Time {
	var mu sync.Mutex
	now := start
	return func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		now = now.Add(step)
		return now
	}
}

// harness is a CLI wired to buffers and fakes.
type harness struct {
	d    *deps
	out  bytes.Buffer
	errb bytes.Buffer
	rc   *herdrapi.RecordingClient
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{rc: &herdrapi.RecordingClient{}}
	h.d = &deps{
		Client:         h.rc,
		Extractor:      &fakeExtractor{},
		Controller:     &fakeController{},
		Resolver:       fakeResolver{},
		NewRegistry:    func(time.Duration) (agents.Registry, error) { return newFakeRegistry(), nil },
		ServerEnv:      cleanServerEnv,
		Home:           t.TempDir(),
		HerdrConfigDir: t.TempDir(),
		PollInterval:   10 * time.Millisecond,
		TailLines:      18,
		Now:            fixedClock(baseTime),
	}
	h.d.Out = &h.out
	h.d.Err = &h.errb
	return h
}

func (h *harness) stdout() string { return h.out.String() }
func (h *harness) stderr() string { return h.errb.String() }

func cleanServerEnv(context.Context) ([]ProcEnv, error) {
	return []ProcEnv{{PID: 4242, Vars: []string{"PATH=/usr/bin", "HOME=/Users/x"}, Readable: true}}, nil
}

// ---------- screen ----------

type fakeExtractor struct {
	dialog map[string]screen.Screen
	tail   map[string]screen.Screen
	err    error

	mu        sync.Mutex
	tailCalls []string
	tailN     []int
}

func (f *fakeExtractor) Dialog(paneID string) (screen.Screen, error) {
	if f.err != nil {
		return screen.Screen{}, f.err
	}
	return f.dialog[paneID], nil
}

func (f *fakeExtractor) Tail(paneID string, n int) (screen.Screen, error) {
	f.mu.Lock()
	f.tailCalls = append(f.tailCalls, paneID)
	f.tailN = append(f.tailN, n)
	f.mu.Unlock()
	if f.err != nil {
		return screen.Screen{}, f.err
	}
	return f.tail[paneID], nil
}

// ---------- controller ----------

type fakeController struct {
	mu     sync.Mutex
	guards []agents.Guard
	keys   []string
	texts  []string

	key       agents.Agent
	keyErr    error
	delivery  agents.Delivery
	sayErr    error
	interrupt agents.Agent
}

func (f *fakeController) SendKey(_ context.Context, g agents.Guard, key string) (agents.Agent, error) {
	f.mu.Lock()
	f.guards = append(f.guards, g)
	f.keys = append(f.keys, key)
	f.mu.Unlock()
	return f.key, f.keyErr
}

func (f *fakeController) Say(_ context.Context, g agents.Guard, text string) (agents.Delivery, error) {
	f.mu.Lock()
	f.guards = append(f.guards, g)
	f.texts = append(f.texts, text)
	f.mu.Unlock()
	return f.delivery, f.sayErr
}

func (f *fakeController) Interrupt(_ context.Context, g agents.Guard) (agents.Agent, error) {
	f.mu.Lock()
	f.guards = append(f.guards, g)
	f.mu.Unlock()
	return f.interrupt, nil
}

func (f *fakeController) lastGuard(t *testing.T) agents.Guard {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.guards) == 0 {
		t.Fatal("controller was never called: the command did not go through the guarded input path")
	}
	return f.guards[len(f.guards)-1]
}

// ---------- transcript ----------

type fakeResolver struct {
	path string
	ok   bool
}

func (f fakeResolver) Resolve(agents.Agent) (string, bool) { return f.path, f.ok }

// ---------- registry ----------

type fakeRegistry struct {
	ch       chan agents.Transition
	runErr   error
	degraded bool

	mu       sync.Mutex
	runCount int
	subs     int
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{ch: make(chan agents.Transition, 16)}
}

// Run mirrors the real registry: it blocks until ctx is cancelled and closes
// every subscriber channel on the way out.
func (f *fakeRegistry) Run(ctx context.Context) error {
	f.mu.Lock()
	f.runCount++
	f.mu.Unlock()
	if f.runErr != nil {
		return f.runErr
	}
	<-ctx.Done()
	close(f.ch)
	return ctx.Err()
}

func (f *fakeRegistry) Snapshot() []agents.Agent        { return nil }
func (f *fakeRegistry) Get(string) (agents.Agent, bool) { return agents.Agent{}, false }
func (f *fakeRegistry) Subscribe() <-chan agents.Transition {
	f.mu.Lock()
	f.subs++
	f.mu.Unlock()
	return f.ch
}
func (f *fakeRegistry) Degraded() bool { return f.degraded }

// ---------- wire helpers ----------

func strptr(s string) *string { return &s }

func agentInfo(pane, kind, status string, seq uint64) herdrapi.AgentInfo {
	return herdrapi.AgentInfo{
		PaneID:                pane,
		WorkspaceID:           "w1",
		TabID:                 "t1",
		TerminalID:            "term-not-stable",
		Agent:                 strptr(kind),
		AgentStatus:           status,
		Cwd:                   strptr("/tmp/herdr-probe"),
		TerminalTitleStripped: strptr("Create hello.txt with touch"),
		StateChangeSeq:        seq,
		InteractiveReady:      true,
	}
}
