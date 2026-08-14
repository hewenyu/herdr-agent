package bridge

import (
	"context"

	"github.com/hewenyu/herdr-agent/internal/dedup"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// inboundEvent is everything the guard needs about an inbound Feishu event,
// independent of which entry point it arrived through.
//
// Actor is the authorization subject and is set by the constructors below
// rather than by the handler, so a new entry point cannot authorize "whichever
// field looked plausible": S2 §3.4 fixes it as the message sender and the card
// operator respectively.
type inboundEvent struct {
	Kind    string // "message" | "card_action"; log label only
	NS      string // dedup namespace: message and card windows differ
	EventID string
	Actor   string // open_id
	ChatID  string
}

func messageEvent(m lark.Msg) inboundEvent {
	return inboundEvent{
		Kind:    "message",
		NS:      dedup.NSMessage,
		EventID: m.EventID,
		Actor:   m.UserID,
		ChatID:  m.ChatID,
	}
}

func actionEvent(a lark.Action) inboundEvent {
	return inboundEvent{
		Kind:    "card_action",
		NS:      dedup.NSCard,
		EventID: a.EventID,
		Actor:   a.Operator,
		ChatID:  a.ChatID,
	}
}

// guard runs fn behind the two checks every inbound event must pass, in the
// only order that is safe: authorize, then deduplicate, then act.
//
// Authorization first, because an unauthorized event must leave no trace a
// stranger could probe for — including a dedup entry, which would make the
// second delivery of the same event behave differently from the first.
//
// A DELIBERATE deviation lives here, and it is the one place the two halves of
// S2 disagree. §3.6 step 6 says a card action ALWAYS ends in UpdateCard, so no
// card is left armed; §3.4 says an actor who is not on the allowlist gets total
// silence. A press by a stranger cannot satisfy both, because Feishu has no
// silent card edit — every UpdateCard is visible to everyone who can see the
// message. Silence wins, on two grounds:
//
//   - a card that visibly changes under a stranger's finger confirms the bot
//     exists, is online, and is listening to that chat — exactly what §3.4
//     refuses to leak;
//   - disarming on a stranger's press would let anyone who can see the card
//     destroy the owner's only way to answer an agent that is waiting for one.
//
// The owner's own presses still always end in UpdateCard (cardaction.go), which
// is what step 6 is for: G17 is about a card the OWNER pressed once and can
// press again three days later. Read step 6 as applying to presses that passed
// step 1.
//
// Deduplication second and BEFORE any side effect, because Feishu redelivers
// events whose handler failed: measured at ~5 minutes later, byte-identical
// (G14). In this product a redelivered event is not a duplicate notification,
// it is a command injected a second time into a live coding agent — a build
// re-run, or a permission dialog re-answered.
//
// And when fn fails, the mark is removed again, so the redelivery gets a real
// second chance instead of being swallowed as "already seen". (For messages
// that second chance never comes — the SDK acknowledges a message event before
// the handler runs and discards its result, see lark.handleMessage — but the
// dedup contract asks for Unmark on failure and the two entry points must not
// differ in a way a future reader has to remember.)
func (b *bridge) guard(ctx context.Context, ev inboundEvent, fn func(context.Context) error) error {
	if !b.authorized(ev.Actor) {
		b.denied(ev)
		return ErrUnauthorized
	}

	if ev.EventID == "" {
		// Nothing to deduplicate on. Feishu always sends an id and lark
		// synthesises one for card presses that arrive without a header, so
		// this is a "cannot happen" — but dropping the event would silently
		// swallow an authorized user's command, which is worse than the risk of
		// acting on it twice.
		b.log.Warn("bridge: inbound event has no event id; processing it without deduplication",
			"kind", ev.Kind, "chat_id", ev.ChatID)
		return fn(ctx)
	}

	if b.deps.Dedup.SeenOrMark(ev.NS, ev.EventID) {
		b.log.Info("bridge: ignoring a redelivered event",
			"kind", ev.Kind, "ns", ev.NS, "event_id", ev.EventID)
		return nil
	}

	err := fn(ctx)
	if err != nil {
		b.deps.Dedup.Unmark(ev.NS, ev.EventID)
		b.log.Error("bridge: handler failed; the event was un-marked so a redelivery can retry it",
			"kind", ev.Kind, "ns", ev.NS, "event_id", ev.EventID, "err", err)
	}
	return err
}
