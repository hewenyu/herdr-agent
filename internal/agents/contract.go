// Package agents owns the agent registry (who is running, in what state) and
// the safe input protocol (how a human answer reaches an agent without ever
// becoming an accidental approval).
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package agents

import (
	"context"
	"errors"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// ---------- state ----------

type Status string

const (
	StatusIdle    Status = "idle"
	StatusWorking Status = "working"
	StatusBlocked Status = "blocked"
	// StatusDone is idle-and-not-yet-seen-by-the-desktop-UI. It is derived by
	// herdr and does not depend on any screen regex, which makes it the most
	// reliable notification trigger we have (G11).
	StatusDone    Status = "done"
	StatusUnknown Status = "unknown"
	// StatusGone is synthesised by the Registry when an agent disappears.
	StatusGone Status = "gone"
)

// Settled reports whether the agent is waiting for a new instruction.
// idle and done are the same agent condition; they differ only in whether the
// desktop UI has looked at it (G11).
func (s Status) Settled() bool { return s == StatusIdle || s == StatusDone }

// Agent is the bridge's view of one coding agent.
// The key is PaneID. TerminalID is deliberately absent: it is not stable
// across a herdr restart (G10).
type Agent struct {
	PaneID      string
	WorkspaceID string
	TabID       string
	Kind        string // "claude" | "codex" | ...; empty if not yet detected
	Status      Status
	Cwd         string
	Title       string // terminal_title_stripped
	SessionRef  *herdrapi.SessionRef
	StateSeq    uint64
	Interactive bool
	LaunchPend  bool
	SeenAt      time.Time
}

// Transition is emitted when an agent's status or state sequence changes.
type Transition struct {
	Agent Agent
	From  Status
	To    Status
	Seq   uint64
	At    time.Time
}

// ---------- registry ----------

// Registry polls herdr and publishes transitions.
//
// v1 polls agent.list rather than using events.subscribe: that subscription
// requires a concrete pane_id with no wildcard, the event ring is 512 entries
// with silent overflow, and reconnects replay from sequence 0 (G10). herdr's
// own detection loop ticks at 300ms, so 1s polling loses at most a second.
type Registry interface {
	// Run blocks until ctx is cancelled.
	Run(ctx context.Context) error
	Snapshot() []Agent
	Get(paneID string) (Agent, bool)
	// Subscribe returns a channel of transitions. Slow consumers drop events
	// rather than blocking the poller; the channel is closed when Run returns.
	Subscribe() <-chan Transition
	// Degraded reports whether the last poll failed (herdr server down).
	Degraded() bool
}

// DefaultPollInterval is how often the registry calls agent.list.
const DefaultPollInterval = 1000 * time.Millisecond

// ---------- safe input ----------

// Guard pins an input to the exact agent state the human was looking at when
// they decided. Every input carries one. This is what stops a card sitting in
// chat history for three days from injecting a keystroke into a pane that has
// since moved on (G17).
type Guard struct {
	PaneID   string
	Kind     string
	StateSeq uint64
	IssuedAt time.Time
}

// MaxGuardAge rejects decisions made against a stale view.
const MaxGuardAge = 10 * time.Minute

var (
	ErrPaneGone        = errors.New("pane no longer exists")
	ErrAgentReplaced   = errors.New("a different agent now occupies this pane")
	ErrGuardStale      = errors.New("guard issued too long ago")
	ErrNoLongerBlocked = errors.New("agent is no longer waiting for input")
	// ErrAgentBusy no longer means "the agent is working, try later": prose to a
	// working agent is delivered (G19/M1), so this is now the refusal for the
	// states that genuinely cannot take text — a status herdr reported that we
	// cannot map, a managed agent whose launch is still pending, and a retry
	// after a stall into an agent that is no longer settled (where a second
	// submission would risk saying the same thing twice). Its message text is
	// left alone because callers already match on the sentinel.
	ErrAgentBusy     = errors.New("agent is working")
	ErrCannotUnblock = errors.New("agent stayed blocked after escape")
	ErrKeyNotAllowed = errors.New("key not in allowlist")

	// ErrDialogOnScreen means the screen read immediately before the paste
	// carried the markers herdr's own detector matches for a permission dialog
	// (G11), whatever agent.get said the status was. Nothing was written.
	//
	// It is the G11 false negative caught from the other side: herdr's claude
	// detector is a literal match that silently reports `idle` when it fails
	// (src/detect/manifest.rs:527-542), and pasting prose at a menu approves the
	// command the prose was refusing (G1). Errors carrying it also wrap
	// ErrCannotUnblock, because the user-facing consequence is the same one —
	// there is a dialog to answer and the message was not sent — and callers
	// already match on that sentinel.
	ErrDialogOnScreen = errors.New("a permission dialog is on screen")
)

// Delivery reports honestly what happened to a prompt.
//
// Acked && !Verified must be surfaced to the user as "sent but not confirmed".
// It must never be reported as success (G3).
type Delivery struct {
	Acked       bool
	Verified    bool
	Attempts    int
	FinalStatus Status
	// Escaped records that the agent was blocked and Say cancelled the pending
	// dialog before submitting the text. The user must be told: their message
	// did something they did not type — it dismissed a permission prompt that
	// was waiting on them. Reporting only "delivered" hides a consequential
	// side effect (G1).
	Escaped bool

	// Queued records that the agent was working when the text was submitted, so
	// the text is parked in the AGENT's own input queue rather than being acted
	// on: it sits in the input box and is submitted as a prompt when the current
	// turn ends (G19/M1). Delivered, not started — and the caller phrases its
	// reply differently, because "it will read this when it finishes" is a
	// different promise from "it is reading this now".
	//
	// It also records which region proved the delivery: for a queued message the
	// evidence is inside the input box, for every other one it is outside (G19,
	// third corollary).
	Queued bool

	// MayHaveAnsweredADialog records that a queued delivery was made into an
	// agent that is showing a permission dialog now.
	//
	// It exists because delivering to a working agent carries a G1 exposure that
	// can be narrowed but not closed. agent.prompt writes a bracketed paste and
	// then a lone Enter 300ms later; that Enter is herdr's, we cannot observe or
	// cancel it, and if the working agent puts up `Do you want to proceed? ❯ 1.
	// Yes` inside that window the Enter selects the highlighted default. Say
	// re-reads the status and the screen immediately before the paste and refuses
	// when a dialog is already up (ErrDialogOnScreen), which is as narrow as this
	// gets from outside herdr.
	//
	// So this flag is a disclosure, not a detection: a dialog on screen after the
	// write means one was up during it. The inverse does not clear the delivery —
	// an Enter that DID answer a dialog leaves the agent working, which looks
	// exactly like an agent that simply went on working. A caller must say that
	// the message may have answered a question the user never saw, the same way
	// Escaped says a question was cancelled.
	//
	// Never set for a submission into a settled agent: an idle agent has no turn
	// running and cannot raise a dialog on its own, so a dialog after that write
	// is the one the user's own prompt caused.
	MayHaveAnsweredADialog bool
}

// AllowedKeys is the complete set of keys that may be sent to an agent.
// Anything outside this set is rejected rather than escaped or guessed.
var AllowedKeys = []string{
	"1", "2", "3", "4", "5", "6", "7", "8", "9",
	"y", "n", "enter", "esc", "up", "down", "tab",
}

// Controller performs guarded input against agents.
type Controller interface {
	// SendKey answers a menu. Requires the agent to still be blocked at the
	// guard's StateSeq. Never used for prose.
	SendKey(ctx context.Context, g Guard, key string) (Agent, error)

	// Say delivers human prose.
	//
	// If the agent is blocked, Say sends esc FIRST and waits for it to settle.
	// Sending prose to a blocked agent without doing so silently approves the
	// pending dialog, because agent.prompt pastes the text (which the menu
	// discards) and then presses Enter, selecting the highlighted default (G1).
	//
	// If the agent is working, Say delivers anyway and reports Delivery.Queued:
	// the agent has its own input queue and holds the text until the current turn
	// ends (G19/M1). It is not refused and not held back here — a bridge-side
	// queue in front of the agent's own queue is what made a user's second and
	// third sentences sit undelivered.
	//
	// Concurrent Says for the SAME pane are serialised inside the implementation,
	// so callers need no lock of their own. They must not rely on ordering: a
	// delivery is a screen read plus a paste that depends on it, and serialising
	// is what keeps two messages from merging into a third neither of them said
	// (G19/M2), not what decides which of two racing sentences goes first.
	Say(ctx context.Context, g Guard, text string) (Delivery, error)

	// Interrupt sends esc and nothing else.
	Interrupt(ctx context.Context, g Guard) (Agent, error)
}

// ---------- transcript ----------

// ResolveTranscript maps an agent to its native transcript file.
//
// ok is false when the agent has no session ref yet. That is a normal
// intermediate state, not an error: for claude the ref only appears after the
// trust-directory prompt is accepted and SessionStart fires (G8).
type TranscriptResolver interface {
	Resolve(a Agent) (path string, ok bool)
}
