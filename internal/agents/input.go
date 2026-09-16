package agents

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// SettleDelay is the pause between a keystroke and the read-back that reports
// the new state (S1 §3.4.2).
//
// A menu answer is a discrete event, so this is a fixed pause rather than
// waitSettle: herdr's own detector ticks at 300ms, and three seconds is long
// enough for the TUI to repaint, the detector to re-run and agent.get to tell
// the truth about where the agent ended up.
const SettleDelay = 3 * time.Second

const (
	// settlePollInterval is how often waitSettle re-reads agent.get.
	settlePollInterval = 250 * time.Millisecond

	// settleStableFor is how long the status must hold still before the agent
	// counts as settled. Measured (G3): a prompt sent immediately after `esc`
	// or after agent.start is swallowed silently — herdr still reports success,
	// because all it promises is that the bytes reached the PTY queue — while
	// the same prompt one second of quiet later lands.
	settleStableFor = time.Second

	// settleMaxWait bounds waitSettle. An agent that is genuinely churning
	// (working, printing) will never hold still, and blocking forever behind it
	// would strand the human who is waiting on the other end of the phone.
	// Hitting the cap is not an error: the caller re-checks the status it got
	// back and decides.
	settleMaxWait = 10 * time.Second
)

// promptWaitTimeoutMs is the window agent.prompt is given to observe a state
// change before it answers agent_prompt_stalled (S1 §3.4.3). It is longer than
// herdr's own 5s default because the reply is our only delivery evidence: a
// timeout that fires early turns a delivered prompt into a retry, and a retry
// says the same thing to the agent twice.
const promptWaitTimeoutMs uint64 = 8000

// promptAttempts is how many agent.prompt calls Say makes before giving up:
// the first, plus three retries (S1 §3.4.3).
const promptAttempts = 4

// workingEchoDelay is the pause between submitting to a working agent and
// reading its input box back.
//
// A submission to a working agent gets no acknowledgement from herdr (see
// promptWaitFor), so agent.prompt returns as soon as the bytes are queued to the
// PTY — before the TUI has drawn them. Reading immediately would find an empty
// box and report every queued message as unconfirmed. One second is well past
// herdr's own 300ms submit delay and its 300ms detector tick, and it is spent
// only on this path.
const workingEchoDelay = time.Second

// promptSeparator is put in front of text that would otherwise be glued to
// whatever the input box already holds.
//
// Measured (G19/M2): two prompts sent during one working turn arrived as ONE
// message with nothing between them — `QUEUED-ONEQUEUED-TWO` — because
// agent.prompt's Enter does not submit while the agent is busy, so the next
// paste lands on the tail of the same input line. That is data corruption, not
// cosmetics: "yes" followed by "no" becomes "yesno". A leading newline inside
// the bracketed paste separates them correctly (G19/M3).
//
// A newline is all this package sends. It does NOT send Enter to push the
// pending text through: when the input box is consumed is the agent's decision,
// and an Enter aimed at a TUI mid-turn is exactly how a written refusal
// approved the command it was refusing (G1).
const promptSeparator = "\n"

// dialogMarkers are the literal strings herdr's own claude detector matches to
// decide an agent is blocked (G11, src/detect/manifests/claude.toml). All three
// are on the captured screen of a real permission dialog
// (internal/screen/testdata/claude-173.txt: line 22 and the hint on line 31).
//
// They are matched against the screen with whitespace removed, because the
// question itself wraps: at 53 columns the same dialog renders as
//
//	Do you want to
//	proceed?
//
// (internal/screen/testdata/claude-53.txt:19-20), and a line-by-line literal
// match is exactly how herdr's own detector goes silently false-negative and
// reports `idle` for a pane with a menu on it (G11, G5).
//
// The bias is deliberate and one-sided. A false positive refuses one delivery and
// tells the user to answer the dialog — noise. A false negative pastes prose at a
// menu and lets herdr's Enter select `❯ 1. Yes`, which is the measured G1
// approval and the one outcome that is vetoed outright. So text an agent merely
// PRINTED that reads like a dialog costs a refusal, and that is the right way
// round.
var dialogMarkers = []string{
	"do you want to proceed?",
	"↑/↓ to navigate",
	"esc to cancel",
}

// keyEscape is the one key this package sends on its own initiative. Measured
// (G2): esc dismisses a permission dialog without answering it — the file the
// dialog was asking about is not created and the agent returns to idle.
const keyEscape = "esc"

// herdr error codes that all mean "there is no agent at this target".
//
// Measured against the running herdr 0.8.0 / protocol 19:
//
//	{"id":"probe-1","method":"agent.get","params":{"target":"w9:p99"}}
//	{"id":"probe-1","error":{"code":"agent_not_found",
//	                         "message":"agent target w9:p99 not found"}}
//
// That is TerminalTargetError::NotFound (src/app/agents.rs:293), which agent.get
// also returns for a pane whose agent has exited, because the pane branch of
// resolve_agent_target only resolves a target that still IS an agent. The pane
// APIs answer pane_not_found for the same condition (src/app/api/panes.rs:47).
//
// Mapping all of them onto ErrPaneGone is what makes S1 §3.4.1 check 1 fire in
// production: S2 retires a card only for ErrPaneGone, and any other error is
// indistinguishable from a herdr outage — which it must keep retrying.
const (
	codeAgentNotFound = "agent_not_found"
	codePaneNotFound  = "pane_not_found"
)

// clockSkewTolerance is how far into the future a Guard may claim to have been
// issued before it is rejected as stale.
//
// A guard dated ahead of now is not a fresh decision, it is a broken clock: an
// IssuedAt accidentally written in milliseconds lands in the year 55000 and
// would leave every card in Feishu history permanently armed (G17), and a
// backwards wall-clock step would revalidate every stale card at once. The
// tolerance only absorbs the jitter between building a card and the callback
// coming back.
const clockSkewTolerance = 30 * time.Second

// readWholeBuffer asks herdr for everything it has. No read here ever names a
// line count: only source=recent can trigger the 15s synthetic-scroll injection
// into the user's live pane (G9), and it is bounded by the line count, so
// never carrying one means no later edit can reintroduce that path by accident.
const readWholeBuffer = 0

