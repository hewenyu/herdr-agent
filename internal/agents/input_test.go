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

	// launchPending models a managed agent herdr has not finished starting.
	launchPending bool

	screen string

	// composerEchoes renders the input box from the prompts this pane has
	// received, which is what a real TUI does with a paste it has not consumed:
	// every body is appended to the composer, and a newline inside a body starts a
	// new line in it. It is the only way to model M2 and M3 in one fake — the glued
	// `QUEUED-ONEQUEUED-TWO` and the separated `SEP-ONE` / `SEP-TWO` are the same
	// mechanism with and without the separator.
	//
	// It overrides screen and screenAfterPrompt.
	composerEchoes bool

	// screenAfterPrompt, when set, replaces screen once agent.prompt has been
	// called and renderDelay has passed. One static screen cannot model both
	// halves of a delivery: the input-box probe that decides whether a separator
	// is needed runs BEFORE the paste, and the read-back that verifies the
	// delivery runs after it.
	screenAfterPrompt string

	// renderDelay is how long the paste takes to appear on screen. It models the
	// gap the working path has to cover: herdr answers agent.prompt as soon as
	// the bytes are queued to the PTY, so a read-back taken immediately sees the
	// screen as it was and finds nothing.
	renderDelay time.Duration
	promptedAt  time.Time

	// now is the harness clock, so renderDelay is measured in virtual time.
	now func() time.Time

	// readErr fails agent.read, modelling a screen we cannot see at all.
	readErr error

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
		LaunchPending:  p.launchPending,
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

func (p *fakePane) prompt(_ context.Context, _, text string, wait *herdrapi.PromptWait) (herdrapi.AgentInfo, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.promptCalls++
	p.prompts = append(p.prompts, text)
	p.promptedAt = p.clock()
	atSubmission := p.status
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
	if wait == nil {
		// A submission that asked for no acknowledgement gets an answer describing
		// the agent as it was when the bytes were queued: herdr observed nothing
		// after them, so its reply cannot report a transition the paste caused. Any
		// caller that wants the status the delivery produced has to go and read it.
		out.AgentStatus = string(atSubmission)
	}
	if p.promptStatus != "" {
		out.AgentStatus = p.promptStatus
	}
	return out, nil
}

func (p *fakePane) read(context.Context, string, herdrapi.ReadSource, int) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.readErr != nil {
		return "", p.readErr
	}
	if p.composerEchoes {
		return claudeScreenLines("  … working", composerFrom(p.prompts)), nil
	}
	if p.screenAfterPrompt != "" && !p.promptedAt.IsZero() && p.clock().Sub(p.promptedAt) >= p.renderDelay {
		return p.screenAfterPrompt, nil
	}
	return p.screen, nil
}

// composerFrom renders the input box the way a TUI that has not consumed its
// input renders it: the pasted bodies concatenated, broken wherever one of them
// carried a newline, the first line behind the prompt glyph and the rest indented
// under it. That is verbatim M3 —
//
//	❯ SEP-ONE
//	  SEP-TWO
//
// — and, without the separator, verbatim M2: `❯ QUEUED-ONEQUEUED-TWO`.
func composerFrom(prompts []string) []string {
	var out []string
	for i, line := range strings.Split(strings.Join(prompts, ""), "\n") {
		if i == 0 {
			out = append(out, "❯ "+line)
			continue
		}
		out = append(out, "  "+line)
	}
	return out
}

// clock is the harness clock, or the wall clock for a pane used without one.
func (p *fakePane) clock() time.Time {
	if p.now == nil {
		return time.Now()
	}
	return p.now()
}

// promptTexts returns every text agent.prompt was called with, separators and
// all.
func (p *fakePane) promptTexts() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.prompts...)
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
	p.now = clk.Now
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
	return claudeScreenLines(transcript, []string{composer})
}

// claudeScreenLines is claudeScreen with a composer of more than one line, which
// is what a box holding two queued messages looks like (M3).
func claudeScreenLines(transcript string, composer []string) string {
	rule := strings.Repeat("─", 40)
	lines := []string{
		"  Some earlier output",
		transcript,
		"",
		"╭" + rule + "╮",
	}
	for _, line := range composer {
		lines = append(lines, "│ "+line)
	}
	return strings.Join(append(lines,
		"╰"+rule+"╯",
		"  ⏵⏵ accept edits on (shift+tab to cycle)",
	), "\n")
}

// realClaudeScreen renders the bottom of a screen captured from a live claude —
// internal/screen/testdata/claude-53.txt lines 23-31, verbatim — with only the
// composer's contents substituted.
//
// It matters that this is the real thing: an EMPTY claude composer is not an
// empty line, it is `│ >`, and a probe that took the prompt glyph for content
// would put a separator in front of every message ever sent.
func realClaudeScreen(composer string) string {
	return strings.Join([]string{
		"   3. No, and tell Claude what to do",
		"      differently (esc)",
		"",
		"─────────────────────────────────────────────────────",
		"╭───────────────────────────────────────────────────╮",
		"│ " + composer,
		"╰───────────────────────────────────────────────────╯",
		"  ⏵⏵ accept edits on (shift+tab to cycle)",
		"",
	}, "\n")
}

// workingClaudeScreen renders the bottom of a screen captured from a claude that
// was MID-TURN — `agent_status: working` before the read and after it — with only
// the composer's contents substituted.
//
// Measured 2026-08-15 against the live herdr 0.8.0 / protocol 19, which is what
// makes it worth carrying: everything the working path does rests on the composer
// being readable and locatable while a turn is running, and until this capture the
// only evidence for that was M2/M3's transcript echoes, which were printed AFTER
// their turn ended. What the capture settles, all of it previously assumed:
//
//   - agent.read source=visible answers mid-turn. It does not fail agent_not_idle
//     (that is the source=recent scroll-injection path, G9).
//   - the composer is two bare 118-column rules with one content line between
//     them — no `╭─╮ │ ╰─╯` box at all on this claude — which InputBoxRange pairs
//     bottom-up with a single non-blank line under it.
//   - a paste made while the agent is working SITS in that line: the capture reads
//     `❯ MIDTURN-PROBE-ONE (ignore this line)` while the agent went on
//     counting above it (G19/M1, now measured from the composer side rather than
//     from the transcript afterwards).
//   - the glyph is followed by U+00A0, a NO-BREAK space, not U+0020. normalizeEcho
//     drops it because unicode.IsSpace covers U+00A0 — but a hand-written
//     `TrimPrefix(line, "❯ ")` would not, and would read every empty composer as
//     content.
//   - NONE of dialogMarkers is anywhere on a working screen. The footer is
//     `⏸ manual mode on · ? for shortcuts · ← for agents`; there is no
//     `esc to cancel` and no `↑/↓ to navigate` unless a menu is actually open,
//     which is what keeps preflight's refusal from firing on every delivery.
func workingClaudeScreen(composer string) string {
	rule := strings.Repeat("─", 118)
	return strings.Join([]string{
		"  24 hours",
		"  25 cent",
		"  26 letters",
		"",
		rule,
		composer,
		rule,
		"  ⏸ manual mode on · ? for shortcuts · ← for agents",
		"",
	}, "\n")
}

