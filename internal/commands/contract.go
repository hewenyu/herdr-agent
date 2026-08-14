// Package commands parses the slash-command surface.
//
// The single most important property: an unrecognised slash command must NEVER
// degrade into free text. Sending "/stpo w1:p1" to a blocked agent as prose
// would press Enter on its permission dialog and approve it (G1).
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package commands

type Kind int

const (
	// KindProse is plain text intended for an agent. Only produced when the
	// input does not begin with '/'.
	KindProse Kind = iota
	KindLs
	KindCard
	KindSay
	KindStop
	KindMirror
	KindDoctor
	KindHelp
	// KindUnknown is an unrecognised slash command. Callers must reply with an
	// error and must not route it to an agent.
	KindUnknown
	// KindBadArgs is a recognised command with unusable arguments.
	KindBadArgs
)

func (k Kind) String() string {
	switch k {
	case KindProse:
		return "prose"
	case KindLs:
		return "ls"
	case KindCard:
		return "card"
	case KindSay:
		return "say"
	case KindStop:
		return "stop"
	case KindMirror:
		return "mirror"
	case KindDoctor:
		return "doctor"
	case KindHelp:
		return "help"
	case KindBadArgs:
		return "bad-args"
	default:
		return "unknown"
	}
}

// Command is a parsed instruction.
type Command struct {
	Kind Kind
	Pane string // for card/say/stop/mirror
	Text string // for say and prose
	On   bool   // for mirror
	Raw  string
	// Reason explains KindUnknown / KindBadArgs to the user.
	Reason string
}

// Parse turns one chat message into a Command.
//
// Implementations must provide, in parse.go, exactly:
//
//	func Parse(s string) Command
//	func Help() string
//
// Rules:
//   - leading/trailing whitespace trimmed; empty input => KindBadArgs
//   - anything not starting with '/' => KindProse
//   - "/ls" takes no arguments; extra arguments are tolerated and ignored
//   - "/card <pane>", "/stop <pane>" require a pane that looks like w<N>:p<M>
//     (also accept the legacy forms herdr tolerates: w1-1, bare integers)
//   - "/say <pane> <text...>" requires both
//   - "/mirror <pane> on|off"
//   - an unknown slash command => KindUnknown with Reason naming the closest
//     known command if one is within edit distance 2
type Parser interface {
	Parse(s string) Command
}
