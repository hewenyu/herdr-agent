package bridge

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/screen"
	"github.com/hewenyu/herdr-agent/internal/selection"
)

// ---------- fixtures ----------

// listCard renders the picker exactly as the bridge posts it, so a press built
// from it carries the value a real tap would send back (G16).
func listCard(t *testing.T, current string, list ...agents.Agent) string {
	t.Helper()
	return listCardAt(t, epoch, current, list...)
}

// listCardAt is listCard with the issue time spelled out, for the cards that
// are still in the chat history long after they were drawn (G17).
func listCardAt(t *testing.T, at time.Time, current string, list ...agents.Agent) string {
	t.Helper()

	card, err := cards.BuildAgentList(list, current, at)
	if err != nil {
		t.Fatalf("BuildAgentList: %v", err)
	}
	return card
}

// blockedCard is the notification card an agent waiting at a permission dialog
// produces. Its numbered buttons are the ones a Select press must not destroy.
func blockedCard(t *testing.T, a agents.Agent) string {
	t.Helper()

	dialog := permissionDialog()
	card, err := cards.BuildBlocked(a, dialog, cards.ParseOptions(dialog), testNonce, epoch)
	if err != nil {
		t.Fatalf("BuildBlocked: %v", err)
	}
	return card
}

// inertPress is the event Feishu delivers when one of the buttons that sends
// nothing — Select, Screen — is tapped on a card the bridge really rendered.
func inertPress(t *testing.T, cardJSON, messageID, pane, act string) lark.Action {
	t.Helper()

	for _, d := range decisionsOf(t, cardJSON) {
		if d.Act != act || d.Pane != pane {
			continue
		}
		if !d.Inert() {
			t.Fatalf("the %q button for %s carries a value that is not inert: %+v", act, pane, d)
		}
		return lark.Action{
			EventID:   "ev_" + act + "_" + pane,
			MessageID: messageID,
			ChatID:    testChat,
			Operator:  testOwner,
			Value:     wireValue(t, d),
		}
	}
	t.Fatalf("no %q button for %s; the card offers %v", act, pane, actsOf(decisionsOf(t, cardJSON)))
	return lark.Action{}
}

// postPickerCard runs /ls and returns the message id of the card it posted,
// which is the card the user then taps.
func postPickerCard(t *testing.T, h *harness) string {
	t.Helper()

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("/ls: %v", err)
	}
	sends := h.bot.sends()
	if len(sends) == 0 || sends[len(sends)-1].Out.Card == "" {
		t.Fatalf("/ls sent no card: %+v", sends)
	}
	return sends[len(sends)-1].ID
}

// updatesOf is every card update aimed at one message.
func updatesOf(h *harness, messageID string) []cardUpdate {
	out := make([]cardUpdate, 0, 1)
	for _, u := range h.bot.cardUpdates() {
		if u.MessageID == messageID {
			out = append(out, u)
		}
	}
	return out
}

// nonceOps is every touch of the single-use store. An inert act must leave none:
// all the buttons of a blocked card share one nonce, so spending it on a Select
// press would answer the agent's question with silence.
func nonceOps(h *harness) []dedupOp {
	out := make([]dedupOp, 0, 1)
	for _, op := range h.dedup.history() {
		if op.NS == NSNonce {
			out = append(out, op)
		}
	}
	return out
}

// ---------- one act, one path ----------

