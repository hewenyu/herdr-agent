package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// blockedAgent is the agent the notifier hands to PushBlocked.
func blockedAgent() agents.Agent {
	return agents.Agent{
		PaneID:   testPane,
		Kind:     "claude",
		Status:   agents.StatusBlocked,
		Cwd:      "/tmp/herdr-accept",
		Title:    "Create hello.txt with touch",
		StateSeq: 42,
	}
}

// permissionDialog is the measured Bash permission prompt (G1).
func permissionDialog() screen.Screen {
	return screen.Screen{
		Lines: []string{
			"Bash command",
			"  touch /tmp/herdr-accept/p1.txt",
			"Do you want to proceed?",
			"❯ 1. Yes",
			"  2. Yes, and don't ask again",
			"  3. No, and tell Claude what to do differently",
		},
		Rows: 49,
		Cols: 100,
	}
}

// decisionsOf pulls every button's Decision back out of a rendered card, the
// same way the Feishu callback will: the value travels verbatim (G16).
func decisionsOf(t *testing.T, cardJSON string) []cards.Decision {
	t.Helper()

	var doc struct {
		Body struct {
			Elements []json.RawMessage `json:"elements"`
		} `json:"body"`
	}
	if err := json.Unmarshal([]byte(cardJSON), &doc); err != nil {
		t.Fatalf("card is not valid JSON: %v", err)
	}

	var out []cards.Decision
	for _, raw := range doc.Body.Elements {
		var set struct {
			Tag     string `json:"tag"`
			Columns []struct {
				Elements []struct {
					Tag       string                   `json:"tag"`
					Text      struct{ Content string } `json:"text"`
					Behaviors []struct {
						Value map[string]any `json:"value"`
					} `json:"behaviors"`
				} `json:"elements"`
			} `json:"columns"`
		}
		if err := json.Unmarshal(raw, &set); err != nil || set.Tag != "column_set" {
			continue
		}
		for _, col := range set.Columns {
			for _, el := range col.Elements {
				if el.Tag != "button" || len(el.Behaviors) == 0 {
					continue
				}
				// DecodeDecision is the real callback path, so a card this
				// bridge builds and cannot decode is caught here.
				d, err := cards.DecodeDecision(el.Behaviors[0].Value)
				if err != nil {
					t.Fatalf("button %q carries a value the callback would reject: %v", el.Text.Content, err)
				}
				out = append(out, d)
			}
		}
	}
	return out
}

// keyDecisionsOf is the subset that actually types something into an agent.
//
// A blocked card also carries inert buttons — Select aims the chat at this
// agent, Screen re-reads it — and those deliberately carry no nonce and no key
// (cards.Decision.Inert): there is nothing to disarm and nothing that could
// become an approval. The rules the guard tests assert are about the numbered
// answers, so they are separated here rather than loosened.
func keyDecisionsOf(ds []cards.Decision) []cards.Decision {
	out := make([]cards.Decision, 0, len(ds))
	for _, d := range ds {
		if !d.Inert() {
			out = append(out, d)
		}
	}
	return out
}

func actsOf(ds []cards.Decision) []string {
	acts := make([]string, 0, len(ds))
	for _, d := range ds {
		acts = append(acts, d.Act)
	}
	return acts
}

func keysOf(ds []cards.Decision) []string {
	keys := make([]string, 0, len(ds))
	for _, d := range ds {
		keys = append(keys, d.Key)
	}
	return keys
}

// TestPushBlockedArmsEveryButtonWithTheStateSeqAtPushTime is the G17 guard at
// this layer. The card is built against the agent as it was when the human was
// told about it; when a button is pressed days later, S1's Guard compares that
// sequence with the agent's current one and refuses the keystroke. A card that
// carried no sequence — or somebody else's — would still be pressable, and
// pressing it types into whatever occupies that pane today.
func TestPushBlockedArmsEveryButtonWithTheStateSeqAtPushTime(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()

	if err := h.b.PushBlocked(context.Background(), a, permissionDialog()); err != nil {
		t.Fatalf("PushBlocked: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 1 {
		t.Fatalf("%d sends, want 1", len(sends))
	}
	out := sends[0].Out
	if out.ChatID != testChat {
		t.Errorf("card went to %q, want the configured notify chat %q", out.ChatID, testChat)
	}
	if out.Card == "" {
		t.Fatalf("PushBlocked did not send a card: %+v", out)
	}

	all := decisionsOf(t, out.Card)
	if len(all) == 0 {
		t.Fatal("the card has no buttons at all")
	}
	// The card that says "an agent needs you" must also be the card that aims
	// the chat at it: notification -> one tap -> start typing is the whole
	// interaction this product is built around.
	if !slices.Contains(actsOf(all), cards.ActSelect) {
		t.Errorf("the blocked card offers no Select button (acts = %v); answering it in prose would "+
			"cost a reply or a typed pane id", actsOf(all))
	}

	ds := keyDecisionsOf(all)
	for _, d := range ds {
		if d.Seq != a.StateSeq {
			t.Errorf("button %q carries seq %d, want the agent's %d at push time", d.Key, d.Seq, a.StateSeq)
		}
		if d.Pane != a.PaneID {
			t.Errorf("button %q carries pane %q, want %q", d.Key, d.Pane, a.PaneID)
		}
		if d.Kind != a.Kind {
			t.Errorf("button %q carries kind %q, want %q", d.Key, d.Kind, a.Kind)
		}
		if d.Nonce != testNonce {
			t.Errorf("button %q carries nonce %q, want the freshly minted one", d.Key, d.Nonce)
		}
		if d.IssuedAt != epoch.Unix() {
			t.Errorf("button %q was issued at %d, want the push time %d", d.Key, d.IssuedAt, epoch.Unix())
		}
	}

	// The options come off the screen, and Esc is always offered last: it is
	// the measured safe exit from a permission dialog (G2).
	if got, want := strings.Join(keysOf(ds), ","), "1,2,3,esc"; got != want {
		t.Errorf("buttons = %s, want %s", got, want)
	}

	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].MessageID != sends[0].ID || bound[0].PaneID != a.PaneID {
		t.Fatalf("Bind calls = %+v, want the card bound to %s", bound, a.PaneID)
	}
}

