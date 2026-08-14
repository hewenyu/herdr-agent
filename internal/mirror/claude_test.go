package mirror

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

// The whole turn list of the real session, from the real file. Seq is the
// record's position in the file (0-based), which is why the numbers have gaps:
// ai-title, system, file-history-snapshot, attachment, mode, permission-mode
// and the two tool_result records all occupy positions without producing turns.
func TestClaudeFixtureGolden(t *testing.T) {
	turns, _ := parseFixture(t, "claude", claudeFixture)

	checkGolden(t, turns, []string{
		`3 user at=2026-08-13T14:59:32.011Z tools=[] text="Reply with just: OK"`,
		`7 assistant at=2026-08-13T14:59:36.675Z tools=[] text="OK"`,
		`10 user at=2026-08-13T15:25:10.804Z tools=[] text="Use the Bash tool to run exactly: touch /tmp/herdr-probe2/from-phone.txt"`,
		`11 assistant at=2026-08-13T15:25:16.704Z tools=[Bash(touch /tmp/herdr-probe2/from-phone.txt)] text=""`,
		`13 assistant at=2026-08-13T15:29:08.545Z tools=[] text="Done. ` + "`/tmp/herdr-probe2/from-phone.txt`" + ` created."`,
		`16 user at=2026-08-13T15:44:25.280Z tools=[] text="1Read the file a.md in this directory and then tell me in two sentences what it contains."`,
		`17 assistant at=2026-08-13T15:44:30.239Z tools=[Read(/private/tmp/herdr-probe2/a.md)] text=""`,
		`23 assistant at=2026-08-13T15:44:33.245Z tools=[] text="` + "`a.md`" + ` contains a single line of text: ` + "`hi`" + `. That's the entire file — no headings, structure, or other content."`,
	})
	assertPlain(t, turns)
}

// G16's approval round trip lives in this fixture: the Bash call the phone
// approved, and the sentence the agent said afterwards.
func TestClaudeFixtureExtractsTheApprovedCommand(t *testing.T) {
	turns, _ := parseFixture(t, "claude", claudeFixture)

	var tools []string
	for _, tn := range turns {
		tools = append(tools, tn.ToolCalls...)
	}
	want := []string{
		"Bash(touch /tmp/herdr-probe2/from-phone.txt)",
		"Read(/private/tmp/herdr-probe2/a.md)",
	}
	if strings.Join(tools, "|") != strings.Join(want, "|") {
		t.Fatalf("tool calls = %q, want %q", tools, want)
	}
}

// G8: a transcript holds no "waiting for approval" record. This fixture caught
// the G16 round trip — the Bash call went out at 15:25:16 and its result only
// landed at 15:29:04, because the dialog sat on screen for those four minutes —
// and the file says nothing at all about it. The mirror must therefore emit
// nothing between the two, and blocked must keep coming from herdr.
func TestClaudeTranscriptSaysNothingAboutTheApprovalItWaitedFor(t *testing.T) {
	turns, _ := parseFixture(t, "claude", claudeFixture)

	var call, next Turn
	for i, tn := range turns {
		if len(tn.ToolCalls) == 1 && strings.HasPrefix(tn.ToolCalls[0], "Bash(") && i+1 < len(turns) {
			call, next = tn, turns[i+1]
			break
		}
	}
	if call.Seq != 11 {
		t.Fatalf("expected the Bash call at seq 11, got %s", formatTurn(call))
	}
	if next.Seq != 13 || next.Text != "Done. `/tmp/herdr-probe2/from-phone.txt` created." {
		t.Fatalf("turn after the blocked tool call = %s, want the assistant's reply at seq 13", formatTurn(next))
	}
	if gap := next.At.Sub(call.At); gap < 3*time.Minute {
		t.Fatalf("gap between call and reply = %v, want the several minutes the dialog was up", gap)
	}
	for _, tn := range turns {
		for _, marker := range []string{"Do you want to proceed", "esc to cancel", "1. Yes"} {
			if strings.Contains(tn.Text, marker) {
				t.Errorf("seq %d claims to carry the permission dialog (%q); that only comes from herdr", tn.Seq, marker)
			}
		}
	}
}

// Claude files the RESULT of the assistant's own tool call under role "user".
// Mirroring that verbatim would put "(Bash completed with no output)" on the
// phone as if the human had typed it.
func TestClaudeToolResultIsNotAUserTurn(t *testing.T) {
	turns, _ := parseFixture(t, "claude", claudeFixture)

	// Records 12 and 18 (0-based) are the two tool_result carriers.
	for _, tn := range turns {
		if tn.Seq == 12 || tn.Seq == 18 {
			t.Errorf("tool_result record %d became a turn: %s", tn.Seq, formatTurn(tn))
		}
	}
	for _, payload := range []string{"(Bash completed with no output)", "1\thi"} {
		for _, tn := range turns {
			if strings.Contains(tn.Text, payload) {
				t.Errorf("seq %d leaked tool_result payload %q", tn.Seq, payload)
			}
		}
	}
	// And the human's three prompts all survived.
	var users int
	for _, tn := range turns {
		if tn.Role == roleUser {
			users++
		}
	}
	if users != 3 {
		t.Fatalf("user turns = %d, want 3 (the typed prompts, and only those)", users)
	}
}