// TestEachActReachesOnlyItsOwnPath is the split this wave exists for.
//
// handleCardAction used to assume every press was a keystroke. Two of the three
// acts now send nothing at all, and the assertion that matters is negative: a
// Select press must never reach SendKey, because a key is what puts a character
// into a live terminal — and at a permission dialog a character is an approval
// (G1, G16).
func TestEachActReachesOnlyItsOwnPath(t *testing.T) {
	t.Run("key types and disarms its card", func(t *testing.T) {
		h := newHarness(t)
		a := withSession(blockedAgent(), "sess-one")
		h.reg.setAgents(a)
		h.ctrl.keyResult = a

		pressed(t, h, cardPress(t, a, "1"))

		if keys := h.ctrl.sentKeys(); len(keys) != 1 || keys[0].Key != "1" {
			t.Fatalf("keys = %+v, want exactly one `1`", keys)
		}
		disarmedCard(t, h)
		if _, ok := h.selected(testChat); ok {
			t.Error("answering a question also re-aimed the chat; a key press is not a selection")
		}
	})

	t.Run("select aims and sends nothing", func(t *testing.T) {
		h := newHarness(t)
		a := withSession(idleAgent(testPane), "sess-one")
		h.reg.setAgents(a)

		pressed(t, h, inertPress(t, listCard(t, "", a), "om_list", testPane, cards.ActSelect))

		assertNothingWasTyped(t, h, "a Select press")
		if ops := nonceOps(h); len(ops) != 0 {
			t.Fatalf("a Select press spent a nonce: %+v", ops)
		}
		got, ok := h.selected(testChat)
		if !ok {
			t.Fatal("the chat was not aimed at anything, which is the only thing this press does")
		}
		if got.Pane != testPane || got.Kind != "claude" || got.Session != "sess-one" {
			t.Errorf("selection = %+v, want the agent's pane AND its identity", got)
		}
	})

	t.Run("screen reads and sends nothing", func(t *testing.T) {
		h := newHarness(t)
		a := withSession(idleAgent(testPane), "sess-one")
		h.reg.setAgents(a)
		h.ex.dialog = permissionDialog()

		pressed(t, h, inertPress(t, listCard(t, "", a), "om_list", testPane, cards.ActScreen))

		assertNothingWasTyped(t, h, "a Screen press")
		if ops := nonceOps(h); len(ops) != 0 {
			t.Fatalf("a Screen press spent a nonce: %+v", ops)
		}
		if _, ok := h.selected(testChat); ok {
			t.Error("looking at an agent also aimed the chat at it; Screen is a read, not a choice")
		}
		text := lastText(t, h)
		wantContains(t, text, "Do you want to proceed?", "the screen itself must be in the message")
		wantContains(t, text, testPane, "the message must name the pane it read")
	})
}

// TestSelectOnABlockedCardLeavesItArmed.
//
// Select is how the user gets ready to ANSWER a question, so the numbered
// buttons have to survive it. Disarming here would be the exact failure the
// disarm exists to prevent, inverted: instead of a card that keeps working
// forever (G17), a card that stopped working while the agent is still waiting.
func TestSelectOnABlockedCardLeavesItArmed(t *testing.T) {
	h := newHarness(t)
	a := withSession(blockedAgent(), "sess-one")
	h.reg.setAgents(a)
	h.ctrl.keyResult = a

	pressed(t, h, inertPress(t, blockedCard(t, a), testCardMsgID, a.PaneID, cards.ActSelect))

	if ups := updatesOf(h, testCardMsgID); len(ups) != 0 {
		t.Fatalf("the blocked card was rewritten by a Select press: %+v", ups)
	}
	if _, ok := h.selected(testChat); !ok {
		t.Fatal("the press did not aim the chat at the blocked agent")
	}
	// The user is being invited to type at an agent that is sitting on a
	// permission dialog. Prose gets there through Controller.Say, which presses
	// esc first (G2), so the question disappears rather than being answered —
	// and learning that from the delivery report afterwards is too late.
	wantContains(t, lastText(t, h), "Esc", "the confirmation must warn that typing backs out of the question")

	// The proof that it is still armed: the numbered button still answers.
	pressed(t, h, cardPress(t, a, "1"))

	keys := h.ctrl.sentKeys()
	if len(keys) != 1 || keys[0].Key != "1" {
		t.Fatalf("keys = %+v, want the `1` button to still work after a Select press", keys)
	}
	if ups := updatesOf(h, testCardMsgID); len(ups) != 1 {
		t.Fatalf("%d updates of the card after the key press, want exactly the disarm", len(ups))
	}
}

// ---------- the card stays true ----------

