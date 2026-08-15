package cards

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// codexAgent is the second agent in the fixtures. Its terminal_title_stripped
// is just the cwd (G8), and herdr has no session ref for it — codex only yields
// one after the hook is trusted by hand inside codex.
func codexAgent() agents.Agent {
	return agents.Agent{
		PaneID:   "w1:p2",
		Kind:     "codex",
		Status:   agents.StatusIdle,
		Cwd:      "/tmp/herdr-probe2",
		Title:    "herdr-probe2",
		StateSeq: 7,
	}
}

// listButtons returns the picker's buttons grouped by row, so a test can say
// "the second row's select button" without counting.
func listButtons(t *testing.T, card map[string]any) [][]map[string]any {
	t.Helper()
	body, ok := card["body"].(map[string]any)
	if !ok {
		t.Fatal("card has no body object")
	}
	elements, _ := body["elements"].([]any)
	var rows [][]map[string]any
	for _, el := range elements {
		set, ok := el.(map[string]any)
		if !ok || set["tag"] != "column_set" {
			continue
		}
		var row []map[string]any
		cols, _ := set["columns"].([]any)
		for _, c := range cols {
			col, _ := c.(map[string]any)
			inner, _ := col["elements"].([]any)
			for _, e := range inner {
				if btn, ok := e.(map[string]any); ok && btn["tag"] == "button" {
					row = append(row, btn)
				}
			}
		}
		rows = append(rows, row)
	}
	return rows
}

// listDecisions returns one decoded Decision per button, row by row.
func listDecisions(t *testing.T, card map[string]any) [][]Decision {
	t.Helper()
	var out [][]Decision
	for _, row := range listButtons(t, card) {
		var ds []Decision
		for _, b := range row {
			behaviors, _ := b["behaviors"].([]any)
			if len(behaviors) == 0 {
				t.Fatalf("button %v has no behaviors", b["text"])
			}
			first, _ := behaviors[0].(map[string]any)
			value, ok := first["value"].(map[string]any)
			if !ok {
				t.Fatalf("button %v has no value object", b["text"])
			}
			d, err := DecodeDecision(value)
			if err != nil {
				t.Fatalf("button %v does not decode: %v", b["text"], err)
			}
			ds = append(ds, d)
		}
		out = append(out, ds)
	}
	return out
}

// panesInOrder is the order the rows are drawn in, read off the buttons.
func panesInOrder(t *testing.T, card map[string]any) []string {
	t.Helper()
	var out []string
	for _, row := range listDecisions(t, card) {
		out = append(out, row[0].Pane)
	}
	return out
}

// ---------- golden structure ----------

