package bridge

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/cards"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// The two card acts that send nothing into a pane: Select, which points this
// chat at an agent so plain typing reaches it, and Screen, which re-reads the
// pane and posts what is on it. handleCardAction explains why neither takes the
// nonce, the guard or the disarm that ActKey does.

// pressSelect makes an agent this chat's current target.
//
// It is the button the whole card-first interaction turns on: after it, typing
// is all it takes to reach that agent — no reply, no pane id, which is what
// matters on a phone. It types nothing itself.
//
// The identity is re-read from the live agent rather than taken from the card,
// and the card is refused when the pane no longer holds the agent it was made
// for. A pane id is a seat, not an identity (G8): select claude at w1:p1, walk
// away, claude exits, codex starts in the same seat, and typing aimed at the
// seat lands in a different context — where, if that agent is sitting at a
// permission dialog, text answers the dialog (G1).
//
// Unlike a keystroke press this one CAN return an error. A redelivered Select
// press (G14) selects the same agent again, which is the state it is already
// in, so letting Feishu retry a send that failed costs nothing and recovers a
// selection the user was told about but never saw.
func (b *bridge) pressSelect(ctx context.Context, a lark.Action, d cards.Decision) error {
	if !b.answerable(a, d.Act) {
		return nil
	}
	if b.sel == nil {
		// Nothing was configured to remember a selection in. Saying so beats a
		// button that reports success and changes nothing.
		b.log.Warn("bridge: a Select press arrived but this bridge has no selection store",
			"pane", d.Pane, "chat_id", a.ChatID)
		return b.say(ctx, a.ChatID, a.MessageID, d.Pane, fmt.Sprintf(
			"⚠️ I have nowhere to remember which agent you picked, so nothing was aimed. "+
				"Use `/say %s <text>` to send it a single message.", d.Pane))
	}

	live, err := b.selectable(d)
	if err != nil {
		b.log.Warn("bridge: refusing a Select press whose agent is not the one in that pane any more",
			"pane", d.Pane, "kind", d.Kind, "err", err)
		return b.refuseSelection(ctx, a, err)
	}

	// Read BEFORE the selection is overwritten, and note what it is NOT: the
	// message this press came from. Usually the two are the same — the user
	// tapped the picker — but a Select press also arrives from a blocked card,
	// and adopting THAT as the chat's picker would have the next selection
	// change overwrite an agent's open question with an agent list. The picker
	// is only ever a message this bridge posted as one.
	card := b.pickerCard(a.ChatID)

	if !b.setSelection(a.ChatID, live, card) {
		// The store refuses a target with no kind, and it is right to: there
		// would be nothing to compare the live agent against before a later
		// delivery. herdr has seen a pane and has not identified what is in it
		// (G8), so the honest answer is that this cannot be aimed at yet.
		b.log.Warn("bridge: the selection store refused a target with no identity", "pane", live.PaneID)
		return b.say(ctx, a.ChatID, a.MessageID, live.PaneID, fmt.Sprintf(
			"⚠️ herdr has not worked out what is running in %s yet, so I cannot aim your typing at it: "+
				"later I would have no way to tell whether it is still the same program. "+
				"Use `/say %s <text>` for one message, or tap Select again once it shows a kind.",
			live.PaneID, live.PaneID))
	}

	if card != "" && !b.repaintPicker(ctx, a.ChatID, card) {
		// The card could not be edited — revoked, or older than Feishu keeps.
		// A fresh one carries the truth instead, and rebinds so the next change
		// edits that one.
		if err := b.postPicker(ctx, a.ChatID, a.MessageID, ""); err != nil {
			return err
		}
	}

	return b.say(ctx, a.ChatID, a.MessageID, live.PaneID, selectedLine(live))
}

// selectedLine is the one line that says where typing now goes.
//
// The blocked caveat is not decoration. The user is being invited to type at an
// agent that is sitting on a permission dialog, and prose to a blocked agent
// goes through Controller.Say, which presses esc first (G2) — the question
// disappears rather than being answered. Learning that afterwards, from a
// delivery report, is learning it too late.
func selectedLine(a agents.Agent) string {
	line := fmt.Sprintf("🎯 Now aimed at %s — just type; no reply and no pane id needed.", agentLabel(a))
	if a.Status == agents.StatusBlocked {
		line += "\nIt is waiting at a question, so the first thing you type presses Esc first: " +
			"that question goes away instead of being answered."
	}
	return line
}

// refuseSelection answers a Select press aimed at an agent that is not there.
//
// Nothing is aimed and the list is re-rendered, because the list is the answer
// to what the user was trying to do: aim at something.
//
// Any selection the chat already had is left ALONE, including one pointing at
// this same seat. This used to clear it, on the reasoning that a target which
// fails the same check is stale for the same reason — but a refused press is
// not a request to un-aim anything, and the delivery path re-checks that target
// before every message anyway, so nothing can reach a stranger by leaving it.
// What clearing actually cost was the conversation: tap Select on a card that
// has gone stale, and the chat you were in the middle of ended as a side effect
// of a button that reported doing nothing. /close is the way out (G8, G17).
func (b *bridge) refuseSelection(ctx context.Context, a lark.Action, cause error) error {
	return b.refuseInert(ctx, a, fmt.Sprintf("🔄 %v.\n\nNothing was aimed there.", cause))
}