// TestSelectRerendersThePickerInPlace: the picker states which agent your
// typing goes to, and a card in Feishu lives forever (G17). A selection change
// that left it saying the old answer would be a card actively lying about where
// the next message lands.
func TestSelectRerendersThePickerInPlace(t *testing.T) {
	h := newHarness(t)
	first := withSession(idleAgent(testPane), "sess-one")
	second := withSession(idleAgent(secondPane), "sess-two")
	h.reg.setAgents(first, second)

	cardID := postPickerCard(t, h)
	press := inertPress(t, listCard(t, "", first, second), cardID, secondPane, cards.ActSelect)
	pressed(t, h, press)

	ups := updatesOf(h, cardID)
	if len(ups) != 1 {
		t.Fatalf("%d updates of the picker, want exactly one in-place re-render", len(ups))
	}
	wantContains(t, ups[0].Card, "your typing goes to", "the re-rendered card must say where typing goes")
	wantContains(t, ups[0].Card, secondPane, "the re-rendered card must name the newly selected pane")
	wantContains(t, ups[0].Card, "✓ Selected", "the selected row must be marked as such")

	if got := len(h.bot.cards()); got != 1 {
		t.Errorf("%d cards posted, want 1: the picker is edited where it stands, not re-posted", got)
	}
	got, ok := h.selected(testChat)
	if !ok || got.Pane != secondPane {
		t.Fatalf("selection = %+v, want %s", got, secondPane)
	}
	if got.CardMessageID != cardID {
		t.Errorf("selection card id = %q, want %q so the next change finds it again", got.CardMessageID, cardID)
	}
	wantContains(t, lastText(t, h), secondPane, "the press must be answered with a line naming the new target")
}

// TestAFailedPickerUpdateFallsBackToANewCard: Feishu refuses an edit to a
// message that was revoked or is older than it keeps. The truth then has to
// arrive as a new card, and the new card is the one the next change edits —
// otherwise every later selection would try the dead message again.
func TestAFailedPickerUpdateFallsBackToANewCard(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a)

	cardID := postPickerCard(t, h)
	h.b.deps.Bot = &flakyBot{fakeBot: h.bot, updateErr: errors.New("message is too old to update")}

	pressed(t, h, inertPress(t, listCard(t, "", a), cardID, testPane, cards.ActSelect))

	sent := h.bot.sends()
	var posted []sendCall
	for _, c := range sent {
		if c.Out.Card != "" {
			posted = append(posted, c)
		}
	}
	if len(posted) != 2 {
		t.Fatalf("%d cards posted, want the original plus the replacement: %+v", len(posted), posted)
	}
	wantContains(t, posted[1].Out.Card, "your typing goes to", "the replacement card must show the new selection")

	got, ok := h.selected(testChat)
	if !ok {
		t.Fatal("the selection was lost when the card could not be edited")
	}
	if got.CardMessageID != posted[1].ID {
		t.Errorf("selection card id = %q, want the replacement %q", got.CardMessageID, posted[1].ID)
	}
}

// TestAnUnavailableTargetRepaintsThePickerInPlace is the same rule on the route
// where nobody pressed anything: the agent behind a standing selection is not
// running, so nothing can be delivered.
//
// Two things are asserted and the second is the point. The card is brought up
// to date where it stands — it marked a row as current and that row is gone —
// and NO fresh card is posted underneath, because the chat is still aimed and
// a chooser under every message reads as "pick again", which is exactly what
// this wave removed.
func TestAnUnavailableTargetRepaintsThePickerInPlace(t *testing.T) {
	h := newHarness(t)
	was := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(was)
	h.selectAgent(testChat, was)

	cardID := postPickerCard(t, h)
	before := len(h.bot.cards())
	h.reg.setAgents() // it exited

	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	assertNothingWasTyped(t, h, "a selection whose agent is not running")
	ups := updatesOf(h, cardID)
	if len(ups) != 1 {
		t.Fatalf("%d updates of the picker, want the stale one brought up to date", len(ups))
	}
	if strings.Contains(ups[0].Card, "✓ Selected") {
		t.Errorf("the repainted card marks a row as selected although nothing is running there:\n%s", ups[0].Card)
	}
	wantContains(t, ups[0].Card, "still aimed at", "the repainted card must say the aim is unchanged")
	if strings.Contains(ups[0].Card, "nothing selected") {
		t.Errorf("the repainted card claims the chat was un-aimed:\n%s", ups[0].Card)
	}
	if got := len(h.bot.cards()); got != before {
		t.Errorf("%d cards posted, want none: the chat already knows who it is talking to", got-before)
	}
	if _, ok := h.selected(testChat); !ok {
		t.Error("the selection was dropped because the agent was briefly not there")
	}
}

