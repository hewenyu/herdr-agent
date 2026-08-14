package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/selection"
)

// ---------- fixtures ----------

// withSession is an agent herdr has published a native session id for. Until
// that happens the field is absent, which is a normal intermediate state and
// not an error: claude publishes one only after its trust-this-directory prompt
// is accepted, codex only after its hook is trusted with `t` (G8).
func withSession(a agents.Agent, id string) agents.Agent {
	a.SessionRef = &herdrapi.SessionRef{
		Source: "herdr:" + a.Kind,
		Agent:  a.Kind,
		Kind:   "id",
		Value:  id,
	}
	return a
}

// replyTo is an inbound message that answers one the bridge sent.
func replyTo(text, messageID string) lark.Msg {
	m := inbound(text)
	m.ReplyToMessageID = messageID
	return m
}

// saidTo is the pane every prose delivery went to, in order.
func saidTo(h *harness) []string {
	panes := make([]string, 0, 2)
	for _, c := range h.ctrl.said() {
		panes = append(panes, c.Guard.PaneID)
	}
	return panes
}

func delivered(t *testing.T, h *harness, pane string) {
	t.Helper()
	if got := saidTo(h); len(got) != 1 || got[0] != pane {
		t.Fatalf("prose went to %v, want exactly one delivery to %s", got, pane)
	}
}

// ---------- the priority table ----------

// TestRoutingPriority is the whole routing contract in one table.
//
// The order exists because the card is the primary interface now: typing is the
// cheapest thing a phone can do, so plain text must reach the selected agent
// with no gesture at all, while an explicit reply still wins for the one
// message it is attached to.
func TestRoutingPriority(t *testing.T) {
	claude1 := withSession(idleAgent(testPane), "sess-one")
	claude2 := withSession(idleAgent(secondPane), "sess-two")

	tests := []struct {
		name    string
		setup   func(h *harness)
		msg     lark.Msg
		want    string // pane the prose must reach, "" for none
		wantSel string // the chat's selection afterwards
	}{
		{
			name: "reply-to beats the selection and does not change it",
			setup: func(h *harness) {
				h.selectAgent(testChat, claude1)
				h.routes.bindAbout("om_about_w2", claude2)
			},
			msg:     replyTo("carry on", "om_about_w2"),
			want:    secondPane,
			wantSel: testPane,
		},
		{
			name: "the selection beats the agent count",
			setup: func(h *harness) {
				h.selectAgent(testChat, claude2)
			},
			msg:     inbound("carry on"),
			want:    secondPane,
			wantSel: secondPane,
		},
		{
			name:    "with no selection and one agent there is nowhere else to go",
			setup:   func(h *harness) { h.reg.setAgents(claude1) },
			msg:     inbound("carry on"),
			want:    testPane,
			wantSel: "",
		},
		{
			name:    "with no selection and several agents nothing is sent",
			msg:     inbound("carry on"),
			want:    "",
			wantSel: "",
		},
		{
			name: "an unroutable reply falls back to the selection",
			setup: func(h *harness) {
				h.selectAgent(testChat, claude1)
			},
			// A mirrored agent turn: streamed, so Feishu gives it no id the
			// bridge could ever have registered (see pumpMirror).
			msg:     replyTo("carry on", "om_a_mirrored_turn"),
			want:    testPane,
			wantSel: testPane,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(claude1, claude2)
			h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
			if tt.setup != nil {
				tt.setup(h)
			}

			if err := h.b.handleMessage(context.Background(), tt.msg); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}

			if tt.want == "" {
				assertNothingWasTyped(t, h, tt.name)
				if len(h.bot.cards()) == 0 {
					t.Error("nothing was delivered and no picker was posted; the user is left with no way forward")
				}
			} else {
				delivered(t, h, tt.want)
			}

			got, ok := h.selected(testChat)
			switch {
			case tt.wantSel == "" && ok:
				t.Errorf("the chat ended up selecting %s, want nothing", got.Pane)
			case tt.wantSel != "" && !ok:
				t.Errorf("the chat has no selection, want %s", tt.wantSel)
			case tt.wantSel != "" && got.Pane != tt.wantSel:
				t.Errorf("selection = %s, want %s", got.Pane, tt.wantSel)
			}
		})
	}
}

