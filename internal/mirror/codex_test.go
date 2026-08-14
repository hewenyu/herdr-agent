package mirror

import (
	"bytes"
	"strings"
	"testing"
)

// The whole turn list of the real rollout. Seq is the envelope `ordinal`, not
// the line number: 8 is the human's prompt, 11 the preamble, 12 the exec call,
// 17 the final answer. Everything else in the file is preamble, lifecycle or
// duplication.
func TestCodexFixtureGolden(t *testing.T) {
	turns, _ := parseFixture(t, "codex", codexFixture)

	checkGolden(t, turns, []string{
		`8 user at=2026-08-13T15:43:48.974Z tools=[] text="Run the shell command 'ls -la' in the current directory and tell me how many files there are."`,
		`11 assistant at=2026-08-13T15:43:54.333Z tools=[] text="I’ll inspect the current directory and count regular files, excluding directories and the ` + "`.`/`..`" + ` entries."`,
		`12 assistant at=2026-08-13T15:43:55.270Z tools=[exec(ls -la)] text=""`,
		`17 assistant at=2026-08-13T15:44:01.930Z tools=[] text="There are **2 files**: ` + "`a.md`" + ` and ` + "`from-phone.txt`" + `."`,
	})
	assertPlain(t, turns)
}

// Codex writes every message twice: once as the response_item, once inside an
// event_msg item_completed. Parsing both would double every turn on the phone.
func TestCodexEventMsgDoesNotDuplicateTurns(t *testing.T) {
	turns, _ := parseFixture(t, "codex", codexFixture)

	counts := map[string]int{}
	for _, tn := range turns {
		counts[tn.Text]++
	}
	for text, n := range counts {
		if text != "" && n != 1 {
			t.Errorf("text %q appears in %d turns, want 1", text, n)
		}
	}
	// The item_completed records for those messages sit at ordinals 9, 10 and
	// 16; none of them may produce a turn of its own.
	for _, tn := range turns {
		switch tn.Seq {
		case 9, 10, 13, 16, 19:
			t.Errorf("event_msg ordinal %d became a turn: %s", tn.Seq, formatTurn(tn))
		}
	}
}

// Everything Codex injects into the model's context arrives as a message: the
// skills catalogue and sandbox policy under role "developer", and AGENTS.md
// plus <environment_context> under role "user". None of it was said by anyone.
func TestCodexSkipsInjectedContext(t *testing.T) {
	turns, _ := parseFixture(t, "codex", codexFixture)

	for _, tn := range turns {
		switch tn.Seq {
		case 2, 3, 4, 5:
			t.Errorf("injected context at ordinal %d became a turn: %s", tn.Seq, formatTurn(tn))
		}
		for _, marker := range []string{
			"AGENTS.md", "<environment_context>", "<skills_instructions>",
			"sandbox_mode", "spawn_agent",
		} {
			if strings.Contains(tn.Text, marker) {
				t.Errorf("seq %d leaked injected context %q", tn.Seq, marker)
			}
		}
	}
	var users int
	for _, tn := range turns {
		if tn.Role == roleUser {
			users++
		}
	}
	if users != 1 {
		t.Fatalf("user turns = %d, want 1 (the one sentence the human typed)", users)
	}
}