// TestAnUnavailableTargetRepaintsThePickerAfterARestart is the same rule with
// the memory index cold, which is the state every restart starts in.
//
// The id of the live picker card is stored INSIDE the target. In-process the
// pickers index also holds it, which hides any dependence on the durable copy;
// after a restart the index is empty and the target is all there is, and S2
// §3.1 has the bridge killed and restarted routinely while a selection now
// lasts until the user closes it.
func TestAnUnavailableTargetRepaintsThePickerAfterARestart(t *testing.T) {
	h := newHarness(t)
	was := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(was)

	// Exactly what a restart reloads: a selection that remembers its card, and
	// an index that remembers nothing.
	const cardID = "om_picker_from_before_the_restart"
	h.sel.Set(testChat, selection.Target{
		Pane:          was.PaneID,
		Kind:          was.Kind,
		Session:       sessionID(was),
		Cwd:           was.Cwd,
		SelectedAt:    h.b.now(),
		CardMessageID: cardID,
	})
	if got := h.b.pickers.get(testChat); got != "" {
		t.Fatalf("the memory index holds %q; this test is not exercising a cold one", got)
	}

	h.reg.setAgents() // it exited

	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	assertNothingWasTyped(t, h, "a selection whose agent is not running")
	ups := updatesOf(h, cardID)
	if len(ups) != 1 {
		t.Fatalf("%d updates of the picker card the selection named, want the stale one corrected", len(ups))
	}
	if strings.Contains(ups[0].Card, "✓ Selected") {
		t.Errorf("the repainted card still marks a row as selected:\n%s", ups[0].Card)
	}
}

// TestThePickerIndexIsBounded: the index is keyed by chat id, and a map keyed
// by something an event carries must not grow without limit. Losing an entry
// costs one card posted where an edit would have done, so the newest chat — the
// one definitely in use — is the one that must survive.
func TestThePickerIndexIsBounded(t *testing.T) {
	p := newPickerIndex()
	for i := range maxPickerChats + 10 {
		p.remember(fmt.Sprintf("oc_%d", i), fmt.Sprintf("om_%d", i))
	}

	p.mu.Lock()
	size := len(p.last)
	p.mu.Unlock()
	if size > maxPickerChats {
		t.Errorf("the index holds %d entries, want at most %d", size, maxPickerChats)
	}

	last := fmt.Sprintf("oc_%d", maxPickerChats+9)
	if got := p.get(last); got != fmt.Sprintf("om_%d", maxPickerChats+9) {
		t.Errorf("the most recent chat was evicted: get(%q) = %q", last, got)
	}
}

// ---------- refusals ----------

// TestSelectIsRefusedWhenTheSeatChanged is the hazard this wave closes, at the
// button that creates a selection.
//
// A pane id is a seat, not an identity: select claude at w1:p1, walk away,
// claude exits, codex starts in the same pane. Honouring the old card would aim
// every later message at a different context, and text typed at an agent that
// is sitting on a permission dialog answers it (G1, G8).
//
// What a refusal must NOT do is take away a selection the chat already had. The
// press said "aim me here"; it failed; that is the whole of it. Ending the
// conversation the user was in the middle of, as a side effect of a button that
// reports doing nothing, is the failure /close exists to be the only cause of.
func TestSelectIsRefusedWhenTheSeatChanged(t *testing.T) {
	carded := withSession(idleAgent(testPane), "sess-one")

	tests := []struct {
		name string
		now  agents.Agent
		says string
		gone bool
	}{
		{
			name: "a different kind took the seat",
			now:  withSession(func() agents.Agent { a := idleAgent(testPane); a.Kind = "codex"; return a }(), "sess-one"),
			says: "now runs codex",
		},
		{
			name: "the pane is gone",
			gone: true,
			says: "is gone",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(carded)
			h.selectAgent(testChat, carded)
			card := listCard(t, testPane, carded)

			if tt.gone {
				h.reg.setAgents()
			} else {
				h.reg.setAgents(tt.now)
			}

			pressed(t, h, inertPress(t, card, "om_list", testPane, cards.ActSelect))

			assertNothingWasTyped(t, h, "a refused Select press")
			if got, ok := h.selected(testChat); !ok || got.Pane != testPane {
				t.Fatalf("selection = %+v, want the one the chat already had left alone", got)
			}
			text := lastText(t, h)
			wantContains(t, text, tt.says, "the refusal must say what changed")
			if len(h.bot.cards()) == 0 && len(h.bot.cardUpdates()) == 0 {
				t.Error("the user was refused and shown no list, so there is no way to aim again")
			}
		})
	}
}

