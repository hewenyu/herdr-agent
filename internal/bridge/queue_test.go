package bridge

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// queueHarness is a bridge whose clock the test steps by hand, with one agent
// that is working: the state in which S1's Say refuses prose and S2 has to
// decide what to do with it (S2 §3.5.1).
func queueHarness(t *testing.T, limit int) (*harness, *movingClock) {
	t.Helper()

	clock := &movingClock{at: epoch}
	h := newHarness(t, func(d *Deps) {
		d.QueueLimit = limit
		d.Now = clock.now
	})
	h.reg.setAgents(workingAgent(testPane))
	h.ctrl.setSay(agents.Delivery{FinalStatus: agents.StatusWorking}, agents.ErrAgentBusy)
	h.ex.dialog = permissionDialog()
	return h, clock
}

// send delivers one inbound message through the dispatcher.
func sendText(t *testing.T, h *harness, text string) {
	t.Helper()
	if err := h.b.handleMessage(context.Background(), inbound(text)); err != nil {
		t.Fatalf("handleMessage(%q): %v", text, err)
	}
}

// park queues messages for the busy agent and then forgets the Say calls that
// came back ErrAgentBusy, so what follows is asserted about the drain alone.
func park(t *testing.T, h *harness, texts ...string) {
	t.Helper()
	for _, text := range texts {
		sendText(t, h, text)
	}
	h.ctrl.reset()
}

// settle makes the registry report the agent as idle and delivers the
// transition the queue drains on.
func settle(t *testing.T, h *harness, status agents.Status) {
	t.Helper()

	a := workingAgent(testPane)
	a.Status = status
	a.StateSeq++
	h.reg.setAgents(a)
	h.b.onTransition(context.Background(), agents.Transition{
		Agent: a,
		From:  agents.StatusWorking,
		To:    status,
		Seq:   a.StateSeq,
	})
}

// TestProseForABusyAgentIsQueuedNotDropped.
func TestProseForABusyAgentIsQueuedNotDropped(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)

	sendText(t, h, "run the tests when you are done")

	if got := h.b.queue.depth(testPane); got != 1 {
		t.Fatalf("queue depth = %d, want 1", got)
	}
	reply := lastText(t, h)
	wantContains(t, reply, "queued", "the user must know their message is waiting, not sent")
	wantContains(t, reply, "memory", "the receipt must admit the queue does not survive a restart")
}

// TestQueuedReceiptsAreThrottledPerPane: one buzz per cooldown. A phone that
// vibrates for every line typed at a busy agent gets muted, and a muted phone
// misses the card that says an agent is waiting for a human.
func TestQueuedReceiptsAreThrottledPerPane(t *testing.T) {
	h, clock := queueHarness(t, DefaultQueueLimit)

	sendText(t, h, "first")
	sendText(t, h, "second")
	sendText(t, h, "third")

	if got := len(h.bot.sends()); got != 1 {
		t.Fatalf("%d receipts for three queued messages, want 1", got)
	}
	if got := h.b.queue.depth(testPane); got != 3 {
		t.Fatalf("queue depth = %d, want 3: throttling the receipt must not drop the message", got)
	}

	clock.add(BusyAckCooldown + time.Second)
	sendText(t, h, "fourth")

	if got := len(h.bot.sends()); got != 2 {
		t.Fatalf("%d receipts after the cooldown expired, want 2", got)
	}
}

// TestQueueRefusesOverTheCap: five deep, then say so. Silently dropping the
// sixth would leave the user waiting for a delivery that is never coming.
func TestQueueRefusesOverTheCap(t *testing.T) {
	h, _ := queueHarness(t, 2)

	sendText(t, h, "first")
	sendText(t, h, "second")
	sendText(t, h, "third")

	if got := h.b.queue.depth(testPane); got != 2 {
		t.Fatalf("queue depth = %d, want the limit of 2", got)
	}
	reply := lastText(t, h)
	wantContains(t, reply, "NOT queued", "a refused message must be described as refused")
	wantContains(t, reply, "/stop", "the refusal must offer the way out")
}

