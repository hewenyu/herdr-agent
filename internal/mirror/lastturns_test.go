package mirror

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The last thing each real session said. This is the line the "finished" card
// exists to carry: everything else in the file — and everything on the screen
// around it — is scrollback.
const (
	claudeFinalAnswer = "`a.md` contains a single line of text: `hi`. That's the entire file — no headings, structure, or other content."
	codexFinalAnswer  = "There are **2 files**: `a.md` and `from-phone.txt`."
)

type sampled struct {
	kind, path, answer string
}

func fixtures() []sampled {
	return []sampled{
		{"claude", claudeFixture, claudeFinalAnswer},
		{"codex", codexFixture, codexFinalAnswer},
	}
}

// One turn, and it is the answer.
func TestLastTurnsReturnsTheFinalAnswer(t *testing.T) {
	for _, f := range fixtures() {
		t.Run(f.kind, func(t *testing.T) {
			got, err := LastTurns(f.path, f.kind, 1)
			if err != nil {
				t.Fatalf("LastTurns: %v", err)
			}
			if len(got) != 1 {
				t.Fatalf("got %d turns, want 1: %v", len(got), got)
			}
			if got[0].Role != roleAssistant {
				t.Errorf("role = %q, want %q", got[0].Role, roleAssistant)
			}
			if got[0].Text != f.answer {
				t.Errorf("text =\n  %q\nwant\n  %q", got[0].Text, f.answer)
			}
			assertPlain(t, got)
		})
	}
}

// Both fixtures are far smaller than TailBytes, so the sample is the whole file
// and must agree with a full parse turn for turn — Seq included.
func TestLastTurnsIsTheTailOfAFullParse(t *testing.T) {
	for _, f := range fixtures() {
		full, _ := parseFixture(t, f.kind, f.path)
		for _, n := range []int{1, 2, 3, len(full), len(full) + 5, 100} {
			t.Run(fmt.Sprintf("%s/n-%d", f.kind, n), func(t *testing.T) {
				got, err := LastTurns(f.path, f.kind, n)
				if err != nil {
					t.Fatalf("LastTurns: %v", err)
				}
				want := full
				if n < len(want) {
					want = want[len(want)-n:]
				}
				if len(got) != len(want) {
					t.Fatalf("got %d turns, want %d", len(got), len(want))
				}
				if diff := diffTurns(want, got); diff != "" {
					t.Error(diff)
				}
			})
		}
	}
}

// Asking for more than the file holds is "fewer than n is fine", not an error —
// a session two turns old still deserves a card.
func TestLastTurnsShortSessionIsNotAnError(t *testing.T) {
	full, _ := parseFixture(t, "codex", codexFixture)
	got, err := LastTurns(codexFixture, "codex", 1000)
	if err != nil {
		t.Fatalf("LastTurns: %v", err)
	}
	if len(got) != len(full) {
		t.Fatalf("got %d turns, want all %d", len(got), len(full))
	}
}

// An agent kind with no parser can never start working on its own, so it is
// reported rather than mistaken for a quiet session.
func TestLastTurnsUnknownKindIsAnError(t *testing.T) {
	for _, kind := range []string{"gemini", "", "claude-code"} {
		t.Run(kind, func(t *testing.T) {
			got, err := LastTurns(claudeFixture, kind, 3)
			if err == nil {
				t.Fatalf("LastTurns(%q) = %v, want an error", kind, got)
			}
			if !errors.Is(err, ErrUnknownKind) {
				t.Errorf("err = %v, want it to wrap ErrUnknownKind", err)
			}
			if len(got) != 0 {
				t.Errorf("got %d turns alongside an error, want none", len(got))
			}
			if !strings.Contains(err.Error(), fmt.Sprintf("%q", kind)) {
				t.Errorf("err = %v, want it to name the kind", err)
			}
		})
	}
}