// TestAgreementBeatsTheClock covers the two ways a card and a live agent can
// agree, because only a genuine DISAGREEMENT may fall through to the card's age.
//
// The second form is the one easy to lose: neither side has a session id at
// all. That is the G8 window — codex whose hook was never trusted with `t` sits
// in it indefinitely — and there is nothing to disagree about, so an old card
// for such an agent must not start reporting it as somebody else.
func TestAgreementBeatsTheClock(t *testing.T) {
	old := epoch.Add(-agents.MaxGuardAge - time.Hour).Unix()

	sessioned := withSession(idleAgent(testPane), "sess-one")
	if replaced(cards.Decision{Kind: "claude", Session: "sess-one", IssuedAt: old}, sessioned, epoch) {
		t.Error("a card whose session still matches was refused for being old; that is proof, and proof does not stale")
	}

	none := idleAgent(testPane) // no SessionRef, and none coming
	if replaced(cards.Decision{Kind: "claude", IssuedAt: old}, none, epoch) {
		t.Error("an old card for an agent that has never published a session was reported as replaced")
	}

	// And a disagreement still falls through to the clock.
	if !replaced(cards.Decision{Kind: "claude", Session: "sess-one", IssuedAt: old}, none, epoch) {
		t.Error("an old card naming a session the agent is not on was trusted")
	}
}

// TestSelectSurvivesTheAgentStartingANewSession is the other half, and it is a
// retraction: a Select press used to be refused outright when the live session
// id differed from the card's.
//
// claude mints a new session on every /clear and every compaction, so the
// refusal fired on the card the user was looking at, seconds after it was
// posted, for an agent that had not moved — and the advice it printed was to
// run /ls and tap the identical button on an identical card. Inside the card's
// own freshness window the press is honoured, and what it stores is the LIVE
// identity, so every later delivery is checked against a session that exists.
func TestSelectSurvivesTheAgentStartingANewSession(t *testing.T) {
	h := newHarness(t)
	carded := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(carded)
	card := listCard(t, "", carded)

	restarted := withSession(idleAgent(testPane), "sess-two")
	h.reg.setAgents(restarted)

	pressed(t, h, inertPress(t, card, "om_list", testPane, cards.ActSelect))

	got, ok := h.selected(testChat)
	if !ok {
		t.Fatal("a Select press was refused for an agent that only started a new conversation")
	}
	if got.Session != "sess-two" {
		t.Errorf("stored session = %q, want the live %q", got.Session, "sess-two")
	}
	// The reply names what it actually aimed at, which is how a user who
	// tapped one row and got another finds out immediately.
	wantContains(t, lastText(t, h), "Now aimed at", "the press must say where typing now goes")
}

// TestSelectRecordsTheLiveIdentityNotTheCards is the G8 window seen from the
// press side.
//
// herdr publishes a session ref only once claude's trust-this-directory prompt
// is accepted, so a card built moments after detection carries none. Refusing
// that press would break Select exactly when it is most useful; what closes the
// hole instead is storing the identity of the agent that is in the pane NOW, so
// every later delivery is checked against a session that exists.
func TestSelectRecordsTheLiveIdentityNotTheCards(t *testing.T) {
	h := newHarness(t)
	unpublished := idleAgent(testPane) // no SessionRef in the card
	h.reg.setAgents(unpublished)
	card := listCard(t, "", unpublished)

	published := withSession(idleAgent(testPane), "sess-late")
	h.reg.setAgents(published)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	pressed(t, h, inertPress(t, card, "om_list", testPane, cards.ActSelect))

	got, ok := h.selected(testChat)
	if !ok {
		t.Fatal("a press made inside the detection window was refused; Select would be unusable there")
	}
	if got.Session != "sess-late" {
		t.Errorf("stored session = %q, want the live %q — the card's empty one would never re-check",
			got.Session, "sess-late")
	}

	// And the stored identity really does route: this is what the selection is for.
	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
}