// realWorkingComposer is the captured composer line, verbatim — including the
// NO-BREAK space after the glyph, written as an escape rather than pasted so that
// nobody "tidies" it into an ordinary space and quietly changes what is tested.
//
// text is what a paste put in the composer; empty means an untouched one, which on
// a real claude is the bare glyph and never a blank line.
func realWorkingComposer(text string) string {
	if text == "" {
		return "❯"
	}
	return "❯\u00a0" + text
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

func TestSayRequiresUnblockedEvenWhenRegistrySnapshotWasIdle(t *testing.T) {
	p := &fakePane{status: StatusIdle, seq: 1}
	h := newInputHarness(t, p)
	g := h.guard()
	g.RequireUnblocked = true
	// Approval appeared after the cached state used to build this guard.
	p.status = StatusBlocked
	p.seq = 2
	d, err := h.ctrl.Say(context.Background(), g, "continue the task")
	if !errors.Is(err, ErrCannotUnblock) || d.FinalStatus != StatusBlocked {
		t.Fatalf("Say = %+v, %v; want a human-approval refusal", d, err)
	}
	if d.Escaped || d.Acked || d.Verified || len(p.sentKeys()) != 0 || h.client.Count("agent.prompt") != 0 {
		t.Fatalf("AI delivery touched a pending approval: %+v, methods=%v", d, h.methods())
	}
}

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

func TestSayDeliversProseToAWorkingAgent(t *testing.T) {
	// G19/M1, measured against a real claude: agent.prompt to a working agent
	// SUCCEEDS. The agent has its own input queue — the text lands in its input
	// box and is submitted as a prompt when the current turn ends. Refusing here
	// (S1 §3.4.3) queued at the wrong layer, and the user watching their second
	// and third sentences sit undelivered is the bug this replaces.
	p := &fakePane{status: StatusWorking, seq: 2}
	p.screen = claudeScreen("  … running tests", "")
	p.screenAfterPrompt = claudeScreen("  … running tests", "❯ also fix the flaky one")
	// The paste is not on screen the instant herdr answers: this path asks for no
	// wait, so agent.prompt returns as soon as the bytes are queued to the PTY. A
	// read-back taken immediately would report every queued message as
	// unconfirmed, so Say has to let the TUI draw first.
	p.renderDelay = workingEchoDelay
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "also fix the flaky one")
	if err != nil {
		t.Fatalf("Say to a working agent: %v, want delivery", err)
	}
	if !d.Acked {
		t.Fatalf("Delivery = %+v, want acked", d)
	}
	// Queued, not started: the agent is mid-turn and will read this when it
	// finishes, which is a different promise from "it is reading this now".
	if !d.Queued {
		t.Fatalf("Delivery.Queued = false for a working agent: %+v", d)
	}
	if !d.Verified {
		t.Fatalf("Verified = false; the text is in the input box, which is where a queued message shows up: %+v", d)
	}
	if d.FinalStatus != StatusWorking {
		t.Errorf("FinalStatus = %s, want working", d.FinalStatus)
	}
	if got := p.promptTexts(); len(got) != 1 || got[0] != "also fix the flaky one" {
		t.Fatalf("prompts = %q, want exactly one, unmodified: the input box was empty", got)
	}
}

func TestSayNeverPressesEnterOnAWorkingAgent(t *testing.T) {
	// The one thing this path must not do. agent.prompt already writes a
	// bracketed paste and an Enter 300ms later; that Enter is herdr's, and while
	// the agent is busy it does not submit. Sending our own Enter to make the
	// pending text go through is how G1 happens: an Enter aimed at a TUI that has
	// meanwhile put up a permission menu selects `❯ 1. Yes`.
	p := &fakePane{status: StatusWorking, seq: 2}
	p.screen = claudeScreen("  … running tests", "❯ QUEUED-ONE")
	h := newInputHarness(t, p)

	if _, err := h.ctrl.Say(context.Background(), h.guard(), "QUEUED-TWO"); err != nil {
		t.Fatalf("Say: %v", err)
	}
	if keys := p.sentKeys(); len(keys) != 0 {
		t.Fatalf("keys %v reached a working agent; the only submission is agent.prompt's own", keys)
	}
	if n := h.client.Count("agent.send_keys"); n != 0 {
		t.Fatalf("agent.send_keys called %d times on the working path", n)
	}
}

func TestSayOmitsTheWaitForAWorkingSubmission(t *testing.T) {
	// herdr skips its prompt-stalled gate when submission starts from `working`
	// and falls through to a settled-state wait that only matches once
	// state_change_seq moves past the submission (src/api/wait.rs:232). An agent
	// that goes on working never moves it, so the wait would burn the whole
	// timeout and answer `timeout` — an error indistinguishable from a real
	// failure, which would report a delivery that measurably DID land as a failed
	// one and have the layer above re-send it. So no wait is asked for, and the
	// input-box read-back is the evidence instead.
	working := &fakePane{status: StatusWorking, seq: 2, screen: claudeScreen("  busy", "")}
	h := newInputHarness(t, working)
	if _, err := h.ctrl.Say(context.Background(), h.guard(), "queue this please"); err != nil {
		t.Fatalf("Say: %v", err)
	}
	for _, c := range h.client.Calls() {
		if c.Method == "agent.prompt" && c.Wait != nil {
			t.Fatalf("agent.prompt carried wait %+v for a working submission", c.Wait)
		}
	}
	// The settled path still asks for one: there the wait IS the acknowledgement
	// (G3), and this half of the assertion is what stops the branch from being
	// "never send a wait".
	idle := &fakePane{status: StatusIdle, seq: 2, screen: claudeScreen("> hello", ""), promptStatus: string(StatusWorking)}
	h2 := newInputHarness(t, idle)
	if _, err := h2.ctrl.Say(context.Background(), h2.guard(), "hello"); err != nil {
		t.Fatalf("Say: %v", err)
	}
	seen := false
	for _, c := range h2.client.Calls() {
		if c.Method == "agent.prompt" {
			seen = c.Wait != nil
		}
	}
	if !seen {
		t.Fatal("agent.prompt to a settled agent carried no wait; its return value alone is not delivery (G3)")
	}
}

