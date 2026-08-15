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

// TestASelectionIsRefusedWhenAnotherProgramTookTheWindow is the one hazard the
// identity check still exists to close.
//
// A herdr pane id is never reused (see identity.matches for the source), so a
// window the user anchored stays that window. What a window DOES outlive is the
// agent inside it: quit claude in w1:p1, run codex there, and the id is
// unchanged while the program is not. Routing on the id alone would put the next
// thing typed into a different context, and text typed at an agent sitting on a
// permission dialog answers that dialog (G1).
//
// What must NOT happen is the selection being dropped. The user did not close
// anything; refusing the delivery is the whole of the answer, and clearing on
// top of it is how a chat with one agent running ends up silently delivering the
// NEXT message to the stranger via the single-agent fallback.
func TestASelectionIsRefusedWhenAnotherProgramTookTheWindow(t *testing.T) {
	h := newHarness(t)
	selected := withSession(idleAgent(testPane), "sess-one")
	selected.Cwd = "/project-a"
	h.reg.setAgents(selected)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, selected)

	tookOver := withSession(idleAgent(testPane), "sess-one")
	tookOver.Kind = "codex"
	tookOver.Cwd = "/project-a"
	h.reg.setAgents(tookOver)

	if err := h.b.handleMessage(context.Background(), inbound("rm -rf the thing we discussed")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	assertNothingWasTyped(t, h, "a selection whose window now runs something else")
	wantContains(t, lastText(t, h), "now runs codex", "the refusal must say what changed")
	wantContains(t, lastText(t, h), "/close", "the refusal must name the one way out")

	got, ok := h.selected(testChat)
	if !ok {
		t.Fatal("the selection was dropped by a refusal the user did not ask for")
	}
	if got.Pane != testPane {
		t.Fatalf("selection = %s, want it left at %s", got.Pane, testPane)
	}

	// ...and the NEXT message must not be delivered either, even though exactly
	// one agent is running. A chat that still has a selection never reaches the
	// single-agent fallback.
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("and this one")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "the message after a refused selection")
}

// TestAWindowRestartedOnAnotherJobIsReportedNotRefused is the deliberate half of
// anchoring a window.
//
// Quit claude in w1:p1, cd to another project, start claude again there. The
// window is the thing the user anchored and it has not moved, so the message is
// delivered — but a new session id together with a new directory is the one
// shape that means "this window was restarted on a different job", and that is
// worth a sentence before someone types into it.
//
// The pairing is what makes it quiet enough to be worth having: AgentInfo.cwd
// can fall back to foreground_cwd, which follows a Bash tool call into a
// subdirectory, and a tool call does not mint a session id.
func TestAWindowRestartedOnAnotherJobIsReportedNotRefused(t *testing.T) {
	h := newHarness(t)
	was := withSession(idleAgent(testPane), "sess-one")
	was.Cwd = "/project-a"
	h.reg.setAgents(was)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, was)

	moved := withSession(idleAgent(testPane), "sess-two")
	moved.Cwd = "/project-b"
	h.reg.setAgents(moved)

	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	for _, want := range []string{"/project-a", "/project-b", "/close"} {
		wantContains(t, lastText(t, h), want, "the note must say where it moved and how to get out")
	}

	// Once, not on every message: the new directory was recorded when it was
	// said.
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("and again")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	if strings.Contains(lastText(t, h), "/project-a") {
		t.Error("the moved note was repeated on the next message")
	}
}

