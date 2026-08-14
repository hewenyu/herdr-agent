package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// testAppSecret is long enough to be worth pattern-matching for (config's own
// scrubber ignores anything shorter than 8 characters) and distinctive enough
// that a substring search for it means something.
const testAppSecret = "s3cr3t-never-log-me-0123456789abcdef"

// waitFor bounds a handshake between goroutines. It is a deadlock guard, not
// pacing: nothing in these tests waits for time to pass.
const waitFor = 5 * time.Second

// ---------- harness ----------

// serveParts are the fakes behind serveHooks, kept so a test can look at what
// the startup sequence did to them.
type serveParts struct {
	order   *orderLog
	lock    *fakeLock
	bot     *fakeBot
	watcher *fakeWatcher
	bridges []bridge.Deps
	// bridgeOpts is how many optional dependencies the bridge was built with.
	// A bridge.Option is a closure over an unexported type, so this is all that
	// can be observed from here; bridge's own tests prove what WithSelection
	// does with the store once it arrives.
	bridgeOpts []int
}

func newServeHarness(t *testing.T) (*harness, serveHooks, *serveParts) {
	t.Helper()
	h := newHarness(t)
	h.d.StateDir = t.TempDir()
	h.d.Cfg = validServeConfig()
	// runChecks pings; without this every serve in this file would die on the
	// one condition that IS fatal.
	h.rc.OnPing = func(context.Context) (herdrapi.PingResult, error) {
		return herdrapi.PingResult{Protocol: herdrapi.MinProtocol, Version: "0.8.0"}, nil
	}
	h.rc.OnAgentList = func(context.Context) ([]herdrapi.AgentInfo, error) { return nil, nil }

	p := &serveParts{order: &orderLog{}}
	p.lock = &fakeLock{path: filepath.Join(h.d.StateDir, bridge.PidFileName), order: p.order}
	p.bot = newFakeBot(p.order)
	p.watcher = newFakeWatcher()

	hooks := serveHooks{
		lock: func(string, *slog.Logger) (instanceLock, error) {
			p.lock.acquire()
			return p.lock, nil
		},
		newWatcher: func(mirror.PathResolver, *slog.Logger) (mirror.Watcher, error) { return p.watcher, nil },
		newBot: func(config.Config, *slog.Logger) (lark.Bot, error) {
			// Recorded as well as bot.start: construction is where the
			// credentials are handed over, and the lock has to precede even
			// that, not merely the connect.
			p.order.add("bot.new")
			return p.bot, nil
		},
		newBridge: func(d bridge.Deps, opts ...bridge.Option) (bridge.Bridge, error) {
			p.bridges = append(p.bridges, d)
			p.bridgeOpts = append(p.bridgeOpts, len(opts))
			return bridge.NewWith(d, opts...)
		},
	}
	return h, hooks, p
}

func validServeConfig() config.Config {
	cfg := config.Default()
	cfg.Feishu.AppID = "cli_a97a042adcb8dbd5"
	cfg.Feishu.AppSecret = testAppSecret
	cfg.Feishu.AllowedOpenIDs = []string{"ou_00000000000000000000000000000001"}
	cfg.Feishu.NotifyChatID = "oc_herdr_agent"
	return cfg
}

func buildForTest(t *testing.T, ctx context.Context, h *harness, hooks serveHooks) *serveDeps {
	t.Helper()
	s, err := buildServe(ctx, h.d, newServeLogger(&h.errb), hooks)
	if err != nil {
		t.Fatalf("buildServe: %v", err)
	}
	t.Cleanup(func() { _ = s.shutdown() })
	return s
}

// ---------- the ordering rule ----------