func TestSaySeparatesTextFromWhateverTheInputBoxHolds(t *testing.T) {
	// G19/M2, verbatim from the pane: two prompts sent during one working turn
	// arrived as ONE message with nothing between them —
	//
	//	> QUEUED-ONEQUEUED-TWO
	//
	// because agent.prompt's Enter does not submit while the agent is busy, so
	// the second paste landed on the tail of the same input line. "yes" followed
	// by "no" becomes "yesno". M3: a leading newline separates them correctly.
	tests := []struct {
		name   string
		status Status
		// composer is what the input box holds before the paste.
		composer string
		readErr  error
		want     string
	}{
		{
			name:     "working agent whose box already holds a queued message",
			status:   StatusWorking,
			composer: "❯ QUEUED-ONE",
			want:     "\nQUEUED-TWO",
		},
		{
			name:     "working agent with an empty box",
			status:   StatusWorking,
			composer: "",
			want:     "QUEUED-TWO",
		},
		{
			// The rule is about the box, not the status: a settled agent whose
			// composer holds a half-typed line at the desktop would concatenate
			// exactly the same way.
			name:     "settled agent whose box holds something",
			status:   StatusIdle,
			composer: "❯ half a sentence",
			want:     "\nQUEUED-TWO",
		},
		{
			name:     "settled agent with an empty box",
			status:   StatusIdle,
			composer: "",
			want:     "QUEUED-TWO",
		},
		{
			// A screen we cannot read is not evidence that the box is empty. The
			// costs are not symmetric: a separator nobody needed is one blank
			// line, a missing one merges two messages into a third that neither
			// of them said.
			name:    "a screen that cannot be read at all",
			status:  StatusWorking,
			readErr: errors.New("pane read failed"),
			want:    "\nQUEUED-TWO",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePane{status: tc.status, seq: 2, readErr: tc.readErr}
			p.screen = claudeScreen("  earlier output", tc.composer)
			if tc.status == StatusIdle {
				p.promptStatus = string(StatusWorking)
			}
			h := newInputHarness(t, p)

			if _, err := h.ctrl.Say(context.Background(), h.guard(), "QUEUED-TWO"); err != nil {
				t.Fatalf("Say: %v", err)
			}
			got := p.promptTexts()
			if len(got) != 1 {
				t.Fatalf("prompts = %q, want exactly one", got)
			}
			if got[0] != tc.want {
				t.Fatalf("prompt text = %q, want %q", got[0], tc.want)
			}
		})
	}
}

func TestSayJudgesTheInputBoxFromARealComposer(t *testing.T) {
	// The decision in the previous test is only as good as the screen it is made
	// from, and the synthetic composer there is tidier than the real one.
	tests := []struct {
		name string
		// composer is what sits after `│ ` on the real captured screen.
		composer string
		want     string
	}{
		{
			// Verbatim from internal/screen/testdata/claude-53.txt: an idle
			// claude's empty composer is `│ >`, never a blank line. Reading the
			// prompt glyph as content would separate every message ever sent.
			name:     "an empty composer is just the prompt glyph",
			composer: ">",
			want:     "QUEUED-TWO",
		},
		{
			name:     "a queued message waiting for the turn to end",
			composer: "> QUEUED-ONE",
			want:     "\nQUEUED-TWO",
		},
		{
			// Verbatim from internal/screen/testdata/claude-173.txt. This is a
			// ghost completion, never typed and never sent (G4) — and it is
			// treated as content anyway. The separator is one blank line the
			// message did not need; mistaking it for an empty box would merge two
			// of the user's messages into one they never wrote.
			name:     "a ghost completion counts as content",
			composer: "> Reply with exactly the single word MARKER4 and nothing else.",
			want:     "\nQUEUED-TWO",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePane{status: StatusWorking, seq: 2, screen: realClaudeScreen(tc.composer)}
			h := newInputHarness(t, p)

			if _, err := h.ctrl.Say(context.Background(), h.guard(), "QUEUED-TWO"); err != nil {
				t.Fatalf("Say: %v", err)
			}
			got := p.promptTexts()
			if len(got) != 1 || got[0] != tc.want {
				t.Fatalf("prompts = %q, want [%q]", got, tc.want)
			}
		})
	}
}

// readBarrier is how long the barrier in the concurrency test below waits for a
// second delivery to reach its pre-paste read. Real time, paid once.
const readBarrier = 250 * time.Millisecond

func TestSayDoesNotInterleaveTwoConcurrentDeliveries(t *testing.T) {
	// G19/M2 is a race, not a formatting rule. A delivery is a screen read plus a
	// paste whose body depends on what that read found, and the larksuite SDK runs
	// a goroutine per inbound WebSocket frame (ws/client.go:554), so two Feishu
	// messages a second apart reach Say for the SAME pane at the same time. Both
	// read the same empty composer, both paste unprefixed, and the agent submits
	// one prompt reading `yesno` — measured verbatim as `QUEUED-ONEQUEUED-TWO`.
	//
	// Until prose was delivered to working agents this was impossible by accident:
	// a working agent answered ErrAgentBusy and every real delivery went out from
	// the bridge's single drain goroutine ("one Say at a time across all panes —
	// and that is the point", bridge/queue.go). The working path routes around that
	// drain, so the serialisation has to be here.
	p := &fakePane{status: StatusWorking, seq: 2, composerEchoes: true}
	h := newInputHarness(t, p)

	// The barrier makes the failure deterministic rather than leaving it to the
	// scheduler: the first two reads to arrive wait for each other. Serialised, the
	// second delivery cannot reach its read while the first holds the pane, so the
	// first read waits out the budget alone and everything after it is free.
	// Unserialised, the two pre-paste reads return together — which is exactly the
	// interleaving being tested.
	var mu sync.Mutex
	arrived := 0
	inner := h.client.OnAgentRead
	h.client.OnAgentRead = func(ctx context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
		mu.Lock()
		arrived++
		nth := arrived
		mu.Unlock()
		for deadline := time.Now().Add(readBarrier); nth <= 2 && time.Now().Before(deadline); {
			mu.Lock()
			both := arrived >= 2
			mu.Unlock()
			if both {
				break
			}
			time.Sleep(time.Millisecond)
		}
		return inner(ctx, target, src, lines)
	}

	sent := []string{"yes", "no"}
	guards := []Guard{h.guard(), h.guard()}
	deliveries := make([]Delivery, len(sent))
	errs := make([]error, len(sent))

	var wg sync.WaitGroup
	for i := range sent {
		wg.Add(1)
		go func() {
			defer wg.Done()
			deliveries[i], errs[i] = h.ctrl.Say(context.Background(), guards[i], sent[i])
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("Say(%q): %v", sent[i], err)
		}
	}

	got := p.promptTexts()
	if len(got) != 2 {
		t.Fatalf("prompts = %q, want two", got)
	}
	separated, bodies := 0, map[string]bool{}
	for _, body := range got {
		if strings.HasPrefix(body, promptSeparator) {
			separated++
		}
		bodies[strings.TrimPrefix(body, promptSeparator)] = true
	}
	if len(bodies) != 2 || !bodies["yes"] || !bodies["no"] {
		t.Fatalf("prompt bodies = %q, want one 'yes' and one 'no' and nothing else", got)
	}
	// Exactly one, whichever went second: the first found an empty composer and a
	// leading blank line there is noise, and the second must have SEEN the first.
	// Ordering is not asserted — two sentences racing into the bridge were already
	// at the mercy of the scheduler, and a swapped pair is legible where a merged
	// one is data loss.
	if separated != 1 {
		t.Fatalf("prompts = %q, want exactly one to carry the separator", got)
	}
	for _, line := range composerFrom(got) {
		if strings.Contains(line, "yes") && strings.Contains(line, "no") {
			t.Fatalf("the agent's composer line %q holds both messages — that is M2's `yesno`", line)
		}
	}

	// And both are reported honestly, which the box read-back can only do if the
	// two deliveries did not overwrite each other's evidence either.
	for i, d := range deliveries {
		if !d.Acked || !d.Queued || !d.Verified {
			t.Fatalf("Delivery for %q = %+v, want acked, queued and verified", sent[i], d)
		}
	}
}