// TestABashToolCallDoesNotDisturbTheAim is the measurement that took the cwd out
// of the comparison.
//
// herdr's AgentInfo.cwd falls back to foreground_cwd, and foreground_cwd
// deliberately looks for a foreground process-group member whose cwd DIFFERS
// from the shell's (src/pane.rs:278-295) — exactly what claude produces while it
// runs a Bash tool call in a subdirectory. Comparing it refused messages in the
// middle of a task, for a directory the user never chose.
func TestABashToolCallDoesNotDisturbTheAim(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	a.Cwd = "/project-a"
	h.reg.setAgents(a)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
	h.selectAgent(testChat, a)

	// Same agent, same session — herdr is simply reporting the cwd of the
	// subprocess it is running right now.
	working := withSession(idleAgent(testPane), "sess-one")
	working.Cwd = "/project-a/vendor/somewhere"
	h.reg.setAgents(working)

	if err := h.b.handleMessage(context.Background(), inbound("stop, use the other file")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	if strings.Contains(lastText(t, h), "vendor") {
		t.Error("a tool call's working directory was reported as the agent moving jobs")
	}
}

// TestASelectionSurvivesTheAgentGoingAway: the ordinary rhythm of working is
// that you finish something, quit claude, and start it again. None of that is
// the user saying they are done talking to it.
func TestASelectionSurvivesTheAgentGoingAway(t *testing.T) {
	h := newHarness(t)
	one := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(one)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, one)

	h.reg.setAgents() // the pane closed, or the agent exited
	if err := h.b.handleMessage(context.Background(), inbound("still there?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "a selection whose agent is not running")
	wantContains(t, lastText(t, h), "still aimed", "the refusal must say the aim is unchanged")
	if _, ok := h.selected(testChat); !ok {
		t.Fatal("the selection was dropped because the agent was briefly not there")
	}

	// Started again in the same seat, on the same job, with a brand new session
	// id — and the conversation simply resumes.
	h.reg.setAgents(withSession(idleAgent(testPane), "sess-restarted"))
	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
}

// TestASelectionSurvivesANewSessionAndSaysSo: claude mints a new session id on
// every /clear and every compaction. Holding a conversational target to that
// ended the conversation several times a day, for an agent that never moved.
//
// It is delivered, because "the claude in ~/project" is still true — and the
// user is told once, because the agent no longer remembers what they discussed.
func TestASelectionSurvivesANewSessionAndSaysSo(t *testing.T) {
	h := newHarness(t)
	one := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(one)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, one)

	h.reg.setAgents(withSession(idleAgent(testPane), "sess-two")) // a /clear
	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	wantContains(t, lastText(t, h), "NEW conversation", "the user must be told the agent forgot")

	// Once, not on every message: the fact was recorded when it was said.
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("and again")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	if strings.Contains(lastText(t, h), "NEW conversation") {
		t.Error("the restart note was repeated on the next message")
	}
}

// TestASelectionMadeBeforeASessionIdKeepsWorking is the narrow window G8
// measures: an agent is detected before herdr can name its session.
//
// claude publishes a session id only after SessionStart, which for a new
// directory is only after the trust prompt is accepted. Tapping Select in that
// window used to record an empty session, and the moment herdr published one
// the comparison failed and the selection was dropped — for an agent the user
// was actively working with, seconds after they picked it.
func TestASelectionMadeBeforeASessionIdKeepsWorking(t *testing.T) {
	h := newHarness(t)
	unpublished := idleAgent(testPane) // no SessionRef yet
	h.reg.setAgents(unpublished)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, unpublished)

	if err := h.b.handleMessage(context.Background(), inbound("hello")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)

	// herdr now reports a session for that pane. Same seat, same kind, same
	// directory: same agent.
	h.ctrl.reset()
	h.reg.setAgents(withSession(idleAgent(testPane), "sess-appeared"))

	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	if _, ok := h.selected(testChat); !ok {
		t.Error("the selection was dropped the moment herdr published a session id")
	}
}