// TestPushBlockedMintsAFreshNoncePerCard: one card is one question, and its
// nonce is what makes the first press consume the whole thing (S2 §3.6).
func TestPushBlockedMintsAFreshNoncePerCard(t *testing.T) {
	h := newHarness(t)
	n := 0
	h.b.newNonce = func() (string, error) {
		n++
		return "nonce-" + string(rune('a'+n-1)), nil
	}

	for range 2 {
		if err := h.b.PushBlocked(context.Background(), blockedAgent(), permissionDialog()); err != nil {
			t.Fatal(err)
		}
	}

	sends := h.bot.sends()
	first := keyDecisionsOf(decisionsOf(t, sends[0].Out.Card))
	second := keyDecisionsOf(decisionsOf(t, sends[1].Out.Card))
	if first[0].Nonce == second[0].Nonce {
		t.Fatalf("two cards share the nonce %q; pressing one would disarm the other", first[0].Nonce)
	}
	for _, d := range first {
		if d.Nonce != first[0].Nonce {
			t.Error("buttons on one card carry different nonces; the card is one question")
		}
	}
}

// TestPushBlockedWithNoReadableOptionsStillOffersEsc: Claude's option count
// varies by prompt and version, and a guessed button would send a real
// keystroke to a live agent. Esc always works (G2), and prose always goes
// through the safe path (G1).
func TestPushBlockedWithNoReadableOptionsStillOffersEsc(t *testing.T) {
	h := newHarness(t)
	dialog := screen.Screen{Lines: []string{"esc to interrupt", "something unparseable"}, Cols: 100}

	if err := h.b.PushBlocked(context.Background(), blockedAgent(), dialog); err != nil {
		t.Fatalf("PushBlocked: %v", err)
	}

	ds := keyDecisionsOf(decisionsOf(t, h.bot.sends()[0].Out.Card))
	if got := keysOf(ds); len(got) != 1 || got[0] != "esc" {
		t.Fatalf("buttons = %v, want only esc", got)
	}
}

// TestPushBlockedFallsBackToTextWhenTheCardCannotBeDelivered.
//
// An undelivered "this agent needs you" strands both ends: the agent waits
// forever and the user is never asked. The fallback keeps the reply route, so
// the user can still answer in prose — which escapes the dialog first and can
// therefore never become an approval (G1).
func TestPushBlockedFallsBackToTextWhenTheCardCannotBeDelivered(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(timeoutError{})
	a := blockedAgent()

	if err := h.b.PushBlocked(context.Background(), a, permissionDialog()); err != nil {
		t.Fatalf("PushBlocked = %v, want nil: the user was told in the end", err)
	}

	sends := h.bot.sends()
	if len(sends) != 2 {
		t.Fatalf("%d sends, want the card attempt and one plain-text fallback", len(sends))
	}
	fallback := sends[1].Out
	if fallback.Card != "" {
		t.Fatalf("the fallback was another card: %+v", fallback)
	}
	if !strings.Contains(fallback.Text, "Do you want to proceed?") {
		t.Errorf("the fallback does not show what the agent is asking: %q", fallback.Text)
	}
	if !strings.Contains(fallback.Text, a.PaneID) {
		t.Errorf("the fallback does not name the pane: %q", fallback.Text)
	}
	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].PaneID != a.PaneID {
		t.Fatalf("the fallback was not bound for reply-routing: %+v", bound)
	}
}

func TestPushBlockedReportsWhenEvenTheFallbackFails(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(timeoutError{}, timeoutError{})

	if err := h.b.PushBlocked(context.Background(), blockedAgent(), permissionDialog()); err == nil {
		t.Fatal("PushBlocked reported success although nothing was delivered")
	}
}

func TestPushBlockedReportsANonceFailure(t *testing.T) {
	h := newHarness(t)
	boom := errors.New("entropy pool is empty")
	h.b.newNonce = func() (string, error) { return "", boom }

	err := h.b.PushBlocked(context.Background(), blockedAgent(), permissionDialog())
	if !errors.Is(err, boom) {
		t.Fatalf("PushBlocked = %v, want the nonce error", err)
	}
	if sends := h.bot.sends(); len(sends) != 0 {
		t.Fatalf("a card was posted without a usable nonce: %+v", sends)
	}
}

// TestPushBlockedFallsBackWhenTheCardCannotBeBuilt. BuildBlocked refuses a card
// it knows the callback would reject; the user still has to hear about the
// agent.
func TestPushBlockedFallsBackWhenTheCardCannotBeBuilt(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	a.PaneID = "" // BuildBlocked refuses: no pane means the buttons aim at nothing

	if err := h.b.PushBlocked(context.Background(), a, permissionDialog()); err != nil {
		t.Fatalf("PushBlocked: %v", err)
	}
	sends := h.bot.sends()
	if len(sends) != 1 || sends[0].Out.Card != "" || sends[0].Out.Text == "" {
		t.Fatalf("want a single plain-text notice, got %+v", sends)
	}
}