func TestSayWillNotPasteAtADialogOnTheScreen(t *testing.T) {
	// The G11 false negative, caught from the side that can still act on it.
	// herdr's claude detector is a literal string match that reports `idle` when it
	// fails (src/detect/manifest.rs:527-542), so agent.get alone is not enough to
	// know a menu is not up — and prose pasted at a menu is discarded while the
	// Enter that herdr sends 300ms later selects `❯ 1. Yes` (G1). preflight reads
	// the screen anyway, so it checks it.
	dialogLines := []string{
		// Verbatim from internal/screen/testdata/claude-173.txt:16-27.
		"─────────────────────────────────────────────────────",
		" Bash command",
		"",
		"   touch /tmp/herdr-accept/DANGER.txt",
		"",
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   2. Yes, and don't ask again for touch commands",
		"   3. No, and tell Claude what to do differently (esc)",
		"",
		"─────────────────────────────────────────────────────",
	}
	wrapped := []string{
		// Verbatim from internal/screen/testdata/claude-53.txt:19-25. At 53 columns
		// the question itself wraps, which is precisely where herdr's own literal
		// match stops matching (G5, G11) — so the check cannot be line-by-line.
		" Do you want to",
		" proceed?",
		" ❯ 1. Yes",
	}

	tests := []struct {
		name   string
		status Status
		screen string
	}{
		{
			name:   "a dialog above the composer, herdr calling it working",
			status: StatusWorking,
			screen: strings.Join(append(dialogLines, claudeScreen("", "")), "\n"),
		},
		{
			name:   "the same dialog with herdr calling the pane idle",
			status: StatusIdle,
			screen: strings.Join(append(wrapped, claudeScreen("", "")), "\n"),
		},
		{
			name:   "the menu hint herdr matches, below the box",
			status: StatusWorking,
			screen: claudeScreen("  … working", "") + "\n  ↑/↓ to navigate · esc to cancel",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePane{status: tc.status, seq: 2, screen: tc.screen}
			h := newInputHarness(t, p)

			d, err := h.ctrl.Say(context.Background(), h.guard(), "absolutely not, do NOT run this command")
			if !errors.Is(err, ErrDialogOnScreen) {
				t.Fatalf("Say error = %v, want ErrDialogOnScreen", err)
			}
			// Also ErrCannotUnblock, because that is the sentinel callers already
			// render, and the user-facing fact is the same: answer the dialog, the
			// message was not sent.
			if !errors.Is(err, ErrCannotUnblock) {
				t.Fatalf("Say error = %v, want it to also wrap ErrCannotUnblock", err)
			}
			// Nothing was written at all: this is the one-vote veto (G1), and no esc
			// is sent either — another esc can answer a second dialog behind the
			// first, and herdr may be showing a menu we did not open.
			h.assertNoInput()
			if d.Acked {
				t.Fatalf("Delivery = %+v, want nothing claimed", d)
			}
		})
	}
}

func TestSayPastesWhenTheScreenHasNoDialogOnIt(t *testing.T) {
	// The other half of the previous test: the refusal must not fire on an ordinary
	// screen, or every delivery to a working agent turns into "answer the card" and
	// the feature is gone. Both screens here are the ones the other tests deliver
	// through, including a captured claude that still has a dismissed dialog's last
	// line — `3. No, and tell Claude what to do differently (esc)` — in its
	// transcript.
	for name, s := range map[string]string{
		"a working claude":             claudeScreen("  … running tests", ""),
		"a real captured claude":       realClaudeScreen(">"),
		"a real captured claude, busy": realClaudeScreen("> QUEUED-ONE"),
	} {
		t.Run(name, func(t *testing.T) {
			p := &fakePane{status: StatusWorking, seq: 2, screen: s}
			h := newInputHarness(t, p)
			if _, err := h.ctrl.Say(context.Background(), h.guard(), "carry on"); err != nil {
				t.Fatalf("Say: %v, want a delivery — this screen has no dialog on it", err)
			}
			if p.promptCalls != 1 {
				t.Fatalf("agent.prompt called %d times, want 1", p.promptCalls)
			}
		})
	}
}

func TestSayRefusesAnAgentThatBlocksBetweenSettlingAndThePaste(t *testing.T) {
	// The window this closes: waitSettle's last agent.get is a round trip old by
	// the time the paste goes out, and a working agent's next transition is most
	// often `blocked`. preflight re-reads the status with nothing between it and
	// the write. Here the agent blocks while the screen is being read — after the
	// settle, before the paste — and the screen itself gives nothing away.
	p := &fakePane{status: StatusWorking, seq: 2, screen: claudeScreen("  … running tests", "")}
	h := newInputHarness(t, p)
	inner := h.client.OnAgentRead
	h.client.OnAgentRead = func(ctx context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
		p.mu.Lock()
		p.status = StatusBlocked
		p.seq++
		p.statuses = nil
		p.mu.Unlock()
		return inner(ctx, target, src, lines)
	}

	d, err := h.ctrl.Say(context.Background(), h.guard(), "looks good, keep going")
	if !errors.Is(err, ErrCannotUnblock) {
		t.Fatalf("Say error = %v, want ErrCannotUnblock", err)
	}
	if n := h.client.Count("agent.prompt"); n != 0 {
		t.Fatalf("agent.prompt called %d times into an agent that had just blocked (G1)", n)
	}
	if keys := p.sentKeys(); len(keys) != 0 {
		t.Fatalf("keys = %v; the agent was not blocked when Say started, so it sends none", keys)
	}
	if d.Acked {
		t.Fatalf("Delivery = %+v, want nothing claimed", d)
	}
	if d.FinalStatus != StatusBlocked {
		t.Errorf("FinalStatus = %s, want blocked so the caller can say why", d.FinalStatus)
	}
}

