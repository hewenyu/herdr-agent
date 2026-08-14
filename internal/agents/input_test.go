package agents

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// ---------- fake clock ----------

// testClock never sleeps. Every wait advances virtual time and is recorded, so
// a test can assert the back-off schedule without spending it.
type testClock struct {
	mu    sync.Mutex
	now   time.Time
	slept []time.Duration
}

func newTestClock() *testClock { return &testClock{now: epoch} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *testClock) wait(ctx context.Context, d time.Duration) bool {
	if ctx.Err() != nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	c.slept = append(c.slept, d)
	return true
}

func (c *testClock) waits() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Duration(nil), c.slept...)
}

// ---------- fake pane ----------

// fakePane is one herdr-visible agent. It answers agent.get, remembers the
// keys it was sent, and models the two behaviours the safe input protocol is
// built around: esc clears a permission dialog (G2), and agent.prompt can
// report a stall (G3).
type fakePane struct {
	mu sync.Mutex

	paneID string
	kind   string
	status Status
	seq    uint64

	// statuses, when non-empty, is popped by each agent.get, which is how a
	// test scripts an agent that is still moving.
	statuses []Status

	gone bool
	// goneCode is the error code agent.get answers with while gone. The default
	// is the one the running herdr actually returns, measured against 0.8.0 /
	// protocol 19:
	//   {"id":"probe-1","method":"agent.get","params":{"target":"w9:p99"}}
	//   {"id":"probe-1","error":{"code":"agent_not_found",...}}
	goneCode string
	getErr   error
	sendErr  error

	// reportPaneID overrides the pane_id in the answer, modelling herdr
	// resolving an agent target by NAME rather than by pane id.
	reportPaneID string

	// escTo is the status esc leaves a blocked agent in. Default idle (G2).
	escTo Status

	// statusOnPrompt, when set, is the status agent.prompt leaves the pane in.
	// It models what the agent — driven by the desktop user, or by a hook — can
	// do on its own while a stalled prompt is backing off.
	statusOnPrompt Status

	// noAgent models a pane herdr still knows about but that no longer has an
	// agent in it: agent_session and agent both come back null.
	noAgent bool

	// escKeeps models an agent that stays blocked no matter what.
	escKeeps bool

	// promptResults[i] is what the i-th agent.prompt returns; the last entry
	// repeats once the slice runs out.
	promptResults []error
	promptStatus  string

	screen string

	keys        []string
	promptCalls int
	prompts     []string
}

func (p *fakePane) info() herdrapi.AgentInfo {
	pane := p.paneID
	if p.reportPaneID != "" {
		pane = p.reportPaneID
	}
	out := herdrapi.AgentInfo{
		PaneID:         pane,
		WorkspaceID:    "w1",
		TabID:          "t1",
		TerminalID:     "term-1",
		AgentStatus:    string(p.status),
		StateChangeSeq: p.seq,
	}
	if !p.noAgent {
		kind := p.kind
		out.Agent = &kind
	}
	return out
}

func (p *fakePane) get(context.Context, string) (herdrapi.AgentInfo, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.getErr != nil {
		return herdrapi.AgentInfo{}, p.getErr
	}
	if p.gone {
		code := p.goneCode
		if code == "" {
			code = codeAgentNotFound
		}
		return herdrapi.AgentInfo{}, &herdrapi.APIError{Code: code, Message: "agent target not found"}
	}
	if len(p.statuses) > 0 {
		p.status = p.statuses[0]
		if len(p.statuses) > 1 {
			p.statuses = p.statuses[1:]
		}
	}
	return p.info(), nil
}

func (p *fakePane) sendKeys(_ context.Context, _ string, keys []string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sendErr != nil {
		return p.sendErr
	}
	p.keys = append(p.keys, keys...)
	for _, k := range keys {
		switch {
		case p.status != StatusBlocked:
		case k == keyEscape && !p.escKeeps:
			// G2: esc dismisses the dialog without answering it.
			p.status = StatusIdle
			if p.escTo != "" {
				p.status = p.escTo
			}
			p.seq++
			p.statuses = nil
		case k != keyEscape:
			// G16: answering the menu lets the agent get on with it.
			p.status = StatusWorking
			p.seq++
			p.statuses = nil
		}
	}
	return nil
}

func (p *fakePane) prompt(_ context.Context, _, text string, _ *herdrapi.PromptWait) (herdrapi.AgentInfo, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.promptCalls++
	p.prompts = append(p.prompts, text)
	if p.statusOnPrompt != "" {
		p.status = p.statusOnPrompt
		p.seq++
		p.statuses = nil
	}
	var res error
	if n := len(p.promptResults); n > 0 {
		i := p.promptCalls - 1
		if i >= n {
			i = n - 1
		}
		res = p.promptResults[i]
	}
	if res != nil {
		return herdrapi.AgentInfo{}, res
	}
	out := p.info()
	if p.promptStatus != "" {
		out.AgentStatus = p.promptStatus
	}
	return out, nil
}

func (p *fakePane) read(context.Context, string, herdrapi.ReadSource, int) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.screen, nil
}

func (p *fakePane) sentKeys() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.keys...)
}

// stalled is the error the real client returns for agent_prompt_stalled: the
// sentinel wrapping the *APIError.
func stalled() error {
	return fmt.Errorf("%w: %w", herdrapi.ErrPromptStalled,
		&herdrapi.APIError{Code: herdrapi.CodeAgentPromptStall, Message: "no state change observed"})
}

// ---------- harness ----------

type inputHarness struct {
	t      *testing.T
	clk    *testClock
	pane   *fakePane
	client *herdrapi.RecordingClient
	ctrl   Controller
}

