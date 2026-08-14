package cards

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// validValue is the value Feishu measured itself handing back: a flat object
// of scalars, pane id included, which is why routing a press needs no
// server-side state at all (G16).
func validValue() map[string]any {
	return map[string]any{
		"act":  "key",
		"key":  "1",
		"pane": "w1:p1",
		"kind": "claude",
		"seq":  float64(42),
		"iat":  float64(1786634943),
		"n":    "9f2c1e",
	}
}

// TestDecodeDecisionRoundTripsThroughJSON runs a Decision through the exact
// path a press takes: marshalled into the card, parsed back out by the SDK's
// encoding/json (which makes every number a float64), decoded here.
func TestDecodeDecisionRoundTripsThroughJSON(t *testing.T) {
	want := Decision{
		Act: ActKey, Key: "3", Pane: "w2:p7", Kind: "codex",
		Seq: 9007199254740991, IssuedAt: issuedAt.Unix(), Nonce: "nonce-1",
	}

	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := v["seq"].(float64); !ok {
		t.Fatalf("seq came back as %T; this test is meant to exercise the float64 path", v["seq"])
	}

	got, err := DecodeDecision(v)
	if err != nil {
		t.Fatalf("DecodeDecision: %v", err)
	}
	if got != want {
		t.Fatalf("round trip changed the decision:\n got %+v\nwant %+v", got, want)
	}
	if g := got.Guard(); g.PaneID != want.Pane || g.StateSeq != want.Seq ||
		!g.IssuedAt.Equal(time.Unix(want.IssuedAt, 0)) {
		t.Fatalf("guard = %+v, does not pin the decision", g)
	}
}

// TestDecodeDecisionAcceptsEveryAllowedKey: the key set is agents.AllowedKeys
// and nothing else. Keeping the check on that variable rather than a local copy
// means a key added there cannot be silently unpressable here.
func TestDecodeDecisionAcceptsEveryAllowedKey(t *testing.T) {
	for _, key := range agents.AllowedKeys {
		v := validValue()
		v["key"] = key
		d, err := DecodeDecision(v)
		if err != nil {
			t.Fatalf("key %q rejected: %v", key, err)
		}
		if d.Key != key {
			t.Fatalf("key %q decoded as %q", key, d.Key)
		}
	}
}

func TestDecodeDecisionAcceptsNumbersFromNonFeishuCallers(t *testing.T) {
	tests := []struct {
		name string
		seq  any
		iat  any
		want Decision
	}{
		{name: "float64 as Feishu sends it", seq: float64(42), iat: float64(1786634943)},
		{name: "json.Number", seq: json.Number("42"), iat: json.Number("1786634943")},
		{name: "go int", seq: 42, iat: 1786634943},
		{name: "go int64", seq: int64(42), iat: int64(1786634943)},
		{name: "go uint64", seq: uint64(42), iat: int64(1786634943)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			v := validValue()
			v["seq"], v["iat"] = tt.seq, tt.iat
			d, err := DecodeDecision(v)
			if err != nil {
				t.Fatalf("DecodeDecision: %v", err)
			}
			if d.Seq != 42 || d.IssuedAt != 1786634943 {
				t.Fatalf("decoded seq=%d iat=%d, want 42 / 1786634943", d.Seq, d.IssuedAt)
			}
		})
	}
}

// TestDecodeDecisionAllowsAnUndetectedKind: herdr reports an agent before it
// has classified it (G8), and the Guard compares kind against the live agent
// anyway. Rejecting it here would be a second, weaker copy of that rule.
func TestDecodeDecisionAllowsAnUndetectedKind(t *testing.T) {
	v := validValue()
	delete(v, "kind")
	d, err := DecodeDecision(v)
	if err != nil {
		t.Fatalf("DecodeDecision: %v", err)
	}
	if d.Kind != "" {
		t.Fatalf("kind = %q, want empty", d.Kind)
	}
}

