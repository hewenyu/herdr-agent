package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/dedup"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// testCardMsgID is the id of the card being pressed. UpdateCard needs it, and
// it is the only handle on the message a card callback carries (S2 §3.6).
const testCardMsgID = "om_the_card"

// ---------- fixtures ----------

// wireValue round-trips a Decision through JSON exactly as the callback does.
// It matters: off the wire every number is a float64, and a decoder that only
// ever saw uint64 would work in tests and refuse every real press.
func wireValue(t *testing.T, d cards.Decision) map[string]any {
	t.Helper()

	raw, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal decision: %v", err)
	}
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("unmarshal decision: %v", err)
	}
	return v
}

// cardPress is the event Feishu delivers when a button on a real card is
// tapped. The card is built by the same code the bridge posts, and its button
// value travels back verbatim (G16), so this exercises the whole loop rather
// than a hand-written payload that could drift from what is actually shipped.
func cardPress(t *testing.T, a agents.Agent, key string) lark.Action {
	t.Helper()

	dialog := permissionDialog()
	card, err := cards.BuildBlocked(a, dialog, cards.ParseOptions(dialog), testNonce, epoch)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}

	ds := decisionsOf(t, card)
	for _, d := range ds {
		if d.Key == key {
			return lark.Action{
				EventID:   "ev_press_" + key,
				MessageID: testCardMsgID,
				ChatID:    testChat,
				Operator:  testOwner,
				Value:     wireValue(t, d),
			}
		}
	}
	t.Fatalf("the card offers no %q button; it offers %v", key, keysOf(ds))
	return lark.Action{}
}

// flakyBot wraps the shared fake so one call can be made to fail without
// adding knobs to fakes_test.go that every other test has to read past.
type flakyBot struct {
	*fakeBot
	updateErr error
	streamErr error
	// opened is signalled once per successfully opened stream, so a test can
	// wait for the pump to do its work instead of sleeping.
	opened chan struct{}
}

var _ lark.Bot = (*flakyBot)(nil)

func (f *flakyBot) UpdateCard(ctx context.Context, messageID, cardJSON string) error {
	if f.updateErr != nil {
		return f.updateErr
	}
	return f.fakeBot.UpdateCard(ctx, messageID, cardJSON)
}

func (f *flakyBot) Stream(ctx context.Context, o lark.Out) (lark.Stream, error) {
	if f.streamErr != nil {
		return nil, f.streamErr
	}
	s, err := f.fakeBot.Stream(ctx, o)
	if err == nil && f.opened != nil {
		select {
		case f.opened <- struct{}{}:
		default:
		}
	}
	return s, err
}

// pressed runs one card press through the installed handler, which is the only
// path a real press takes: it goes through guard() first, so authorization and
// deduplication cannot be skipped by a test any more than by production code.
func pressed(t *testing.T, h *harness, a lark.Action) {
	t.Helper()

	h.b.installHandlers()
	_, act := h.bot.handlers()
	if act == nil {
		t.Fatal("no card action handler was installed")
	}
	if err := act(context.Background(), a); err != nil {
		t.Fatalf("card handler returned %v; Feishu would redeliver this press", err)
	}
}

// disarmedCard is the single card update a press must always produce.
func disarmedCard(t *testing.T, h *harness) string {
	t.Helper()

	ups := h.bot.cardUpdates()
	if len(ups) != 1 {
		t.Fatalf("%d card updates, want exactly 1: a card that is not disarmed stays pressable forever (G17)", len(ups))
	}
	if ups[0].MessageID != testCardMsgID {
		t.Errorf("updated message %q, want the card's own %q", ups[0].MessageID, testCardMsgID)
	}
	if strings.Contains(ups[0].Card, `"tag":"button"`) {
		t.Errorf("the replacement card still has buttons:\n%s", ups[0].Card)
	}
	return ups[0].Card
}

// ---------- the happy path ----------