func newInputHarness(t *testing.T, p *fakePane, opts ...ControllerOption) *inputHarness {
	t.Helper()
	if p.paneID == "" {
		p.paneID = "w1:p1"
	}
	if p.kind == "" {
		p.kind = "claude"
	}
	client := &herdrapi.RecordingClient{
		OnAgentGet:      p.get,
		OnAgentSendKeys: p.sendKeys,
		OnAgentPrompt:   p.prompt,
		OnAgentRead:     p.read,
	}
	clk := newTestClock()
	base := []ControllerOption{WithInputClock(clk.Now), withInputWaiter(clk.wait)}
	c, err := NewController(client, append(base, opts...)...)
	if err != nil {
		t.Fatalf("NewController: %v", err)
	}
	return &inputHarness{t: t, clk: clk, pane: p, client: client, ctrl: c}
}

// guard returns a guard that matches the pane as it stands right now.
func (h *inputHarness) guard() Guard {
	h.pane.mu.Lock()
	defer h.pane.mu.Unlock()
	return Guard{PaneID: h.pane.paneID, Kind: h.pane.kind, StateSeq: h.pane.seq, IssuedAt: h.clk.Now()}
}

func (h *inputHarness) methods() []string { return h.client.Methods() }

// assertNoInput fails if anything was written to the agent.
func (h *inputHarness) assertNoInput() {
	h.t.Helper()
	if keys := h.pane.sentKeys(); len(keys) != 0 {
		h.t.Fatalf("keys %v reached the agent; nothing should have", keys)
	}
	if n := h.client.Count("agent.prompt"); n != 0 {
		h.t.Fatalf("agent.prompt called %d times; it should not have been", n)
	}
}

// indexOf reports the position of the first call to method, or -1.
func indexOf(methods []string, method string) int {
	for i, m := range methods {
		if m == method {
			return i
		}
	}
	return -1
}

// claudeScreen renders a Claude-like viewport: transcript, then the composer
// fenced by two horizontal rules, then the status hint below it.
func claudeScreen(transcript, composer string) string {
	rule := strings.Repeat("─", 40)
	return strings.Join([]string{
		"  Some earlier output",
		transcript,
		"",
		"╭" + rule + "╮",
		"│ " + composer,
		"╰" + rule + "╯",
		"  ⏵⏵ accept edits on (shift+tab to cycle)",
	}, "\n")
}

// ---------- guard ----------

func TestValidateGuardChecksInOrder(t *testing.T) {
	const pane = "w1:p1"
	tests := []struct {
		name           string
		pane           *fakePane
		guard          func(now time.Time) Guard
		requireBlocked bool
		want           error
	}{
		{
			name:  "pane gone",
			pane:  &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4, gone: true},
			guard: func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			want:  ErrPaneGone,
		},
		{
			// Every code herdr uses for "there is no agent at this target".
			// agent_not_found is what the running 0.8.0 answers for agent.get
			// (measured); pane_not_found is the pane-target equivalent
			// (src/app/api/panes.rs:47); not_found is the generic one the
			// transport layer names. Only ErrPaneGone lets S2 retire the card —
			// anything else is indistinguishable from a herdr outage and is
			// retried forever.
			name:  "pane gone, reported as agent_not_found",
			pane:  &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4, gone: true, goneCode: "agent_not_found"},
			guard: func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			want:  ErrPaneGone,
		},
		{
			name:  "pane gone, reported as pane_not_found",
			pane:  &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4, gone: true, goneCode: "pane_not_found"},
			guard: func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			want:  ErrPaneGone,
		},
		{
			name:  "pane gone, reported as not_found",
			pane:  &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4, gone: true, goneCode: herdrapi.CodeNotFound},
			guard: func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			want:  ErrPaneGone,
		},
		{
			// herdr resolves an agent target by pane id OR by agent name
			// (src/app/terminal_targets.rs:75-101), and agents can be renamed.
			// A guard for a dead pane must not be satisfied by whatever other
			// terminal the name happens to reach.
			name: "herdr answered about a different pane",
			pane: &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4, reportPaneID: "w1:p9"},
			guard: func(now time.Time) Guard {
				return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now}
			},
			requireBlocked: true,
			want:           ErrPaneGone,
		},
		{
			name: "pane gone beats every other fault",
			pane: &fakePane{paneID: pane, kind: "claude", status: StatusIdle, seq: 9, gone: true},
			guard: func(now time.Time) Guard {
				return Guard{PaneID: pane, Kind: "codex", StateSeq: 4, IssuedAt: now.Add(-time.Hour)}
			},
			requireBlocked: true,
			want:           ErrPaneGone,
		},
		{
			name:  "different agent kind",
			pane:  &fakePane{paneID: pane, kind: "codex", status: StatusBlocked, seq: 4},
			guard: func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			want:  ErrAgentReplaced,
		},
		{
			name:  "agent exited, pane now has none",
			pane:  &fakePane{paneID: pane, noAgent: true, status: StatusIdle, seq: 4},
			guard: func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			want:  ErrAgentReplaced,
		},
		{
			name: "kind is checked before age",
			pane: &fakePane{paneID: pane, kind: "codex", status: StatusBlocked, seq: 4},
			guard: func(now time.Time) Guard {
				return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now.Add(-time.Hour)}
			},
			want: ErrAgentReplaced,
		},
		{
			name: "guard older than MaxGuardAge",
			pane: &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4},
			guard: func(now time.Time) Guard {
				return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now.Add(-MaxGuardAge - time.Second)}
			},
			requireBlocked: true,
			want:           ErrGuardStale,
		},
		{
			// G17 from the other side: cards.Decision carries IssuedAt as unix
			// seconds, so a value written in milliseconds by mistake reads as
			// the year 55000 and an age-only check would arm that card forever.
			name: "guard issued in the future",
			pane: &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4},
			guard: func(now time.Time) Guard {
				return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now.Add(time.Hour)}
			},
			requireBlocked: true,
			want:           ErrGuardStale,
		},
		{
			// A second of skew between building the card and the callback
			// coming back is normal and must still be accepted.
			name: "guard a second ahead of the clock still passes",
			pane: &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4},
			guard: func(now time.Time) Guard {
				return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now.Add(time.Second)}
			},
			requireBlocked: true,
		},
		{
			name: "guard with no issue time at all is stale",
			pane: &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4},
			guard: func(time.Time) Guard {
				return Guard{PaneID: pane, Kind: "claude", StateSeq: 4}
			},
			want: ErrGuardStale,
		},
		{
			name: "age is checked before blockedness",
			pane: &fakePane{paneID: pane, kind: "claude", status: StatusIdle, seq: 99},
			guard: func(now time.Time) Guard {
				return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now.Add(-MaxGuardAge - time.Second)}
			},
			requireBlocked: true,
			want:           ErrGuardStale,
		},
		{
			name:           "no longer blocked",
			pane:           &fakePane{paneID: pane, kind: "claude", status: StatusIdle, seq: 4},
			guard:          func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			requireBlocked: true,
			want:           ErrNoLongerBlocked,
		},
		{
			// G17: still blocked, but on a different question than the one the
			// human answered.
			name:           "blocked at a different state sequence",
			pane:           &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 5},
			guard:          func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			requireBlocked: true,
			want:           ErrNoLongerBlocked,
		},
		{
			name:           "blocked at the same sequence passes",
			pane:           &fakePane{paneID: pane, kind: "claude", status: StatusBlocked, seq: 4},
			guard:          func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
			requireBlocked: true,
		},
		{
			// Prose does not require a blocked agent, so an idle one passes the
			// same guard that SendKey would reject.
			name:  "not blocked passes when blockedness is not required",
			pane:  &fakePane{paneID: pane, kind: "claude", status: StatusIdle, seq: 7},
			guard: func(now time.Time) Guard { return Guard{PaneID: pane, Kind: "claude", StateSeq: 4, IssuedAt: now} },
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newInputHarness(t, tc.pane)
			c := h.ctrl.(*controller)

			got, err := c.validateGuard(context.Background(), tc.guard(h.clk.Now()), tc.requireBlocked)
			if tc.want == nil {
				if err != nil {
					t.Fatalf("validateGuard: %v, want nil", err)
				}
				if got.PaneID != pane {
					t.Fatalf("agent = %+v, want pane %s", got, pane)
				}
				return
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("validateGuard error = %v, want %v", err, tc.want)
			}
			if got.PaneID != pane {
				t.Errorf("failing guard returned %+v; the caller still needs to know which pane", got)
			}
			h.assertNoInput()
		})
	}
}

