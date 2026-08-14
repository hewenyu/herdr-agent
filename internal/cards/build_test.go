package cards

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

var (
	// bridgeZone is the zone the bridge runs in. It is deliberately not UTC: a
	// card renders every instant in one zone, and a golden pinned in UTC could
	// not tell a card that got that right from one that hardcoded UTC.
	bridgeZone = time.FixedZone("CST", 8*60*60)
	// issuedAt is the moment every card in this file was built.
	issuedAt = time.Date(2026, 8, 14, 1, 23, 45, 0, bridgeZone)
	// pressedAt is when the human tapped it.
	pressedAt = time.Date(2026, 8, 14, 1, 24, 5, 0, bridgeZone)
)

// TestMain pins the local zone so the goldens are the same on every machine.
//
// It has to be done here rather than with t.Setenv("TZ", …): time.Local is
// resolved once, on first use, so a test that changes the environment after
// some earlier test formatted a time changes nothing at all.
func TestMain(m *testing.M) {
	time.Local = bridgeZone
	os.Exit(m.Run())
}

// claudeSession is the shape herdr hands back once claude's SessionStart hook
// has fired — which only happens after the trust-directory prompt is accepted
// (G8), so an agent without one is a normal intermediate state, not an error.
func claudeSession() *herdrapi.SessionRef {
	return &herdrapi.SessionRef{
		Source: "herdr:claude", Agent: "claude", Kind: "id",
		Value: "cf67e552-abca-4b2a-8711-f37c328ed677",
	}
}

func blockedAgent() agents.Agent {
	return agents.Agent{
		PaneID:     "w1:p1",
		Kind:       "claude",
		Status:     agents.StatusBlocked,
		Cwd:        "/tmp/herdr-accept",
		Title:      "Create DANGER.txt",
		StateSeq:   42,
		SessionRef: claudeSession(),
	}
}

func dialogScreen() screen.Screen {
	// Cols well above screen.NarrowCols: a pane a terminal has attached to.
	return screen.Screen{Lines: lines(claudeBash), Cols: 173, Rows: 49}
}

// ---------- helpers ----------

func decodeCard(t *testing.T, js string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(js), &m); err != nil {
		t.Fatalf("card is not valid JSON: %v\n%s", err, js)
	}
	return m
}

// findTag collects every element in the card tree carrying the given tag.
func findTag(v any, tag string) []map[string]any {
	var out []map[string]any
	switch t := v.(type) {
	case map[string]any:
		if t["tag"] == tag {
			out = append(out, t)
		}
		for _, child := range t {
			out = append(out, findTag(child, tag)...)
		}
	case []any:
		for _, child := range t {
			out = append(out, findTag(child, tag)...)
		}
	}
	return out
}

// hasKey reports whether key appears anywhere in the tree.
func hasKey(v any, key string) bool {
	switch t := v.(type) {
	case map[string]any:
		if _, ok := t[key]; ok {
			return true
		}
		for _, child := range t {
			if hasKey(child, key) {
				return true
			}
		}
	case []any:
		for _, child := range t {
			if hasKey(child, key) {
				return true
			}
		}
	}
	return false
}

// allText concatenates every string in the tree, so a test can ask whether the
// card says something without caring which element says it.
func allText(v any) string {
	var b strings.Builder
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case string:
			b.WriteString(t)
			b.WriteString("\n")
		case map[string]any:
			for _, child := range t {
				walk(child)
			}
		case []any:
			for _, child := range t {
				walk(child)
			}
		}
	}
	walk(v)
	return b.String()
}

// buttonValues returns each button's behaviors[0].value, in card order.
func buttonValues(t *testing.T, card map[string]any) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, b := range orderedButtons(t, card) {
		behaviors, ok := b["behaviors"].([]any)
		if !ok || len(behaviors) == 0 {
			t.Fatalf("button %v has no behaviors", b["text"])
		}
		first, ok := behaviors[0].(map[string]any)
		if !ok {
			t.Fatalf("behaviors[0] is %T, want an object", behaviors[0])
		}
		if first["type"] != "callback" {
			t.Fatalf("behaviors[0].type = %v, want callback", first["type"])
		}
		val, ok := first["value"].(map[string]any)
		if !ok {
			t.Fatalf("behaviors[0].value is %T, want an object", first["value"])
		}
		out = append(out, val)
	}
	return out
}