func TestSayWillNotWriteWhenTheLastStatusReadFails(t *testing.T) {
	// preflight's agent.get is not a formality: it is the observation that
	// authorises writing prose into a live TUI, taken with nothing between it and
	// the paste. If herdr cannot answer it — socket down, or its single UI thread
	// wedged behind a modal dialog (G10) — then the newest thing we know about the
	// agent is a second old, and a second is how long it takes to go from working to
	// a permission menu. So nothing is written.
	down := errors.New("dial unix: connection refused")
	p := &fakePane{status: StatusWorking, seq: 2, screen: claudeScreen("  … running tests", "")}
	h := newInputHarness(t, p)
	inner := h.client.OnAgentRead
	h.client.OnAgentRead = func(ctx context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
		// The screen read immediately precedes that get, so failing from here on
		// lands on it and on nothing earlier.
		p.mu.Lock()
		p.getErr = down
		p.mu.Unlock()
		return inner(ctx, target, src, lines)
	}

	d, err := h.ctrl.Say(context.Background(), h.guard(), "looks good, keep going")
	if !errors.Is(err, down) {
		t.Fatalf("Say error = %v, want the transport failure", err)
	}
	h.assertNoInput()
	if d.Acked {
		t.Fatalf("Delivery = %+v, want nothing claimed", d)
	}
}

func TestSayDoesNotRetryIntoAnAgentThatStartsWorkingAtTheLastMoment(t *testing.T) {
	// TestSayDoesNotRetryIntoAWorkingAgent catches this at the retry's settle
	// check. This catches it one round trip later, at the moment of writing, which
	// is where the first attempt's rule and the retry's rule differ: the first
	// delivers to a working agent (G19/M1), a retry does not, because herdr's stall
	// report only means "no state change observed" and an agent that has since
	// started working may have taken the text after all.
	p := &fakePane{status: StatusIdle, seq: 2, screen: claudeScreen("  earlier", "")}
	p.promptResults = []error{stalled(), nil}
	h := newInputHarness(t, p)
	inner := h.client.OnAgentRead
	reads := 0
	h.client.OnAgentRead = func(ctx context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
		reads++
		if reads == 2 {
			// The retry's own pre-paste read: settled a moment ago, working now.
			p.mu.Lock()
			p.status = StatusWorking
			p.seq++
			p.statuses = nil
			p.mu.Unlock()
		}
		return inner(ctx, target, src, lines)
	}

	_, err := h.ctrl.Say(context.Background(), h.guard(), "ship it")
	if !errors.Is(err, ErrAgentBusy) {
		t.Fatalf("Say error = %v, want ErrAgentBusy", err)
	}
	if p.promptCalls != 1 {
		t.Fatalf("agent.prompt called %d times, want 1: the second copy was refused at the write", p.promptCalls)
	}
}

func TestSayDisclosesThatAQueuedMessageMayHaveAnsweredADialog(t *testing.T) {
	// The residual G1 exposure of delivering to a working agent, reported instead
	// of hidden. agent.prompt writes a bracketed paste and herdr writes a lone
	// Enter 300ms later; that Enter is not ours to cancel, and a working agent can
	// put up `Do you want to proceed? ❯ 1. Yes` inside the window. A dialog on
	// screen afterwards means one was up while we were writing.
	//
	// It is a disclosure, not a detection: an Enter that DID answer a dialog leaves
	// the agent working, which is indistinguishable from an agent that simply went
	// on working. The flag says "may have", and the last case below is why.
	afterWithDialog := strings.Join([]string{
		" Do you want to proceed?",
		" ❯ 1. Yes",
		"   3. No, and tell Claude what to do differently (esc)",
		"",
		claudeScreen("  … running tests", "❯ carry on"),
	}, "\n")

	tests := []struct {
		name       string
		status     Status
		onPrompt   Status
		after      string
		wantDialog bool
		wantStatus Status
		wantVerify bool
	}{
		{
			// herdr agrees it is blocked now.
			name:       "the agent is blocked after a queued delivery",
			status:     StatusWorking,
			onPrompt:   StatusBlocked,
			after:      claudeScreen("  … running tests", "❯ carry on"),
			wantDialog: true,
			wantStatus: StatusBlocked,
			wantVerify: true,
		},
		{
			// herdr does not, because its detector is a literal match that fails
			// silently (G11). The screen does.
			name:       "only the screen shows the dialog",
			status:     StatusWorking,
			after:      afterWithDialog,
			wantDialog: true,
			wantStatus: StatusWorking,
			wantVerify: true,
		},
		{
			name:       "an ordinary queued delivery discloses nothing",
			status:     StatusWorking,
			after:      claudeScreen("  … running tests", "❯ carry on"),
			wantStatus: StatusWorking,
			wantVerify: true,
		},
		{
			// A settled submission is not this problem: an idle agent has no turn
			// running, so the dialog it puts up afterwards is the one the user's own
			// prompt caused, and herdr's wait reports it as the final status.
			name:       "a settled submission that ends blocked is not disclosed",
			status:     StatusIdle,
			onPrompt:   StatusBlocked,
			after:      claudeScreen("> carry on", ""),
			wantStatus: StatusBlocked,
			wantVerify: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePane{
				status:            tc.status,
				seq:               2,
				statusOnPrompt:    tc.onPrompt,
				screen:            claudeScreen("  … running tests", ""),
				screenAfterPrompt: tc.after,
			}
			h := newInputHarness(t, p)

			d, err := h.ctrl.Say(context.Background(), h.guard(), "carry on")
			if err != nil {
				t.Fatalf("Say: %v", err)
			}
			if !d.Acked {
				t.Fatalf("Delivery = %+v, want acked: the text is in the agent", d)
			}
			if d.MayHaveAnsweredADialog != tc.wantDialog {
				t.Fatalf("MayHaveAnsweredADialog = %v, want %v: %+v", d.MayHaveAnsweredADialog, tc.wantDialog, d)
			}
			// The status is re-read after a queued delivery: agent.prompt is given no
			// wait on that path, so its reply carries the PRE-submit status and
			// reporting it would say "working" for an agent now waiting on a human.
			if d.FinalStatus != tc.wantStatus {
				t.Fatalf("FinalStatus = %s, want %s", d.FinalStatus, tc.wantStatus)
			}
			if d.Verified != tc.wantVerify {
				t.Fatalf("Verified = %v, want %v", d.Verified, tc.wantVerify)
			}
		})
	}
}

func TestSayWillNotConfirmAQueuedMessageFromACopyAlreadyInTheBox(t *testing.T) {
	// A queued delivery asks herdr for no acknowledgement (promptWaitFor), so the
	// box read-back is the only evidence there is — and on its own it cannot tell
	// the copy that just arrived from an identical one already sitting there.
	//
	// The sequence: "ok" is delivered to a working agent and parks in the composer;
	// the user sends "ok" again; that paste is swallowed with a success return (G3,
	// and with no wait there is no stall gate left to catch it); a plain search of
	// the box finds the FIRST copy and the phone says "✅ Delivered". The message is
	// gone. So the pre-image the separator probe already read is kept, and the
	// needle has to appear more often after the paste than before it.
	p := &fakePane{status: StatusWorking, seq: 2, screen: claudeScreen("  … running tests", "❯ ok")}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "ok")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if !d.Acked {
		t.Fatal("Acked = false; herdr took the text")
	}
	if d.Verified {
		t.Fatalf("Delivery = %+v: the box holds the copy that was ALREADY there, which proves nothing about this one", d)
	}
	// And the same read that refused to confirm it also separated it, so if the
	// paste did land the two are legible rather than merged into "okok".
	if got := p.promptTexts(); len(got) != 1 || got[0] != promptSeparator+"ok" {
		t.Fatalf("prompts = %q, want one %q", got, promptSeparator+"ok")
	}
}