// TestAReplyIsRefusedWhenTheAgentWasReplaced closes the same hole on the older
// half of the routing. routes.json stores one opaque string per message, so the
// identity travels inside it (see bind): a reply to a three-day-old message
// must not steer whatever occupies that pane today (G17).
func TestAReplyIsRefusedWhenTheAgentWasReplaced(t *testing.T) {
	h := newHarness(t)
	was := withSession(idleAgent(testPane), "sess-one")
	was.Cwd = "/project-a"
	nowThere := withSession(idleAgent(testPane), "sess-two")
	nowThere.Kind = "codex" // the window outlived the agent that was in it
	nowThere.Cwd = "/project-a"
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
	wantContains(t, lastText(t, h), "now runs codex", "the refusal must say what changed")

	// A refused reply is about that message, not about the conversation the
	// chat is having: the selection points somewhere else and is still good.
	if got, ok := h.selected(testChat); !ok || got.Pane != secondPane {
		t.Errorf("selection = %+v, want %s left alone", got, secondPane)
	}
	// And it must not put the chooser back in front of a user who already has
	// somewhere to type — the reply says where that is.
	wantContains(t, lastText(t, h), secondPane, "the refusal must name where typing still goes")
	if len(h.bot.cards()) != 0 {
		t.Error("a picker was posted although the chat is still aimed at a live agent")
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

// TestASelectionDoesNotExpireButItsAgeIsSaid is the retraction of the 12h TTL.
//
// The TTL's stated purpose was that a forgotten selection must not silently
// receive tomorrow's first message. The word doing the work there is SILENTLY,
// and dropping the selection was a poor answer to it: the user got no delivery,
// no explanation and a picker card, several times a week, for a conversation
// they had not finished. Now the message is delivered AND the age is said —
// once per quiet period, so a chat in daily use never sees it at all.
func TestASelectionDoesNotExpireButItsAgeIsSaid(t *testing.T) {
	clock := &movingClock{at: epoch}
	h := newHarness(t, func(d *Deps) { d.Now = clock.now })
	one := withSession(idleAgent(testPane), "sess-one")
	two := withSession(idleAgent(secondPane), "sess-two")
	h.reg.setAgents(one, two)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, one)

	clock.add(selection.StaleAfter - time.Minute)
	if err := h.b.handleMessage(context.Background(), inbound("still there?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	if strings.Contains(lastText(t, h), "still aimed there") {
		t.Error("a selection inside the quiet window was reported as old")
	}

	// Days later — and it still routes, because nothing but the user ends it.
	clock.add(3 * 24 * time.Hour)
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("and now?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	wantContains(t, lastText(t, h), "still aimed there", "an old selection must say how old it is")
	wantContains(t, lastText(t, h), "/close", "the reminder must name the way out")

	// And the reminder is not repeated on the next message.
	clock.add(time.Minute)
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("one more")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)
	if strings.Contains(lastText(t, h), "still aimed there") {
		t.Error("the age reminder was repeated on the very next message")
	}
}

// TestALegacySelectionLearnsItsDirectory is the upgrade path.
//
// selection.Target grew a Cwd field so a refusal can NAME what the chat is
// aimed at when no live agent is there to read one off, and so a restart in
// another directory can be reported. It is never compared. A selection.json
// written by the previous build carries none; the first delivery that resolves
// cleanly writes it back.
func TestALegacySelectionLearnsItsDirectory(t *testing.T) {
	h := newHarness(t)
	a := withSession(idleAgent(testPane), "sess-one")
	a.Cwd = "/project-a"
	h.reg.setAgents(a)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	// Exactly what the previous build stored: pane, kind, session, no cwd.
	h.sel.Set(testChat, selection.Target{
		Pane:       a.PaneID,
		Kind:       a.Kind,
		Session:    sessionID(a),
		SelectedAt: h.b.now(),
	})

	if err := h.b.handleMessage(context.Background(), inbound("carry on")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, testPane)

	got, ok := h.selected(testChat)
	if !ok {
		t.Fatal("a selection written by the previous build was refused")
	}
	if got.Cwd != "/project-a" {
		t.Fatalf("stored cwd = %q, want it learned from the live agent", got.Cwd)
	}

	// And now the label a refusal prints can name it, which is what the field is
	// for: with the agent gone there is nothing live left to read.
	h.reg.setAgents()
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("and this")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "a selection whose agent is not running")
	wantContains(t, lastText(t, h), "project-a", "the refusal must name what the chat is still aimed at")
}

// TestNothingButTheUserRetiresASelection is the rule stated once, over every
// route that used to drop one. Each step is a thing that ended the conversation
// before this wave; none of them may now.
func TestNothingButTheUserRetiresASelection(t *testing.T) {
	clock := &movingClock{at: epoch}
	h := newHarness(t, func(d *Deps) { d.Now = clock.now })
	a := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(a, withSession(idleAgent(secondPane), "sess-two"))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, a)

	steps := []struct {
		name string
		do   func()
	}{
		{"a /clear inside the agent", func() {
			h.reg.setAgents(withSession(idleAgent(testPane), "sess-new"), withSession(idleAgent(secondPane), "sess-two"))
		}},
		{"the agent exiting", func() { h.reg.setAgents(withSession(idleAgent(secondPane), "sess-two")) }},
		{"it coming back", func() {
			h.reg.setAgents(withSession(idleAgent(testPane), "sess-back"), withSession(idleAgent(secondPane), "sess-two"))
		}},
		{"a week passing", func() { clock.add(7 * 24 * time.Hour) }},
		{"running /ls", func() {
			if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
				t.Fatalf("/ls: %v", err)
			}
		}},
		{"a codex taking the OTHER seat", func() {
			other := withSession(idleAgent(secondPane), "sess-two")
			other.Kind = "codex"
			h.reg.setAgents(withSession(idleAgent(testPane), "sess-back"), other)
		}},
	}
	for _, s := range steps {
		s.do()
		if err := h.b.handleMessage(context.Background(), inbound("still here")); err != nil {
			t.Fatalf("after %s: %v", s.name, err)
		}
		if _, ok := h.selected(testChat); !ok {
			t.Fatalf("%s retired the selection; only /close may do that", s.name)
		}
	}

	// And then the one thing that does.
	if err := h.b.handleMessage(context.Background(), inbound("/close")); err != nil {
		t.Fatalf("/close: %v", err)
	}
	if got, ok := h.selected(testChat); ok {
		t.Fatalf("selection = %+v, want /close to have retired it", got)
	}
}