// orderedButtons walks the column_set in declaration order, which findTag's map
// iteration cannot promise.
func orderedButtons(t *testing.T, card map[string]any) []map[string]any {
	t.Helper()
	body, ok := card["body"].(map[string]any)
	if !ok {
		t.Fatal("card has no body object")
	}
	elements, _ := body["elements"].([]any)
	var out []map[string]any
	for _, el := range elements {
		set, ok := el.(map[string]any)
		if !ok || set["tag"] != "column_set" {
			continue
		}
		cols, _ := set["columns"].([]any)
		for _, c := range cols {
			col, ok := c.(map[string]any)
			if !ok {
				continue
			}
			inner, _ := col["elements"].([]any)
			for _, e := range inner {
				if btn, ok := e.(map[string]any); ok && btn["tag"] == "button" {
					out = append(out, btn)
				}
			}
		}
	}
	return out
}

func buttonTexts(t *testing.T, card map[string]any) []string {
	t.Helper()
	var out []string
	for _, b := range orderedButtons(t, card) {
		text, ok := b["text"].(map[string]any)
		if !ok {
			t.Fatalf("button %v has no text object", b)
		}
		out = append(out, text["content"].(string))
	}
	return out
}

// ---------- golden structure ----------

// TestBuildBlockedGolden pins the whole schema 2.0 document for the canonical
// case: Claude's three-option Bash prompt on a pane of normal width.
func TestBuildBlockedGolden(t *testing.T) {
	a := blockedAgent()
	s := dialogScreen()
	js, err := BuildBlocked(a, s, ParseOptions(s), "nonce-1", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}

	iat := float64(issuedAt.Unix())
	value := func(key string) map[string]any {
		return map[string]any{
			"act": "key", "key": key, "pane": "w1:p1", "kind": "claude",
			"seq": float64(42), "iat": iat, "n": "nonce-1",
		}
	}
	// The select button sends nothing, so it carries no nonce — pressing it must
	// not spend the single use the numbered buttons above it depend on — and it
	// carries the session id, which is what makes the selection an identity
	// rather than a seat (G8, G17).
	selectValue := map[string]any{
		"act": "select", "key": "", "pane": "w1:p1", "kind": "claude",
		"seq": float64(42), "iat": iat, "n": "",
		"sid": "cf67e552-abca-4b2a-8711-f37c328ed677",
	}
	column := func(text, style string, v map[string]any) any {
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
	button := func(text, style, key string) any {
		return column(text, style, value(key))
	}

	want := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"update_multi": true,
			"summary":      map[string]any{"content": "claude is waiting: Create DANGER.txt"},
		},
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": "claude · herdr-accept · w1:p1"},
			"subtitle": map[string]any{"tag": "plain_text", "content": "Create DANGER.txt"},
			"template": "red",
		},
		"body": map[string]any{
			"elements": []any{
				map[string]any{"tag": "markdown", "content": "```\n" + claudeBash + "\n```"},
				map[string]any{
					"tag":                "column_set",
					"flex_mode":          "flow",
					"horizontal_spacing": "8px",
					"columns": []any{
						button("1. Yes", "default", "1"),
						button("2. Yes, and always allow…", "default", "2"),
						button("3. No", "default", "3"),
						button("Esc · back out", "danger", "esc"),
					},
				},
				map[string]any{
					"tag":                "column_set",
					"flex_mode":          "flow",
					"horizontal_spacing": "8px",
					"columns": []any{
						column("Select · then just type", "default", selectValue),
					},
				},
				map[string]any{"tag": "markdown", "content": selectNote(a)},
				map[string]any{
					"tag": "markdown",
					"content": "pane `w1:p1` · seq 42 · issued 2026-08-14 01:23:45 CST · " +
						"buttons stop working after 10m0s",
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

func TestBuildResolvedGolden(t *testing.T) {
	d := Decision{
		Act: ActKey, Key: "1", Pane: "w1:p1", Kind: "claude",
		Seq: 42, IssuedAt: issuedAt.Unix(), Nonce: "nonce-1",
	}
	js, err := BuildResolved(blockedAgent(), d, "ou_a90a043a", "agent is working again", pressedAt)
	if err != nil {
		t.Fatalf("BuildResolved: %v", err)
	}

	want := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"update_multi": true,
			"summary":      map[string]any{"content": "handled · w1:p1 · agent is working again"},
		},
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": "claude · herdr-accept · w1:p1"},
			"subtitle": map[string]any{"tag": "plain_text", "content": "handled"},
			"template": "grey",
		},
		"body": map[string]any{
			"elements": []any{
				map[string]any{"tag": "markdown", "content": "**Sent** `1` to `w1:p1`"},
				map[string]any{"tag": "markdown", "content": "**By** ou_a90a043a · **at** 2026-08-14 01:24:05 CST"},
				map[string]any{"tag": "markdown", "content": "**Outcome** agent is working again"},
				map[string]any{"tag": "markdown", "content": "_This card is spent: its buttons are gone and it can no longer send anything._"},
				map[string]any{"tag": "markdown", "content": "pane `w1:p1` · kind `claude` · seq 42 · card issued 2026-08-14 01:23:45 CST"},
			},
		},
	}

	if got := decodeCard(t, js); !reflect.DeepEqual(got, want) {
		gotPretty, _ := json.MarshalIndent(got, "", "  ")
		t.Fatalf("card structure differs\ngot: %s", gotPretty)
	}
}

