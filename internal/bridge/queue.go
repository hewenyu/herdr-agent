package bridge

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// queuedProse is one message parked for an agent that was working when it
// arrived.
//
// It remembers where it came from, not just what it said: the delivery report
// has to land next to the message the user actually typed, which may be many
// minutes and several other notifications ago.
type queuedProse struct {
	Text    string
	ChatID  string
	ReplyTo string
	At      time.Time

	// For is the agent this sentence was written for, recorded when it was
	// parked and re-checked when it is drained.
	//
	// Without it the queue would be the one delivery path that routes on the
	// seat alone: the FIFO is keyed by pane id, and the drain re-resolves that
	// pane from the registry, so the guard handed to Controller.Say would be
	// built from whoever is sitting there NOW. A queue that was parked behind
	// claude and drained into the codex that replaced it is exactly the delivery
	// this wave exists to refuse (G8, G17) — and it needs no exotic timing: a
	// kind change reported on a single poll produces a transition and no Gone,
	// and a Gone can be dropped outright when a subscriber falls behind.
	For identity
}

// paneQueue is the FIFO for one pane plus the two throttles that keep it from
// becoming a notification source of its own.
type paneQueue struct {
	items []queuedProse

	// lastReceipt is when the user was last told "queued" for this pane.
	lastReceipt time.Time
	// lastBlockedNote is when the user was last told that the queue could not
	// drain because the agent went back to waiting for an answer.
	lastBlockedNote time.Time

	// draining is held for as long as a drain is in flight for this pane. It
	// keeps a second drain out, and it also makes the inbound path queue rather
	// than send: a message that took the direct path while the drainer was
	// mid-Say would be a second prompt racing the first into the same TUI.
	draining bool
}

// proseQueue holds parked prose for every pane.
//
// Deliberately in memory (S2 §3.5.1). Persisting it would mean replaying, after
// a restart, sentences written against a screen that no longer exists — which
// is the same mistake as delivering a queued line to an agent that has since
// blocked (G1), only with hours instead of seconds in between. The user is told
// as much on the receipt, because a promise the bridge silently drops is worse
// than one it never made.
type proseQueue struct {
	mu    sync.Mutex
	panes map[string]*paneQueue
}

func newProseQueue() *proseQueue {
	return &proseQueue{panes: map[string]*paneQueue{}}
}

// get returns the queue for paneID, creating it on first use. Callers hold mu.
func (q *proseQueue) get(paneID string) *paneQueue {
	pq, ok := q.panes[paneID]
	if !ok {
		pq = &paneQueue{}
		q.panes[paneID] = pq
	}
	return pq
}

// push parks one message.
//
// depth is the item's 1-based position in the queue. receipt reports whether
// the caller should tell the user, and is true at most once per cooldown per
// pane: a phone that buzzes for every line the user types at a busy agent is a
// phone that gets muted, and a muted phone misses the card that says an agent
// is waiting for a human.
func (q *proseQueue) push(paneID string, item queuedProse, limit int, now time.Time, cooldown time.Duration) (depth int, receipt bool, err error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq := q.get(paneID)
	if len(pq.items) >= limit {
		// Refused, not dropped silently. The caller says so; a message the user
		// believes is on its way is the failure mode to avoid.
		return len(pq.items), false, fmt.Errorf("%w: %s holds %d", ErrQueueFull, paneID, len(pq.items))
	}
	pq.items = append(pq.items, item)

	if pq.lastReceipt.IsZero() || now.Sub(pq.lastReceipt) >= cooldown {
		pq.lastReceipt = now
		receipt = true
	}
	return len(pq.items), receipt, nil
}

// front returns the next message without removing it.
func (q *proseQueue) front(paneID string) (queuedProse, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq, ok := q.panes[paneID]
	if !ok || len(pq.items) == 0 {
		return queuedProse{}, false
	}
	return pq.items[0], true
}

// pop removes and returns the next message.
func (q *proseQueue) pop(paneID string) (queuedProse, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq, ok := q.panes[paneID]
	if !ok || len(pq.items) == 0 {
		return queuedProse{}, false
	}
	item := pq.items[0]
	pq.items = pq.items[1:]
	return item, true
}