func TestSayWillNotConfirmAQueuedMessageWithNoPreImageToCompare(t *testing.T) {
	// The two halves of the asymmetry in one delivery. The pre-paste read fails, so
	// the separator goes in — an unreadable screen is not an empty box, and a
	// missing separator merges two of the user's messages. The post-paste read then
	// finds the message in the box, and it is still not confirmed: without the
	// pre-image there is nothing to show that this copy is the one that just
	// arrived. One honest "sent but not confirmed" costs a glance at the Mac; a
	// false "delivered" costs the message.
	p := &fakePane{status: StatusWorking, seq: 2, screen: claudeScreen("  … running tests", "❯ carry on")}
	h := newInputHarness(t, p)
	inner := h.client.OnAgentRead
	reads := 0
	h.client.OnAgentRead = func(ctx context.Context, target string, src herdrapi.ReadSource, lines int) (string, error) {
		reads++
		if reads == 1 {
			return "", errors.New("pane read failed")
		}
		return inner(ctx, target, src, lines)
	}

	d, err := h.ctrl.Say(context.Background(), h.guard(), "carry on")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if !d.Acked || !d.Queued {
		t.Fatalf("Delivery = %+v, want acked and queued", d)
	}
	if d.Verified {
		t.Fatalf("Delivery = %+v, want unverified: the box was never seen before the paste", d)
	}
	if got := p.promptTexts(); len(got) != 1 || got[0] != promptSeparator+"carry on" {
		t.Fatalf("prompts = %q, want one %q", got, promptSeparator+"carry on")
	}
}

func TestSayGivesUpWaitingForAnotherDeliveryToTheSamePane(t *testing.T) {
	// The serialisation must not be able to strand a caller. A delivery already in
	// flight holds the pane, and the wait for it ends when the caller's context does
	// — with nothing written, because nothing had been written yet.
	p := &fakePane{status: StatusWorking, seq: 2, screen: claudeScreen("  … running tests", "")}
	h := newInputHarness(t, p)
	c := h.ctrl.(*controller)

	release, err := c.panes.acquire(context.Background(), p.paneID)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := h.ctrl.Say(ctx, h.guard(), "hello"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Say error = %v, want context.Canceled", err)
	}
	h.assertNoInput()
	if n := h.client.Count("agent.get"); n != 0 {
		t.Fatalf("agent.get called %d times; the guard is not even read until the pane is free", n)
	}
}

func TestSayReportsTheEscapeAndTheQueueTogether(t *testing.T) {
	// The combination a user actually sees, and the one no other test covers: the
	// dialog they were looking at is cancelled AND their message is parked unread in
	// the agent's own composer. Both facts are theirs to be told — Escaped because
	// their prose dismissed a question they did not answer (G1, G2), Queued because
	// "it will read this when it finishes" is a different promise from "it is
	// reading this now" (G19/M1).
	p := &fakePane{status: StatusBlocked, seq: 3, escTo: StatusWorking}
	p.screen = claudeScreen("  … resuming work", "")
	p.screenAfterPrompt = claudeScreen("  … resuming work", "❯ keep going then")
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "keep going then")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if !d.Escaped || !d.Queued || !d.Acked || !d.Verified {
		t.Fatalf("Delivery = %+v, want escaped, queued, acked and verified all at once", d)
	}
	if d.FinalStatus != StatusWorking {
		t.Errorf("FinalStatus = %s, want working", d.FinalStatus)
	}
	if keys := p.sentKeys(); len(keys) != 1 || keys[0] != keyEscape {
		t.Fatalf("keys = %v, want exactly one esc", keys)
	}
	methods := h.methods()
	esc, prompt := indexOf(methods, "agent.send_keys"), indexOf(methods, "agent.prompt")
	if esc < 0 || prompt < 0 || esc > prompt {
		t.Fatalf("call sequence = %v, want the esc before the prompt", methods)
	}
}

func TestSayDeliversThroughARealMidTurnComposer(t *testing.T) {
	// Everything the working path does rests on one thing that used to be assumed:
	// that a claude which is mid-turn hands back a screen with a locatable composer
	// holding the paste. G19's M2/M3 quotes were transcript echoes printed AFTER the
	// turn ended, so they were evidence about the glue, not about the box.
	//
	// workingClaudeScreen is that screen, captured while agent_status was `working`
	// on both sides of the read. Its composer is two bare 118-column rules with one
	// line between them — no `╭─╮` box at all — and the glyph is followed by a
	// NO-BREAK space. Both are exactly the kind of detail a synthetic screen gets
	// wrong in the direction that hides a bug.
	tests := []struct {
		name string
		// text defaults to "also fix the flaky one".
		text     string
		before   string
		after    string
		wantBody string
		wantEcho bool
	}{
		{
			name:     "an untouched composer takes the text as it is",
			before:   workingClaudeScreen(realWorkingComposer("")),
			after:    workingClaudeScreen(realWorkingComposer("also fix the flaky one")),
			wantBody: "also fix the flaky one",
			wantEcho: true,
		},
		{
			// The short-message rule meets the real glyph. A needle this short has
			// to BE the composer line rather than appear inside it, so the line has
			// to reduce to exactly "ok" — which it only does because the NO-BREAK
			// space after the glyph is whitespace to unicode.IsSpace. "ok", "no",
			// "yes" and "go" are what a phone sends, so this is the common case.
			name:     "a two-letter message against the real glyph and its no-break space",
			text:     "ok",
			before:   workingClaudeScreen(realWorkingComposer("")),
			after:    workingClaudeScreen(realWorkingComposer("ok")),
			wantBody: "ok",
			wantEcho: true,
		},
		{
			// The M2 case on the real screen: the box already holds a message this
			// turn has not consumed, so the paste is separated from it.
			name:     "a composer already holding a queued message gets a separator",
			before:   workingClaudeScreen(realWorkingComposer("MIDTURN-PROBE-ONE")),
			after:    workingClaudeScreen(realWorkingComposer("MIDTURN-PROBE-ONE")),
			wantBody: promptSeparator + "also fix the flaky one",
			// Unchanged box: the delivery is honestly unconfirmed rather than
			// confirmed from the copy that was already there.
			wantEcho: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			text := tc.text
			if text == "" {
				text = "also fix the flaky one"
			}
			p := &fakePane{status: StatusWorking, seq: 2, screen: tc.before, screenAfterPrompt: tc.after}
			h := newInputHarness(t, p)

			d, err := h.ctrl.Say(context.Background(), h.guard(), text)
			if err != nil {
				t.Fatalf("Say: %v — a working claude's own screen must not refuse a delivery", err)
			}
			if !d.Acked || !d.Queued {
				t.Fatalf("Delivery = %+v, want acked and queued", d)
			}
			// The footer of a working claude reads `⏸ manual mode on · ? for
			// shortcuts · ← for agents`. If preflight's dialog check ever fired on
			// that, every message to every busy agent would come back "answer the
			// card" — the delivery above is what proves it does not.
			if d.MayHaveAnsweredADialog {
				t.Fatalf("Delivery = %+v: an ordinary working screen was read as a dialog", d)
			}
			if got := p.promptTexts(); len(got) != 1 || got[0] != tc.wantBody {
				t.Fatalf("prompts = %q, want [%q]", got, tc.wantBody)
			}
			if d.Verified != tc.wantEcho {
				t.Fatalf("Verified = %v, want %v", d.Verified, tc.wantEcho)
			}
		})
	}
}

