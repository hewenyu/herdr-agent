package commands

import "testing"

func TestLevenshtein(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"", "", 0},
		{"", "stop", 4},
		{"stop", "", 4},
		{"stop", "stop", 0},
		{"stpo", "stop", 2}, // transposition costs two in plain edit distance
		{"stap", "stop", 1},
		{"sop", "stop", 1},
		{"sstop", "stop", 1},
		{"mirro", "mirror", 1},
		{"doctor", "help", 6},
		{"停止", "stop", 4}, // distance is over runes, not bytes
	}
	for _, tc := range tests {
		if got := levenshtein(tc.a, tc.b); got != tc.want {
			t.Errorf("levenshtein(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestClosest(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"stpo", "stop", true},
		{"stpo", "stop", true},
		{"sto", "stop", true},
		{"stopp", "stop", true},
		{"halp", "help", true},
		{"hlep", "help", true},
		{"mirro", "mirror", true},
		{"mirrors", "mirror", true},
		{"docter", "doctor", true},
		{"l", "ls", true},
		{"lst", "ls", true},
		{"crad", "card", true},
		{"sya", "say", true},

		// three or more edits away: naming a command here would be guessing
		{"frobnicate", "", false},
		{"restart", "", false},
		{"", "", false},

		// a dialog answer is not a misspelling of a word. "/1" and "/y" are
		// someone trying to answer a permission dialog; telling them they
		// meant "/ls" is noise, and telling "/tab" it meant "/say" is advice
		// aimed at free text, which is the G1 path.
		{"1", "", false},
		{"12", "", false},
		{"y", "", false},
		{"n", "", false},
		{"yes", "", false},
		{"no", "", false},
		{"esc", "", false},
		{"up", "", false},
		{"down", "", false},
		{"tab", "", false},
		{"enter", "", false},
	}
	for _, tc := range tests {
		got, ok := closest(tc.in)
		if ok != tc.ok {
			t.Errorf("closest(%q) ok = %v, want %v (got %q)", tc.in, ok, tc.ok, got)
			continue
		}
		if got != tc.want {
			t.Errorf("closest(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// isDialogAnswer decides between two very different error messages, so it has
// to be right at the edges: the S1 §4 key whitelist and the digits of Claude's
// "1. Yes / 2. Yes,always / 3. No" menu are dialog answers; a command name is
// not, and neither is the empty string (an empty name means a bare slash,
// which Parse handles before it ever asks).
func TestIsDialogAnswer(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{"1", true},
		{"2", true},
		{"9", true},
		{"12", true},
		{"y", true},
		{"n", true},
		{"yes", true},
		{"no", true},
		{"enter", true},
		{"esc", true},
		{"up", true},
		{"down", true},
		{"tab", true},

		{"", false},
		{"1a", false},
		{"Y", false}, // Parse lowercases before it gets here
		{"escape", false},
		{"stop", false},
		{"ls", false},
		{"say", false},
	}
	for _, tc := range tests {
		if got := isDialogAnswer(tc.in); got != tc.want {
			t.Errorf("isDialogAnswer(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

// The length prefilter in closest() must count runes on BOTH sides.
//
// levenshtein measures runes, so comparing the typo's rune count against the
// candidate's byte length is a latent trap: it is invisible while every
// command name is ASCII, and the day one is not, the prefilter judges a
// one-edit typo six apart and skips the only candidate that could have
// matched — the suggestion vanishes with no other symptom. Swapping the table
// is the only way to observe it, since the real table is all ASCII.
func TestClosestPrefilterCountsRunesNotBytes(t *testing.T) {
	saved := table
	defer func() { table = saved }()
	table = []spec{{name: "镜像", kind: KindMirror, args: "<pane> on|off", parse: parseMirror}}

	if got, ok := closest("镜"); !ok || got != "镜像" {
		t.Errorf("closest(%q) = %q, %v; want %q — a byte-length prefilter skipped the candidate", "镜", got, ok, "镜像")
	}
}

// Every real command name must resolve to itself, otherwise the tie-breaking
// order is wrong and a typo would be pointed at the wrong command.
func TestClosestIsIdentityOnRealNames(t *testing.T) {
	for _, sp := range table {
		got, ok := closest(sp.name)
		if !ok || got != sp.name {
			t.Errorf("closest(%q) = %q, %v; want the name itself", sp.name, got, ok)
		}
	}
}

// The suggestion is advice, never an action: a typo must still come back as
// KindUnknown, never as the command it resembles.
func TestSuggestionDoesNotExecute(t *testing.T) {
	for _, in := range []string{"/stpo w1:p1", "/sya w1:p1 hello", "/mirro w1:p1 on", "/crad w1:p1"} {
		if got := Parse(in); got.Kind != KindUnknown {
			t.Errorf("Parse(%q) = %v, want unknown; a near-miss must not run", in, got.Kind)
		}
	}
}