// TestServeTakesTheLockBeforeItTouchesFeishu is the G15 assertion.
//
// One app_id may hold exactly one WebSocket. Two bridges do not fail loudly:
// they take the connection from each other, and the user reads that as "Feishu
// is flaky". A second instance therefore has to die BEFORE it connects, which
// means the pid file has to be locked before anything reaches the network.
func TestServeTakesTheLockBeforeItTouchesFeishu(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	s := buildForTest(t, ctx, h, hooks)
	if !p.lock.held() {
		t.Fatal("the single-instance lock was not taken during startup")
	}
	if p.bot.startCount() != 0 {
		t.Fatal("the bot connected during buildServe; nothing may reach Feishu before run")
	}

	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()

	select {
	case <-p.bot.started:
	case <-time.After(waitFor):
		t.Fatal("the bridge never started the Feishu bot")
	}
	cancel()

	if err := <-done; err != nil {
		t.Fatalf("run after a cancelled context = %v, want nil so the process exits 0", err)
	}
	if got, want := p.order.events(), []string{"lock", "bot.new", "bot.start"}; !slices.Equal(got, want) {
		t.Errorf("startup order = %v, want %v (the lock must precede any network IO, G15)", got, want)
	}
}

// TestServeHandsTheConfigToTheBridge: the allowlist is the security boundary of
// the product (G10), and a knob that is read from config.toml but never reaches
// the component that enforces it is worse than no knob at all.
func TestServeHandsTheConfigToTheBridge(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	h.d.Cfg.UI.MaxCols = 44
	h.d.Cfg.UI.TailLines = 9
	h.d.Cfg.UI.QueueLimit = 3

	buildForTest(t, context.Background(), h, hooks)

	if len(p.bridges) != 1 {
		t.Fatalf("bridge built %d times, want 1", len(p.bridges))
	}
	got := p.bridges[0]
	if !slices.Equal(got.AllowedOpenIDs, h.d.Cfg.Feishu.AllowedOpenIDs) {
		t.Errorf("allowlist = %v, want %v", got.AllowedOpenIDs, h.d.Cfg.Feishu.AllowedOpenIDs)
	}
	if got.NotifyChatID != h.d.Cfg.Feishu.NotifyChatID {
		t.Errorf("notify chat = %q, want %q", got.NotifyChatID, h.d.Cfg.Feishu.NotifyChatID)
	}
	if got.MaxCols != 44 || got.TailLines != 9 || got.QueueLimit != 3 {
		t.Errorf("ui knobs = max_cols %d, tail_lines %d, queue_limit %d; want 44, 9, 3",
			got.MaxCols, got.TailLines, got.QueueLimit)
	}
	for _, dep := range []struct {
		name string
		nil  bool
	}{
		{"Bot", got.Bot == nil},
		{"Registry", got.Registry == nil},
		{"Controller", got.Controller == nil},
		{"Extractor", got.Extractor == nil},
		{"Resolver", got.Resolver == nil},
		{"Dedup", got.Dedup == nil},
		{"Routes", got.Routes == nil},
		{"Watcher", got.Watcher == nil},
	} {
		if dep.nil {
			t.Errorf("bridge.Deps.%s is nil", dep.name)
		}
	}
}