// TestQueueRefusalIsNeverThrottled: the receipt may be suppressed, the refusal
// may not — they say opposite things about whether the message will be sent.
func TestQueueRefusalIsNeverThrottled(t *testing.T) {
	h, _ := queueHarness(t, 1)

	sendText(t, h, "first")  // queued, receipt
	sendText(t, h, "second") // refused
	sendText(t, h, "third")  // refused again, inside the cooldown

	sends := h.bot.sends()
	if len(sends) != 3 {
		t.Fatalf("%d messages, want a receipt and two refusals", len(sends))
	}
	for _, s := range sends[1:] {
		if !strings.Contains(s.Out.Text, "NOT queued") {
			t.Errorf("a refusal was suppressed or reworded: %q", s.Out.Text)
		}
	}
}

// TestQueueDrainsInOrderWhenTheAgentSettles is acceptance item 11's middle
// clause: the agent goes idle and the queued messages go out, oldest first.
func TestQueueDrainsInOrderWhenTheAgentSettles(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "first", "second")

	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
	settle(t, h, agents.StatusIdle)

	said := h.ctrl.said()
	if len(said) != 2 {
		t.Fatalf("%d Say calls after settling, want the two queued messages", len(said))
	}
	if said[0].Text != "first" || said[1].Text != "second" {
		t.Fatalf("delivered out of order: %q then %q", said[0].Text, said[1].Text)
	}
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d after draining, want 0", got)
	}

	// The report has to say which message it is about: it arrives long after
	// the user typed it, under whatever they said most recently.
	wantContains(t, lastText(t, h), "queued earlier", "a late delivery report must name what it refers to")
}

// TestQueueDrainsOnDoneAsWellAsIdle. `done` is idle-that-the-desktop-UI has not
// looked at; it is the same agent condition (G11) and prose is just as
// deliverable there.
func TestQueueDrainsOnDoneAsWellAsIdle(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")

	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
	settle(t, h, agents.StatusDone)

	if got := h.ctrl.said(); len(got) != 1 {
		t.Fatalf("%d Say calls, want the queued message delivered on `done`", len(got))
	}
}

// TestQueuedProseIsNotDeliveredToABlockedAgent is the veto item of this file.
//
// The queued sentence was written against a screen the agent has since left. If
// it went back to waiting for an answer in the meantime, delivering that
// sentence pastes text at a menu — which discards it — and then presses Enter
// on the highlighted default. Measured (G1): a written refusal delivered that
// way CREATED the file it was refusing. So nothing is typed, the queue stays
// put, and the user gets the dialog to decide against.
func TestQueuedProseIsNotDeliveredToABlockedAgent(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "no, do something else instead")

	// A delivery would succeed if it were attempted, so a queue that stayed
	// silent here would be indistinguishable from one that delivered.
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
	before := len(h.bot.sends())
	settle(t, h, agents.StatusBlocked)

	assertNothingWasTyped(t, h, "a queue draining into a blocked agent")
	if got := h.b.queue.depth(testPane); got != 1 {
		t.Fatalf("queue depth = %d, want the message still waiting", got)
	}

	if got := len(h.bot.cards()); got != 1 {
		t.Fatalf("%d cards pushed, want one so the user can decide again", got)
	}
	var note string
	for _, s := range h.bot.sends()[before:] {
		if s.Out.Text != "" {
			note = s.Out.Text
		}
	}
	wantContains(t, note, "NOT sent", "the user must be told their queued message was held back")
	wantContains(t, note, "still queued", "the user must be told it is still waiting")
}

// TestTheBlockedNoticeIsThrottled: an agent that blocks repeatedly must not
// turn one queued message into a stream of identical cards.
func TestTheBlockedNoticeIsThrottled(t *testing.T) {
	h, clock := queueHarness(t, DefaultQueueLimit)
	park(t, h, "hold on")

	settle(t, h, agents.StatusBlocked)
	first := len(h.bot.cards())
	settle(t, h, agents.StatusBlocked)

	if got := len(h.bot.cards()); got != first {
		t.Fatalf("%d cards, want no second one inside the cooldown", got)
	}

	clock.add(BusyAckCooldown + time.Second)
	settle(t, h, agents.StatusBlocked)
	if got := len(h.bot.cards()); got != first+1 {
		t.Fatalf("%d cards after the cooldown, want another one", got)
	}
}

