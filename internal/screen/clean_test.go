package screen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// fixture returns a recorded pane read. claude-173.txt is a pane a 200x50
// client attached to once; claude-53.txt is the 53x23 a headless herdr server
// hands out to a pane no client ever attached to (G5).
func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return string(b)
}

func nonBlankCount(raw string) int {
	n := 0
	for _, l := range strings.Split(raw, "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

func TestCleanWidePane(t *testing.T) {
	raw := fixture(t, "claude-173.txt")
	s := Clean(raw, DefaultMaxCols)

	if s.Cols != 173 {
		t.Errorf("Cols = %d, want 173 (widest line BEFORE cropping)", s.Cols)
	}
	if s.Narrow {
		t.Error("Narrow = true for a 173-column pane; that pane was attached (G5)")
	}
	if !s.Cropped {
		t.Error("Cropped = false, but 173-column lines cannot fit in 56")
	}
	if s.Rows != 0 {
		t.Errorf("Rows = %d, want 0: Clean has no pane geometry to read", s.Rows)
	}

	for i, line := range s.Lines {
		// Columns, which is what the phone renders and what S1's acceptance
		// check counts ("每行 ≤56 列"). Runes only coincide with columns because
		// this fixture happens to be pure ASCII and box drawing.
		if got := displayWidth(line); got > DefaultMaxCols {
			t.Fatalf("line %d is %d columns, want <= %d: %q", i, got, DefaultMaxCols, line)
		}
		if got := utf8.RuneCountInString(line); got > DefaultMaxCols {
			t.Fatalf("line %d is %d runes, want <= %d: %q", i, got, DefaultMaxCols, line)
		}
		if line == "" {
			t.Fatalf("line %d is blank; blank lines must be dropped", i)
		}
		if line != strings.TrimRight(line, " \t") {
			t.Fatalf("line %d has trailing whitespace: %q", i, line)
		}
	}

	// Cropping, not wrapping: one input line can never become two.
	if want := nonBlankCount(raw); len(s.Lines) != want {
		t.Errorf("got %d lines from %d non-blank input lines; wrapping would inflate this", len(s.Lines), want)
	}

	// The header border is 56 runes but three bytes per rune: proof the cut is
	// rune-wise. A byte-wise cut would land at column 18.
	border := s.Lines[0]
	if n := utf8.RuneCountInString(border); n != DefaultMaxCols {
		t.Errorf("border cropped to %d runes, want %d", n, DefaultMaxCols)
	}
	if len(border) <= DefaultMaxCols {
		t.Errorf("border is %d bytes; fixture is supposed to exercise multi-byte cropping", len(border))
	}

	// At 173 columns herdr's blocked-detection string survives on one line.
	if !hasLineContaining(s.Lines, "Do you want to proceed?") {
		t.Error("detection string missing; fixture no longer represents a blocked Claude (G11)")
	}
}

func TestCleanNarrowPaneIsFlagged(t *testing.T) {
	raw := fixture(t, "claude-53.txt")
	s := Clean(raw, DefaultMaxCols)

	if s.Cols != 53 {
		t.Errorf("Cols = %d, want 53", s.Cols)
	}
	if !s.Narrow {
		t.Errorf("Narrow = false at %d columns; a never-attached pane must be flagged (G5)", s.Cols)
	}
	if s.Cropped {
		t.Error("Cropped = true, but every line already fits in 56 columns")
	}

	// This is what the warning is for: at 53 columns Claude wraps the string
	// herdr matches on, herdr reports idle instead of blocked, and it does so
	// silently (G11).
	if hasLineContaining(s.Lines, "Do you want to proceed?") {
		t.Error("fixture no longer wraps the detection string, so it no longer demonstrates G11")
	}
	if !hasLineContaining(s.Lines, "Do you want to") || !hasLineContaining(s.Lines, "proceed?") {
		t.Error("fixture should show the detection string broken across two lines")
	}
}

func hasLineContaining(lines []string, sub string) bool {
	for _, l := range lines {
		if strings.Contains(l, sub) {
			return true
		}
	}
	return false
}

func TestClean(t *testing.T) {
	tests := []struct {
		name        string
		raw         string
		maxCols     int
		wantLines   []string
		wantCols    int
		wantCropped bool
		wantNarrow  bool
	}{
		{
			name:      "drops blank and whitespace-only lines",
			raw:       "alpha\n\n   \n\t\nbeta\n",
			maxCols:   80,
			wantLines: []string{"alpha", "beta"},
			// widest line is 5 runes, well under the narrow threshold
			wantCols:   5,
			wantNarrow: true,
		},
		{
			name:       "trims trailing whitespace and CR",
			raw:        "alpha   \r\nbeta\t\r\n",
			maxCols:    80,
			wantLines:  []string{"alpha", "beta"},
			wantCols:   5,
			wantNarrow: true,
		},
		{
			name:       "keeps leading indentation",
			raw:        "   3. No, and tell Claude what to do differently (esc)\n",
			maxCols:    80,
			wantLines:  []string{"   3. No, and tell Claude what to do differently (esc)"},
			wantCols:   54,
			wantNarrow: true,
		},
		{
			name:        "crops on rune boundaries, not bytes",
			raw:         strings.Repeat("─", 173) + "\n",
			maxCols:     DefaultMaxCols,
			wantLines:   []string{strings.Repeat("─", DefaultMaxCols)},
			wantCols:    173,
			wantCropped: true,
		},
		{
			// The bridge shows Chinese on a phone. One han rune is two terminal
			// cells, so a 56-RUNE crop would ship a 112-column line and the
			// crop would have done nothing at all (S1 §3.3 按列裁剪).
			name:        "crops CJK by display cells, not runes",
			raw:         strings.Repeat("你好", 30) + "\n",
			maxCols:     DefaultMaxCols,
			wantLines:   []string{strings.Repeat("你好", DefaultMaxCols/4)},
			wantCols:    120,
			wantCropped: true,
		},
		{
			// 27 wide runes is 54 cells; a 28th would be 56 > 55.
			name:        "a wide rune is never split by the crop",
			raw:         strings.Repeat("要", 60) + "\n",
			maxCols:     55,
			wantLines:   []string{strings.Repeat("要", 27)},
			wantCols:    120,
			wantCropped: true,
		},
		{
			// Cols is a pane-width proxy, so it too must be in cells: 40 han
			// runes on a 80-column pane measure 40 by rune count, which would
			// put a bogus "this pane was never attached" warning (G5) on a card
			// about a pane that is perfectly wide.
			name:        "CJK does not fake a narrow pane",
			raw:         strings.Repeat("中", 40) + "\n",
			maxCols:     DefaultMaxCols,
			wantLines:   []string{strings.Repeat("中", DefaultMaxCols/2)},
			wantCols:    80,
			wantCropped: true,
			wantNarrow:  false,
		},
		{
			// Combining marks compose onto the cell before them, so 70 of these
			// are 70 columns, not 140, and the crop keeps 56 of them.
			name:        "combining marks cost no columns",
			raw:         strings.Repeat("e\u0301", 70) + "\n",
			maxCols:     DefaultMaxCols,
			wantLines:   []string{strings.Repeat("e\u0301", DefaultMaxCols)},
			wantCols:    70,
			wantCropped: true,
		},
		{
			name:        "never wraps: one long line stays one line",
			raw:         strings.Repeat("x", 200) + "\n",
			maxCols:     DefaultMaxCols,
			wantLines:   []string{strings.Repeat("x", DefaultMaxCols)},
			wantCols:    200,
			wantCropped: true,
		},
		{
			name:      "exactly maxCols is not cropped",
			raw:       strings.Repeat("x", DefaultMaxCols) + "\n",
			maxCols:   DefaultMaxCols,
			wantLines: []string{strings.Repeat("x", DefaultMaxCols)},
			wantCols:  DefaultMaxCols,
			// 56 <= NarrowCols
			wantNarrow: true,
		},
		{
			name:        "maxCols <= 0 falls back to the phone default",
			raw:         strings.Repeat("x", 173) + "\n",
			maxCols:     0,
			wantLines:   []string{strings.Repeat("x", DefaultMaxCols)},
			wantCols:    173,
			wantCropped: true,
		},
		{
			name:        "Narrow boundary: NarrowCols is narrow",
			raw:         strings.Repeat("x", NarrowCols) + "\n",
			maxCols:     DefaultMaxCols,
			wantLines:   []string{strings.Repeat("x", DefaultMaxCols)},
			wantCols:    NarrowCols,
			wantCropped: true,
			wantNarrow:  true,
		},
		{
			name:        "Narrow boundary: one column wider is not",
			raw:         strings.Repeat("x", NarrowCols+1) + "\n",
			maxCols:     DefaultMaxCols,
			wantLines:   []string{strings.Repeat("x", DefaultMaxCols)},
			wantCols:    NarrowCols + 1,
			wantCropped: true,
			wantNarrow:  false,
		},
		{
			name:       "padding-only remainder is dropped rather than left blank",
			raw:        strings.Repeat(" ", 60) + "right-aligned\n",
			maxCols:    DefaultMaxCols,
			wantLines:  nil,
			wantCols:   73,
			wantNarrow: false,
			// the line was over maxCols, so the crop is real even though
			// nothing printable survived it
			wantCropped: true,
		},
		{
			name:       "empty input",
			raw:        "",
			maxCols:    DefaultMaxCols,
			wantLines:  nil,
			wantCols:   0,
			wantNarrow: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Clean(tc.raw, tc.maxCols)
			if !equalLines(got.Lines, tc.wantLines) {
				t.Errorf("Lines = %q, want %q", got.Lines, tc.wantLines)
			}
			if got.Cols != tc.wantCols {
				t.Errorf("Cols = %d, want %d", got.Cols, tc.wantCols)
			}
			if got.Cropped != tc.wantCropped {
				t.Errorf("Cropped = %v, want %v", got.Cropped, tc.wantCropped)
			}
			if got.Narrow != tc.wantNarrow {
				t.Errorf("Narrow = %v, want %v", got.Narrow, tc.wantNarrow)
			}
			if got.Rows != 0 {
				t.Errorf("Rows = %d, want 0", got.Rows)
			}
		})
	}
}

func equalLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestScreenText(t *testing.T) {
	s := Clean("alpha\n\nbeta\n", DefaultMaxCols)
	if got, want := s.Text(), "alpha\nbeta"; got != want {
		t.Errorf("Text() = %q, want %q", got, want)
	}
}
