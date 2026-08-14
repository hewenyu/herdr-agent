package agents

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
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
// A caller that gets an error back cannot assume nothing happened: when the
// agent was blocked, Say has already sent esc, so the dialog the human was
// looking at may be cancelled even though the message was not delivered. Every
// error raised after that point says so in its text. A queueing layer must tell
// the user rather than silently retrying later, because by then the question
// they were answering is gone from the screen.
func (c *controller) Say(ctx context.Context, g Guard, text string) (Delivery, error) {
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

	if cur.Status == StatusWorking {
		// Not our decision: whether to queue the message or interrupt the agent
		// belongs to the layer that knows what the human is trying to do.
		return fail(cur.Status, fmt.Errorf("agents: %s: %w", paneID, ErrAgentBusy))
	}

	cur, err = c.waitSettle(ctx, paneID)
	if err != nil {
		return fail(cur.Status, err)
	}
	// The agent can have moved while we were waiting for it to hold still.
	switch {
	case cur.Status == StatusBlocked:
		return fail(StatusBlocked,
			fmt.Errorf("agents: %s went blocked while settling: %w", paneID, ErrCannotUnblock))
	case !cur.Status.Settled():
		// Prompt only from idle or done (S1 §3.4.3). An unrecognised status is
		// refused for the same reason as `working`: we cannot show that the TUI
		// is in a state where pasted text is text rather than a menu selection.
		return fail(cur.Status,
			fmt.Errorf("agents: %s is %s, not accepting prose: %w", paneID, cur.Status, ErrAgentBusy))
	}

	d, err := c.deliverPrompt(ctx, paneID, text, cur.Status)
	d.Escaped = escaped
	if err != nil {
		// Not fail(): d carries the attempt count, which is exactly what the
		// caller needs to explain a prompt that never landed.
		return d, escNote(err)
	}

	// Read-back is the second half of the acknowledgement. Acked && !Verified
	// is reported as-is: it means the text reached herdr but we could not find
	// it on screen, which the caller must show as "sent but not confirmed".
	d.Verified = c.verifyEcho(ctx, paneID, text)
	return d, nil
}

// deliverPrompt submits text, retrying while herdr says it stalled.
//
// agent_prompt_stalled is the one error that means the text is definitely NOT
// in the agent (G3, S1 §3.4.4): herdr submitted it and then failed to observe
// any state change within the wait window. Every other error is ambiguous and
// is returned untouched — retrying an ambiguous failure risks saying the same
// thing to the agent twice.
//
// Every retry re-establishes the precondition first. A stall means up to eight
// seconds passed with the agent visibly doing nothing, and the back-off adds
// more; in that window the desktop user, or a hook, can put the agent into a
// permission dialog. Pasting prose into one is an approval (G1), which is the
// one outcome S1 §4 item 4 vetoes outright, so an agent that is no longer
// settled ends the attempt instead of receiving the text.
func (c *controller) deliverPrompt(ctx context.Context, paneID, text string, before Status) (Delivery, error) {
	wait := &herdrapi.PromptWait{Until: promptUntil(), TimeoutMs: promptTimeout()}
	d := Delivery{FinalStatus: before}
	from := before

	for attempt := 1; ; attempt++ {
		if attempt > 1 {
			// waitSettle rather than a bare get: a prompt sent right after a
			// state change is swallowed anyway (G3), so the retry needs the
			// quiet as much as it needs the answer.
			cur, err := c.waitSettle(ctx, paneID)
			if err != nil {
				return d, err
			}
			d.FinalStatus = cur.Status
			from = cur.Status
			switch {
			case cur.Status == StatusBlocked:
				return d, fmt.Errorf("agents: %s went blocked before retry %d: %w", paneID, attempt, ErrCannotUnblock)
			case !cur.Status.Settled():
				return d, fmt.Errorf("agents: %s is %s before retry %d, not accepting prose: %w",
					paneID, cur.Status, attempt, ErrAgentBusy)
			}
		}

		d.Attempts = attempt
		info, err := c.client.AgentPrompt(ctx, paneID, text, wait)
		if err == nil {
			d.Acked = true
			d.FinalStatus = c.statusAfterPrompt(ctx, paneID, info, from)
			return d, nil
		}
		if !errors.Is(err, herdrapi.ErrPromptStalled) {
			return d, fmt.Errorf("agents: prompt %s: %w", paneID, err)
		}
		if attempt >= promptAttempts {
			return d, fmt.Errorf("agents: prompt %s: not delivered after %d attempts: %w", paneID, attempt, err)
		}
		if err := c.pause(ctx, promptBackoff(attempt)); err != nil {
			return d, err
		}
	}
}

func promptTimeout() *uint64 {
	ms := promptWaitTimeoutMs
	return &ms
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

// verifyEcho looks for text on the visible screen, outside the input box.
//
// Excluding the input box is not tidiness, it is the whole check. Claude
// renders ghost completion suggestions inside its composer — measured (G4): a
// line reading `❯ Reply with exactly the single word MARKER4 and nothing else.`
// appeared on screen having never been sent, and pane.read returns it as
// ordinary text. Grepping the whole screen would therefore confirm delivery of
// a message the agent never received.
//
// A false negative here costs one honest "sent but not confirmed"; a false
// positive loses the user's message silently, so every ambiguity resolves to
// false.
//
// Short messages get a stricter test, because a substring search for them
// matches by coincidence: `Say(g, "no")` against a screen reading "I found
// nothing to do here." would otherwise report the message as confirmed. "no",
// "ok", "yes" and "go" are exactly what a phone sends.
func (c *controller) verifyEcho(ctx context.Context, paneID, text string) bool {
	needle := normalizeEcho(text)
	if needle == "" {
		return false
	}
	raw, err := c.client.AgentRead(ctx, paneID, herdrapi.SourceVisible, readWholeBuffer)
	if err != nil {
		return false
	}
	lines := strings.Split(raw, "\n")
	start, end, ok := screen.InputBoxRange(lines)

	// A needle long enough to be unambiguous is searched across the whole
	// screen joined together, because a message wide enough to wrap is split
	// across lines by the terminal. A short one cannot wrap, so it is matched
	// against one line at a time and must BE that line rather than appear
	// somewhere inside it.
	short := utf8.RuneCountInString(needle) < distinctiveEchoRunes

	var b strings.Builder
	for i, line := range lines {
		if ok && i >= start && i < end {
			continue
		}
		norm := normalizeEcho(line)
		if !short {
			b.WriteString(norm)
			continue
		}
		if trimEchoMarkers(norm) == needle {
			return true
		}
	}
	if short {
		return false
	}
	return strings.Contains(b.String(), needle)
}

// distinctiveEchoRunes is the length at which a normalized message stops being
// something an agent might print by accident. Below it, verification demands a
// whole line.
const distinctiveEchoRunes = 8

// trimEchoMarkers removes the leading glyphs a TUI puts in front of the user's
// own words when it quotes them back — claude renders a sent message as
// `> text`, codex as `▌ text` — so that a whole-line comparison is comparing
// the message and not the decoration. Box drawing and whitespace are already
// gone by the time this runs.
func trimEchoMarkers(s string) string {
	return strings.TrimLeft(s, ">❯›»•·▌▏|*-")
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
