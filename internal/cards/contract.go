// Package cards builds the Feishu interactive cards that let a human take over
// a blocked agent from a phone, and disarms them once used.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package cards

import (
	"errors"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// Button actions.
const (
	// ActKey answers a menu. Single-use, guard-checked, disarms its card.
	ActKey = "key"
	// ActSelect makes an agent the chat's current target, so that plain typing
	// reaches it without a reply or a pane id. It sends nothing to the agent,
	// so it is neither single-use nor guard-checked, and its card stays live.
	ActSelect = "select"
	// ActScreen re-reads and posts the agent's screen. Also inert.
	ActScreen = "screen"
)

// Decision is what a button press carries back. Every field is needed to
// prove the press is still valid: a card sits in chat history forever, and
// pressing an old one would otherwise inject a keystroke into a pane that has
// long since moved on (G17).
type Decision struct {
	Act      string `json:"act"` // one of ActKey, ActSelect, ActScreen
	Key      string `json:"key"` // must be in agents.AllowedKeys; empty unless ActKey
	Pane     string `json:"pane"`
	Kind     string `json:"kind"` // agent kind at issue time
	Seq      uint64 `json:"seq"`  // state_change_seq at issue time
	IssuedAt int64  `json:"iat"`  // unix seconds
	Nonce    string `json:"n"`    // single-use for ActKey; ignored otherwise
	// Session is the agent's native session id at issue time, when herdr had
	// one. A pane id is a seat, not an identity: an agent can exit and another
	// take the same seat. Selecting by pane alone would silently retarget a
	// later message at whoever is sitting there now (G8, G17).
	Session string `json:"sid,omitempty"`
}

// Inert reports that this decision sends nothing to the agent. Inert actions
// skip the nonce and the blocked-state guard, because there is nothing to
// disarm and nothing that could become an approval.
func (d Decision) Inert() bool { return d.Act == ActSelect || d.Act == ActScreen }

// Guard converts a Decision back into the guard the agents package validates.
func (d Decision) Guard() agents.Guard {
	return agents.Guard{
		PaneID:   d.Pane,
		Kind:     d.Kind,
		StateSeq: d.Seq,
		IssuedAt: time.Unix(d.IssuedAt, 0),
	}
}

// Option is one selectable answer parsed off the agent's screen.
// The number of options varies between agents and versions (Claude shows 2 or
// 3), so they are read from the dialog rather than hardcoded.
type Option struct {
	Key   string // "1", "2", "3"
	Label string
}

var ErrBadDecision = errors.New("card value is not a valid decision")

// Builder renders cards.
//
// Implementations must provide, in build.go, exactly:
//
//	func ParseOptions(s screen.Screen) []Option
//	func BuildBlocked(a agents.Agent, s screen.Screen, opts []Option, nonce string, now time.Time) (string, error)
//	func BuildResolved(a agents.Agent, d Decision, operator, outcome string, at time.Time) (string, error)
//	func BuildExpired(d Decision, reason string) (string, error)
//	func DecodeDecision(v map[string]any) (Decision, error)
//	func BuildAgentList(list []agents.Agent, current string, now time.Time) (string, error)
//
// BuildAgentList is the PRIMARY interface of the product. Typing is the
// cheapest thing a phone can do and everything else costs taps, so the card
// carries the interaction: one row per agent with a select button, and the
// currently selected row marked. It is re-rendered in place on every selection
// (Feishu update_multi), so switching agents is one tap on a card the user
// already has, not another /ls.
//
// current is the pane id of the chat's current target, or "" for none.
// Rows carry ActSelect (with Session filled in) and ActScreen. Slash commands
// remain available underneath, as an escape hatch rather than the main path.
//
// Implementations must also provide:
//
//	func BuildDone(a agents.Agent, answer Answer, nonce string, now time.Time) (string, error)
//
// BuildDone is the "agent finished" card. It shows WHAT THE AGENT SAID, not a
// picture of the terminal: a screen tail carries previous turns, tool chatter
// and TUI furniture, when the only thing the reader wants is the answer. The
// full screen stays one tap away behind ActScreen.
type Answer struct {
	// Prompt is the request being answered, one line, for context. Optional.
	Prompt string
	// Text is the agent's final message, already plain.
	Text string
	// Tools are collapsed one-line summaries, e.g. Bash(date).
	Tools []string
	// Truncated marks Text as cut short; the card then says where to see the rest.
	Truncated bool
	// FromScreen marks a fallback: no transcript was available, so Text is a
	// screen tail and the card must not claim it is the agent's answer.
	FromScreen bool
}

// ParseOptions extracts numbered choices such as "❯ 1. Yes" / "  3. No" from
// the dialog region. When it finds none, callers must fall back to offering
// only Esc plus an instruction to reply in prose, rather than guessing.
//
// BuildBlocked produces a card schema 2.0 with:
//   - a header carrying the agent kind, cwd and title
//   - a markdown code block holding the (already cropped) dialog text
//   - one button per Option, plus a danger-styled Esc
//   - each button's behaviors[0].value being the Decision as a flat object
//
// BuildResolved is the disarmed replacement: no buttons, and it states who
// pressed what, when, and what happened.
type Builder interface {
	BuildBlocked(a agents.Agent, s screen.Screen, opts []Option, nonce string, now time.Time) (string, error)
}