// promptUntil is the set of states that count as "the agent reacted", used as
// the delivery acknowledgement for agent.prompt (S1 §3.4.4).
//
// It is built per call rather than kept in a package var so that nothing can
// mutate the list the next Say depends on.
func promptUntil() []string {
	return []string{
		string(StatusWorking),
		string(StatusBlocked),
		string(StatusIdle),
		string(StatusDone),
	}
}

// acceptsProse reports whether prose may be submitted to an agent in this state.
//
// `working` is in the set, and that is the change G19 forced. Measured (M1):
// agent.prompt to a working claude SUCCEEDS — the agent has its own input queue,
// the text lands in its input box and is submitted as a prompt when the current
// turn ends. Nothing is lost and nothing errors. S1 §3.4.3 said to refuse it
// with ErrAgentBusy and let the caller queue, and that queued at the wrong
// layer: the agent already has a queue, so a second one in front of it only
// meant a user who typed three sentences watched the bridge sit on two of them.
//
// Nothing else is relaxed. An unrecognised status is still refused, because we
// cannot show that pasted text would be treated as text rather than as a menu
// selection (G1). blocked and working are different problems: blocked is a menu
// that will misread the text, working is an agent that will queue it correctly.
//
// `blocked` DOES reach this predicate, and answering false is not the whole
// defence. Say escapes a blocked agent first and gives up if the dialog stayed
// up, but the status this is called with is an observation, and an agent that is
// working right now is one whose next transition is most often `blocked`. The
// window between the last observation and the paste is closed as far as it can
// be by preflight, which re-reads BOTH the status and the screen immediately
// before the write; what is left of it is disclosed in
// Delivery.MayHaveAnsweredADialog rather than pretended away.
func acceptsProse(s Status) bool {
	return s.Settled() || s == StatusWorking
}

// promptBackoff is the pause before retry n (1-based): 1s, 2s, 4s.
func promptBackoff(retry int) time.Duration {
	if retry < 1 {
		return 0
	}
	return time.Duration(1<<(retry-1)) * time.Second
}

// ControllerOption configures a Controller.
type ControllerOption func(*controller)

// WithInputClock injects the time source used for guard ages and settle
// timing. A nil function is ignored.
//
// It is not called WithClock only because that name already belongs to the
// registry's option in this package.
func WithInputClock(now func() time.Time) ControllerOption {
	return func(c *controller) {
		if now != nil {
			c.now = now
		}
	}
}

// WithSettleDelay overrides SettleDelay for SendKey and Interrupt. Values <= 0
// are ignored.
func WithSettleDelay(d time.Duration) ControllerOption {
	return func(c *controller) {
		if d > 0 {
			c.settleDelay = d
		}
	}
}

func withInputWaiter(w waitFunc) ControllerOption {
	return func(c *controller) {
		if w != nil {
			c.wait = w
		}
	}
}

// controller is the guarded input path. Everything a human types or taps
// reaches an agent through here, and every entry point starts with a guard
// check, because the alternative — a keystroke aimed at whatever happens to be
// in that pane now — is a command execution (G16, G17).
type controller struct {
	client      herdrapi.Client
	now         func() time.Time
	wait        waitFunc
	settleDelay time.Duration

	// panes serialises Say per pane. See paneLocks.
	panes paneLocks
}

// paneLocks gives each pane one slot, so that only one Say at a time can be in
// flight against it.
//
// The corruption this prevents is measured (G19/M2). A delivery is a screen read
// followed by a paste whose body depends on what that read found; the pair is not
// atomic and cannot be made atomic through this API. Two of them interleaved read
// the same empty composer, both paste unprefixed, and the box ends up holding
// `QUEUED-ONEQUEUED-TWO` — "yes" followed by "no" submitted as "yesno".
//
// It has to live here because the inbound path is concurrent by construction: the
// larksuite SDK runs a goroutine per inbound WebSocket frame (ws/client.go:554),
// so two Feishu messages a second apart reach Say for the same pane at the same
// time. Until prose was delivered to working agents this was impossible by
// accident — a working agent answered ErrAgentBusy and every actual delivery went
// out from the bridge's single drain goroutine — and that accident is what the
// working path routes around.
//
// What this does NOT provide is ordering. Two sentences racing into the bridge
// were already at the mercy of goroutine scheduling and a lock does not pick a
// winner; it guarantees only that whichever goes second SEES the first and
// separates itself from it. A garbled merge is data loss, a swapped pair is
// legible.
//
// Keys are deliberately not serialised through here. A menu answer must not queue
// behind a Say that is backing off through its retries, and a key is a single
// write with no read it depends on. Two menu answers are kept apart by the guard
// instead: the second carries a state_change_seq the agent has left, and
// validateGuard refuses it (G17).
type paneLocks struct {
	mu sync.Mutex
	// held is one buffered slot per pane. Entries are never removed: pane ids are
	// stable and few (G10), so the map is bounded by the machine rather than by
	// traffic.
	held map[string]chan struct{}
}