func TestPushesWithoutANotifyChatAreReported(t *testing.T) {
	h := newHarness(t, func(d *Deps) { d.NotifyChatID = "" })
	a := blockedAgent()

	tests := map[string]func() error{
		"blocked": func() error { return h.b.PushBlocked(context.Background(), a, permissionDialog()) },
		"done":    func() error { return h.b.PushDone(context.Background(), a, permissionDialog()) },
		"gone":    func() error { return h.b.PushGone(context.Background(), a) },
	}
	for name, push := range tests {
		t.Run(name, func(t *testing.T) {
			if err := push(); !errors.Is(err, ErrNoNotifyTarget) {
				t.Fatalf("push = %v, want ErrNoNotifyTarget", err)
			}
		})
	}
	if sends := h.bot.sends(); len(sends) != 0 {
		t.Fatalf("something was sent with no configured target: %+v", sends)
	}
}

// ---------- the finished card ----------

// finishedAgent is the agent the notifier hands to PushDone: the same one, one
// state later. `done` is idle-and-unseen, derived by herdr rather than matched
// off a screen, which makes it the most reliable trigger the bridge has (G11).
func finishedAgent() agents.Agent {
	a := blockedAgent()
	a.Status = agents.StatusDone
	a.StateSeq = 43
	return a
}

// scrollback is what screen.Tail hands PushDone, and it is the problem this
// wave exists to fix: three previous turns, tool chatter, the empty prompt box
// and the status line, around one line that answers the question. Every
// assertion below that says "not this" is naming a line of it.
func scrollback() screen.Screen {
	return screen.Screen{
		Lines: []string{
			"> Reply with just: OK",
			"⏺ OK",
			"> Use the Bash tool to run exactly: touch /tmp/herdr-probe2/from-phone.txt",
			"⏺ Ran 1 shell command",
			"⏺ Done. /tmp/herdr-probe2/from-phone.txt created.",
			"> 1Read the file a.md in this directory",
			"⏺ Ran 1 shell command",
			"⏺ a.md contains a single line of text: hi.",
			"╭──────────────────────────────────────────╮",
			"│ >                                        │",
			"╰──────────────────────────────────────────╯",
			"  ? for shortcuts                    ⏵⏵ accept edits on",
		},
		Rows: 49,
		Cols: 56,
	}
}

// The records of mirror's captured claude session, by position in the file.
// Naming them is what makes a transcript assembled below readable; the file
// itself is a real one (S2 §3.9 requires fixtures before parsers) and its shape
// is the vendor's, not this test's.
const (
	fxMode          = 0  // session metadata: not conversation
	fxUserOK        = 3  // "Reply with just: OK"
	fxAssistantOK   = 7  // "OK"
	fxUserTouch     = 10 // "Use the Bash tool to run exactly: touch ..."
	fxAssistantBash = 11 // tool_use Bash
	fxAssistantMade = 13 // "Done. `/tmp/herdr-probe2/from-phone.txt` created."
	fxUserRead      = 16 // "1Read the file a.md in this directory ..."
	fxAssistantRead = 17 // tool_use Read
	fxAssistantAMD  = 23 // the final answer
)

// What those records say, verbatim. Hardcoded rather than re-derived from the
// file: a test that computed its expectation the same way the code does would
// pass however wrong both were.
const (
	fxPromptRead = "1Read the file a.md in this directory and then tell me in two sentences what it contains."
	fxAnswerAMD  = "`a.md` contains a single line of text: `hi`. That's the entire file — no headings, structure, " +
		"or other content."
	fxAnswerMade = "Done. `/tmp/herdr-probe2/from-phone.txt` created."
	fxAnswerOK   = "OK"
)

// claudeFixture reads mirror's real claude transcript and returns its records.
func claudeFixture(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "mirror", "testdata", "claude-session.jsonl"))
	if err != nil {
		t.Fatalf("read the claude transcript fixture: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) <= fxAssistantAMD {
		t.Fatalf("the fixture has %d records; this test names record %d", len(lines), fxAssistantAMD)
	}
	return lines
}

// writeTranscript assembles a transcript out of real records and returns its
// path, the way agents.TranscriptResolver would (G8).
func writeTranscript(t *testing.T, records ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cf67e552-abca-4b2a-8711-f37c328ed677.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(records, "\n")+"\n"), 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	return path
}

// retextAssistant rewrites a real assistant record's text block, so a test can
// use a payload of its own choosing inside a record whose SHAPE is still the
// vendor's.
func retextAssistant(t *testing.T, record, text string) string {
	t.Helper()
	var rec map[string]any
	if err := json.Unmarshal([]byte(record), &rec); err != nil {
		t.Fatalf("fixture record is not JSON: %v", err)
	}
	msg, ok := rec["message"].(map[string]any)
	if !ok {
		t.Fatalf("fixture record has no message object: %s", record)
	}
	blocks, ok := msg["content"].([]any)
	if !ok || len(blocks) == 0 {
		t.Fatalf("fixture record has no content blocks: %s", record)
	}
	block, ok := blocks[0].(map[string]any)
	if !ok || block["type"] != "text" {
		t.Fatalf("fixture record does not open with a text block: %s", record)
	}
	block["text"] = text
	out, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("re-marshal fixture record: %v", err)
	}
	return string(out)
}