// "Nothing to show" — the states a live session passes through.
func TestLastTurnsNothingToShowIsNotAnError(t *testing.T) {
	dir := t.TempDir()
	empty := filepath.Join(dir, "empty.jsonl")
	writeFile(t, empty, "")
	noTurns := filepath.Join(dir, "lifecycle-only.jsonl")
	writeFile(t, noTurns, `{"type":"ai-title","aiTitle":"Reply with OK"}`+"\n"+
		`{"type":"file-history-snapshot","messageId":"x"}`+"\n")

	tests := []struct {
		name string
		path string
	}{
		// G8: the transcript only appears once SessionStart has fired, so an agent
		// that is detected but has not been trusted yet resolves to a path with no
		// file behind it.
		{"missing file", filepath.Join(dir, "does-not-exist.jsonl")},
		{"empty file", empty},
		{"records but no conversation", noTurns},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := LastTurns(tt.path, "claude", 5)
			if err != nil {
				t.Fatalf("LastTurns: %v, want nil — %s is not a failure to look", err, tt.name)
			}
			if len(got) != 0 {
				t.Fatalf("got %d turns, want none: %v", len(got), got)
			}
		})
	}
}

// "I could not look" — a caller that cannot tell this from an idle session
// would report a broken mirror as a quiet one forever.
func TestLastTurnsIOFailureIsAnError(t *testing.T) {
	dir := t.TempDir()

	t.Run("a directory where a transcript should be", func(t *testing.T) {
		got, err := LastTurns(dir, "claude", 5)
		if err == nil {
			t.Fatalf("LastTurns = %v, want an error", got)
		}
		if len(got) != 0 {
			t.Errorf("got %d turns alongside an error, want none", len(got))
		}
	})

	t.Run("unreadable file", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root ignores file permissions")
		}
		path := filepath.Join(dir, "locked.jsonl")
		writeFile(t, path, claudeLine("assistant", "hi"))
		if err := os.Chmod(path, 0o000); err != nil {
			t.Fatalf("chmod: %v", err)
		}
		t.Cleanup(func() { _ = os.Chmod(path, 0o600) })

		got, err := LastTurns(path, "claude", 5)
		if err == nil {
			t.Fatalf("LastTurns = %v, want an error", got)
		}
		if !errors.Is(err, os.ErrPermission) {
			t.Errorf("err = %v, want it to wrap the permission error", err)
		}
		if !strings.Contains(err.Error(), path) {
			t.Errorf("err = %v, want it to name the path", err)
		}
	})
}