func TestBuildExpiredGolden(t *testing.T) {
	d := Decision{
		Act: ActKey, Key: "2", Pane: "w1:p1", Kind: "claude",
		Seq: 42, IssuedAt: issuedAt.Unix(), Nonce: "nonce-1",
	}
	js, err := BuildExpired(d, "the agent is no longer waiting for input")
	if err != nil {
		t.Fatalf("BuildExpired: %v", err)
	}

	want := map[string]any{
		"schema": "2.0",
		"config": map[string]any{
			"update_multi": true,
			"summary":      map[string]any{"content": "ignored · w1:p1 · the agent is no longer waiting for input"},
		},
		"header": map[string]any{
			"title":    map[string]any{"tag": "plain_text", "content": "claude · w1:p1"},
			"subtitle": map[string]any{"tag": "plain_text", "content": "no key was sent"},
			"template": "yellow",
		},
		"body": map[string]any{
			"elements": []any{
				map[string]any{"tag": "markdown", "content": "**`2` was NOT sent to `w1:p1`.**"},
				map[string]any{"tag": "markdown", "content": "**Why** the agent is no longer waiting for input"},
				map[string]any{"tag": "markdown", "content": "_Nothing reached the agent. Ask again with a fresh card (`/card w1:p1`) if you still want this._"},
				map[string]any{"tag": "markdown", "content": "pane `w1:p1` · kind `claude` · seq 42 · card issued 2026-08-14 01:23:45 CST"},
			},
		},
	}

	if got := decodeCard(t, js); !reflect.DeepEqual(got, want) {
		gotPretty, _ := json.MarshalIndent(got, "", "  ")
		t.Fatalf("card structure differs\ngot: %s", gotPretty)
	}
}

// ---------- behaviour ----------

