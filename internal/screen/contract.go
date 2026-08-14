// Package screen turns raw terminal text into something a phone can read.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package screen

// DefaultMaxCols is the column budget for a phone. A pane can be 173 columns
// wide (G5); lines are CROPPED, never wrapped — wrapping destroys TUI
// alignment and makes the result unreadable.
const DefaultMaxCols = 56

// NarrowCols is the threshold below which a pane was almost certainly never
// attached by a terminal client. herdr gives such panes 53x23 (G5), at which
// width Claude's TUI wraps and its blocked-detection strings stop matching —
// which degrades silently to `idle` (G11). Callers must warn.
const NarrowCols = 60

// Screen is extracted terminal content plus the metadata a caller needs in
// order to say honest things about it.
type Screen struct {
	Lines   []string
	Cropped bool // at least one line was truncated at MaxCols
	Rows    int  // pane viewport rows, 0 if unknown
	Cols    int  // widest observed line, used as a proxy for pane width
	Narrow  bool // Cols <= NarrowCols: pane was likely never attached
}

// Text joins Lines with newlines.
func (s Screen) Text() string {
	out := ""
	for i, l := range s.Lines {
		if i > 0 {
			out += "\n"
		}
		out += l
	}
	return out
}

// Extractor produces phone-sized views of a pane.
type Extractor interface {
	// Dialog returns what the agent is currently asking. It reads the
	// `detection` buffer — exactly the snapshot herdr's own detector saw — so
	// the bridge and herdr agree about what is on screen.
	Dialog(paneID string) (Screen, error)

	// Tail returns the last n non-blank lines of the visible viewport.
	Tail(paneID string, n int) (Screen, error)
}

// Implementations must also provide, in inputbox.go, exactly:
//
//	func InputBoxRange(lines []string) (start, end int, ok bool)
//
// It locates the agent's input box and returns the half-open line range
// [start, end) it occupies. That region must be EXCLUDED when verifying a
// prompt was delivered: Claude renders ghost completion suggestions there, so
// text can appear in the input box that the user never sent (G4).
//
// Rule: scanning upward from the bottom, find the first pair of consecutive
// horizontal rules (a line of >=10 repeated box-drawing dashes); the content
// between them is the input box. If no such pair exists (not a Claude-style
// TUI), fall back to the last 5 non-blank lines. ok is false when neither
// applies.