// The production window, on a transcript big enough to need it. Every other
// test here either rides the off==0 branch — both fixtures are ~30 KB, an
// eighth of TailBytes — or injects a tiny window, so nothing else exercises the
// arithmetic that runs for every real long-lived session: seek to
// Size()-TailBytes, drop the record the cut landed in, parse the rest.
func TestLastTurnsSamplesTheEndOfAHugeTranscript(t *testing.T) {
	const (
		question = "现在几点了"
		answer   = "现在是下午 2:47。"
	)
	// Distinct filler per role, so a turn from the wrong end of the file, or a
	// fragment of one, cannot pass for the exchange being looked for.
	const (
		olderAsk    = "an hour of earlier turns "
		olderAnswer = "an earlier answer "
	)
	filler := claudeLine(roleUser, olderAsk+strings.Repeat("x", 300)) +
		claudeLine(roleAssistant, olderAnswer+strings.Repeat("y", 900))

	var b strings.Builder
	for b.Len() <= 4*TailBytes { // several windows deep
		b.WriteString(filler)
	}
	records := strings.Count(b.String(), "\n") + 2
	b.WriteString(claudeLine(roleUser, question))
	b.WriteString(claudeLine(roleAssistant, answer))

	path := filepath.Join(t.TempDir(), "long-session.jsonl")
	writeFile(t, path, b.String())
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if fi.Size() <= TailBytes {
		t.Fatalf("fixture is %d bytes, not larger than the %d-byte window this test exists to exercise",
			fi.Size(), TailBytes)
	}

	got, err := LastTurns(path, "claude", 4)
	if err != nil {
		t.Fatalf("LastTurns: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("got %d turns, want 4: %v", len(got), got)
	}
	assertPlain(t, got)

	last := got[3]
	if last.Role != roleAssistant || last.Text != answer {
		t.Errorf("last turn = %s %q, want %s %q", last.Role, last.Text, roleAssistant, answer)
	}
	if got[2].Role != roleUser || got[2].Text != question {
		t.Errorf("turn before it = %s %q, want the question %q", got[2].Role, got[2].Text, question)
	}
	// The two before that are the newest filler and nothing else: a contiguous
	// suffix of the file, in order, with no head fragment smuggled in.
	if got[0].Role != roleUser || !strings.HasPrefix(got[0].Text, olderAsk) {
		t.Errorf("turn 0 = %s %.40q, want a whole %s filler turn", got[0].Role, got[0].Text, roleUser)
	}
	if got[1].Role != roleAssistant || !strings.HasPrefix(got[1].Text, olderAnswer) {
		t.Errorf("turn 1 = %s %.40q, want a whole %s filler turn", got[1].Role, got[1].Text, roleAssistant)
	}

	// And it really was a sample: Seq counts records within the window, so
	// reading the whole file to reach the same four turns would put the last one
	// at ~records instead of a fraction of it. Cheap for one 1 MiB transcript,
	// the point on a day-old one.
	if last.Seq*2 >= uint64(records) {
		t.Errorf("last turn Seq = %d of %d records: the whole file was parsed, not the last %d bytes",
			last.Seq, records, TailBytes)
	}
}

// A record longer than the window leaves nothing complete to parse, and the
// caller falls back to the terminal — the eighteen lines of scrollback this
// sampler exists to replace. That is allowed (the window is a hard bound by
// contract) but it must not be SILENT: from the caller's side it is
// byte-identical to an idle session, so the only way to ever find out is for the
// sampler to say so.
func TestLastTurnsReportsAWindowWithNoCompleteRecord(t *testing.T) {
	// One claude assistant message at the model's output ceiling is roughly a
	// quarter of a megabyte, so this is the real TailBytes, not an injected one.
	t.Run("through the production window", func(t *testing.T) {
		logged := captureDefaultLog(t)
		path := filepath.Join(t.TempDir(), "huge-answer.jsonl")
		writeFile(t, path, claudeLine(roleUser, "summarise the repo")+
			claudeLine(roleAssistant, strings.Repeat("verbose ", TailBytes/4)))

		got, err := LastTurns(path, "claude", 5)
		if err != nil {
			t.Fatalf("LastTurns: %v, want nil — an unsampleable record is not a failure to look", err)
		}
		if len(got) != 0 {
			t.Fatalf("got %d turns from a window of pure fragment, want none: %v", len(got), got)
		}
		if !strings.Contains(logged.String(), path) {
			t.Errorf("the fall back to the screen was silent; log was %q", logged)
		}
	})

	// Both shapes it takes, and — as important — the ordinary cuts it must stay
	// quiet about, since a line on every sample is a line nobody reads.
	tests := []struct {
		name    string
		content string
		window  int64
		wantLog bool
	}{
		{"a record longer than the window", "AAAA\n" + strings.Repeat("B", 50) + "\n", 20, true},
		{"the same record still being written", "AAAA\n" + strings.Repeat("B", 50), 20, true},
		{"an ordinary cut has whole records after it", "AAAA\nBBBB\nCCCC\n", 10, false},
		{"a window larger than the file is all whole records", "AAAA\nBBBB\n", 1024, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logged := captureDefaultLog(t)
			path := filepath.Join(t.TempDir(), "session.jsonl")
			writeFile(t, path, tt.content)

			if _, err := lastTurns(&fakeParser{name: "fake"}, path, 5, tt.window); err != nil {
				t.Fatalf("lastTurns: %v", err)
			}
			if got := strings.Contains(logged.String(), path); got != tt.wantLog {
				t.Errorf("logged = %v, want %v; log was %q", got, tt.wantLog, logged)
			}
		})
	}
}

// captureDefaultLog redirects the package's logging — the sampler has no logger
// of its own, by contract it is a plain function — for the duration of one test.
func captureDefaultLog(t *testing.T) *strings.Builder {
	t.Helper()
	var b strings.Builder
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&b, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(restore) })
	return &b
}

