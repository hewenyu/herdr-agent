package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// This file replaces queue_test.go. That file asserted the behaviour of a
// per-pane FIFO the bridge kept in front of every working agent, and G19/M1
// measured the premise away: a working agent takes prose and queues it itself, so
// the bridge's queue only meant a user who typed three sentences watched two of
// them sit in it. What is asserted here instead is that nothing is held back, and
// that the chat says exactly as much as it has to.

// burstHarness is a bridge with one settled agent that accepts prose cleanly:
// Acked, Verified, nothing escaped, no dialog. That is the only combination the
// burst acknowledgement is allowed to cover, so every test that wants to see
// something spoken has to break one of those on purpose.
func burstHarness(t *testing.T) (*harness, *movingClock) {
	t.Helper()

	clock := &movingClock{at: epoch}
	h := newHarness(t, func(d *Deps) { d.Now = clock.now })
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{
		Acked: true, Verified: true, Attempts: 1, FinalStatus: agents.StatusWorking,
	}, nil)
	return h, clock
}

// saidTexts is what actually reached the agent, in the order it reached it.
func saidTexts(h *harness) []string {
	out := make([]string, 0, 3)
	for _, c := range h.ctrl.said() {
		out = append(out, c.Text)
	}
	return out
}

// ---------- A: nothing is queued ----------

// TestThreeMessagesInARowAllReachTheAgentInOrder is the whole point of the wave.
//
// 现在是你在阻塞消息，你要等到消息停下来才会推送给对应的 agent. Measured (G19/M1):
// `agent.prompt` to a working claude succeeds, the words land in its composer and
// are submitted when the turn ends. The bridge used to answer the second and third
// sentence with "queued (#2)" and sit on them until a transition arrived.
func TestThreeMessagesInARowAllReachTheAgentInOrder(t *testing.T) {
	for _, status := range []agents.Status{agents.StatusIdle, agents.StatusWorking} {
		t.Run(string(status), func(t *testing.T) {
			h, _ := burstHarness(t)
			a := idleAgent(testPane)
			a.Status = status
			h.reg.setAgents(a)
			if status == agents.StatusWorking {
				// What a real Say reports for a working agent: delivered into the
				// agent's OWN queue, verified inside the input box (G19, third
				// corollary).
				h.ctrl.setSay(agents.Delivery{
					Acked: true, Verified: true, Queued: true, Attempts: 1, FinalStatus: agents.StatusWorking,
				}, nil)
			}

			for _, text := range []string{"first", "second", "third"} {
				if err := h.b.handleMessage(context.Background(), inbound(text)); err != nil {
					t.Fatalf("handleMessage(%q): %v", text, err)
				}
			}

			got := saidTexts(h)
			want := []string{"first", "second", "third"}
			if len(got) != len(want) {
				t.Fatalf("%d of 3 messages reached the agent (%v); the bridge is holding messages again", len(got), got)
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("messages arrived as %v, want %v", got, want)
				}
			}
		})
	}
}

