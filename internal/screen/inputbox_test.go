package screen

import (
	"strings"
	"testing"
)

func rule(n int) string { return strings.Repeat("─", n) }
func boxTop(n int) string {
	return "╭" + strings.Repeat("─", n) + "╮"
}
func boxBottom(n int) string {
	return "╰" + strings.Repeat("─", n) + "╯"
}

// TestInputBoxRangeOnRealScreen walks the recorded 173-column pane the way a
// caller does: Clean first, then locate the box in the cleaned lines.
func TestInputBoxRangeOnRealScreen(t *testing.T) {
	s := Clean(fixture(t, "claude-173.txt"), DefaultMaxCols)

	start, end, ok := InputBoxRange(s.Lines)
	if !ok {
		t.Fatal("InputBoxRange: not found on a screen that has an input box")
	}
	if start < 0 || end > len(s.Lines) || start >= end {
		t.Fatalf("range [%d,%d) out of bounds for %d lines", start, end, len(s.Lines))
	}

	// Both edges of the returned range are the box's own rules, cropped to
	// phone width and still recognisable.
	if !isRule(s.Lines[start]) {
		t.Errorf("line %d is not a rule: %q", start, s.Lines[start])
	}
	if !isRule(s.Lines[end-1]) {
		t.Errorf("line %d is not a rule: %q", end-1, s.Lines[end-1])
	}

	// G4: the ghost completion Claude invented lives inside the box and must
	// therefore fall inside the excluded range. If it did not, a delivery check
	// could match text the user never sent.
	ghost := indexOfLineContaining(t, s.Lines, "MARKER4")
	if ghost < start || ghost >= end {
		t.Errorf("ghost completion at line %d is outside range [%d,%d)", ghost, start, end)
	}

	// The permission dialog is fenced by rules too. Anchoring on the topmost
	// rule instead of pairing bottom-up would swallow all of this.
	for _, keep := range []string{
		"Do you want to proceed?",
		"1. Yes",
		"2. Yes, and don't ask again",
		"3. No, and tell Claude",
		"Bash command",
	} {
		i := indexOfLineContaining(t, s.Lines, keep)
		if i >= start && i < end {
			t.Errorf("%q (line %d) was swallowed by the input box range [%d,%d)", keep, i, start, end)
		}
	}

	// The rule that opens the permission dialog is above the box, not its edge.
	dialogRule := indexOfLineContaining(t, s.Lines, "Do you want to proceed?")
	if start <= dialogRule {
		t.Errorf("range starts at %d, above the dialog at %d: wrong rule pair chosen", start, dialogRule)
	}

	// The status hint below the box is not part of it.
	hint := indexOfLineContaining(t, s.Lines, "accept edits on")
	if hint < end {
		t.Errorf("status hint at line %d is inside the box range [%d,%d)", hint, start, end)
	}

	// Finally: the user's real prompt stays visible to a delivery check.
	sent := indexOfLineContaining(t, s.Lines, "create DANGER.txt")
	if sent >= start {
		t.Errorf("the user's own prompt at line %d is inside the excluded range [%d,%d)", sent, start, end)
	}
}

// The same screen must resolve identically before Clean has dropped its blank
// lines, because Say's verification path may hold either form.
func TestInputBoxRangeOnUncleanedScreen(t *testing.T) {
	lines := strings.Split(fixture(t, "claude-173.txt"), "\n")

	start, end, ok := InputBoxRange(lines)
	if !ok {
		t.Fatal("InputBoxRange: not found")
	}
	ghost := indexOfLineContaining(t, lines, "MARKER4")
	if ghost < start || ghost >= end {
		t.Errorf("ghost completion at %d outside range [%d,%d)", ghost, start, end)
	}
	dialog := indexOfLineContaining(t, lines, "Do you want to proceed?")
	if dialog >= start {
		t.Errorf("dialog at %d is inside range [%d,%d)", dialog, start, end)
	}
}