// TestQueueSurvivesABlockAndDrainsAfterwards: holding the message back is not
// dropping it. Once the dialog is answered and the agent settles, it goes.
func TestQueueSurvivesABlockAndDrainsAfterwards(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "and then run the tests")

	settle(t, h, agents.StatusBlocked)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
	settle(t, h, agents.StatusIdle)

	said := h.ctrl.said()
	if len(said) != 1 || said[0].Text != "and then run the tests" {
		t.Fatalf("Say calls = %+v, want the parked message delivered once the agent settled", said)
	}
}

// TestANewMessageDoesNotJumpTheQueue: FIFO is a promise about order, and the
// direct path would deliver the user's second thought before their first.
func TestANewMessageDoesNotJumpTheQueue(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "first")

	// The agent is idle now, so without the queue check this one would be sent
	// immediately, ahead of the message already waiting.
	a := idleAgent(testPane)
	h.reg.setAgents(a)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
	sendText(t, h, "second")

	if got := h.ctrl.said(); len(got) != 0 {
		t.Fatalf("a message jumped the queue: %+v", got)
	}
	if got := h.b.queue.depth(testPane); got != 2 {
		t.Fatalf("queue depth = %d, want both messages queued in order", got)
	}
}

// TestQueueIsDroppedWhenThePaneDisappears: a message addressed to a pane that
// no longer exists can only ever be typed into a stranger.
func TestQueueIsDroppedWhenThePaneDisappears(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")

	h.b.onTransition(context.Background(), agents.Transition{
		Agent: agents.Agent{PaneID: testPane, Status: agents.StatusGone},
		From:  agents.StatusWorking,
		To:    agents.StatusGone,
	})

	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d after the pane disappeared, want 0", got)
	}
	assertNothingWasTyped(t, h, "a pane that disappeared")
}

// TestDrainTellsTheUserWhenTheAgentVanishedUnderIt covers the pane that is gone
// by the time the drain looks, without a Gone transition having arrived.
func TestDrainTellsTheUserWhenTheAgentVanishedUnderIt(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")
	h.reg.setAgents() // herdr no longer knows the pane

	h.b.drainPane(context.Background(), testPane)

	assertNothingWasTyped(t, h, "a pane herdr no longer knows")
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d, want the parked message dropped", got)
	}
	wantContains(t, lastText(t, h), "never sent", "the user must be told the message will not arrive")
}

// TestADrainThatFindsTheAgentBusyKeepsItsOrder: Say can lose the race with a
// new task starting, and the message must go back where it was.
func TestADrainThatFindsTheAgentBusyKeepsItsOrder(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "first", "second")

	// Idle by the registry, busy by the time the prompt lands.
	h.reg.setAgents(idleAgent(testPane))
	h.b.drainPane(context.Background(), testPane)

	if got := h.b.queue.depth(testPane); got != 2 {
		t.Fatalf("queue depth = %d, want both messages still queued", got)
	}
	front, _ := h.b.queue.front(testPane)
	if front.Text != "first" {
		t.Fatalf("front of the queue = %q, want the oldest message", front.Text)
	}
}

// TestADrainStopsAtTheFirstFailure: a Say that failed may already have sent
// esc, so hammering the rest of the queue at it would keep dismissing dialogs
// on the user's behalf.
func TestADrainStopsAtTheFirstFailure(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "first", "second")

	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{FinalStatus: agents.StatusBlocked}, agents.ErrCannotUnblock)
	h.b.drainPane(context.Background(), testPane)

	if got := len(h.ctrl.said()); got != 1 {
		t.Fatalf("%d Say calls, want the drain to stop after the first failure", got)
	}
	if got := h.b.queue.depth(testPane); got != 1 {
		t.Fatalf("queue depth = %d, want the undelivered remainder kept", got)
	}
	wantContains(t, lastText(t, h), "NOT sent", "the failure must be reported against the queued message")
}