// TestAPressSendsTheKeyAndDisarmsTheCard is acceptance item 3 (S2 §4.3): the
// measured end-to-end loop of G16 — tap `1 Yes` on the phone, herdr sends the
// key, the agent proceeds — plus the disarm that G17 requires immediately
// afterwards.
func TestAPressSendsTheKeyAndDisarmsTheCard(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)

	settled := a
	settled.Status = agents.StatusIdle
	settled.StateSeq = a.StateSeq + 1
	h.ctrl.keyResult = settled

	pressed(t, h, cardPress(t, a, "1"))

	keys := h.ctrl.sentKeys()
	if len(keys) != 1 {
		t.Fatalf("%d keys sent, want exactly 1: %+v", len(keys), keys)
	}
	if keys[0].Key != "1" {
		t.Errorf("sent key %q, want %q", keys[0].Key, "1")
	}

	card := disarmedCard(t, h)
	for _, want := range []string{
		"1",          // which key
		a.PaneID,     // to which pane
		testOwner,    // who pressed it
		"idle",       // what came of it
		"2026-08-14", // when
	} {
		if !strings.Contains(card, want) {
			t.Errorf("the resolved card does not mention %q:\n%s", want, card)
		}
	}
}

// TestTheGuardComesFromTheCardNotFromTheLiveAgent is the whole point of putting
// a Guard inside the button value.
//
// If the bridge rebuilt the guard from whatever herdr reports at press time,
// every check in SendKey would compare the agent with itself and pass — a
// three-day-old card would sail straight through into a pane running something
// else entirely (G17). The agent in the registry here is deliberately at a
// different state sequence from the card.
func TestTheGuardComesFromTheCardNotFromTheLiveAgent(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()

	moved := a
	moved.StateSeq = a.StateSeq + 100
	moved.Status = agents.StatusWorking
	h.reg.setAgents(moved)

	pressed(t, h, cardPress(t, a, "1"))

	keys := h.ctrl.sentKeys()
	if len(keys) != 1 {
		t.Fatalf("%d keys sent, want 1", len(keys))
	}
	g := keys[0].Guard
	if g.StateSeq != a.StateSeq {
		t.Errorf("guard carries seq %d, want the card's %d — the live agent is at %d",
			g.StateSeq, a.StateSeq, moved.StateSeq)
	}
	if g.PaneID != a.PaneID || g.Kind != a.Kind {
		t.Errorf("guard = %+v, want pane %q kind %q from the card", g, a.PaneID, a.Kind)
	}
	if want := time.Unix(epoch.Unix(), 0); !g.IssuedAt.Equal(want) {
		t.Errorf("guard issued %s, want the card's issue time %s", g.IssuedAt, want)
	}
}

// ---------- the vote-no item ----------

// TestASecondPressOfTheSameCardSendsNothing is acceptance item 4 (S2 §4.4), a
// one-vote-veto.
//
// Measured (G17): after the agent had stopped being blocked, pressing the old
// card's `1 Yes` again still delivered the key, and it landed in the input box
// as a stray "1". Feishu messages never expire; three days later that button is
// still there. The nonce is what makes the second press inert even if the agent
// happens to be blocked again at the very same state sequence.
//
// The second press carries a DIFFERENT event id on purpose: event-id dedup
// covers Feishu redelivering one press, not a human pressing twice.
func TestASecondPressOfTheSameCardSendsNothing(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)

	first := cardPress(t, a, "1")
	pressed(t, h, first)

	if got := len(h.ctrl.sentKeys()); got != 1 {
		t.Fatalf("first press sent %d keys, want 1", got)
	}

	second := first
	second.EventID = "ev_press_1_again"
	pressed(t, h, second)

	if keys := h.ctrl.sentKeys(); len(keys) != 1 {
		t.Fatalf("a second press typed into the agent: %+v", keys)
	}
	ups := h.bot.cardUpdates()
	if len(ups) != 2 {
		t.Fatalf("%d card updates, want one per press: the user must be told the press did nothing", len(ups))
	}
	if !strings.Contains(ups[1].Card, "already been used") {
		t.Errorf("the second update does not say the card was spent:\n%s", ups[1].Card)
	}
	if strings.Contains(ups[1].Card, `"tag":"button"`) {
		t.Errorf("the second update re-armed the card:\n%s", ups[1].Card)
	}
}

