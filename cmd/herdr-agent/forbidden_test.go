package main

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
	"github.com/hewenyu/herdr-agent/internal/setup"
)

// forbiddenForCLI is the S1 §3.1 blacklist, restated here as the acceptance
// script names it.
//
//	agent.focus / pane.focus   clear `done` and yank the desktop user's UI (G10)
//	server.stop / pane.close / workspace.close   irreversible and out of scope
//
// herdrapi.ForbiddenMethods is a superset; both are checked, so a method added
// to either list is covered.
var forbiddenForCLI = []string{
	"agent.focus",
	"pane.focus",
	"server.stop",
	"pane.close",
	"workspace.close",
}

// TestForbidden drives every subcommand through a recording client and asserts
// that the CLI never sends a method it must not, and never reads a buffer it
// must not.
//
// The read rule is the one with teeth: source=recent makes herdr synthesise
// real mouse-wheel events into the user's live pane for up to 15 seconds, and a
// socket client cannot opt out — PaneReadParams.intent is #[serde(skip)] and
// always Interactive (G9). RecordingClient refuses such a read and files it
// under Rejected(), so an attempt is visible even though no bytes went out.
func TestForbidden(t *testing.T) {
	h := newHarness(t)
	rc := h.rc

	var mu sync.Mutex
	status := "blocked"
	seq := uint64(7)
	setState := func(s string, n uint64) { mu.Lock(); status, seq = s, n; mu.Unlock() }
	current := func() herdrapi.AgentInfo {
		mu.Lock()
		defer mu.Unlock()
		return agentInfo("w1:p1", "claude", status, seq)
	}

	ctx := context.Background()
	// `watch` is the only run that has to be stopped from the outside, so it
	// gets its own context and its own counter. Counting agent.list globally
	// would couple this test to how many times the OTHER commands happen to
	// poll: one more list in doctor or ls and the cancel would land before
	// `key` and `say`, which are the runs that actually exercise
	// agent.send_keys and agent.prompt.
	wctx, wcancel := context.WithCancel(ctx)
	defer wcancel()
	var watching atomic.Bool
	var watchPolls atomic.Int32

	rc.OnPing = func(context.Context) (herdrapi.PingResult, error) {
		return herdrapi.PingResult{Protocol: herdrapi.MinProtocol, Version: "0.8.0"}, nil
	}
	rc.OnAgentList = func(context.Context) ([]herdrapi.AgentInfo, error) {
		// `watch` runs the real registry; two polls are enough to prove it
		// reconciles, and the second cancels so the command returns.
		if watching.Load() && watchPolls.Add(1) >= 2 {
			wcancel()
		}
		return []herdrapi.AgentInfo{current()}, nil
	}
	rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) { return current(), nil }
	// A pane wide enough to pass the never-attached check: Screen.Cols is the
	// widest line seen before cropping (G5).
	rule := strings.Repeat("─", 100)
	rc.OnAgentRead = func(context.Context, string, herdrapi.ReadSource, int) (string, error) {
		return "⏺ hello from the agent\n" + rule + "\n❯ \n" + rule + "\n", nil
	}
	rc.OnPaneGet = func(_ context.Context, paneID string) (herdrapi.PaneInfo, error) {
		return herdrapi.PaneInfo{PaneID: paneID, Scroll: &herdrapi.ScrollInfo{ViewportRows: 49}}, nil
	}
	rc.OnAgentSendKeys = func(_ context.Context, _ string, keys []string) error {
		if len(keys) == 1 && keys[0] == "1" {
			setState("working", 8)
		}
		return nil
	}
	rc.OnAgentPrompt = func(context.Context, string, string, *herdrapi.PromptWait) (herdrapi.AgentInfo, error) {
		setState("working", 9)
		return current(), nil
	}

	// Real implementations everywhere: a fake controller would prove nothing
	// about what actually reaches the socket.
	extractor, err := screen.NewExtractor(rc)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := agents.NewController(rc,
		agents.WithInputClock(advancingClock(baseTime, 2*time.Second)),
		agents.WithSettleDelay(time.Nanosecond))
	if err != nil {
		t.Fatal(err)
	}
	resolver, err := agents.NewTranscriptResolver(agents.WithHome(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	h.d.Extractor = extractor
	h.d.Controller = controller
	h.d.Resolver = resolver
	h.d.NewRegistry = func(d time.Duration) (agents.Registry, error) {
		return agents.NewRegistry(rc, agents.WithPollInterval(d))
	}
	writeFile(t, filepath.Join(h.d.Home, ".claude", "hooks", "herdr-agent-state.sh"), "#!/bin/sh\n")
	writeFile(t, filepath.Join(h.d.Home, ".codex", "hooks.json"), "{}\n")
	// setup reaches herdr through nothing at all, and that has to be asserted
	// rather than left to the harness happening not to wire a runner. The fake
	// is what makes this safe to run: the real flow registers an app in a
	// Feishu tenant and no API was found that deletes one.
	h.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome: setup.OutcomeVerified, AppID: "cli_x", InboundOK: true, CardOK: true,
	}})

	// Every subcommand, in an order that keeps the agent's state usable: the
	// key answers a blocked agent, then say talks to the settled one.
	runs := []struct {
		name string
		argv []string
		// allow is the outcome this canned machine legitimately produces; any
		// other error means the command did not run at all.
		allow error
	}{
		{name: "help", argv: []string{"help"}},
		{name: "doctor", argv: []string{"doctor"}},
		{name: "ls", argv: []string{"ls"}},
		{name: "dialog", argv: []string{"dialog", "w1:p1"}},
		{name: "tail", argv: []string{"tail", "-n", "10", "w1:p1"}},
		// No transcript file exists under the fixture home, which is a normal
		// state and not an error in the bridge (G8).
		{name: "transcript", argv: []string{"transcript", "w1:p1"}, allow: errAny},
		{name: "key", argv: []string{"key", "w1:p1", "1"}},
		// The canned screen does not echo the message back, so the honest answer
		// is "sent but not confirmed" (G3, G4).
		{name: "say", argv: []string{"say", "w1:p1", "please run the tests"}, allow: errUnconfirmed},
		// serve stops at configuration: this harness has no credentials and no
		// allowlist, and a bridge without one hands shell access to whoever
		// finds the bot (G10). What serve actually sends to herdr is asserted by
		// TestServeCallsNoForbiddenMethod, which drives the whole startup with
		// this same recording client.
		{name: "serve", argv: []string{"serve"}, allow: errAny},
		{name: "watch", argv: []string{"watch", "-interval", "1ms"}},
		// It drives the fake runner above, so nothing is registered; what is
		// being asserted is that the command reaches herdr not at all.
		{name: "setup", argv: []string{"setup"}, allow: errAny},
	}
	for _, r := range runs {
		runCtx := ctx
		switch r.name {
		case "say":
			// Say only prompts a settled agent; the key above left it working.
			setState("idle", 8)
		case "watch":
			// Arm the cancel only now, so nothing an earlier command did can
			// end this run before it starts.
			watching.Store(true)
			runCtx = wctx
		}
		err := dispatch(runCtx, h.d, r.argv)
		if err == nil || errors.Is(r.allow, errAny) || (r.allow != nil && errors.Is(err, r.allow)) {
			continue
		}
		t.Fatalf("%s: %v", r.name, err)
	}

	methods := rc.Methods()
	if len(methods) == 0 {
		t.Fatal("no herdr calls were recorded; the subcommands cannot have run")
	}
	for _, bad := range slices.Concat(forbiddenForCLI, herdrapi.ForbiddenMethods) {
		if slices.Contains(methods, bad) {
			t.Errorf("the CLI called the forbidden method %q", bad)
		}
	}
	for _, c := range rc.Calls() {
		if c.Method != "agent.read" {
			continue
		}
		// Only visible and detection may ever be read (G9).
		if c.Source != herdrapi.SourceVisible && c.Source != herdrapi.SourceDetection {
			t.Errorf("agent.read used source %q", c.Source)
		}
	}
	if rejected := rc.Rejected(); len(rejected) != 0 {
		t.Errorf("the CLI attempted %d forbidden read(s): %+v", len(rejected), rejected)
	}

	// Sanity: the drive must actually have exercised the interesting paths,
	// otherwise the assertions above are vacuous.
	for _, m := range []string{"ping", "agent.list", "agent.get", "agent.read", "agent.send_keys", "agent.prompt"} {
		if rc.Count(m) == 0 {
			t.Errorf("%s was never called; the test did not exercise the CLI", m)
		}
	}
}

// TestForbiddenListIsNotEmpty guards the guard: an accidentally empty list
// would make TestForbidden pass no matter what the CLI did.
func TestForbiddenListIsNotEmpty(t *testing.T) {
	if len(forbiddenForCLI) == 0 || len(herdrapi.ForbiddenMethods) == 0 {
		t.Fatal("the forbidden method list is empty")
	}
	for _, want := range []string{"agent.focus", "pane.focus", "server.stop", "pane.close", "workspace.close"} {
		if !slices.Contains(forbiddenForCLI, want) {
			t.Errorf("%q is missing from the list the acceptance script checks", want)
		}
	}
}

// errAny marks a run whose failure carries no information about the CLI.
var errAny = errors.New("any error is acceptable")