// TestBuildAgentListGolden pins the picker: two agents, the second of them the
// chat's current target.
func TestBuildAgentListGolden(t *testing.T) {
	js, err := BuildAgentList([]agents.Agent{codexAgent(), blockedAgent()}, "w1:p2", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}

	iat := float64(issuedAt.Unix())
	value := func(act, pane, kind string, seq float64, session string) map[string]any {
		v := map[string]any{
			"act": act, "key": "", "pane": pane, "kind": kind,
			"seq": seq, "iat": iat, "n": "",
		}
		if session != "" {
			v["sid"] = session
		}
		return v
	}
	button := func(text, style string, v map[string]any) any {
		return map[string]any{
			"tag":   "column",
			"width": "auto",
			"elements": []any{map[string]any{
				"tag":  "button",
				"text": map[string]any{"tag": "plain_text", "content": text},
				"type": style,
				"behaviors": []any{map[string]any{
					"type": "callback", "value": v,
				}},
			}},
		}
	}
	buttonRow := func(cols ...any) any {
		return map[string]any{
			"tag":                "column_set",
			"flex_mode":          "flow",
			"horizontal_spacing": "8px",
			"columns":            cols,
		}
	}

	claudeSid := claudeSession().Value
	want := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"update_multi": true,
			"summary":      map[string]any{"content": "2 agents · 1 waiting for you"},
		},
		"header": map[string]any{
			"title": map[string]any{"tag": "plain_text", "content": "2 agents"},
			"subtitle": map[string]any{
				"tag": "plain_text", "content": "your typing goes to codex · herdr-probe2 · w1:p2",
			},
			"template": "blue",
		},
		"body": map[string]any{
			"elements": []any{
				// Blocked sorts above idle even though it was passed second.
				map[string]any{
					"tag":     "markdown",
					"content": "🔴 **claude** · herdr-accept\n`w1:p1` · blocked · Create DANGER.txt",
				},
				buttonRow(
					button("Select", "default", value("select", "w1:p1", "claude", 42, claudeSid)),
					button("Screen", "default", value("screen", "w1:p1", "claude", 42, claudeSid)),
				),
				map[string]any{"tag": "hr"},
				// The current row: marker, and a select button that states a fact.
				// codex's title is its cwd, so it is not repeated (G8).
				map[string]any{
					"tag":     "markdown",
					"content": "▶ 💤 **codex** · herdr-probe2\n`w1:p2` · idle",
				},
				buttonRow(
					button("✓ Selected", "primary", value("select", "w1:p2", "codex", 7, "")),
					button("Screen", "default", value("screen", "w1:p2", "codex", 7, "")),
				),
				map[string]any{"tag": "markdown", "content": listHint},
				map[string]any{
					"tag":     "markdown",
					"content": "_as of 2026-08-14 01:23:45 CST · `/help` for commands_",
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

// ---------- ordering ----------

// TestAgentListPutsWhatNeedsAHumanFirst: the list exists to find the agent that
// is stopped. blocked first, then done (herdr derives it without a regex, so it
// is the status we trust most, G11), then working, then idle, then a state this
// build does not recognise. Gone is not in the order at all; see
// TestAgentListDropsAgentsThatCannotBeTalkedTo.
func TestAgentListPutsWhatNeedsAHumanFirst(t *testing.T) {
	agent := func(pane string, s agents.Status) agents.Agent {
		return agents.Agent{PaneID: pane, Kind: "claude", Status: s, Cwd: "/tmp/x"}
	}
	list := []agents.Agent{
		agent("w1:p3", agents.StatusIdle),
		agent("w1:p2", agents.StatusWorking),
		agent("w8:p1", agents.StatusUnknown),
		agent("w1:p1", agents.StatusDone),
		agent("w2:p1", agents.StatusBlocked),
		// Two blocked agents: the tie breaks on pane id, so the same set always
		// renders the same card.
		agent("w0:p1", agents.StatusBlocked),
	}

	js, err := BuildAgentList(list, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	want := []string{"w0:p1", "w2:p1", "w1:p1", "w1:p2", "w1:p3", "w8:p1"}
	if got := panesInOrder(t, decodeCard(t, js)); !reflect.DeepEqual(got, want) {
		t.Fatalf("row order = %v, want %v", got, want)
	}
}

// TestAgentListOrderDoesNotDependOnInputOrder: the card is re-rendered in place
// on every selection change, so two renders of the same set that disagreed
// about order would shuffle the rows under the user's thumb.
func TestAgentListOrderDoesNotDependOnInputOrder(t *testing.T) {
	a, b := blockedAgent(), codexAgent()
	first, err := BuildAgentList([]agents.Agent{a, b}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	second, err := BuildAgentList([]agents.Agent{b, a}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	if first != second {
		t.Fatalf("the same agents in a different order rendered different cards:\n%s\n%s", first, second)
	}
}

// ---------- current row ----------

// TestAgentListMarksTheCurrentRow: the marked row must be findable by text, not
// only by button colour — this is the card that decides where typing lands.
func TestAgentListMarksTheCurrentRow(t *testing.T) {
	js, err := BuildAgentList([]agents.Agent{blockedAgent(), codexAgent()}, "w1:p1", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	card := decodeCard(t, js)

	rows := listButtons(t, card)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	current, other := rows[0][0], rows[1][0]
	if got := current["text"].(map[string]any)["content"]; got != selectedText {
		t.Fatalf("current row's select button reads %q, want %q", got, selectedText)
	}
	if got := other["text"].(map[string]any)["content"]; got != selectText {
		t.Fatalf("other row's select button reads %q, want %q", got, selectText)
	}
	if current["type"] == other["type"] {
		t.Fatalf("both select buttons are styled %v; the current row must look different", current["type"])
	}

	body := card["body"].(map[string]any)["elements"].([]any)
	currentText := body[0].(map[string]any)["content"].(string)
	otherText := body[3].(map[string]any)["content"].(string)
	if !strings.HasPrefix(currentText, currentMarker) {
		t.Fatalf("current row %q does not start with the marker %q", currentText, currentMarker)
	}
	if strings.Contains(otherText, currentMarker) {
		t.Fatalf("a row that is not current carries the marker: %q", otherText)
	}
	if header := allText(card["header"]); !strings.Contains(header, "w1:p1") {
		t.Fatalf("header does not say where typing goes:\n%s", header)
	}

	// Still pressable: re-confirming the row that already looks selected is
	// what re-reads the live identity and records it.
	d := listDecisions(t, card)[0][0]
	if d.Act != ActSelect || d.Pane != "w1:p1" {
		t.Fatalf("current row's select button decoded to %+v", d)
	}
}

// TestAgentListSaysWhenTheSelectionIsGone: a selection lasts until the user
// sends /close, and an agent can exit in a minute. Marking no row at all would
// read as "nothing is selected" — which is exactly wrong now, and would send
// the user hunting for a button to press when the aim never moved.
func TestAgentListSaysWhenTheSelectionIsGone(t *testing.T) {
	js, err := BuildAgentList([]agents.Agent{codexAgent()}, "w7:p7", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	card := decodeCard(t, js)
	text := allText(card)
	if !strings.Contains(text, "still aimed at w7:p7") {
		t.Fatalf("card does not say the aim is still standing:\n%s", text)
	}
	if strings.Contains(text, "nothing selected") {
		t.Fatalf("card claims nothing is selected although the chat is still aimed:\n%s", text)
	}
	if strings.Contains(text, selectedText) {
		t.Fatalf("a row is marked as selected although that agent is not running:\n%s", text)
	}
}

// ---------- values ----------

// TestAgentListButtonsAreInertAndCarryIdentity is the safety core of the card.
//
// Nothing on it may reach an agent's keyboard: no key, and no nonce to spend —
// the picker is never disarmed, it is re-rendered in place, so a nonce would
// make the second tap of the day fail for no reason. What each button DOES
// carry is kind and session, because a pane id is a seat and not an identity:
// claude can exit and codex start in the same pane, and a selection that
// remembered the seat alone would silently aim tomorrow's typing at whatever is
// sitting there (G8, G17).
func TestAgentListButtonsAreInertAndCarryIdentity(t *testing.T) {
	js, err := BuildAgentList([]agents.Agent{blockedAgent(), codexAgent()}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	card := decodeCard(t, js)

	want := [][]Decision{
		{
			{Act: ActSelect, Pane: "w1:p1", Kind: "claude", Seq: 42, IssuedAt: issuedAt.Unix(), Session: claudeSession().Value},
			{Act: ActScreen, Pane: "w1:p1", Kind: "claude", Seq: 42, IssuedAt: issuedAt.Unix(), Session: claudeSession().Value},
		},
		{
			{Act: ActSelect, Pane: "w1:p2", Kind: "codex", Seq: 7, IssuedAt: issuedAt.Unix()},
			{Act: ActScreen, Pane: "w1:p2", Kind: "codex", Seq: 7, IssuedAt: issuedAt.Unix()},
		},
	}
	got := listDecisions(t, card)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("button values =\n%+v\nwant\n%+v", got, want)
	}
	for _, row := range got {
		for _, d := range row {
			if !d.Inert() {
				t.Fatalf("%+v is not inert; something on the picker can send input", d)
			}
			if d.Key != "" || d.Nonce != "" {
				t.Fatalf("%+v carries a key or a nonce", d)
			}
		}
	}
}

// TestAgentListDropsAnOversizedSessionRef: a ref longer than DecodeDecision
// accepts must not be truncated into the value. A truncated id would never
// again equal the live one, so every delivery would be refused with a reason
// nobody could act on; dropping it degrades to the pane+kind check that an
// agent without a ref yet already lives with (G8).
func TestAgentListDropsAnOversizedSessionRef(t *testing.T) {
	a := blockedAgent()
	a.SessionRef = &herdrapi.SessionRef{Kind: "path", Value: strings.Repeat("x", maxSessionID+1)}

	js, err := BuildAgentList([]agents.Agent{a}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	d := listDecisions(t, decodeCard(t, js))[0][0]
	if d.Session != "" {
		t.Fatalf("session = %q, want it dropped rather than truncated", d.Session)
	}
}

// ---------- re-render ----------

// TestAgentListBodyDoesNotChurn: the card is re-rendered in place on every
// selection change (config.update_multi). Anything in the body that moved with
// the clock would rewrite the user's chat every time, so exactly one line — the
// last — is allowed to carry a timestamp.
func TestAgentListBodyDoesNotChurn(t *testing.T) {
	list := []agents.Agent{blockedAgent(), codexAgent()}
	first, err := BuildAgentList(list, "w1:p1", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	later := issuedAt.Add(97 * time.Minute)
	second, err := BuildAgentList(list, "w1:p1", later)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	if first == second {
		t.Fatal("two renders an hour apart are identical; the footer does not carry the time")
	}

	a, b := decodeCard(t, first), decodeCard(t, second)
	stripFooter(t, a)
	stripFooter(t, b)
	// The issue stamp inside the button values is not body text; it moves by
	// design, so it is normalised away here.
	stripIssuedAt(a)
	stripIssuedAt(b)
	if !reflect.DeepEqual(a, b) {
		gotPretty, _ := json.MarshalIndent(a, "", "  ")
		wantPretty, _ := json.MarshalIndent(b, "", "  ")
		t.Fatalf("the card changed outside its footer\n%s\n%s", gotPretty, wantPretty)
	}

	// And the footer really is the line that carries it.
	if !strings.Contains(lastElementText(t, decodeCard(t, second)), later.Format(stampLayout)) {
		t.Fatal("the footer does not state the time the list was taken")
	}
}

func stripFooter(t *testing.T, card map[string]any) {
	t.Helper()
	body := card["body"].(map[string]any)
	elements := body["elements"].([]any)
	body["elements"] = elements[:len(elements)-1]
}

func lastElementText(t *testing.T, card map[string]any) string {
	t.Helper()
	elements := card["body"].(map[string]any)["elements"].([]any)
	return elements[len(elements)-1].(map[string]any)["content"].(string)
}

// stripIssuedAt zeroes every iat in the tree.
func stripIssuedAt(v any) {
	switch t := v.(type) {
	case map[string]any:
		if _, ok := t["iat"]; ok {
			t["iat"] = float64(0)
		}
		for _, child := range t {
			stripIssuedAt(child)
		}
	case []any:
		for _, child := range t {
			stripIssuedAt(child)
		}
	}
}

// ---------- degenerate lists ----------

// TestBuildAgentListEmpty: no agents is the expected state in v1 — the bridge
// does not start them — so the card explains how to get one rather than
// failing or rendering an empty shell.
func TestBuildAgentListEmpty(t *testing.T) {
	js, err := BuildAgentList(nil, "", issuedAt)
	if err != nil {
		t.Fatalf("an empty list must still render a card: %v", err)
	}
	card := decodeCard(t, js)
	if got := findTag(card, "button"); len(got) != 0 {
		t.Fatalf("empty list has %d button(s)", len(got))
	}
	text := allText(card)
	for _, want := range []string{"No agent is running", "claude", "codex", "does not start agents", "/ls"} {
		if !strings.Contains(text, want) {
			t.Fatalf("empty card does not mention %q:\n%s", want, text)
		}
	}
	// The 53-column trap: a pane nothing ever attached to silently degrades
	// blocked detection to idle, and the user only ever fixes that once, at the
	// moment they start the agent (G5, G11).
	if !strings.Contains(text, "53 columns") {
		t.Fatalf("empty card does not warn about a never-attached pane:\n%s", text)
	}
	if got := card["header"].(map[string]any)["title"].(map[string]any)["content"]; got != "no agents" {
		t.Fatalf("header title = %q", got)
	}
}

// TestBuildAgentListOmitsAgentsWithNoPane: the pane id is the address a press
// comes back with (G16), so a row without one cannot carry a button. herdr keys
// its agents by pane id, so this is a "cannot happen" — and is therefore stated
// rather than hidden.
func TestBuildAgentListOmitsAgentsWithNoPane(t *testing.T) {
	js, err := BuildAgentList([]agents.Agent{{Kind: "claude", Status: agents.StatusIdle}, codexAgent()}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	card := decodeCard(t, js)
	if got := panesInOrder(t, card); !reflect.DeepEqual(got, []string{"w1:p2"}) {
		t.Fatalf("rows = %v, want only the agent that has an address", got)
	}
	if text := allText(card); !strings.Contains(text, "without a pane id") {
		t.Fatalf("card hides the agent it dropped:\n%s", text)
	}
}

// TestAgentListDropsAgentsThatCannotBeTalkedTo covers the two rows that must
// never be armed, and what the header says when the selection is one of them.
//
// A gone agent has nothing to select: the pane is closed, and delivery refuses
// with ErrPaneGone. Worse, the Registry synthesises its state sequence from the
// top of uint64 (MaxUint64-n), which is past the largest integer a JSON float64
// carries exactly — so DecodeDecision refuses the value the button would send,
// and a press of it is undecodable by construction.
//
// The header is the line the reader's eye lands on and the only question this
// card exists to answer, so it must not promise a destination the row's own ⚫
// contradicts.
func TestAgentListDropsAgentsThatCannotBeTalkedTo(t *testing.T) {
	gone := agents.Agent{
		PaneID: "w9:p9", Kind: "claude", Status: agents.StatusGone,
		Cwd: "/tmp/x", StateSeq: math.MaxUint64 - 1,
	}
	js, err := BuildAgentList([]agents.Agent{gone, codexAgent()}, "w9:p9", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	card := decodeCard(t, js)

	// listDecisions decodes every button, so a row whose seq cannot survive the
	// wire would fail there rather than here.
	if got := panesInOrder(t, card); !reflect.DeepEqual(got, []string{"w1:p2"}) {
		t.Fatalf("rows = %v, want only the agent that can still be talked to", got)
	}
	text := allText(card)
	if !strings.Contains(text, "still aimed at w9:p9") {
		t.Fatalf("header does not say the aim is still standing:\n%s", text)
	}
	if strings.Contains(text, "your typing goes to") {
		t.Fatalf("header claims typing reaches a gone agent:\n%s", text)
	}
	// It is not a gap in the list — the agent stopped existing — so it is not
	// reported as one.
	if strings.Contains(text, "not listed") {
		t.Fatalf("a gone agent is reported as an agent the user is missing:\n%s", text)
	}
}

// TestAgentListDropsAnUnsendableStateSeq: BuildBlocked refuses to draw a button
// whose key or nonce the controller would later refuse, and the picker owes the
// same. A sequence at or past 2^53 does not survive JSON, so DecodeDecision
// rejects it on the way back and the press could only ever be refused.
func TestAgentListDropsAnUnsendableStateSeq(t *testing.T) {
	a := codexAgent()
	a.StateSeq = maxSafeInt
	js, err := BuildAgentList([]agents.Agent{a, blockedAgent()}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	card := decodeCard(t, js)
	if got := panesInOrder(t, card); !reflect.DeepEqual(got, []string{"w1:p1"}) {
		t.Fatalf("rows = %v, want only the agent whose seq survives the wire", got)
	}
	if text := allText(card); !strings.Contains(text, "not listed") {
		t.Fatalf("card hides the agent it dropped:\n%s", text)
	}
}

// TestAgentListWarnsThatTypingCancelsAQuestion: blocked agents sort first, so
// Select is most likely to be tapped on the one row where typing does something
// the user did not ask for — Controller.Say sends esc before prose, because
// prose at a menu is discarded and the Enter behind it takes the highlighted
// default (G1, G2). Saying it only in the delivery report says it too late.
func TestAgentListWarnsThatTypingCancelsAQuestion(t *testing.T) {
	js, err := BuildAgentList([]agents.Agent{blockedAgent()}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	text := allText(decodeCard(t, js))
	for _, want := range []string{"waiting at a question", "esc", "nothing gets approved"} {
		if !strings.Contains(text, want) {
			t.Fatalf("picker does not warn that typing backs out of a question (%q):\n%s", want, text)
		}
	}
}

// TestAgentRowCannotForgeAnotherRow: Title is text the agent writes from model
// output (G8) and a row is markdown, so a newline in it opens a line inside the
// row's element — while the buttons that belong to the row sit in a separate
// element below. A payload that draws a second, marked row would let a user aim
// their typing at one agent while reading the name of another.
func TestAgentRowCannotForgeAnotherRow(t *testing.T) {
	a := blockedAgent()
	a.Title = "x\n" + currentMarker + " 💤 **codex** · herdr-probe2"
	a.Cwd = "/tmp/inject\nme"

	js, err := BuildAgentList([]agents.Agent{a}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	row := decodeCard(t, js)["body"].(map[string]any)["elements"].([]any)[0].(map[string]any)["content"].(string)
	if n := strings.Count(row, "\n"); n != 1 {
		t.Fatalf("row has %d newlines, want the 1 this package wrote:\n%q", n, row)
	}
	if strings.HasPrefix(row, currentMarker) {
		t.Fatalf("an unselected row is marked as current: %q", row)
	}
	// The same text reaches the blocked card's subtitle and its summary.
	blocked, err := BuildBlocked(a, dialogScreen(), nil, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	for _, s := range []string{
		decodeCard(t, blocked)["header"].(map[string]any)["subtitle"].(map[string]any)["content"].(string),
		decodeCard(t, blocked)["config"].(map[string]any)["summary"].(map[string]any)["content"].(string),
	} {
		if strings.Contains(s, "\n") {
			t.Fatalf("agent text reached a one-line field with a newline in it: %q", s)
		}
	}
}

// TestAgentListRowsSurviveMissingMetadata: an agent herdr has not finished
// detecting has no kind, no cwd and no title (G8), and it still has to be
// selectable — that is how the user gets to it at all.
func TestAgentListRowsSurviveMissingMetadata(t *testing.T) {
	js, err := BuildAgentList([]agents.Agent{{PaneID: "w3:p1"}}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	card := decodeCard(t, js)
	row := card["body"].(map[string]any)["elements"].([]any)[0].(map[string]any)["content"].(string)
	if row != "❔ **agent**\n`w3:p1` · unknown" {
		t.Fatalf("row = %q", row)
	}
	d := listDecisions(t, card)[0][0]
	if d.Pane != "w3:p1" || d.Kind != "" {
		t.Fatalf("select decoded to %+v", d)
	}
}

// TestAgentListTruncatesALongTitle keeps one talkative agent from burying the
// rest of the list.
func TestAgentListTruncatesALongTitle(t *testing.T) {
	a := blockedAgent()
	a.Title = strings.Repeat("long ", 40)
	js, err := BuildAgentList([]agents.Agent{a}, "", issuedAt)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	row := decodeCard(t, js)["body"].(map[string]any)["elements"].([]any)[0].(map[string]any)["content"].(string)
	title := row[strings.LastIndex(row, "· ")+len("· "):]
	if n := len([]rune(title)); n > maxRowTitle {
		t.Fatalf("title on the row is %d runes, want at most %d: %q", n, maxRowTitle, title)
	}
	if !strings.HasSuffix(title, "…") {
		t.Fatalf("a truncated title must show that it was cut: %q", title)
	}
}