// TestPressingAnotherButtonOfASpentCardSendsNothing: all the buttons of one
// card share a nonce, because a card is one question. Answering `2` after
// answering `1` is the same stale decision as pressing `1` twice.
func TestPressingAnotherButtonOfASpentCardSendsNothing(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)

	pressed(t, h, cardPress(t, a, "1"))
	pressed(t, h, cardPress(t, a, "3"))

	keys := h.ctrl.sentKeys()
	if len(keys) != 1 || keys[0].Key != "1" {
		t.Fatalf("keys sent = %+v, want only the first press", keys)
	}
	if got := len(h.bot.cardUpdates()); got != 2 {
		t.Fatalf("%d card updates, want one per press", got)
	}
}

// TestTheNonceOutlivesTheCardDedupWindow.
//
// NSNonce is not a namespace the dedup store knows, so it falls into the
// store's default window — which is the long one, deliberately. The card
// namespace expires after 15 minutes; if a nonce expired with it, a card
// pressed at 16 minutes would be as good as new, and G17 is about cards that
// are days old. This asserts the constant this package publishes agrees with
// what the store will actually apply.
func TestTheNonceOutlivesTheCardDedupWindow(t *testing.T) {
	if NonceTTL != dedup.MessageTTL {
		t.Fatalf("NonceTTL = %s but the store will apply %s to an unknown namespace", NonceTTL, dedup.MessageTTL)
	}
	if NonceTTL <= dedup.CardTTL {
		t.Fatalf("NonceTTL %s does not outlive the card dedup window %s; a card would re-arm itself",
			NonceTTL, dedup.CardTTL)
	}
}

// ---------- refusals ----------

// TestARefusedPressTypesNothingAndStillDisarms covers every way SendKey can say
// no. Each of them is one of the four guard checks S1 performs on the Guard
// this bridge hands it, and none of them may end with a keystroke or with a
// card that still looks pressable (S2 §3.6, G17).
func TestARefusedPressTypesNothingAndStillDisarms(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string // what the user must be told
	}{
		{"agent moved on", agents.ErrNoLongerBlocked, "not waiting at the question this card was made for"},
		{"card too old", agents.ErrGuardStale, "older than"},
		{"pane closed", agents.ErrPaneGone, "no longer exists"},
		{"different agent now", agents.ErrAgentReplaced, "different agent"},
		{"key not allowed", agents.ErrKeyNotAllowed, "not a key this bridge will send"},
		{"herdr unreachable", errors.New("dial unix /tmp/herdr.sock: connection refused"), "would not take the key"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			a := blockedAgent()
			h.reg.setAgents(a)
			h.ctrl.keyErr = tt.err

			pressed(t, h, cardPress(t, a, "1"))

			card := disarmedCard(t, h)
			if !strings.Contains(card, tt.want) {
				t.Errorf("the card does not explain the refusal (%q):\n%s", tt.want, card)
			}
			if !strings.Contains(card, "NOT sent") {
				t.Errorf("the card does not say the key was not sent:\n%s", card)
			}
			if !strings.Contains(card, a.PaneID) {
				t.Errorf("the card does not name the pane:\n%s", card)
			}
		})
	}
}

// TestAStaleGuardIsHandedToSendKeyAndNothingElseHappens.
//
// SendKey owns the four guard checks; this layer's job is to hand it the card's
// guard, take no for an answer, and not go looking for another way to deliver
// the key. Notably it must not fall back to prose — prose at an open dialog is
// an approval (G1).
func TestAStaleGuardIsHandedToSendKeyAndNothingElseHappens(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)
	h.ctrl.keyErr = agents.ErrNoLongerBlocked

	pressed(t, h, cardPress(t, a, "1"))

	if got := h.ctrl.said(); len(got) != 0 {
		t.Fatalf("a refused press fell back to prose: %+v", got)
	}
	if got := h.ctrl.interrupted(); len(got) != 0 {
		t.Fatalf("a refused press sent esc: %+v", got)
	}
	if got := len(h.ctrl.sentKeys()); got != 1 {
		t.Fatalf("SendKey was called %d times, want exactly once", got)
	}
	disarmedCard(t, h)
}