func TestValidateGuardTreatsAPaneWithoutAnIDAsGone(t *testing.T) {
	// herdr answered, but with nothing addressable in it.
	empty := &herdrapi.RecordingClient{
		OnAgentGet: func(context.Context, string) (herdrapi.AgentInfo, error) {
			return herdrapi.AgentInfo{AgentStatus: "idle"}, nil
		},
	}
	c, err := NewController(empty)
	if err != nil {
		t.Fatalf("NewController: %v", err)
	}
	g := Guard{PaneID: "w1:p1", Kind: "claude", IssuedAt: time.Now()}
	if _, err := c.SendKey(context.Background(), g, "1"); !errors.Is(err, ErrPaneGone) {
		t.Fatalf("SendKey error = %v, want ErrPaneGone", err)
	}
	if n := empty.Count("agent.send_keys"); n != 0 {
		t.Fatalf("agent.send_keys called %d times for a pane with no agent", n)
	}
}

func TestGuardDoesNotTurnAHerdrOutageIntoAMissingPane(t *testing.T) {
	// A socket that is down — or a herdr wedged behind a modal dialog on its
	// single UI thread (G10) — says nothing about whether the pane still
	// exists. Reporting ErrPaneGone here would tell the layer above to retire a
	// card for an agent that is still sitting there waiting for an answer.
	down := errors.New("dial unix: connection refused")
	p := &fakePane{status: StatusBlocked, seq: 1, getErr: down}
	h := newInputHarness(t, p)
	g := Guard{PaneID: p.paneID, Kind: "claude", StateSeq: 1, IssuedAt: h.clk.Now()}

	_, err := h.ctrl.SendKey(context.Background(), g, "1")
	if !errors.Is(err, down) {
		t.Fatalf("SendKey error = %v, want the transport failure", err)
	}
	if errors.Is(err, ErrPaneGone) {
		t.Fatal("an unreachable herdr was reported as a missing pane")
	}
	h.assertNoInput()
}

func TestSendKeyReportsAFailedWriteWithoutWaiting(t *testing.T) {
	boom := errors.New("socket closed")
	p := &fakePane{status: StatusBlocked, seq: 1, sendErr: boom}
	h := newInputHarness(t, p)

	got, err := h.ctrl.SendKey(context.Background(), h.guard(), "1")
	if !errors.Is(err, boom) {
		t.Fatalf("SendKey error = %v, want the write failure", err)
	}
	if waits := h.clk.waits(); len(waits) != 0 {
		t.Fatalf("waited %v for a key that was never written", waits)
	}
	if got.Status != StatusBlocked {
		t.Errorf("returned status = %s, want the state the agent is still in", got.Status)
	}
}

