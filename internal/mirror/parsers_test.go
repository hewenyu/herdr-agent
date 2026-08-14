package mirror

import (
	"bytes"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	claudeFixture = "testdata/claude-session.jsonl"
	codexFixture  = "testdata/codex-rollout.jsonl"
	// claudeCommandFixture holds the records a slash command writes. The record
	// shapes — a meta <local-command-caveat>, the three-element
	// <command-name>/<command-message>/<command-args> block, and the
	// <local-command-stdout> with its ANSI still in it — were read off a live
	// claude-code v2.1.231 transcript under ~/.claude/projects; the payloads are
	// re-keyed to the same probe session as claude-session.jsonl rather than
	// copied, because a personal transcript does not belong in a repo.
	claudeCommandFixture = "testdata/claude-commands.jsonl"
)

func TestParserFor(t *testing.T) {
	tests := []struct {
		kind string
		want string // parser name; "" means no parser
	}{
		{"claude", "claude"},
		{"codex", "codex"},
		{"CLAUDE", "claude"},
		{" codex ", "codex"},
		{"gemini", ""},
		{"", ""},
		{"claude-code", ""},
	}
	for _, tt := range tests {
		t.Run(tt.kind, func(t *testing.T) {
			p, ok := ParserFor(tt.kind)
			if ok != (tt.want != "") {
				t.Fatalf("ParserFor(%q) ok = %v, want %v", tt.kind, ok, tt.want != "")
			}
			if !ok {
				if p != nil {
					t.Fatalf("ParserFor(%q) returned a parser with ok=false", tt.kind)
				}
				return
			}
			if got := p.Name(); got != tt.want {
				t.Fatalf("Name() = %q, want %q", got, tt.want)
			}
		})
	}
}

// A parser holds the record counter for ONE file, so handing the same instance
// to two panes would number the second pane's turns as a continuation of the
// first.
func TestParserForReturnsIndependentInstances(t *testing.T) {
	line := []byte(`{"type":"user","timestamp":"2026-08-13T14:59:32.011Z","message":{"role":"user","content":"hi"}}` + "\n")

	first, _ := ParserFor("claude")
	if _, _, err := first.Parse(line); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	turns, _, err := first.Parse(line)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if turns[0].Seq != 1 {
		t.Fatalf("second record of the same parser: Seq = %d, want 1", turns[0].Seq)
	}

	second, _ := ParserFor("claude")
	turns, _, err = second.Parse(line)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if turns[0].Seq != 0 {
		t.Fatalf("fresh parser: Seq = %d, want 0", turns[0].Seq)
	}
}

// A clock is the least valuable field in a record, so it is read from the raw
// JSON: whatever shape it turns up in, the text still has to reach the phone.
func TestParseTime(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string // RFC3339 in UTC, "" means the zero time
		log  bool
	}{
		{name: "rfc3339 with millis", raw: `"2026-08-13T14:59:32.011Z"`, want: "2026-08-13T14:59:32.011Z"},
		{name: "rfc3339 with an offset", raw: `"2026-08-13T22:59:32+08:00"`, want: "2026-08-13T14:59:32Z"},
		{name: "absent", raw: ``},
		{name: "null", raw: `null`},
		{name: "empty string", raw: `""`},
		{name: "epoch seconds", raw: `1786635828`, want: "2026-08-13T15:43:48Z"},
		{name: "epoch seconds with a fraction", raw: `1786635828.5`, want: "2026-08-13T15:43:48.5Z"},
		{name: "epoch millis", raw: `1786635828011`, want: "2026-08-13T15:43:48.011Z"},
		{name: "epoch micros", raw: `1786635828011000`, want: "2026-08-13T15:43:48.011Z"},
		{name: "epoch nanos", raw: `1786635828011000000`, want: "2026-08-13T15:43:48.011Z"},
		{name: "zero is no time at all", raw: `0`},
		{name: "unparseable string", raw: `"yesterday"`, log: true},
		{name: "an object where a clock should be", raw: `{"iso":"2026-08-13T14:59:32Z"}`, log: true},
		{name: "a list where a clock should be", raw: `[2026,8,13]`, log: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var buf bytes.Buffer
			log := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
			got := parseTime([]byte(tt.raw), log, 7)
			if tt.want == "" {
				if !got.IsZero() {
					t.Errorf("parseTime(%s) = %v, want the zero time", tt.raw, got)
				}
			} else if !got.Equal(mustTime(t, tt.want)) {
				t.Errorf("parseTime(%s) = %v, want %s", tt.raw, got.UTC(), tt.want)
			}
			if logged := strings.Contains(buf.String(), "unreadable transcript timestamp"); logged != tt.log {
				t.Errorf("logged = %v, want %v; log: %s", logged, tt.log, buf.String())
			}
		})
	}
}

func TestSplitLines(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		lines []string
		rest  string
	}{
		{"empty", "", nil, ""},
		{"no newline at all is all partial", "{\"a\":1}", nil, `{"a":1}`},
		{"one whole line", "a\n", []string{"a"}, ""},
		{"trailing partial", "a\nb\nhalf-writt", []string{"a", "b"}, "half-writt"},
		{"crlf", "a\r\nb\r\n", []string{"a", "b"}, ""},
		{"blank lines are not records", "\n\na\n\n", []string{"a"}, ""},
		{"blank partial", "a\n   ", []string{"a"}, "   "},
		{"inner whitespace kept", " a \n", []string{" a "}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lines, rest := splitLines([]byte(tt.in))
			var got []string
			for _, l := range lines {
				got = append(got, string(l))
			}
			if strings.Join(got, "|") != strings.Join(tt.lines, "|") {
				t.Errorf("lines = %q, want %q", got, tt.lines)
			}
			if string(rest) != tt.rest {
				t.Errorf("rest = %q, want %q", rest, tt.rest)
			}
			if tt.rest == "" && rest != nil {
				t.Errorf("rest = %v, want nil when there is no partial line", rest)
			}
		})
	}
}