// ---------- /close ----------

// TestCloseIsTheOnlyWayOut states the contract the picker now rests on: one
// deliberate act opens the channel, one deliberate act closes it, and there is
// exactly one answer to "why am I being asked to pick again?"
func TestCloseIsTheOnlyWayOut(t *testing.T) {
	h := newHarness(t)
	one := withSession(idleAgent(testPane), "sess-one")
	two := withSession(idleAgent(secondPane), "sess-two")
	h.reg.setAgents(one, two)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, one)

	if err := h.b.handleMessage(context.Background(), inbound("/close")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got, ok := h.selected(testChat); ok {
		t.Fatalf("selection = %+v, want it closed", got)
	}
	if len(h.bot.cards()) == 0 {
		t.Error("/close must hand the user the picker; that is the point of closing")
	}

	// And plain text no longer reaches anyone: two agents are running and the
	// bridge must not guess which one the user meant.
	h.ctrl.reset()
	if err := h.b.handleMessage(context.Background(), inbound("hello?")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	assertNothingWasTyped(t, h, "prose after /close")
}

// /close on a chat that was not aimed anywhere is not an error: the user asked
// to be handed the chooser, and that is what they get.
func TestCloseWithNothingSelected(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(withSession(idleAgent(testPane), "sess-one"))

	if err := h.b.handleMessage(context.Background(), inbound("/close")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	wantContains(t, lastText(t, h), "nothing to close", "the reply must say there was nothing aimed")
	if len(h.bot.cards()) == 0 {
		t.Error("no picker was posted")
	}
}

// The card left in the chat says "your typing goes to X". After /close that is
// a lie, and Feishu messages never expire (G17), so it is repainted where it
// stands rather than left behind for someone to scroll back to.
func TestCloseRepaintsTheCardItLeavesBehind(t *testing.T) {
	h := newHarness(t)
	one := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(one)
	h.selectAgent(testChat, one)

	if err := h.b.handleMessage(context.Background(), inbound("/ls")); err != nil {
		t.Fatalf("/ls: %v", err)
	}
	posted := h.bot.sends()
	if len(posted) != 1 {
		t.Fatalf("sends = %+v, want the picker", posted)
	}
	card := posted[0].ID

	if err := h.b.handleMessage(context.Background(), inbound("/close")); err != nil {
		t.Fatalf("/close: %v", err)
	}

	updates := h.bot.cardUpdates()
	if len(updates) == 0 {
		t.Fatal("the picker card was not repainted, so it still claims a target this chat gave up")
	}
	last := updates[len(updates)-1]
	if last.MessageID != card {
		t.Fatalf("repainted %q, want the picker card %q", last.MessageID, card)
	}
	if strings.Contains(last.Card, "your typing goes to") {
		t.Errorf("the repainted card still claims a target:\n%s", last.Card)
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
	// Posting a list is not a human re-confirming a selection: moving that stamp
	// would silence the age reminder for every chat that runs /ls now and then.
	if !after.SelectedAt.Equal(before.SelectedAt) {
		t.Errorf("/ls restamped the selection: %v -> %v", before.SelectedAt, after.SelectedAt)
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

// TestIdentityIsTheWindowPlusTheProgram: what a person picks is a window, and
// herdr pane ids are not recycled, so the id IS the identity. The only thing
// left to check is that the same PROGRAM is still in it.
//
// Neither of the other two fields survives contact with how herdr reports them.
// The session id is absent until claude's trust prompt is accepted (G8) and
// brand new after every /clear and compaction. The cwd is equal across two
// different agents on a live machine — w2:p1 codex and w2:p2 claude both report
// /Users/yueban/code/yuebanhome — and it follows a Bash tool call into a
// subdirectory. Both are carried for reporting; neither is a test.
func TestIdentityIsTheWindowPlusTheProgram(t *testing.T) {
	live := withSession(idleAgent(testPane), "sess-one")
	live.Cwd = "/project-a"

	tests := []struct {
		name string
		id   identity
		want bool
	}{
		{"identical", identity{Kind: "claude", Session: "sess-one", Cwd: "/project-a"}, true},
		{"another program in the window", identity{Kind: "codex", Session: "sess-one", Cwd: "/project-a"}, false},
		// The /clear, the compaction, the restart in place.
		{"a new session in the same window", identity{Kind: "claude", Session: "sess-two", Cwd: "/project-a"}, true},
		{"recorded before a session existed", identity{Kind: "claude", Cwd: "/project-a"}, true},
		// A Bash tool call running in a subdirectory, or a restart on another
		// job: delivered either way, and the second is reported (restartNote).
		{"another directory", identity{Kind: "claude", Session: "sess-one", Cwd: "/elsewhere"}, true},
		{"nothing recorded at all", identity{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.id.matches(live); got != tt.want {
				t.Fatalf("%+v.matches(live) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}

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
func TestTwoAgentsAreToldApartByTheirWindow(t *testing.T) {
	// The live machine this was measured on: two agents, two windows, ONE
	// directory. Neither the cwd nor (for codex, whose hook is untrusted) the
	// session id separates them; the pane does, and herdr does not recycle pane
	// ids, so it always will.
	one := idleAgent(testPane)
	one.Cwd = "/Users/yueban/code/yuebanhome"
	two := idleAgent(secondPane)
	two.Cwd = "/Users/yueban/code/yuebanhome"

	if one.Cwd != two.Cwd {
		t.Fatal("this test is meaningless unless both agents share a directory")
	}
	if identityOf(one).Cwd != identityOf(two).Cwd {
		t.Fatal("the recorded identities differ on a field that cannot separate them")
	}

	// Two claudes in one project is an ordinary way to work — planning in one
	// window, implementing in the other — and for those the kind matches too.
	// Routing is keyed on the pane, so they never collide.
	h := newHarness(t)
	h.reg.setAgents(one, two)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)
	h.selectAgent(testChat, two)

	if err := h.b.handleMessage(context.Background(), inbound("you, the second one")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	delivered(t, h, secondPane)

	// And the one thing that does end it: a different program in that window.
	took := idleAgent(secondPane)
	took.Kind = "codex"
	took.Cwd = two.Cwd
	err := replacedError(secondPane, identityOf(two), took)
	if !errors.Is(err, ErrTargetReplaced) {
		t.Fatalf("err = %v, want ErrTargetReplaced", err)
	}
	for _, want := range []string{"claude", "codex", secondPane} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name %s:\n%s", want, err)
		}
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