func TestNewControllerRejectsNilClient(t *testing.T) {
	if _, err := NewController(nil); !errors.Is(err, ErrNoClient) {
		t.Fatalf("NewController(nil) error = %v, want ErrNoClient", err)
	}
}

// ---------- SendKey ----------

func TestSendKeyAcceptsEveryAllowedKey(t *testing.T) {
	for _, key := range AllowedKeys {
		t.Run(key, func(t *testing.T) {
			h := newInputHarness(t, &fakePane{status: StatusBlocked, seq: 3})
			if _, err := h.ctrl.SendKey(context.Background(), h.guard(), key); err != nil {
				t.Fatalf("SendKey(%q): %v", key, err)
			}
			if got := h.pane.sentKeys(); len(got) != 1 || got[0] != key {
				t.Fatalf("keys delivered = %v, want exactly [%q]", got, key)
			}
		})
	}
}

func TestSendKeyRejectsAnythingOutsideTheAllowlist(t *testing.T) {
	// Rejected, never escaped, translated or guessed at: every one of these
	// would be executed by the agent on the other side.
	for _, key := range []string{
		"", " ", "1 ", "10", "Y", "N", "ESC", "escape", "q", "c-c", "ctrl-c",
		"rm -rf /", "yes", "\n", "\x1b", "0",
	} {
		t.Run(fmt.Sprintf("%q", key), func(t *testing.T) {
			h := newInputHarness(t, &fakePane{status: StatusBlocked, seq: 3})
			_, err := h.ctrl.SendKey(context.Background(), h.guard(), key)
			if !errors.Is(err, ErrKeyNotAllowed) {
				t.Fatalf("SendKey(%q) error = %v, want ErrKeyNotAllowed", key, err)
			}
			h.assertNoInput()
		})
	}
}

func TestSendKeyWritesOnceThenSettlesAndReadsBack(t *testing.T) {
	p := &fakePane{status: StatusBlocked, seq: 3}
	h := newInputHarness(t, p)

	got, err := h.ctrl.SendKey(context.Background(), h.guard(), "1")
	if err != nil {
		t.Fatalf("SendKey: %v", err)
	}

	// One agent.send_keys carrying the whole answer. pane.send_keys writes one
	// syscall per key and is never used.
	calls := h.client.Calls()
	sends := 0
	for _, c := range calls {
		if c.Method != "agent.send_keys" {
			continue
		}
		sends++
		if len(c.Keys) != 1 || c.Keys[0] != "1" {
			t.Fatalf("agent.send_keys keys = %v, want [1]", c.Keys)
		}
	}
	if sends != 1 {
		t.Fatalf("agent.send_keys called %d times, want exactly 1", sends)
	}
	if want := []string{"agent.get", "agent.send_keys", "agent.get"}; !equalStrings(h.methods(), want) {
		t.Fatalf("call sequence = %v, want %v", h.methods(), want)
	}
	if waits := h.clk.waits(); len(waits) != 1 || waits[0] != SettleDelay {
		t.Fatalf("waits = %v, want a single %v settle", waits, SettleDelay)
	}
	// The read-back is the point: the caller renders the state the key produced.
	if got.Status != StatusWorking || got.StateSeq != 4 {
		t.Fatalf("read-back = %s/seq %d, want working/seq 4", got.Status, got.StateSeq)
	}
}

func TestSendKeyRefusesAStaleCard(t *testing.T) {
	// G17: the pane moved on between the card being built and the tap arriving.
	p := &fakePane{status: StatusBlocked, seq: 3}
	h := newInputHarness(t, p)
	g := h.guard()

	p.mu.Lock()
	p.status = StatusIdle
	p.seq = 8
	p.mu.Unlock()

	got, err := h.ctrl.SendKey(context.Background(), g, "1")
	if !errors.Is(err, ErrNoLongerBlocked) {
		t.Fatalf("SendKey error = %v, want ErrNoLongerBlocked", err)
	}
	// The whole point: no keystroke reached the pane, so nothing landed in the
	// input box as a stray `1`.
	h.assertNoInput()
	if got.Status != StatusIdle {
		t.Errorf("returned status = %s, want the current idle so the caller can explain itself", got.Status)
	}
}

func TestSendKeyRefusesAGuardFromTheFuture(t *testing.T) {
	// The measured failure this prevents: a card whose IssuedAt was written in
	// milliseconds lands a century ahead, and an age check that only looks at
	// the upper bound delivers its keystroke for as long as Feishu keeps the
	// message — which is forever (G17).
	p := &fakePane{status: StatusBlocked, seq: 3}
	h := newInputHarness(t, p)
	g := h.guard()
	g.IssuedAt = h.clk.Now().Add(100 * 365 * 24 * time.Hour)

	if _, err := h.ctrl.SendKey(context.Background(), g, "1"); !errors.Is(err, ErrGuardStale) {
		t.Fatalf("SendKey error = %v, want ErrGuardStale", err)
	}
	h.assertNoInput()
}

// ---------- Interrupt ----------

func TestInterruptSendsOnlyEscapeAndDoesNotRequireBlocked(t *testing.T) {
	p := &fakePane{status: StatusWorking, seq: 2}
	h := newInputHarness(t, p)

	got, err := h.ctrl.Interrupt(context.Background(), h.guard())
	if err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	if keys := p.sentKeys(); len(keys) != 1 || keys[0] != keyEscape {
		t.Fatalf("keys = %v, want exactly [esc]", keys)
	}
	if n := h.client.Count("agent.prompt"); n != 0 {
		t.Fatalf("Interrupt sent %d prompts; it sends esc and nothing else", n)
	}
	if got.PaneID != p.paneID {
		t.Fatalf("Interrupt returned %+v", got)
	}
}