// rest is prepended to the next read with append(), which would write through
// into the caller's buffer if it were a sub-slice of it.
func TestSplitLinesRestDoesNotAliasInput(t *testing.T) {
	data := []byte("whole\npart")
	_, rest := splitLines(data)
	copy(data[6:], "XXXX")
	if string(rest) != "part" {
		t.Fatalf("rest = %q after mutating the source buffer, want %q", rest, "part")
	}
}

// The tailer hands over whatever fsnotify woke it up with: a line may arrive in
// any number of pieces. Reassembly through rest must produce exactly the turns
// a single read would have.
func TestParseIsChunkSizeIndependent(t *testing.T) {
	for _, f := range []struct {
		kind, path string
		chunks     []int
	}{
		{"claude", claudeFixture, []int{1, 7, 64, 1024}},
		{"codex", codexFixture, []int{7, 64, 1024, 65536}},
	} {
		data := readFixture(t, f.path)
		p, _ := ParserFor(f.kind)
		want, rest, err := p.Parse(data)
		if err != nil {
			t.Fatalf("%s: Parse: %v", f.kind, err)
		}
		if len(rest) != 0 {
			t.Fatalf("%s: fixture ends with a newline, so rest should be empty, got %q", f.kind, rest)
		}
		if len(want) == 0 {
			t.Fatalf("%s: fixture produced no turns", f.kind)
		}

		for _, n := range f.chunks {
			t.Run(fmt.Sprintf("%s/chunk-%d", f.kind, n), func(t *testing.T) {
				p, _ := ParserFor(f.kind)
				var got []Turn
				var carry []byte
				for i := 0; i < len(data); i += n {
					end := min(i+n, len(data))
					buf := append(carry, data[i:end]...)
					turns, rest, err := p.Parse(buf)
					if err != nil {
						t.Fatalf("Parse: %v", err)
					}
					got = append(got, turns...)
					carry = rest
				}
				if len(carry) != 0 {
					t.Errorf("carry = %q, want empty", carry)
				}
				if diff := diffTurns(want, got); diff != "" {
					t.Error(diff)
				}
			})
		}
	}
}

func readFixture(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return data
}

// parseFixture runs a whole fixture through a parser wired to a captured
// logger, and returns the turns plus everything logged.
func parseFixture(t *testing.T, kind, path string) ([]Turn, string) {
	t.Helper()
	var log bytes.Buffer
	p := newParser(t, kind, &log)
	turns, rest, err := p.Parse(readFixture(t, path))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(rest) != 0 {
		t.Fatalf("rest = %q, want empty", rest)
	}
	return turns, log.String()
}

func newParser(t *testing.T, kind string, log *bytes.Buffer) Parser {
	t.Helper()
	l := slog.New(slog.NewTextHandler(log, &slog.HandlerOptions{Level: slog.LevelDebug}))
	switch kind {
	case "claude":
		return newClaudeParser(l)
	case "codex":
		return newCodexParser(l)
	default:
		t.Fatalf("no parser for kind %q", kind)
		return nil
	}
}

// formatTurn is the golden representation of one turn: everything the contract
// promises, and nothing else.
func formatTurn(tn Turn) string {
	at := "-"
	if !tn.At.IsZero() {
		at = tn.At.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return fmt.Sprintf("%d %s at=%s tools=%v text=%q", tn.Seq, tn.Role, at, tn.ToolCalls, tn.Text)
}

func diffTurns(want, got []Turn) string {
	var b strings.Builder
	for i := 0; i < len(want) || i < len(got); i++ {
		w, g := "<missing>", "<extra>"
		if i < len(want) {
			w = formatTurn(want[i])
		}
		if i < len(got) {
			g = formatTurn(got[i])
		}
		if w != g {
			fmt.Fprintf(&b, "turn %d:\n  want %s\n   got %s\n", i, w, g)
		}
	}
	return b.String()
}

func checkGolden(t *testing.T, got []Turn, want []string) {
	t.Helper()
	for i := 0; i < len(want) || i < len(got); i++ {
		switch {
		case i >= len(got):
			t.Errorf("turn %d missing, want %s", i, want[i])
		case i >= len(want):
			t.Errorf("turn %d unexpected: %s", i, formatTurn(got[i]))
		default:
			if g := formatTurn(got[i]); g != want[i] {
				t.Errorf("turn %d:\n  want %s\n   got %s", i, want[i], g)
			}
		}
	}
}

// Every turn a phone is shown must already be plain: the acceptance criterion
// is "no ANSI, no box drawing" (S2 §4.9).
func assertPlain(t *testing.T, turns []Turn) {
	t.Helper()
	for _, tn := range turns {
		texts := append([]string{tn.Text}, tn.ToolCalls...)
		for _, s := range texts {
			if strings.ContainsRune(s, 0x1b) {
				t.Errorf("seq %d: text contains an ESC: %q", tn.Seq, s)
			}
			for _, r := range s {
				if isBoxDrawing(r) {
					t.Errorf("seq %d: text contains box drawing %q: %q", tn.Seq, r, s)
				}
				if r != '\n' && r != '\t' && r < 0x20 {
					t.Errorf("seq %d: text contains control %U: %q", tn.Seq, r, s)
				}
			}
		}
		if tn.Role != roleUser && tn.Role != roleAssistant {
			t.Errorf("seq %d: role = %q, want user or assistant", tn.Seq, tn.Role)
		}
	}
}

// mustTime parses a fixture timestamp for tests that assert on time values.
func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("bad test timestamp %q: %v", s, err)
	}
	return v
}