// TestServeOpensTheSelectionStoreAndHandsItToTheBridge.
//
// The selection is what makes plain typing reach an agent — the primary
// interaction, because typing is the cheapest thing a phone can do and every
// other gesture costs taps. It lives next to routes.json for the same reason
// routes does: the bridge is restarted routinely (S2 §3.1) and a conversation
// in progress must survive that.
//
// bridge.Deps is frozen by contract, so the store travels as an Option; without
// it the bridge starts, looks healthy, and silently degrades to reply-only
// routing.
func TestServeOpensTheSelectionStoreAndHandsItToTheBridge(t *testing.T) {
	h, hooks, p := newServeHarness(t)

	s := buildForTest(t, context.Background(), h, hooks)

	if s.selection == nil {
		t.Fatal("no selection store was opened")
	}
	if !slices.Equal(p.bridgeOpts, []int{1}) {
		t.Errorf("bridge built with %v options, want exactly one (the selection store)", p.bridgeOpts)
	}
	if _, err := os.Stat(filepath.Join(h.d.StateDir, selectionFileName)); err != nil {
		t.Errorf("%s was not created in the state directory: %v", selectionFileName, err)
	}

	// And it is closed — which flushes — while the single-instance lock is still
	// held, like the other two.
	if err := s.shutdown(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if err := s.selection.Flush(); err == nil {
		t.Error("the selection store is still writable after shutdown, so it was never closed")
	}
}

// TestServeReleasesTheLockAndFlushesStateOnShutdown covers the signal path with
// the REAL lock: cancel, flush, release, exit 0.
func TestServeReleasesTheLockAndFlushesStateOnShutdown(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	hooks.lock = defaultServeHooks().lock

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := buildServe(ctx, h.d, newServeLogger(&h.errb), hooks)
	if err != nil {
		t.Fatalf("buildServe: %v", err)
	}

	pid := filepath.Join(h.d.StateDir, bridge.PidFileName)
	if _, err := os.Stat(pid); err != nil {
		t.Fatalf("the pid file must exist while the bridge runs: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()
	select {
	case <-p.bot.started:
	case <-time.After(waitFor):
		t.Fatal("the bridge never started")
	}

	cancel() // this is what SIGINT/SIGTERM do (see cli)
	if err := <-done; err != nil {
		t.Fatalf("run = %v, want nil on a signal", err)
	}
	if err := s.shutdown(); err != nil {
		t.Fatalf("shutdown: %v", err)
	}

	if _, err := os.Stat(pid); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("stat pid file after shutdown = %v, want it removed", err)
	}
	// All three stores are write-through, but shutdown is what guarantees the
	// last write reached the disk: a dedup entry lost here is a redelivered
	// Feishu event re-injected into a live agent (G14), and a lost selection is
	// a user who has to re-aim the conversation they were in the middle of.
	for _, name := range []string{dedupFileName, routesFileName, selectionFileName} {
		info, err := os.Stat(filepath.Join(h.d.StateDir, name))
		if err != nil {
			t.Errorf("%s was not written: %v", name, err)
			continue
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s mode = %o, want 600: reaching this state is reaching the herdr socket (G10)", name, perm)
		}
	}
	// Idempotent: cmdServe defers it and a test may call it too.
	if err := s.shutdown(); err != nil {
		t.Errorf("second shutdown = %v, want nil", err)
	}
}

// TestServeSecondInstanceRefusesToStart is the other half of G15: the process
// that loses the race exits instead of stealing the WebSocket.
func TestServeSecondInstanceRefusesToStart(t *testing.T) {
	h, hooks, _ := newServeHarness(t)
	hooks.lock = defaultServeHooks().lock
	ctx := context.Background()

	first := buildForTest(t, ctx, h, hooks)

	h2, hooks2, p2 := newServeHarness(t)
	h2.d.StateDir = h.d.StateDir // same machine, same state directory
	hooks2.lock = defaultServeHooks().lock

	_, err := buildServe(ctx, h2.d, newServeLogger(&h2.errb), hooks2)
	if !errors.Is(err, bridge.ErrAlreadyRunning) {
		t.Fatalf("second instance err = %v, want ErrAlreadyRunning", err)
	}
	if p2.bot.startCount() != 0 {
		t.Error("the second instance reached Feishu; it must die before it connects (G15)")
	}
	assertOneLine(t, err)

	// The loser must not have taken the winner's lock away.
	if err := first.shutdown(); err != nil {
		t.Errorf("first instance shutdown: %v", err)
	}
}

// ---------- startup refusals ----------

func TestServeStartupRefusals(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(t *testing.T, h *harness, p *serveParts)
		wantIs  error
		wantHas string
	}{
		{
			// Default deny. herdr's socket has no authentication and reaching it
			// is shell access (G10), so an unset allowlist locks everyone out.
			name:    "empty allowlist",
			mutate:  func(_ *testing.T, h *harness, _ *serveParts) { h.d.Cfg.Feishu.AllowedOpenIDs = nil },
			wantIs:  config.ErrEmptyAllowlist,
			wantHas: "allowed_open_ids",
		},
		{
			name:    "no credentials",
			mutate:  func(_ *testing.T, h *harness, _ *serveParts) { h.d.Cfg.Feishu.AppSecret = "" },
			wantIs:  config.ErrMissingAppSecret,
			wantHas: "FEISHU_APP_SECRET",
		},
		{
			name:    "no state directory",
			mutate:  func(_ *testing.T, h *harness, _ *serveParts) { h.d.StateDir = "" },
			wantHas: "state directory",
		},
		{
			// The bridge never starts herdr (S1 §2), and connecting to Feishu
			// anyway would burn the one WebSocket this app_id gets in order to
			// serve an empty agent list.
			name: "herdr is not running",
			mutate: func(_ *testing.T, h *harness, _ *serveParts) {
				h.rc.OnPing = func(context.Context) (herdrapi.PingResult, error) {
					return herdrapi.PingResult{}, herdrapi.ErrServerUnavailable
				}
			},
			wantIs:  herdrapi.ErrServerUnavailable,
			wantHas: "herdr server not running",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, hooks, p := newServeHarness(t)
			tc.mutate(t, h, p)

			s, err := buildServe(context.Background(), h.d, newServeLogger(&h.errb), hooks)
			if err == nil {
				_ = s.shutdown()
				t.Fatal("serve started; it must refuse")
			}
			if tc.wantIs != nil && !errors.Is(err, tc.wantIs) {
				t.Errorf("err = %v, want errors.Is %v", err, tc.wantIs)
			}
			if !strings.Contains(err.Error(), tc.wantHas) {
				t.Errorf("err = %q, must name the problem (%q)", err, tc.wantHas)
			}
			// A launchd job restarts every 30s; the reason has to be readable as
			// one line in the log, and never a stack trace.
			assertOneLine(t, err)
			if p.bot.startCount() != 0 {
				t.Error("a refused startup still connected to Feishu")
			}
			if p.lock.held() {
				t.Error("a refused startup left the single-instance lock held; the next start would be locked out")
			}
			if report(&h.errb, err) == exitOK {
				t.Error("a startup failure must exit non-zero")
			}
		})
	}
}