// TestAReplyDoesNotDisturbTheSelection states the half of the priority rule a
// table cannot: replying is a per-message override, so the conversation the
// user was having continues where it was.
func TestAReplyDoesNotDisturbTheSelection(t *testing.T) {
	h := newHarness(t)
	one := withSession(idleAgent(testPane), "sess-one")
	two := withSession(idleAgent(secondPane), "sess-two")
	h.reg.setAgents(one, two)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, one)
	before, _ := h.selected(testChat)
	h.routes.bindAbout("om_about_w2", two)

	if err := h.b.handleMessage(context.Background(), replyTo("just this once", "om_about_w2")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, secondPane)

	// And the NEXT plain message goes back to the selected agent.
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("and now you")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)

	after, ok := h.selected(testChat)
	if !ok || after.Pane != before.Pane || !after.SelectedAt.Equal(before.SelectedAt) {
		t.Fatalf("selection = %+v, want it untouched at %+v", after, before)
	}
}

// ---------- identity: a pane id is a seat, not an identity ----------

// TestASelectionIsRefusedWhenTheAgentWasReplaced is the hazard this wave exists
// to close.
//
// Select claude at w1:p1, walk away, claude exits, codex starts in the same
// pane. Routing on the seat alone would put the next thing typed into a
// different context — and text typed at an agent sitting on a permission dialog
// answers that dialog (G1). Both halves of the identity are checked because
// either can change alone: the kind when a different program takes the seat,
// the session id when the same program is started again.
func TestASelectionIsRefusedWhenTheAgentWasReplaced(t *testing.T) {
	selected := withSession(idleAgent(testPane), "sess-one")

	tests := []struct {
		name string
		now  agents.Agent
		says string
	}{
		{
			name: "a different kind of agent took the seat",
			now:  withSession(func() agents.Agent { a := idleAgent(testPane); a.Kind = "codex"; return a }(), "sess-one"),
			says: "now runs codex",
		},
		{
			name: "the same agent was restarted",
			now:  withSession(idleAgent(testPane), "sess-two"),
			says: "different session",
		},
		{
			name: "the pane is gone entirely",
			now:  agents.Agent{},
			says: "is gone",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.reg.setAgents(selected)
			h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
			h.selectAgent(testChat, selected)

			if tt.now.PaneID == "" {
				h.reg.setAgents()
			} else {
				h.reg.setAgents(tt.now)
			}

			if err := h.b.handleMessage(context.Background(), inbound("rm -rf the thing we discussed")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}

			assertNothingWasTyped(t, h, "a selection whose agent was replaced")
			wantContains(t, lastText(t, h), tt.says, "the refusal must say what changed")
			if _, ok := h.selected(testChat); ok {
				t.Error("the selection survived the agent it pointed at; tomorrow's first message would " +
					"land in the same seat")
			}
			if len(h.bot.cards()) == 0 {
				t.Error("no picker was posted, so the user has no one-tap way to aim again")
			}
		})
	}
}

// TestASelectionMadeBeforeASessionIdIsRefusedOnceItAppears is the narrow window
// G8 measures: an agent is detected before herdr can name its session.
//
// A recorded empty session must match ONLY a live agent that also reports none.
// Reading it as "matches anything" would turn that window into a permanent
// wildcard: select claude before SessionStart, that claude exits hours later,
// another claude takes the seat in another project, the kind still matches, and
// the next thing typed lands in the wrong agent's context.
func TestASelectionMadeBeforeASessionIdIsRefusedOnceItAppears(t *testing.T) {
	h := newHarness(t)
	unpublished := idleAgent(testPane) // no SessionRef yet
	h.reg.setAgents(unpublished)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, unpublished)

	// While it still has none, the selection works: the window is legitimate.
	if err := h.b.handleMessage(context.Background(), inbound("hello")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)

	// herdr now reports a session for that pane. We cannot tell whether it is
	// the same run, so we do not deliver.
	h.ctrl.reset()
	h.reg.setAgents(withSession(idleAgent(testPane), "sess-appeared"))

	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "a selection recorded before the session id existed")
	if _, ok := h.selected(testChat); ok {
		t.Error("the unverifiable selection was kept")
	}
}