// unpop puts a message back at the head, for the case where the agent turned
// out not to be ready after all. The user was promised an order; losing it
// would deliver their second thought before their first.
func (q *proseQueue) unpop(paneID string, item queuedProse) {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq := q.get(paneID)
	pq.items = append([]queuedProse{item}, pq.items...)
}

// waiting lists the panes that still hold at least one message, sorted so a
// sweep behaves the same way twice.
func (q *proseQueue) waiting() []string {
	q.mu.Lock()
	defer q.mu.Unlock()

	var panes []string
	for paneID, pq := range q.panes {
		if len(pq.items) > 0 {
			panes = append(panes, paneID)
		}
	}
	slices.Sort(panes)
	return panes
}

// depth is how many messages are parked for paneID.
func (q *proseQueue) depth(paneID string) int {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq, ok := q.panes[paneID]
	if !ok {
		return 0
	}
	return len(pq.items)
}

// pending reports whether the inbound path must queue instead of sending:
// either something is already waiting, or a drain is in flight for this pane.
func (q *proseQueue) pending(paneID string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq, ok := q.panes[paneID]
	if !ok {
		return false
	}
	return len(pq.items) > 0 || pq.draining
}

// drop discards everything parked for a pane and returns it, so the caller can
// say how much was lost.
func (q *proseQueue) drop(paneID string) []queuedProse {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq, ok := q.panes[paneID]
	if !ok {
		return nil
	}
	items := pq.items
	delete(q.panes, paneID)
	return items
}

// claimDrain takes the per-pane drain lock, reporting false when another drain
// already holds it.
func (q *proseQueue) claimDrain(paneID string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq := q.get(paneID)
	if pq.draining {
		return false
	}
	pq.draining = true
	return true
}

func (q *proseQueue) releaseDrain(paneID string) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if pq, ok := q.panes[paneID]; ok {
		pq.draining = false
	}
}

// blockedNoteDue reports whether the "your queued message was not sent" notice
// may be repeated for this pane yet.
func (q *proseQueue) blockedNoteDue(paneID string, now time.Time, cooldown time.Duration) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	pq := q.get(paneID)
	if !pq.lastBlockedNote.IsZero() && now.Sub(pq.lastBlockedNote) < cooldown {
		return false
	}
	pq.lastBlockedNote = now
	return true
}

// ---------- the bridge side ----------

// enqueue parks prose for a busy agent and answers the user.
func (b *bridge) enqueue(ctx context.Context, chatID, replyTo string, a agents.Agent, text string) error {
	// The identity comes from the agent the caller resolved, which is the one the
	// user was aiming at when they typed.
	item := queuedProse{Text: text, ChatID: chatID, ReplyTo: replyTo, At: b.now(), For: identityOf(a)}

	depth, receipt, err := b.queue.push(a.PaneID, item, b.deps.QueueLimit, b.now(), BusyAckCooldown)
	if err != nil {
		if !errors.Is(err, ErrQueueFull) {
			return err
		}
		b.log.Warn("bridge: refused prose for a full queue", "pane", a.PaneID, "depth", depth)
		// Always answered, never throttled: this one says the message was NOT
		// taken, and a user who does not hear it will wait for a delivery that
		// is never coming.
		return b.say(ctx, chatID, replyTo, a.PaneID, fmt.Sprintf(
			"🚫 %s already has %d messages waiting, which is the limit — this one was NOT queued and NOT sent. "+
				"Wait for it to catch up, or /stop %s to interrupt what it is doing.",
			agentLabel(a), depth, a.PaneID))
	}

	if !receipt {
		// Silently queued. The last receipt is recent enough that the user
		// already knows this agent is busy.
		b.log.Info("bridge: queued prose without a receipt", "pane", a.PaneID, "depth", depth)
		return nil
	}
	return b.say(ctx, chatID, replyTo, a.PaneID, fmt.Sprintf(
		"⏳ %s is working, so your message is queued (#%d) and goes out when it settles. "+
			"Further messages in the next %s are queued without another receipt. "+
			"The queue lives in memory only: if the bridge restarts, anything still waiting is dropped.",
		agentLabel(a), depth, BusyAckCooldown))
}