// pressScreen re-reads a pane and posts what is on it.
//
// Also inert: both buffers it can read are passive (G9 forbids the `recent`
// source, whose read synthesises real scroll events into the user's live pane),
// so this is the one way to look at an agent from a phone without touching it.
//
// The screen posted is the live one, and it is labelled with the agent that is
// in that pane NOW rather than with what the card remembers. A card outlives
// what it describes; a screen that silently claimed to be another agent's would
// be worse than one that says it changed.
func (b *bridge) pressScreen(ctx context.Context, a lark.Action, d cards.Decision) error {
	if !b.answerable(a, d.Act) {
		return nil
	}

	live, ok := b.deps.Registry.Get(d.Pane)
	if !ok {
		b.log.Info("bridge: a Screen press names a pane herdr no longer has", "pane", d.Pane)
		return b.refuseInert(ctx, a, fmt.Sprintf(
			"👋 %s is gone — the pane was closed or the agent exited, so there is no screen to read.", d.Pane))
	}

	s, err := b.deps.Extractor.Dialog(d.Pane)
	if err != nil {
		b.log.Error("bridge: could not read a pane's screen for a Screen press", "pane", d.Pane, "err", err)
		return b.say(ctx, a.ChatID, a.MessageID, live.PaneID, fmt.Sprintf(
			"❌ Could not read %s's screen: %v", agentLabel(live), err))
	}

	body := []string{fmt.Sprintf("**📺 %s** · %s", agentLabel(live), live.Status)}
	// Two different facts, and only the first is "a different agent". A pane id
	// is never reused (see identity.matches), so an old button still names the
	// window it was drawn for; what may have changed underneath is the program
	// in it, or merely the conversation that program is on. Saying "this is not
	// the agent" for a /clear would be false.
	switch {
	case d.Kind != live.Kind:
		body = append(body, fmt.Sprintf(
			"_This is not the agent that button was made for: %s runs %s now._", d.Pane, orUnknown(live.Kind)))
	case replaced(d, live, b.now()):
		body = append(body, fmt.Sprintf(
			"_Same window, new conversation: the %s in %s has been restarted or cleared since that button "+
				"was drawn._", orUnknown(live.Kind), d.Pane))
	}
	body = append(body, dialogOrNote(s))
	if s.Cropped {
		body = append(body, "_Long lines were cropped to phone width, not wrapped._")
	}
	if s.Narrow {
		body = append(body, narrowNote(s.Cols))
	}
	body = append(body, fmt.Sprintf("_Reply to this message to send `%s` something._", live.PaneID))

	if _, err := b.send(ctx, outgoing{
		ChatID:   a.ChatID,
		ReplyTo:  a.MessageID,
		Markdown: strings.Join(body, "\n\n"),
		Title:    agentLabel(live) + " · screen",
		PaneID:   live.PaneID,
	}); err != nil {
		return fmt.Errorf("bridge: post the screen of %s: %w", live.PaneID, err)
	}
	return nil
}

// refuseInert reports an inert press that could not be honoured, and leaves the
// chat holding an up-to-date list.
//
// The card the press came from is deliberately NOT touched. It may be a blocked
// card whose numbered buttons are still the only way to answer an agent that is
// waiting, and refusing a Select press is no reason to take them away.
func (b *bridge) refuseInert(ctx context.Context, a lark.Action, reason string) error {
	if b.repaintPicker(ctx, a.ChatID, b.pickerCard(a.ChatID)) {
		return b.say(ctx, a.ChatID, a.MessageID, "",
			reason+" The agent list I posted has been brought up to date.")
	}
	return b.postPicker(ctx, a.ChatID, a.MessageID, reason)
}

// answerable reports whether an inert press can be answered at all.
//
// Both acts end in a message: one aims the chat, the other posts a screen into
// it. lark can synthesise an event id for a press that arrives without a header
// (see lark.syntheticActionID) but it cannot invent the chat the press came
// from, and no retry will supply one — so such a press is dropped with a log
// rather than returned as an error that Feishu redelivers every five minutes
// (G14). Nothing was sent to any agent either way.
func (b *bridge) answerable(a lark.Action, act string) bool {
	if a.ChatID != "" {
		return true
	}
	b.log.Error("bridge: a card press carried no chat id, so there is nowhere to answer it",
		"act", act, "message_id", a.MessageID, "operator", a.Operator)
	return false
}