func TestInterruptStillChecksTheGuard(t *testing.T) {
	p := &fakePane{kind: "codex", status: StatusBlocked, seq: 1}
	h := newInputHarness(t, p)
	g := Guard{PaneID: p.paneID, Kind: "claude", StateSeq: 1, IssuedAt: h.clk.Now()}

	if _, err := h.ctrl.Interrupt(context.Background(), g); !errors.Is(err, ErrAgentReplaced) {
		t.Fatalf("Interrupt error = %v, want ErrAgentReplaced", err)
	}
	h.assertNoInput()
}

// ---------- waitSettle ----------

func TestWaitSettleWaitsForAQuietSecond(t *testing.T) {
	// The status changes once, then holds. Settled means settleStableFor of no
	// change, which at a 250ms poll is four identical reads after the last one.
	p := &fakePane{status: StatusWorking, statuses: []Status{
		StatusWorking, StatusWorking, StatusIdle, StatusIdle, StatusIdle, StatusIdle, StatusIdle,
	}}
	h := newInputHarness(t, p)
	c := h.ctrl.(*controller)

	start := h.clk.Now()
	got, err := c.waitSettle(context.Background(), p.paneID)
	if err != nil {
		t.Fatalf("waitSettle: %v", err)
	}
	if got.Status != StatusIdle {
		t.Fatalf("settled status = %s, want idle", got.Status)
	}
	// 2 polls of `working`, the change on the 3rd, then 4 more to make a
	// quiet second: 6 waits after the first read.
	elapsed := h.clk.Now().Sub(start)
	if want := 6 * settlePollInterval; elapsed != want {
		t.Fatalf("settled after %v, want %v", elapsed, want)
	}
	for _, d := range h.clk.waits() {
		if d != settlePollInterval {
			t.Fatalf("waits = %v, want every poll to be %v", h.clk.waits(), settlePollInterval)
		}
	}
}

func TestWaitSettleGivesUpAtTheCap(t *testing.T) {
	// An agent that never holds still. The cap keeps the human on the phone
	// from waiting forever, and hitting it is not an error: the caller decides
	// what to do with a status that is still moving.
	flip := 0
	h := newInputHarness(t, &fakePane{status: StatusWorking})
	h.client.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		flip++
		st := StatusWorking
		if flip%2 == 0 {
			st = StatusIdle
		}
		kind := "claude"
		return herdrapi.AgentInfo{PaneID: "w1:p1", Agent: &kind, AgentStatus: string(st)}, nil
	}
	c := h.ctrl.(*controller)

	start := h.clk.Now()
	if _, err := c.waitSettle(context.Background(), "w1:p1"); err != nil {
		t.Fatalf("waitSettle: %v", err)
	}
	if elapsed := h.clk.Now().Sub(start); elapsed < settleMaxWait || elapsed > settleMaxWait+settlePollInterval {
		t.Fatalf("gave up after %v, want about %v", elapsed, settleMaxWait)
	}
}

func TestWaitSettleStopsOnContextCancel(t *testing.T) {
	h := newInputHarness(t, &fakePane{status: StatusWorking})
	c := h.ctrl.(*controller)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.waitSettle(ctx, "w1:p1"); !errors.Is(err, context.Canceled) {
		t.Fatalf("waitSettle error = %v, want context.Canceled", err)
	}
}

// ---------- Say: the safety-critical path ----------

func TestSayEscapesABlockedAgentBeforePrompting(t *testing.T) {
	// G1, measured: prose sent to a blocked claude APPROVES the dialog, because
	// agent.prompt pastes text the menu discards and then presses Enter on the
	// highlighted default. The written refusal created the file it refused.
	p := &fakePane{status: StatusBlocked, seq: 3, promptStatus: string(StatusWorking)}
	p.screen = claudeScreen("> please do not run that", "")
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "please do not run that")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if !d.Acked || !d.Verified {
		t.Fatalf("Delivery = %+v, want acked and verified", d)
	}
	// The escape is a side effect the human did not ask for: their prose also
	// dismissed a question that was waiting on them. Every layer above reports
	// it from this flag, so if it is not set the user is never told (G1, G2).
	if !d.Escaped {
		t.Fatalf("Delivery.Escaped = false after escaping a blocked agent: %+v", d)
	}

	methods := h.methods()
	esc := indexOf(methods, "agent.send_keys")
	prompt := indexOf(methods, "agent.prompt")
	if esc < 0 || prompt < 0 {
		t.Fatalf("call sequence = %v, want both an esc and a prompt", methods)
	}
	if esc > prompt {
		t.Fatalf("prompt at %d came before esc at %d: %v", prompt, esc, methods)
	}
	if keys := p.sentKeys(); len(keys) != 1 || keys[0] != keyEscape {
		t.Fatalf("keys = %v, want exactly [esc]", keys)
	}
	// esc, then a settle, then the prompt: the agent is re-read repeatedly in
	// between, because a prompt sent straight after a state change is swallowed
	// (G3).
	gets := 0
	for _, m := range methods[esc+1 : prompt] {
		if m == "agent.get" {
			gets++
		}
	}
	if gets < 2 {
		t.Fatalf("only %d agent.get between esc and prompt: %v", gets, methods)
	}
	if last := methods[len(methods)-1]; last != "agent.read" {
		t.Fatalf("last call = %q, want the read-back", last)
	}
}