// queueSweep is how often a non-empty queue is looked at even though no
// transition arrived for it.
//
// A transition is the normal trigger, and it is enough almost always. It is not
// enough in one window: Controller.Say can return ErrAgentBusy, the agent can
// settle and publish its working→idle transition, and only then does the
// message reach the queue. The sweep that transition caused saw depth 0, and an
// agent that now sits idle produces no further transition to catch up on — so
// the message would wait forever behind a receipt that promised it goes out
// "when it settles". Microseconds wide against a 1s poll, permanent when it
// hits, and silent apart from the ⏳ line in /ls.
const queueSweep = 30 * time.Second

// watchQueues drains parked prose as agents settle.
//
// It takes its own subscription: the registry hands every subscriber a separate
// channel, so this one sees exactly what the notifier sees rather than stealing
// transitions from it. Transitions and sweeps are both handled inline on this
// goroutine, which serialises the drains — one Say at a time across all panes —
// and that is the point: two prompts in flight at once are two prompts that can
// interleave in a TUI.
func (b *bridge) watchQueues(ctx context.Context) {
	transitions := b.deps.Registry.Subscribe()

	tick, stop := b.newTicker(queueSweep)
	defer stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick:
			b.sweepQueues(ctx)
		case t, ok := <-transitions:
			if !ok {
				// The registry stopped. Nothing will settle again.
				return
			}
			b.onTransition(ctx, t)
		}
	}
}

// sweepQueues is the liveness backstop for a queue no transition came back for.
//
// It acts on two states and skips everything else:
//
//   - settled (idle or done) — the stranded case above: deliver.
//   - herdr no longer reports the pane — its Gone transition never arrived (a
//     subscriber that falls behind loses transitions rather than stalling the
//     poller). drainPane drops the queue and says so, once, because dropping
//     deletes the pane's entry entirely. This is not a false positive during a
//     degraded registry: a failed poll deliberately keeps the last view instead
//     of reconciling against "no agents" (agents/registry.go), so Get still
//     answers while herdr is wedged behind a modal dialog (G10).
//
// Blocked and working panes are deliberately left to the transition path.
// drainPane answers a blocked agent by pushing its dialog as a card rather than
// delivering, and repeating that on every sweep would put a card in the chat
// every 30 seconds for as long as the user leaves the dialog open — which is
// how a phone gets muted, and a muted phone misses the card that matters.
func (b *bridge) sweepQueues(ctx context.Context) {
	for _, paneID := range b.queue.waiting() {
		if ctx.Err() != nil {
			return
		}
		if a, ok := b.deps.Registry.Get(paneID); ok && !a.Status.Settled() {
			continue
		}
		if !b.queue.claimDrain(paneID) {
			continue
		}
		b.log.Info("bridge: a queued message outlived its transition; draining it on the sweep",
			"pane", paneID, "depth", b.queue.depth(paneID))
		b.drainPane(ctx, paneID)
		b.queue.releaseDrain(paneID)
	}
}

// onTransition reacts to one registry transition on behalf of the queue.
func (b *bridge) onTransition(ctx context.Context, t agents.Transition) {
	paneID := t.Agent.PaneID
	if paneID == "" {
		return
	}

	if t.To == agents.StatusGone {
		// The pane is gone, so is anything addressed to it. PushGone already
		// tells the user that whatever was queued has been dropped, so this
		// only has to make that true.
		if dropped := b.queue.drop(paneID); len(dropped) > 0 {
			b.log.Warn("bridge: dropped queued prose for a pane that disappeared",
				"pane", paneID, "dropped", len(dropped))
		}
		return
	}

	if b.queue.depth(paneID) == 0 {
		return
	}
	// Every other status goes through drainPane, including blocked: it re-reads
	// the agent, so the decision to deliver or not is made against what herdr
	// says now rather than against a transition that has been sitting in a
	// channel.
	if !b.queue.claimDrain(paneID) {
		return
	}
	defer b.queue.releaseDrain(paneID)
	b.drainPane(ctx, paneID)
}