// TestAReplyIsRefusedWhenTheAgentWasReplaced closes the same hole on the older
// half of the routing. routes.json stores one opaque string per message, so the
// identity travels inside it (see bind): a reply to a three-day-old message
// must not steer whatever occupies that pane today (G17).
func TestAReplyIsRefusedWhenTheAgentWasReplaced(t *testing.T) {
	h := newHarness(t)
	was := withSession(idleAgent(testPane), "sess-one")
	nowThere := withSession(idleAgent(testPane), "sess-two")
	other := withSession(idleAgent(secondPane), "sess-other")

	h.reg.setAgents(was, other)
	h.routes.bindAbout("om_about_w1", was)
	h.selectAgent(testChat, other)
	h.reg.setAgents(nowThere, other)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	if err := h.b.handleMessage(context.Background(), replyTo("yes, do that", "om_about_w1")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	assertNothingWasTyped(t, h, "a reply to a message about an agent that has been replaced")
	wantContains(t, lastText(t, h), "different session", "the refusal must say what changed")

	// A refused reply is about that message, not about the conversation the
	// chat is having: the selection points somewhere else and is still good.
	if got, ok := h.selected(testChat); !ok || got.Pane != secondPane {
		t.Errorf("selection = %+v, want %s left alone", got, secondPane)
	}
}

// TestALegacyRouteBindingIsNotDeliveredBlind: a routes.json written before this
// version records only the seat. There is no identity to check, so there is
// nothing to deliver against.
func TestALegacyRouteBindingIsNotDeliveredBlind(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.routes.Bind("om_from_an_older_build", testPane) // the bare pane id

	if err := h.b.handleMessage(context.Background(), replyTo("carry on", "om_from_an_older_build")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "a reply to a binding that carries no identity")
	wantContains(t, lastText(t, h), "before this version", "the refusal must explain why it cannot be honoured")
	if len(h.bot.cards()) == 0 {
		t.Error("no picker was posted")
	}
}

// TestAMessageIsBoundToTheAgentNotJustThePane: the identity has to be recorded
// on the way out or there is nothing to compare on the way back in.
func TestAMessageIsBoundToTheAgentNotJustThePane(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("/say "+testPane+" go on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	bound := h.routes.bound()
	if len(bound) != 1 {
		t.Fatalf("Bind calls = %+v, want 1", bound)
	}
	bd, ok := decodeBinding(bound[0].PaneID)
	if !ok || !bd.verified {
		t.Fatalf("binding %q does not decode as verifiable", bound[0].PaneID)
	}
	if bd.Pane != a.PaneID || bd.Kind != a.Kind || bd.Session != "sess-one" {
		t.Fatalf("binding = %+v, want pane, kind and session of %+v", bd, a)
	}
}

// TestSelectionExpiryStopsRouting: selection.TTL bounds how long a selection
// stays good WITHOUT a human re-confirming it, so that a forgotten selection
// does not silently receive tomorrow's first message.
func TestSelectionExpiryStopsRouting(t *testing.T) {
	clock := &movingClock{at: epoch}
	h := newHarness(t, func(d *Deps) { d.Now = clock.now })
	one := withSession(idleAgent(testPane), "sess-one")
	two := withSession(idleAgent(secondPane), "sess-two")
	h.reg.setAgents(one, two)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, one)

	clock.add(selection.TTL - time.Minute)
	if err := h.b.handleMessage(context.Background(), inbound("still there?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)

	clock.add(2 * time.Minute) // now past the TTL
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("and now?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "an expired selection")
	if len(h.bot.cards()) == 0 {
		t.Error("an expired selection must come back as the picker, not as silence")
	}
}

// ---------- the picker card ----------

// TestListPostsThePickerAndRemembersIt: the card is re-rendered in place as the
// selection changes, so the bridge has to know which message it is.
func TestListPostsThePickerAndRemembersIt(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a)
	h.selectAgent(testChat, a)
	before, _ := h.selected(testChat)

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 1 || sends[0].Out.Card == "" {
		t.Fatalf("/ls sent %+v, want exactly one card", sends)
	}
	after, ok := h.selected(testChat)
	if !ok {
		t.Fatal("the selection was lost by /ls")
	}
	if after.CardMessageID != sends[0].ID {
		t.Errorf("picker card id = %q, want %q; without it the card cannot be re-rendered in place",
			after.CardMessageID, sends[0].ID)
	}
	// Posting a list is not a human re-confirming a selection: restarting the
	// TTL here would let a chat that keeps running /ls hold one forever.
	if !after.SelectedAt.Equal(before.SelectedAt) {
		t.Errorf("/ls restarted the selection TTL: %v -> %v", before.SelectedAt, after.SelectedAt)
	}
	// And the card says where typing goes, which is the question it exists to
	// answer.
	wantContains(t, sends[0].Out.Card, "your typing goes to", "the picker must name the current target")
}

// TestThePickerIsNotBoundToAnyOnePane: it is about every agent, so a reply to
// it must fall through to the normal rules rather than aim at whichever row
// happened to be rendered first.
func TestThePickerIsNotBoundToAnyOnePane(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if bound := h.routes.bound(); len(bound) != 0 {
		t.Fatalf("the picker was bound for reply-routing: %+v", bound)
	}
}

// TestThePickerFallsBackToTextWhenItCannotBeDelivered: a user who cannot see
// the card still has to be able to find out what is running.
func TestThePickerFallsBackToTextWhenItCannotBeDelivered(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.bot.failNext(failing(lark.ErrFormat)) // a card cannot be downgraded in place

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("/ls reported a failure although the fallback was delivered: %v", err)
	}
	wantContains(t, lastText(t, h), testPane, "the text fallback must still list the agents")
}

// TestADegradedHerdrIsSaidAboveThePicker: the card cannot carry it — it is a
// fact about herdr, not about any agent — and a list that looks live while
// herdr is down invites a tap that will be refused (G10).
func TestADegradedHerdrIsSaidAboveThePicker(t *testing.T) {
	h := newHarness(t)
	h.reg.degraded = true
	h.reg.setAgents(idleAgent(testPane))

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	wantContains(t, lastText(t, h), "last view", "a stale snapshot must be admitted")
	if len(h.bot.cards()) != 1 {
		t.Fatalf("%d cards sent, want the picker as well as the warning", len(h.bot.cards()))
	}
}

// ---------- degraded configuration ----------

// TestNoSelectionStoreDegradesToTheOldRouting: the store is optional, and a
// bridge built without one must route exactly as it did before it existed —
// never panic on the first message.
func TestNoSelectionStoreDegradesToTheOldRouting(t *testing.T) {
	h := newHarnessWithoutSelection(t)
	one := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(one)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	// The single-agent fallback still works.
	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)

	// So does reply-to, and so does the picker.
	h.ctrl.reset()
	h.reg.setAgents(one, withSession(idleAgent(secondPane), "sess-two"))
	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if len(h.bot.cards()) != 1 {
		t.Fatalf("%d cards sent, want the picker", len(h.bot.cards()))
	}
	if err := h.b.handleMessage(context.Background(), inbound("who is there?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got := saidTo(h); len(got) != 0 {
		t.Fatalf("prose was guessed at %v with no selection and two agents", got)
	}
}

// TestWithSelectionWiresTheStore, and tolerates being handed nothing: a caller
// that could not open one must get the degraded bridge, not a panic on the
// first message.
func TestWithSelectionWiresTheStore(t *testing.T) {
	h := newHarnessWithoutSelection(t)
	if h.b.sel != nil {
		t.Fatal("a bridge built with no options has a selection store")
	}

	store, err := selection.OpenWith(t.TempDir()+"/selection.json", selection.WithAutoFlush(false))
	if err != nil {
		t.Fatalf("selection.OpenWith: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	WithSelection(store)(h.b)
	if h.b.sel != store {
		t.Fatal("WithSelection did not wire the store")
	}
	WithSelection(nil)(h.b)
	if h.b.sel != store {
		t.Fatal("WithSelection(nil) replaced a working store with nothing")
	}
}

// ---------- the identity primitives ----------

func TestIdentityComparesEveryHalfItHas(t *testing.T) {
	live := withSession(idleAgent(testPane), "sess-one")

	tests := []struct {
		name string
		id   identity
		want bool
	}{
		{"identical", identity{Kind: "claude", Session: "sess-one"}, true},
		{"another kind in the seat", identity{Kind: "codex", Session: "sess-one"}, false},
		{"another run of the same kind", identity{Kind: "claude", Session: "sess-two"}, false},
		{"no session recorded, one live", identity{Kind: "claude"}, false},
		{"nothing recorded at all", identity{}, false},
		// A session id is a strong enough identity on its own: an agent that
		// somehow reports a different cwd under the same session is still that
		// same run, and refusing it would cost a delivery for nothing.
		{"same session, another cwd", identity{Kind: "claude", Session: "sess-one", Cwd: "/elsewhere"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.id.matches(live); got != tt.want {
				t.Fatalf("%+v.matches(live) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}

	// The mirror image: an agent with no session matches only a record with
	// none, which is what makes the G8 window usable at all.
	if !identityOf(idleAgent(testPane)).matches(idleAgent(testPane)) {
		t.Error("an agent that has published no session id cannot be selected")
	}
}

// TestTwoPreSessionRunsAreToldApartByTheirDirectory closes the one hole
// kind+session cannot see (G8).
//
// herdr publishes a session ref only after claude's trust-this-directory prompt
// is accepted. Aim at claude before that, quit it, start claude again in the
// same pane in another project and leave that prompt open too: both runs report
// the same kind and no session, so the record matches a run the user never
// aimed at. Cwd is the one further thing agents.Agent carries, and comparing it
// costs at worst one tap on the picker.
func TestTwoPreSessionRunsAreToldApartByTheirDirectory(t *testing.T) {
	recorded := idleAgent(testPane) // no session yet: the trust prompt is open
	recorded.Cwd = "/project-a"

	other := idleAgent(testPane)
	other.Cwd = "/project-b" // a second run, same seat, also pre-session

	id := identityOf(recorded)
	if !id.matches(recorded) {
		t.Fatal("an agent does not match itself")
	}
	if id.matches(other) {
		t.Fatal("a message aimed at the /project-a run would be typed into the /project-b run")
	}

	err := replacedError(testPane, id, other)
	if !errors.Is(err, ErrTargetReplaced) {
		t.Fatalf("err = %v, want ErrTargetReplaced", err)
	}
	for _, want := range []string{"/project-a", "/project-b"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name %s:\n%s", want, err)
		}
	}

	// And a record with no cwd at all — a selection, whose store has no field
	// for one — refutes nothing rather than refusing everything.
	if !(identity{Kind: "claude"}).matches(other) {
		t.Error("a record that never held a cwd was treated as a mismatch")
	}
}

// TestAnOverlongSessionIdIsDroppedTheSameWayCardsDropIt keeps the two sides of
// a card press comparable. cards puts the session in the button and drops one
// that is too long; if this side kept it, that agent could never be selected
// and every message to it would be refused for a reason no reply explains.
func TestAnOverlongSessionIdIsDroppedTheSameWayCardsDropIt(t *testing.T) {
	long := withSession(idleAgent(testPane), strings.Repeat("x", maxSessionID+1))
	if got := sessionID(long); got != "" {
		t.Fatalf("sessionID = %q, want it dropped", got)
	}
	if !identityOf(long).matches(long) {
		t.Error("an agent whose session id is too long to travel in a card cannot be selected")
	}
}

func TestBindingCodecRoundTrip(t *testing.T) {
	a := withSession(idleAgent(testPane), "sess-one")
	bd, ok := decodeBinding(encodeBinding(a))
	if !ok || !bd.verified {
		t.Fatalf("decode(encode(a)) = %+v, %v", bd, ok)
	}
	if bd.Pane != a.PaneID || bd.Kind != a.Kind || bd.Session != "sess-one" {
		t.Fatalf("binding = %+v, want %+v", bd, a)
	}
	// The cwd rides along because this encoding is the bridge's own: it is the
	// only thing that separates two runs which have both still to publish a
	// session id (G8).
	if bd.Cwd != a.Cwd {
		t.Fatalf("binding cwd = %q, want %q", bd.Cwd, a.Cwd)
	}
	if got := bd.identity(); got != identityOf(a) {
		t.Fatalf("binding identity = %+v, want %+v", got, identityOf(a))
	}

	// A bare pane id from an older build: readable, but not verifiable.
	legacy, ok := decodeBinding(testPane)
	if !ok || legacy.Pane != testPane || legacy.verified {
		t.Fatalf("legacy binding = %+v, %v", legacy, ok)
	}

	for _, raw := range []string{"", "   ", "{", `{"p":""}`, `{"p":123}`} {
		if bd, ok := decodeBinding(raw); ok {
			t.Errorf("decodeBinding(%q) = %+v, want a miss", raw, bd)
		}
	}
}

func TestTargetReplacedIsItsOwnSentinel(t *testing.T) {
	// It must not be mistaken for "there is no agent": the answers differ, and
	// so does what the user has to do next.
	err := replacedError(testPane, identity{Kind: "claude", Session: "sess-one"},
		withSession(idleAgent(testPane), "sess-two"))
	if !errors.Is(err, ErrTargetReplaced) {
		t.Fatalf("err = %v, want ErrTargetReplaced", err)
	}
	if errors.Is(err, ErrNoAgent) || errors.Is(err, ErrAmbiguous) {
		t.Fatalf("err = %v also matches another routing sentinel", err)
	}
}

// TestAnUnroutableReplyDeliveredElsewhereSaysSo: the user made a gesture the
// bridge could not honour, and a delivery report that did not mention it would
// read as "your reply went where you pointed it".
func TestAnUnroutableReplyDeliveredElsewhereSaysSo(t *testing.T) {
	h := newHarness(t)
	one := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(one, withSession(idleAgent(secondPane), "sess-two"))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, one)

	if err := h.b.handleMessage(context.Background(), replyTo("go on", "om_a_mirrored_turn")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	wantContains(t, lastText(t, h), "not bound to an agent",
		"the report must say the reply could not be routed")
	wantContains(t, lastText(t, h), testPane, "the report must name where it went instead")

	// With a single agent there is nowhere else it could have gone, and the
	// note would be noise on every mirrored turn the user answers.
	h2 := newHarness(t)
	h2.reg.setAgents(one)
	h2.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	if err := h2.b.handleMessage(context.Background(), replyTo("go on", "om_a_mirrored_turn")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if strings.Contains(lastText(t, h2), "not bound to an agent") {
		t.Error("the caveat was shown where there was no other agent it could have gone to")
	}
}

// TestCardsAreNotRoutedThroughTheSelection guards the boundary the priority
// table starts at: a button press carries its own pane and must never be
// re-aimed by whatever the chat has selected (G16).
func TestCardsAreNotRoutedThroughTheSelection(t *testing.T) {
	h := newHarness(t)
	blocked := withSession(blockedAgent(), "sess-one")
	other := withSession(idleAgent(secondPane), "sess-two")
	h.reg.setAgents(blocked, other)
	h.ctrl.keyResult = blocked
	h.selectAgent(testChat, other)

	press := lark.Action{
		EventID:   "ev_press",
		MessageID: "om_card",
		ChatID:    testChat,
		Operator:  testOwner,
		Value: map[string]any{
			"act": cards.ActKey, "key": "1", "pane": blocked.PaneID, "kind": blocked.Kind,
			"seq": float64(blocked.StateSeq), "iat": float64(epoch.Unix()), "n": testNonce,
		},
	}
	if err := h.b.handleCardAction(context.Background(), press); err != nil {
		t.Fatalf("handleCardAction: %v", err)
	}

	keys := h.ctrl.sentKeys()
	if len(keys) != 1 || keys[0].Guard.PaneID != blocked.PaneID {
		t.Fatalf("keys = %+v, want one aimed at the card's own pane %s", keys, blocked.PaneID)
	}
}