// TestBlockedButtonsCarryTheGuard is the G16/G17 lock: routing needs no
// server-side state because the pane comes back in the value, and every button
// carries the sequence, issue time and nonce that let the press be re-checked.
func TestBlockedButtonsCarryTheGuard(t *testing.T) {
	a := blockedAgent()
	s := dialogScreen()
	js, err := BuildBlocked(a, s, ParseOptions(s), "nonce-1", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	card := decodeCard(t, js)

	values := buttonValues(t, card)
	wantKeys := []string{"1", "2", "3", "esc"}
	// One per option, then Esc, then the inert Select — which is checked by
	// TestBlockedSelectButtonIsInert, not here.
	if len(values) != len(wantKeys)+1 {
		t.Fatalf("got %d buttons, want %d (one per option, Esc, Select)", len(values), len(wantKeys)+1)
	}

	for i, v := range values[:len(wantKeys)] {
		// Feishu round-trips the value verbatim; anything nested would come
		// back as a shape DecodeDecision does not accept (G16).
		for k, raw := range v {
			switch raw.(type) {
			case string, float64, bool:
			default:
				t.Fatalf("button %d value[%q] is %T; the value must be a flat object of scalars", i, k, raw)
			}
		}

		d, err := DecodeDecision(v)
		if err != nil {
			t.Fatalf("button %d value does not decode: %v", i, err)
		}
		want := Decision{
			Act: ActKey, Key: wantKeys[i], Pane: "w1:p1", Kind: "claude",
			Seq: 42, IssuedAt: issuedAt.Unix(), Nonce: "nonce-1",
		}
		if d != want {
			t.Fatalf("button %d decoded to %+v, want %+v", i, d, want)
		}

		g := d.Guard()
		if g.PaneID != a.PaneID || g.Kind != a.Kind || g.StateSeq != a.StateSeq || !g.IssuedAt.Equal(issuedAt) {
			t.Fatalf("button %d guard = %+v, want it to pin %+v", i, g, a)
		}
	}
}

// TestEscButtonIsAlwaysPresentAndDangerous locks the safe exit (G2) onto every
// card, including one with no options at all. Esc stays the LAST thing that
// sends a key: Select is added after it but sends nothing.
func TestEscButtonIsAlwaysPresentAndDangerous(t *testing.T) {
	tests := []struct {
		name string
		opts []Option
		want []string
	}{
		{
			name: "with options",
			opts: opts("1", "Yes", "2", "No"),
			want: []string{"1. Yes", "2. No", "Esc · back out", selectAndTypeText},
		},
		{
			name: "nothing parsed",
			opts: nil,
			want: []string{"Esc · back out", selectAndTypeText},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			js, err := BuildBlocked(blockedAgent(), dialogScreen(), tt.opts, "n", issuedAt)
			if err != nil {
				t.Fatalf("BuildBlocked: %v", err)
			}
			card := decodeCard(t, js)
			if got := buttonTexts(t, card); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("buttons = %q, want %q", got, tt.want)
			}
			// The Esc button is the one before Select.
			esc := orderedButtons(t, card)[len(tt.want)-2]
			if esc["type"] != "danger" {
				t.Fatalf("Esc button style = %v, want danger", esc["type"])
			}
			values := buttonValues(t, card)
			if got := values[len(values)-2]["key"]; got != "esc" {
				t.Fatalf("last key button sends %v, want esc", got)
			}
		})
	}
}