func TestCodexRecords(t *testing.T) {
	const ts = `"timestamp":"2026-08-13T15:43:48.974Z"`
	const at = `at=2026-08-13T15:43:48.974Z`

	tests := []struct {
		name string
		line string
		want string
		log  string
	}{
		{
			name: "user message",
			line: `{` + ts + `,"ordinal":8,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do the thing"}]}}`,
			want: `8 user ` + at + ` tools=[] text="do the thing"`,
		},
		{
			name: "assistant message",
			line: `{` + ts + `,"ordinal":17,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}`,
			want: `17 assistant ` + at + ` tools=[] text="done"`,
		},
		{
			name: "developer message is not conversation",
			line: `{` + ts + `,"ordinal":2,"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"you are a helpful"}]}}`,
			want: "",
		},
		{
			name: "AGENTS.md preamble filed under user is skipped",
			line: `{` + ts + `,"ordinal":5,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n<INSTRUCTIONS>\nbe good\n</INSTRUCTIONS>"}]}}`,
			want: "",
		},
		{
			name: "environment_context filed under user is skipped",
			line: `{` + ts + `,"ordinal":5,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"}]}}`,
			want: "",
		},
		{
			name: "injected block does not swallow the human text beside it",
			line: `{` + ts + `,"ordinal":5,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"},{"type":"input_text","text":"and now do the thing"}]}}`,
			want: `5 user ` + at + ` tools=[] text="and now do the thing"`,
		},
		{
			name: "an angle bracket in prose is still prose",
			line: `{` + ts + `,"ordinal":5,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<b>bold</b> and more text"}]}}`,
			want: `5 user ` + at + ` tools=[] text="<b>bold</b> and more text"`,
		},
		{
			name: "custom_tool_call collapses the exec script",
			line: `{` + ts + `,"ordinal":12,"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","status":"completed","call_id":"c1","input":"const r = await tools.exec_command({\"cmd\":\"ls -la\",\"workdir\":\"/tmp\",\"yield_time_ms\":10000});\ntext(r.output);\n"}}`,
			want: `12 assistant ` + at + ` tools=[exec(ls -la)] text=""`,
		},
		{
			name: "quotes inside the command survive the scan",
			line: `{` + ts + `,"ordinal":12,"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"await tools.exec_command({\"cmd\":\"echo \\\"hi there\\\"\"});"}}`,
			want: `12 assistant ` + at + ` tools=[exec(echo "hi there")] text=""`,
		},
		{
			name: "tool input that is a plain object",
			line: `{` + ts + `,"ordinal":12,"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":{"file_path":"/tmp/a.md","content":"lots and lots of text"}}}`,
			want: `12 assistant ` + at + ` tools=[apply_patch(/tmp/a.md)] text=""`,
		},
		{
			name: "tool input with no recognisable argument falls back to its first line",
			line: `{` + ts + `,"ordinal":12,"type":"response_item","payload":{"type":"custom_tool_call","name":"mystery","input":"do_something(42)\nand_more()"}}`,
			want: `12 assistant ` + at + ` tools=[mystery(do_something(42))] text=""`,
		},
		{
			name: "tool output is not mirrored",
			line: `{` + ts + `,"ordinal":14,"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"total 8\ndrwxr-xr-x"}}`,
			want: "",
		},
		{
			name: "event_msg is lifecycle, never content",
			line: `{` + ts + `,"ordinal":9,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"do the thing"}]}}}`,
			want: "",
		},
		{
			name: "world_state is skipped quietly",
			line: `{` + ts + `,"ordinal":6,"type":"world_state","payload":{"full":true,"state":{}}}`,
			want: "",
		},
		{
			name: "unknown record type is skipped with a debug log",
			line: `{` + ts + `,"ordinal":20,"type":"holodeck_state","payload":{}}`,
			want: "",
			log:  "unknown codex record type",
		},
		{
			name: "unknown payload type is skipped with a debug log",
			line: `{` + ts + `,"ordinal":20,"type":"response_item","payload":{"type":"web_search_call","query":"x"}}`,
			want: "",
			log:  "unknown codex payload type",
		},
		{
			name: "unknown content block is skipped with a debug log",
			line: `{` + ts + `,"ordinal":8,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:..."},{"type":"input_text","text":"what is this"}]}}`,
			want: `8 user ` + at + ` tools=[] text="what is this"`,
			log:  "unknown codex content block",
		},
		{
			name: "unreadable line is skipped, not fatal",
			line: `{"type":"response_item","payload":{`,
			want: "",
			log:  "unreadable codex record",
		},
		{
			name: "ansi and box drawing are stripped",
			line: `{` + ts + `,"ordinal":17,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"\u001b[32m│ ok │\u001b[0m"}]}}`,
			want: `17 assistant ` + at + ` tools=[] text="ok"`,
		},
		{
			// The filter is an allowlist of the wrappers Codex writes, not the
			// shape "one XML element": a human really does type markup, and this
			// record is the whole of what they asked.
			name: "markup the human typed is still the human",
			line: `{` + ts + `,"ordinal":8,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<div>fix this markup for me</div>"}]}}`,
			want: `8 user ` + at + ` tools=[] text="<div>fix this markup for me</div>"`,
		},
		{
			name: "a wrapper Codex does write is still dropped",
			line: `{` + ts + `,"ordinal":5,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<user_instructions>be terse</user_instructions>"}]}}`,
			want: "",
		},
		{
			name: "a numeric timestamp costs the clock, not the text",
			line: `{"timestamp":1786635828,"ordinal":8,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do the thing"}]}}`,
			want: `8 user at=2026-08-13T15:43:48.000Z tools=[] text="do the thing"`,
		},
		{
			name: "a content block with a wrongly typed field does not drop the message",
			line: `{` + ts + `,"ordinal":17,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":{"value":"nested"}},{"type":"output_text","text":"the part that decoded"}]}}`,
			want: `17 assistant ` + at + ` tools=[] text="the part that decoded"`,
			log:  "unexpected field type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var log bytes.Buffer
			p := newParser(t, "codex", &log)
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

// Codex numbers its own records; the ordinal is the ordering, and it is not the
// line number — the fixture's first turn is line 9, ordinal 8.
func TestCodexSeqComesFromTheOrdinal(t *testing.T) {
	var log bytes.Buffer
	p := newParser(t, "codex", &log)
	line := `{"timestamp":"2026-08-13T15:43:48.974Z","ordinal":4242,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}` + "\n"

	turns, _, err := p.Parse([]byte(line))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(turns) != 1 || turns[0].Seq != 4242 {
		t.Fatalf("got %+v, want a single turn with Seq 4242", turns)
	}
}

// A record without a usable ordinal still has to be ordered somehow, so it
// falls back to its position in the file rather than colliding on zero.
func TestCodexSeqFallsBackToRecordOrder(t *testing.T) {
	var log bytes.Buffer
	p := newParser(t, "codex", &log)
	body := `"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}`
	lines := strings.Join([]string{
		`{"ordinal":0,` + body + `}`,
		`{` + body + `}`,
		`{"ordinal":"nine",` + body + `}`,
	}, "\n") + "\n"

	turns, _, err := p.Parse([]byte(lines))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(turns) != 3 {
		t.Fatalf("got %d turns, want 3", len(turns))
	}
	if turns[0].Seq != 0 || turns[1].Seq != 1 || turns[2].Seq != 2 {
		t.Fatalf("seqs = %d,%d,%d, want 0,1,2", turns[0].Seq, turns[1].Seq, turns[2].Seq)
	}
	if !strings.Contains(log.String(), "unreadable codex ordinal") {
		t.Errorf("debug log = %q, want it to mention the unreadable ordinal", log.String())
	}
}

func TestCodexTurnTimeIsUTCFromTheRecord(t *testing.T) {
	turns, _ := parseFixture(t, "codex", codexFixture)
	want := mustTime(t, "2026-08-13T15:43:48.974Z")
	if !turns[0].At.Equal(want) {
		t.Fatalf("At = %v, want %v", turns[0].At, want)
	}
}