func TestSayOnAnIdleAgentReportsNoEscape(t *testing.T) {
	// The mirror image: Escaped must not be set when nothing was cancelled, or
	// the phone tells the user a dialog was dismissed that never existed.
	p := &fakePane{status: StatusIdle, seq: 1, promptStatus: string(StatusWorking)}
	p.screen = claudeScreen("> hello there", "")
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "hello there")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if d.Escaped {
		t.Fatalf("Delivery.Escaped = true for an idle agent: %+v", d)
	}
	if keys := p.sentKeys(); len(keys) != 0 {
		t.Fatalf("keys = %v, want none", keys)
	}
}

func TestSayNeverPromptsAnAgentThatStaysBlocked(t *testing.T) {
	// The one-vote veto: if esc did not clear the dialog, there is no safe way
	// to deliver prose, so nothing is delivered.
	p := &fakePane{status: StatusBlocked, seq: 3, escKeeps: true}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "absolutely not, do NOT run this command")
	if !errors.Is(err, ErrCannotUnblock) {
		t.Fatalf("Say error = %v, want ErrCannotUnblock", err)
	}
	if n := h.client.Count("agent.prompt"); n != 0 {
		t.Fatalf("agent.prompt called %d times against a blocked agent (G1)", n)
	}
	if keys := p.sentKeys(); len(keys) != 1 || keys[0] != keyEscape {
		t.Fatalf("keys = %v, want a single esc and no second attempt", keys)
	}
	if d.Acked || d.Verified {
		t.Fatalf("Delivery = %+v, want nothing claimed", d)
	}
	if d.FinalStatus != StatusBlocked {
		t.Errorf("FinalStatus = %s, want blocked", d.FinalStatus)
	}
}

func TestSayRefusesAWorkingAgent(t *testing.T) {
	p := &fakePane{status: StatusWorking, seq: 2}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "stop that")
	if !errors.Is(err, ErrAgentBusy) {
		t.Fatalf("Say error = %v, want ErrAgentBusy", err)
	}
	// Queue or interrupt is the caller's call, so nothing was sent either way.
	h.assertNoInput()
	if d.FinalStatus != StatusWorking {
		t.Errorf("FinalStatus = %s, want working", d.FinalStatus)
	}
}

func TestSayRefusesAnUnrecognisedStatus(t *testing.T) {
	// herdr said something we cannot map. We cannot show that pasted text would
	// be text rather than a menu selection, so we do not paste it.
	p := &fakePane{status: Status("restarting"), seq: 2}
	h := newInputHarness(t, p)
	if _, err := h.ctrl.Say(context.Background(), h.guard(), "hello"); !errors.Is(err, ErrAgentBusy) {
		t.Fatalf("Say error = %v, want ErrAgentBusy", err)
	}
	h.assertNoInput()
}

func TestSayPassesTheWaitAcknowledgement(t *testing.T) {
	p := &fakePane{status: StatusIdle, seq: 2, promptStatus: string(StatusWorking)}
	p.screen = claudeScreen("> hello", "")
	h := newInputHarness(t, p)

	if _, err := h.ctrl.Say(context.Background(), h.guard(), "hello"); err != nil {
		t.Fatalf("Say: %v", err)
	}
	var wait *herdrapi.PromptWait
	for _, c := range h.client.Calls() {
		if c.Method == "agent.prompt" {
			wait = c.Wait
		}
	}
	if wait == nil {
		t.Fatal("agent.prompt was sent without a wait; its return value alone is not delivery (G3)")
	}
	if wait.TimeoutMs == nil || *wait.TimeoutMs != promptWaitTimeoutMs {
		t.Fatalf("wait.timeout_ms = %v, want %d", wait.TimeoutMs, promptWaitTimeoutMs)
	}
	if want := []string{"working", "blocked", "idle", "done"}; !equalStrings(wait.Until, want) {
		t.Fatalf("wait.until = %v, want %v", wait.Until, want)
	}
}

func TestSayRetriesAStalledPromptWithBackoff(t *testing.T) {
	p := &fakePane{status: StatusIdle, seq: 2, promptStatus: string(StatusWorking)}
	p.promptResults = []error{stalled(), stalled(), nil}
	p.screen = claudeScreen("> ship it", "")
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "ship it")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if !d.Acked || d.Attempts != 3 {
		t.Fatalf("Delivery = %+v, want acked on attempt 3", d)
	}
	// The two back-offs, and nothing else that long.
	var backoffs []time.Duration
	for _, w := range h.clk.waits() {
		if w != settlePollInterval {
			backoffs = append(backoffs, w)
		}
	}
	if want := []time.Duration{time.Second, 2 * time.Second}; !equalDurations(backoffs, want) {
		t.Fatalf("back-offs = %v, want %v", backoffs, want)
	}
	if p.promptCalls != 3 {
		t.Fatalf("agent.prompt called %d times, want 3", p.promptCalls)
	}
	for _, sent := range p.prompts {
		if sent != "ship it" {
			t.Fatalf("retry changed the text: %q", sent)
		}
	}
}

func TestSayGivesUpAfterThreeRetries(t *testing.T) {
	p := &fakePane{status: StatusIdle, seq: 2}
	p.promptResults = []error{stalled()}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "hello")
	if !errors.Is(err, herdrapi.ErrPromptStalled) {
		t.Fatalf("Say error = %v, want ErrPromptStalled", err)
	}
	if d.Acked {
		t.Fatal("Delivery claims an ack for a prompt herdr said it never landed")
	}
	if d.Attempts != promptAttempts {
		t.Fatalf("Attempts = %d, want %d", d.Attempts, promptAttempts)
	}
	var backoffs []time.Duration
	for _, w := range h.clk.waits() {
		if w != settlePollInterval {
			backoffs = append(backoffs, w)
		}
	}
	if want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}; !equalDurations(backoffs, want) {
		t.Fatalf("back-offs = %v, want %v", backoffs, want)
	}
	// No read-back: there is nothing to look for.
	if n := h.client.Count("agent.read"); n != 0 {
		t.Fatalf("agent.read called %d times after giving up", n)
	}
}