func TestInputBoxRangeOnNarrowScreen(t *testing.T) {
	s := Clean(fixture(t, "claude-53.txt"), DefaultMaxCols)

	start, end, ok := InputBoxRange(s.Lines)
	if !ok {
		t.Fatal("InputBoxRange: not found on a 53-column pane")
	}
	// A 53-column box edge still carries far more than minRuleDashes dashes.
	if !isRule(s.Lines[start]) || !isRule(s.Lines[end-1]) {
		t.Errorf("range [%d,%d) does not sit on rules: %q / %q", start, end, s.Lines[start], s.Lines[end-1])
	}
	dialog := indexOfLineContaining(t, s.Lines, "Do you want to")
	if dialog >= start {
		t.Errorf("dialog at %d is inside range [%d,%d)", dialog, start, end)
	}
}

func indexOfLineContaining(t *testing.T, lines []string, sub string) int {
	t.Helper()
	for i, l := range lines {
		if strings.Contains(l, sub) {
			return i
		}
	}
	t.Fatalf("fixture no longer contains %q", sub)
	return -1
}

func TestInputBoxRange(t *testing.T) {
	tests := []struct {
		name      string
		lines     []string
		wantStart int
		wantEnd   int
		wantOK    bool
	}{
		{
			name: "bottom pair wins over an earlier rule",
			lines: []string{
				"transcript",
				rule(40),
				" Do you want to proceed?",
				" 1. Yes",
				rule(40),
				boxTop(40),
				"│ > ghost suggestion",
				boxBottom(40),
				"  ? for shortcuts",
			},
			wantStart: 5, wantEnd: 8, wantOK: true,
		},
		{
			name: "bare rules with no corners",
			lines: []string{
				"transcript",
				rule(40),
				"> typed text",
				rule(40),
			},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			name: "adjacent rules are an empty box",
			lines: []string{
				"transcript",
				rule(40),
				rule(40),
				"hint",
			},
			wantStart: 1, wantEnd: 3, wantOK: true,
		},
		{
			name: "cropped box edges are still rules",
			lines: []string{
				"transcript",
				"╭" + rule(55),
				"│ > ghost",
				"╰" + rule(55),
			},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			name: "double-line and heavy rules count",
			lines: []string{
				"transcript",
				strings.Repeat("═", 12),
				"> typed text",
				strings.Repeat("━", 12),
			},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			// A boxed welcome banner with a transcript under it and no composer
			// in sight. Pairing its rules would call the banner "the input box"
			// and leave the bottom of the screen — where anything typed would
			// be — inside the region a delivery check searches (G4).
			name: "a box far above the bottom is not the input box",
			lines: []string{
				boxTop(40),
				"│ ✻ Welcome to Claude Code!",
				boxBottom(40),
				"one", "two", "three", "four", "five",
				"six", "seven", "eight", "nine", "ten",
			},
			wantStart: 8, wantEnd: 13, wantOK: true,
		},
		{
			name: "boundary: eight non-blank lines below the box still pairs",
			lines: []string{
				"transcript",
				boxTop(40),
				"│ > typed",
				boxBottom(40),
				"1", "2", "3", "4", "5", "6", "7", "8",
			},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			name: "boundary: nine non-blank lines below the box falls back",
			lines: []string{
				"transcript",
				boxTop(40),
				"│ > typed",
				boxBottom(40),
				"1", "2", "3", "4", "5", "6", "7", "8", "9",
			},
			wantStart: 8, wantEnd: 13, wantOK: true,
		},
		{
			name: "blank lines below the box do not count toward the distance",
			lines: []string{
				"transcript",
				boxTop(40),
				"│ > typed",
				boxBottom(40),
				"", "", "", "", "", "", "", "", "", "", "hint",
			},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			name: "no rules at all falls back to the last five non-blank lines",
			lines: []string{
				"one", "two", "three", "four", "five", "six", "seven", "eight",
			},
			wantStart: 3, wantEnd: 8, wantOK: true,
		},
		{
			name: "fallback counts non-blank lines but spans to the end",
			lines: []string{
				"one", "", "two", "", "three", "", "four", "", "five", "", "six", "",
			},
			// non-blank lines from the bottom: six, five, four, three, two
			wantStart: 2, wantEnd: 12, wantOK: true,
		},
		{
			name:      "fallback with fewer than five non-blank lines takes them all",
			lines:     []string{"", "one", "", "two"},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			name: "a single unpaired rule is not a box",
			lines: []string{
				"one", "two", rule(40), "three", "four", "five", "six",
			},
			wantStart: 2, wantEnd: 7, wantOK: true,
		},
		{
			name: "nine dashes is not a rule",
			lines: []string{
				"one",
				strings.Repeat("─", minRuleDashes-1),
				"two",
				strings.Repeat("─", minRuleDashes-1),
			},
			// falls back: four non-blank lines, all of them
			wantStart: 0, wantEnd: 4, wantOK: true,
		},
		{
			name: "ten dashes is a rule",
			lines: []string{
				"one",
				strings.Repeat("─", minRuleDashes),
				"two",
				strings.Repeat("─", minRuleDashes),
			},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			name: "ascii dashes are transcript text, not box edges",
			lines: []string{
				"# heading",
				strings.Repeat("-", 40),
				"body",
				strings.Repeat("=", 40),
				"more body",
			},
			wantStart: 0, wantEnd: 5, wantOK: true,
		},
		{
			name: "a rule with a label is not a box edge",
			lines: []string{
				"one",
				rule(12) + " context " + rule(12),
				"two",
				rule(12) + " context " + rule(12),
			},
			wantStart: 0, wantEnd: 4, wantOK: true,
		},
		{
			name: "vertical box drawing is not a rule",
			lines: []string{
				"one",
				strings.Repeat("│", 40),
				"two",
				strings.Repeat("│", 40),
			},
			wantStart: 0, wantEnd: 4, wantOK: true,
		},
		{
			name: "indented rules still count",
			lines: []string{
				"one",
				"   " + rule(40) + "  ",
				"> typed",
				"   " + rule(40) + "  ",
			},
			wantStart: 1, wantEnd: 4, wantOK: true,
		},
		{
			name:   "nothing but blank lines",
			lines:  []string{"", "   ", "\t"},
			wantOK: false,
		},
		{
			name:   "no lines",
			lines:  nil,
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			start, end, ok := InputBoxRange(tc.lines)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if start != tc.wantStart || end != tc.wantEnd {
				t.Errorf("range = [%d,%d), want [%d,%d)", start, end, tc.wantStart, tc.wantEnd)
			}
		})
	}
}

func TestIsRule(t *testing.T) {
	tests := []struct {
		name string
		line string
		want bool
	}{
		{"light rule", rule(minRuleDashes), true},
		{"one dash short", rule(minRuleDashes - 1), false},
		{"empty", "", false},
		{"blank", "     ", false},
		{"rounded box top", boxTop(20), true},
		{"rounded box bottom", boxBottom(20), true},
		{"square box top", "┌" + rule(20) + "┐", true},
		{"tee joins", "├" + rule(20) + "┤", true},
		{"dashed variant", strings.Repeat("┄", minRuleDashes), true},
		{"corners only", "╭╮╰╯", false},
		{"short runs separated by corners", rule(6) + "┼" + rule(6), false},
		{"long run after a corner", rule(6) + "┼" + rule(minRuleDashes), true},
		{"text inside", rule(20) + " title " + rule(20), false},
		{"input line", "│ > hello", false},
		{"ascii", strings.Repeat("-", 40), false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isRule(tc.line); got != tc.want {
				t.Errorf("isRule(%q) = %v, want %v", tc.line, got, tc.want)
			}
		})
	}
}