// TestDecodeDecisionRejects is the gate between a tap in a chat window and a
// keystroke in a live terminal. Everything here must come back as
// ErrBadDecision, never as a repaired Decision.
func TestDecodeDecisionRejects(t *testing.T) {
	tests := []struct {
		name  string
		value map[string]any
	}{
		{name: "nil value", value: nil},
		{name: "empty value", value: map[string]any{}},

		{name: "missing act", value: without("act")},
		{name: "unknown act", value: with("act", "prompt")},
		{name: "act is free text", value: with("act", "say the following to the agent")},
		{name: "act is not a string", value: with("act", float64(1))},
		{name: "act is empty", value: with("act", "")},

		{name: "missing key", value: without("key")},
		{name: "key is empty", value: with("key", "")},
		{name: "key is not in the allowlist", value: with("key", "q")},
		{name: "key is a two digit answer", value: with("key", "10")},
		{name: "key is cased differently", value: with("key", "Y")},
		{name: "key is a whole command", value: with("key", "rm -rf /")},
		{name: "key is a number", value: with("key", float64(1))},

		{name: "missing pane", value: without("pane")},
		{name: "empty pane", value: with("pane", "")},
		{name: "pane is not a string", value: with("pane", float64(11))},

		{name: "kind is not a string", value: with("kind", float64(1))},

		{name: "missing nonce", value: without("n")},
		{name: "empty nonce", value: with("n", "")},
		{name: "nonce is not a string", value: with("n", float64(1))},

		{name: "missing seq", value: without("seq")},
		{name: "seq is a string", value: with("seq", "42")},
		{name: "seq is fractional", value: with("seq", 1.5)},
		{name: "seq is negative", value: with("seq", float64(-1))},
		{name: "seq is not finite", value: with("seq", math.NaN())},
		{name: "seq is beyond exact float64 range", value: with("seq", float64(1e18))},
		{name: "seq is null", value: with("seq", nil)},

		{name: "seq is an unparseable json.Number", value: with("seq", json.Number("4 2"))},
		{name: "seq is a uint64 past exact float64 range", value: with("seq", uint64(math.MaxUint64))},

		{name: "missing iat", value: without("iat")},
		{name: "zero iat", value: with("iat", float64(0))},
		{name: "iat is a string", value: with("iat", "1786634943")},
		{name: "iat is negative", value: with("iat", float64(-1786634943))},
		{name: "iat is null", value: with("iat", nil)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, err := DecodeDecision(tt.value)
			if err == nil {
				t.Fatalf("accepted a malformed value as %+v", d)
			}
			if !errors.Is(err, ErrBadDecision) {
				t.Fatalf("err = %v, want ErrBadDecision", err)
			}
			if d != (Decision{}) {
				t.Fatalf("a rejected value must decode to nothing, got %+v", d)
			}
		})
	}
}

// inertValue is what a picker row's button sends back: no key and no nonce,
// because nothing about it reaches the agent.
func inertValue(act string) map[string]any {
	return map[string]any{
		"act":  act,
		"key":  "",
		"pane": "w1:p1",
		"kind": "claude",
		"seq":  float64(42),
		"iat":  float64(1786634943),
		"n":    "",
		"sid":  "cf67e552-abca-4b2a-8711-f37c328ed677",
	}
}

// TestDecodeDecisionAcceptsInertActs covers the two acts that send nothing.
// They are the card-first interface: select aims typing at an agent, screen
// re-reads its screen. Neither can become an approval, so neither is held to
// the rules that exist to keep a keystroke single-use and legal.
func TestDecodeDecisionAcceptsInertActs(t *testing.T) {
	for _, act := range []string{ActSelect, ActScreen} {
		t.Run(act, func(t *testing.T) {
			d, err := DecodeDecision(inertValue(act))
			if err != nil {
				t.Fatalf("DecodeDecision: %v", err)
			}
			want := Decision{
				Act: act, Pane: "w1:p1", Kind: "claude", Seq: 42, IssuedAt: 1786634943,
				Session: "cf67e552-abca-4b2a-8711-f37c328ed677",
			}
			if d != want {
				t.Fatalf("decoded %+v, want %+v", d, want)
			}
			if !d.Inert() {
				t.Fatalf("%q decoded to a decision that is not inert", act)
			}
			if d.Guard().PaneID != "w1:p1" {
				t.Fatalf("guard = %+v", d.Guard())
			}
		})
	}
}

// TestInertActsSurviveWithoutTheOptionalFields: a picker card is re-rendered in
// place rather than disarmed, so its rows must keep working after the nonce of
// the day is spent — and an agent herdr has issued no session ref for is a
// normal state, not an error (G8).
func TestInertActsSurviveWithoutTheOptionalFields(t *testing.T) {
	for _, act := range []string{ActSelect, ActScreen} {
		v := inertValue(act)
		delete(v, "n")
		delete(v, "sid")
		delete(v, "key")
		d, err := DecodeDecision(v)
		if err != nil {
			t.Fatalf("%q without nonce, session or key was rejected: %v", act, err)
		}
		if d.Session != "" || d.Nonce != "" || d.Key != "" {
			t.Fatalf("%q decoded to %+v, want the optional fields empty", act, d)
		}
	}
}

// TestOnlyInertActsMayOmitTheNonce is the whole asymmetry in one test. The
// nonce is what makes a press single-use; an ActKey press produces a keystroke
// in a live terminal, so a value without one is refused exactly as before,
// while an ActSelect press produces nothing to make single-use.
func TestOnlyInertActsMayOmitTheNonce(t *testing.T) {
	selectNoNonce := inertValue(ActSelect)
	delete(selectNoNonce, "n")
	if _, err := DecodeDecision(selectNoNonce); err != nil {
		t.Fatalf("a select without a nonce must decode: %v", err)
	}

	keyNoNonce := validValue()
	delete(keyNoNonce, "n")
	d, err := DecodeDecision(keyNoNonce)
	if err == nil {
		t.Fatalf("a key press without a nonce decoded to %+v; it could then be replayed forever", d)
	}
	if !errors.Is(err, ErrBadDecision) {
		t.Fatalf("err = %v, want ErrBadDecision", err)
	}
}