// withToolBlock appends another record's tool_use block to an assistant
// record, producing the shape claude writes when one message both says
// something and calls a tool. Both halves are real records; only the joint is
// this test's.
func withToolBlock(t *testing.T, textRecord, toolRecord string) string {
	t.Helper()
	var text, tool map[string]any
	if err := json.Unmarshal([]byte(textRecord), &text); err != nil {
		t.Fatalf("fixture record is not JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(toolRecord), &tool); err != nil {
		t.Fatalf("fixture record is not JSON: %v", err)
	}
	textMsg, ok := text["message"].(map[string]any)
	if !ok {
		t.Fatalf("fixture record has no message object: %s", textRecord)
	}
	toolMsg, ok := tool["message"].(map[string]any)
	if !ok {
		t.Fatalf("fixture record has no message object: %s", toolRecord)
	}
	blocks, ok := textMsg["content"].([]any)
	if !ok {
		t.Fatalf("fixture record has no content blocks: %s", textRecord)
	}
	toolBlocks, ok := toolMsg["content"].([]any)
	if !ok {
		t.Fatalf("fixture record has no content blocks: %s", toolRecord)
	}
	textMsg["content"] = append(blocks, toolBlocks...)
	out, err := json.Marshal(text)
	if err != nil {
		t.Fatalf("re-marshal fixture record: %v", err)
	}
	return string(out)
}

// cardMarkdown joins every markdown element of a rendered card, in order. It is
// what the reader sees, minus the buttons.
func cardMarkdown(t *testing.T, cardJSON string) string {
	t.Helper()
	var doc struct {
		Body struct {
			Elements []struct {
				Tag     string `json:"tag"`
				Content string `json:"content"`
			} `json:"elements"`
		} `json:"body"`
	}
	if err := json.Unmarshal([]byte(cardJSON), &doc); err != nil {
		t.Fatalf("card is not valid JSON: %v", err)
	}
	var parts []string
	for _, el := range doc.Body.Elements {
		if el.Tag == "markdown" {
			parts = append(parts, el.Content)
		}
	}
	return strings.Join(parts, "\n")
}

// TestPushDoneShowsWhatTheAgentSaidNotTheScreen is the whole point of this
// path.
//
// The user asked "现在几点了" and got eighteen lines of terminal back, with the
// answer buried in the middle. The transcript has roles and turn boundaries
// (G8), so the last thing the agent SAID can be lifted out of it whole — and
// everything a screen tail would have dragged along stays behind the card's
// Screen button, one tap away.
func TestPushDoneShowsWhatTheAgentSaidNotTheScreen(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	h.transcript(a.PaneID, writeTranscript(t, claudeFixture(t)...))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 1 {
		t.Fatalf("%d sends, want 1", len(sends))
	}
	out := sends[0].Out
	if out.ChatID != testChat {
		t.Errorf("the card went to %q, want the configured notify chat %q", out.ChatID, testChat)
	}
	if out.Card == "" {
		t.Fatalf("PushDone did not send a card: %+v", out)
	}

	body := cardMarkdown(t, out.Card)
	if !strings.Contains(body, fxAnswerAMD) {
		t.Errorf("the card does not carry the agent's final answer:\n%s", body)
	}
	// A prefix: the card shortens a long request to one line of context, which
	// is cards' business and is asserted exactly in the next test.
	if !strings.Contains(body, "1Read the file a.md in this directory") {
		t.Errorf("the card does not say what was asked:\n%s", body)
	}

	// Everything a screen tail drags in. The first two are earlier turns — one
	// of them inside the very window LastTurns sampled — and the rest is TUI
	// furniture, including the input box whose contents nobody typed (G4).
	for _, unwanted := range []string{
		fxAnswerMade, fxAnswerOK, "Ran 1 shell command", "? for shortcuts", "accept edits on",
	} {
		if strings.Contains(out.Card, unwanted) {
			t.Errorf("the card still carries %q from the screen tail:\n%s", unwanted, body)
		}
	}
	// The disclaimer belongs only to the fallback. Claiming a transcript was
	// missing when it was read would teach the reader to ignore the warning that
	// matters.
	if strings.Contains(body, "No transcript was available") {
		t.Errorf("the card disclaims an answer it really did quote:\n%s", body)
	}

	// Reply-routing is unchanged: the notification is how the user drives the
	// agent next (S2 §3.5).
	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].MessageID != sends[0].ID || bound[0].PaneID != a.PaneID {
		t.Fatalf("Bind calls = %+v, want the done card bound to %s", bound, a.PaneID)
	}
}

// TestPushDoneQuotesExactlyTheLastAssistantTurn pins WHICH turn is shown, by
// building the card the notifier should have built and comparing documents.
// The contains-checks above say the wrong text is absent; this says the right
// text — and only it — is present, with the request as context and no tools.
func TestPushDoneQuotesExactlyTheLastAssistantTurn(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	h.transcript(a.PaneID, writeTranscript(t, claudeFixture(t)...))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	want, err := cards.BuildDone(a, cards.Answer{Prompt: fxPromptRead, Text: fxAnswerAMD}, "", epoch)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := h.bot.sends()[0].Out.Card; got != want {
		t.Errorf("the card is not the agent's last turn as sent:\ngot  %s\nwant %s", got, want)
	}
}

// TestPushDoneSkipsATrailingToolCall: claude writes one record per content
// block, so an exchange can end with a record that is nothing but a tool call
// (G8). Quoting that would announce that the agent finished and said nothing,
// with the sentence the reader wants sitting one record above it.
func TestPushDoneSkipsATrailingToolCall(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	fx := claudeFixture(t)
	h.transcript(a.PaneID, writeTranscript(t,
		fx[fxUserRead], fx[fxAssistantAMD], fx[fxAssistantRead]))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	body := cardMarkdown(t, h.bot.sends()[0].Out.Card)
	if !strings.Contains(body, fxAnswerAMD) {
		t.Errorf("a trailing tool call hid the answer:\n%s", body)
	}
}