// acquire blocks until this pane is free, or until ctx is done. The returned
// release must be called exactly once.
func (l *paneLocks) acquire(ctx context.Context, paneID string) (func(), error) {
	l.mu.Lock()
	if l.held == nil {
		l.held = map[string]chan struct{}{}
	}
	slot, ok := l.held[paneID]
	if !ok {
		slot = make(chan struct{}, 1)
		l.held[paneID] = slot
	}
	l.mu.Unlock()

	select {
	case slot <- struct{}{}:
		return func() { <-slot }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

var _ Controller = (*controller)(nil)

// NewController returns a Controller that drives agents through c.
func NewController(c herdrapi.Client, opts ...ControllerOption) (Controller, error) {
	if c == nil {
		return nil, ErrNoClient
	}
	ct := &controller{
		client:      c,
		now:         time.Now,
		wait:        sleepWait,
		settleDelay: SettleDelay,
	}
	for _, opt := range opts {
		opt(ct)
	}
	return ct, nil
}

// ---------- guard ----------

// validateGuard re-reads the agent and checks the decision the human made
// against the agent as it is right now (S1 §3.4.1). The checks run in order:
//
//  1. the pane still has an agent          -> ErrPaneGone
//  2. it is still the same kind of agent   -> ErrAgentReplaced
//  3. the guard is not older than MaxGuardAge -> ErrGuardStale
//  4. for menu answers: still blocked, at the very same state_change_seq
//     -> ErrNoLongerBlocked
//
// Check 4 is the one that disarms the card sitting in chat history. Feishu
// messages never expire; tapping `1 Yes` on a three-day-old card delivers that
// keystroke to whatever the pane is doing today, where it lands in the input
// box as `❯ 1` at best and answers a different dialog at worst (G17).
//
// The returned Agent is the fresh state and is filled in even when the error is
// non-nil, so a caller can tell the user what the agent is doing instead.
func (c *controller) validateGuard(ctx context.Context, g Guard, requireBlocked bool) (Agent, error) {
	cur, err := c.get(ctx, g.PaneID)
	if err != nil {
		if errors.Is(err, ErrPaneGone) {
			// Synthesised rather than zero-valued: callers render this state.
			gone := Agent{PaneID: g.PaneID, Kind: g.Kind, Status: StatusGone, SeenAt: c.now()}
			return gone, fmt.Errorf("agents: guard for %s: %w", g.PaneID, ErrPaneGone)
		}
		return Agent{PaneID: g.PaneID, Kind: g.Kind, Status: StatusUnknown, SeenAt: c.now()}, err
	}

	if cur.PaneID != g.PaneID {
		// herdr resolves an agent target by pane id OR, when the pane branch
		// does not resolve to an agent, by agent NAME
		// (src/app/terminal_targets.rs:75-101) — and an agent can be renamed to
		// any string at all. A guard for a dead pane can therefore come back
		// holding a different terminal, and the Kind check below would not
		// catch it when both are claude.
		//
		// The answer describes a stranger, so it is not handed back: the caller
		// is told about the pane it asked for, which is gone as far as this
		// guard is concerned.
		gone := Agent{PaneID: g.PaneID, Kind: g.Kind, Status: StatusGone, SeenAt: c.now()}
		return gone, fmt.Errorf("agents: guard for %s: herdr resolved it to %s: %w",
			g.PaneID, cur.PaneID, ErrPaneGone)
	}

	if cur.Kind != g.Kind {
		// Covers the empty case in both directions: a pane whose agent exited
		// reports no kind at all, and a guard cut before detection finished
		// carries none. Either way the thing on the other end is not what the
		// human was looking at.
		return cur, fmt.Errorf("agents: guard for %s: was %q, now %q: %w",
			g.PaneID, g.Kind, cur.Kind, ErrAgentReplaced)
	}

	// Both ends of the window are checked. A guard from the future is rejected
	// too: cards.Decision carries IssuedAt as unix seconds, so a value written
	// in milliseconds by mistake reads as the year 55000 and would make an
	// unbounded age check pass forever (G17).
	switch age := c.now().Sub(g.IssuedAt); {
	case age > MaxGuardAge:
		return cur, fmt.Errorf("agents: guard for %s: issued %s ago, limit %s: %w",
			g.PaneID, age.Round(time.Second), MaxGuardAge, ErrGuardStale)
	case age < -clockSkewTolerance:
		return cur, fmt.Errorf("agents: guard for %s: issued %s in the future, tolerance %s: %w",
			g.PaneID, (-age).Round(time.Second), clockSkewTolerance, ErrGuardStale)
	}

	if requireBlocked && (cur.Status != StatusBlocked || cur.StateSeq != g.StateSeq) {
		return cur, fmt.Errorf("agents: guard for %s: decided at %s/seq %d, now %s/seq %d: %w",
			g.PaneID, StatusBlocked, g.StateSeq, cur.Status, cur.StateSeq, ErrNoLongerBlocked)
	}

	return cur, nil
}

// get reads one agent, mapping every "no such agent" code onto ErrPaneGone.
func (c *controller) get(ctx context.Context, paneID string) (Agent, error) {
	info, err := c.client.AgentGet(ctx, paneID)
	if err != nil {
		for _, code := range []string{codeAgentNotFound, codePaneNotFound, herdrapi.CodeNotFound} {
			if herdrapi.IsCode(err, code) {
				return Agent{}, fmt.Errorf("%w: %s", ErrPaneGone, paneID)
			}
		}
		return Agent{}, fmt.Errorf("agents: agent.get %s: %w", paneID, err)
	}
	if info.PaneID == "" {
		// herdr answered, but with nothing addressable in it. pane_id is the
		// only key we can route on (G10); without one there is no agent here.
		return Agent{}, fmt.Errorf("%w: %s", ErrPaneGone, paneID)
	}
	a := fromWire(info)
	a.SeenAt = c.now()
	return a, nil
}

// ---------- keys ----------

// SendKey answers a menu.
//
// The key must be one of AllowedKeys. Anything else is rejected outright: this
// package never escapes, translates or guesses at a key, because the failure
// mode of guessing wrong is a keystroke executing something in a live agent.
func (c *controller) SendKey(ctx context.Context, g Guard, key string) (Agent, error) {
	cur, err := c.validateGuard(ctx, g, true)
	if err != nil {
		return cur, err
	}
	if !slices.Contains(AllowedKeys, key) {
		return cur, fmt.Errorf("agents: %q: %w", key, ErrKeyNotAllowed)
	}
	return c.deliverKey(ctx, cur, key)
}

// Interrupt sends esc and nothing else.
//
// It does not require the agent to be blocked: esc is also how a human cancels
// an agent that is off doing the wrong thing, and requiring `blocked` would
// make the escape hatch available exactly when it is least needed. The guard is
// still checked, so the esc cannot land in a pane that has moved on (G17).
func (c *controller) Interrupt(ctx context.Context, g Guard) (Agent, error) {
	cur, err := c.validateGuard(ctx, g, false)
	if err != nil {
		return cur, err
	}
	return c.deliverKey(ctx, cur, keyEscape)
}

// deliverKey writes one key and reports the state it produced.
func (c *controller) deliverKey(ctx context.Context, cur Agent, key string) (Agent, error) {
	// agent.send_keys, never pane.send_keys: herdr writes the whole key list in
	// a single write, where pane.send_keys issues one syscall per key. Against
	// a TUI that is reading a menu, a key split across writes is a key that can
	// interleave with a repaint.
	if err := c.client.AgentSendKeys(ctx, cur.PaneID, []string{key}); err != nil {
		return cur, fmt.Errorf("agents: send key %q to %s: %w", key, cur.PaneID, err)
	}
	if err := c.pause(ctx, c.settleDelay); err != nil {
		return cur, fmt.Errorf("agents: key %q delivered to %s, then: %w", key, cur.PaneID, err)
	}
	next, err := c.get(ctx, cur.PaneID)
	if err != nil {
		// The key is already in the agent. Say so, so that nobody retries it.
		return cur, fmt.Errorf("agents: key %q delivered to %s but reading its state back failed: %w",
			key, cur.PaneID, err)
	}
	return next, nil
}

// ---------- settle ----------

// waitSettle polls agent.get every settlePollInterval until the status has
// held still for settleStableFor, giving up after settleMaxWait.
//
// It exists because agent.prompt's return value is not delivery (G3): a prompt
// sent while the TUI is mid-transition is dropped on the floor and reported as
// success. Waiting for quiet is what makes the next prompt land.
//
// Reaching the cap is not an error. The agent it returns is the last one
// observed, and the caller decides whether that state can be prompted.
func (c *controller) waitSettle(ctx context.Context, paneID string) (Agent, error) {
	start := c.now()
	cur, err := c.get(ctx, paneID)
	if err != nil {
		return cur, err
	}
	stableSince := c.now()
	for {
		if c.now().Sub(stableSince) >= settleStableFor {
			return cur, nil
		}
		if c.now().Sub(start) >= settleMaxWait {
			return cur, nil
		}
		if err := c.pause(ctx, settlePollInterval); err != nil {
			return cur, err
		}
		next, err := c.get(ctx, paneID)
		if err != nil {
			return cur, err
		}
		// Only the status resets the clock. state_change_seq also moves for
		// changes that are not the transition we are waiting out, and treating
		// every bump as unrest would make a chatty agent look like it never
		// settles.
		if next.Status != cur.Status {
			stableSince = c.now()
		}
		cur = next
	}
}

// pause blocks for d, returning the context's error if it was cancelled first.
func (c *controller) pause(ctx context.Context, d time.Duration) error {
	if c.wait(ctx, d) {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return context.Canceled
}

// ---------- prose ----------

// Say delivers human prose. This is the safety-critical path.
//
// The blocked branch is the whole reason this package exists. Measured (G1):
// `herdr agent prompt <pane> "absolutely not, do NOT run this command"` against
// a Claude permission dialog CREATED the file it was refusing. agent.prompt is
// a bracketed paste followed 300ms later by a lone Enter; a permission dialog
// is a menu, not a text field, so the paste is discarded and the Enter selects
// the highlighted default — `❯ 1. Yes`. An explicit written refusal is
// therefore an approval. esc first, always (G2).
//
// A working agent, by contrast, is delivered to (G19/M1): it has its own input
// queue, and the text lands in its input box to be submitted as a prompt when
// the current turn ends. Three things follow, all handled below — the text is
// separated from whatever the box already holds (promptSeparator), delivery is
// verified INSIDE the box rather than outside it (verifyEcho), and the G1 risk
// does not vanish just because the status was not `blocked`.
//
// That last one is the honest part. A working agent is one turn away from a
// permission dialog, and agent.prompt's trailing Enter is herdr's: it goes in
// 300ms after the paste and we can neither observe nor cancel it. preflight
// re-reads the status AND the screen with nothing between them and the write, and
// refuses if a dialog is up either way; what remains is a bounded window that is
// disclosed in Delivery.MayHaveAnsweredADialog. Delivering to a working agent is
// therefore narrowed and declared, not proven safe — which is a different claim
// from the blocked path, where the answer is simply "not while that menu is up".
//
// A caller that gets an error back cannot assume nothing happened: when the
// agent was blocked, Say has already sent esc, so the dialog the human was
// looking at may be cancelled even though the message was not delivered. Every
// error raised after that point says so in its text. A queueing layer must tell
// the user rather than silently retrying later, because by then the question
// they were answering is gone from the screen.
func (c *controller) Say(ctx context.Context, g Guard, text string) (Delivery, error) {
	// One delivery at a time per pane, for the whole of it: the input-box read and
	// the paste whose body depends on it must not interleave with another
	// delivery's pair (G19/M2, paneLocks).
	//
	// Keyed on the guard's pane id, which is the only pane this call can write to:
	// validateGuard proves that the agent herdr answered about IS that pane and
	// refuses everything else, so the lock cannot end up guarding a different
	// terminal than the one written to.
	release, err := c.panes.acquire(ctx, g.PaneID)
	if err != nil {
		return Delivery{FinalStatus: StatusUnknown},
			fmt.Errorf("agents: waiting for another delivery to %s to finish: %w", g.PaneID, err)
	}
	defer release()

	// requireBlocked is false: prose is legitimate for an agent that is merely
	// idle, and a blocked one is handled below rather than refused.
	cur, err := c.validateGuard(ctx, g, false)
	if err != nil {
		return Delivery{FinalStatus: cur.Status}, err
	}
	// Write to the pane the guard was validated against, not to the string the
	// guard carries: validateGuard has just proved they are the same pane, and
	// keeping one source for both entry points means they can never disagree
	// about which terminal they addressed.
	paneID := cur.PaneID

	// escaped records the one side effect that outlives a failure below. It is
	// reported twice on purpose: in Delivery.Escaped for callers that render a
	// result, and in the error text for callers that only see a failure. The
	// user typed prose and also, without asking, dismissed a dialog that was
	// waiting on them; neither path may hide that.
	escaped := false
	escNote := func(err error) error {
		if !escaped {
			return err
		}
		return fmt.Errorf("esc was delivered to %s first, so a pending dialog may already be cancelled: %w",
			paneID, err)
	}
	fail := func(status Status, err error) (Delivery, error) {
		return Delivery{FinalStatus: status, Escaped: escaped}, escNote(err)
	}

	if cur.Status == StatusBlocked {
		if g.RequireUnblocked {
			return fail(StatusBlocked, fmt.Errorf("agents: %s is waiting for human approval: %w", paneID, ErrCannotUnblock))
		}
		if err := c.client.AgentSendKeys(ctx, paneID, []string{keyEscape}); err != nil {
			return Delivery{FinalStatus: StatusBlocked},
				fmt.Errorf("agents: escape %s before prompting: %w", paneID, err)
		}
		escaped = true
		cur, err = c.waitSettle(ctx, paneID)
		if err != nil {
			return fail(cur.Status, err)
		}
		if cur.Status == StatusBlocked {
			// Do not prompt and do not escape again. Another esc might answer
			// a second dialog behind the first, and a prompt here is G1.
			return fail(StatusBlocked, fmt.Errorf("agents: %s: %w", paneID, ErrCannotUnblock))
		}
	}

	// A working agent is NOT refused here any more (G19/M1); it goes through the
	// same wait-for-quiet as everyone else and is then delivered to. Waiting for
	// quiet is about not prompting across a transition (G3) and says nothing
	// about whether the agent is mid-turn: an agent that goes on steadily working
	// holds its status still for the required second and is prompted right after,
	// which is the point — the user's second sentence must not sit here waiting
	// for the turn to end.
	cur, err = c.waitSettle(ctx, paneID)
	if err != nil {
		return fail(cur.Status, err)
	}
	// The agent can have moved while we were waiting for it to hold still.
	switch {
	case cur.Status == StatusBlocked:
		return fail(StatusBlocked,
			fmt.Errorf("agents: %s went blocked while settling: %w", paneID, ErrCannotUnblock))
	case cur.LaunchPend:
		// herdr answers agent_not_ready for a prompt to a managed agent whose
		// launch is still pending (src/app/api/agents.rs:86). Refusing it here,
		// before any bytes are written, turns that opaque transport error into
		// the sentinel a caller can park a message on and retry — which is what
		// a queue is actually for.
		//
		// Agent.Interactive is deliberately NOT checked alongside it.
		// interactive_ready is true only for an agent herdr launched itself and
		// has marked Active (src/terminal/state.rs:1928 via
		// src/app/agents.rs:390), so an agent the user started in their own pane
		// — which in v1 is every agent — reports false, and gating on it would
		// refuse all prose to every real agent.
		return fail(cur.Status,
			fmt.Errorf("agents: %s is still launching, not accepting prose: %w", paneID, ErrAgentBusy))
	case !acceptsProse(cur.Status):
		// An unrecognised status is refused because we cannot show that the TUI
		// is in a state where pasted text is text rather than a menu selection.
		return fail(cur.Status,
			fmt.Errorf("agents: %s is %s, not accepting prose: %w", paneID, cur.Status, ErrAgentBusy))
	}

	d, preImage, err := c.deliverPrompt(ctx, paneID, text, cur.Status)
	d.Escaped = escaped
	if err != nil {
		// Not fail(): d carries the attempt count, which is exactly what the
		// caller needs to explain a prompt that never landed.
		return d, escNote(err)
	}

	if d.Queued {
		// The paste is in the PTY queue, not yet on the screen, and this path has
		// no wait to have covered the gap. Let the TUI draw before looking. The
		// error is dropped on purpose: the text is already in the agent, so a
		// cancelled context here costs the verification, not the delivery, and
		// the reads below will fail on their own and report the honest
		// Acked && !Verified.
		_ = c.pause(ctx, workingEchoDelay)

		// The one status read this path has. Without it FinalStatus would be the
		// state we submitted INTO — agent.prompt answers with no wait here, so its
		// reply carries the pre-submit status and statusAfterPrompt maps it
		// straight through — and a delivery that landed in an agent which has
		// since put up a permission dialog would be reported as "working".
		if a, err := c.get(ctx, paneID); err == nil {
			d.FinalStatus = a.Status
			if a.Status == StatusBlocked {
				// A dialog is up now, so one was up while herdr's own trailing
				// Enter went in — unobservable to us, and the measured way a
				// written refusal approves a command (G1). Disclosed rather than
				// claimed either way: see Delivery.MayHaveAnsweredADialog.
				d.MayHaveAnsweredADialog = true
			}
		}
	}

	// Read-back is the second half of the acknowledgement. Acked && !Verified
	// is reported as-is: it means the text reached herdr but we could not find
	// it on screen, which the caller must show as "sent but not confirmed".
	post, postRead := c.readLines(ctx, paneID)
	d.Verified = verifyEcho(post, postRead, text, d.Queued, preImage)

	if d.Queued && postRead && screenShowsDialog(post) {
		// The same disclosure from the screen instead of the status, because
		// herdr's blocked detection is a literal match that reports `idle` when it
		// fails (G11) — and this read is already paid for.
		d.MayHaveAnsweredADialog = true
	}
	return d, nil
}

// deliverPrompt submits text, retrying while herdr says it stalled.
//
// agent_prompt_stalled is the only error worth retrying (G3, S1 §3.4.4), and it
// is weaker evidence than it looks: it means herdr submitted the paste and then
// observed NO state change within the wait window. That is not proof the text is
// absent — a paste that landed in a composer the agent has not consumed yet
// changes no state at all — so a retry can be a second copy of the same
// sentence. It is bounded at promptAttempts, and the per-attempt input-box read
// is what keeps a duplicate legible: the second copy is separated from the first
// instead of being glued to its tail (G19/M2). Every other error is ambiguous in
// the same direction and is returned untouched rather than retried.
//
// Every attempt re-establishes the precondition immediately before writing, in
// preflight. A stall means up to eight seconds passed with the agent visibly
// doing nothing and the back-off adds more; in that window the desktop user, or a
// hook, can put the agent into a permission dialog. Pasting prose into one is an
// approval (G1), which is the one outcome S1 §4 item 4 vetoes outright.
//
// The retry is stricter than the first attempt: the first delivers to a working
// agent (G19/M1), a retry does not.
//
// It returns the input box as it stood immediately before the paste that was
// accepted, because that is the only thing that can tell a fresh copy of the
// message from one that was already sitting there (verifyEcho).
func (c *controller) deliverPrompt(ctx context.Context, paneID, text string, before Status) (Delivery, boxProbe, error) {
	d := Delivery{FinalStatus: before}
	from := before
	var box boxProbe

	for attempt := 1; ; attempt++ {
		if attempt > 1 {
			// waitSettle rather than a bare get: a prompt sent right after a
			// state change is swallowed anyway (G3), so the retry needs the
			// quiet as much as it needs the answer.
			cur, err := c.waitSettle(ctx, paneID)
			if err != nil {
				return d, box, err
			}
			d.FinalStatus = cur.Status
			from = cur.Status
			switch {
			case cur.Status == StatusBlocked:
				return d, box, fmt.Errorf("agents: %s went blocked before retry %d: %w", paneID, attempt, ErrCannotUnblock)
			case !cur.Status.Settled():
				// Note this is stricter than the first attempt, which delivers to
				// a working agent (G19/M1). A retry is a second copy of the same
				// sentence: herdr said the first one stalled, but a stall is only
				// "no state change observed", and an agent that has since started
				// working may have taken the text after all. Saying it twice is
				// worse than saying it late, so the retry waits for the caller.
				return d, box, fmt.Errorf("agents: %s is %s before retry %d, not accepting prose: %w",
					paneID, cur.Status, attempt, ErrAgentBusy)
			}
		}

		d.Attempts = attempt

		// The last look before the write, per attempt, as late as possible: one
		// screen read and one status read, with nothing between them and the paste.
		// Both are re-done per attempt because a retry runs seconds later and
		// because a stalled attempt is precisely an attempt whose text may be
		// sitting unsubmitted in the composer — retrying without looking again
		// would glue the message to its own first copy (G19/M2).
		//
		// accepts is what this attempt may submit into: everything acceptsProse
		// allows on the first, settled only on a retry.
		accepts := acceptsProse
		if attempt > 1 {
			accepts = Status.Settled
		}
		probe, atWrite, err := c.preflight(ctx, paneID, from, accepts)
		if err != nil {
			d.FinalStatus = atWrite
			return d, box, err
		}
		// from now describes the state we are actually writing into, which is what
		// picks the acknowledgement to ask for and whether this counts as queued.
		box, from = probe, atWrite
		d.FinalStatus = from

		body := text
		if box.holdsText {
			body = promptSeparator + text
		}
		info, err := c.client.AgentPrompt(ctx, paneID, body, promptWaitFor(from))
		if err == nil {
			d.Acked = true
			// Recorded from the state we submitted INTO, not the one observed
			// after: a working agent was mid-turn, so the text is parked in its
			// own queue rather than being worked on, and the caller phrases its
			// reply differently. It also selects the region the read-back
			// trusts (verifyEcho).
			d.Queued = from == StatusWorking
			d.FinalStatus = c.statusAfterPrompt(ctx, paneID, info, from)
			return d, box, nil
		}
		if !errors.Is(err, herdrapi.ErrPromptStalled) {
			return d, box, fmt.Errorf("agents: prompt %s: %w", paneID, err)
		}
		if attempt >= promptAttempts {
			return d, box, fmt.Errorf("agents: prompt %s: not delivered after %d attempts: %w", paneID, attempt, err)
		}
		if err := c.pause(ctx, promptBackoff(attempt)); err != nil {
			return d, box, err
		}
	}
}

// preflight is the last look at the agent before a paste, and the one that has to
// be trusted: everything observed earlier is at least one round trip old.
//
// It reads the screen once and the status once, in that order, so the status —
// the check that decides whether text may be written at all — is the freshest
// thing before the write.
//
// The screen is read anyway (the composer decides whether a separator is needed),
// so it is also checked for the markers herdr's own detector matches for a
// permission dialog (dialogMarkers). That catches the case agent.get cannot: a
// literal-match miss makes herdr report `idle` for a pane with a menu on it
// (G11), and prose pasted at a menu is discarded while the Enter that follows it
// selects `❯ 1. Yes` (G1). Nothing has been written when this refuses.
//
// What it cannot do is close the window. herdr's trailing Enter goes in 300ms
// after the paste, we can neither see nor cancel it, and a working agent can put
// up a dialog inside that window. That residual exposure is bounded, narrowed
// here, and disclosed in Delivery.MayHaveAnsweredADialog — not eliminated.
func (c *controller) preflight(ctx context.Context, paneID string, from Status, accepts func(Status) bool) (boxProbe, Status, error) {
	probe := c.probeBox(ctx, paneID)
	if probe.dialog {
		// Wraps both sentinels: ErrDialogOnScreen names what was seen, and
		// ErrCannotUnblock is what a caller already renders — there is a dialog to
		// answer and the message was not sent.
		return probe, from, fmt.Errorf("agents: %s has a permission dialog on screen, not pasting prose at it: %w: %w",
			paneID, ErrDialogOnScreen, ErrCannotUnblock)
	}
	cur, err := c.get(ctx, paneID)
	if err != nil {
		// Not "assume it is still fine": the observation this call exists to
		// refresh is the one that authorises writing into a live TUI.
		return probe, from, err
	}
	switch {
	case cur.Status == StatusBlocked:
		// No second esc. Say already sent one if the agent was blocked when it
		// started, and another might answer a different dialog behind the first.
		return probe, cur.Status, fmt.Errorf("agents: %s went blocked before the paste: %w", paneID, ErrCannotUnblock)
	case !accepts(cur.Status):
		return probe, cur.Status, fmt.Errorf("agents: %s is %s at the moment of writing, not accepting prose: %w",
			paneID, cur.Status, ErrAgentBusy)
	}
	return probe, cur.Status, nil
}

func promptTimeout() *uint64 {
	ms := promptWaitTimeoutMs
	return &ms
}

// promptWaitFor picks the acknowledgement to ask for, given the state the text
// is being submitted into.
//
// For a settled agent the wait IS the acknowledgement (G3): herdr requires an
// observed state change within its effect window and answers
// agent_prompt_stalled when none arrives. That is the only failure worth
// retrying — though not proof of absence, see deliverPrompt: an agent that took
// the text into a composer it has not consumed changes no state either.
//
// For a working agent there is no such acknowledgement to be had, so none is
// asked for. herdr skips the stalled gate entirely when submission starts from
// `working` (src/api/wait.rs:232, and its own CLI help says as much) and falls
// through to a settled-state wait that only matches once state_change_seq moves
// past the submission — which for an agent that goes on working it does not.
// That wait would burn the whole timeout and then answer `timeout`, an error
// this package cannot distinguish from a real failure, so a delivery that
// measurably DID land (G19/M1) would be reported as a failed one and re-sent by
// the layer above. Evidence for this path comes from reading the input box back
// instead, which is where the text demonstrably sits.
func promptWaitFor(from Status) *herdrapi.PromptWait {
	if from == StatusWorking {
		return nil
	}
	return &herdrapi.PromptWait{Until: promptUntil(), TimeoutMs: promptTimeout()}
}

// boxProbe is one screen read taken immediately before a paste, and everything
// that read is used for.
type boxProbe struct {
	// read is false when the screen could not be read at all. It is not the same
	// as an empty box, and the two are used in opposite directions: an unreadable
	// screen gets a separator it may not have needed, and it cannot verify
	// anything at all afterwards.
	read bool

	// dialog reports the markers herdr's own detector matches for a permission
	// dialog (dialogMarkers). Set means: do not write.
	dialog bool

	// lines is the input box exactly as read, borders included, or nil when no box
	// could be located. It is the pre-image verifyEcho compares against, which is
	// what tells a copy that just arrived from an identical one that was already
	// sitting there.
	lines []string

	// all is the whole screen as read, not just the box. A queued delivery can
	// be proven in either half: the text may still be pending in the box, or the
	// agent may have finished its turn and already consumed it into the
	// transcript. Measured: a short message to a working claude was submitted
	// and answered before the verification read happened, so a box-only search
	// found nothing and reported a delivery that had plainly landed as unproven.
	all []string

	// holdsText is whether anything in the box would be glued to the paste.
	//
	// Every ambiguity resolves to true, which is the opposite bias from verifyEcho
	// and for the same reason — the costs are not symmetric. A separator nobody
	// needed costs one blank line at the top of a prompt; a separator that was
	// needed and missing costs the user's words, silently, by merging two messages
	// into a third one neither of them said. So a screen that cannot be read, and
	// a box whose contents are only Claude's own placeholder or a ghost completion
	// (G4), all count as holding text.
	holdsText bool
}

// probeBox takes that read.
func (c *controller) probeBox(ctx context.Context, paneID string) boxProbe {
	lines, ok := c.readLines(ctx, paneID)
	if !ok {
		// A screen we cannot see is not a screen we may call empty.
		return boxProbe{holdsText: true}
	}
	p := boxProbe{read: true, dialog: screenShowsDialog(lines), all: lines}
	start, end, found := screen.InputBoxRange(lines)
	if !found {
		// Nothing non-blank anywhere on screen: there is no box, so there is
		// nothing for the paste to be appended to.
		return p
	}
	p.lines = lines[start:end]
	for _, line := range p.lines {
		// Borders, the prompt glyph and the indentation are chrome, not content.
		if trimEchoMarkers(normalizeEcho(line)) != "" {
			p.holdsText = true
			break
		}
	}
	return p
}

// readLines reads the visible viewport and splits it. ok is false when herdr
// could not answer, which is never evidence about what is on the screen — every
// caller decides for itself which way that ambiguity falls.
func (c *controller) readLines(ctx context.Context, paneID string) ([]string, bool) {
	raw, err := c.client.AgentRead(ctx, paneID, herdrapi.SourceVisible, readWholeBuffer)
	if err != nil {
		return nil, false
	}
	return strings.Split(raw, "\n"), true
}

// screenShowsDialog reports whether the screen carries a permission dialog.
//
// The whole screen is joined with its whitespace removed before matching, which
// is what makes a wrapped question match: on a 53-column pane the same dialog
// reads `Do you want to` / `proceed?` across two lines (G5), and matching line by
// line there is how herdr's own detector goes false-negative and calls the pane
// idle (G11). Joining can in principle manufacture a match across two unrelated
// lines; that costs a refusal, and the alternative costs an approval nobody
// typed (G1).
func screenShowsDialog(lines []string) bool {
	var b strings.Builder
	for _, line := range lines {
		b.WriteString(normalizeEcho(line))
	}
	haystack := strings.ToLower(b.String())
	for _, marker := range dialogMarkers {
		if strings.Contains(haystack, strings.ToLower(normalizeEcho(marker))) {
			return true
		}
	}
	return false
}

// statusAfterPrompt prefers the state agent.prompt's wait observed, and only
// spends another round trip when herdr answered with a status we cannot map.
func (c *controller) statusAfterPrompt(ctx context.Context, paneID string, info herdrapi.AgentInfo, before Status) Status {
	if st := statusFromWire(info.AgentStatus); st != StatusUnknown {
		return st
	}
	if a, err := c.get(ctx, paneID); err == nil {
		return a.Status
	}
	return before
}

// ---------- read-back ----------

// verifyEcho looks for text on the visible screen, in the one region that can
// prove delivery for the state the text was submitted into.
//
// inBox selects that region, and the two halves are exact opposites on purpose:
//
//   - Submitted to a SETTLED agent: the agent took the text and echoed it into
//     its transcript, so the proof is OUTSIDE the input box, and a match inside
//     the box proves nothing. Claude renders ghost completion suggestions in its
//     composer — measured (G4): a line reading `❯ Reply with exactly the single
//     word MARKER4 and nothing else.` appeared on screen having never been sent,
//     and pane.read returns it as ordinary text. Grepping the whole screen would
//     therefore confirm delivery of a message the agent never received.
//
//   - Submitted to a WORKING agent: the agent is mid-turn, so the text SITS in
//     the input box until the turn ends (G19/M1) and does not reach the
//     transcript while we are looking. The box is then the only place a match
//     means anything. The ghost-completion argument does not carry over: a ghost
//     is the agent's own suggestion, and what we are looking for is a specific
//     sentence a human wrote seconds ago.
//
// So the input box is simultaneously the one place a match proves nothing and
// the only place it proves anything, depending on the state observed at
// submission. Do not "fix" either half towards the other: excluding the box for
// a working submission reports every queued message as unconfirmed, and
// searching it for a settled one is the false positive G4 describes.
//
// The box half needs one thing the transcript half does not: a pre-image. A
// queued message asks herdr for no acknowledgement at all (promptWaitFor), so
// this read is the ONLY evidence, and a box that already held an identical copy
// would confirm a paste that was swallowed (G3) — "ok" sent twice, the second one
// silently lost, the phone saying it was delivered. So preImage is the box as it
// stood immediately before this paste, and the needle has to appear MORE often now
// than it did then. The transcript half keeps herdr's stalled gate as independent
// corroboration and needs no such comparison.
//
// A false negative costs one honest "sent but not confirmed"; a false positive
// loses the user's message silently, so every ambiguity resolves to false — a
// working submission whose box cannot be located, a screen that cannot be read
// either before or after, all of it.
//
// Short messages get a stricter test, because a substring search for them
// matches by coincidence: `Say(g, "no")` against a screen reading "I found
// nothing to do here." would otherwise report the message as confirmed. "no",
// "ok", "yes" and "go" are exactly what a phone sends.
func verifyEcho(lines []string, read bool, text string, inBox bool, preImage boxProbe) bool {
	needle := normalizeEcho(text)
	if needle == "" || !read {
		return false
	}
	region, ok := echoRegion(lines, inBox)
	if !ok {
		return false
	}

	// A needle long enough to be unambiguous is searched across the whole
	// region joined together, because a message wide enough to wrap is split
	// across lines by the terminal. A short one cannot wrap, so it is matched
	// against one line at a time and must BE that line rather than appear
	// somewhere inside it.
	// The short-needle rule exists because a substring search over a whole
	// SCREEN matches by coincidence — "no" inside "I found nothing to do here."
	// Inside the input box that premise does not hold: the haystack is the one
	// or two lines we just pasted into, and the in-box branch below already
	// requires the hit count to have GROWN, which is what rules out coincidence
	// there. Keeping the rule would break exactly the messages a phone sends
	// most: the box line reads "❯ ok", which is not equal to "ok", so every
	// short queued delivery would report itself unproven.
	short := !inBox && utf8.RuneCountInString(needle) < distinctiveEchoRunes
	hits := echoHits(region, needle, short)
	if !inBox {
		return hits > 0
	}
	if !preImage.read {
		// No pre-image, so a match cannot be shown to be new.
		return false
	}
	if hits > echoHits(preImage.lines, needle, short) {
		return true
	}
	// The box is not the only place a queued delivery can be proven. If the
	// agent's turn ended between the paste and this read, it has already
	// SUBMITTED the pending text, which moves it out of the box and into the
	// transcript — measured, and the reason a box-only search called a landed
	// message unproven. The same grown-since-the-pre-image test applies there,
	// with the strict short-needle rule restored because the transcript half is
	// a whole screen again and coincidence is back on the table.
	after, okAfter := echoRegion(lines, false)
	before, okBefore := echoRegion(preImage.all, false)
	if !okAfter || !okBefore {
		return false
	}
	strict := utf8.RuneCountInString(needle) < distinctiveEchoRunes
	return echoHits(after, needle, strict) > echoHits(before, needle, strict)
}

// echoRegion returns the lines that can prove a delivery made into the given
// state, and false when there is no such region on this screen.
func echoRegion(lines []string, inBox bool) ([]string, bool) {
	start, end, ok := screen.InputBoxRange(lines)
	if inBox {
		if !ok {
			return nil, false
		}
		return lines[start:end], true
	}
	if !ok {
		// No box to exclude: whatever is on the screen is transcript.
		return lines, true
	}
	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, lines[end:]...)
	return out, true
}

// echoHits counts the needle in a region under the same rule the caller verifies
// with, so that a before/after comparison compares like with like.
func echoHits(lines []string, needle string, short bool) int {
	if short {
		n := 0
		for _, line := range lines {
			if trimEchoMarkers(normalizeEcho(line)) == needle {
				n++
			}
		}
		return n
	}
	var b strings.Builder
	for _, line := range lines {
		b.WriteString(normalizeEcho(line))
	}
	return strings.Count(b.String(), needle)
}

// distinctiveEchoRunes is the length at which a normalized message stops being
// something an agent might print by accident. Below it, verification demands a
// whole line.
const distinctiveEchoRunes = 8

// trimEchoMarkers removes the leading glyphs a TUI puts in front of the user's
// own words when it quotes them back — claude renders a sent message as
// `> text`, codex as `› text` — so that a whole-line comparison is comparing
// the message and not the decoration. Box drawing and whitespace are already
// gone by the time this runs.
//
// `↳` is here for one specific line: codex parks a message submitted mid-turn
// under `• Messages to be submitted after next tool call` and renders it as
// `↳ text` (G21). That line is the only proof a short queued message arrived,
// and without the trim `↳ok` never equals `ok`, so every "ok" and "好的" sent to
// a working codex reported itself unconfirmed.
func trimEchoMarkers(s string) string {
	return strings.TrimLeft(s, ">❯›»•·▌▏↳|*-")
}

// normalizeEcho reduces a line to the characters that carry the message.
//
// Whitespace goes because the terminal has already re-flowed the text: a
// message wide enough to wrap is split at the pane's width, and the agent
// indents its own quoting of it. Box-drawing characters go because codex frames
// transcript entries, so a wrap inside a frame leaves a `│` in the middle of
// the sentence. What remains matches regardless of how the TUI laid it out.
func normalizeEcho(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
		case r >= 0x2500 && r <= 0x257F: // Box Drawing block
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