// TestAnUndecodableValueTypesNothingAndStillDisarms.
//
// The value is the only thing between a tap in a chat window and a keystroke in
// a live terminal, so anything that is not exactly what BuildBlocked wrote is
// refused rather than repaired. The card is still disarmed: its buttons cannot
// work, and leaving them drawn invites tapping.
func TestAnUndecodableValueTypesNothingAndStillDisarms(t *testing.T) {
	tests := []struct {
		name  string
		value map[string]any
	}{
		{"no value at all", nil},
		{"empty object", map[string]any{}},
		{"wrong act", map[string]any{"act": "reboot", "key": "1", "pane": testPane, "seq": 1.0, "iat": 1.0, "n": "x"}},
		{"key outside the allowlist", map[string]any{"act": "key", "key": "rm -rf /", "pane": testPane, "seq": 1.0, "iat": 1.0, "n": "x"}},
		{"no nonce", map[string]any{"act": "key", "key": "1", "pane": testPane, "seq": 1.0, "iat": 1.0}},
		{"no issue time", map[string]any{"act": "key", "key": "1", "pane": testPane, "seq": 1.0, "n": "x"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(blockedAgent())

			pressed(t, h, lark.Action{
				EventID:   "ev_bad",
				MessageID: testCardMsgID,
				ChatID:    testChat,
				Operator:  testOwner,
				Value:     tt.value,
			})

			assertNothingWasTyped(t, h, "a card value the decoder refused")
			card := disarmedCard(t, h)
			if !strings.Contains(card, "could not read") {
				t.Errorf("the card does not explain why nothing happened:\n%s", card)
			}
			// The nonce store must not be marked with junk salvaged from an
			// unreadable payload.
			for _, op := range h.dedup.history() {
				if op.NS == NSNonce {
					t.Errorf("an undecodable press touched the nonce store: %+v", op)
				}
			}
		})
	}
}

// TestAnUndecodableInertPressLeavesTheCardAlone.
//
// The disarm is a full redraw of the card, and on a blocked card the numbered
// buttons it destroys are the only way to answer an agent that is still sitting
// at its question. A decodable Select press is therefore left to stand; a press
// whose value this build cannot read must be too, when the value says it was
// that same button. Otherwise a later build that tightens DecodeDecision turns
// one tap on "Select & type" into the loss of a live card — hazard (c) arriving
// through the decode path.
//
// Trusting the act this far is safe in the only direction it is used: decoding
// already failed, so nothing can be typed from this payload whatever it claims,
// and a claimed act can only withhold the redraw, never cause one.
func TestAnUndecodableInertPressLeavesTheCardAlone(t *testing.T) {
	for _, act := range []string{cards.ActSelect, cards.ActScreen} {
		t.Run(act, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(blockedAgent())

			pressed(t, h, lark.Action{
				EventID:   "ev_bad_" + act,
				MessageID: testCardMsgID,
				ChatID:    testChat,
				Operator:  testOwner,
				// No seq, no iat: refused by the decoder, and claiming to be a
				// button that types nothing.
				Value: map[string]any{"act": act, "pane": testPane},
			})

			assertNothingWasTyped(t, h, "a card value the decoder refused")
			if ups := updatesOf(h, testCardMsgID); len(ups) != 0 {
				t.Fatalf("the card was redrawn by an unreadable press of an inert button: %+v", ups)
			}
			wantContains(t, lastText(t, h), "left exactly as it is",
				"the user must be told the card still works")
		})
	}

	// The fail-safe half: a value that does not claim to be inert still disarms,
	// because only a key press can type and an unknown act might be one.
	h := newHarness(t)
	h.reg.setAgents(blockedAgent())
	pressed(t, h, lark.Action{
		EventID:   "ev_bad_unknown",
		MessageID: testCardMsgID,
		ChatID:    testChat,
		Operator:  testOwner,
		Value:     map[string]any{"act": "reboot", "pane": testPane},
	})
	if ups := updatesOf(h, testCardMsgID); len(ups) != 1 {
		t.Fatalf("%d updates for an unreadable press of an unknown act, want the card disarmed", len(ups))
	}
}