// TestDecodeDecisionRejectsMalformedInertValues: relaxed is not unchecked. An
// inert act still has to name a pane, and it must arrive with neither a key nor
// a nonce — a decision that says "sends nothing" while holding one of those is
// the shape a later caller could hand to SendKey, or spend against the dedup
// store, by mistake.
func TestDecodeDecisionRejectsMalformedInertValues(t *testing.T) {
	mutate := func(act, key string, val any) map[string]any {
		v := inertValue(act)
		if val == nil {
			delete(v, key)
			return v
		}
		v[key] = val
		return v
	}
	tests := []struct {
		name  string
		value map[string]any
	}{
		{name: "act is misspelt", value: mutate(ActSelect, "act", "selct")},
		{name: "act is empty", value: mutate(ActSelect, "act", "")},
		{name: "act is not a string", value: mutate(ActSelect, "act", float64(1))},

		{name: "select carries a key", value: mutate(ActSelect, "key", "1")},
		{name: "screen carries a key", value: mutate(ActScreen, "key", "esc")},
		{name: "select carries a key that is not one", value: mutate(ActSelect, "key", "rm -rf /")},
		{name: "select key is not a string", value: mutate(ActSelect, "key", float64(1))},

		{name: "select without a pane", value: mutate(ActSelect, "pane", nil)},
		{name: "select with an empty pane", value: mutate(ActSelect, "pane", "")},
		{name: "screen without a pane", value: mutate(ActScreen, "pane", nil)},
		{name: "select pane is not a string", value: mutate(ActSelect, "pane", float64(11))},
		{name: "select kind is not a string", value: mutate(ActSelect, "kind", float64(1))},

		{name: "select nonce is not a string", value: mutate(ActSelect, "n", float64(1))},
		// The mirror of "select carries a key", and the same argument: nothing
		// here writes a nonce onto an inert button, and a consumer that spends
		// whatever nonce it is handed would spend a live blocked card's single
		// use on a press that sends nothing — taking the numbered buttons away
		// from an agent that is still waiting at the question.
		{name: "select carries a nonce", value: mutate(ActSelect, "n", "9f2c1e")},
		{name: "screen carries a nonce", value: mutate(ActScreen, "n", "9f2c1e")},
		{name: "select session is not a string", value: mutate(ActSelect, "sid", float64(1))},
		{
			name:  "select session is longer than any real ref",
			value: mutate(ActSelect, "sid", strings.Repeat("x", maxSessionID+1)),
		},

		{name: "select without a seq", value: mutate(ActSelect, "seq", nil)},
		{name: "select seq is a string", value: mutate(ActSelect, "seq", "42")},
		{name: "select without an iat", value: mutate(ActSelect, "iat", nil)},
		{name: "select iat is zero", value: mutate(ActSelect, "iat", float64(0))},
		{name: "screen iat is negative", value: mutate(ActScreen, "iat", float64(-1))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, err := DecodeDecision(tt.value)
			if err == nil {
				t.Fatalf("accepted a malformed value as %+v", d)
			}
			if !errors.Is(err, ErrBadDecision) {
				t.Fatalf("err = %v, want ErrBadDecision", err)
			}
			if d != (Decision{}) {
				t.Fatalf("a rejected value must decode to nothing, got %+v", d)
			}
		})
	}
}

// TestInertCoversExactlyTheActsThatSendNothing. Inert() is what the bridge
// branches on to skip the nonce and the blocked-state guard, so an act
// wrongly reported as inert would skip both for a real keystroke.
func TestInertCoversExactlyTheActsThatSendNothing(t *testing.T) {
	for act, want := range map[string]bool{
		ActKey:    false,
		ActSelect: true,
		ActScreen: true,
		"":        false,
		"prompt":  false,
	} {
		if got := (Decision{Act: act}).Inert(); got != want {
			t.Fatalf("Decision{Act: %q}.Inert() = %v, want %v", act, got, want)
		}
	}
}

// TestDecodeDecisionIgnoresUnknownFields: Feishu echoes the value verbatim, so
// an extra field can only come from a newer build of this bridge. The fields
// that matter are all validated, so tolerating it beats refusing a press the
// user is waiting on.
func TestDecodeDecisionIgnoresUnknownFields(t *testing.T) {
	v := validValue()
	v["future"] = "something a later version added"
	if _, err := DecodeDecision(v); err != nil {
		t.Fatalf("DecodeDecision: %v", err)
	}
}

func with(key string, val any) map[string]any {
	v := validValue()
	v[key] = val
	return v
}

func without(key string) map[string]any {
	v := validValue()
	delete(v, key)
	return v
}
