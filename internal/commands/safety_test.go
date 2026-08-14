package commands

import (
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// TestSlashInputNeverBecomesProse is the reason this package exists.
//
// G1, measured: sending free text to an agent that is sitting on a permission
// dialog approves the dialog. herdr's agent.prompt pastes the text and then
// writes a bare Enter 300ms later; the dialog is a menu, so the text is
// discarded and the Enter selects the highlighted "1. Yes". A user who typed
// "/stpo w1:p1" to STOP an agent would have approved whatever it was asking.
//
// So: no input that opens with a command marker may ever come back as
// KindProse, however mangled it is.
func TestSlashInputNeverBecomesProse(t *testing.T) {
	for _, in := range malformedCommands() {
		got := Parse(in)
		if got.Kind == KindProse {
			t.Errorf("Parse(%q) = KindProse; a slash line must never be routed to an agent as text (G1)", in)
			continue
		}
		if got.Kind == KindUnknown || got.Kind == KindBadArgs {
			if strings.TrimSpace(got.Reason) == "" {
				t.Errorf("Parse(%q) = %v with no Reason; the user must be told why", in, got.Kind)
			}
		}
		// Whatever we decided, nothing that reaches an agent may be carrying
		// the raw line as text.
		if got.Kind != KindSay && got.Text != "" {
			t.Errorf("Parse(%q) = %v carries Text %q", in, got.Kind, got.Text)
		}
	}
}

// malformedCommands enumerates slash lines a phone can realistically produce:
// hand-picked disasters plus systematic mutations of every known command.
func malformedCommands() []string {
	var in []string

	in = append(in,
		"/",
		"//",
		"///",
		"/ ",
		"/ stop w1:p1",
		"/ /stop w1:p1",
		"/\n",
		"/\t",
		"/stpo w1:p1",
		"/stop!",
		"/stop.",
		"/stop,",
		"/stop?",
		"/stop:",
		"/stop w1:p1:extra",
		"/stop@w1:p1",
		"/stop-w1:p1",
		"/stop/w1:p1",
		"/stop w1;p1",
		"/stop wp",
		"/stop pane one",
		"/stop the agent now",
		"/say",
		"/say w1:p1",
		"/say hello",
		"/say stop the build",
		"/card",
		"/card the screen",
		"/mirror",
		"/mirror w1:p1",
		"/mirror w1:p1 yes",
		"/mirror on w1:p1",
		"/ls-all",
		"/tmp/herdr-accept",
		"/Users/me/notes.md",
		"/1",
		"/1 w1:p1",
		"/2",
		"/y",
		"/n",
		"/esc",
		"/yes",
		"/no",
		"/exit",
		"/quit",
		"/status",
		"/agents",
		"/kill w1:p1",
		"/frobnicate everything",
		"/HELP!!",
		"/🙂",
		"/停止 w1:p1",
		"/ls\x00",
		"/ls\r\n",
		"/"+strings.Repeat("x", 4096),
		"/stop "+strings.Repeat("9", 64),

		// Invisible characters in front of the marker, written as escapes
		// because Go will not accept a BOM mid-file — which is itself the point:
		// nobody can see these, so nobody can debug them from the chat window.
		// strings.TrimSpace does not remove category Cf, so without an explicit
		// strip each of these reads as "does not start with a slash" and the whole
		// command is delivered to the agent as text (G1).
		"\u200b/stop w1:p1", // zero-width space
		"\ufeff/stpo w1:p1", // BOM, with a typo behind it
		"\u200d/stop w1:p1", // zero-width joiner
		"\u202e/stop w1:p1", // right-to-left override
		"\u200b\ufeff /stop w1:p1",
		"\u200b", // nothing but an invisible character

		// Slash lookalikes reachable from a phone symbol picker or a paste.
		"\u2044stop w1:p1", // fraction slash
		"\u2215stop w1:p1", // division slash
	)

	// Systematic single-edit damage to every real command name, crossed with
	// the argument shapes users actually type. A phone keyboard drops,
	// doubles and transposes characters; none of those may reopen the prose
	// path.
	args := []string{"", " w1:p1", " w1:p1 on", " w1:p1 some words", " nonsense", "   "}
	for _, sp := range table {
		for _, form := range mutate(sp.name) {
			for _, a := range args {
				in = append(in, "/"+form+a)
			}
		}
	}

	// Every one of the above typed with a Chinese IME, which produces U+FF0F
	// where the user pressed "/".
	for _, s := range append([]string(nil), in...) {
		in = append(in, "／"+strings.TrimPrefix(s, "/"))
	}

	// ...and with the leading and trailing whitespace a phone adds.
	for _, s := range append([]string(nil), in...) {
		in = append(in, "  "+s, s+"\n", "\n\t"+s+"  \n")
	}
	return in
}

// mutate returns misspellings of name: deletions, transpositions, doublings,
// insertions and case damage.
func mutate(name string) []string {
	r := []rune(name)
	out := []string{name, strings.ToUpper(name), capitalize(name)}

	for i := range r {
		// deletion
		out = append(out, string(r[:i])+string(r[i+1:]))
		// doubling
		out = append(out, string(r[:i])+string(r[i])+string(r[i:]))
		// insertion
		out = append(out, string(r[:i])+"x"+string(r[i:]))
		// transposition
		if i+1 < len(r) {
			s := append([]rune(nil), r...)
			s[i], s[i+1] = s[i+1], s[i]
			out = append(out, string(s))
		}
	}
	out = append(out, name+"s", name+"1", name+"_", "x"+name)
	return out
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	return strings.ToUpper(string(r[0])) + string(r[1:])
}

// looksLikeCommand is the fuzz target's oracle, and it is deliberately written
// out in literals instead of calling stripCommandPrefix.
//
// An oracle that asks the implementation what counts as a command agrees with
// the implementation when the implementation is wrong: emptying
// commandPrefixes — the exact G1 disaster, every command degrading to prose —
// would leave a self-referential fuzz target passing. Keep this list in sync
// with commandPrefixes by hand; the duplication is the point.
func looksLikeCommand(trimmed string) bool {
	visible := strings.TrimLeftFunc(trimmed, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.Is(unicode.Cf, r)
	})
	for _, marker := range []string{"/", "／", "⁄", "∕"} {
		if strings.HasPrefix(visible, marker) {
			return true
		}
	}
	return false
}

