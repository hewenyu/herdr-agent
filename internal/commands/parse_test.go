package commands

import (
	"strings"
	"testing"
)

// Parse must keep satisfying the Parser interface declared in contract.go.
type parserFunc func(string) Command

func (f parserFunc) Parse(s string) Command { return f(s) }

var _ Parser = parserFunc(Parse)

func TestParse(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want Command
		// reasonHas, when set, must appear in Reason. Reason wording is free,
		// its content is not.
		reasonHas string
	}{
		// --- prose -------------------------------------------------------
		{
			name: "plain text is prose",
			in:   "how is the build going",
			want: Command{Kind: KindProse, Text: "how is the build going"},
		},
		{
			name: "prose is trimmed",
			in:   "  \n hello \t ",
			want: Command{Kind: KindProse, Text: "hello"},
		},
		{
			name: "prose may contain a slash",
			in:   "look in /tmp/herdr-accept please",
			want: Command{Kind: KindProse, Text: "look in /tmp/herdr-accept please"},
		},
		{
			name: "multiline prose keeps its layout",
			in:   "first line\n\nsecond line",
			want: Command{Kind: KindProse, Text: "first line\n\nsecond line"},
		},

		// --- empty -------------------------------------------------------
		{
			name:      "empty input",
			in:        "",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "empty",
		},
		{
			name:      "whitespace only input",
			in:        " \t\n ",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "empty",
		},

		// --- /ls, /doctor, /help ----------------------------------------
		{name: "ls", in: "/ls", want: Command{Kind: KindLs}},
		{name: "ls tolerates junk", in: "/ls now please", want: Command{Kind: KindLs}},
		{name: "ls is case insensitive", in: "/LS", want: Command{Kind: KindLs}},
		{name: "ls with leading space", in: "   /ls", want: Command{Kind: KindLs}},
		{name: "doctor", in: "/doctor", want: Command{Kind: KindDoctor}},
		{name: "help", in: "/help", want: Command{Kind: KindHelp}},
		{name: "clear", in: "/clear", want: Command{Kind: KindClear}},
		{name: "clear is case insensitive", in: "/CLEAR", want: Command{Kind: KindClear}},
		{name: "clear with whitespace", in: " \t/ clear\n", want: Command{Kind: KindClear}},
		{name: "clear with fullwidth slash", in: "／clear", want: Command{Kind: KindClear}},
		{name: "clear with fraction slash", in: "⁄clear", want: Command{Kind: KindClear}},
		{name: "clear with division slash", in: "∕clear", want: Command{Kind: KindClear}},
		{name: "clear rejects inline request", in: "/clear 创建一个新项目", want: Command{Kind: KindBadArgs}, reasonHas: "请单独发送 /clear"},
		{name: "clear rejects multiline request", in: "/clear\n创建一个新项目", want: Command{Kind: KindBadArgs}, reasonHas: "再发送新需求"},
		{name: "help tolerates junk", in: "/help me", want: Command{Kind: KindHelp}},

		// --- /card -------------------------------------------------------
		{name: "card", in: "/card w1:p1", want: Command{Kind: KindCard, Pane: "w1:p1"}},
		{name: "card uppercase pane", in: "/card W2:P10", want: Command{Kind: KindCard, Pane: "w2:p10"}},
		{name: "card tolerates trailing words", in: "/card w1:p1 please", want: Command{Kind: KindCard, Pane: "w1:p1"}},
		{
			name:      "card without pane",
			in:        "/card",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "/card <pane>",
		},
		{
			name:      "card with a non-pane",
			in:        "/card frontend",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "not a pane id",
		},

		// --- /stop -------------------------------------------------------
		{name: "stop", in: "/stop w1:p1", want: Command{Kind: KindStop, Pane: "w1:p1"}},
		{name: "stop legacy dash pane", in: "/stop w1-1", want: Command{Kind: KindStop, Pane: "w1-1"}},
		{name: "stop bare index", in: "/stop 3", want: Command{Kind: KindStop, Pane: "3"}},
		{
			// G2: esc is the safe way out. An extra word must not stand
			// between a worried user and the escape hatch.
			name: "stop tolerates trailing words",
			in:   "/stop w1:p1 right now",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name:      "stop without pane",
			in:        "/stop",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "/stop <pane>",
		},

		// --- /say --------------------------------------------------------
		{
			name: "say",
			in:   "/say w1:p1 use the other branch",
			want: Command{Kind: KindSay, Pane: "w1:p1", Text: "use the other branch"},
		},
		{
			name: "say keeps internal whitespace and newlines",
			in:   "/say w1:p1 line one\n  line two",
			want: Command{Kind: KindSay, Pane: "w1:p1", Text: "line one\n  line two"},
		},
		{
			name: "say text may start with a slash",
			in:   "/say w1:p1 /tmp/x is the file",
			want: Command{Kind: KindSay, Pane: "w1:p1", Text: "/tmp/x is the file"},
		},
		{
			name:      "say without text",
			in:        "/say w1:p1",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "no text",
		},
		{
			name:      "say without text but with trailing space",
			in:        "/say w1:p1   ",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "no text",
		},
		{
			name:      "say with a bad pane does not become prose",
			in:        "/say hello there",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "not a pane id",
		},
		{
			name:      "say with nothing at all",
			in:        "/say",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "/say <pane> <text>",
		},

		// --- /mirror -----------------------------------------------------
		{name: "mirror on", in: "/mirror w1:p1 on", want: Command{Kind: KindMirror, Pane: "w1:p1", On: true}},
		{name: "mirror off", in: "/mirror w1:p1 off", want: Command{Kind: KindMirror, Pane: "w1:p1", On: false}},
		{name: "mirror ON uppercase", in: "/mirror w1:p1 ON", want: Command{Kind: KindMirror, Pane: "w1:p1", On: true}},
		{
			name:      "mirror without state",
			in:        "/mirror w1:p1",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "on or off",
		},
		{
			name:      "mirror with a state we do not know",
			in:        "/mirror w1:p1 yes",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "neither on nor off",
		},
		{
			name:      "mirror rejects trailing junk",
			in:        "/mirror w1:p1 on please",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "please",
		},
		{
			name:      "mirror without arguments",
			in:        "/mirror",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "/mirror <pane> on|off",
		},

		// --- unknown -----------------------------------------------------
		{
			name:      "typo names the closest command",
			in:        "/stpo w1:p1",
			want:      Command{Kind: KindUnknown},
			reasonHas: "/stop",
		},
		{
			name:      "single deletion names the closest command",
			in:        "/mirro w1:p1 on",
			want:      Command{Kind: KindUnknown},
			reasonHas: "/mirror",
		},
		{
			name:      "far-away word gets no suggestion but does get help",
			in:        "/frobnicate",
			want:      Command{Kind: KindUnknown},
			reasonHas: helpHint,
		},
		{
			name:      "an absolute path is not a command and not prose",
			in:        "/tmp/herdr-accept",
			want:      Command{Kind: KindUnknown},
			reasonHas: helpHint,
		},
		{
			name:      "bare slash",
			in:        "/",
			want:      Command{Kind: KindUnknown},
			reasonHas: "slash",
		},
		{
			// A stray space after the marker is a phone typo, not a new
			// meaning. Either way the line is a command, never prose.
			name: "slash then space is still a command",
			in:   "/ stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name:      "slash then space then nonsense",
			in:        "/ frobnicate",
			want:      Command{Kind: KindUnknown},
			reasonHas: helpHint,
		},
		{
			name:      "double slash",
			in:        "//stop w1:p1",
			want:      Command{Kind: KindUnknown},
			reasonHas: helpHint,
		},
		{
			// A fullwidth solidus is what a Chinese IME gives you for "/".
			// Treating it as prose would send this line to the agent (G1).
			name: "fullwidth solidus opens a command",
			in:   "／stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name:      "fullwidth solidus with a typo is still not prose",
			in:        "／stpo w1:p1",
			want:      Command{Kind: KindUnknown},
			reasonHas: "/stop",
		},
		{
			name: "ideographic space still separates arguments",
			in:   "/stop　w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name: "non-breaking space still separates arguments",
			in:   "/stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},

		// --- invisible characters in front of the marker -----------------
		{
			// strings.TrimSpace uses unicode.White_Space, which does not cover
			// category Cf. A zero-width space the user cannot see would
			// otherwise make this line "not start with a slash" and send the
			// whole command to the agent as text (G1).
			name: "zero-width space before the marker",
			in:   "\u200b/stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name: "BOM before the marker",
			in:   "\ufeff/stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name: "direction override before the marker",
			in:   "\u202e/stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name:      "invisible prefix on a typo is still not prose",
			in:        "\u200b/stpo w1:p1",
			want:      Command{Kind: KindUnknown},
			reasonHas: "/stop",
		},
		{
			name:      "a message of nothing but invisible characters is empty",
			in:        "\u200b\ufeff",
			want:      Command{Kind: KindBadArgs},
			reasonHas: "empty",
		},
		{
			// The stripping is for the marker test only. What the user typed is
			// what the agent gets.
			name: "an invisible character inside prose is left alone",
			in:   "\u200bhello there",
			want: Command{Kind: KindProse, Text: "\u200bhello there"},
		},
		{
			name: "fraction slash opens a command",
			in:   "\u2044stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},
		{
			name: "division slash opens a command",
			in:   "\u2215stop w1:p1",
			want: Command{Kind: KindStop, Pane: "w1:p1"},
		},

		// --- dialog answers ----------------------------------------------
		{
			// "/1" is someone answering Claude's "1. Yes / 2. Yes,always /
			// 3. No" menu from the chat window (G1). The useful reply names the
			// card buttons and esc (G2), not a spelling guess.
			name:      "a digit is read as a dialog answer",
			in:        "/1",
			want:      Command{Kind: KindUnknown},
			reasonHas: "/stop <pane>",
		},
		{
			name:      "y is read as a dialog answer",
			in:        "/y",
			want:      Command{Kind: KindUnknown},
			reasonHas: "dialog",
		},
		{
			name:      "esc is read as a dialog answer",
			in:        "/esc",
			want:      Command{Kind: KindUnknown},
			reasonHas: "dialog",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Parse(tc.in)

			if got.Kind != tc.want.Kind {
				t.Fatalf("Kind = %v, want %v (reason %q)", got.Kind, tc.want.Kind, got.Reason)
			}
			if got.Pane != tc.want.Pane {
				t.Errorf("Pane = %q, want %q", got.Pane, tc.want.Pane)
			}
			if got.Text != tc.want.Text {
				t.Errorf("Text = %q, want %q", got.Text, tc.want.Text)
			}
			if got.On != tc.want.On {
				t.Errorf("On = %v, want %v", got.On, tc.want.On)
			}
			if got.Raw != tc.in {
				t.Errorf("Raw = %q, want the input verbatim %q", got.Raw, tc.in)
			}
			if tc.reasonHas != "" && !strings.Contains(got.Reason, tc.reasonHas) {
				t.Errorf("Reason = %q, want it to mention %q", got.Reason, tc.reasonHas)
			}
			checkInvariants(t, tc.in, got)
		})
	}
}