// TestPushDoneCarriesTheAnsweringTurnsToolCalls: what the agent did in the
// message it answered with is context worth one line each. What it did in the
// records BEFORE that stays behind the Screen button — "Ran 1 shell command",
// twice, around one line of answer is the notification this wave removed.
func TestPushDoneCarriesTheAnsweringTurnsToolCalls(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	fx := claudeFixture(t)
	h.transcript(a.PaneID, writeTranscript(t,
		fx[fxUserRead],
		fx[fxAssistantBash], // an earlier record's tool call: not this turn's
		withToolBlock(t, fx[fxAssistantAMD], fx[fxAssistantRead]),
	))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	want, err := cards.BuildDone(a, cards.Answer{
		Prompt: fxPromptRead,
		Text:   fxAnswerAMD,
		Tools:  []string{"Read(/private/tmp/herdr-probe2/a.md)"},
	}, "", epoch)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := h.bot.sends()[0].Out.Card; got != want {
		t.Errorf("the card does not carry the answering turn's tool calls:\ngot  %s\nwant %s", got, want)
	}
}

// TestPushDoneWithNoRequestInTheSampledWindow: the context line is optional.
// A window that opens after the request — a long exchange, or a sample that
// landed mid-turn — still carries the answer, which is the part that matters.
func TestPushDoneWithNoRequestInTheSampledWindow(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	fx := claudeFixture(t)
	h.transcript(a.PaneID, writeTranscript(t, fx[fxAssistantBash], fx[fxAssistantAMD]))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	want, err := cards.BuildDone(a, cards.Answer{Text: fxAnswerAMD}, "", epoch)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := h.bot.sends()[0].Out.Card; got != want {
		t.Errorf("a window with no request in it did not still show the answer:\ngot  %s\nwant %s", got, want)
	}
}

// TestPushDoneTruncatesARunawayAnswer. A phone shows about twenty lines before
// the reader is scrolling rather than reading, and an agent that answers with a
// whole file must not cost the notification its shape.
func TestPushDoneTruncatesARunawayAnswer(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	fx := claudeFixture(t)
	long := strings.Repeat("x", doneAnswerCells*3)
	h.transcript(a.PaneID, writeTranscript(t,
		fx[fxUserRead], retextAssistant(t, fx[fxAssistantAMD], long)))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	// The budget is in display cells and the ellipsis is charged one of them, so
	// the answer arrives one cell short of the budget, marked.
	want, err := cards.BuildDone(a, cards.Answer{
		Prompt:    fxPromptRead,
		Text:      strings.Repeat("x", doneAnswerCells-1) + "…",
		Truncated: true,
	}, "", epoch)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := h.bot.sends()[0].Out.Card; got != want {
		t.Errorf("a runaway answer was not cut to the phone budget:\ngot  %s\nwant %s", got, want)
	}
}

// TestPushDoneKeepsTheRequestBehindSeveralToolRecords.
//
// Claude writes one record per content block (G8), so a coding exchange with
// three tool calls is five turns: the request, three tool-only assistant
// records, and the message that answers. A window narrow enough to open after
// the request costs the card its "You asked" line — the one thing that makes a
// notification recognisable on a lock screen when the reader asked an hour ago.
func TestPushDoneKeepsTheRequestBehindSeveralToolRecords(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	fx := claudeFixture(t)
	h.transcript(a.PaneID, writeTranscript(t,
		fx[fxUserRead],
		fx[fxAssistantRead], fx[fxAssistantRead], fx[fxAssistantRead],
		fx[fxAssistantAMD]))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	want, err := cards.BuildDone(a, cards.Answer{Prompt: fxPromptRead, Text: fxAnswerAMD}, "", epoch)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := h.bot.sends()[0].Out.Card; got != want {
		t.Errorf("the tool records between the request and the answer hid the request:\ngot  %s\nwant %s", got, want)
	}
}

// TestPushDoneClosesACodeFenceTheCutOpened.
//
// A coding agent's long final message carrying a ``` block is the normal case,
// not a corner one, and the card renders a transcript answer as markdown. Cut
// inside the fence, the body would reach Feishu with an odd number of markers,
// leaving a block open over everything after it — starting with the note that
// says the answer was cut.
func TestPushDoneClosesACodeFenceTheCutOpened(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	fx := claudeFixture(t)
	// Sentence, patch, sentence. The patch alone is past the phone budget, so
	// the cut lands between the two fences.
	answer := "Here is the patch:\n\n```go\n" + strings.Repeat("x := 1\n", 300) + "```\nDone."
	h.transcript(a.PaneID, writeTranscript(t,
		fx[fxUserRead], retextAssistant(t, fx[fxAssistantAMD], answer)))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	body := cardMarkdown(t, h.bot.sends()[0].Out.Card)
	if n := strings.Count(body, "```"); n%2 != 0 {
		t.Errorf("the body carries %d fence markers, so a block is left open:\n%s", n, body)
	}
	// The element the open fence would have swallowed.
	if !strings.Contains(body, "cut to fit") {
		t.Errorf("the card does not say the answer was cut:\n%s", body)
	}
}

