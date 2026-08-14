package screen

import "unicode"

// displayWidth reports how many terminal cells s occupies.
//
// Cells, not runes, are the only measure that matches what the user sees. The
// text herdr returns is the pane's rendered grid — already laid out in cells —
// and this bridge routinely carries Chinese, where one rune is two cells. A
// 56-rune crop of Chinese is a 112-cell line, i.e. exactly the wrapping that
// cropping exists to prevent (S1 §3.3 «按列裁剪», acceptance check "每行 ≤56 列").
// Measuring in runes would also under-report Screen.Cols for CJK-heavy content
// and so flag a genuinely wide pane as Narrow (G5).
func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		w += runeWidth(r)
	}
	return w
}

// runeWidth is a deliberately small, dependency-free approximation of UAX #11:
// East Asian Wide and Fullwidth are two cells, combining marks and format
// characters are zero, everything else is one. It is a table, not a library,
// because this module may not grow dependencies.
//
// Known imprecision, all in the direction of over-estimating width (which
// crops slightly early — the safe direction for a phone): a few narrow
// characters inside the big CJK block count as two, and an emoji ZWJ sequence
// counts each pictograph rather than the single glyph a terminal may compose.
func runeWidth(r rune) int {
	switch {
	case r < 0x20 || r == 0x7F:
		// C0 controls occupy no cell. Pane content is already rendered, so
		// these should not appear at all; counting them as 1 would let a line
		// of escape debris shrink the visible crop.
		return 0
	case r < 0x7F:
		// Fast path: printable ASCII is the bulk of any TUI.
		return 1
	case unicode.Is(unicode.Mn, r), unicode.Is(unicode.Me, r), unicode.Is(unicode.Cf, r):
		// Combining marks compose onto the preceding cell; format characters
		// (ZWJ, ZWSP, bidi marks, the emoji variation selector U+FE0F) are not
		// drawn at all.
		return 0
	case isWideRune(r):
		return 2
	}
	return 1
}

// wideRanges are the East Asian Wide/Fullwidth blocks, in ascending order.
var wideRanges = [...]struct{ lo, hi rune }{
	{0x1100, 0x115F},   // Hangul Jamo initial consonants
	{0x2E80, 0xA4CF},   // CJK radicals through Yi: kana, ideographs, CJK punctuation
	{0xAC00, 0xD7A3},   // Hangul syllables
	{0xF900, 0xFAFF},   // CJK compatibility ideographs
	{0xFE30, 0xFE6F},   // CJK compatibility forms, small form variants
	{0xFF00, 0xFF60},   // fullwidth ASCII forms
	{0xFFE0, 0xFFE6},   // fullwidth currency and bar signs
	{0x1F300, 0x1F64F}, // pictographs and emoticons
	{0x1F680, 0x1F6FF}, // transport and map symbols: 🚀 is two cells like the rest
	{0x1F900, 0x1F9FF}, // supplemental pictographs
	{0x20000, 0x3FFFD}, // CJK extension B and beyond
}

func isWideRune(r rune) bool {
	for _, rg := range wideRanges {
		if r < rg.lo {
			// Table is ascending, so nothing further can match.
			return false
		}
		if r <= rg.hi {
			return true
		}
	}
	return false
}

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
		w := runeWidth(r)
		if used+w > maxCols {
			return s[:i], width
		}
		used += w
	}
	return s, width
}