// checkInvariants holds for every Command the parser can ever return.
func checkInvariants(t *testing.T, in string, c Command) {
	t.Helper()

	switch c.Kind {
	case KindUnknown, KindBadArgs:
		if strings.TrimSpace(c.Reason) == "" {
			t.Errorf("Parse(%q): %v with no Reason; the user would get a silent failure", in, c.Kind)
		}
		// Half-parsed fields must not leak: a caller acting on them would be
		// acting on a line we refused to understand.
		if c.Pane != "" || c.Text != "" {
			t.Errorf("Parse(%q): %v carries Pane=%q Text=%q, want both empty", in, c.Kind, c.Pane, c.Text)
		}
	case KindProse:
		if c.Text == "" {
			t.Errorf("Parse(%q): prose with empty Text", in)
		}
		if c.Text != strings.TrimSpace(c.Text) {
			t.Errorf("Parse(%q): prose Text %q is not trimmed", in, c.Text)
		}
	case KindCard, KindStop, KindSay, KindMirror:
		if _, ok := normalizePane(c.Pane); !ok {
			t.Errorf("Parse(%q): %v carries unusable Pane %q", in, c.Kind, c.Pane)
		}
	}
	if c.Kind == KindSay && c.Text == "" {
		t.Errorf("Parse(%q): say with empty Text", in)
	}
}