// TestServeRefusesAnOlderHerdrProtocol is S1 §3.1: ping once at startup, refuse
// below protocol 19, and print the version actually found.
//
// It is the second of the two fatal startup conditions and the less obvious
// one, because an old herdr answers every call. The decoders here were measured
// against protocol 19; an older server returns fields they do not find, and
// herdr's own detection reports an agent it cannot classify as idle rather than
// unknown (G11). The bridge would connect, list every agent as idle, and stop
// pushing the cards that say a human is needed — silently. Starting is worse
// than not starting.
func TestServeRefusesAnOlderHerdrProtocol(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	const oldVersion = "0.7.4"
	h.rc.OnPing = func(context.Context) (herdrapi.PingResult, error) {
		return herdrapi.PingResult{Protocol: herdrapi.MinProtocol - 1, Version: oldVersion}, nil
	}

	s, err := buildServe(context.Background(), h.d, newServeLogger(&h.errb), hooks)
	if err == nil {
		_ = s.shutdown()
		t.Fatal("serve started against a protocol this build cannot decode; it must refuse (S1 §3.1)")
	}
	if !errors.Is(err, herdrapi.ErrProtocolTooOld) {
		t.Errorf("err = %v, want errors.Is herdrapi.ErrProtocolTooOld", err)
	}
	// The spec asks for the version that was actually found, so an operator
	// reading one launchd log line knows what to upgrade and to what.
	for _, want := range []string{
		oldVersion,
		fmt.Sprintf("protocol %d", herdrapi.MinProtocol-1),
		fmt.Sprintf("%d or newer", herdrapi.MinProtocol),
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %q, must contain %q", err, want)
		}
	}
	assertOneLine(t, err)
	if p.bot.startCount() != 0 {
		t.Error("a bridge that refused over the protocol still connected to Feishu")
	}
	if p.lock.held() {
		t.Error("the refused startup kept the single-instance lock; the next start would be locked out")
	}
	if report(&h.errb, err) == exitOK {
		t.Error("a startup failure must exit non-zero")
	}
}

