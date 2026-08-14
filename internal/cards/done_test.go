package cards

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// doneAgent is the agent behind every card in this file: claude, finished, with
// a session ref (which only exists once the trust prompt has been accepted, G8).
func doneAgent() agents.Agent {
	return agents.Agent{
		PaneID:     "w1:p1",
		Kind:       "claude",
		Status:     agents.StatusDone,
		Cwd:        "/tmp/herdr-accept",
		Title:      "Check the current time",
		StateSeq:   43,
		SessionRef: claudeSession(),
	}
}

// markdownContents returns every markdown element's content in card order,
// which findTag's map iteration cannot promise.
func markdownContents(t *testing.T, card map[string]any) []string {
	t.Helper()
	body, ok := card["body"].(map[string]any)
	if !ok {
		t.Fatal("card has no body object")
	}
	elements, _ := body["elements"].([]any)
	var out []string
	for _, el := range elements {
		m, ok := el.(map[string]any)
		if !ok || m["tag"] != "markdown" {
			continue
		}
		s, _ := m["content"].(string)
		out = append(out, s)
	}
	return out
}

// doneBody is the element carrying Answer.Text: the last markdown element
// before the buttons, minus the notes that may follow it.
func doneBody(t *testing.T, card map[string]any, ans Answer) string {
	t.Helper()
	md := markdownContents(t, card)
	// prompt, tools and the screen disclaimer come first, the footer last, the
	// truncation note in between.
	idx := 0
	if collapse(ans.Prompt) != "" {
		idx++
	}
	if toolLines(ans.Tools) != "" {
		idx++
	}
	if ans.FromScreen {
		idx++
	}
	if idx >= len(md) {
		t.Fatalf("no body element in %q", md)
	}
	return md[idx]
}

// ---------- golden structure ----------

// TestBuildDoneGolden pins the whole document for the case the card exists for:
// a short question and a one-line answer, which used to arrive as eighteen
// lines of terminal scrollback with the answer buried in the middle.
func TestBuildDoneGolden(t *testing.T) {
	a := doneAgent()
	ans := Answer{Prompt: "what time is it", Text: "It is 01:23 on 14 August 2026, CST."}

	js, err := BuildDone(a, ans, "nonce-9", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}

	iat := float64(issuedAt.Unix())
	inert := func(act string) map[string]any {
		return map[string]any{
			"act": act, "key": "", "pane": "w1:p1", "kind": "claude",
			"seq": float64(43), "iat": iat, "n": "",
			"sid": "cf67e552-abca-4b2a-8711-f37c328ed677",
		}
	}
	column := func(text string, v map[string]any) any {
		return map[string]any{
			"tag":   "column",
			"width": "auto",
			"elements": []any{map[string]any{
				"tag":  "button",
				"text": map[string]any{"tag": "plain_text", "content": text},
				"type": "default",
				"behaviors": []any{map[string]any{
					"type": "callback", "value": v,
				}},
			}},
		}
	}

	want := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"update_multi": true,
			"summary":      map[string]any{"content": "claude · It is 01:23 on 14 August 2026, CST."},
		},
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": "claude · herdr-accept · w1:p1"},
			"subtitle": map[string]any{"tag": "plain_text", "content": "Check the current time"},
			"template": "green",
		},
		"body": map[string]any{
			"elements": []any{
				map[string]any{"tag": "markdown", "content": "**You asked** “what time is it”"},
				// The payload, as prose. Not a code block: a code block on a
				// phone does not wrap, so an ordinary sentence would scroll
				// sideways.
				map[string]any{"tag": "markdown", "content": "It is 01:23 on 14 August 2026, CST."},
				map[string]any{
					"tag":                "column_set",
					"flex_mode":          "flow",
					"horizontal_spacing": "8px",
					"columns": []any{
						column("Select · then just type", inert("select")),
						column("Screen", inert("screen")),
					},
				},
				map[string]any{
					"tag":     "markdown",
					"content": "pane `w1:p1` · seq 43 · as of 2026-08-14 01:23:45 CST",
				},
			},
		},
	}

	if got := decodeCard(t, js); !reflect.DeepEqual(got, want) {
		gotPretty, _ := json.MarshalIndent(got, "", "  ")
		wantPretty, _ := json.MarshalIndent(want, "", "  ")
		t.Fatalf("card structure differs\n got: %s\nwant: %s", gotPretty, wantPretty)
	}
}

// ---------- safety ----------