// TestAnAgedSelectButtonStopsAimingAtWhoeverHoldsTheSeat bounds the one piece
// of deliberate laxness in replaced() (G8, G17).
//
// 09:00, claude starts in /project-a: herdr has published no session ref yet,
// so the /ls card's Select button carries none, and the button is trusted
// anyway — that is the window the laxness exists for. The user accepts the
// trust prompt, works, quits. 15:00, a different claude occupies the same seat
// in /project-b and does have a session. Feishu messages never expire, so the
// 09:00 card is still there, still reading "claude · project-a" — and tapping
// it must not aim the chat at project-b.
func TestAnAgedSelectButtonStopsAimingAtWhoeverHoldsTheSeat(t *testing.T) {
	h := newHarness(t)
	morning := idleAgent(testPane) // no SessionRef: the trust prompt is still open
	morning.Cwd = "/project-a"
	h.reg.setAgents(morning)

	stale := listCardAt(t, epoch.Add(-agents.MaxGuardAge-time.Minute), "", morning)
	fresh := listCardAt(t, epoch.Add(-agents.MaxGuardAge+time.Second), "", morning)

	afternoon := withSession(idleAgent(testPane), "sess-afternoon")
	afternoon.Cwd = "/project-b"
	h.reg.setAgents(afternoon)

	pressed(t, h, inertPress(t, stale, "om_morning_list", testPane, cards.ActSelect))

	assertNothingWasTyped(t, h, "a Select press from a card older than the window it was drawn in")
	if got, ok := h.selected(testChat); ok {
		t.Fatalf("selection = %+v, want none: that button was drawn before the agent it now names", got)
	}
	wantContains(t, lastText(t, h), "cannot tell whether it is still the same run",
		"the refusal must say why an old session-less button is no longer trusted")
	if len(h.bot.cards()) == 0 && len(h.bot.cardUpdates()) == 0 {
		t.Error("the user was refused and shown no list, so there is no way to aim again")
	}

	// The bound is the age, not the missing session: a button drawn inside
	// agents.MaxGuardAge still works, which is what keeps Select usable in the
	// window before herdr has published anything.
	second := inertPress(t, fresh, "om_recent_list", testPane, cards.ActSelect)
	second.EventID = "ev_the_second_tap" // a distinct event, not a redelivery of the first
	pressed(t, h, second)
	if got, ok := h.selected(testChat); !ok {
		t.Fatal("a press on a button drawn inside the window was refused; Select would be unusable there")
	} else if got.Session != "sess-afternoon" {
		t.Errorf("stored session = %q, want the live %q", got.Session, "sess-afternoon")
	}
}

// TestSelectIsRefusedWhenHerdrCannotIdentifyTheAgent: with no kind there is
// nothing to compare the live agent against before a later delivery, so the
// store refuses the target — and the user has to be told, not shown a
// confirmation for a selection that was never made.
func TestSelectIsRefusedWhenHerdrCannotIdentifyTheAgent(t *testing.T) {
	h := newHarness(t)
	unknown := idleAgent(testPane)
	unknown.Kind = "" // detected as a pane, not yet as an agent (G8)
	h.reg.setAgents(unknown)

	pressed(t, h, inertPress(t, listCard(t, "", unknown), "om_list", testPane, cards.ActSelect))

	if got, ok := h.selected(testChat); ok {
		t.Fatalf("selection = %+v, want none: it could only ever be honoured blind", got)
	}
	wantContains(t, lastText(t, h), "has not worked out what is running",
		"the user must be told why nothing was aimed")
}

// TestSelectWithoutASelectionStoreSaysSo: the store is optional (New builds a
// bridge without one), and a button that reports success while remembering
// nothing is worse than one that admits it.
func TestSelectWithoutASelectionStoreSaysSo(t *testing.T) {
	h := newHarnessWithoutSelection(t)
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a)

	pressed(t, h, inertPress(t, listCard(t, "", a), "om_list", testPane, cards.ActSelect))

	assertNothingWasTyped(t, h, "a Select press with no selection store")
	wantContains(t, lastText(t, h), "nowhere to remember", "the user must be told the press changed nothing")
}