// TestOnlyOneDrainRunsPerPane: two drains would put two prompts in flight at
// the same TUI.
func TestOnlyOneDrainRunsPerPane(t *testing.T) {
	q := newProseQueue()
	if !q.claimDrain(testPane) {
		t.Fatal("the first claim was refused")
	}
	if q.claimDrain(testPane) {
		t.Fatal("a second drain claimed the same pane")
	}
	q.releaseDrain(testPane)
	if !q.claimDrain(testPane) {
		t.Fatal("the claim was not released")
	}
}

// TestQueueIsPerPane: one busy agent must not park another's messages.
func TestQueueIsPerPane(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	h.reg.setAgents(workingAgent(testPane), idleAgent(secondPane))
	h.routes.Bind("om_about_w2", secondPane)

	sendText(t, h, "/say "+testPane+" wait for me")

	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
	sendText(t, h, "/say "+secondPane+" go ahead")

	if got := h.b.queue.depth(testPane); got != 1 {
		t.Fatalf("busy pane queue depth = %d, want 1", got)
	}
	if got := h.b.queue.depth(secondPane); got != 0 {
		t.Fatalf("idle pane queue depth = %d, want 0", got)
	}
	said := h.ctrl.said()
	if len(said) != 2 {
		// The first Say is the one that came back ErrAgentBusy.
		t.Fatalf("%d Say calls, want the busy attempt and the idle delivery", len(said))
	}
	if said[1].Guard.PaneID != secondPane {
		t.Fatalf("the second message went to %s, want %s", said[1].Guard.PaneID, secondPane)
	}
}

// TestATransitionForAnEmptyQueueDoesNothing keeps the common case cheap: most
// transitions belong to panes nobody is queued behind.
func TestATransitionForAnEmptyQueueDoesNothing(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	h.reg.setAgents(idleAgent(testPane))

	settle(t, h, agents.StatusIdle)

	assertNothingWasTyped(t, h, "a transition with nothing queued")
	if got := len(h.bot.sends()); got != 0 {
		t.Fatalf("%d messages sent for an empty queue, want 0", got)
	}
}

// ---------- the sweep ----------

// TestASweepDeliversAQueueNoTransitionCameBackFor closes the window between
// "Say said busy" and "the message reached the queue".
//
// The registry can publish working→idle in exactly that window: the drain it
// triggers sees depth 0 and returns, the message lands a moment later, and an
// agent that now sits idle publishes nothing further. Without the sweep the
// message waits forever behind a receipt that promised delivery "when it
// settles" — silently, apart from the ⏳ line in /ls.
func TestASweepDeliversAQueueNoTransitionCameBackFor(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")

	// The agent settled while the message was still on its way into the queue,
	// so the transition for it has already been and gone.
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)

	h.b.sweepQueues(context.Background())

	said := h.ctrl.said()
	if len(said) != 1 || said[0].Text != "carry on" {
		t.Fatalf("Say calls = %+v, want the stranded message delivered by the sweep", said)
	}
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d after the sweep, want it emptied", got)
	}
}

// TestASweepLeavesAnUnsettledAgentAlone.
//
// The sweep is a liveness backstop, not a second scheduler. A blocked agent
// must not be swept, because drainPane answers one by pushing its dialog as a
// card: repeating that on every sweep would put a card in the chat every 30
// seconds for as long as the user leaves the dialog open, which is how a phone
// gets muted — and a muted phone misses the card that matters. A working agent
// is left alone for the plainer reason that its transition is still coming.
func TestASweepLeavesAnUnsettledAgentAlone(t *testing.T) {
	tests := []struct {
		name  string
		agent agents.Agent
	}{
		{"waiting at a dialog", blockedAgent()},
		{"still working", workingAgent(testPane)},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := queueHarness(t, DefaultQueueLimit)
			park(t, h, "carry on")
			h.reg.setAgents(tc.agent)
			// A delivery would succeed if one were attempted, so silence here
			// cannot be mistaken for a Say that failed.
			h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)
			before := len(h.bot.sends())

			h.b.sweepQueues(context.Background())

			assertNothingWasTyped(t, h, "a sweep over an agent that is not settled")
			if got := h.b.queue.depth(testPane); got != 1 {
				t.Fatalf("queue depth = %d, want the message still waiting for its transition", got)
			}
			if got := len(h.bot.sends()) - before; got != 0 {
				t.Fatalf("%d messages sent by the sweep, want none: the transition path owns this case", got)
			}
		})
	}
}