// drainPane delivers parked prose for one pane, one message at a time.
//
// The refusal in the middle is the reason this function exists. A queued line
// was written against a screen the agent has since left; if it went back to
// waiting for an answer while the message sat here, delivering it now would
// paste text at a menu and press Enter on the highlighted option — measured to
// approve the very command the text was refusing (G1). So the queue stays put
// and the user gets the dialog to answer instead.
func (b *bridge) drainPane(ctx context.Context, paneID string) {
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		item, ok := b.queue.front(paneID)
		if !ok {
			return
		}

		a, ok := b.deps.Registry.Get(paneID)
		if !ok {
			dropped := b.queue.drop(paneID)
			b.log.Warn("bridge: dropped queued prose; herdr no longer knows this pane",
				"pane", paneID, "dropped", len(dropped))
			b.tellQueueDropped(ctx, paneID, dropped)
			return
		}

		// The identity re-check every other remembered destination gets, applied
		// where the destination was remembered longest ago. The guard below is
		// built from `a`, so nothing further down can notice that the seat
		// changed hands: Controller.Say would validate the replacement against
		// itself and type into it (G8, G17).
		//
		// The whole queue goes, not just the head. Its order was promised against
		// one agent's screen, and the pane is now a different context — there is
		// nothing left in it that was aimed where it would land.
		if !item.For.matches(a) {
			cause := replacedError(paneID, item.For, a)
			dropped := b.queue.drop(paneID)
			b.log.Warn("bridge: dropped queued prose written for an agent that has been replaced",
				"pane", paneID, "dropped", len(dropped), "err", cause)
			b.tellQueueReplaced(ctx, dropped, cause)
			return
		}

		switch {
		case a.Status == agents.StatusBlocked:
			b.blockedInsteadOfDelivering(ctx, a)
			return
		case !a.Status.Settled():
			// Still working, or a status we cannot reason about. The next
			// transition brings us back.
			return
		}

		item, ok = b.queue.pop(paneID)
		if !ok {
			return
		}

		d, err := b.deps.Controller.Say(ctx, b.guardFor(a), item.Text)
		if errors.Is(err, agents.ErrAgentBusy) {
			// It started working between the poll and the prompt. Put it back
			// at the head so the order the user was promised survives, and wait
			// for the next transition rather than spinning.
			b.queue.unpop(paneID, item)
			return
		}
		if err != nil {
			// Reported once, to the message it belongs to, and not retried: a
			// failed Say may already have sent esc, so repeating it would keep
			// dismissing dialogs on the user's behalf.
			b.log.Error("bridge: queued prose was not delivered", "pane", paneID, "err", err)
			b.report(ctx, item, paneID, queuedPrefix+b.deliveryFailed(a, err))
			return
		}
		b.report(ctx, item, paneID, queuedPrefix+deliveryNote(a, d))
	}
}

// queuedPrefix marks a report that belongs to a message the user sent a while
// ago. Without it, a delivery note arriving minutes later reads like an echo of
// whatever they typed most recently.
const queuedPrefix = "📤 (the message you queued earlier)\n"