// A window a fraction of TailBytes still lands on the answer, because the file
// is read from its end.
func TestLastTurnsSmallWindowStillReachesTheAnswer(t *testing.T) {
	tests := []struct {
		kind, path, answer string
		window             int64
	}{
		{"claude", claudeFixture, claudeFinalAnswer, 2000},
		{"claude", claudeFixture, claudeFinalAnswer, 8000},
		{"codex", codexFixture, codexFinalAnswer, 1600},
		{"codex", codexFixture, codexFinalAnswer, 8000},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%s/%d", tt.kind, tt.window), func(t *testing.T) {
			p, _ := ParserFor(tt.kind)
			got, err := lastTurns(p, tt.path, 1, tt.window)
			if err != nil {
				t.Fatalf("lastTurns: %v", err)
			}
			if len(got) != 1 {
				t.Fatalf("got %d turns, want 1: %v", len(got), got)
			}
			if got[0].Text != tt.answer {
				t.Errorf("text =\n  %q\nwant\n  %q", got[0].Text, tt.answer)
			}
			assertPlain(t, got)
		})
	}
}

// The property that makes a blind cut safe: whatever survives the discarded
// first record is a CONTIGUOUS SUFFIX of the turns a full parse produces. Never
// a turn the file does not contain, never a turn cut in half, never one out of
// order — which is what "a JSON fragment must not decide what the phone shows"
// means in practice.
func TestLastTurnsMidRecordCutNeverYieldsAMalformedTurn(t *testing.T) {
	for _, f := range fixtures() {
		full, _ := parseFixture(t, f.kind, f.path)
		want := turnKeys(full)
		size := int64(len(readFixture(t, f.path)))

		for _, window := range cutSizes(size) {
			p, _ := ParserFor(f.kind)
			got, err := lastTurns(p, f.path, len(full), window)
			if err != nil {
				t.Fatalf("%s: lastTurns(window=%d): %v", f.kind, window, err)
			}
			assertPlain(t, got)
			keys := turnKeys(got)
			if len(keys) > len(want) {
				t.Fatalf("%s: window=%d produced %d turns, more than the whole file's %d",
					f.kind, window, len(keys), len(want))
			}
			if suffix := want[len(want)-len(keys):]; strings.Join(keys, "\n") != strings.Join(suffix, "\n") {
				t.Fatalf("%s: window=%d is not a suffix of the full parse:\n got %q\nwant %q",
					f.kind, window, keys, suffix)
			}
		}
	}
}

// A window is only ever asked to give up what it cannot vouch for. Both of these
// are ordinary at 256 KiB too: a single agent message can be longer than that.
func TestLastTurnsWindowShorterThanOneRecord(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "session.jsonl")
	writeFile(t, path, claudeLine("assistant", strings.Repeat("long ", 200)))

	p, _ := ParserFor("claude")
	got, err := lastTurns(p, path, 5, 64)
	if err != nil {
		t.Fatalf("lastTurns: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("got %d turns from half a record, want none: %v", len(got), got)
	}
}

// The window is a byte count, not a record count, so the two ends of the file
// are handled differently on purpose: the first record of a cut window is
// dropped because its head was never read, and the first record of a whole file
// is kept because it is whole.
func TestLastTurnsDropsOnlyTheCutRecord(t *testing.T) {
	const content = "AAAA\nBBBB\nCCCC\n"
	path := filepath.Join(t.TempDir(), "records.jsonl")
	writeFile(t, path, content)

	tests := []struct {
		name   string
		window int64
		want   string
	}{
		{"window larger than the file keeps the first line", 1024, content},
		{"window exactly the file keeps the first line", int64(len(content)), content},
		{"cut inside the first line drops it", 8, "CCCC\n"},
		{"cut on a record boundary still drops a record", 10, "CCCC\n"},
		{"cut leaving no whole record yields nothing", 3, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &fakeParser{name: "fake"}
			if _, err := lastTurns(p, path, 5, tt.window); err != nil {
				t.Fatalf("lastTurns: %v", err)
			}
			if string(p.got) != tt.want {
				t.Fatalf("parser was handed %q, want %q", p.got, tt.want)
			}
		})
	}
}

// A window that contains no newline at all is all fragment.
func TestLastTurnsWindowWithoutANewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unterminated.jsonl")
	writeFile(t, path, "AAAA\nBBBBBBBBBB")

	p := &fakeParser{name: "fake"}
	if _, err := lastTurns(p, path, 5, 3); err != nil {
		t.Fatalf("lastTurns: %v", err)
	}
	if len(p.got) != 0 {
		t.Fatalf("parser was handed %q, want nothing", p.got)
	}
}

