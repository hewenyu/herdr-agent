package screen

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestDisplayWidth(t *testing.T) {
	tests := []struct {
		name string
		s    string
		want int
	}{
		{"empty", "", 0},
		{"ascii", "hello", 5},
		{"box drawing is one cell", strings.Repeat("─", 10), 10},
		// The whole reason this file exists: 56 runes of Chinese is 112 columns.
		{"han", "你好世界", 8},
		{"56 runes of han are 112 cells", strings.Repeat("你", 56), 112},
		{"hiragana", "こんにちは", 10},
		{"hangul syllables", "안녕하세요", 10},
		{"hangul jamo initial", "ᄀ", 2},
		{"fullwidth forms", "ＡＢ", 4},
		{"fullwidth won sign", "￦", 2},
		{"cjk punctuation", "、。「」", 8},
		{"cjk compatibility ideograph", "豈", 2},
		{"cjk extension B", "\U00020000", 2},
		{"above every wide range", "\U000F0000", 1},
		{"emoticon", "😀", 2},
		{"supplemental pictograph", "🧠", 2},
		{"transport symbol", "🚀", 2},
		{"mixed", "id: 用户名", 4 + 6},
		{"combining mark is zero width", "é", 1},
		{"variation selector is zero width", "✔️", 1},
		{"zero width joiner", "a‍b", 2},
		{"control characters occupy no cell", "a\x00\x1bb", 2},
		// Ambiguous-width characters stay narrow; herdr's TUIs use them as
		// single cells and a wide guess here would crop legible lines early.
		{"claude status glyph", "⏵⏵ accept edits on", 18},
		{"cyrillic and accents", "Ю́", 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := displayWidth(tc.s); got != tc.want {
				t.Errorf("displayWidth(%q) = %d, want %d", tc.s, got, tc.want)
			}
		})
	}
}

func TestCropCells(t *testing.T) {
	tests := []struct {
		name      string
		s         string
		maxCols   int
		want      string
		wantWidth int
	}{
		{
			name: "short line is untouched",
			s:    "hello", maxCols: 10, want: "hello", wantWidth: 5,
		},
		{
			name: "exactly the budget is untouched",
			s:    "hello", maxCols: 5, want: "hello", wantWidth: 5,
		},
		{
			name: "ascii cuts at the budget",
			s:    strings.Repeat("x", 200), maxCols: 56,
			want: strings.Repeat("x", 56), wantWidth: 200,
		},
		{
			// 28 runes, not 56: this is the bug this function exists to fix.
			name: "han cuts at half the runes",
			s:    strings.Repeat("你", 100), maxCols: 56,
			want: strings.Repeat("你", 28), wantWidth: 200,
		},
		{
			// 27 wide runes = 54 cells; a 28th would be 56 > 55, so the line
			// ends a cell short rather than emitting half a glyph.
			name: "a wide rune is never split at an odd budget",
			s:    strings.Repeat("你", 100), maxCols: 55,
			want: strings.Repeat("你", 27), wantWidth: 200,
		},
		{
			name: "mixed ascii and han",
			s:    "log: " + strings.Repeat("错", 40), maxCols: 20,
			// 5 ascii cells + 7 wide runes = 19 cells; an 8th would overshoot.
			want: "log: " + strings.Repeat("错", 7), wantWidth: 85,
		},
		{
			name: "combining marks ride along with their base rune",
			s:    strings.Repeat("é", 10), maxCols: 3,
			want: "ééé", wantWidth: 10,
		},
		{
			name: "emoji cut at a rune boundary",
			s:    strings.Repeat("🚀", 10), maxCols: 5,
			want: strings.Repeat("🚀", 2), wantWidth: 20,
		},
		{
			name: "budget smaller than the first rune yields nothing",
			s:    "你好", maxCols: 1, want: "", wantWidth: 4,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, width := cropCells(tc.s, tc.maxCols)
			if got != tc.want {
				t.Errorf("cropCells(%q, %d) = %q, want %q", tc.s, tc.maxCols, got, tc.want)
			}
			if width != tc.wantWidth {
				t.Errorf("width = %d, want %d", width, tc.wantWidth)
			}
			if w := displayWidth(got); w > tc.maxCols {
				t.Errorf("result is %d cells wide, over the %d-column budget", w, tc.maxCols)
			}
			if !utf8.ValidString(got) {
				t.Errorf("result %q is not valid UTF-8: a rune was split", got)
			}
		})
	}
}

// Whatever the budget and whatever the text, the result must be valid UTF-8, no
// wider than the budget, and a prefix of the input.
func TestCropCellsNeverOverflowsOrSplits(t *testing.T) {
	inputs := []string{
		"",
		"plain ascii line",
		strings.Repeat("你好，世界！", 20),
		"mixed 混合 text with 表情 🚀🧠 and combining é",
		strings.Repeat("─", 80) + "┤",
		"ＦＵＬＬＷＩＤＴＨ",
		"각 jamo",
	}
	for _, in := range inputs {
		for maxCols := 0; maxCols <= 40; maxCols++ {
			got, width := cropCells(in, maxCols)
			if width != displayWidth(in) {
				t.Fatalf("cropCells(%q, %d) reported width %d, want %d", in, maxCols, width, displayWidth(in))
			}
			if !strings.HasPrefix(in, got) {
				t.Fatalf("cropCells(%q, %d) = %q, not a prefix", in, maxCols, got)
			}
			if !utf8.ValidString(got) {
				t.Fatalf("cropCells(%q, %d) split a rune: %q", in, maxCols, got)
			}
			if w := displayWidth(got); w > maxCols {
				t.Fatalf("cropCells(%q, %d) is %d cells wide", in, maxCols, w)
			}
		}
	}
}