func TestSayRefusesAnAgentThatIsStillLaunching(t *testing.T) {
	// A managed agent herdr has not finished starting cannot take text: herdr
	// itself answers agent_not_ready (src/app/api/agents.rs:86). Saying so before
	// any bytes are written keeps it a sentinel the caller can park a message on,
	// which is the one case where queueing above this layer IS right.
	p := &fakePane{status: StatusIdle, seq: 2, launchPending: true}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "hello")
	if !errors.Is(err, ErrAgentBusy) {
		t.Fatalf("Say error = %v, want ErrAgentBusy", err)
	}
	h.assertNoInput()
	if d.Acked {
		t.Fatalf("Delivery = %+v, want nothing claimed", d)
	}
}

func TestSayDeliversToAnAgentThatIsNotInteractiveReady(t *testing.T) {
	// interactive_ready is true only for an agent herdr launched itself and has
	// marked Active (src/terminal/state.rs:1928). Every agent in v1 is one the
	// user started in their own pane, so it reports false — gating prose on it
	// would refuse every real delivery. This test is here so nobody adds that
	// guard on the strength of the field's name.
	p := &fakePane{status: StatusIdle, seq: 2, screen: claudeScreen("> hello", ""), promptStatus: string(StatusWorking)}
	h := newInputHarness(t, p)

	d, err := h.ctrl.Say(context.Background(), h.guard(), "hello")
	if err != nil {
		t.Fatalf("Say: %v", err)
	}
	if !d.Acked {
		t.Fatalf("Delivery = %+v, want acked", d)
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
	// No read-back: there is nothing to look for. Reads still happen BEFORE each
	// attempt — that is the input-box probe — so the assertion is that the last
	// thing this Say did was fail to prompt, not that it never read.
	methods := h.methods()
	if last := methods[len(methods)-1]; last != "agent.prompt" {
		t.Fatalf("last call = %q, want agent.prompt: nothing is verified after giving up", last)
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
	// esc is a side effect that outlives the error: the caller may park the
	// message and re-send later, but the dialog the human was looking at is
	// already gone, so "nothing happened" would be a lie.
	//
	// escTo is an unmappable status rather than `working`: working is now
	// delivered to (G19/M1) and so no longer produces a post-esc failure to
	// report. Any refusal after the esc exercises the same escNote path.
	p := &fakePane{status: StatusBlocked, seq: 3, escTo: Status("restarting")}
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

func TestSayVerifiesInTheRegionTheStatusMakesMeaningful(t *testing.T) {
	// G19, third corollary — the reversal that is easy to get wrong. Excluding
	// the input box is correct for a settled agent (G4: ghost completions live
	// there, so a match proves nothing) and exactly inverted for a working one,
	// where the text SITS in the box until the turn ends and that is the only
	// evidence there is.
	//
	// The asymmetry is not symmetric, and a live run is why. A SETTLED agent has
	// already consumed its box, so a match there is a ghost and only the
	// transcript counts. A QUEUED delivery can be proven in EITHER half: the text
	// may still be pending in the box, or the agent's turn may have ended in the
	// milliseconds since the paste, in which case it has already been submitted
	// and moved to the transcript. This case originally expected false, on the
	// premise that a working agent has not consumed the box yet — a snapshot
	// assumption that expires almost immediately. Measured: a short message to a
	// working claude was submitted and answered before the verification read, the
	// box came back empty, and a landed delivery was reported unproven.
	//
	// Every case has a before and an after: the message has to ARRIVE, because a
	// copy already present before the paste proves nothing about this one
	// (see TestSayWillNotConfirmAQueuedMessageFromACopyAlreadyInTheBox).
	const text = "deploy to staging"
	tests := []struct {
		name   string
		status Status
		before string
		after  string
		want   bool
	}{
		{
			name:   "working: in the input box",
			status: StatusWorking,
			before: claudeScreen("  … still running the migration", ""),
			after:  claudeScreen("  … still running the migration", "❯ deploy to staging"),
			want:   true,
		},
		{
			// The turn ended between the paste and the read, so the agent has
			// already submitted what was pending. Still proof, and refusing it
			// puts a warning on the phone for a message that plainly landed.
			name:   "working: already consumed into the transcript",
			status: StatusWorking,
			before: claudeScreen("  … still running the migration", ""),
			after:  claudeScreen("> deploy to staging", ""),
			want:   true,
		},
		{
			name:   "settled: outside the box",
			status: StatusIdle,
			before: claudeScreen("  something unrelated", "❯ some ghost suggestion"),
			after:  claudeScreen("> deploy to staging", "❯ some ghost suggestion"),
			want:   true,
		},
		{
			name:   "settled: in the input box only",
			status: StatusIdle,
			before: claudeScreen("  something unrelated", ""),
			after:  claudeScreen("  something unrelated", "❯ deploy to staging"),
			want:   false,
		},
		{
			// No box to look in, and for a working submission there is nowhere
			// else that would mean anything.
			name:   "working: nothing on screen at all",
			status: StatusWorking,
			before: "",
			after:  "",
			want:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePane{status: tc.status, seq: 2, screen: tc.before, screenAfterPrompt: tc.after}
			if tc.status == StatusIdle {
				p.promptStatus = string(StatusIdle)
			}
			h := newInputHarness(t, p)

			d, err := h.ctrl.Say(context.Background(), h.guard(), text)
			if err != nil {
				t.Fatalf("Say: %v", err)
			}
			if !d.Acked {
				t.Fatalf("Delivery = %+v, want acked", d)
			}
			if d.Verified != tc.want {
				t.Fatalf("Verified = %v, want %v for screen:\n%s", d.Verified, tc.want, tc.after)
			}
		})
	}
}

// realCodexScreen renders the bottom of a screen captured from a live codex
// 0.147 — internal/screen/testdata/codex-settled.txt, verbatim — with only the
// newest transcript entry and the composer substituted.
//
// Measured 2026-08-15 against the live herdr 0.8.0 / protocol 19. What matters
// about it, and what no synthesised screen was saying (G21):
//
//   - there is no box. codex draws `› ` at the left margin and nothing else, so
//     the rule pair InputBoxRange looks for does not exist on this screen.
//   - codex quotes the user's own messages back with the SAME `› ` glyph the
//     composer uses, three blank-separated lines above it.
//   - an empty composer is not an empty line, it is `› Use /skills to list
//     available skills`.
func realCodexScreen(transcript, composer string) string {
	return strings.Join([]string{
		"• 测试D完成。",
		"",
		"",
		transcript,
		"",
		"",
		"• Working (0s • esc to interrupt)",
		"",
		"",
		"› " + composer,
		"",
		"  gpt-5.6-sol high · ~/code/yuebanhome",
		"",
	}, "\n")
}

// realCodexQueuedScreen is internal/screen/testdata/codex-queued.txt: what codex
// does with a message submitted while it is mid-turn. It does NOT hold it in the
// composer the way claude does — it parks it in the transcript under a notice,
// prefixed with `↳`.
func realCodexQueuedScreen(queued string) string {
	return strings.Join([]string{
		"• 测试D完成。",
		"",
		"",
		"› 这是一条自动化测试消息E。",
		"",
		"",
		"• Working (2s • esc to interrupt)",
		"",
		"• Messages to be submitted after next tool call (press esc to interrupt and send immediately)",
		"  ↳ " + queued,
		"",
		"› Use /skills to list available skills",
		"",
		"  gpt-5.6-sol high · ~/code/yuebanhome",
		"",
	}, "\n")
}

// TestSayVerifiesADeliveryToCodex is the regression for the bug that put
// "⚠️ Sent to codex … but not confirmed" on the phone after EVERY message,
// including the ones codex had visibly received and already answered.
//
// codex has no bordered composer (G21), so InputBoxRange found no rule pair and
// fell back to "the last 5 non-blank lines" — a region that on a codex screen
// reaches up past `• Working` and over the user's own echoed message, which for
// a delivery into a settled agent is the only proof there is. The delivery
// landed, the warning went out anyway, and the user was told to go and look at
// a Mac that had nothing wrong with it.
//
// The two halves are tested together on purpose: making the transcript half
// pass is easy if the composer stops being excluded, and that trade would be
// far worse — an unsubmitted paste read back as proof (G3) loses the message
// silently.
func TestSayVerifiesADeliveryToCodex(t *testing.T) {
	const text = "把测试结果发给我"
	tests := []struct {
		name   string
		text   string // defaults to text
		status Status
		before string
		after  string
		want   bool
	}{
		{
			// The bug, from the screen it was measured on.
			name:   "settled: echoed into the transcript",
			status: StatusIdle,
			before: realCodexScreen("› 上一条消息", "Use /skills to list available skills"),
			after:  realCodexScreen("› "+text, "Use /skills to list available skills"),
			want:   true,
		},
		{
			// The guard that must survive the fix: herdr acked the paste but the
			// TUI never submitted it, so it is sitting in the composer. That is
			// exactly the case the warning exists for.
			name:   "settled: sitting unsubmitted in the composer",
			status: StatusIdle,
			before: realCodexScreen("› 上一条消息", "Use /skills to list available skills"),
			after:  realCodexScreen("› 上一条消息", text),
			want:   false,
		},
		{
			// Mid-turn: codex parks the text in the transcript under `↳`, not in
			// the composer, so the box half finds nothing and the transcript half
			// has to carry it.
			name:   "working: parked in the queue notice",
			status: StatusWorking,
			before: realCodexScreen("› 这是一条自动化测试消息E。", "Use /skills to list available skills"),
			after:  realCodexQueuedScreen(text),
			want:   true,
		},
		{
			// The same, short enough to hit the whole-line rule. `↳ 好的` is not
			// `好的` until the marker is trimmed, and "ok"/"好的" is most of what
			// a phone ever sends.
			name:   "working: a short message parked in the queue notice",
			text:   "好的",
			status: StatusWorking,
			before: realCodexScreen("› 这是一条自动化测试消息E。", "Use /skills to list available skills"),
			after:  realCodexQueuedScreen("好的"),
			want:   true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body := tc.text
			if body == "" {
				body = text
			}
			p := &fakePane{status: tc.status, seq: 2, screen: tc.before, screenAfterPrompt: tc.after}
			if tc.status == StatusIdle {
				p.promptStatus = string(StatusIdle)
			}
			h := newInputHarness(t, p)

			d, err := h.ctrl.Say(context.Background(), h.guard(), body)
			if err != nil {
				t.Fatalf("Say: %v", err)
			}
			if !d.Acked {
				t.Fatalf("Delivery = %+v, want acked", d)
			}
			if d.Verified != tc.want {
				t.Fatalf("Verified = %v, want %v for screen:\n%s", d.Verified, tc.want, tc.after)
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
	// they would all pass if the reads were deleted outright. Two of them per
	// delivery: the input-box probe that decides whether a separator is needed
	// (G19/M2) before the paste, and the read-back that verifies it after.
	if n := h.client.Count("agent.read"); n != 2 {
		t.Fatalf("agent.read called %d times, want 2 (input-box probe, then read-back)", n)
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

// A phone sends "ok", "yes", "好". The short-needle rule — match a whole line,
// not a substring — exists because a search over a whole SCREEN matches by
// coincidence ("no" inside "I found nothing to do here."). Inside the input box
// that premise fails: the haystack is the line we just pasted into, it reads
// "❯ ok" rather than "ok", and the in-box branch already rules out coincidence
// by requiring the hit count to have grown. Measured live: before this, every
// short message to a working agent reported itself unproven and the phone got a
// warning for a delivery that had plainly landed.
func TestShortQueuedMessagesAreVerifiableInsideTheInputBox(t *testing.T) {
	box := func(content string) []string {
		return []string{
			"⏺ some earlier output",
			"────────────────────────────────",
			"❯ " + content,
			"────────────────────────────────",
			"  ⏸ manual mode on",
		}
	}
	pre := boxProbe{read: true, lines: box("")}

	for _, needle := range []string{"ok", "no", "yes", "好"} {
		t.Run(needle, func(t *testing.T) {
			if !verifyEcho(box(needle), true, needle, true, pre) {
				t.Errorf("a queued %q in the composer was not recognised", needle)
			}
		})
	}

	// The protection that replaces the whole-line rule: text already present
	// before the delivery proves nothing, however short it is.
	t.Run("already there proves nothing", func(t *testing.T) {
		was := boxProbe{read: true, lines: box("ok")}
		if verifyEcho(box("ok"), true, "ok", true, was) {
			t.Error("an unchanged composer was accepted as proof of a new delivery")
		}
	})

	// And outside the box the coincidence risk is real, so the rule stays.
	t.Run("outside the box keeps the strict rule", func(t *testing.T) {
		screenLines := []string{"⏺ I found nothing to do here.", "✻ Baked for 2s"}
		if verifyEcho(screenLines, true, "no", false, boxProbe{}) {
			t.Error(`"no" matched inside "nothing" on the transcript half`)
		}
	})
}