// TestServeStartsDespiteAFailingCheck: doctor's verdicts are advice, not a
// gate. A missing codex hook or an unpinned manifest degrades the product; a
// bridge that refuses to start is a phone that cannot reach ANY agent.
func TestServeStartsDespiteAFailingCheck(t *testing.T) {
	h, hooks, _ := newServeHarness(t)
	// The fixture home has neither integration installed, so both hook checks
	// FAIL — the same input that makes `doctor` exit 1.
	checks, probe := h.d.runChecks(context.Background())
	if !probe.reachable || probe.err != nil {
		t.Fatalf("herdr must be reachable and current for this test to mean anything: %+v", probe)
	}
	if !slices.ContainsFunc(checks, func(c check) bool { return c.status == checkFail }) {
		t.Fatal("no check FAILed, so this test proves nothing")
	}

	s, err := buildServe(context.Background(), h.d, newServeLogger(&h.errb), hooks)
	if err != nil {
		t.Fatalf("serve refused to start over a non-fatal check: %v", err)
	}
	defer func() { _ = s.shutdown() }()

	if !strings.Contains(h.stderr(), "startup check did not pass") {
		t.Error("a FAILing check must still be logged as a warning")
	}
	if !strings.Contains(h.stderr(), "the bridge starts anyway") {
		t.Error("the log must say the bridge started regardless")
	}
}

// TestServeLogsTheConfigWithoutTheSecret is S2 §3.1: the app secret must never
// appear in a log line, not even as a prefix or a length.
func TestServeLogsTheConfigWithoutTheSecret(t *testing.T) {
	h, hooks, _ := newServeHarness(t)
	h.d.Cfg.Feishu.NotifyChatID = testAppSecret // an operator pasting it in the wrong field

	s, err := buildServe(context.Background(), h.d, newServeLogger(&h.errb), hooks)
	if err != nil {
		t.Fatalf("buildServe: %v", err)
	}
	defer func() { _ = s.shutdown() }()

	logged := h.stderr() + h.stdout()
	if logged == "" {
		t.Fatal("nothing was logged at all")
	}
	if !strings.Contains(logged, config.RedactedSecret) {
		t.Errorf("the startup log does not show the redacted secret placeholder:\n%s", logged)
	}
	if !strings.Contains(logged, h.d.Cfg.Feishu.AppID) {
		t.Error("the app id is not a secret and belongs in the log")
	}
	for n := len(testAppSecret); n >= 8; n-- {
		if strings.Contains(logged, testAppSecret[:n]) {
			t.Fatalf("the log leaks the first %d characters of the app secret", n)
		}
	}
}

func TestStartupErrorsAreOneLine(t *testing.T) {
	// errors.Join, which config.Validate uses to report every problem at once,
	// separates with newlines.
	joined := errors.Join(errors.New("first problem"), errors.New("second problem"))
	err := &startupError{step: "configuration", err: joined}

	assertOneLine(t, err)
	for _, want := range []string{"first problem", "second problem", "configuration"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("flattened error %q lost %q", err, want)
		}
	}
	if !errors.Is(err, joined) {
		t.Error("flattening must not break errors.Is")
	}
}

func assertOneLine(t *testing.T, err error) {
	t.Helper()
	if strings.ContainsAny(err.Error(), "\n\r") {
		t.Errorf("startup error spans several lines:\n%s", err)
	}
}

// ---------- the supervisor ----------

