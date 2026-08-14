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
	ErrAgentBusy       = errors.New("agent is working")
	ErrCannotUnblock   = errors.New("agent stayed blocked after escape")
	ErrKeyNotAllowed   = errors.New("key not in allowlist")
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
