package screen

import (
	"strings"
	"unicode"
)

// Clean turns a raw terminal read into a phone-sized Screen: blank lines are
// dropped, trailing whitespace is trimmed, and every line is CROPPED to maxCols
// display cells.
//
// Cells, not runes: herdr hands back the pane's rendered grid, and a CJK rune
// occupies two of its columns, so a rune-wise cut of Chinese would produce a
// line twice as wide as the budget. See displayWidth.
//
// Cropping — never wrapping — is the whole point. A pane that a terminal client
// once attached to is 173 columns wide (G5); re-wrapping that at phone width
// would destroy the column alignment that makes a TUI legible at all, and would
// manufacture line breaks in the middle of the very strings herdr's detector
// matches on (G11).
//
// maxCols <= 0 is treated as DefaultMaxCols, so a zero-valued config can never
// silently ship 173-column lines to a phone.
func Clean(raw string, maxCols int) Screen {
	c := cleanLines(raw, clampMaxCols(maxCols))
	lines, cropped := c.window(0)
	return buildScreen(lines, cropped, c.maxWidth)
}

func clampMaxCols(maxCols int) int {
	if maxCols <= 0 {
		return DefaultMaxCols
	}
	return maxCols
}

// cleaned is the result of the text pass.
type cleaned struct {
	// lines are the lines to show, already cropped.
	lines []string
	// truncated is parallel to lines: true where the crop actually removed
	// something.
	truncated []bool
	// lostToCrop holds, for every line the crop consumed entirely, the index it
	// would have occupied in lines. Such a line leaves no other trace, so a
	// window covering its position still has to admit that it cropped.
	lostToCrop []int
	// maxWidth is the widest line seen BEFORE cropping, in cells, including
	// lines that cropping consumed entirely. It is the pane-width proxy.
	maxWidth int
}

func cleanLines(raw string, maxCols int) cleaned {
	var c cleaned
	for _, line := range strings.Split(raw, "\n") {
		// Trimming right over unicode space also disposes of the \r in \r\n.
		line = strings.TrimRightFunc(line, unicode.IsSpace)
		if line == "" {
			continue
		}
		cropped, width := cropCells(line, maxCols)
		if width > c.maxWidth {
			c.maxWidth = width
		}
		// Cropping can re-expose trailing whitespace — TUIs right-align status
		// text, so the middle of a line is often padding. A line that is
		// nothing but padding inside the crop window carries no information on
		// a phone, so it goes too rather than becoming a blank line the caller
		// was promised it would not see.
		cropped = strings.TrimRightFunc(cropped, unicode.IsSpace)
		if cropped == "" {
			c.lostToCrop = append(c.lostToCrop, len(c.lines))
			continue
		}
		c.lines = append(c.lines, cropped)
		c.truncated = append(c.truncated, width > maxCols)
	}
	return c
}

// window returns the last n cleaned lines — all of them when n <= 0 — together
// with whether anything the caller actually receives was cropped.
//
// Cropped describes the window rather than the whole read because that is what
// contract.go promises ("at least one line was truncated at MaxCols") and what
// a card renders a "content truncated" note about. Cols deliberately does not
// follow: it is the pane-width proxy, and a short tail of a 173-column pane is
// still a 173-column pane.
func (c cleaned) window(n int) (lines []string, cropped bool) {
	start := 0
	if n > 0 && len(c.lines) > n {
		start = len(c.lines) - n
	}
	for i := start; i < len(c.lines); i++ {
		if c.truncated[i] {
			return c.lines[start:], true
		}
	}
	for _, at := range c.lostToCrop {
		// A line the crop consumed entirely sat immediately before the line now
		// at index `at`, so it is inside the window whenever at >= start.
		if at >= start {
			return c.lines[start:], true
		}
	}
	return c.lines[start:], false
}

// buildScreen assembles a Screen from already-cleaned lines, where cols is the
// widest line of everything that was read, in cells.
//
// Cols and Narrow describe the read, not the slice of it in Lines. That matters
// for Tail: a short tail of a 173-column pane still reports a pane width of
// 173, because that is a fact about the pane, and Cols is the only width
// evidence herdr gives us at all.
func buildScreen(lines []string, cropped bool, cols int) Screen {
	s := Screen{Lines: lines, Cols: cols, Cropped: cropped}
	// An empty screen reports Cols == 0 and therefore Narrow == true. That is
	// the safe direction: a spurious warning is noise, a missing one hides a
	// pane whose blocked detection is silently degrading (G5, G11).
	s.Narrow = s.Cols <= NarrowCols
	return s
}
