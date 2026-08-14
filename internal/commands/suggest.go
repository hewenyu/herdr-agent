package commands

import (
	"slices"
	"strings"
	"unicode/utf8"
)

// maxSuggestDistance is the edit distance within which a typo is still
// recognisable as a command name. Two edits covers a transposition
// ("stpo" -> "stop"), which is the mistake a phone keyboard makes most.
const maxSuggestDistance = 2

// closest returns the known command name nearest to name, if one is close
// enough to be worth naming in an error.
//
// The suggestion is advice, never an action: guessing what the user meant and
// running it would turn a typo into a keystroke sent to a live agent.
func closest(name string) (string, bool) {
	n := utf8.RuneCountInString(name)
	if n == 0 {
		return "", false
	}
	// A dialog answer is not a misspelling of a word. Without this, "/1" and
	// "/y" — plausible attempts to answer a permission dialog in the chat
	// window — come back as typos for "/ls", which is wrong, and "/tab" comes
	// back as a typo for "/say", which is advice pointing at free text (G1).
	// unknownReason gives these their own message.
	if isDialogAnswer(name) {
		return "", false
	}

	best, bestDist := "", maxSuggestDistance+1
	for _, sp := range table {
		// Length alone can rule a candidate out, which keeps a pathologically
		// long garbage token from being run through the O(n*m) matrix. Both
		// sides are rune counts: levenshtein measures runes, so comparing
		// against len(sp.name) would silently drop a valid candidate the day
		// a command name stops being ASCII.
		if abs(n-utf8.RuneCountInString(sp.name)) > maxSuggestDistance {
			continue
		}
		if d := levenshtein(name, sp.name); d < bestDist {
			best, bestDist = sp.name, d
		}
	}
	if bestDist > maxSuggestDistance {
		return "", false
	}
	return best, true
}

// levenshtein is the plain edit distance over runes (a transposition costs 2).
func levenshtein(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	if len(ra) == 0 {
		return len(rb)
	}
	if len(rb) == 0 {
		return len(ra)
	}

	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(cur[j-1]+1, min(prev[j]+1, prev[j-1]+cost))
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}

// dialogAnswerKeys is S1 §4's send-keys whitelist minus the digits, plus the
// two words a human types instead of "y"/"n". These are the keystrokes that
// answer a permission dialog, and a user who typed one with a slash in front
// wanted to press a button, not run a command.
var dialogAnswerKeys = []string{"y", "n", "yes", "no", "enter", "esc", "up", "down", "tab"}

// isDialogAnswer reports whether an unrecognised command name is really an
// attempt to answer a permission dialog. Digits count: "/1" is the top item of
// Claude's "1. Yes / 2. Yes,always / 3. No" menu (G1).
func isDialogAnswer(name string) bool {
	if isAllDigits(name) {
		return true
	}
	return slices.Contains(dialogAnswerKeys, name)
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	return strings.IndexFunc(s, func(r rune) bool { return r < '0' || r > '9' }) < 0
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