// TestNothingIsHeldBackWhenTheAgentRefusesText: ErrAgentBusy no longer means
// "try later, I will keep it". It now covers the states that genuinely cannot
// take text — a launch still finishing, a status herdr could not map, a retry
// into an agent that started working again — and the user is told at once rather
// than promised a delivery.
func TestNothingIsHeldBackWhenTheAgentRefusesText(t *testing.T) {
	h, _ := burstHarness(t)
	h.reg.setAgents(workingAgent(testPane))
	h.ctrl.setSay(agents.Delivery{FinalStatus: agents.StatusUnknown}, agents.ErrAgentBusy)

	if err := h.b.handleMessage(context.Background(), inbound("run the tests")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	if got := len(h.ctrl.said()); got != 1 {
		t.Fatalf("%d Say calls, want exactly 1: a refusal must not be retried behind the user's back", got)
	}
	reply := lastText(t, h)
	wantContains(t, reply, "could not confirm", "a refused message must be reported at once, not parked")
	wantContains(t, reply, testPane, "the refusal must name the agent it was aimed at")
	if strings.Contains(reply, "queue") {
		t.Errorf("the refusal still promises a queue that does not exist:\n%s", reply)
	}
}

// TestARefusalDoesNotClaimTheMessageWasNotSent.
//
// This assertion used to be its opposite: the reply said "nothing was sent. Send
// it again in a moment", and this test asserted the words "nothing was sent". It
// is a claim the bridge cannot support. ErrAgentBusy covers three states and one
// of them is reached AFTER a paste was written — Say's retry gate refuses an agent
// that started working again, and it is only reached because attempt 1 already
// called agent.prompt and herdr answered agent_prompt_stalled, which means "no
// state change observed", not "the text is absent" (G3). The error is one sentinel
// for all three states and deliver has no Delivery on this path, so the bridge
// cannot tell them apart.
//
// The consequence of getting this wrong is not tone. "Nothing was sent, send it
// again" invites a user to re-inject a command into a live coding agent that may
// already be holding it — the migration runs twice — which is the hazard G14
// cites to justify persistent dedup, with the bridge asking for it.
func TestARefusalDoesNotClaimTheMessageWasNotSent(t *testing.T) {
	h, _ := burstHarness(t)
	h.reg.setAgents(workingAgent(testPane))
	h.ctrl.setSay(agents.Delivery{FinalStatus: agents.StatusUnknown}, agents.ErrAgentBusy)

	if err := h.b.handleMessage(context.Background(), inbound("run the migration")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	reply := lastText(t, h)
	if strings.Contains(reply, "nothing was sent") || strings.Contains(reply, "NOT sent") {
		t.Errorf("the refusal claims a non-delivery it cannot know; an earlier attempt may have "+
			"written the text already:\n%s", reply)
	}
	wantContains(t, reply, "input box",
		"the user has to be told where their text may already be sitting, or they cannot check")
	wantContains(t, reply, "Look at the Mac",
		"the only safe next step is to look before re-sending, not to re-send")
}

// ---------- B: one acknowledgement per burst ----------

// TestABurstIsAcknowledgedOnceAndAnsweredOnceOnSettle.
//
// 最终只要 agent 停下来，你在返回消息给飞书. Three messages used to produce three
// "Delivered to X" bubbles before the agent had said anything. Now they produce
// one short line, and the substantive reply is the settle notification.
func TestABurstIsAcknowledgedOnceAndAnsweredOnceOnSettle(t *testing.T) {
	h, _ := burstHarness(t)

	for _, text := range []string{"first", "second", "third"} {
		if err := h.b.handleMessage(context.Background(), inbound(text)); err != nil {
			t.Fatalf("handleMessage(%q): %v", text, err)
		}
	}

	sends := h.bot.sends()
	if len(sends) != 1 {
		t.Fatalf("%d messages in the chat for three deliveries, want 1 acknowledgement: %+v", len(sends), sends)
	}
	wantContains(t, sends[0].Out.Text, testPane,
		"the acknowledgement must name the agent that heard them: the selection is sticky, and this is the "+
			"only place the user learns which terminal their typing reached")

	// The settle reply, which is what the notifier pushes on `done`.
	if err := h.b.PushDone(context.Background(), finishedAgent(), screen.Screen{}); err != nil {
		t.Fatalf("PushDone: %v", err)
	}
	if got := len(h.bot.sends()); got != 2 {
		t.Fatalf("%d messages after the agent settled, want the acknowledgement plus exactly one settle reply", got)
	}
}

// TestTheSettleReplyNamesTheAgentItCameFrom: with the per-message reports gone,
// the settle notification is the only thing that can tell a user WHICH of their
// agents finished — and the chat's selection is sticky, so guessing costs them a
// reply typed at the wrong terminal.
func TestTheSettleReplyNamesTheAgentItCameFrom(t *testing.T) {
	for _, tc := range []struct {
		name string
		push func(*harness) error
	}{
		{"done", func(h *harness) error {
			return h.b.PushDone(context.Background(), finishedAgent(), screen.Screen{})
		}},
		{"blocked", func(h *harness) error {
			return h.b.PushBlocked(context.Background(), blockedAgent(), permissionDialog())
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := burstHarness(t)
			if err := tc.push(h); err != nil {
				t.Fatalf("push: %v", err)
			}
			sends := h.bot.sends()
			if len(sends) != 1 {
				t.Fatalf("%d messages, want 1", len(sends))
			}
			body := sends[0].Out.Card + sends[0].Out.Text + sends[0].Out.Markdown
			for _, want := range []string{testPane, "claude"} {
				if !strings.Contains(body, want) {
					t.Errorf("the settle reply does not name %q:\n%s", want, body)
				}
			}
		})
	}
}

// TestTheNextBurstIsAcknowledgedAgain: the settle notification is the closing
// bracket of a burst. Without that, the user would hear which agent they are
// talking to once and then never again, however many separate conversations they
// had with it.
func TestTheNextBurstIsAcknowledgedAgain(t *testing.T) {
	for _, tc := range []struct {
		name string
		push func(*harness) error
	}{
		{"done", func(h *harness) error {
			return h.b.PushDone(context.Background(), finishedAgent(), screen.Screen{})
		}},
		{"blocked", func(h *harness) error {
			return h.b.PushBlocked(context.Background(), blockedAgent(), permissionDialog())
		}},
		{"gone", func(h *harness) error {
			return h.b.PushGone(context.Background(), finishedAgent())
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := burstHarness(t)

			if err := h.b.handleMessage(context.Background(), inbound("first")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			if err := h.b.handleMessage(context.Background(), inbound("second")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			if got := len(h.bot.texts()); got != 1 {
				t.Fatalf("%d acknowledgements inside one burst, want 1", got)
			}

			if err := tc.push(h); err != nil {
				t.Fatalf("push: %v", err)
			}
			// Counted from after the push, because PushGone is itself a plain-text
			// message while the other two are cards.
			before := len(h.bot.texts())
			if err := h.b.handleMessage(context.Background(), inbound("after it stopped")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}

			if got := len(h.bot.texts()); got != before+1 {
				t.Fatalf("%d plain-text messages, want %d: the settle notification must reopen the "+
					"acknowledgement", got, before+1)
			}
		})
	}
}

// TestAnAcknowledgementExpiresWithoutASettleNotification is the backstop.
//
// A settle notification can fail its retries, an agent can work for an hour, and
// a bridge can be running with no notify chat at all. Erring towards one extra
// line is deliberate: the failure mode to avoid is a chat that says nothing about
// where the user's words are going.
func TestAnAcknowledgementExpiresWithoutASettleNotification(t *testing.T) {
	h, clock := burstHarness(t)

	if err := h.b.handleMessage(context.Background(), inbound("first")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	clock.add(BusyAckCooldown - time.Second)
	if err := h.b.handleMessage(context.Background(), inbound("still inside the window")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got := len(h.bot.texts()); got != 1 {
		t.Fatalf("%d acknowledgements inside the cooldown, want 1", got)
	}

	clock.add(2 * time.Second)
	if err := h.b.handleMessage(context.Background(), inbound("long after")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got := len(h.bot.texts()); got != 2 {
		t.Fatalf("%d acknowledgements after the window expired, want 2", got)
	}

	// A clock that steps BACKWARDS — an NTP correction, which agents.validateGuard
	// guards against for the same reason — must also fall towards speaking. Reading
	// a negative age as "inside the window" would silence a pane for as long as the
	// step was wide.
	clock.add(-time.Hour)
	if err := h.b.handleMessage(context.Background(), inbound("after the clock jumped back")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got := len(h.bot.texts()); got != 3 {
		t.Fatalf("%d acknowledgements after the clock stepped backwards, want 3", got)
	}
}

// TestTheAcknowledgementIsPerPane: one agent's burst must not silence another's.
// A user driving two agents from one chat has to be told which one heard each
// thing, and that is exactly the sticky-selection hazard.
func TestTheAcknowledgementIsPerPane(t *testing.T) {
	h, _ := burstHarness(t)
	h.reg.setAgents(idleAgent(testPane), idleAgent(secondPane))

	if err := h.b.handleMessage(context.Background(), inbound("/say "+testPane+" one")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if err := h.b.handleMessage(context.Background(), inbound("/say "+secondPane+" two")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	texts := h.bot.texts()
	if len(texts) != 2 {
		t.Fatalf("%d acknowledgements for two different agents, want 2: %v", len(texts), texts)
	}
	if !strings.Contains(texts[0], testPane) || !strings.Contains(texts[1], secondPane) {
		t.Errorf("the acknowledgements do not name their own agents: %v", texts)
	}
}

// TestOneChatsAcknowledgementDoesNotSilenceAnother.
//
// The acknowledgement is spoken into the chat the message came from, while the
// settle reply that normally closes a burst only goes to Deps.NotifyChatID. Keyed
// on the pane alone, the first chat's line would cover a message typed in a
// second chat — whose author never saw that line, and who will not receive the
// settle reply either. That message would produce no visible response anywhere.
func TestOneChatsAcknowledgementDoesNotSilenceAnother(t *testing.T) {
	const otherChat = "oc_second_chat"

	h, _ := burstHarness(t)

	fromOther := func(text string) lark.Msg {
		m := inbound(text)
		m.ChatID = otherChat
		return m
	}

	if err := h.b.handleMessage(context.Background(), inbound("from the notify chat")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if err := h.b.handleMessage(context.Background(), fromOther("from the other chat")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 2 {
		t.Fatalf("%d messages for two chats talking to one agent, want one acknowledgement each: %+v",
			len(sends), sends)
	}
	if sends[0].Out.ChatID != testChat || sends[1].Out.ChatID != otherChat {
		t.Fatalf("the acknowledgements went to %q and %q, want %q and %q",
			sends[0].Out.ChatID, sends[1].Out.ChatID, testChat, otherChat)
	}

	// Within one chat the throttle still holds: this is per (chat, pane), not
	// per message.
	if err := h.b.handleMessage(context.Background(), fromOther("and again")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got := len(h.bot.sends()); got != 2 {
		t.Fatalf("%d messages after a second line in the same chat, want 2: one chat's burst is still one "+
			"acknowledgement", got)
	}

	// A settle closes the burst in every chat, not only in the one the
	// notification reaches: the chat that gets nothing has more reason to be
	// acknowledged again, not less.
	if err := h.b.PushDone(context.Background(), finishedAgent(), screen.Screen{}); err != nil {
		t.Fatalf("PushDone: %v", err)
	}
	before := len(h.bot.sends())
	if err := h.b.handleMessage(context.Background(), fromOther("after it stopped")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if got := len(h.bot.sends()); got != before+1 {
		t.Fatalf("%d messages, want %d: the settle must reopen the other chat's burst too", got, before+1)
	}
}

// TestAFailedAcknowledgementDoesNotSilenceTheMessagesBehindIt.
//
// The burst is stamped before the acknowledgement is actually sent, because check
// and stamp have to be one critical section — two messages to one agent arrive on
// two goroutines. So a Feishu write that fails has to hand the stamp back. Without
// that, one transient failure costs the user this message's acknowledgement AND
// every further message to that pane for BusyAckCooldown: they hear nothing, and
// the silence is indistinguishable from the designed silence.
func TestAFailedAcknowledgementDoesNotSilenceTheMessagesBehindIt(t *testing.T) {
	h, _ := burstHarness(t)

	// Rate-limited is the one-shot failure class: sendOne does not retry it, so
	// this is exactly one lost write.
	h.bot.failNext(failing(lark.ErrRateLimited))
	if err := h.b.handleMessage(context.Background(), inbound("first")); err == nil {
		t.Fatal("handleMessage hid a failed acknowledgement; guard() needs the error to unmark the event (G14)")
	}
	if got := len(chatReceived(h)); got != 0 {
		t.Fatalf("%d acknowledgements actually reached the chat, want 0", got)
	}

	if err := h.b.handleMessage(context.Background(), inbound("second")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	got := chatReceived(h)
	if len(got) != 1 {
		t.Fatalf("%d acknowledgements reached the chat, want 1: a failed send must not stand in for the "+
			"messages behind it", len(got))
	}
	wantContains(t, got[0], testPane, "the surviving acknowledgement must still name the agent")
}

// chatReceived is what the chat actually received: the fake records failed sends
// too, and a message the user never saw cannot be counted as one that spoke.
func chatReceived(h *harness) []string {
	out := []string{}
	for _, c := range h.bot.sends() {
		if c.Err == nil && c.Out.Text != "" {
			out = append(out, c.Out.Text)
		}
	}
	return out
}

// TestAQueuedDeliveryAcknowledgementSaysTheAgentIsMidTurn: "it will read this
// when it finishes" is a different promise from "it is reading this now", and the
// user acts on the difference (G19/M1).
func TestAQueuedDeliveryAcknowledgementSaysTheAgentIsMidTurn(t *testing.T) {
	h, _ := burstHarness(t)
	h.reg.setAgents(workingAgent(testPane))
	h.ctrl.setSay(agents.Delivery{
		Acked: true, Verified: true, Queued: true, Attempts: 1, FinalStatus: agents.StatusWorking,
	}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("also run the linter")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	wantContains(t, lastText(t, h), "mid-turn",
		"a message parked in the agent's own composer must not read as one it is acting on")
}

// ---------- B: what still speaks at once ----------

// TestAnUnprovenDeliveryIsReportedImmediatelyMidBurst is G3 against the new
// silence. agent.prompt reports success as soon as the bytes reach the PTY queue,
// and a prompt sent across a state change was measured being swallowed with no
// error at all. Folding that into "you hear from me when it stops" would leave the
// user waiting for an agent that never heard them.
func TestAnUnprovenDeliveryIsReportedImmediatelyMidBurst(t *testing.T) {
	for _, tc := range []struct {
		name string
		d    agents.Delivery
		want string
	}{
		{
			name: "acked but not verified",
			d:    agents.Delivery{Acked: true, Verified: false, FinalStatus: agents.StatusWorking},
			want: "not confirmed",
		},
		{
			name: "never acknowledged",
			d:    agents.Delivery{Acked: false, Verified: false, FinalStatus: agents.StatusIdle},
			want: "not sent",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := burstHarness(t)

			// A clean delivery first, so the burst is already open and the report
			// below has to override it rather than merely be the first thing said.
			if err := h.b.handleMessage(context.Background(), inbound("first")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			h.ctrl.setSay(tc.d, nil)
			if err := h.b.handleMessage(context.Background(), inbound("second")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}

			texts := h.bot.texts()
			if len(texts) != 2 {
				t.Fatalf("%d messages, want the acknowledgement plus an immediate report: %v", len(texts), texts)
			}
			wantContains(t, texts[1], tc.want, "an unproven send must be reported at once, not at settle time")
		})
	}
}

// TestADeliveryThatMayHaveAnsweredADialogIsReportedImmediately is the G1
// disclosure, and it is the one report that may never wait for anything.
//
// Delivering to a working agent means herdr's own Enter goes in 300ms after the
// paste, unobservable and uncancellable; if a permission dialog came up inside
// that window the Enter selected its highlighted default. A delivery flagged that
// way is verified and acked, so without this it would be swallowed by the burst
// acknowledgement — the user would never learn that their message may have
// approved something.
func TestADeliveryThatMayHaveAnsweredADialogIsReportedImmediately(t *testing.T) {
	h, _ := burstHarness(t)
	if err := h.b.handleMessage(context.Background(), inbound("first")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	h.ctrl.setSay(agents.Delivery{
		Acked: true, Verified: true, Queued: true, MayHaveAnsweredADialog: true,
		FinalStatus: agents.StatusBlocked,
	}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("no, do not do that")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	texts := h.bot.texts()
	if len(texts) != 2 {
		t.Fatalf("%d messages, want the acknowledgement plus the dialog disclosure: %v", len(texts), texts)
	}
	wantContains(t, texts[1], "may have ANSWERED",
		"a delivery that may have answered a permission dialog must say so, in those terms")
	wantContains(t, texts[1], "Check the Mac", "the disclosure must tell the user what to do about it")
}

// TestARetriedDeliveryIsReportedImmediatelyMidBurst.
//
// A retried delivery can be VERIFIED and still be a duplicate. herdr answers
// agent_prompt_stalled when it sees no state change in its window, which is not
// proof the text is absent (G3): a paste sitting in a composer the agent has not
// consumed changes no state at all. So attempt 2 reads the input box, finds the
// first copy, prepends the newline that keeps them apart (G19/M2) and pastes
// again — and herdr's Enter submits "run the deploy\nrun the deploy" as one
// prompt, which reads back cleanly as {Acked, Verified, Attempts: 2}.
//
// The separator only keeps the duplicate legible on the AGENT'S screen, and that
// is the one screen the person on the phone cannot see. So the retry count is the
// only thing that makes a doubled instruction diagnosable from the chat, and it
// must not be foldable into an acknowledgement that never mentions attempts.
func TestARetriedDeliveryIsReportedImmediatelyMidBurst(t *testing.T) {
	h, _ := burstHarness(t)

	// A clean delivery first, so the burst is open and this has to speak over it.
	if err := h.b.handleMessage(context.Background(), inbound("first")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	h.ctrl.setSay(agents.Delivery{
		Acked: true, Verified: true, Attempts: 2, FinalStatus: agents.StatusWorking,
	}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("run the deploy")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	texts := h.bot.texts()
	if len(texts) != 2 {
		t.Fatalf("%d messages, want the acknowledgement plus a report of the retry: %v", len(texts), texts)
	}
	wantContains(t, texts[1], "2 attempts",
		"a retried delivery must disclose the retry; it is the only sign the agent may hold the message twice")
	wantContains(t, texts[1], "more than once",
		"the retry count has to be spelled out as a possible duplicate, not left as plumbing trivia")
}

// TestAnEscapedDeliveryIsReportedImmediately: the user's message dismissed a
// dialog they never asked to dismiss (G1, G2). That is a side effect of typing,
// and it cannot wait for the agent to stop.
func TestAnEscapedDeliveryIsReportedImmediately(t *testing.T) {
	h, _ := burstHarness(t)
	if err := h.b.handleMessage(context.Background(), inbound("first")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	h.ctrl.setSay(agents.Delivery{
		Acked: true, Verified: true, Escaped: true, FinalStatus: agents.StatusWorking,
	}, nil)

	if err := h.b.handleMessage(context.Background(), inbound("do it differently")); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}

	texts := h.bot.texts()
	if len(texts) != 2 {
		t.Fatalf("%d messages, want the acknowledgement plus the esc report: %v", len(texts), texts)
	}
	wantContains(t, texts[1], "esc", "cancelling a pending dialog must be reported when it happens")
}

// ---------- C: errors still speak immediately ----------

// TestEveryDeliveryErrorSpeaksImmediately. Only the success chatter moved to
// settle time; a failure means the agent will never stop on account of this
// message, so nothing else is coming.
func TestEveryDeliveryErrorSpeaksImmediately(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want string
	}{
		{"still blocked after esc", agents.ErrCannotUnblock, "NOT sent"},
		{"a dialog was on screen", agents.ErrDialogOnScreen, "NOT sent"},
		{"pane gone", agents.ErrPaneGone, "gone"},
		{"agent replaced", agents.ErrAgentReplaced, "different agent"},
		{"guard stale", agents.ErrGuardStale, "too old"},
		{"cannot take text", agents.ErrAgentBusy, "could not confirm"},
		{"anything else", errors.New("herdr socket closed"), "herdr socket closed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := burstHarness(t)
			// Burst already open: an error must speak over it.
			if err := h.b.handleMessage(context.Background(), inbound("first")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}
			err := tc.err
			if errors.Is(err, agents.ErrDialogOnScreen) {
				// Say wraps both sentinels for this one, because the user-facing
				// consequence is the same: there is a dialog to answer and the
				// message was not sent.
				err = errors.Join(agents.ErrDialogOnScreen, agents.ErrCannotUnblock)
			}
			h.ctrl.setSay(agents.Delivery{FinalStatus: agents.StatusBlocked}, err)

			if err := h.b.handleMessage(context.Background(), inbound("second")); err != nil {
				t.Fatalf("handleMessage: %v", err)
			}

			texts := h.bot.texts()
			if len(texts) != 2 {
				t.Fatalf("%d messages, want the acknowledgement plus an immediate failure report: %v", len(texts), texts)
			}
			wantContains(t, texts[1], tc.want, "a failed delivery must be explained when it fails")
		})
	}
}

// TestWithoutANotifyChatEveryDeliveryIsStillReported.
//
// The silence between deliveries is only affordable because something speaks when
// the agent stops, and that something is the notifier pushing into
// Deps.NotifyChatID. With none configured the Push* methods answer
// ErrNoNotifyTarget, so a folded acknowledgement would be the last the user ever
// heard about their message.
func TestWithoutANotifyChatEveryDeliveryIsStillReported(t *testing.T) {
	h := newHarness(t, func(d *Deps) { d.NotifyChatID = "" })
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{
		Acked: true, Verified: true, Attempts: 1, FinalStatus: agents.StatusWorking,
	}, nil)

	for _, text := range []string{"first", "second", "third"} {
		if err := h.b.handleMessage(context.Background(), inbound(text)); err != nil {
			t.Fatalf("handleMessage(%q): %v", text, err)
		}
	}

	texts := h.bot.texts()
	if len(texts) != 3 {
		t.Fatalf("%d reports for three deliveries with no notify chat, want 3: %v", len(texts), texts)
	}
	for _, got := range texts {
		wantContains(t, got, "Delivered", "with nothing to speak at settle time, every delivery must report")
	}
}

// TestARoutedElsewhereDeliveryIsNeverFoldedIntoABurst: a routing note means the
// message did NOT go where the user pointed it. Folding that into "your typing is
// getting through" would be a message delivered somewhere they did not aim.
func TestARoutedElsewhereDeliveryIsNeverFoldedIntoABurst(t *testing.T) {
	h, _ := burstHarness(t)
	one := withSession(idleAgent(testPane), "sess-one")
	h.reg.setAgents(one, withSession(idleAgent(secondPane), "sess-two"))
	h.selectAgent(testChat, one)

	// Two messages, both replying to something the bridge cannot route, so both
	// carry the note that says where they went instead.
	for i := 0; i < 2; i++ {
		if err := h.b.handleMessage(context.Background(), replyTo("go on", "om_a_mirrored_turn")); err != nil {
			t.Fatalf("handleMessage: %v", err)
		}
	}

	texts := h.bot.texts()
	if len(texts) != 2 {
		t.Fatalf("%d messages, want one per misrouted delivery: %v", len(texts), texts)
	}
	for _, got := range texts {
		wantContains(t, got, "not bound to an agent", "each misrouted delivery must explain itself")
		wantContains(t, got, testPane, "each misrouted delivery must name where it went instead")
	}
}