// TestServeReportsATaskThatStopsOnItsOwn: a bridge whose Feishu channel died is
// a product that looks alive and answers nothing, so the process must exit
// non-zero and let launchd restart it.
func TestServeReportsATaskThatStopsOnItsOwn(t *testing.T) {
	h, hooks, _ := newServeHarness(t)
	hooks.newBridge = func(bridge.Deps, ...bridge.Option) (bridge.Bridge, error) {
		return stoppingBridge{}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := buildForTest(t, ctx, h, hooks)

	err := s.run(ctx)
	if err == nil {
		t.Fatal("run = nil; a task that ends by itself must not look like a clean shutdown")
	}
	if !errors.Is(err, errStoppedEarly) {
		t.Errorf("err = %v, want errStoppedEarly", err)
	}
	if !strings.Contains(err.Error(), "feishu bridge") {
		t.Errorf("err = %q, must name the task that stopped", err)
	}
	if ctx.Err() != nil {
		t.Error("the parent context must be left alone; only the run context is cancelled")
	}
}

// TestAFailingMirrorLeavesTheBridgeRunning is S2 §8: a broken mirror must not
// affect taking an agent over.
//
// The mirror is the cosmetic half of the product — it renders a transcript as a
// conversation. The other half answers permission dialogs, and an unanswered
// dialog is a machine waiting for a human who was never told (G1, G11). So the
// watcher is the one long-lived loop whose death is not fatal: it is logged, and
// the bridge keeps its exit code.
func TestAFailingMirrorLeavesTheBridgeRunning(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	p.watcher.failRun(errors.New("fsnotify: too many open files"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := buildForTest(t, ctx, h, hooks)

	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()

	select {
	case <-p.watcher.stopped:
	case err := <-done:
		t.Fatalf("run returned before the mirror even gave up: %v", err)
	case <-time.After(waitFor):
		t.Fatal("the transcript mirror was never started")
	}

	// The half that matters is still coming up after the mirror died.
	select {
	case <-p.bot.started:
	case err := <-done:
		t.Fatalf("the whole process ended when only the mirror failed: %v", err)
	case <-time.After(waitFor):
		t.Fatal("the bridge never connected to Feishu after the mirror failed")
	}

	// The load-bearing assertion: a supervised task would have cancelled the run
	// context and made this a non-zero exit naming the mirror.
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run = %v, want nil: a mirror failure must not become the process exit code (S2 §8)", err)
	}
	if !strings.Contains(h.stderr(), "transcript mirror stopped") {
		t.Errorf("the mirror failure was swallowed instead of logged:\n%s", h.stderr())
	}
}

func TestServeReportsTheFirstTaskFailure(t *testing.T) {
	h, hooks, _ := newServeHarness(t)
	boom := errors.New("websocket closed by the server")
	hooks.newBridge = func(bridge.Deps, ...bridge.Option) (bridge.Bridge, error) {
		return failingBridge{err: boom}, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := buildForTest(t, ctx, h, hooks)

	err := s.run(ctx)
	if !errors.Is(err, boom) {
		t.Fatalf("run = %v, want the underlying failure", err)
	}
	if report(&h.errb, err) == exitOK {
		t.Error("a supervised task failure must exit non-zero")
	}
}

// ---------- mirror.default_on ----------

// TestServeMirrorDefaultOnEnablesEachPaneOnce covers the knob and, more
// importantly, that honouring it cannot undo an explicit /mirror <pane> off.
func TestServeMirrorDefaultOnEnablesEachPaneOnce(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	h.d.Cfg.Mirror.DefaultOn = true

	reg := newFakeRegistry()
	h.d.NewRegistry = func(time.Duration) (agents.Registry, error) { return reg, nil }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := buildForTest(t, ctx, h, hooks)

	done := make(chan struct{})
	go func() { defer close(done); s.enableMirrorsByDefault(ctx) }()

	send := func(pane string, to agents.Status) {
		reg.ch <- agents.Transition{Agent: agents.Agent{PaneID: pane, Kind: "claude"}, To: to}
	}
	send("w1:p1", agents.StatusBlocked)
	send("w1:p4", agents.StatusIdle)
	p.watcher.waitForEnables(t, 2)

	// The user turns it off; a later transition for the same pane must not
	// bring it back.
	p.watcher.Disable("w1:p1")
	send("w1:p1", agents.StatusDone)
	// A different pane's transition proves the loop consumed the one above.
	send("w1:p4", agents.StatusDone)
	send("w1:p9", agents.StatusIdle)
	p.watcher.waitForEnables(t, 3)

	cancel()
	<-done

	if got, want := p.watcher.enables(), []string{"w1:p1", "w1:p4", "w1:p9"}; !slices.Equal(got, want) {
		t.Errorf("enabled %v, want %v (once per pane, first sighting only)", got, want)
	}
	if p.watcher.Enabled("w1:p1") {
		t.Error("mirror.default_on re-enabled a pane the user had turned off")
	}
}

func TestServeDoesNotSubscribeWhenMirrorDefaultIsOff(t *testing.T) {
	h, hooks, _ := newServeHarness(t)
	h.d.Cfg.Mirror.DefaultOn = false

	s := buildForTest(t, context.Background(), h, hooks)
	if s.transitions != nil {
		// A subscription nobody reads costs the registry a channel it fills and
		// then drops events into for the life of the process.
		t.Error("serve subscribed to transitions with mirror.default_on off")
	}
}

// ---------- forbidden methods ----------

// TestServeCallsNoForbiddenMethod drives the whole startup and one supervised
// second over a recording client, with the REAL registry, extractor and
// controller, and asserts that nothing serve does reaches a method that clears
// `done`, yanks the desktop UI, or scrolls the user's pane (G9, G10).
func TestServeCallsNoForbiddenMethod(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	rc := h.rc

	// The sequence climbs on every poll, so a transition is published no matter
	// when the notifier's subscription lands. A constant list would publish only
	// on the first poll and make this test depend on winning that race.
	var polls atomic.Uint64
	rc.OnAgentList = func(context.Context) ([]herdrapi.AgentInfo, error) {
		return []herdrapi.AgentInfo{agentInfo("w1:p1", "claude", "blocked", polls.Add(1))}, nil
	}
	rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		return agentInfo("w1:p1", "claude", "blocked", 7), nil
	}
	rule := strings.Repeat("─", 100)
	rc.OnAgentRead = func(context.Context, string, herdrapi.ReadSource, int) (string, error) {
		return "⏺ Do you want to proceed?\n" + rule + "\n❯ \n" + rule + "\n", nil
	}
	rc.OnPaneGet = func(_ context.Context, paneID string) (herdrapi.PaneInfo, error) {
		return herdrapi.PaneInfo{PaneID: paneID, Scroll: &herdrapi.ScrollInfo{ViewportRows: 49}}, nil
	}

	extractor, err := screen.NewExtractor(rc)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := agents.NewController(rc)
	if err != nil {
		t.Fatal(err)
	}
	h.d.Extractor = extractor
	h.d.Controller = controller
	h.d.NewRegistry = func(d time.Duration) (agents.Registry, error) {
		return agents.NewRegistry(rc, agents.WithPollInterval(d))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := buildForTest(t, ctx, h, hooks)

	done := make(chan error, 1)
	go func() { done <- s.run(ctx) }()
	select {
	case <-p.bot.started:
	case <-time.After(waitFor):
		t.Fatal("the bridge never started")
	}
	// The notifier pushes the blocked agent above, which is what makes the run
	// read a screen rather than only poll agent.list.
	p.bot.waitForSend(t)
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("run: %v", err)
	}

	methods := rc.Methods()
	if len(methods) == 0 {
		t.Fatal("no herdr calls were recorded; serve cannot have run")
	}
	for _, bad := range slices.Concat(forbiddenForCLI, herdrapi.ForbiddenMethods) {
		if slices.Contains(methods, bad) {
			t.Errorf("serve called the forbidden method %q", bad)
		}
	}
	for _, c := range rc.Calls() {
		if c.Method == "agent.read" && c.Source != herdrapi.SourceVisible && c.Source != herdrapi.SourceDetection {
			t.Errorf("serve read source %q; only visible and detection are allowed (G9)", c.Source)
		}
	}
	if rejected := rc.Rejected(); len(rejected) != 0 {
		t.Errorf("serve attempted %d forbidden read(s): %+v", len(rejected), rejected)
	}
	if rc.Count("agent.list") == 0 {
		t.Error("the registry never polled; the supervisor did not run it")
	}
}

// ---------- fakes ----------

// orderLog records the sequence of the two events the G15 ordering rule is
// about.
type orderLog struct {
	mu  sync.Mutex
	seq []string
}

func (o *orderLog) add(ev string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.seq = append(o.seq, ev)
}

func (o *orderLog) events() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return slices.Clone(o.seq)
}

type fakeLock struct {
	path  string
	order *orderLog

	mu       sync.Mutex
	acquired bool
	released bool
}

func (l *fakeLock) acquire() {
	l.mu.Lock()
	l.acquired = true
	l.mu.Unlock()
	l.order.add("lock")
}

func (l *fakeLock) Path() string { return l.path }

func (l *fakeLock) Release() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.released = true
	return nil
}