// TestPushDoneDoesNotCloseAFenceInsideAScreenTail is the other half of that,
// and it is deliberately the opposite behaviour.
//
// A screen tail is never rendered as markdown: cards wraps it whole in a fence
// longer than any run of backticks inside it, so an unbalanced ``` in a
// terminal grid is already inert — and appending one would draw a line of
// backticks into the character grid the crop exists to keep aligned (G5).
func TestPushDoneDoesNotCloseAFenceInsideAScreenTail(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent() // no transcript registered: the screen fallback

	const fence = "```go"
	lines := []string{fence}
	for range doneAnswerCells + 100 { // wider than the budget, so it is cut
		lines = append(lines, "x")
	}
	tail := screen.Screen{Lines: lines, Rows: 49, Cols: 56}

	if err := h.b.PushDone(context.Background(), a, tail); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	// Newlines cost no cells, the ellipsis costs one, and the cut lands on a
	// rune boundary — so the budget buys the fence plus that many single-cell
	// lines, plus the zero-width newline after the last of them, and nothing is
	// appended after the ellipsis.
	want, err := cards.BuildDone(a, cards.Answer{
		Text:       fence + strings.Repeat("\nx", doneAnswerCells-1-len(fence)) + "\n…",
		Truncated:  true,
		FromScreen: true,
	}, "", epoch)
	if err != nil {
		t.Fatalf("BuildDone: %v", err)
	}
	if got := h.bot.sends()[0].Out.Card; got != want {
		t.Errorf("the screen fallback was not the cut tail verbatim:\ngot  %s\nwant %s", got, want)
	}
}

// TestPushDoneFallsBackToTheScreen covers every way the transcript can fail to
// produce an answer. In each one the card must show the tail PushDone was
// handed AND mark it FromScreen: a terminal tail carries earlier turns, tool
// output and an input box that shows completions nobody typed (G4), so a card
// that presented it as the agent speaking would be quoting text no agent
// produced.
func TestPushDoneFallsBackToTheScreen(t *testing.T) {
	fx := claudeFixture(t)

	tests := map[string]struct {
		kind  string
		setup func(t *testing.T, h *harness, a agents.Agent)
	}{
		// The state every claude session starts in: herdr has detected the agent
		// but no session id exists yet, because the trust-this-directory prompt
		// has not been accepted (G8). Normal, not an error.
		"no session ref yet": {kind: "claude", setup: func(*testing.T, *harness, agents.Agent) {}},

		// A transcript we cannot read: here an agent kind no parser knows, which
		// mirror reports rather than silently returning nothing for.
		"the transcript cannot be read": {
			kind: "gemini",
			setup: func(t *testing.T, h *harness, a agents.Agent) {
				h.transcript(a.PaneID, writeTranscript(t, fx...))
			},
		},

		// A real transcript whose sampled tail holds no assistant turn at all:
		// metadata and one human turn, which is what a session looks like in its
		// first seconds.
		"no assistant turn in it": {
			kind: "claude",
			setup: func(t *testing.T, h *harness, a agents.Agent) {
				h.transcript(a.PaneID, writeTranscript(t, fx[fxMode], fx[fxUserOK]))
			},
		},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			a := finishedAgent()
			a.Kind = tt.kind
			tt.setup(t, h, a)
			tail := scrollback()

			if err := h.b.PushDone(context.Background(), a, tail); err != nil {
				t.Fatalf("PushDone: %v", err)
			}

			got := h.bot.sends()[0].Out.Card
			if got == "" {
				t.Fatalf("the fallback did not send a card: %+v", h.bot.sends()[0].Out)
			}
			want, err := cards.BuildDone(a, cards.Answer{Text: tail.Text(), FromScreen: true}, "", epoch)
			if err != nil {
				t.Fatalf("BuildDone: %v", err)
			}
			if got != want {
				t.Errorf("the fallback is not the screen tail marked as such:\ngot  %s\nwant %s", got, want)
			}
			// Named explicitly, because the equality above would also be
			// satisfied by a cards package that stopped disclaiming.
			if !strings.Contains(cardMarkdown(t, got), "No transcript was available") {
				t.Error("the fallback presents the terminal as the agent's own words")
			}
		})
	}
}

// TestPushDoneWithNothingToShowStillTellsTheUser: no transcript and an empty
// screen is still worth a push — the fact that the agent finished is the part
// the user cannot see from their phone.
func TestPushDoneWithNothingToShowStillTellsTheUser(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()

	if err := h.b.PushDone(context.Background(), a, screen.Screen{}); err != nil {
		t.Fatal(err)
	}

	out := h.bot.sends()[0].Out
	if out.Card == "" {
		t.Fatalf("nothing was pushed for a finished agent: %+v", out)
	}
	// An empty body would read as "the agent printed nothing", which is not the
	// same statement as "there was nothing to read".
	if body := cardMarkdown(t, out.Card); !strings.Contains(body, "no final message") {
		t.Errorf("an empty screen and no transcript rendered as %q", body)
	}
}

// TestPushDoneFallsBackToAPostWhenTheCardCannotBeBuilt. BuildDone refuses a
// card whose buttons would aim at no pane; the user still has to hear that the
// agent finished.
func TestPushDoneFallsBackToAPostWhenTheCardCannotBeBuilt(t *testing.T) {
	h := newHarness(t)
	a := finishedAgent()
	a.PaneID = ""

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 1 || sends[0].Out.Card != "" || sends[0].Out.Markdown == "" {
		t.Fatalf("want a single markdown post, got %+v", sends)
	}
	if !strings.Contains(sends[0].Out.Markdown, "? for shortcuts") {
		t.Errorf("the post does not carry the screen it fell back to: %q", sends[0].Out.Markdown)
	}
	// There is no transcript for this pane, so the body really is the terminal.
	// The post has to say so for the same reason the card does: the input box
	// shows completions nobody typed (G4).
	if !strings.Contains(sends[0].Out.Markdown, "not the agent's own words") {
		t.Errorf("the post presents the terminal as the agent speaking: %q", sends[0].Out.Markdown)
	}
}

