package bridge

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// bursts records which agents a chat has already been told its typing is
// reaching, so that a run of messages to one agent costs one line in the chat
// instead of one line per message.
//
// A burst opens on the first delivery from a chat to a pane and closes when that
// agent settles — the notification the notifier pushes on `done` or `blocked` is the
// substantive reply, and it is the closing bracket of the burst. BusyAckCooldown
// is only a backstop for the burst that never gets one: a push that failed its
// retries, an agent that works for an hour, a bridge with no notify chat. Erring
// towards one extra acknowledgement is deliberate; erring towards silence would
// leave a user typing into a chat that says nothing about where their words went.
//
// THIS IS THE FALLBACK ACKNOWLEDGEMENT, NOT THE INTENDED ONE. The intended one is
// an emoji reaction on the user's own message: it occupies no bubble, it survives
// a restart, and since Feishu has no bot typing indicator a reaction is the only
// acknowledgement that is not itself a message. internal/lark cannot add one —
// lark.Bot is a frozen contract offering Send, UpdateCard, Stream and BotOpenID,
// with no reaction method behind them (the only "reaction" in that package is the
// SDK's INBOUND event, stubbed out in its tests) — and no other package may touch
// the Feishu SDK. Inventing one here was explicitly out of scope, so the first
// message of a burst gets one short line and the rest are silent. If a reaction
// API is added to lark.Bot later, swap the b.say that carries burstAck for it and
// the rest of this file is unchanged.
type bursts struct {
	mu sync.Mutex
	// spokeAt is when this burst was acknowledged. Entries are deleted when the
	// burst closes, so the map is bounded by the number of agents actually being
	// talked to, times the chats talking to them.
	spokeAt map[burstKey]time.Time
}

// burstKey is what one acknowledgement covers: one agent, as addressed from one
// chat.
//
// NOT the pane alone, which is what this was keyed on first. The acknowledgement
// is spoken into the chat the message arrived from, while the settle reply that
// normally closes the burst only ever goes to Deps.NotifyChatID. Keyed on the
// pane, a first chat's acknowledgement would silence a second chat's message —
// and that message's author would then hear nothing at settle time either,
// because the settle reply is not delivered to them. One message, no visible
// response anywhere, which is the exact failure this file exists to avoid.
//
// It is a marginal configuration under the product decision 仅本人/单聊为主 (one
// open_id, single chat), and that is the reason to spend a struct key on it
// rather than to skip it: the rule this wave leans on — the user must always
// know which agent heard them — is a per-chat property, since the chat is where
// the sticky selection lives and where the answer is read.
type burstKey struct{ chatID, paneID string }

func newBursts() *bursts { return &bursts{spokeAt: map[burstKey]time.Time{}} }

// open reports whether this delivery should be acknowledged out loud, recording
// that it was. It is true for the first delivery of a burst and false while an
// acknowledgement for that key is still standing.
//
// Check and stamp are one critical section because two messages to one agent
// arrive concurrently (the larksuite SDK runs a goroutine per inbound frame), and
// a check that released the lock before stamping would let both speak. The
// caller must therefore hand the stamp back with unopen if the acknowledgement
// it was granted never reaches the chat.
func (s *bursts) open(k burstKey, now time.Time, window time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if at, ok := s.spokeAt[k]; ok && now.Sub(at) < window && !now.Before(at) {
		return false
	}
	s.spokeAt[k] = now
	return true
}

// unopen withdraws an open whose acknowledgement was never delivered, so the
// message behind it is acknowledged instead of being covered by a line the user
// never saw. A transient Feishu failure must cost one message its
// acknowledgement, not the whole burst's.
//
// It withdraws only its own stamp — an entry that has since moved on belongs to
// a later delivery that did speak, and deleting that would produce a duplicate
// acknowledgement rather than restore a missing one.
func (s *bursts) unopen(k burstKey, stamped time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if at, ok := s.spokeAt[k]; ok && at.Equal(stamped) {
		delete(s.spokeAt, k)
	}
}

// close ends a pane's burst, so the next thing typed at that agent is
// acknowledged again.
//
// Called from every Push* sink method, which are the notifier's three settle
// events (blocked, done, gone). It runs on the attempt rather than on success:
// closing an unspoken burst costs one extra acknowledgement later, while leaving
// it open after a failed push would suppress the next one for no reason.
//
// A settle closes the burst in EVERY chat that was talking to the pane, although
// the notification itself goes to one. For the chat that receives it the
// notification is the closing bracket; for any other chat nothing arrived at all,
// so its burst has even more reason to be reopened. Both directions land on
// speaking again, which is the side this file always takes.
func (s *bursts) close(paneID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.spokeAt {
		if k.paneID == paneID {
			delete(s.spokeAt, k)
		}
	}
}