// held reports whether the lock was taken and not given back.
func (l *fakeLock) held() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.acquired && !l.released
}

type fakeBot struct {
	order   *orderLog
	started chan struct{}
	sent    chan struct{}

	mu     sync.Mutex
	starts int
}

func newFakeBot(o *orderLog) *fakeBot {
	return &fakeBot{order: o, started: make(chan struct{}), sent: make(chan struct{}, 1)}
}

var _ lark.Bot = (*fakeBot)(nil)

func (b *fakeBot) Start(ctx context.Context) error {
	b.mu.Lock()
	b.starts++
	first := b.starts == 1
	b.mu.Unlock()

	b.order.add("bot.start")
	if first {
		close(b.started)
	}
	<-ctx.Done()
	return ctx.Err()
}

func (b *fakeBot) startCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.starts
}

func (b *fakeBot) waitForSend(t *testing.T) {
	t.Helper()
	select {
	case <-b.sent:
	case <-time.After(waitFor):
		t.Fatal("the bridge never sent anything to Feishu")
	}
}

func (b *fakeBot) Stop(context.Context) error                            { return nil }
func (b *fakeBot) OnMessage(func(context.Context, lark.Msg) error)       {}
func (b *fakeBot) OnCardAction(func(context.Context, lark.Action) error) {}
func (b *fakeBot) SetLifecycle(lark.Lifecycle)                           {}
func (b *fakeBot) BotOpenID(context.Context) string                      { return "ou_bot" }