// A slash command is filed under role "user" exactly like typed prose, and it
// is NOT marked isMeta — only the caveat record before it is. Mirroring the
// wrappers puts "<command-name>/clear</command-name>" on the phone as if the
// human had typed it, and the command's own stdout right after it.
func TestClaudeSlashCommandsAreNotHumanTurns(t *testing.T) {
	turns, _ := parseFixture(t, "claude", claudeCommandFixture)

	// Only the typed prompt and the answer to it survive the six records before
	// them.
	checkGolden(t, turns, []string{
		`6 user at=2026-08-13T14:59:32.011Z tools=[] text="Reply with just: OK"`,
		`7 assistant at=2026-08-13T14:59:36.675Z tools=[] text="OK"`,
	})
	for _, tn := range turns {
		for _, marker := range []string{"<command-name>", "command-message", "local-command-stdout", "Set model to"} {
			if strings.Contains(tn.Text, marker) {
				t.Errorf("seq %d leaked the slash-command wrapper %q: %s", tn.Seq, marker, formatTurn(tn))
			}
		}
	}
	assertPlain(t, turns)
}

func TestClaudeRecords(t *testing.T) {
	const ts = `"timestamp":"2026-08-13T14:59:32.011Z"`

	tests := []struct {
		name string
		line string
		want string // formatTurn output, "" means no turn
		log  string // substring the debug log must contain
	}{
		{
			name: "typed prompt is a string body",
			line: `{"type":"user",` + ts + `,"message":{"role":"user","content":"hello there"}}`,
			want: `0 user at=2026-08-13T14:59:32.011Z tools=[] text="hello there"`,
		},
		{
			name: "user text blocks",
			line: `{"type":"user",` + ts + `,"message":{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}`,
			want: `0 user at=2026-08-13T14:59:32.011Z tools=[] text="a\n\nb"`,
		},
		{
			name: "pure tool_result is not a turn",
			line: `{"type":"user",` + ts + `,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"rm -rf output"}]}}`,
			want: "",
		},
		{
			name: "tool_result mixed with text keeps only the text",
			line: `{"type":"user",` + ts + `,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"payload"},{"type":"text","text":"and now this"}]}}`,
			want: `0 user at=2026-08-13T14:59:32.011Z tools=[] text="and now this"`,
		},
		{
			name: "assistant text and tool_use in one record",
			line: `{"type":"assistant",` + ts + `,"message":{"role":"assistant","content":[{"type":"text","text":"Let me look."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la","description":"list"}}]}}`,
			want: `0 assistant at=2026-08-13T14:59:32.011Z tools=[Bash(ls -la)] text="Let me look."`,
		},
		{
			name: "several tool_use blocks in one record",
			line: `{"type":"assistant",` + ts + `,"message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a"}},{"type":"tool_use","name":"Grep","input":{"pattern":"todo","path":"/b"}}]}}`,
			want: `0 assistant at=2026-08-13T14:59:32.011Z tools=[Read(/a) Grep(todo)] text=""`,
		},
		{
			name: "thinking block is skipped, not shown",
			line: `{"type":"assistant",` + ts + `,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"the user probably wants"},{"type":"text","text":"Sure."}]}}`,
			want: `0 assistant at=2026-08-13T14:59:32.011Z tools=[] text="Sure."`,
			log:  "unknown claude content block",
		},
		{
			name: "sub-agent sidechain is not the conversation",
			line: `{"type":"assistant","isSidechain":true,` + ts + `,"message":{"role":"assistant","content":[{"type":"text","text":"inner monologue"}]}}`,
			want: "",
		},
		{
			name: "meta user record is not the human",
			line: `{"type":"user","isMeta":true,` + ts + `,"message":{"role":"user","content":"Caveat: this message was auto-generated"}}`,
			want: "",
		},
		{
			name: "empty assistant record produces nothing",
			line: `{"type":"assistant",` + ts + `,"message":{"role":"assistant","content":[]}}`,
			want: "",
		},
		{
			name: "known non-conversation record is skipped quietly",
			line: `{"type":"ai-title","aiTitle":"Reply with OK","sessionId":"x"}`,
			want: "",
		},
		{
			name: "unknown record type is skipped with a debug log",
			line: `{"type":"quantum-summary","payload":{"whatever":1}}`,
			want: "",
			log:  "unknown claude record type",
		},
		{
			name: "unreadable line is skipped, not fatal",
			line: `{"type":"user","message":{`,
			want: "",
			log:  "unreadable claude record",
		},
		{
			name: "unreadable timestamp still yields the text",
			line: `{"type":"user","timestamp":"yesterday","message":{"role":"user","content":"hi"}}`,
			want: `0 user at=- tools=[] text="hi"`,
			log:  "unreadable transcript timestamp",
		},
		{
			name: "ansi and box drawing are stripped",
			line: `{"type":"assistant",` + ts + `,"message":{"role":"assistant","content":[{"type":"text","text":"\u001b[31m╭─ done ─╮\u001b[0m"}]}}`,
			want: `0 assistant at=2026-08-13T14:59:32.011Z tools=[] text="done"`,
		},
		{
			name: "system-reminder is the client talking to the model",
			line: `{"type":"user",` + ts + `,"message":{"role":"user","content":"<system-reminder>Your todo list is empty</system-reminder>"}}`,
			want: "",
		},
		{
			name: "a reminder appended to a real prompt does not take the prompt with it",
			line: `{"type":"user",` + ts + `,"message":{"role":"user","content":[{"type":"text","text":"run the tests"},{"type":"text","text":"<system-reminder>todo list is empty</system-reminder>"}]}}`,
			want: `0 user at=2026-08-13T14:59:32.011Z tools=[] text="run the tests"`,
		},
		{
			name: "markup the human typed is still the human",
			line: `{"type":"user",` + ts + `,"message":{"role":"user","content":"<div>fix this markup for me</div>"}}`,
			want: `0 user at=2026-08-13T14:59:32.011Z tools=[] text="<div>fix this markup for me</div>"`,
		},
		{
			name: "the assistant quoting a wrapper is not filtered",
			line: `{"type":"assistant",` + ts + `,"message":{"role":"assistant","content":[{"type":"text","text":"<command-name>/clear</command-name>"}]}}`,
			want: `0 assistant at=2026-08-13T14:59:32.011Z tools=[] text="<command-name>/clear</command-name>"`,
		},
		{
			name: "a numeric timestamp costs the clock, not the text",
			line: `{"type":"user","timestamp":1786635828,"message":{"role":"user","content":"hello from the human"}}`,
			want: `0 user at=2026-08-13T15:43:48.000Z tools=[] text="hello from the human"`,
		},
		{
			name: "a timestamp of the wrong shape entirely still yields the text",
			line: `{"type":"user","timestamp":{"iso":"2026-08-13T14:59:32.011Z"},"message":{"role":"user","content":"still here"}}`,
			want: `0 user at=- tools=[] text="still here"`,
			log:  "unreadable transcript timestamp",
		},
		{
			name: "a wrongly typed field does not discard the record",
			line: `{"type":"user","isMeta":"no",` + ts + `,"message":{"role":"user","content":"survived a type change"}}`,
			want: `0 user at=2026-08-13T14:59:32.011Z tools=[] text="survived a type change"`,
			log:  "unexpected field type",
		},
		{
			name: "a block with a wrongly typed field does not blank its siblings",
			line: `{"type":"assistant",` + ts + `,"message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":"ls -la"},{"type":"text","text":"and here is why"}]}}`,
			want: `0 assistant at=2026-08-13T14:59:32.011Z tools=[Bash] text="and here is why"`,
			log:  "unexpected field type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var log bytes.Buffer
			p := newParser(t, "claude", &log)
			turns, rest, err := p.Parse([]byte(tt.line + "\n"))
			if err != nil {
				t.Fatalf("Parse returned an error, which must never happen: %v", err)
			}
			if len(rest) != 0 {
				t.Fatalf("rest = %q, want empty", rest)
			}
			switch {
			case tt.want == "" && len(turns) != 0:
				t.Fatalf("got %d turns, want none: %s", len(turns), formatTurn(turns[0]))
			case tt.want != "" && len(turns) != 1:
				t.Fatalf("got %d turns, want 1", len(turns))
			case tt.want != "":
				if got := formatTurn(turns[0]); got != tt.want {
					t.Errorf("\n want %s\n  got %s", tt.want, got)
				}
				assertPlain(t, turns)
			}
			if tt.log != "" && !strings.Contains(log.String(), tt.log) {
				t.Errorf("debug log = %q, want it to mention %q", log.String(), tt.log)
			}
		})
	}
}

