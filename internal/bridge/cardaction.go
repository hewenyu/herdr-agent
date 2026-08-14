package bridge

import (
	"context"
	"errors"
	"fmt"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// handleCardAction acts on one authorized, non-duplicate button press.
//
// It is reached only through guard(), which has already performed steps 1 and 2
// of S2 §3.6 for every act. What happens after that depends on which act the
// button carries, and the three are NOT the same pipeline:
//
//	ActKey    types into a live terminal. It keeps every rule it ever had —
//	          nonce, guard, SendKey, and a disarmed card at the end, always.
//	ActSelect points this chat at an agent so that plain typing reaches it.
//	ActScreen re-reads the pane and posts what is on it.
//
// The last two send nothing into any pane, which is what cards.Decision.Inert
// reports, and they deliberately skip the nonce, the guard and the disarm. That
// is not a weakening of §3.6; applying it to them would be actively harmful:
//
//   - all the buttons of a blocked card share one nonce, so spending it on a
//     Select press would take the numbered answers away from an agent that is
//     still sitting at the question — and Select is precisely how the user gets
//     ready to answer it;
//   - the disarm exists so a keystroke cannot be delivered twice (G17). An act
//     that delivers no keystroke has nothing to disarm, and redrawing the card
//     as "used" would destroy the same buttons for the same reason;
//   - the guard pins a decision to the state the human was looking at. Aiming
//     future typing at an agent is a decision about NOW, re-checked against the
//     live agent here and again before every delivery.
//
// The switch is exhaustive and its default refuses. A future act must arrive
// here as "I do not know what that is", never as a fall-through into the one
// branch that puts characters into a terminal (G1).
func (b *bridge) handleCardAction(ctx context.Context, a lark.Action) error {
	d, err := cards.DecodeDecision(a.Value)
	if err != nil {
		// A value this build cannot read will not become readable later: it is
		// a card from another build, or a payload somebody edited. Nothing is
		// sent, and the card is normally disarmed too, so the user is not left
		// tapping buttons that do nothing.
		b.log.Warn("bridge: refusing a card press whose value could not be decoded",
			"message_id", a.MessageID, "operator", a.Operator, "err", err)

		shown := displayOnlyDecision(a.Value)
		if shown.Inert() {
			// Except when the value says it was one of the buttons that types
			// nothing. Disarming redraws the whole card, which on a blocked card
			// destroys the numbered answers an agent may still be waiting on —
			// the same reason a decodable Select press leaves the card alone.
			// Trusting the act this far is safe in the one direction it is used:
			// decoding already failed, so no keystroke can be sent from this
			// payload whatever it claims, and a forged act can only WITHHOLD the
			// repaint, never cause one.
			//
			// Unreachable for values this build writes. It is here because a
			// later build that tightens DecodeDecision would otherwise turn one
			// tap on "Select & type" into the loss of a live card (G17).
			b.tellOperator(ctx, a, shown.Pane, "⚠️ I could not read what that button was supposed to do, "+
				"so nothing was sent and the card was left exactly as it is. Run /ls for a fresh list.")
			return nil
		}
		b.refuseCard(ctx, a, shown,
			"I could not read what this button was supposed to do, so nothing was sent")
		return nil
	}

	switch d.Act {
	case cards.ActKey:
		return b.pressKey(ctx, a, d)

	case cards.ActSelect:
		return b.pressSelect(ctx, a, d)

	case cards.ActScreen:
		return b.pressScreen(ctx, a, d)

	default:
		// Unreachable: DecodeDecision refuses any other act. It is here because
		// the only alternative to an explicit refusal is a keystroke sent on
		// behalf of a button this build does not understand.
		b.log.Error("bridge: a card value decoded to an act this build cannot handle",
			"act", d.Act, "pane", d.Pane, "message_id", a.MessageID)
		b.refuseCard(ctx, a, d, fmt.Sprintf(
			"this button asks for %q and this build has no handler for it, so nothing was sent", d.Act))
		return nil
	}
}

// pressKey is S2 §3.6 in full: the one act that reaches a live terminal.
//
// Consume the card's nonce exactly once (NSNonce), hand the Decision's Guard to
// Controller.SendKey — which refuses a keystroke whose StateSeq no longer
// matches the agent — and then, whatever happened, replace the card with a
// disarmed one. Feishu messages never expire, so a card left armed in the chat
// history keeps delivering keystrokes into whatever occupies that pane days
// later (G17).
//
// Decoding ran before the nonce was consumed because the nonce is INSIDE the
// value; that is not a reordering of the steps, since decoding is a pure
// function of the payload and touches nothing. Everything that has an effect —
// the nonce, the guard, the key — happens in the order the spec fixes.
//
// It returns nil on every refusal. An error here would leave the press
// unacknowledged and Feishu would redeliver it about five minutes later (G14),
// by which time the nonce is spent and the redelivery could only be refused
// again — while the first refusal has already been explained to the user on the
// card itself. Errors are for things a retry could fix, and none of these are.
func (b *bridge) pressKey(ctx context.Context, a lark.Action, d cards.Decision) error {
	// Step 3. The nonce is consumed BEFORE the guard is checked and before any
	// key is sent, so that the second press of a card can never reach an agent
	// regardless of what the agent is doing at the time. All the buttons of one
	// card share a nonce, because a card is one question: answering it with `2`
	// after answering it with `1` is the same mistake as pressing `1` twice.
	//
	// The store is on disk, so a card stays spent across a restart — which
	// matters because a restart is exactly when Feishu redelivers most (G14).
	if b.deps.Dedup.SeenOrMark(NSNonce, d.Nonce) {
		b.log.Warn("bridge: refusing a second press of a card that was already used",
			"pane", d.Pane, "key", d.Key, "operator", a.Operator, "message_id", a.MessageID)
		b.refuseCard(ctx, a, d,
			"this card has already been used, and a card answers exactly one question, once")
		return nil
	}

	// Steps 4 and 5. The Guard travels back out of the card exactly as it went
	// in, and SendKey re-checks it against herdr: the pane still exists, the
	// same kind of agent is in it, the card is not older than
	// agents.MaxGuardAge, and the agent is still blocked at the very state
	// sequence the human was looking at. A press that fails any of them types
	// nothing (G17).
	next, err := b.deps.Controller.SendKey(ctx, d.Guard(), d.Key)
	if err != nil {
		b.log.Warn("bridge: a card press was refused; no key reached the agent",
			"pane", d.Pane, "key", d.Key, "seq", d.Seq, "err", err)
		b.refuseCard(ctx, a, d, cardRefusal(d, err))
		return nil
	}

	b.resolveCard(ctx, a, next, d)
	return nil
}

// resolveCard replaces an honoured card with the record of what it did.
func (b *bridge) resolveCard(ctx context.Context, a lark.Action, next agents.Agent, d cards.Decision) {
	outcome := fmt.Sprintf("%s is now %s", agentLabel(next), next.Status)
	at := b.now()

	card, err := cards.BuildResolved(next, d, a.Operator, outcome, at)
	if err != nil {
		// The key is already in the agent, so this must not read as a failure
		// to send. Only the record of it could not be drawn.
		b.log.Error("bridge: could not build the resolved card", "pane", d.Pane, "err", err)
		b.tellOperator(ctx, a, d.Pane, fmt.Sprintf(
			"✅ Sent `%s` to %s — %s. (I could not redraw the card itself; its buttons are spent "+
				"and pressing them again sends nothing.)", d.Key, d.Pane, outcome))
		return
	}

	b.replaceCard(ctx, a, d.Pane, card, fmt.Sprintf(
		"✅ Sent `%s` to %s at %s — %s.", d.Key, d.Pane, at.Format(cardStampLayout), outcome))
}

// refuseCard replaces a card that was NOT acted on, and says why.
//
// A refusal has to be visible. The user tapped something; silence would leave
// them believing an agent had been answered when it is still sitting at a
// dialog (S2 §3.6).
func (b *bridge) refuseCard(ctx context.Context, a lark.Action, d cards.Decision, reason string) {
	plain := fmt.Sprintf("⚠️ Nothing was sent to %s: %s.", fallbackPane(d.Pane), reason)

	card, err := cards.BuildExpired(d, reason)
	if err != nil {
		b.log.Error("bridge: could not build the expired card", "pane", d.Pane, "err", err)
		b.tellOperator(ctx, a, d.Pane, plain)
		return
	}
	b.replaceCard(ctx, a, d.Pane, card, plain)
}

// replaceCard performs step 6: swap the armed card for a static one.
//
// This is the fix for a measured hazard. A card pressed three days after it was
// posted still delivered its keystroke into the pane, which by then held
// something else entirely; the reproduction put a stray "1" into a live agent's
// input box (G17). The nonce above is what makes a second press harmless; this
// is what makes it obvious, so nobody keeps tapping a button that answers
// nothing.
//
// When the update itself fails the buttons stay drawn in the chat, so the user
// is told in plain text — both what happened and that the drawn buttons are
// already spent.
func (b *bridge) replaceCard(ctx context.Context, a lark.Action, paneID, cardJSON, plain string) {
	if a.MessageID == "" {
		// lark synthesises an event id for a press that arrives without a
		// header, but it cannot invent the message id an update needs.
		b.log.Error("bridge: a card press carried no message id, so its card cannot be disarmed",
			"pane", paneID, "chat_id", a.ChatID)
		b.tellOperator(ctx, a, paneID, plain)
		return
	}

	if err := b.deps.Bot.UpdateCard(ctx, a.MessageID, cardJSON); err != nil {
		b.log.Error("bridge: could not disarm a card after a press",
			"pane", paneID, "message_id", a.MessageID, "err", err)
		b.tellOperator(ctx, a, paneID, plain+
			"\n\n(The card above could not be updated, so its buttons are still drawn. "+
			"They are spent: pressing them again sends nothing.)")
	}
}

// tellOperator answers a press in plain text, threaded under the card it was
// about. It is the fallback for every path where the card itself could not
// carry the answer.
func (b *bridge) tellOperator(ctx context.Context, a lark.Action, paneID, text string) {
	if err := b.say(ctx, a.ChatID, a.MessageID, paneID, text); err != nil {
		b.log.Error("bridge: could not tell the operator what happened to their press",
			"chat_id", a.ChatID, "pane", paneID, "err", err)
	}
}

// cardStampLayout matches the one the cards package prints, so the message and
// the card it accompanies do not describe the same instant two ways.
const cardStampLayout = "2006-01-02 15:04:05 MST"

// cardRefusal turns a guard failure into the sentence the user reads.
//
// Each case names the check that refused, because the useful next step differs:
// a stale card is re-issued with /card, a gone pane is not.
func cardRefusal(d cards.Decision, err error) string {
	switch {
	case errors.Is(err, agents.ErrNoLongerBlocked):
		return fmt.Sprintf("%s is not waiting at the question this card was made for any more "+
			"(the card was issued at state %d). Answering it now would type `%s` into whatever "+
			"the agent is doing instead", d.Pane, d.Seq, d.Key)

	case errors.Is(err, agents.ErrGuardStale):
		return fmt.Sprintf("this card is older than %s, which is as long as a decision stays "+
			"good for. Ask again with `/card %s`", agents.MaxGuardAge, d.Pane)

	case errors.Is(err, agents.ErrPaneGone):
		return fmt.Sprintf("pane %s no longer exists — it was closed, or the agent exited", d.Pane)

	case errors.Is(err, agents.ErrAgentReplaced):
		return fmt.Sprintf("a different agent occupies %s now, so this card is aimed at "+
			"something that is no longer there", d.Pane)

	case errors.Is(err, agents.ErrKeyNotAllowed):
		return fmt.Sprintf("`%s` is not a key this bridge will send", d.Key)

	default:
		return fmt.Sprintf("herdr would not take the key: %v", err)
	}
}

// displayOnlyDecision salvages whatever is legible from a card value that
// DecodeDecision refused, so the "nothing was sent" card can still say which
// pane and key the user thought they were pressing.
//
// It exists for prose and for ONE decision: whether the press claims to be an
// act that types nothing, and may therefore be answered without redrawing the
// card. Both uses are refusals-of-work. Its result is handed to
// cards.BuildExpired — which draws a card with no buttons — and must never
// reach SendKey or a Guard: DecodeDecision already refused this payload, and a
// decision repaired here would be a decision the user never made. The Act
// salvaged here is deliberately NOT dispatched on; the switch below runs only
// on a Decision the decoder accepted.
func displayOnlyDecision(v map[string]any) cards.Decision {
	var d cards.Decision
	if s, ok := v["act"].(string); ok {
		d.Act = s
	}
	if s, ok := v["pane"].(string); ok {
		d.Pane = s
	}
	if s, ok := v["key"].(string); ok {
		d.Key = s
	}
	if s, ok := v["kind"].(string); ok {
		d.Kind = s
	}
	return d
}

func fallbackPane(paneID string) string {
	if paneID == "" {
		return "any agent"
	}
	return paneID
}