func (b *fakeBot) Send(context.Context, lark.Out) (string, error) {
	select {
	case b.sent <- struct{}{}:
	default:
	}
	return "om_1", nil
}

func (b *fakeBot) UpdateCard(context.Context, string, string) error { return nil }

func (b *fakeBot) Stream(context.Context, lark.Out) (lark.Stream, error) {
	return nil, errors.New("fakeBot: no streaming in this test")
}

type fakeWatcher struct {
	turns chan mirror.PaneTurn

	mu      sync.Mutex
	on      map[string]bool
	order   []string
	changed chan struct{}

	// runErr, when set, makes Run give up immediately instead of following its
	// context — the failure S2 §8 says must not reach the rest of the product.
	runErr  error
	stopped chan struct{}
}

func newFakeWatcher() *fakeWatcher {
	return &fakeWatcher{
		turns:   make(chan mirror.PaneTurn),
		on:      map[string]bool{},
		changed: make(chan struct{}, 64),
		stopped: make(chan struct{}),
	}
}

var _ mirror.Watcher = (*fakeWatcher)(nil)

func (w *fakeWatcher) failRun(err error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.runErr = err
}

func (w *fakeWatcher) Run(ctx context.Context) error {
	w.mu.Lock()
	err := w.runErr
	w.mu.Unlock()

	if err != nil {
		close(w.stopped)
		return err
	}
	<-ctx.Done()
	return ctx.Err()
}

func (w *fakeWatcher) Enable(paneID string) error {
	w.mu.Lock()
	w.on[paneID] = true
	w.order = append(w.order, paneID)
	w.mu.Unlock()
	select {
	case w.changed <- struct{}{}:
	default:
	}
	return nil
}

func (w *fakeWatcher) Disable(paneID string) {
	w.mu.Lock()
	delete(w.on, paneID)
	w.mu.Unlock()
}

func (w *fakeWatcher) Enabled(paneID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.on[paneID]
}

func (w *fakeWatcher) Turns() <-chan mirror.PaneTurn { return w.turns }

func (w *fakeWatcher) enables() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.order)
}

// waitForEnables blocks until n panes have been enabled, so the test never
// depends on a sleep.
func (w *fakeWatcher) waitForEnables(t *testing.T, n int) {
	t.Helper()
	deadline := time.After(waitFor)
	for {
		if len(w.enables()) >= n {
			return
		}
		select {
		case <-w.changed:
		case <-deadline:
			t.Fatalf("only %d pane(s) were mirrored, want %d", len(w.enables()), n)
		}
	}
}

// stoppingBridge returns immediately with no error, which is the "it stopped
// and had no reason to" case.
type stoppingBridge struct{ bridge.Bridge }

func (stoppingBridge) Run(context.Context) error { return nil }

type failingBridge struct {
	bridge.Bridge
	err error
}

func (f failingBridge) Run(context.Context) error { return f.err }