func TestSayDoesNotRetryIntoAPermissionDialog(t *testing.T) {
	// The stall path is a hole in the one-vote veto if the retry does not
	// re-check. herdr reports agent_prompt_stalled after observing no state
	// change for eight seconds, and the back-off adds up to seven more; in that
	// window the desktop user — or a hook — can put the agent into a permission
	// dialog. Attempt 2 would then paste prose into a menu, which discards the
	// text and presses Enter on `❯ 1. Yes` (G1).
	p := &fakePane{status: StatusIdle, seq: 2, statusOnPrompt: StatusBlocked}
	p.promptResults = []error{stalled(), nil}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "absolutely not, do NOT run this command")
	if !errors.Is(err, ErrCannotUnblock) {
		t.Fatalf("Say error = %v, want ErrCannotUnblock", err)
	}
	if p.promptCalls != 1 {
		t.Fatalf("agent.prompt called %d times; the retry went into a blocked agent (G1)", p.promptCalls)
	}
	if d.Acked {
		t.Fatalf("Delivery = %+v, want no ack: herdr said the first attempt never landed", d)
	}
	if d.FinalStatus != StatusBlocked {
		t.Errorf("FinalStatus = %s, want blocked so the caller can say why", d.FinalStatus)
	}
}

func TestSayDoesNotRetryIntoAWorkingAgent(t *testing.T) {
	// Same precondition, milder outcome: the agent picked the prompt up after
	// all and is busy with it. Sending it again would say the same thing twice.
	p := &fakePane{status: StatusIdle, seq: 2, statusOnPrompt: StatusWorking}
	p.promptResults = []error{stalled(), nil}
	h := newInputHarness(t, p)

	_, err := h.ctrl.Say(context.Background(), h.guard(), "ship it")
	if !errors.Is(err, ErrAgentBusy) {
		t.Fatalf("Say error = %v, want ErrAgentBusy", err)
	}
	if p.promptCalls != 1 {
		t.Fatalf("agent.prompt called %d times, want 1: the agent was no longer settled", p.promptCalls)
	}
}

func TestSayAdmitsItAlreadyCancelledTheDialog(t *testing.T) {
	// esc is a side effect that outlives the error: S2 queues on ErrAgentBusy
	// and re-sends later, but the dialog the human was looking at is already
	// gone, so "nothing happened" would be a lie.
	p := &fakePane{status: StatusBlocked, seq: 3, escTo: StatusWorking}
	h := newInputHarness(t, p)

	_, err := h.ctrl.Say(context.Background(), h.guard(), "hello")
	if !errors.Is(err, ErrAgentBusy) {
		t.Fatalf("Say error = %v, want ErrAgentBusy", err)
	}
	if keys := p.sentKeys(); len(keys) != 1 || keys[0] != keyEscape {
		t.Fatalf("keys = %v, want exactly [esc]", keys)
	}
	if !strings.Contains(err.Error(), "esc was delivered") {
		t.Fatalf("error %q does not say a dialog may have been cancelled", err)
	}
}

func TestSayDoesNotRetryAnAmbiguousFailure(t *testing.T) {
	// Anything that is not agent_prompt_stalled might have been delivered.
	// Sending it again would say the same thing to the agent twice.
	boom := &herdrapi.APIError{Code: herdrapi.CodeAgentNotReady, Message: "not ready"}
	p := &fakePane{status: StatusIdle, seq: 2, promptResults: []error{boom}}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "hello")
	if err == nil || errors.Is(err, herdrapi.ErrPromptStalled) {
		t.Fatalf("Say error = %v, want the underlying failure", err)
	}
	if d.Attempts != 1 || p.promptCalls != 1 {
		t.Fatalf("Attempts = %d, prompt calls = %d, want 1 of each", d.Attempts, p.promptCalls)
	}
}

func TestSayReportsAckedButUnverifiedHonestly(t *testing.T) {
	// herdr took the text and the agent moved, but it is nowhere on screen.
	// That is "sent but not confirmed", and it must never be dressed up as
	// success (G3).
	p := &fakePane{status: StatusIdle, seq: 2, promptStatus: string(StatusWorking)}
	p.screen = claudeScreen("> something else entirely", "")
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "the message")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if !d.Acked {
		t.Fatal("Acked = false, want true: herdr accepted the prompt")
	}
	if d.Verified {
		t.Fatal("Verified = true for text that is not on the screen")
	}
	if d.FinalStatus != StatusWorking {
		t.Errorf("FinalStatus = %s, want the state the wait observed", d.FinalStatus)
	}
}