// TestPushDoneFallsBackToAPostWhenTheCardCannotBeDelivered.
//
// sendOne cannot downgrade a card the way it downgrades markdown — a card's
// body is JSON, not prose — and `done` produces no second transition to retry
// on, so a card Feishu refuses would otherwise cost the user the notification
// entirely.
//
// The post carries the SAME answer the card would have. Losing the rendering is
// not a reason to lose the content: the transcript was read before the card was
// built, so falling back to the screen tail here would hand the reader the
// scrollback this wave removed, on the one path where the notification has
// already failed them once.
func TestPushDoneFallsBackToAPostWhenTheCardCannotBeDelivered(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrFormat))
	a := finishedAgent()
	h.transcript(a.PaneID, writeTranscript(t, claudeFixture(t)...))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone = %v, want nil: the user was told in the end", err)
	}

	sends := h.bot.sends()
	if len(sends) != 2 {
		t.Fatalf("%d sends, want the card attempt and one markdown fallback", len(sends))
	}
	post := sends[1].Out
	if post.Card != "" || post.Markdown == "" {
		t.Fatalf("the fallback was not a plain post: %+v", post)
	}
	if !strings.Contains(post.Markdown, fxAnswerAMD) {
		t.Errorf("the post does not carry the agent's final answer:\n%s", post.Markdown)
	}
	if !strings.Contains(post.Markdown, "1Read the file a.md in this directory") {
		t.Errorf("the post does not say what was asked:\n%s", post.Markdown)
	}
	// The twelve lines of scrollback the user complained about, named one by
	// one. The transcript answered the question; none of this belongs in the
	// message that reports it.
	for _, unwanted := range []string{
		"? for shortcuts", "accept edits on", "Ran 1 shell command", fxAnswerMade, fxAnswerOK,
		"> Reply with just",
	} {
		if strings.Contains(post.Markdown, unwanted) {
			t.Errorf("the post still carries %q from the screen tail:\n%s", unwanted, post.Markdown)
		}
	}
	// The disclaimer belongs to a body that really is the terminal.
	if strings.Contains(post.Markdown, "not the agent's own words") {
		t.Errorf("the post disclaims an answer it really did quote:\n%s", post.Markdown)
	}
	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].PaneID != a.PaneID {
		t.Fatalf("the fallback was not bound for reply-routing: %+v", bound)
	}
}

// TestPushDonePostCarriesTheAnsweringTurnsToolCalls: the plain post keeps the
// card's other two elements too — what the agent did in the message it answered
// with, and the admission that a long answer was cut. Both are one line; the
// scrollback they replace was twelve.
func TestPushDonePostCarriesTheAnsweringTurnsToolCallsAndSaysWhenItCut(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrFormat))
	a := finishedAgent()
	fx := claudeFixture(t)
	long := strings.Repeat("x", doneAnswerCells*2)
	h.transcript(a.PaneID, writeTranscript(t,
		fx[fxUserRead],
		withToolBlock(t, retextAssistant(t, fx[fxAssistantAMD], long), fx[fxAssistantRead]),
	))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	md := h.bot.sends()[1].Out.Markdown
	if !strings.Contains(md, toolBullet+"Read(/private/tmp/herdr-probe2/a.md)") {
		t.Errorf("the post does not carry the answering turn's tool call:\n%s", md)
	}
	if !strings.Contains(md, "cut to fit") {
		t.Errorf("the post presents a cut answer as the whole of it:\n%s", md)
	}
}

// TestPushDonePostWithNoFinalMessageStillSaysSo: an exchange whose sampled
// window ends on a tool-only record has no sentence to quote (G8). The post
// still reports the fact the user cannot see from a phone — that the agent
// finished — rather than arriving as an empty bubble, and it does NOT reach for
// the screen: the transcript was read, it simply had no final message.
func TestPushDonePostWithNoFinalMessageStillSaysSo(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrFormat))
	a := finishedAgent()
	fx := claudeFixture(t)
	h.transcript(a.PaneID, writeTranscript(t, fx[fxUserRead], fx[fxAssistantRead]))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}

	md := h.bot.sends()[1].Out.Markdown
	if !strings.Contains(md, "no final message") {
		t.Errorf("a turn with nothing said rendered as %q", md)
	}
	if !strings.Contains(md, toolBullet+"Read(") {
		t.Errorf("the post does not say what the agent did instead:\n%s", md)
	}
	if strings.Contains(md, "? for shortcuts") {
		t.Errorf("the post fell back to the screen although the transcript was read:\n%s", md)
	}
}

