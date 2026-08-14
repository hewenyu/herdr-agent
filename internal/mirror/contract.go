// Package mirror tails an agent's own transcript file and turns it into chat
// turns with real roles — so the phone shows a conversation, not a screenshot
// of a terminal.
//
// The transcript is the source of truth for CONTENT. It says nothing about a
// pending permission request (there is no such record), so "the agent is
// blocked" always comes from herdr instead. Two data sources, two jobs (G8).
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package mirror

import (
	"context"
	"time"
)

// Turn is one conversational turn extracted from a transcript.
type Turn struct {
	Role string // "user" | "assistant"
	Text string
	// ToolCalls are collapsed one-line summaries, e.g. `Bash(touch x.txt)`.
	// A phone does not want full tool payloads.
	ToolCalls []string
	At        time.Time
	// Seq orders turns within a file (claude: record order; codex: `ordinal`).
	Seq uint64
}

// Parser converts newly appended transcript bytes into turns.
//
// Implementations must be resilient: an unrecognised record type is skipped
// with a debug log, never an error that would stop the mirror. Agent vendors
// add record types without notice.
type Parser interface {
	Name() string
	// Parse consumes whole JSONL lines from data. Any trailing partial line is
	// returned in rest so the caller can prepend it to the next read.
	Parse(data []byte) (turns []Turn, rest []byte, err error)
}

// ParserFor returns the parser for a herdr agent kind ("claude", "codex").
//
// Implementations must provide, in parsers.go, exactly:
//
//	func ParserFor(kind string) (Parser, bool)
func ParserForDoc() {}

// TailBytes is how much of the end of a transcript LastTurns reads. Large
// enough to contain several turns of any real session, small enough that a
// long-running agent's multi-megabyte transcript costs nothing to sample.
const TailBytes = 256 << 10

// LastTurns returns the final turns of a transcript, newest last.
//
// This is what a "finished" notification shows. The alternative — the tail of
// the terminal — is a screenshot of scrollback: it carries previous turns, tool
// chatter and TUI furniture, when all the reader wants is the answer. The
// transcript already has roles and boundaries, so use them.
//
// It reads only the last TailBytes and discards the first partial record, so a
// huge transcript is cheap. Fewer than n turns is not an error.
//
// Implementations must provide, in lastturns.go, exactly:
//
//	func LastTurns(path, kind string, n int) ([]Turn, error)
//
// It must NOT be used for a blocked agent: a transcript has no pending
// permission record at all (G8), so what the agent is asking can only come from
// the screen.
type Sampler interface {
	LastTurns(path, kind string, n int) ([]Turn, error)
}

// PaneTurn is a turn tagged with the pane it came from.
type PaneTurn struct {
	PaneID string
	Turn   Turn
}

// Watcher tails enabled agents' transcripts and publishes turns.
//
// Mirroring is opt-in per agent (/mirror <pane> on): a chatty agent would
// otherwise flood the chat.
type Watcher interface {
	Run(ctx context.Context) error
	// Enable starts tailing paneID's transcript from the CURRENT end of file.
	// Back-filling history on enable would dump an entire session into chat.
	Enable(paneID string) error
	Disable(paneID string)
	Enabled(paneID string) bool
	Turns() <-chan PaneTurn
}