// TestASweepResolvesAQueueWhosePaneDisappeared covers the other way a queue is
// stranded: the Gone transition that should have dropped it never arrived,
// because a subscriber that falls behind loses transitions rather than stalling
// the poller. The user is told once — dropping deletes the pane's queue, so a
// later sweep finds nothing to repeat.
func TestASweepResolvesAQueueWhosePaneDisappeared(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")
	h.reg.setAgents() // herdr answered, and the pane was not in the list

	h.b.sweepQueues(context.Background())

	assertNothingWasTyped(t, h, "a sweep over a pane that disappeared")
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d, want the messages dropped with the pane", got)
	}
	wantContains(t, lastText(t, h), "gone", "the user must be told their queued message will never be sent")

	before := len(h.bot.sends())
	h.b.sweepQueues(context.Background())
	if got := len(h.bot.sends()) - before; got != 0 {
		t.Fatalf("a second sweep said it again %d time(s); the notice must not repeat", got)
	}
}

// TestWatchQueuesSweepsOnItsTicker proves the backstop is actually wired to the
// loop, not merely implemented.
func TestWatchQueuesSweepsOnItsTicker(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")

	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)

	ticks := make(chan time.Time, 1)
	stopped := false
	h.b.newTicker = func(d time.Duration) (<-chan time.Time, func()) {
		if d != queueSweep {
			t.Errorf("watchQueues ticks every %s, want %s", d, queueSweep)
		}
		return ticks, func() { stopped = true }
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); h.b.watchQueues(ctx) }()

	ticks <- epoch.Add(queueSweep)
	waitForSays(t, h, 1)

	cancel()
	<-done
	if !stopped {
		t.Error("watchQueues left its ticker running")
	}
}

// waitForSays blocks until the controller has been asked to deliver n messages.
// The drain runs on another goroutine, so this is a deadlock guard rather than
// pacing: nothing here waits for time to pass.
func waitForSays(t *testing.T, h *harness, n int) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if got := h.ctrl.said(); len(got) >= n {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("%d messages delivered, want %d", len(h.ctrl.said()), n)
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

// TestWatchQueuesStopsWithTheContext: Run waits on this goroutine.
func TestWatchQueuesStopsWithTheContext(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); h.b.watchQueues(ctx) }()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("watchQueues ignored the cancelled context")
	}
}

// TestWatchQueuesDrainsWhatItReceives proves the loop is wired to the same
// transitions the notifier sees, not just that onTransition works.
func TestWatchQueuesDrainsWhatItReceives(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")

	a := idleAgent(testPane)
	h.reg.setAgents(a)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusWorking}, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); h.b.watchQueues(ctx) }()

	h.reg.ch <- agents.Transition{Agent: a, From: agents.StatusWorking, To: agents.StatusIdle, Seq: a.StateSeq}

	waitForSays(t, h, 1)
	cancel()
	<-done
}

// ---------- the queue is aimed at an agent, not at a seat ----------

// TestQueuedProseIsNotDeliveredToTheAgentThatReplacedIts is the identity
// re-check on the delivery path that outlives its target longest (G8, G17).
//
// A pane id is a seat. Prose parked behind a working claude and drained into
// the codex that took that seat is a message typed into a context the user
// never aimed at — and it needs no exotic timing to happen: herdr reporting a
// different kind in the same pane produces a kind-change transition and no Gone
// at all, which is what this test replays.
func TestQueuedProseIsNotDeliveredToTheAgentThatReplacedIt(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "keep going with the refactor")

	// The seat changes hands, and the drain is driven by the transition that
	// announces the newcomer rather than by a Gone for the agent that left.
	newcomer := idleAgent(testPane)
	newcomer.Kind = "codex"
	newcomer.StateSeq++
	h.reg.setAgents(newcomer)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	h.b.onTransition(context.Background(), agents.Transition{
		Agent: newcomer,
		From:  agents.StatusWorking,
		To:    agents.StatusIdle,
		Seq:   newcomer.StateSeq,
	})

	assertNothingWasTyped(t, h, "a queue whose agent was replaced")
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d, want the parked message dropped rather than delivered", got)
	}

	text := lastText(t, h)
	wantContains(t, text, "now runs codex", "the user must be told what took the seat")
	wantContains(t, text, "dropped", "the user must be told the sentence they typed is not coming")
}