// ---------- screen ----------

// TestScreenOnAReplacedPaneSaysWhoIsThereNow: reading is harmless, so the press
// is honoured — but the screen is labelled with the agent that is in the pane
// now. A screen silently attributed to the agent the card remembers would be a
// worse lie than one that says it changed (G17).
func TestScreenOnAReplacedPaneSaysWhoIsThereNow(t *testing.T) {
	h := newHarness(t)
	carded := withSession(idleAgent(testPane), "sess-one")
	card := listCard(t, "", carded)

	replacement := withSession(idleAgent(testPane), "sess-two")
	replacement.Kind = "codex"
	h.reg.setAgents(replacement)
	h.ex.dialog = permissionDialog()

	pressed(t, h, inertPress(t, card, "om_list", testPane, cards.ActScreen))

	assertNothingWasTyped(t, h, "a Screen press on a replaced pane")
	text := lastText(t, h)
	wantContains(t, text, "not the agent that button was made for", "the message must admit the pane changed hands")
	wantContains(t, text, "codex", "the message must name what is there now")
}

// TestScreenWarnsAboutANarrowPane is G5 meeting G11 on a phone.
//
// A pane herdr never attached a client to is 53 columns. Claude's TUI wraps
// there, the English strings herdr matches to detect "blocked" stop matching,
// and an unmatched screen is reported as idle rather than unknown — so the
// cards that say an agent needs a human simply stop arriving. The user cannot
// see that from a phone unless a message says it.
func TestScreenWarnsAboutANarrowPane(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a)
	h.ex.dialog = screen.Screen{
		Lines:   []string{"Do you want to proceed?", "❯ 1. Yes"},
		Rows:    23,
		Cols:    53,
		Narrow:  true,
		Cropped: true,
	}

	pressed(t, h, inertPress(t, listCard(t, "", a), "om_list", testPane, cards.ActScreen))

	text := lastText(t, h)
	wantContains(t, text, "53 columns", "the warning must name the width that breaks detection")
	wantContains(t, text, "idle instead of blocked", "the warning must say what silently goes wrong")
	wantContains(t, text, "cropped", "a cropped screen must say so rather than look complete")
}

// TestARefusedSelectRepaintsTheListInsteadOfPostingAnother: the picker is
// edited where it stands (Feishu update_multi), so a refusal the user can act
// on does not cost another card in a chat they read on a phone.
func TestARefusedSelectRepaintsTheListInsteadOfPostingAnother(t *testing.T) {
	h := newHarness(t)
	was := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(was)
	h.selectAgent(testChat, was)

	cardID := postPickerCard(t, h)
	card := listCard(t, testPane, was)

	// A different program in that seat: the one thing no card can make work.
	took := withSession(idleAgent(testPane), "sess-two")
	took.Kind = "codex"
	h.reg.setAgents(took)

	pressed(t, h, inertPress(t, card, cardID, testPane, cards.ActSelect))

	if ups := updatesOf(h, cardID); len(ups) != 1 {
		t.Fatalf("%d updates of the picker, want the refused list brought up to date", len(ups))
	}
	if got := len(h.bot.cards()); got != 1 {
		t.Errorf("%d cards posted, want only the original: the list was edited in place", got)
	}
	if _, ok := h.selected(testChat); !ok {
		t.Error("a refused press took away the conversation the chat was already having")
	}
	wantContains(t, lastText(t, h), "up to date", "the user must be told where the corrected list is")
}

// TestScreenOnAGonePaneShowsTheList: there is nothing to read, and what the
// user needs next is an agent that still exists.
func TestScreenOnAGonePaneShowsTheList(t *testing.T) {
	h := newHarness(t)
	gone := withSession(idleAgent(testPane), "sess-one")
	card := listCard(t, "", gone)
	h.reg.setAgents(idleAgent(secondPane))

	pressed(t, h, inertPress(t, card, "om_list", testPane, cards.ActScreen))

	assertNothingWasTyped(t, h, "a Screen press on a pane that is gone")
	wantContains(t, lastText(t, h), "is gone", "the user must be told there is no screen to read")
	if len(h.bot.cards()) == 0 {
		t.Error("no list was shown, so the user has no way to reach the agent that is left")
	}
}