func TestParseIsDeterministic(t *testing.T) {
	for _, in := range []string{"/ls", "/say w1:p1 hi", "/stpo w1:p1", "hello", ""} {
		if a, b := Parse(in), Parse(in); a != b {
			t.Errorf("Parse(%q) returned %+v then %+v", in, a, b)
		}
	}
}

func TestKindStringIsStable(t *testing.T) {
	// The strings end up in logs and in user-facing errors; a silent rename
	// would break both.
	want := map[Kind]string{
		KindProse:   "prose",
		KindLs:      "ls",
		KindCard:    "card",
		KindSay:     "say",
		KindStop:    "stop",
		KindMirror:  "mirror",
		KindDoctor:  "doctor",
		KindHelp:    "help",
		KindClear:   "clear",
		KindUnknown: "unknown",
		KindBadArgs: "bad-args",
	}
	for k, s := range want {
		if got := k.String(); got != s {
			t.Errorf("Kind(%d).String() = %q, want %q", int(k), got, s)
		}
	}
}

// TestFullwidthSolidusRefusesLegitimateChineseText pins a deliberate deviation
// from contract.go, which says "anything not starting with '/' => KindProse".
//
// Treating U+FF0F as a command marker is what makes "\uff0fstop w1:p1" from a
// Chinese IME a command instead of an approval (G1), and it is not free: a
// legitimate Chinese message that happens to open with a fullwidth solidus is
// now refused. That trade-off is accepted, so it has to be visible here — and
// the refusal must tell the user how to get the line through, or they will
// retype it as prose and hit G1 by the other door.
func TestFullwidthSolidusRefusesLegitimateChineseText(t *testing.T) {
	got := Parse("\uff0f\u4f60\u597d")

	if got.Kind == KindProse {
		t.Fatalf("Parse = KindProse; the fullwidth solidus must stay a command marker (G1)")
	}
	if got.Kind != KindUnknown {
		t.Fatalf("Kind = %v, want unknown", got.Kind)
	}
	if !strings.Contains(got.Reason, "/say <pane> <text>") {
		t.Errorf("Reason = %q; a refused line must name the safe way to send text", got.Reason)
	}
}