// TestAnUnauthorizedPressTypesNothingAndSaysNothing.
//
// S2 §3.4 and this package's contract: an unauthorized event is logged at WARN
// and dropped with no reply. That includes NOT disarming the card. The card is
// deliberately left alone, because disarming it is a write anyone who can see
// it could trigger: a stranger tapping a button would otherwise destroy the
// owner's only way of answering an agent that is sitting at a dialog. Refusing
// the keystroke is the whole security requirement; the card stays valid for the
// person it was posted to, who is still subject to the nonce and the guard.
func TestAnUnauthorizedPressTypesNothingAndSaysNothing(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)

	press := cardPress(t, a, "1")
	press.Operator = testStranger
	pressed(t, h, press)

	assertNothingWasTyped(t, h, "a press by somebody who is not on the allowlist")
	if ups := h.bot.cardUpdates(); len(ups) != 0 {
		t.Fatalf("a stranger's press mutated the card: %+v", ups)
	}
	if sends := h.bot.sends(); len(sends) != 0 {
		t.Fatalf("the bridge answered a stranger: %+v", sends)
	}
	if ops := h.dedup.history(); len(ops) != 0 {
		t.Fatalf("a stranger's press left a trace in the dedup store: %+v", ops)
	}
}

// TestARedeliveredPressActsOnce is G14 at the card entry point. Feishu
// redelivers an event whose handler failed, byte-identical, about five minutes
// later; here that would be a second keystroke into a live agent.
func TestARedeliveredPressActsOnce(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)

	press := cardPress(t, a, "1")
	pressed(t, h, press)
	pressed(t, h, press) // same event id: this is Feishu, not the user

	if keys := h.ctrl.sentKeys(); len(keys) != 1 {
		t.Fatalf("%d keys reached the agent, want 1: %+v", len(keys), keys)
	}
	if ups := h.bot.cardUpdates(); len(ups) != 1 {
		t.Fatalf("%d card updates, want 1; the redelivery was acted on", len(ups))
	}
}

// TestAFailedCardUpdateIsReportedInText.
//
// If the card cannot be replaced the buttons stay drawn, so the user has to
// hear both what happened and that those buttons are spent — otherwise they
// keep tapping something that answers nothing, which is the exact confusion
// G17 produced when it was measured.
func TestAFailedCardUpdateIsReportedInText(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)
	h.b.deps.Bot = &flakyBot{fakeBot: h.bot, updateErr: errors.New("card update rejected")}

	pressed(t, h, cardPress(t, a, "1"))

	if got := len(h.ctrl.sentKeys()); got != 1 {
		t.Fatalf("%d keys sent, want 1: the key went in before the card update failed", got)
	}
	text := lastText(t, h)
	if !strings.Contains(text, "Sent") || !strings.Contains(text, a.PaneID) {
		t.Errorf("the fallback message does not say what was sent where:\n%s", text)
	}
	if !strings.Contains(text, "spent") {
		t.Errorf("the fallback message does not warn that the drawn buttons are spent:\n%s", text)
	}
}

// TestAPressWithNoMessageIDStillAnswersInText: without a message id there is no
// card to update, and silence would leave the user believing an agent had been
// answered.
func TestAPressWithNoMessageIDStillAnswersInText(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)
	h.ctrl.keyErr = agents.ErrNoLongerBlocked

	press := cardPress(t, a, "1")
	press.MessageID = ""
	pressed(t, h, press)

	if ups := h.bot.cardUpdates(); len(ups) != 0 {
		t.Fatalf("something was updated without a message id: %+v", ups)
	}
	text := lastText(t, h)
	if !strings.Contains(text, "Nothing was sent") {
		t.Errorf("the user was not told the press did nothing:\n%s", text)
	}
}

// TestARefusedPressIsNotRetriedByFeishu: the handler returns nil for every
// refusal. Returning an error leaves the press unacknowledged, Feishu resends
// it about five minutes later (G14), and by then the nonce is spent — so the
// only thing a retry can produce is a second "this card is spent" card.
func TestARefusedPressIsNotRetriedByFeishu(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)
	h.ctrl.keyErr = agents.ErrPaneGone

	press := cardPress(t, a, "1")
	if err := h.b.handleCardAction(context.Background(), press); err != nil {
		t.Fatalf("handleCardAction = %v, want nil so Feishu stops resending", err)
	}
}