// TestToolBullets pins the two rules of the collapsed tool list: the overflow
// is counted rather than listed, and a blank summary is dropped WITHOUT being
// counted — "+1 more" must never promise the reader something to go and look at
// that does not exist.
func TestToolBullets(t *testing.T) {
	tests := map[string]struct {
		in   []string
		want string
	}{
		"none":            {in: nil, want: ""},
		"only blanks":     {in: []string{"", "   "}, want: ""},
		"blanks are free": {in: []string{"Bash(date)", "  "}, want: toolBullet + "Bash(date)"},
		"folded onto one line": {
			in:   []string{"Bash(echo\nhi)"},
			want: toolBullet + "Bash(echo hi)",
		},
		"overflow is counted": {
			in: []string{"a", "b", "c", "d", "e", "f", "g"},
			want: toolBullet + "a\n" + toolBullet + "b\n" + toolBullet + "c\n" +
				toolBullet + "d\n" + toolBullet + "e\n_+2 more_",
		},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			if got := toolBullets(tt.in); got != tt.want {
				t.Errorf("toolBullets(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestPushDoneReportsWhenEvenThePostFails(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrFormat), failing(lark.ErrPermissionDenied))

	if err := h.b.PushDone(context.Background(), finishedAgent(), scrollback()); err == nil {
		t.Fatal("PushDone reported success although nothing was delivered")
	}
}

// TestPushDoneDoesNotSpendANonce. Both buttons on a finished card are inert, so
// there is nothing to make single-use — and writing a nonce in would let a tap
// on this card spend one that a live blocked card still depends on (S2 §3.6).
func TestPushDoneDoesNotSpendANonce(t *testing.T) {
	h := newHarness(t)
	minted := 0
	h.b.newNonce = func() (string, error) {
		minted++
		return testNonce, nil
	}
	a := finishedAgent()
	h.transcript(a.PaneID, writeTranscript(t, claudeFixture(t)...))

	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatalf("PushDone: %v", err)
	}
	if minted != 0 {
		t.Errorf("PushDone minted %d nonces for a card that can send nothing", minted)
	}
	for _, d := range decisionsOf(t, h.bot.sends()[0].Out.Card) {
		if !d.Inert() {
			t.Errorf("the finished card carries a button that types into the pane: %+v", d)
		}
		if d.Nonce != "" {
			t.Errorf("an inert button carries nonce %q; the callback refuses those", d.Nonce)
		}
	}
}

// TestTruncateCells measures the budget in cells rather than runes, because
// this bridge carries Chinese: one CJK rune is two cells, so a rune-counted
// budget would mean one width for English answers and half of it for Chinese
// ones (G5, S1 §3.3).
func TestTruncateCells(t *testing.T) {
	tests := []struct {
		name  string
		in    string
		limit int
		want  string
		cut   bool
	}{
		{"under budget", "hello", 10, "hello", false},
		{"exactly the budget", "hello", 5, "hello", false},
		{"ascii", "hello world", 6, "hello…", true},
		{"chinese counts double", "现在几点了", 6, "现在…", true},
		{"never splits a wide rune", "现在几点了", 5, "现在…", true},
		{"an emoji is wide too", "🚀🚀🚀", 3, "🚀…", true},
		// Decomposed on purpose: the combining acute is its own rune, so it must
		// cost no cell — otherwise a budget would shrink on accented text.
		{"a combining mark costs nothing", "e\u0301abc", 3, "e\u0301a\u2026", true},
		{"a newline costs nothing", "a\nb", 3, "a\nb", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, cut := truncateCells(tt.in, tt.limit)
			if got != tt.want || cut != tt.cut {
				t.Fatalf("truncateCells(%q, %d) = %q, %v; want %q, %v", tt.in, tt.limit, got, cut, tt.want, tt.cut)
			}
			if w := displayWidth(got); w > tt.limit {
				t.Fatalf("result is %d cells wide, over the %d budget", w, tt.limit)
			}
		})
	}
}

// TestPushGoneIsPlainAndUnbound: the pane is gone, so a reply to this message
// could only produce an error. Leaving it unbound lets the reply fall through
// to the normal routing rules instead.
func TestPushGoneIsPlainAndUnbound(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	a.Status = agents.StatusGone

	if err := h.b.PushGone(context.Background(), a); err != nil {
		t.Fatalf("PushGone: %v", err)
	}

	out := h.bot.sends()[0].Out
	if out.Text == "" || out.Card != "" || out.Markdown != "" {
		t.Fatalf("PushGone did not send plain text: %+v", out)
	}
	if !strings.Contains(out.Text, a.PaneID) {
		t.Errorf("the message does not name the pane: %q", out.Text)
	}
	if bound := h.routes.bound(); len(bound) != 0 {
		t.Fatalf("a dead pane was bound for reply-routing: %+v", bound)
	}
}

func TestPushGoneReportsADeliveryFailure(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrPermissionDenied))

	if err := h.b.PushGone(context.Background(), blockedAgent()); err == nil {
		t.Fatal("PushGone reported success although nothing was delivered")
	}
}

func TestAgentLabel(t *testing.T) {
	tests := []struct {
		name string
		a    agents.Agent
		want string
	}{
		{"full", agents.Agent{Kind: "claude", Cwd: "/tmp/herdr-accept", PaneID: "w1:p1"}, "claude · herdr-accept · w1:p1"},
		{"no kind yet", agents.Agent{Cwd: "/tmp/x", PaneID: "w1:p2"}, "agent · x · w1:p2"},
		{"no cwd", agents.Agent{Kind: "codex", PaneID: "w2:p1"}, "codex · w2:p1"},
		{"root cwd", agents.Agent{Kind: "codex", Cwd: "/", PaneID: "w2:p1"}, "codex · w2:p1"},
		{"nothing", agents.Agent{}, "agent"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := agentLabel(tt.a); got != tt.want {
				t.Fatalf("agentLabel = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestFencedBlockSurvivesBackticks: agent output is full of them, and a fence
// the content closes early turns the rest of the message into prose.
func TestFencedBlockSurvivesBackticks(t *testing.T) {
	got := fencedBlock("run ``` this")
	if !strings.HasPrefix(got, "````\n") || !strings.HasSuffix(got, "\n````") {
		t.Fatalf("fencedBlock = %q, want a longer fence than the content's", got)
	}
}

// TestRandomNonceIsUnique guards the real minting function, which the harness
// replaces everywhere else.
func TestRandomNonceIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		n, err := randomNonce()
		if err != nil {
			t.Fatalf("randomNonce: %v", err)
		}
		if len(n) != nonceBytes*2 {
			t.Fatalf("nonce %q is %d chars, want %d", n, len(n), nonceBytes*2)
		}
		if seen[n] {
			t.Fatalf("nonce %q was minted twice; a collision disarms a card nobody pressed", n)
		}
		seen[n] = true
	}
}
