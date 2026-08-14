package cards

import "unicode"

// Display width, measured in terminal cells.
//
// This is a COPY of internal/screen's rule, not a second one. That package
// measures its crop in cells because one CJK rune occupies two of them, and a
// 56-rune crop of Chinese is a 112-cell line — exactly the wrapping cropping
// exists to prevent (S1 §3.3, G5). This package measures the same class of
// text, on the same phone, against the same kind of budget: a prompt line, a
// tool summary, a notification preview. Two different rules would mean one
// card cropping a Chinese sentence at half the width of another.
//
// It is copied rather than imported because screen exports Screen and its two
// readers and nothing about width, and its contract file is frozen. Keep the
// table below identical to screen/width.go: if one moves, move both.
func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		w += runeWidth(r)
	}
	return w
}

// runeWidth is a deliberately small, dependency-free approximation of UAX #11:
// East Asian Wide and Fullwidth are two cells, combining marks and format
// characters are zero, everything else is one.
//
// Known imprecision, all in the direction of over-estimating width (which cuts
// slightly early — the safe direction for a phone): a few narrow characters
// inside the big CJK block count as two, and an emoji ZWJ sequence counts each
// pictograph rather than the single glyph a terminal may compose.
func runeWidth(r rune) int {
	switch {
	case r < 0x20 || r == 0x7F:
		// C0 controls occupy no cell. A newline inside a body therefore costs
		// nothing against a budget that is about how wide the text renders.
		return 0
	case r < 0x7F:
		// Fast path: printable ASCII is the bulk of any answer.
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
	{0x1F680, 0x1F6FF}, // transport and map symbols
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

// hasWideRune reports whether s contains anything that occupies two cells.
//
// It is the cheap "this is not a shell command" test: no shell in this product
// is driven in Chinese, so a line carrying CJK is prose being described, never
// a command being quoted. See looksLikeCommand.
func hasWideRune(s string) bool {
	for _, r := range s {
		if isWideRune(r) {
			return true
		}
	}
	return false
}

// truncateCells cuts s to at most limit display cells, marking that it did.
//
// It is the cell-measured twin of truncate. The ellipsis is charged one cell,
// so the result never exceeds the budget, and the cut always lands on a rune
// boundary (the index comes from ranging over s) — never on half of a wide one,
// because a rune that would overshoot ends the line a cell short instead.
func truncateCells(s string, limit int) string {
	if limit < 2 || displayWidth(s) <= limit {
		return s
	}
	used, cut := 0, len(s)
	for i, r := range s {
		w := runeWidth(r)
		if used+w > limit-1 {
			cut = i
			break
		}
		used += w
	}
	return s[:cut] + "…"
}
