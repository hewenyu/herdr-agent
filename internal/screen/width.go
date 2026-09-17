package screen

import "github.com/hewenyu/herdr-agent/internal/textwidth"

// displayWidth reports how many terminal cells s occupies.
//
// Cells, not runes, are the only measure that matches what the user sees. The
// text herdr returns is the pane's rendered grid — already laid out in cells —
// and this bridge routinely carries Chinese, where one rune is two cells. A
// 56-rune crop of Chinese is a 112-cell line, i.e. exactly the wrapping that
// cropping exists to prevent (S1 §3.3 «按列裁剪», acceptance check "每行 ≤56 列").
// Measuring in runes would also under-report Screen.Cols for CJK-heavy content
// and so flag a genuinely wide pane as Narrow (G5).
func displayWidth(s string) int { return textwidth.Width(s) }

// cropCells cuts s down to at most maxCols display cells and reports the full
// width of s before the cut.
//
// It never splits a rune (the cut index comes from ranging over s, so it always
// lands on a boundary) and never emits half of a wide one: when the next rune
// would overshoot the budget the line simply ends a cell short. Zero-width
// runes always fit, so a combining mark stays attached to the base character it
// modifies instead of being orphaned onto the next line's first cell.
//
// A budget too small for even the first rune yields the empty string; the
// caller drops such a line rather than ship one that overflows the phone.
func cropCells(s string, maxCols int) (string, int) {
	width := displayWidth(s)
	if width <= maxCols {
		return s, width
	}
	used := 0
	for i, r := range s {
		w := textwidth.RuneWidth(r)
		if used+w > maxCols {
			return s[:i], width
		}
		used += w
	}
	return s, width
}