// selectable resolves the agent a Select press names, refusing when the pane no
// longer holds the agent the card was made for.
//
// The two refusals are told apart because they are different facts and the user
// can act on only one of them. A changed KIND is about the pane: something else
// is running there, and no card will ever make that press work. An expired
// window is about the CARD: the agent may well be the right one, but this button
// was drawn too long ago to prove it, and /ls draws a new one that can.
//
// replacedError is not used for the second case, and that is not cosmetic: a
// cards.Decision carries no cwd, so the "I recorded it in X" sentence it writes
// would name an empty directory for a comparison it never made.
func (b *bridge) selectable(d cards.Decision) (agents.Agent, error) {
	a, ok := b.deps.Registry.Get(d.Pane)
	if !ok {
		return agents.Agent{}, fmt.Errorf("%w: %s is gone — the pane was closed or the agent exited",
			ErrTargetGone, d.Pane)
	}
	if d.Kind != a.Kind {
		return agents.Agent{}, replacedError(d.Pane, identity{Kind: d.Kind}, a)
	}
	if replaced(d, a, b.now()) {
		return agents.Agent{}, staleCardError(d, a)
	}
	return a, nil
}

// staleCardError explains a Select press refused because the card outlived the
// window in which what it claims could be trusted (see replaced).
func staleCardError(d cards.Decision, a agents.Agent) error {
	return fmt.Errorf("%w: that button was drawn more than %s ago and the %s in %s is not on the session "+
		"it was drawn against — it works in %s now — so I cannot tell whether it is still the same run. "+
		"Send /ls for a button that can prove it",
		ErrTargetReplaced, agents.MaxGuardAge, orUnknown(a.Kind), d.Pane, orNoCwd(a.Cwd))
}

// replaced reports that the pane does not hold the agent the card was made for.
//
// The rule is deliberately laxer in ONE direction than identity.matches, which
// decides whether a remembered destination may still be delivered to: a card
// that carries no session may select a live agent that has one — but only for
// as long as the card itself claims to be good for.
//
// That laxness is the G8 window seen from the other end. herdr publishes a
// session ref only once claude's trust-this-directory prompt is accepted, or
// codex's hook is trusted with `t`, so a card built seconds after an agent is
// detected carries none — and refusing it would break Select in exactly the
// window it is most useful, for a press the human is making right now while
// looking at the row. What the press stores is the LIVE identity, so every later
// delivery is checked against a session that does exist.
//
// The window is what is defended, so it is bounded by the clock rather than left
// open forever: Feishu messages never expire (G17), and an unbounded rule would
// let a Select drawn at 09:00 in project-A aim at whatever claude occupies that
// seat at 15:00 in project-B, on a card the user is reading precisely because it
// still names project-A. agents.MaxGuardAge is the bound because it is the one
// the cards already advertise — the blocked card's own footer says its buttons
// stop working after it — and past it the refusal path re-renders the list
// instead of retargeting in silence.
//
// AGREEMENT ends the question at any age, and it comes in two forms: the same
// session id on both sides, which is proof and does not go stale, and NO
// session on either side, which is the G8 window with nothing yet to disagree
// about. Only a genuine disagreement falls through to the clock.
//
// That last clause is a relaxation of a rule that used to refuse a changed
// session outright, and it is the same retraction identity.matches makes for
// deliveries, arriving here for the same reason. claude mints a new session id
// on every /clear and every compaction, so the old rule refused the Select on
// the card the user was looking at, seconds after it was posted, for an agent
// that had not moved an inch — and the advice it printed was to run /ls and tap
// the identical button on an identical card. What bounds it is the card's own
// age: inside agents.MaxGuardAge the user is acting on what is in front of them,
// and past it a card in the chat history (which never expires, G17) is not
// evidence of anything, so it falls back to the list.
//
// The ten-minute window is not new — it already governed every card that
// carries no session at all, which is every card drawn before claude's trust
// prompt is accepted — and inside it a seat that changed hands is aimed at
// rather than refused. What catches that is the sentence the press writes back:
// selectedLine names the LIVE agent it aimed at, kind, directory and pane, so a
// user who tapped "project-a" and got "project-b" reads it in the very next
// message instead of discovering it three messages later.
func replaced(d cards.Decision, a agents.Agent, now time.Time) bool {
	if d.Kind != a.Kind {
		return true
	}
	if d.Session == sessionID(a) {
		return false
	}
	return now.Sub(time.Unix(d.IssuedAt, 0)) > agents.MaxGuardAge
}

// narrowNote warns about the pane geometry that breaks detection silently.
//
// A pane herdr never attached a client to is 53 columns (G5). Claude's TUI
// wraps there, so the English strings herdr matches to decide "blocked" stop
// matching — and an unmatched screen is reported as idle rather than unknown
// (G11). The failure mode is a card that never arrives, which is invisible from
// a phone; this is the one place the user can see the cause.
func narrowNote(cols int) string {
	return fmt.Sprintf("⚠️ _This pane is %d columns wide. Dialogs wrap at that width and herdr then "+
		"reports the agent idle instead of blocked, so the cards that say it needs you stop arriving. "+
		"Attach a terminal to it once to widen it._", cols)
}