// TestQueuedProseIsNotDeliveredToAnotherRunOfTheSameAgent: the same hazard with
// nothing visible changed. claude exits, claude starts again in the same pane —
// same kind, new conversation — and the sentence was written for the old one.
func TestQueuedProseIsNotDeliveredToAnotherRunOfTheSameAgent(t *testing.T) {
	h, clock := queueHarness(t, DefaultQueueLimit)
	h.reg.setAgents(withSession(workingAgent(testPane), "sess-one"))
	park(t, h, "yes, delete that file")

	restarted := withSession(idleAgent(testPane), "sess-two")
	h.reg.setAgents(restarted)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	// Through the sweep this time: the transition path is not the only way in.
	clock.add(queueSweep)
	h.b.sweepQueues(context.Background())

	assertNothingWasTyped(t, h, "a queue whose agent was restarted")
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d, want the parked message dropped", got)
	}
	wantContains(t, lastText(t, h), "different session",
		"the user must be told it is a different run of the same agent")
}

// TestAReplacedQueueIsReportedOncePerChat: the whole queue goes, because its
// order was promised against one agent's screen, and each chat hears about it
// once with a count rather than once per message.
func TestAReplacedQueueIsReportedOncePerChat(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "first", "second", "third")

	newcomer := idleAgent(testPane)
	newcomer.Kind = "codex"
	h.reg.setAgents(newcomer)
	before := len(h.bot.sends())

	h.b.drainPane(context.Background(), testPane)

	if got := len(h.bot.sends()) - before; got != 1 {
		t.Fatalf("%d messages about the dropped queue, want exactly one for the chat", got)
	}
	wantContains(t, lastText(t, h), "3 messages you queued",
		"the notice must say how much was thrown away")
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d, want the whole queue dropped", got)
	}
}

// TestAQueueParkedBeforeASessionIdIsRefusedWhenOneAppears holds the queue to
// the same rule as every other remembered destination (see
// TestASelectionMadeBeforeASessionIdIsRefusedOnceItAppears).
//
// herdr publishes a session ref only after a trust prompt is accepted (G8), so
// a message can be parked for an agent that has none and drained against one
// that does. That is EITHER the same run further along or a different run that
// was trusted quickly, and nothing here can tell the two apart — so it is
// refused. It costs the user a retype; delivering blind would cost them a
// sentence typed into another project's agent.
func TestAQueueParkedBeforeASessionIdIsRefusedWhenOneAppears(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")

	published := withSession(idleAgent(testPane), "sess-late")
	h.reg.setAgents(published)
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	h.b.drainPane(context.Background(), testPane)

	assertNothingWasTyped(t, h, "a queue parked before a session id existed")
	if got := h.b.queue.depth(testPane); got != 0 {
		t.Fatalf("queue depth = %d, want the message dropped rather than delivered blind", got)
	}
	wantContains(t, lastText(t, h), "cannot tell whether it is still the same run",
		"the user must be told why their message was not sent")
}

// TestAQueueStillDrainsWhileNothingHasPublishedASession is the complement: the
// check must not fire on an agent that has not changed at all. Most agents sit
// in this state for the first seconds of their life (G8), and a queue that
// refused them would be a queue that never delivered.
func TestAQueueStillDrainsWhileNothingHasPublishedASession(t *testing.T) {
	h, _ := queueHarness(t, DefaultQueueLimit)
	park(t, h, "carry on")

	h.reg.setAgents(idleAgent(testPane)) // same kind, same cwd, still no session
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, FinalStatus: agents.StatusIdle}, nil)

	h.b.drainPane(context.Background(), testPane)

	if got := h.ctrl.said(); len(got) != 1 || got[0].Text != "carry on" {
		t.Fatalf("Say calls = %+v, want the queued message delivered to the run it was written for", got)
	}
}