// FuzzParseNeverDegradesToProse is the same property with inputs nobody
// thought of.
func FuzzParseNeverDegradesToProse(f *testing.F) {
	for _, s := range []string{
		"", " ", "/", "//", "/ls", "/stop w1:p1", "/stpo w1:p1", "／stop w1:p1",
		"hello", "look in /tmp", "/say w1:p1 hi", "/mirror w1:p1 on", "/ ",
		"\u200b/stop w1:p1", "\ufeff/stpo w1:p1", "\u2044stop w1:p1", "\u200b", "\u200bhello",
	} {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, s string) {
		got := Parse(s)

		trimmed := strings.TrimSpace(s)
		isCommand := looksLikeCommand(trimmed)

		if got.Kind == KindProse {
			if isCommand {
				t.Fatalf("Parse(%q) = KindProse for a command-shaped line (G1)", s)
			}
			if got.Text == "" || got.Text != trimmed {
				t.Fatalf("Parse(%q) = prose with Text %q, want %q", s, got.Text, trimmed)
			}
		}
		if trimmed == "" && got.Kind != KindBadArgs {
			t.Fatalf("Parse(%q) = %v, want bad-args for an empty message", s, got.Kind)
		}
		if (got.Kind == KindUnknown || got.Kind == KindBadArgs) && got.Reason == "" {
			t.Fatalf("Parse(%q) = %v with no Reason", s, got.Kind)
		}
		// Reason is user-facing: outbound.Split cuts at 4000 runes and puts no
		// cap on the number of chunks, so an unbounded echo of the input turns
		// one pasted blob into a burst of Feishu messages. The bound is loose
		// because %q can expand one rune into ten characters.
		if n := utf8.RuneCountInString(got.Reason); n > 600 {
			t.Fatalf("Parse(%q) = %v with a %d-rune Reason; it must be bounded", s, got.Kind, n)
		}
		if got.Pane != "" {
			if _, ok := normalizePane(got.Pane); !ok {
				t.Fatalf("Parse(%q) returned unusable Pane %q", s, got.Pane)
			}
		}
		if got.Raw != s {
			t.Fatalf("Parse(%q) lost the raw input: %q", s, got.Raw)
		}
	})
}
