package cards

import (
	"reflect"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/screen"
)

// The three shapes below are transcribed from real agents. They are the reason
// options are parsed instead of hardcoded: the count differs per agent and per
// prompt, and the selection marker is not always there.

// claudeBash is Claude's Bash permission prompt: three options, chevron on the
// highlighted one. This is the dialog that proved G1 — sending prose here
// approves it — so it is also the dialog the whole product exists for.
const claudeBash = ` Bash command

   touch /tmp/herdr-probe/DANGER.txt

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to herdr-probe/ from this project
   3. No`

// claudeTrust is the trust-directory prompt: two options. Until it is answered
// there is no agent_session at all (G8).
const claudeTrust = ` Do you trust the files in this folder?

 ❯ 1. Yes, I trust this folder
   2. No, exit`

// codexApprove is codex's approval prompt: two options, its own wording.
const codexApprove = ` Allow command?

 > 1. Yes, continue
   2. No, quit`

func lines(s string) []string { return strings.Split(s, "\n") }

func opts(pairs ...string) []Option {
	out := make([]Option, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, Option{Key: pairs[i], Label: pairs[i+1]})
	}
	return out
}

func TestParseOptions(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  []Option
	}{
		{
			name:  "claude bash prompt, three options",
			lines: lines(claudeBash),
			want: opts(
				"1", "Yes",
				"2", "Yes, and always allow access to herdr-probe/ from this project",
				"3", "No",
			),
		},
		{
			name:  "claude trust prompt, two options",
			lines: lines(claudeTrust),
			want:  opts("1", "Yes, I trust this folder", "2", "No, exit"),
		},
		{
			name:  "codex prompt, two options",
			lines: lines(codexApprove),
			want:  opts("1", "Yes, continue", "2", "No, quit"),
		},
		{
			name:  "no selection marker at all",
			lines: lines("Choose:\n  1. Keep going\n  2. Stop"),
			want:  opts("1", "Keep going", "2", "Stop"),
		},
		{
			name:  "parenthesised numbering",
			lines: lines("  1) Yes\n  2) No"),
			want:  opts("1", "Yes", "2", "No"),
		},
		{
			name:  "dialog drawn inside a box",
			lines: lines("│ Do you want to proceed?\n│ ❯ 1. Yes                │\n│   2. No                 │"),
			want:  opts("1", "Yes", "2", "No"),
		},
		{
			// G5: a pane nothing ever attached to is 53 columns wide, so long
			// options arrive wrapped. The wrapped tail belongs to the label.
			name: "wrapped labels on a narrow pane",
			lines: lines(" Do you want to proceed?\n" +
				" ❯ 1. Yes\n" +
				"   2. Yes, and don't ask again for touch\n" +
				"      commands in /tmp/herdr-accept\n" +
				"   3. No, and tell Claude what to do\n" +
				"      differently (esc)"),
			want: opts(
				"1", "Yes",
				"2", "Yes, and don't ask again for touch commands in /tmp/herdr-accept",
				"3", "No, and tell Claude what to do differently (esc)",
			),
		},
		{
			// Claude answers in numbered prose constantly. Those numbers are
			// not a menu, and buttons built from them would send keys that
			// answer the real menu's entries instead.
			name: "prose list above the live menu loses to the menu",
			lines: lines("⏺ I'll do three things:\n" +
				"  1. read the file\n" +
				"  2. patch it\n" +
				"  3. run the tests\n" +
				"  4. report back\n" +
				"\n" +
				" Do you want to proceed?\n" +
				" ❯ 1. Yes\n" +
				"   2. No"),
			want: opts("1", "Yes", "2", "No"),
		},
		{
			// G17: a pressed card left a stray "❯ 1" in the input box. It is not
			// numbered-list shaped, so it never looked like a menu.
			name:  "a stray keystroke echoed into the input box is not a menu",
			lines: lines(" ❯ 1. Yes\n   2. No\n─────────────\n│ ❯ 1"),
			want:  opts("1", "Yes", "2", "No"),
		},
		{
			// The one that matters. The input box sits BELOW the dialog and G4
			// measured text appearing in it that nobody sent, so the bottom-most
			// numbered run is not automatically the menu. A one-entry run losing
			// to a real menu is the difference between a button that reads "no
			// thanks" and sends Yes, and a correct one.
			name:  "an input-box line shaped like a menu entry does not replace the menu",
			lines: lines(" > 1. Yes\n   2. No\n─────────────\n| > 1. yes please"),
			want:  opts("1", "Yes", "2", "No"),
		},
		{
			// A real second menu still wins: two credible runs, bottom-most is
			// the live one.
			name:  "a later menu replaces an earlier one",
			lines: lines(" 1. old a\n 2. old b\n────────\n 1. new a\n 2. new b"),
			want:  opts("1", "new a", "2", "new b"),
		},
		{
			// G5: a 53 column pane wraps, and the wrap does not always land past
			// the number's column. Losing the tail of one label is cosmetic;
			// losing every option below it is a card that disagrees with the
			// menu the user is reading.
			name: "a wrap that is not indented past the number does not drop the options below it",
			lines: lines(" > 1. Yes\n" +
				"   2. Yes, and don't ask again for touch\n" +
				"   commands in /tmp/herdr-accept\n" +
				"   3. No"),
			want: opts("1", "Yes", "2", "Yes, and don't ask again for touch", "3", "No"),
		},
		{
			name:  "a rule drawn between two entries does not end the menu",
			lines: lines(" 1. Yes\n ─────────\n 2. No"),
			want:  opts("1", "Yes", "2", "No"),
		},
		{
			// One line of tolerance, not two: past that we are reading prose.
			name:  "two unexplained lines do end the menu",
			lines: lines(" 1. Yes\n ─────────\n and then some prose\n 2. No"),
			want:  opts("1", "Yes"),
		},
		{
			// isContinuation cannot tell a wrapped tail from a hint indented
			// deeper than the number, so the hint folds in. Documented rather
			// than fixed: the button still sends the key its number names, and
			// the full dialog is in the card body.
			name:  "a hint indented past the number folds into the label above it",
			lines: lines(" > 1. Yes\n   2. No\n     Press esc to cancel"),
			want:  opts("1", "Yes", "2", "No Press esc to cancel"),
		},
		{
			name:  "numbering that does not start at one is not a menu",
			lines: lines(" 2. Yes\n 3. No"),
			want:  nil,
		},
		{
			name:  "gap in the numbering ends the menu",
			lines: lines(" 1. Yes\n 2. No\n 4. Maybe"),
			want:  opts("1", "Yes", "2", "No"),
		},
		{
			// Only 1..9 are in agents.AllowedKeys: a two-digit answer is two
			// keystrokes and the menu acts on the first one.
			name: "options past nine are not offered",
			lines: lines("  1. a\n  2. b\n  3. c\n  4. d\n  5. e\n" +
				"  6. f\n  7. g\n  8. h\n  9. i\n 10. j\n 11. k"),
			want: opts("1", "a", "2", "b", "3", "c", "4", "d", "5", "e",
				"6", "f", "7", "g", "8", "h", "9", "i"),
		},
		{
			name:  "prose with no menu yields nothing",
			lines: lines("⏺ Done. I created the file.\n\n> "),
			want:  nil,
		},
		{
			name:  "empty screen yields nothing",
			lines: nil,
			want:  nil,
		},
		{
			name:  "a bare number is not an option",
			lines: lines(" 1.\n 2."),
			want:  nil,
		},
		{
			name:  "decimals and years are not options",
			lines: lines("took 1.5 seconds\n2024. was a year"),
			want:  nil,
		},
		{
			// The separator rule, exercised where it actually bites: a line that
			// starts exactly like a menu entry. Without the required whitespace
			// after the dot this is option 1 labelled "5 seconds remaining" — a
			// button built out of prose that sends a real key to a blocked agent.
			name:  "a decimal at the start of a line is not option one",
			lines: lines(" 1.5 seconds remaining\n 2. No"),
			want:  nil,
		},
		{
			name:  "a decimal is not an option even alone on the line",
			lines: lines("3.14 is pi"),
			want:  nil,
		},
		{
			// The label must start with a non-space: "1." with nothing but
			// padding after it is an empty entry, and an unlabelled button is a
			// key with no description of what it does.
			name:  "a number followed by only whitespace is not an option",
			lines: lines(" 1.   \n 2.   "),
			want:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseOptions(screen.Screen{Lines: tt.lines})
			if len(got) != len(tt.want) {
				t.Fatalf("got %d options %v, want %d %v", len(got), got, len(tt.want), tt.want)
			}
			if !reflect.DeepEqual(got, tt.want) && len(tt.want) > 0 {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}

// TestParseOptionsOnCleanedScreen runs the parser on what it will actually be
// handed in production: a whole pane, cropped to phone width by the screen
// package, chrome and all.
func TestParseOptionsOnCleanedScreen(t *testing.T) {
	const raw = "╭───────────────────────────────────────────────────╮\n" +
		"│ ✻ Welcome to Claude Code!                         │\n" +
		"╰───────────────────────────────────────────────────╯\n" +
		"\n" +
		"> create DANGER.txt, use a shell command please\n" +
		"\n" +
		"⏺ Bash(touch /tmp/herdr-accept/DANGER.txt)\n" +
		"  ⎿  Waiting…\n" +
		"\n" +
		"─────────────────────────────────────────────────────\n" +
		" Bash command\n" +
		"\n" +
		"   touch /tmp/herdr-accept/DANGER.txt\n" +
		"\n" +
		" Do you want to proceed?\n" +
		" ❯ 1. Yes\n" +
		"   2. Yes, and don't ask again for touch commands\n" +
		"   3. No, and tell Claude what to do differently\n" +
		"\n" +
		"─────────────────────────────────────────────────────\n" +
		"╭───────────────────────────────────────────────────╮\n" +
		"│ > Reply with exactly the single word MARKER4      │\n" +
		"╰───────────────────────────────────────────────────╯\n" +
		"  ⏵⏵ accept edits on (shift+tab to cycle)\n"

	got := ParseOptions(screen.Clean(raw, screen.DefaultMaxCols))
	want := opts(
		"1", "Yes",
		"2", "Yes, and don't ask again for touch commands",
		"3", "No, and tell Claude what to do differently",
	)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestParseOptionsFoldsAtMostFourWrappedLines(t *testing.T) {
	in := []string{
		" 1. start",
		"     a", "     b", "     c", "     d", "     e",
	}
	got := ParseOptions(screen.Screen{Lines: in})
	if len(got) != 1 {
		t.Fatalf("got %#v, want one option", got)
	}
	if want := "start a b c d"; got[0].Label != want {
		t.Fatalf("label = %q, want %q (the fifth wrapped line must not be folded in)", got[0].Label, want)
	}
}

// TestParseOptionsKeepsOptionsBelowAnOverlongLabel: the fold cap bounds how much
// of one label reaches the card. It must not also decide how many options the
// user is offered — dropping "2. No" because "1. Yes" wrapped six times would
// leave a card that answers a different question than the screen is asking.
func TestParseOptionsKeepsOptionsBelowAnOverlongLabel(t *testing.T) {
	in := []string{
		" 1. start",
		"     a", "     b", "     c", "     d", "     e", "     f",
		" 2. second",
	}
	got := ParseOptions(screen.Screen{Lines: in})
	want := opts("1", "start a b c d", "2", "second")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}