func TestSayIgnoresAnEchoThatOnlyExistsInTheInputBox(t *testing.T) {
	// G4, measured: Claude renders ghost completion suggestions inside its
	// composer, and pane.read returns them as ordinary text. A whole-screen
	// grep would confirm delivery of a message that was never sent.
	tests := []struct {
		name string
		// text defaults to "deploy to staging".
		text       string
		screen     string
		wantVerify bool
	}{
		{
			name:       "only inside the input box",
			screen:     claudeScreen("  Working on something unrelated", "❯ deploy to staging"),
			wantVerify: false,
		},
		{
			name:       "echoed in the transcript above the box",
			screen:     claudeScreen("> deploy to staging", "❯ some ghost suggestion"),
			wantVerify: true,
		},
		{
			name: "wrapped across two transcript lines",
			// The terminal broke the sentence at the pane width; the words are
			// the same ones.
			screen:     claudeScreen("> deploy to\n  staging", "❯"),
			wantVerify: true,
		},
		{
			name:       "framed by a codex-style box",
			screen:     claudeScreen("│ deploy to │\n│ staging   │", "❯"),
			wantVerify: true,
		},
		{
			name:       "nothing on screen at all",
			screen:     "",
			wantVerify: false,
		},
		{
			// A short message is the common case from a phone, and a substring
			// search finds it everywhere: "no" lives inside "nothing". A false
			// positive loses the user's message silently, so a needle this
			// short has to BE a line rather than appear inside one.
			name:       "a short message that is only a substring of the transcript",
			text:       "no",
			screen:     claudeScreen("  I found nothing to do here.", "❯"),
			wantVerify: false,
		},
		{
			name:       "a short message echoed as its own transcript line",
			text:       "no",
			screen:     claudeScreen("> no", "❯"),
			wantVerify: true,
		},
		{
			name:       "a short message that is only in the input box",
			text:       "ok",
			screen:     claudeScreen("  Working on something unrelated", "❯ ok"),
			wantVerify: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			text := tc.text
			if text == "" {
				text = "deploy to staging"
			}
			p := &fakePane{status: StatusIdle, seq: 2, screen: tc.screen, promptStatus: string(StatusIdle)}
			h := newInputHarness(t, p)
			d, err := h.ctrl.Say(context.Background(), h.guard(), text)
			if err != nil {
				t.Fatalf("Say: %v", err)
			}
			if d.Verified != tc.wantVerify {
				t.Fatalf("Verified = %v, want %v for screen:\n%s", d.Verified, tc.wantVerify, tc.screen)
			}
			if !d.Acked {
				t.Fatal("Acked = false, want true")
			}
		})
	}
}

func TestSayReadsOnlyTheVisibleBuffer(t *testing.T) {
	p := &fakePane{status: StatusIdle, seq: 2, screen: claudeScreen("> hi", "")}
	h := newInputHarness(t, p)
	if _, err := h.ctrl.Say(context.Background(), h.guard(), "hi"); err != nil {
		t.Fatalf("Say: %v", err)
	}
	// Count first: the assertions below live inside a filter, so without this
	// they would all pass if the read-back were deleted outright.
	if n := h.client.Count("agent.read"); n != 1 {
		t.Fatalf("agent.read called %d times, want exactly 1 read-back", n)
	}
	for _, c := range h.client.Calls() {
		if c.Method != "agent.read" {
			continue
		}
		// source=recent makes herdr synthesise mouse-wheel events into the
		// user's live pane for up to 15s, and a line count is what triggers it
		// (G9).
		if c.Source != herdrapi.SourceVisible {
			t.Fatalf("agent.read source = %q, want visible", c.Source)
		}
		if c.Lines != 0 {
			t.Fatalf("agent.read lines = %d, want 0 (whole buffer)", c.Lines)
		}
	}
	if rejected := h.client.Rejected(); len(rejected) != 0 {
		t.Fatalf("the client refused %d reads: %+v", len(rejected), rejected)
	}
}

func TestSayIsGuardedToo(t *testing.T) {
	p := &fakePane{status: StatusIdle, seq: 2}
	h := newInputHarness(t, p)
	stale := Guard{PaneID: p.paneID, Kind: "claude", StateSeq: 2, IssuedAt: h.clk.Now().Add(-MaxGuardAge - time.Minute)}

	if _, err := h.ctrl.Say(context.Background(), stale, "hello"); !errors.Is(err, ErrGuardStale) {
		t.Fatalf("Say error = %v, want ErrGuardStale", err)
	}
	h.assertNoInput()
}

// ---------- forbidden methods ----------

func TestControllerNeverCallsAForbiddenMethod(t *testing.T) {
	forbidden := map[string]bool{}
	for _, m := range herdrapi.ForbiddenMethods {
		forbidden[m] = true
	}
	allowed := map[string]bool{"agent.get": true, "agent.send_keys": true, "agent.prompt": true, "agent.read": true}

	// One controller, driven through every entry point, including the blocked
	// path that is the most eventful.
	p := &fakePane{status: StatusBlocked, seq: 1, screen: claudeScreen("> hello", "")}
	h := newInputHarness(t, p)
	ctx := context.Background()

	if _, err := h.ctrl.Say(ctx, h.guard(), "hello"); err != nil {
		t.Fatalf("Say: %v", err)
	}
	p.mu.Lock()
	p.status = StatusBlocked
	p.seq++
	p.mu.Unlock()
	if _, err := h.ctrl.SendKey(ctx, h.guard(), "1"); err != nil {
		t.Fatalf("SendKey: %v", err)
	}
	if _, err := h.ctrl.Interrupt(ctx, h.guard()); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}

	methods := h.methods()
	// Without this, an implementation that made no calls at all would satisfy
	// every assertion in the loop below.
	for _, want := range []string{"agent.get", "agent.prompt", "agent.send_keys", "agent.read"} {
		if h.client.Count(want) == 0 {
			t.Fatalf("%q was never called; the recorded set %v cannot prove anything", want, methods)
		}
	}
	for _, m := range methods {
		if forbidden[m] {
			t.Errorf("controller called forbidden method %q", m)
		}
		if !allowed[m] {
			t.Errorf("controller called %q; the input protocol needs nothing else", m)
		}
	}
}

// ---------- helpers ----------

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalDurations(a, b []time.Duration) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