// TestBlockedSelectButtonIsInert is the reason the button exists and the reason
// it is safe: the flow from a notification is one tap and then typing, and that
// tap must not spend the card.
//
// It carries no nonce (so it cannot consume the single use the numbered buttons
// depend on), no key (so nothing reaches the agent), and the session id — the
// selection has to be an identity, not a seat: claude can exit and codex start
// in the same pane, and typing at the seat would land in a different context
// entirely (G8, G17).
func TestBlockedSelectButtonIsInert(t *testing.T) {
	a := blockedAgent()
	s := dialogScreen()
	js, err := BuildBlocked(a, s, ParseOptions(s), "nonce-1", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	card := decodeCard(t, js)

	values := buttonValues(t, card)
	last := values[len(values)-1]
	if got := last["n"]; got != "" {
		t.Fatalf("select button carries nonce %v; pressing it would spend the card", got)
	}

	d, err := DecodeDecision(last)
	if err != nil {
		t.Fatalf("select value does not decode: %v", err)
	}
	want := Decision{
		Act: ActSelect, Pane: "w1:p1", Kind: "claude", Seq: 42,
		IssuedAt: issuedAt.Unix(), Session: claudeSession().Value,
	}
	if d != want {
		t.Fatalf("select decoded to %+v, want %+v", d, want)
	}
	if !d.Inert() {
		t.Fatal("the select button's decision is not inert")
	}

	// The armed buttons must be untouched by its presence.
	for i, v := range values[:len(values)-1] {
		if v["n"] != "nonce-1" {
			t.Fatalf("button %d lost its nonce: %v", i, v["n"])
		}
	}
}

// TestBlockedCardWarnsBesideItsSelectButton: the notification card is where
// "select, then just type" is most likely to be tapped, and by construction its
// agent is sitting at a question. Controller.Say cancels that question before it
// submits prose — it has to, because prose typed at a menu is discarded and the
// Enter behind it approves the highlighted default (G1, G2) — so the card has to
// say so beside the button, not afterwards in a delivery report.
//
// /card posts this same card for an agent that is NOT waiting at anything, and
// there the warning would describe a dialog that is not on screen.
func TestBlockedCardWarnsBesideItsSelectButton(t *testing.T) {
	tests := []struct {
		name    string
		status  agents.Status
		want    []string
		notWant []string
	}{
		{
			name:   "blocked",
			status: agents.StatusBlocked,
			want: []string{
				"aims your typing at this agent", "sends nothing",
				"waiting at the question above", "esc", "nothing above gets approved",
			},
		},
		{
			name:    "/card on an agent that is not waiting",
			status:  agents.StatusWorking,
			want:    []string{"aims your typing at this agent", "sends nothing"},
			notWant: []string{"waiting at the question above", "gets approved"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := blockedAgent()
			a.Status = tt.status
			js, err := BuildBlocked(a, dialogScreen(), opts("1", "Yes"), "n", issuedAt)
			if err != nil {
				t.Fatalf("BuildBlocked: %v", err)
			}
			text := allText(decodeCard(t, js))
			for _, want := range tt.want {
				if !strings.Contains(text, want) {
					t.Fatalf("card does not say %q beside its select button:\n%s", want, text)
				}
			}
			for _, notWant := range tt.notWant {
				if strings.Contains(text, notWant) {
					t.Fatalf("card claims %q about an agent that is %s:\n%s", notWant, tt.status, text)
				}
			}
		})
	}
}

// TestBuildBlockedWithoutOptionsAsksForProse: when nothing parses the card must
// not invent buttons. It says so and points at the safe path, because prose to
// a blocked agent is only safe when it goes through Say's esc-first route (G1).
func TestBuildBlockedWithoutOptionsAsksForProse(t *testing.T) {
	js, err := BuildBlocked(blockedAgent(), dialogScreen(), nil, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	card := decodeCard(t, js)
	text := allText(card)
	for _, want := range []string{"No numbered options", "reply to this message", "esc first"} {
		if !strings.Contains(text, want) {
			t.Fatalf("card does not mention %q:\n%s", want, text)
		}
	}
	if got := buttonTexts(t, card); !reflect.DeepEqual(got, []string{"Esc · back out", selectAndTypeText}) {
		t.Fatalf("buttons = %q, want only Esc and the inert Select", got)
	}
}

// TestNarrowPaneWarning covers G5 + G11: a pane nothing ever attached to is 53
// columns wide, Claude's TUI wraps there, and herdr's blocked detection then
// degrades to `idle` without saying anything. The card has to admit that.
func TestNarrowPaneWarning(t *testing.T) {
	tests := []struct {
		name    string
		screen  screen.Screen
		want    []string
		notWant []string
	}{
		{
			name:    "attached pane, no warning",
			screen:  screen.Screen{Lines: lines(claudeBash), Cols: 173},
			notWant: []string{"columns wide", "width is unknown", "possibly incomplete"},
		},
		{
			name:   "never-attached 53 column pane",
			screen: screen.Screen{Lines: lines(claudeBash), Cols: 53, Narrow: true},
			want: []string{
				"only 53 columns wide", "attached a terminal", "blocked", "idle",
				"possibly incomplete",
			},
			notWant: []string{"width is unknown"},
		},
		{
			// The production path for a pane herdr returned nothing for.
			// screen.Clean derives Cols from the widest line it saw, so an empty
			// read is Cols 0 and — deliberately, failing safe — Narrow. The
			// warning must not turn that into the measurement "0 columns wide";
			// this is the one line of the card telling the user not to trust
			// what they are looking at.
			name:    "empty read has no measured width",
			screen:  screen.Clean("", screen.DefaultMaxCols),
			want:    []string{"width is unknown", "no screen content", "possibly incomplete"},
			notWant: []string{"0 columns", "columns wide"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			js, err := BuildBlocked(blockedAgent(), tt.screen, nil, "n", issuedAt)
			if err != nil {
				t.Fatalf("BuildBlocked: %v", err)
			}
			text := allText(decodeCard(t, js))
			for _, want := range tt.want {
				if !strings.Contains(text, want) {
					t.Fatalf("card does not mention %q:\n%s", want, text)
				}
			}
			for _, notWant := range tt.notWant {
				if strings.Contains(text, notWant) {
					t.Fatalf("card must not say %q:\n%s", notWant, text)
				}
			}
		})
	}
}

func TestBuildBlockedCroppedNotice(t *testing.T) {
	s := screen.Screen{Lines: lines(claudeBash), Cols: 173, Cropped: true}
	js, err := BuildBlocked(blockedAgent(), s, nil, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	if text := allText(decodeCard(t, js)); !strings.Contains(text, "cropped to phone width") {
		t.Fatalf("card does not admit the screen was cropped:\n%s", text)
	}
}

// TestDialogIsEmbeddedVerbatim: the screen package already cropped these lines
// to phone width; re-wrapping or trimming them would destroy the TUI alignment
// and could hide the very command the user is approving.
func TestDialogIsEmbeddedVerbatim(t *testing.T) {
	s := dialogScreen()
	js, err := BuildBlocked(blockedAgent(), s, ParseOptions(s), "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	body := decodeCard(t, js)["body"].(map[string]any)
	first := body["elements"].([]any)[0].(map[string]any)
	if first["tag"] != "markdown" {
		t.Fatalf("first element is %v, want markdown", first["tag"])
	}
	want := "```\n" + s.Text() + "\n```"
	if first["content"] != want {
		t.Fatalf("dialog block = %q, want %q", first["content"], want)
	}
}

// TestDialogWithBackticksKeepsItsFence: agent output contains code fences, and
// a three-backtick fence around one would end the block early and spill the
// rest of the dialog into the card as markdown.
func TestDialogWithBackticksKeepsItsFence(t *testing.T) {
	s := screen.Screen{Lines: []string{"run this:", "```sh", "rm -rf /", "```", " 1. Yes"}, Cols: 100}
	js, err := BuildBlocked(blockedAgent(), s, nil, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	body := decodeCard(t, js)["body"].(map[string]any)
	got := body["elements"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.HasPrefix(got, "````\n") || !strings.HasSuffix(got, "\n````") {
		t.Fatalf("fence did not grow past the embedded one: %q", got)
	}
	if !strings.Contains(got, s.Text()) {
		t.Fatalf("dialog text was altered: %q", got)
	}
}

func TestBuildBlockedEmptyScreen(t *testing.T) {
	js, err := BuildBlocked(blockedAgent(), screen.Screen{}, nil, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	if text := allText(decodeCard(t, js)); !strings.Contains(text, "no screen content") {
		t.Fatalf("empty screen must be admitted, not rendered as an empty block:\n%s", text)
	}
}

func TestBuildBlockedRefusesUnarmableCards(t *testing.T) {
	tests := []struct {
		name  string
		agent agents.Agent
		opts  []Option
		nonce string
	}{
		{
			name:  "no nonce means the card could never be consumed once",
			agent: blockedAgent(),
			nonce: "",
		},
		{
			name:  "no pane id means the press could not be routed",
			agent: agents.Agent{Kind: "claude"},
			nonce: "n",
		},
		{
			name:  "a key the controller would refuse",
			agent: blockedAgent(),
			opts:  opts("10", "the tenth option"),
			nonce: "n",
		},
		{
			name:  "a key that is not a key at all",
			agent: blockedAgent(),
			opts:  opts("yes", "Yes"),
			nonce: "n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			js, err := BuildBlocked(tt.agent, dialogScreen(), tt.opts, tt.nonce, issuedAt)
			if err == nil {
				t.Fatalf("built a card that must not exist: %s", js)
			}
			if !errors.Is(err, errUnbuildable) {
				t.Fatalf("err = %v, want errUnbuildable", err)
			}
			if js != "" {
				t.Fatalf("a failed build must not return a card body: %s", js)
			}
		})
	}
}

// TestDisarmedCardsHaveNoButtons is the G17 fix: a Feishu message never
// expires, so the replacement posted after a press must have nothing left to
// press. Any button — or any behaviors block at all — would rearm it.
func TestDisarmedCardsHaveNoButtons(t *testing.T) {
	d := Decision{
		Act: ActKey, Key: "1", Pane: "w1:p1", Kind: "claude",
		Seq: 42, IssuedAt: issuedAt.Unix(), Nonce: "nonce-1",
	}
	resolved, err := BuildResolved(blockedAgent(), d, "ou_a90a043a", "approved", pressedAt)
	if err != nil {
		t.Fatalf("BuildResolved: %v", err)
	}
	expired, err := BuildExpired(d, "the agent is no longer waiting")
	if err != nil {
		t.Fatalf("BuildExpired: %v", err)
	}

	for name, js := range map[string]string{"resolved": resolved, "expired": expired} {
		card := decodeCard(t, js)
		if got := findTag(card, "button"); len(got) != 0 {
			t.Fatalf("%s card still has %d button(s)", name, len(got))
		}
		if hasKey(card, "behaviors") {
			t.Fatalf("%s card still carries a behaviors block", name)
		}
		if hasKey(card, "value") {
			t.Fatalf("%s card still carries a callback value", name)
		}
		if card["header"].(map[string]any)["template"] == "red" {
			t.Fatalf("%s card still looks live", name)
		}
	}
}

// TestResolvedCardSaysWhoWhatWhen: the disarmed card is the only record of the
// press left in the chat.
func TestResolvedCardSaysWhoWhatWhen(t *testing.T) {
	d := Decision{
		Act: ActKey, Key: "2", Pane: "w1:p1", Kind: "claude",
		Seq: 42, IssuedAt: issuedAt.Unix(), Nonce: "nonce-1",
	}
	js, err := BuildResolved(blockedAgent(), d, "ou_a90a043a", "claude is working again", pressedAt)
	if err != nil {
		t.Fatalf("BuildResolved: %v", err)
	}
	text := allText(decodeCard(t, js))
	for _, want := range []string{"`2`", "ou_a90a043a", "2026-08-14 01:24:05 CST", "claude is working again", "w1:p1"} {
		if !strings.Contains(text, want) {
			t.Fatalf("resolved card does not state %q:\n%s", want, text)
		}
	}
}

// TestCardStampsShareOneZone: stampLayout carries a zone so that a human
// reading the chat hours later can place the time. One card printing one
// instant in two zones defeats that — a blocked card footed "issued 01:23:45
// CST" whose disarmed replacement says "card issued 17:23:45 UTC" reads as two
// separate events, and the second one looks like it happened yesterday.
func TestCardStampsShareOneZone(t *testing.T) {
	d := Decision{
		Act: ActKey, Key: "1", Pane: "w1:p1", Kind: "claude",
		Seq: 42, IssuedAt: issuedAt.Unix(), Nonce: "nonce-1",
	}
	blocked, err := BuildBlocked(blockedAgent(), dialogScreen(), nil, "nonce-1", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	resolved, err := BuildResolved(blockedAgent(), d, "ou_a90a043a", "approved", pressedAt)
	if err != nil {
		t.Fatalf("BuildResolved: %v", err)
	}
	expired, err := BuildExpired(d, "too old")
	if err != nil {
		t.Fatalf("BuildExpired: %v", err)
	}

	// The blocked card formats the caller's time.Time; the two disarmed cards
	// only have the unix second inside the Decision. All three must land on the
	// same wall clock, which they do only if the second pair renders locally.
	issued := issuedAt.Format(stampLayout)
	for name, js := range map[string]string{"blocked": blocked, "resolved": resolved, "expired": expired} {
		if text := allText(decodeCard(t, js)); !strings.Contains(text, issued) {
			t.Fatalf("%s card does not state the issue time as %q:\n%s", name, issued, text)
		}
	}
	if text := allText(decodeCard(t, resolved)); !strings.Contains(text, pressedAt.Format(stampLayout)) {
		t.Fatalf("resolved card does not state the press time in the caller's zone:\n%s", text)
	}
}

// TestDisarmedCardsWithoutDetails still have to say something: a card whose
// text is blank leaves the user unable to tell a honoured press from a refused
// one, which is the whole reason these replacements exist.
func TestDisarmedCardsWithoutDetails(t *testing.T) {
	d := Decision{Act: ActKey, Key: "1", Pane: "w1:p1", Seq: 1, IssuedAt: issuedAt.Unix(), Nonce: "n"}

	resolved, err := BuildResolved(blockedAgent(), d, "", "", pressedAt)
	if err != nil {
		t.Fatalf("BuildResolved: %v", err)
	}
	for _, want := range []string{"an unknown operator", "not reported"} {
		if text := allText(decodeCard(t, resolved)); !strings.Contains(text, want) {
			t.Fatalf("resolved card does not fall back to %q:\n%s", want, text)
		}
	}

	expired, err := BuildExpired(d, "")
	if err != nil {
		t.Fatalf("BuildExpired: %v", err)
	}
	if text := allText(decodeCard(t, expired)); !strings.Contains(text, "no longer valid") {
		t.Fatalf("expired card does not fall back to a reason:\n%s", text)
	}
}

func TestExpiredCardStatesTheRejection(t *testing.T) {
	d := Decision{
		Act: ActKey, Key: "1", Pane: "w9:p9", Kind: "codex",
		Seq: 7, IssuedAt: issuedAt.Unix(), Nonce: "nonce-9",
	}
	js, err := BuildExpired(d, "pane no longer exists")
	if err != nil {
		t.Fatalf("BuildExpired: %v", err)
	}
	text := allText(decodeCard(t, js))
	for _, want := range []string{"NOT sent", "pane no longer exists", "Nothing reached the agent", "w9:p9", "seq 7"} {
		if !strings.Contains(text, want) {
			t.Fatalf("expired card does not state %q:\n%s", want, text)
		}
	}
}

// TestHeadlineAndButtonEdges covers the degenerate metadata a real pane can
// carry: an agent started at the filesystem root, and an option whose label
// the screen did not give us.
func TestHeadlineAndButtonEdges(t *testing.T) {
	a := blockedAgent()
	a.Cwd = "/"
	a.Title = ""
	js, err := BuildBlocked(a, dialogScreen(), []Option{{Key: "1"}}, "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	card := decodeCard(t, js)

	header := card["header"].(map[string]any)
	if got := header["title"].(map[string]any)["content"]; got != "claude · w1:p1" {
		t.Fatalf("title = %q, want no cwd element for a root cwd", got)
	}
	if got := header["subtitle"].(map[string]any)["content"]; got != "waiting for an answer" {
		t.Fatalf("subtitle = %q, want the placeholder for a title-less agent", got)
	}
	if got := buttonTexts(t, card)[0]; got != "1" {
		t.Fatalf("button text = %q, want the bare key when there is no label", got)
	}
}

// TestCodexTitleIsNotRepeated: codex's terminal_title_stripped is just the cwd
// (G8), which the headline already carries, so echoing it as a subtitle would
// spend the one line the user reads first on no information at all.
func TestCodexTitleIsNotRepeated(t *testing.T) {
	a := agents.Agent{PaneID: "w1:p2", Kind: "codex", Cwd: "/tmp/herdr-probe2", Title: "herdr-probe2", StateSeq: 3}
	js, err := BuildBlocked(a, dialogScreen(), opts("1", "Yes, continue"), "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	header := decodeCard(t, js)["header"].(map[string]any)
	if got := header["subtitle"].(map[string]any)["content"]; got != "waiting for an answer" {
		t.Fatalf("subtitle = %q, want the placeholder rather than a repeat of the cwd", got)
	}
}

// TestMissingMetadataDoesNotBreakACard: an agent herdr has not finished
// detecting has no kind, no cwd and no title (G8), and it can still be blocked.
func TestMissingMetadataDoesNotBreakACard(t *testing.T) {
	a := agents.Agent{PaneID: "w2:p3", Status: agents.StatusBlocked, StateSeq: 1}
	js, err := BuildBlocked(a, dialogScreen(), opts("1", "Yes"), "n", issuedAt)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	card := decodeCard(t, js)
	title := card["header"].(map[string]any)["title"].(map[string]any)["content"].(string)
	if title != "agent · w2:p3" {
		t.Fatalf("header title = %q, want the pane and a placeholder kind", title)
	}
	// The value still decodes, with an empty kind the Guard will compare
	// against the live agent.
	d, err := DecodeDecision(buttonValues(t, card)[0])
	if err != nil {
		t.Fatalf("value does not decode: %v", err)
	}
	if d.Kind != "" || d.Pane != "w2:p3" {
		t.Fatalf("decoded %+v, want an empty kind and pane w2:p3", d)
	}
}