// reportDelivery answers a delivered message — or deliberately does not.
//
// The product owner's rule (S2 wave): 最终只要 agent 停下来，你在返回消息给飞书 —
// the substantive reply comes when the agent stops, not once per message. Three
// sentences typed at one agent used to produce three "Delivered to X" bubbles
// before the agent had said anything, which is three notifications carrying one
// fact between them.
//
// So a clean delivery is folded into the burst acknowledgement. Everything else
// speaks at once, and the list is not a matter of taste:
//
//   - a routing note means the message did NOT go where the user pointed
//     (sticky selection, unroutable reply). Silence there is a message delivered
//     somewhere they did not aim it.
//   - Acked && !Verified is "we do not know" (G3): agent.prompt reports success
//     as soon as the bytes reach the PTY queue, and a prompt sent across a state
//     change was measured being swallowed with no error at all. A user who is not
//     told walks away from an agent that never heard them.
//   - Escaped means their message dismissed a permission dialog they never asked
//     to dismiss (G1, G2).
//   - MayHaveAnsweredADialog means it may have ANSWERED one (G1). That is the one
//     disclosure this product exists to make, and it must never wait for a settle.
//   - Attempts > 1 means the agent may be holding the same sentence twice. See
//     mustReportNow.
//   - no notify chat configured means nothing will ever speak later, so this is
//     the only chance to report anything at all.
func (b *bridge) reportDelivery(ctx context.Context, chatID, replyTo string, a agents.Agent, note string, d agents.Delivery) error {
	if note != "" || !b.settleWillReport(a.PaneID) || mustReportNow(d) {
		return b.say(ctx, chatID, replyTo, a.PaneID, withNote(note, deliveryNote(a, d)))
	}

	k := burstKey{chatID: chatID, paneID: a.PaneID}
	at := b.now()
	if !b.acks.open(k, at, BusyAckCooldown) {
		// Delivered and deliberately unremarked. The user has already been told
		// which agent is hearing them, and the agent's own answer is what they are
		// waiting for.
		b.log.Info("bridge: delivered without a reply; this pane's burst is already acknowledged",
			"pane", a.PaneID, "chat_id", chatID)
		return nil
	}
	if err := b.say(ctx, chatID, replyTo, a.PaneID, burstAck(a, d)); err != nil {
		// The acknowledgement did not reach the chat, so it cannot be allowed to
		// stand for the messages behind it: one failed Feishu write would
		// otherwise silence this message AND every further message to this pane
		// for BusyAckCooldown. Handing the stamp back costs at most one extra
		// acknowledgement, which is the direction close() already argues for.
		b.acks.unopen(k, at)
		return err
	}
	return nil
}

// mustReportNow reports whether a delivery has to be described immediately
// instead of being folded into the burst acknowledgement. See reportDelivery.
//
// Attempts > 1 is here because a retry can put the SAME SENTENCE into the agent
// twice. herdr answers agent_prompt_stalled when it observes no state change
// inside its window, which is not proof the text is absent (G3): a paste sitting
// in a composer the agent has not consumed changes no state at all. So attempt 2
// reads the input box, finds the first copy, prepends a newline (G19/M2) and
// pastes again — and the agent is submitted "run the deploy\nrun the deploy" as
// one prompt, verified, acked, indistinguishable at this layer from a clean
// delivery. The separator only keeps the duplicate legible on the AGENT'S screen,
// which is the screen the person on the phone cannot see; deliveryNote's retry
// count is the only thing that makes a doubled instruction diagnosable from the
// chat, and folding it into burstAck — which never mentions attempts — would drop
// it, or drop the whole message mid-burst.
func mustReportNow(d agents.Delivery) bool {
	return !d.Acked || !d.Verified || d.Escaped || d.MayHaveAnsweredADialog || d.Attempts > 1
}

// settleWillReport is whether anything will speak when the agent stops.
//
// A task reports into its group. Other agents only have automatic notifications
// in legacy mode; when there is no destination, direct input needs its receipt.
func (b *bridge) settleWillReport(pane string) bool { return b.notifyChat(pane) != "" }

// burstAck is the one line a run of messages to one agent costs.
//
// It names the agent, which is not decoration: the chat's selection is sticky, so
// the user who types three sentences must be able to see WHICH terminal heard
// them — and this line is the only place that is said until the agent answers.
// It also says that further messages will go unremarked, so the silence that
// follows reads as designed rather than as a bridge that stopped working.
func burstAck(a agents.Agent, d agents.Delivery) string {
	if d.Queued {
		// Delivered into the agent's OWN input queue: it is mid-turn, the text
		// sits in its composer and is submitted as a prompt when the turn ends
		// (G19/M1). "It will read this when it finishes" is a different promise
		// from "it is reading this now", and the user acts on the difference.
		return fmt.Sprintf("📤 %s has your message. It is mid-turn, so it reads this when the current "+
			"turn ends. Keep typing — I will not answer each message; you hear from me when it stops.",
			agentLabel(a))
	}
	return fmt.Sprintf("📤 %s has your message. Keep typing — I will not answer each message; "+
		"you hear from me when it stops.", agentLabel(a))
}

// plural picks a form. These messages count things, and "1 messages" reads like a
// bug in a product whose whole job is to be trusted about what it sent.
func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
