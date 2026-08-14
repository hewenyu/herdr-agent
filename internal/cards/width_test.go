package cards

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// TestDisplayWidthAgreesWithScreen keeps this copy of the rule honest about the
// cases it was copied for: CJK is two cells, combining marks and format
// characters are none, control characters (a newline inside a body) are none.
func TestDisplayWidthMeasuresCells(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"现在几点了", 10},
		{"现在是 01:23", 12}, // three wide runes, a space, five ASCII
		{"ｆｕｌｌ", 8},       // fullwidth ASCII forms
		{"é", 1},          // precomposed
		{"é", 1},         // e + combining acute: one cell
		{"a‍b", 2},        // ZWJ is not drawn
		{"line\nline", 8}, // a newline occupies no cell
		{"🚀", 2},          // pictograph
		{"…", 1},          // the ellipsis truncateCells charges one cell for
	}
	for _, tc := range tests {
		if got := displayWidth(tc.in); got != tc.want {
			t.Errorf("displayWidth(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// TestTruncateCellsNeverExceedsItsBudget, including when the rune that would
// overshoot is a wide one — the line then ends a cell short rather than
// emitting half a character.
func TestTruncateCellsNeverExceedsItsBudget(t *testing.T) {
	for _, limit := range []int{2, 3, 5, 9, 10, 11, 40} {
		for _, in := range []string{
			strings.Repeat("a", 50),
			strings.Repeat("时", 50),
			"abc时def时ghi",
		} {
			got := truncateCells(in, limit)
			if w := displayWidth(got); w > limit {
				t.Errorf("truncateCells(%q, %d) = %q, %d cells", in, limit, got, w)
			}
			if !utf8.ValidString(got) {
				t.Errorf("truncateCells(%q, %d) = %q, which is not valid UTF-8", in, limit, got)
			}
		}
	}
}

func TestTruncateCellsLeavesShortStringsAlone(t *testing.T) {
	for _, in := range []string{"", "abc", "现在几点了"} {
		if got := truncateCells(in, 20); got != in {
			t.Errorf("truncateCells(%q, 20) = %q, want it unchanged", in, got)
		}
	}
}

// TestTruncateCellsCutsCJKAtHalfTheRunes is the difference that matters: the
// same 40-rune input keeps every rune in ASCII and about half of them in
// Chinese, because the budget is cells.
func TestTruncateCellsCutsCJKAtHalfTheRunes(t *testing.T) {
	const budget = 40
	ascii := truncateCells(strings.Repeat("a", budget), budget)
	if n := utf8.RuneCountInString(ascii); n != budget {
		t.Errorf("ascii kept %d runes, want %d", n, budget)
	}
	cjk := truncateCells(strings.Repeat("时", budget), budget)
	if n := utf8.RuneCountInString(cjk); n > budget/2+1 {
		t.Errorf("cjk kept %d runes, want about %d", n, budget/2)
	}
	if !strings.HasSuffix(cjk, "…") {
		t.Errorf("cjk = %q, want it marked as cut", cjk)
	}
}

func TestHasWideRune(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want bool
	}{
		{"go test ./...", false},
		{"cd /tmp/herdr-accept", false},
		{"现在几点了", true},
		{"run 测试", true},
		{"", false},
		{"\U000E0001", false}, // past the last wide range: the loop runs off the end
	} {
		if got := hasWideRune(tc.in); got != tc.want {
			t.Errorf("hasWideRune(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}
