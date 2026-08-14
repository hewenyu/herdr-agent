package setup

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// TestParseEnvLineMatchesTheParserTheBridgeUses. Every disagreement here is a
// credential that setup writes and the bridge does not read.
func TestParseEnvLineMatchesTheParserTheBridgeUses(t *testing.T) {
	cases := []struct {
		line, key, value string
		ok               bool
	}{
		{line: "FOO=bar", key: "FOO", value: "bar", ok: true},
		{line: "  FOO = bar  ", key: "FOO", value: "bar", ok: true},
		{line: "FOO=", key: "FOO", value: "", ok: true},
		{line: "FOO=a=b#c", key: "FOO", value: "a=b#c", ok: true}, // taken literally after the first '='
		{line: "FOO=bar\r", key: "FOO", value: "bar", ok: true},   // a CRLF file
		{line: "# FOO=bar"},      // comment
		{line: ""},               // blank
		{line: "no equals sign"}, // not an assignment
		{line: "export FOO=bar"}, // the format has no export keyword
		{line: "=bar"},           // no key
	}
	for _, tc := range cases {
		key, value, ok := parseEnvLine(tc.line)
		if ok != tc.ok || key != tc.key || value != tc.value {
			t.Errorf("parseEnvLine(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tc.line, key, value, ok, tc.key, tc.value, tc.ok)
		}
	}
}

func TestParseInlineArray(t *testing.T) {
	cases := []struct {
		rhs   string
		items []string
		tail  string
		ok    bool
	}{
		{rhs: ` []`, ok: true},
		{rhs: ` ["a"]`, items: []string{"a"}, ok: true},
		{rhs: ` ["a", 'b']  # note`, items: []string{"a", "b"}, tail: "  # note", ok: true},
		{rhs: ` [`},               // opens and never closes: a multi-line array
		{rhs: ` "not an array"`},  // not an array at all
		{rhs: ` ["unterminated]`}, // a quote with no partner

		// The array ends at the first ']' outside a quote, never the last one on
		// the line. Taking the last would delete the comment and — in the first
		// case, whose syntax the shipped example teaches at
		// deploy/config.example.toml:44 — promote an id nobody authorised into
		// feishu.allowed_open_ids, which is the authorization boundary (G10).
		{rhs: ` []  # e.g. ["ou_x"]`, tail: `  # e.g. ["ou_x"]`, ok: true},
		{rhs: ` ["a"] # step [3]`, items: []string{"a"}, tail: " # step [3]", ok: true},
	}
	for _, tc := range cases {
		items, tail, ok := parseInlineArray(tc.rhs)
		if ok != tc.ok || tail != tc.tail || !slices.Equal(items, tc.items) {
			t.Errorf("parseInlineArray(%q) = (%v, %q, %v), want (%v, %q, %v)",
				tc.rhs, items, tail, ok, tc.items, tc.tail, tc.ok)
		}
	}
}

func TestSectionName(t *testing.T) {
	cases := []struct {
		line, want string
		ok         bool
	}{
		{line: "[feishu]", want: "feishu", ok: true},
		{line: "  [ herdr ] ", want: "herdr", ok: true},
		{line: "[[array]]"}, // not a table, and its keys are not ours
		{line: "key = 1"},
		{line: "# [feishu]"},
	}
	for _, tc := range cases {
		got, ok := sectionName(tc.line)
		if ok != tc.ok || got != tc.want {
			t.Errorf("sectionName(%q) = (%q, %v), want (%q, %v)", tc.line, got, ok, tc.want, tc.ok)
		}
	}
}

func TestStringTail(t *testing.T) {
	cases := []struct{ rhs, want string }{
		{` "oc_1"  # where pushes go`, "  # where pushes go"},
		{` "oc_1"`, ""},
		{` `, ""},
		{` "unterminated`, ""},
	}
	for _, tc := range cases {
		if got := stringTail(tc.rhs); got != tc.want {
			t.Errorf("stringTail(%q) = %q, want %q", tc.rhs, got, tc.want)
		}
	}
}

func TestSplitAssignmentRejectsANonAssignment(t *testing.T) {
	if _, _, ok := splitAssignment("just words"); ok {
		t.Error("a line with no '=' was treated as an assignment")
	}
}

func TestSplitAndJoinLinesRoundTrip(t *testing.T) {
	for _, in := range []string{"", "a\n", "a\nb\n", "a\nb"} {
		got := string(joinLines(splitLines(in)))
		want := in
		if want != "" && want[len(want)-1] != '\n' {
			want += "\n" // an unterminated last line is terminated on the way out
		}
		if got != want {
			t.Errorf("round trip of %q = %q, want %q", in, got, want)
		}
	}
}

func TestValueReadsCardPayloads(t *testing.T) {
	if got := value(lark.Action{}, "n"); got != "" {
		t.Errorf("a nil payload returned %q", got)
	}
	if got := value(lark.Action{Value: map[string]any{"n": 42}}, "n"); got != "" {
		t.Errorf("a non-string field returned %q", got)
	}
	if got := value(lark.Action{Value: map[string]any{"n": "abc"}}, "n"); got != "abc" {
		t.Errorf("got %q", got)
	}
}

// TestUnreadableEnvFileIsAnErrorNotAnEmptyOne: silently treating it as absent
// would register a second app over credentials that are still there.
func TestUnreadableEnvFileIsAnErrorNotAnEmptyOne(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, config.DotEnvFileName), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if _, err := readCredentials(envPath(dir)); err == nil {
		t.Fatal("a directory named .env read as no credentials at all")
	}
}