// TestReasonIsBounded: Reason is user-facing and outbound.Split cuts at 4000
// runes with no cap on the number of chunks, so echoing the offending token
// back without a bound turns one pasted whitespace-free blob (a long URL path,
// a base64 line) into a burst of Feishu messages.
func TestReasonIsBounded(t *testing.T) {
	blob := strings.Repeat("x", 100000)
	for _, in := range []string{
		"/" + blob,
		"/stop " + blob,
		"/say " + blob + " hello",
		"/mirror w1:p1 " + blob,
		"/mirror w1:p1 on " + blob,
	} {
		got := Parse(in)
		if got.Kind == KindProse {
			t.Fatalf("Parse(<%d-byte slash line>) = KindProse (G1)", len(in))
		}
		if n := len([]rune(got.Reason)); n >= 200 {
			t.Errorf("Parse(%.20q...) Reason is %d runes, want it truncated", in, n)
		}
	}
}

// A dialog answer is not a misspelling. Suggesting /ls to someone who typed
// "/y" is noise; suggesting /say to someone who typed "/tab" is advice
// pointing straight at free text, which is the G1 path.
func TestDialogAnswersAreNotReportedAsTypos(t *testing.T) {
	for _, in := range []string{"/1", "/2", "/3", "/y", "/n", "/yes", "/no", "/esc", "/up", "/down", "/tab", "/enter"} {
		got := Parse(in)
		if got.Kind != KindUnknown {
			t.Errorf("Parse(%q) = %v, want unknown", in, got.Kind)
			continue
		}
		if strings.Contains(got.Reason, "did you mean") {
			t.Errorf("Parse(%q) Reason = %q; a dialog answer is not a typo for a command", in, got.Reason)
		}
		if !strings.Contains(got.Reason, "/stop <pane>") {
			t.Errorf("Parse(%q) Reason = %q; it should point at the card buttons and esc (G2)", in, got.Reason)
		}
	}
}
