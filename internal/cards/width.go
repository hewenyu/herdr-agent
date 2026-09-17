package cards

import "github.com/hewenyu/herdr-agent/internal/textwidth"

func displayWidth(s string) int { return textwidth.Width(s) }

// hasWideRune reports whether s contains anything that occupies two cells.
//
// It is the cheap "this is not a shell command" test: no shell in this product
// is driven in Chinese, so a line carrying CJK is prose being described, never
// a command being quoted. See looksLikeCommand.
func hasWideRune(s string) bool {
	for _, r := range s {
		if textwidth.IsWide(r) {
			return true
		}
	}
	return false
}

// truncateCells retains this package's string-only rendering helper while
// sharing the same width and ellipsis budget as terminal crops and done posts.
func truncateCells(s string, limit int) string {
	shown, _ := textwidth.Truncate(s, limit)
	return shown
}