// Seq is the record's position in the file, so a skipped record still consumes
// one — that is what makes a turn's Seq point back at a line of the transcript.
func TestClaudeSeqIsRecordOrder(t *testing.T) {
	var log bytes.Buffer
	p := newParser(t, "claude", &log)
	lines := strings.Join([]string{
		`{"type":"mode","mode":"normal"}`,
		`{"type":"user","timestamp":"2026-08-13T14:59:32.011Z","message":{"role":"user","content":"one"}}`,
		`{"type":"garbage`,
		`{"type":"user","timestamp":"2026-08-13T14:59:33.011Z","message":{"role":"user","content":"two"}}`,
	}, "\n") + "\n"

	turns, _, err := p.Parse([]byte(lines))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(turns) != 2 {
		t.Fatalf("got %d turns, want 2", len(turns))
	}
	if turns[0].Seq != 1 || turns[1].Seq != 3 {
		t.Fatalf("seqs = %d,%d, want 1,3", turns[0].Seq, turns[1].Seq)
	}
}

func TestClaudeTurnTimeIsUTCFromTheRecord(t *testing.T) {
	turns, _ := parseFixture(t, "claude", claudeFixture)
	want := mustTime(t, "2026-08-13T14:59:32.011Z")
	if !turns[0].At.Equal(want) {
		t.Fatalf("At = %v, want %v", turns[0].At, want)
	}
}