// A record still being written is not a turn, and nobody is coming with the
// rest of it — this is a one-shot sample, not a tail.
func TestLastTurnsIgnoresTheTrailingPartialRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeFile(t, path, claudeLine("assistant", "finished sentence")+
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"half writ`)

	got, err := LastTurns(path, "claude", 5)
	if err != nil {
		t.Fatalf("LastTurns: %v", err)
	}
	if len(got) != 1 || got[0].Text != "finished sentence" {
		t.Fatalf("got %v, want only the completed turn", got)
	}
}

func TestLastTurnsNonPositiveN(t *testing.T) {
	for _, n := range []int{0, -1} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			got, err := LastTurns(claudeFixture, "claude", n)
			if err != nil {
				t.Fatalf("LastTurns: %v", err)
			}
			if len(got) != 0 {
				t.Fatalf("got %d turns for n=%d, want none", len(got), n)
			}
		})
	}
}

// The shipped parsers never return an error, so this is about the day one does:
// a sample that produced turns is still worth showing, and one that produced
// nothing must not look like an idle session.
func TestLastTurnsParserError(t *testing.T) {
	boom := errors.New("boom")
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeFile(t, path, claudeLine("assistant", "hi"))

	t.Run("nothing parsed is reported", func(t *testing.T) {
		got, err := lastTurns(&fakeParser{name: "fake", err: boom}, path, 5, TailBytes)
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v, want it to wrap %v", err, boom)
		}
		if len(got) != 0 {
			t.Errorf("got %d turns alongside an error, want none", len(got))
		}
	})

	t.Run("what was parsed still wins", func(t *testing.T) {
		p := &fakeParser{name: "fake", err: boom, turns: []Turn{{Role: roleAssistant, Text: "salvaged"}}}
		got, err := lastTurns(p, path, 5, TailBytes)
		if err != nil {
			t.Fatalf("lastTurns: %v", err)
		}
		if len(got) != 1 || got[0].Text != "salvaged" {
			t.Fatalf("got %v, want the salvaged turn", got)
		}
	})
}

// The returned slice must not pin the rest of the window: n turns are kept and
// the other end of a 256 KiB sample is not the caller's problem.
func TestLastTurnsDoesNotAliasTheParsersSlice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeFile(t, path, claudeLine("assistant", "hi"))
	p := &fakeParser{name: "fake", turns: []Turn{
		{Role: roleAssistant, Text: "old"},
		{Role: roleAssistant, Text: "new"},
	}}

	got, err := lastTurns(p, path, 1, TailBytes)
	if err != nil {
		t.Fatalf("lastTurns: %v", err)
	}
	got[0].Text = "mutated"
	if p.turns[1].Text != "new" {
		t.Fatalf("writing to the result changed the parser's slice: %q", p.turns[1].Text)
	}
}

// fakeParser records what it was handed and returns whatever it was told to.
type fakeParser struct {
	name  string
	turns []Turn
	err   error
	got   []byte
}

func (p *fakeParser) Name() string { return p.name }

func (p *fakeParser) Parse(data []byte) ([]Turn, []byte, error) {
	p.got = append([]byte(nil), data...)
	return p.turns, nil, p.err
}

func turnKeys(turns []Turn) []string {
	keys := make([]string, 0, len(turns))
	for _, tn := range turns {
		// Seq is deliberately absent: it counts records within the window, so a
		// cut renumbers every claude turn while the conversation is unchanged.
		keys = append(keys, fmt.Sprintf("%s|%v|%q", tn.Role, tn.ToolCalls, tn.Text))
	}
	return keys
}

// cutSizes returns window sizes to cut a fixture at: dense over the last few
// records, where a "finished" card actually samples, and sparse over the rest.
func cutSizes(size int64) []int64 {
	var out []int64
	for w := int64(1); w < 3000 && w < size; w += 13 {
		out = append(out, w)
	}
	for w := int64(3000); w < size+64; w += size / 50 {
		out = append(out, w)
	}
	return append(out, size, size+1)
}