// blockedInsteadOfDelivering pushes the dialog the agent is now showing and
// leaves the queue where it is.
//
// The card goes to the chat the queued message came from, as a reply to it, so
// the question and the sentence it displaced sit together. The notifier may
// push its own card for the same dialog into the notify chat; a second card is
// noise, while a missing one is an agent waiting forever for a human who
// believes their message was already sent.
func (b *bridge) blockedInsteadOfDelivering(ctx context.Context, a agents.Agent) {
	item, ok := b.queue.front(a.PaneID)
	if !ok {
		return
	}
	if !b.queue.blockedNoteDue(a.PaneID, b.now(), BusyAckCooldown) {
		b.log.Info("bridge: queue is still parked behind a dialog; notice throttled", "pane", a.PaneID)
		return
	}

	dialog, err := b.deps.Extractor.Dialog(a.PaneID)
	if err != nil {
		// Say what is known anyway. BuildBlocked degrades to Esc plus an
		// instruction when it has no options to offer, and an empty screen is
		// still better than silence about an agent that needs a human.
		b.log.Error("bridge: could not read the dialog that parked a queue", "pane", a.PaneID, "err", err)
	}
	if err := b.pushBlockedTo(ctx, cardTarget{ChatID: item.ChatID, ReplyTo: item.ReplyTo}, a, dialog); err != nil {
		b.log.Error("bridge: could not push the card that replaces a queued message", "pane", a.PaneID, "err", err)
	}

	depth := b.queue.depth(a.PaneID)
	b.report(ctx, item, a.PaneID, fmt.Sprintf(
		"⏸ %s is waiting for an answer again, so the %s NOT sent — text typed at an open dialog "+
			"answers that dialog instead of being read, which is how a refusal becomes an approval. "+
			"It is still queued: answer the card above (or /stop %s) and it goes out once the agent settles.",
		agentLabel(a), plural(depth, "message you queued was", "messages you queued were"), a.PaneID))
}

// tellQueueDropped reports prose that will never be delivered because its pane
// disappeared under the drain.
//
// The ordinary disappearance is announced by PushGone, which already says that
// anything queued was dropped. This covers the case where the drain outlived
// that notice, or never saw it — a subscriber that falls behind loses
// transitions rather than stalling the poller — and it answers in the chat the
// messages were written in rather than in the notify chat.
func (b *bridge) tellQueueDropped(ctx context.Context, paneID string, dropped []queuedProse) {
	b.tellQueueLost(ctx, dropped, func(n int) string {
		return fmt.Sprintf("👋 %s is gone — the pane was closed or the agent exited — so the %s never sent.",
			paneID, plural(n, "message you queued for it was", "messages you queued for it were"))
	})
}

// tellQueueReplaced reports prose that was thrown away rather than typed into
// the agent that took over the pane it was parked for.
//
// It reads like routeProse's refusal because it is the same refusal, arriving
// late: the destination was remembered, it stopped being that destination, and
// nothing was delivered. The user is told which sentence died with the agent it
// was written for, rather than discovering it in another agent's terminal.
func (b *bridge) tellQueueReplaced(ctx context.Context, dropped []queuedProse, cause error) {
	b.tellQueueLost(ctx, dropped, func(n int) string {
		return fmt.Sprintf("🔄 %v.\n\n%s dropped rather than delivered: it was written for the agent "+
			"that was there then, and typing it at the one there now would put it in a context you never "+
			"aimed at. Run /ls, tap **Select**, and send it again.",
			cause, plural(n, "message you queued for that pane was", "messages you queued for that pane were"))
	})
}

// tellQueueLost says, once per chat, that parked prose will never be delivered.
//
// One notice per chat rather than per message: the count is the information, and
// five identical bubbles is not five times as useful. Every notice is
// deliberately unbound (PaneID ""): whatever is in that pane is not what these
// messages were aimed at, so a reply to this notice must fall through to the
// normal routing rules rather than point back at it.
func (b *bridge) tellQueueLost(ctx context.Context, dropped []queuedProse, line func(n int) string) {
	seen := map[string]bool{}
	for _, item := range dropped {
		if seen[item.ChatID] {
			continue
		}
		seen[item.ChatID] = true

		n := 0
		for _, other := range dropped {
			if other.ChatID == item.ChatID {
				n++
			}
		}
		b.report(ctx, item, "", line(n))
	}
}

// report delivers one message about a queued item, in the thread it came from.
//
// Nothing upstream of here can act on a failed report — the queue has already
// moved on — so it is logged rather than returned, and logged loudly: a user
// who is not told what happened to their message will assume it was sent.
func (b *bridge) report(ctx context.Context, item queuedProse, paneID, text string) {
	if err := b.say(ctx, item.ChatID, item.ReplyTo, paneID, text); err != nil {
		b.log.Error("bridge: could not report what happened to a queued message",
			"pane", paneID, "chat_id", item.ChatID, "err", err)
	}
}

// plural picks a form. Queue notices count things, and "1 messages" reads like
// a bug in a product whose whole job is to be trusted about what it sent.
func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