// TestDoneButtonsAreInert is the G17 lock for this card. Both buttons send
// nothing, so neither may carry a key or a nonce: a nonce here would be spent
// by a tap that does nothing, and if the caller shares one nonce per agent that
// tap would disarm a live blocked card's numbered buttons.
func TestDoneButtonsAreInert(t *testing.T) {
	a := doneAgent()
	js, err := BuildDone(a, Answer{Text: "done"}, "nonce-9", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if strings.Contains(js, "nonce-9") {
		t.Fatalf("the nonce reached the card; every button here is inert:\n%s", js)
	}

	card := decodeCard(t, js)
	if texts := buttonTexts(t, card); !reflect.DeepEqual(texts, []string{selectAndTypeText, screenText}) {
		t.Fatalf("buttons = %q, want select then screen", texts)
	}

	values := buttonValues(t, card)
	if len(values) != 2 {
		t.Fatalf("got %d buttons, want 2", len(values))
	}
	wantActs := []string{ActSelect, ActScreen}
	for i, v := range values {
		d, err := DecodeDecision(v)
		if err != nil {
			t.Fatalf("button %d does not decode: %v", i, err)
		}
		if d.Act != wantActs[i] {
			t.Errorf("button %d act = %q, want %q", i, d.Act, wantActs[i])
		}
		if !d.Inert() {
			t.Errorf("button %d is not inert", i)
		}
		if d.Key != "" || d.Nonce != "" {
			t.Errorf("button %d carries key %q nonce %q; both must be empty", i, d.Key, d.Nonce)
		}
		// Pane, kind and session are what let the bridge check that the seat
		// still holds the same agent before it aims typing at it (G8).
		if d.Pane != a.PaneID || d.Kind != a.Kind || d.Seq != a.StateSeq {
			t.Errorf("button %d = %+v, want pane/kind/seq of %+v", i, d, a)
		}
		if d.Session != a.SessionRef.Value {
			t.Errorf("button %d session = %q, want %q", i, d.Session, a.SessionRef.Value)
		}
	}
}

func TestBuildDoneRefusesWithoutAPane(t *testing.T) {
	a := doneAgent()
	a.PaneID = ""
	if _, err := BuildDone(a, Answer{Text: "hi"}, "nonce-9", issuedAt); !errors.Is(err, errUnbuildable) {
		t.Fatalf("err = %v, want errUnbuildable: a card whose buttons carry no pane cannot be routed", err)
	}
}

// ---------- cells, not runes ----------

// TestDonePromptTruncatesInCells is the CJK lock. The same prompt length in
// runes must produce a much shorter line in Chinese, because each of those
// runes is two cells on the phone doing the reading (G5, screen/width.go).
func TestDonePromptTruncatesInCells(t *testing.T) {
	const runes = 60
	ascii := strings.Repeat("a", runes)
	chinese := strings.Repeat("时", runes)

	quoted := func(prompt string) string {
		t.Helper()
		js, err := BuildDone(doneAgent(), Answer{Prompt: prompt, Text: "ok"}, "n", issuedAt)
		if err != nil {
			t.Fatalf("BuildDone: %v", err)
		}
		line := markdownContents(t, decodeCard(t, js))[0]
		s := strings.TrimPrefix(line, "**You asked** “")
		if s == line {
			t.Fatalf("prompt line %q is not the quoted context line", line)
		}
		return strings.TrimSuffix(s, "”")
	}

	// 60 ASCII runes are 60 cells: under budget, so nothing is cut.
	if got := quoted(ascii); got != ascii {
		t.Errorf("ascii prompt was altered:\n got %q\nwant %q", got, ascii)
	}

	got := quoted(chinese)
	if w := displayWidth(got); w > maxPromptCells {
		t.Errorf("chinese prompt is %d cells, want at most %d", w, maxPromptCells)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("chinese prompt %q was not marked as cut", got)
	}
	// The point of the test: it was cut well before 60 runes, which a
	// rune-counting rule would have let through untouched.
	if n := utf8.RuneCountInString(got); n >= runes {
		t.Errorf("chinese prompt kept %d runes; measuring runes instead of cells would keep %d", n, runes)
	}
}

// TestChineseAnswerStaysProse guards the whole point of the change: the answer
// to a Chinese question is a sentence and must not be boxed into a code block,
// which does not wrap on a phone.
func TestChineseAnswerStaysProse(t *testing.T) {
	const text = "现在是 2026 年 8 月 14 日 01:23:45，时区 CST。"
	js, err := BuildDone(doneAgent(), Answer{Prompt: "现在几点了", Text: text}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	card := decodeCard(t, js)
	body := doneBody(t, card, Answer{Prompt: "现在几点了"})
	if body != text {
		t.Fatalf("body = %q, want the answer verbatim as prose", body)
	}
	if strings.Contains(body, "```") {
		t.Errorf("the answer was fenced; prose in a code block scrolls sideways on a phone")
	}
}

// TestPromptIsOneLine: a multi-line request is context here, not a re-run of
// itself. A newline would push the answer down the card for nothing.
func TestPromptIsOneLine(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{Prompt: "first line\n\nsecond   line", Text: "ok"}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	got := markdownContents(t, decodeCard(t, js))[0]
	if want := "**You asked** “first line second line”"; got != want {
		t.Fatalf("prompt line = %q, want %q", got, want)
	}
}

// ---------- tools ----------

func TestDoneCollapsesToolLines(t *testing.T) {
	ans := Answer{
		Prompt: "what time is it",
		Text:   "It is 01:23.",
		Tools: []string{
			"Bash(date)", "Read(main.go)", "  ", "Edit(main.go)", "Bash(go build ./...)",
			"Bash(go test ./...)", "Read(go.mod)", "Bash(git status)",
		},
	}
	js, err := BuildDone(doneAgent(), ans, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	got := markdownContents(t, decodeCard(t, js))[1]

	want := "`Bash(date)`\n`Read(main.go)`\n`Edit(main.go)`\n`Bash(go build ./...)`\n" +
		"`Bash(go test ./...)`\n_+2 more_"
	if got != want {
		t.Fatalf("tool block =\n%q\nwant\n%q", got, want)
	}
	if n := strings.Count(got, "\n") + 1; n != maxToolLines+1 {
		t.Errorf("tool block has %d lines, want %d plus the overflow line", n, maxToolLines)
	}
}

// TestDoneDropsBlankToolsWithoutCountingThem: a blank summary carries nothing,
// so promising the reader "+1 more" to go and look at would be a lie.
func TestDoneDropsBlankToolsWithoutCountingThem(t *testing.T) {
	ans := Answer{Text: "ok", Tools: []string{"", "Bash(date)", "   ", "\n"}}
	js, err := BuildDone(doneAgent(), ans, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	got := markdownContents(t, decodeCard(t, js))[0]
	if got != "`Bash(date)`" {
		t.Fatalf("tool block = %q, want just the one real entry", got)
	}
}

func TestDoneTruncatesALongToolLine(t *testing.T) {
	long := "Bash(grep -rn " + strings.Repeat("x", 200) + ")"
	js, err := BuildDone(doneAgent(), Answer{Text: "ok", Tools: []string{long}}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	got := markdownContents(t, decodeCard(t, js))[0]
	if w := displayWidth(strings.Trim(got, "`")); w > maxToolCells {
		t.Fatalf("tool line is %d cells, want at most %d", w, maxToolCells)
	}
	if !strings.Contains(got, "…") {
		t.Errorf("tool line %q was cut without saying so", got)
	}
}

// TestAToolSummaryWithABacktickIsNotWrapped: an inline fence would close on the
// summary's own backtick and leave the rest of the line rendering as markdown.
func TestAToolSummaryWithABacktickIsNotWrapped(t *testing.T) {
	const tool = "Bash(echo `date`)"
	js, err := BuildDone(doneAgent(), Answer{Text: "ok", Tools: []string{tool}}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := markdownContents(t, decodeCard(t, js))[0]; got != tool {
		t.Fatalf("tool line = %q, want %q unwrapped", got, tool)
	}
}

// TestNoToolsNoToolBlock: an answer with no tools must not gain an empty
// element between the prompt and the answer.
func TestNoToolsNoToolBlock(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{Prompt: "hi", Text: "hello"}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	md := markdownContents(t, decodeCard(t, js))
	if len(md) != 3 { // prompt, answer, footer
		t.Fatalf("got %d markdown elements %q, want prompt, answer and footer", len(md), md)
	}
}

// ---------- truncation and the fallback ----------

func TestDoneSaysWhenTheAnswerWasCutShort(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{Text: "the first half", Truncated: true}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	card := decodeCard(t, js)
	if !strings.Contains(allText(card), truncatedNote) {
		t.Fatalf("a truncated answer did not say where the rest is:\n%s", allText(card))
	}
	// The note points at the button that can actually show more.
	if !strings.Contains(truncatedNote, "**Screen**") {
		t.Errorf("truncation note %q does not name the screen button", truncatedNote)
	}
}

// TestDoneCutsARunawayAnswer: the caller's Truncated flag is not the only
// bound. A mirror that hands over a whole session, or a screen fallback on a
// 49-row pane (G5), must still produce a card that gets delivered.
func TestDoneCutsARunawayAnswer(t *testing.T) {
	huge := strings.Repeat("all the words. ", 1000)
	js, err := BuildDone(doneAgent(), Answer{Text: huge}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	card := decodeCard(t, js)
	body := doneBody(t, card, Answer{})
	if w := displayWidth(body); w > maxAnswerCells {
		t.Errorf("body is %d cells, want at most %d", w, maxAnswerCells)
	}
	if !strings.Contains(allText(card), truncatedNote) {
		t.Errorf("the body was cut without telling the reader")
	}
}

// TestDoneCutsAnAnswerThatIsWideLessButHuge is the delivery bound, which cells
// cannot provide. runeWidth charges nothing for a newline, a combining mark or
// a zero-width joiner, so a body made of them measures a handful of cells at any
// size — while Feishu counts characters (8000, S2 §3.8, outbound.MaxMessageRunes)
// and this card is sent whole. Over the ceiling nothing arrives at all: the
// notification is lost rather than shortened.
func TestDoneCutsAnAnswerThatIsWideLessButHuge(t *testing.T) {
	for _, tc := range []struct{ name, text string }{
		{"newlines", "start" + strings.Repeat("\n", 200000) + "end"},
		{"zero width joiners", "start" + strings.Repeat("‍", 200000) + "end"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if w := displayWidth(tc.text); w > maxAnswerCells {
				t.Fatalf("fixture measures %d cells; it must pass the cell budget to test the rune one", w)
			}
			js, err := BuildDone(doneAgent(), Answer{Text: tc.text}, "n", issuedAt)
			if err != nil {
				t.Fatalf("BuildDone: %v", err)
			}
			card := decodeCard(t, js)
			if n := utf8.RuneCountInString(doneBody(t, card, Answer{})); n > maxAnswerRunes+8 {
				t.Errorf("body is %d runes, want about %d: the whole card would exceed Feishu's limit"+
					" and no notification would arrive", n, maxAnswerRunes)
			}
			if !strings.Contains(allText(card), truncatedNote) {
				t.Errorf("the body was cut without telling the reader")
			}
			// The banner is measured in cells too, so it is blind to the same
			// runes and would otherwise carry the whole 200k line by itself.
			if n := utf8.RuneCountInString(summaryOf(t, card)); n > maxSummary {
				t.Errorf("banner is %d runes, want at most %d", n, maxSummary)
			}
		})
	}
}

// TestACutFenceIsClosed: an unbalanced ``` swallows every line after it,
// including the note that says the answer was cut.
func TestACutFenceIsClosed(t *testing.T) {
	text := "here is the patch:\n```go\n" + strings.Repeat("x := 1 // padding\n", 300)
	js, err := BuildDone(doneAgent(), Answer{Text: text}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	body := doneBody(t, decodeCard(t, js), Answer{})
	if strings.Count(body, "```")%2 != 0 {
		t.Fatalf("body ends inside an open fence:\n%s", body)
	}
}

// TestFromScreenSaysSo is the honesty lock on the fallback: with no transcript
// the body is the terminal, and a reader who takes ghost input-box completions
// (G4) or a previous turn for the agent's answer has been misled by this card.
func TestFromScreenSaysSo(t *testing.T) {
	const tail = "╭──────────────╮\n│ > ls /tmp    │\n╰──────────────╯"
	js, err := BuildDone(doneAgent(), Answer{Text: tail, FromScreen: true}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	card := decodeCard(t, js)

	body := doneBody(t, card, Answer{FromScreen: true})
	// A rendered character grid: fenced, so its columns survive (S1 §3.3).
	if want := "```\n" + tail + "\n```"; body != want {
		t.Fatalf("screen body = %q, want it fenced verbatim", body)
	}
	text := allText(card)
	if !strings.Contains(text, fromScreenNote) {
		t.Fatalf("the fallback did not admit it is a screen:\n%s", text)
	}
	for _, phrase := range []string{"No transcript", "raw screen", "nobody typed"} {
		if !strings.Contains(fromScreenNote, phrase) {
			t.Errorf("fallback note does not mention %q: %q", phrase, fromScreenNote)
		}
	}

	// The banner must not spend its one line on a box corner.
	if got := summaryOf(t, card); got != "claude finished" {
		t.Errorf("summary = %q, want no screen furniture in the notification", got)
	}
}

// TestFromScreenNoteComesBeforeTheScreen: a disclaimer under a screenful of
// terminal is read after the thing it disclaims. The body can run to
// maxAnswerCells of fenced furniture — earlier turns, tool output, the input box
// with completions nobody typed (G4) — so a reader who meets that first has
// already taken it for the agent's answer.
func TestFromScreenNoteComesBeforeTheScreen(t *testing.T) {
	tail := strings.Repeat("│ some earlier turn nobody asked about │\n", 40)
	js, err := BuildDone(doneAgent(), Answer{Prompt: "hi", Text: tail, FromScreen: true}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	md := markdownContents(t, decodeCard(t, js))

	note, screen := -1, -1
	for i, el := range md {
		switch {
		case el == fromScreenNote:
			note = i
		case strings.Contains(el, "```"):
			screen = i
		}
	}
	if note < 0 || screen < 0 {
		t.Fatalf("card is missing the note (%d) or the screen body (%d):\n%q", note, screen, md)
	}
	if note > screen {
		t.Fatalf("the warning is element %d and the screen it warns about is element %d;"+
			" the reader meets the terminal first", note, screen)
	}
}

// TestEmptyAnswerStillBuildsACard: "it finished" is worth pushing on its own,
// and an error here would drop the notification entirely.
func TestEmptyAnswerStillBuildsACard(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone with an empty answer: %v", err)
	}
	card := decodeCard(t, js)
	if got := doneBody(t, card, Answer{}); got != noAnswerText {
		t.Fatalf("body = %q, want %q", got, noAnswerText)
	}
	if got := summaryOf(t, card); got != "claude finished" {
		t.Errorf("summary = %q, want a plain statement that it finished", got)
	}
	// The buttons are the only way to learn more, so they must survive.
	if texts := buttonTexts(t, card); len(texts) != 2 {
		t.Errorf("buttons = %q, want select and screen", texts)
	}
}

// TestWhitespaceOnlyAnswerIsTreatedAsEmpty: a body of blank lines renders as an
// empty card, which reads as a broken bridge rather than a finished agent.
func TestWhitespaceOnlyAnswerIsTreatedAsEmpty(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{Text: "\n  \n\t\n"}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := doneBody(t, decodeCard(t, js), Answer{}); got != noAnswerText {
		t.Fatalf("body = %q, want %q", got, noAnswerText)
	}
}

// ---------- prose or code ----------

func TestAnswerIsFencedOnlyWhenItIsCode(t *testing.T) {
	tests := []struct {
		name  string
		text  string
		fence bool
	}{
		{"one line answer", "It is 01:23.", false},
		{"terse answer", "Done", false},
		{"prose without a full stop", "all tests pass", false},
		{"prose naming a path", "The file is at /tmp/herdr-accept/x.txt", false},
		// The single most common shape of a coding agent's final message: a
		// list of what it changed, every item naming a file. A list marker is
		// not a program name, and fencing this is the horizontal scroll on a
		// phone that this card exists to remove.
		{"a bullet list of changed files", "- fixed the parser in internal/mirror/claude.go\n" +
			"- added a test in internal/mirror/claude_test.go\n" +
			"- updated the docs in docs/mirror.md", false},
		{"a numbered list of steps", "1. read internal/cards/done.go\n" +
			"2. rewrote the body in internal/cards/done.go\n" +
			"3. ran the tests in internal/cards", false},
		{"a bare list of paths", "changes:\n- internal/cards/done.go\n- internal/cards/width.go", false},
		// One line of lowercase prose that happens to name a file: with a single
		// line a strict majority is one vote, so the path rule alone decides it.
		{"one lowercase line naming a path", "see the log at /tmp/build.log for details", false},
		{"prose listing options", "You can run it now, or wait for the build", false},
		{"chinese prose", "现在是 01:23，测试全部通过", false},
		{"a paragraph", "I checked the clock on the machine and it says 01:23 in CST, " +
			"which is the zone the bridge runs in", false},
		{"shell session", "cd /tmp/herdr-accept\ngo build ./...\ngo test -race ./...", true},
		{"prompt markers", "$ npm install\n% npm run build", true},
		{"blank lines between commands", "cd /tmp\n\nmake build\n\ngit status --short", true},
		{"a pipeline", "grep -rn TODO .\ncat notes.txt | sort", true},
		// Programs this build has never heard of still read as commands when
		// they carry shell syntax: a flag, a path, a pipe.
		{"unfamiliar tools", "gh pr list --limit 5\nrg TODO | sort", true},
		{"mostly prose with one command", "I ran this for you:\ngo test ./...\nand it passed", false},
		// A known limit, and the deliberate direction of the bias: source that
		// arrives without a fence reads as prose here, which costs alignment.
		// Guessing the other way costs a horizontal scroll on every ordinary
		// sentence, which is the complaint this card exists to answer.
		{"unfenced go source", "func main() {\n\tfmt.Println(\"hi\")\n}", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			js, err := BuildDone(doneAgent(), Answer{Text: tc.text}, "n", issuedAt)
			if err != nil {
				t.Fatalf("BuildDone: %v", err)
			}
			body := doneBody(t, decodeCard(t, js), Answer{})
			if got := strings.HasPrefix(body, "```"); got != tc.fence {
				t.Fatalf("fenced = %v, want %v for:\n%s", got, tc.fence, tc.text)
			}
		})
	}
}

// TestAnAlreadyFencedAnswerIsNotWrappedAgain: wrapping it would show the inner
// fence as literal backticks and put the prose around it in a code block.
func TestAnAlreadyFencedAnswerIsNotWrappedAgain(t *testing.T) {
	text := "I fixed it:\n```go\nreturn nil\n```\nRun the tests when you can."
	js, err := BuildDone(doneAgent(), Answer{Text: text}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	body := doneBody(t, decodeCard(t, js), Answer{})
	if body != text {
		t.Fatalf("body = %q, want the text unchanged", body)
	}
}

// ---------- the notification banner ----------

func TestDoneSummaryLeadsWithTheAnswer(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{Prompt: "what time is it", Text: "It is 01:23.\nAnything else?"}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got, want := summaryOf(t, decodeCard(t, js)), "claude · It is 01:23."; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
}

// TestDoneSummaryIsPlainText: config.summary.content is not rendered as
// markdown, so every mark in it is literal punctuation spending characters of
// the one line a locked phone shows.
func TestDoneSummaryIsPlainText(t *testing.T) {
	const text = "`a.md` contains a single line of text: **hi**. That's all."
	js, err := BuildDone(doneAgent(), Answer{Text: text}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	card := decodeCard(t, js)
	got := summaryOf(t, card)
	if want := "claude · a.md contains a single line of text: hi. That's al…"; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
	// Only the banner is stripped: the body is markdown and keeps its marks.
	if body := doneBody(t, card, Answer{}); body != text {
		t.Errorf("body = %q, want the answer's own formatting untouched", body)
	}
}

func TestDoneSummaryIsBoundedInCells(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{Text: strings.Repeat("时", 100)}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	got := summaryOf(t, decodeCard(t, js))
	if w := displayWidth(got); w > maxSummary {
		t.Fatalf("summary is %d cells, want at most %d: %q", w, maxSummary, got)
	}
}

// TestDoneSubtitleFallsBackWhenTheAgentHasNoTitle: codex reports only its cwd
// as a title (G8), which taskTitle already drops.
func TestDoneSubtitleFallsBackWhenTheAgentHasNoTitle(t *testing.T) {
	a := doneAgent()
	a.Title = ""
	js, err := BuildDone(a, Answer{Text: "ok"}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	header, _ := decodeCard(t, js)["header"].(map[string]any)
	sub, _ := header["subtitle"].(map[string]any)
	if got := sub["content"]; got != "finished" {
		t.Fatalf("subtitle = %v, want \"finished\"", got)
	}
}

// TestDoneHeaderIsGreen: the colour is the glance. Red in this chat means a
// card whose buttons can still send a key right now (G17); nothing here can.
func TestDoneHeaderIsGreen(t *testing.T) {
	js, err := BuildDone(doneAgent(), Answer{Text: "ok"}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	header, _ := decodeCard(t, js)["header"].(map[string]any)
	if got := header["template"]; got != "green" {
		t.Fatalf("template = %v, want green", got)
	}
}

func summaryOf(t *testing.T, card map[string]any) string {
	t.Helper()
	config, ok := card["config"].(map[string]any)
	if !ok {
		t.Fatal("card has no config")
	}
	summary, ok := config["summary"].(map[string]any)
	if !ok {
		t.Fatal("card has no summary")
	}
	s, _ := summary["content"].(string)
	return s
}