// TestAnUnreadableScreenIsReportedNotSwallowed: herdr can refuse a read — G9
// makes agent.read unavailable exactly when an agent is busy — and silence
// would leave the user waiting for a screen that is never coming.
func TestAnUnreadableScreenIsReportedNotSwallowed(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a)
	h.ex.dialErr = errors.New("agent_not_idle")

	pressed(t, h, inertPress(t, listCard(t, "", a), "om_list", testPane, cards.ActScreen))

	wantContains(t, lastText(t, h), "Could not read", "a failed read must be reported")
	wantContains(t, lastText(t, h), "agent_not_idle", "the reason herdr gave must survive")
}

// ---------- authorization ----------

// TestAnUnauthorizedInertPressDoesNothing.
//
// S2 §3.4 is default-deny at EVERY entry point, and the inert acts are two new
// ones. A stranger's press must leave no trace at all: no selection moved, no
// card edited, no message sent, and nothing written to the dedup store that
// would make their second press behave differently from their first.
func TestAnUnauthorizedInertPressDoesNothing(t *testing.T) {
	for _, act := range []string{cards.ActSelect, cards.ActScreen} {
		t.Run(act, func(t *testing.T) {
			h := newHarness(t)
			a := withSession(idleAgent(testPane), "sess-one")
			h.reg.setAgents(a)
			h.ex.dialog = permissionDialog()

			press := inertPress(t, listCard(t, "", a), "om_list", testPane, act)
			press.Operator = testStranger
			pressed(t, h, press)

			assertNothingWasTyped(t, h, "a press by somebody who is not on the allowlist")
			if _, ok := h.selected(testChat); ok {
				t.Error("a stranger aimed the chat at an agent")
			}
			if ups := h.bot.cardUpdates(); len(ups) != 0 {
				t.Errorf("a stranger's press mutated a card: %+v", ups)
			}
			if sends := h.bot.sends(); len(sends) != 0 {
				t.Errorf("the bridge answered a stranger: %+v", sends)
			}
			if ops := h.dedup.history(); len(ops) != 0 {
				t.Errorf("a stranger's press left a trace in the dedup store: %+v", ops)
			}
		})
	}
}

// TestAnInertPressWithNoChatIdIsDropped: lark synthesises an event id for a
// press that arrives without a header, but it cannot invent the chat it came
// from — and both inert acts end in a message. A retry cannot supply one, so
// the press must be dropped rather than returned as an error Feishu keeps
// redelivering (G14).
func TestAnInertPressWithNoChatIdIsDropped(t *testing.T) {
	for _, act := range []string{cards.ActSelect, cards.ActScreen} {
		t.Run(act, func(t *testing.T) {
			h := newHarness(t)
			a := withSession(idleAgent(testPane), "sess-one")
			h.reg.setAgents(a)
			h.ex.dialog = permissionDialog()

			press := inertPress(t, listCard(t, "", a), "om_list", testPane, act)
			press.ChatID = ""
			if err := h.b.handleCardAction(context.Background(), press); err != nil {
				t.Fatalf("handleCardAction = %v, want nil so Feishu stops resending", err)
			}

			assertNothingWasTyped(t, h, "a press with no chat id")
			if _, ok := h.selected(""); ok {
				t.Error("a selection was recorded under an empty chat id")
			}
			if sends := h.bot.sends(); len(sends) != 0 {
				t.Errorf("something was sent for a press with nowhere to answer: %+v", sends)
			}
		})
	}
}

// TestARedeliveredInertPressActsOnce: Feishu redelivers an event whose handler
// failed, byte-identical, about five minutes later (G14). For Select that is
// harmless twice over, but a second card posted under the first is not.
func TestARedeliveredInertPressActsOnce(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a)

	press := inertPress(t, listCard(t, "", a), "om_list", testPane, cards.ActSelect)
	pressed(t, h, press)
	pressed(t, h, press) // same event id: this is Feishu, not the user

	if got := len(h.bot.sends()); got != 1 {
		t.Fatalf("%d messages sent, want 1: the redelivery was acted on again", got)
	}
}
