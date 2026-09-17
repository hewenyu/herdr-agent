package bridge

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/commands"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// handleMessage routes one authorized, non-duplicate inbound message.
//
// It is reached only through guard(), so by the time it runs the sender is on
// the allowlist and this event id has not been handled before.
//
// Routing itself (S2 §3.5) belongs here: slash commands first — an
// unrecognised one must produce an error reply and must NEVER fall through to
// prose, because "/stpo w1:p1" delivered as prose to a blocked agent presses
// Enter on its permission dialog and approves it (G1) — then the priority in
// target(): reply-to, the chat's selection, the single agent, the picker card.
//
// The switch is exhaustive over commands.Kind and its default is an error, not
// prose. That is the shape the rule needs: a Kind added to the parser later
// arrives here as "I do not know what that is", never as text aimed at an
// agent.
func (b *bridge) handleMessage(ctx context.Context, m lark.Msg) error {
	cmd := commands.Parse(m.Text)

	switch cmd.Kind {
	case commands.KindProse:
		return b.routeProse(ctx, m, cmd.Text)

	case commands.KindLs:
		return b.commandList(ctx, m)

	case commands.KindCard:
		return b.commandCard(ctx, m, cmd.Pane)

	case commands.KindSay:
		return b.commandSay(ctx, m, cmd.Pane, cmd.Text)

	case commands.KindStop:
		return b.commandStop(ctx, m, cmd.Pane)

	case commands.KindMirror:
		return b.commandMirror(ctx, m, cmd.Pane, cmd.On)

	case commands.KindClose:
		return b.commandClose(ctx, m)

	case commands.KindDoctor:
		return b.reply(ctx, m, "", b.doctor())

	case commands.KindHelp:
		return b.reply(ctx, m, "", commands.Help())

	case commands.KindBadArgs:
		// A command we recognise, with arguments we could not use. Reason names
		// the command and its usage, which is all the user needs; the whole
		// table would bury it.
		b.log.Info("bridge: refused a malformed command", "reason", cmd.Reason)
		return b.reply(ctx, m, "", "⚠️ "+cmd.Reason)

	case commands.KindUnknown:
		b.log.Info("bridge: refused an unknown command", "reason", cmd.Reason)
		return b.reply(ctx, m, "", "⚠️ "+cmd.Reason+"\n\n"+commands.Help())

	default:
		// Unreachable today. It is here because the alternative to an explicit
		// refusal is a fallthrough to prose, and prose aimed at a blocked agent
		// is an approval (G1) — a new Kind must fail loudly, not quietly type
		// into a terminal.
		b.log.Error("bridge: commands.Parse returned a kind this build cannot route",
			"kind", cmd.Kind.String())
		return b.reply(ctx, m, "", fmt.Sprintf(
			"⚠️ I parsed that as %q and this build has no handler for it, so nothing was sent to any agent.\n\n%s",
			cmd.Kind.String(), commands.Help()))
	}
}

// ---------- prose ----------

// routeProse resolves which agent free text is aimed at, and delivers it.
//
// Every refusal ends on the picker card rather than on a paragraph of prose:
// the card is the interaction now, and the next thing the user has to do —
// choose an agent and carry on typing — is one tap on it.
func (b *bridge) routeProse(ctx context.Context, m lark.Msg, text string) error {
	t, err := b.target(m)
	switch {
	case err == nil:
		return b.deliver(ctx, m.ChatID, m.MessageID, t, text)

	case fromStanding(err):
		// The conversation this chat is in the middle of could not be delivered
		// to. Checked FIRST because it wraps the sentinels below.
		return b.standingUnavailable(ctx, m, err)

	case errors.Is(err, ErrTargetReplaced), errors.Is(err, ErrTargetGone):
		// A reply aimed at a destination that is not that destination any more.
		// One message, one gesture, nothing delivered — and, unlike the case
		// above, nothing about the chat's own conversation has changed.
		return b.replyUnroutable(ctx, m, err)

	case errors.Is(err, ErrAmbiguous):
		// Deliberately not "the most recent one". Guessing costs a message
		// delivered to the wrong agent, and the wrong agent may be sitting at a
		// permission dialog (G1). Tapping one is cheap; guessing is not.
		return b.postPicker(ctx, m.ChatID, m.MessageID, fmt.Sprintf(
			"🤔 %v, so nothing was sent. Tap **Select** below and send it again.%s",
			err, unboundReplyNote(m)))

	case errors.Is(err, ErrNoAgent):
		return b.postPicker(ctx, m.ChatID, m.MessageID, fmt.Sprintf("🤷 %v", err))

	default:
		return err
	}
}

// standingUnavailable answers a message the chat's own agent could not take.
//
// It says three things, in this order: what happened, that nothing was sent,
// and that the chat is STILL aimed there. The third is the one that matters. An
// agent exiting is the ordinary rhythm of working — you finish a task, you quit
// claude, you start it again — and a bridge that treated each of those as the
// end of the conversation is a bridge that asks you to pick your agent several
// times a day.
//
// No fresh picker card is posted while one can be repainted. A new card under
// every message reads as "choose again", and there is nothing to choose: the
// chat already knows who it is talking to, and the one command that changes
// that is named in the reply.
func (b *bridge) standingUnavailable(ctx context.Context, m lark.Msg, cause error) error {
	label := "the agent you picked"
	if t, ok := b.currentSelection(m.ChatID); ok {
		label = targetLabel(t)
	}
	line := fmt.Sprintf("🚫 %v.\n\nNothing was sent. This chat is still aimed at %s and picks up again "+
		"the moment it is back — send /close to aim somewhere else, or tap Select on the list.", cause, label)

	if b.repaintPicker(ctx, m.ChatID, b.pickerCard(m.ChatID)) {
		return b.reply(ctx, m, "", line)
	}
	return b.postPicker(ctx, m.ChatID, m.MessageID, line)
}

// replyUnroutable answers a REPLY whose recorded destination is not there any
// more. The message is lost; the conversation is not.
//
// With a selection in place the picker is deliberately not posted: the user has
// somewhere to type, they are told where, and one refused gesture is no reason
// to put the chooser back in front of them.
func (b *bridge) replyUnroutable(ctx context.Context, m lark.Msg, cause error) error {
	line := fmt.Sprintf("🔄 %v.\n\nNothing was sent.", cause)
	if t, ok := b.currentSelection(m.ChatID); ok {
		return b.reply(ctx, m, "", line+fmt.Sprintf(
			" This chat is still aimed at %s: send it again without replying and it goes there.",
			targetLabel(t)))
	}
	// The picker card already in the chat may still mark that agent as the
	// current target, so it is repainted where it stands before a fresh one is
	// posted below. Scrolling back to a card that offers a selection this bridge
	// has just refused is how a user ends up tapping it again.
	b.repaintPicker(ctx, m.ChatID, b.pickerCard(m.ChatID))
	return b.postPicker(ctx, m.ChatID, m.MessageID, line+" Tap **Select** below and send it again.")
}

// unboundReplyNote explains an ambiguity the user thought they had resolved.
//
// Getting "which agent did you mean?" after deliberately replying to a message
// reads like the bridge ignored the reply. It did not: that message carries no
// route. The ordinary reason is a MIRRORED agent turn, which is streamed into
// one edited message and therefore has no id to register (see pumpMirror), and
// a mirrored answer is the most natural thing in the chat to reply to.
func unboundReplyNote(m lark.Msg) string {
	if m.ReplyToMessageID == "" {
		return ""
	}
	return "\n(I did see that you replied, but that message is not bound to an agent. " +
		"Mirrored agent turns are streamed, and Feishu gives a streamed message no id I can register, " +
		"so replies to them cannot be routed.)"
}

// aim is the outcome of routing one inbound message: which agent it goes to,
// and anything the user has to be told about how that was decided.
type aim struct {
	agent agents.Agent
	// note is prepended to the delivery report when the destination was NOT the
	// one the user's gesture asked for. Silence there would be a message
	// delivered somewhere the user did not aim it, which is the failure this
	// whole package exists to prevent.
	note string
}

// target picks the agent an inbound message is aimed at (S2 §3.5), in the
// priority the card-first interaction fixes:
//
//  1. card buttons — a different handler entirely; the pane travels in the
//     button's own value, so they win by construction (G16).
//  2. reply-to. It overrides the selection for THIS message only and does not
//     change it: that is what lets one chat drive several agents at once while
//     still having a default.
//  3. the chat's selection. This is the common case — several turns with ONE
//     agent — and it costs no gesture at all beyond typing.
//  4. exactly one agent running: there is nowhere else it could go.
//  5. nothing: the caller posts the picker card.
//
// Steps 2 and 3 both resolve a REMEMBERED destination, so both re-check the
// identity of whoever is in that pane now before anything is delivered.
func (b *bridge) target(m lark.Msg) (aim, error) {
	if m.ReplyToMessageID != "" {
		if raw, ok := b.deps.Routes.Lookup(m.ReplyToMessageID); ok {
			if bd, ok := decodeBinding(raw); ok {
				return b.boundTarget(bd)
			}
			// A binding this build cannot read at all. There is no pane to aim
			// at and nothing to explain, so it is exactly an unbound reply.
			b.log.Warn("bridge: a route binding could not be decoded; treating the reply as unbound",
				"message_id", m.ReplyToMessageID)
		}
	}

	if t, ok := b.currentSelection(m.ChatID); ok {
		a, err := b.checkIdentity(t.Pane, selectionIdentity(t))
		if err != nil {
			// THE SELECTION IS KEPT, and this line is the whole point of the
			// wave. It used to be cleared here, "where the fact is known" — and
			// the fact known here is only that we cannot deliver RIGHT NOW, which
			// is not the same fact as "this person is done talking to that
			// agent". Every transient cause (the agent exited and is about to be
			// restarted, herdr has not listed it back yet) ended the conversation
			// permanently, and the user had to re-pick from a card.
			//
			// Clearing was also the more dangerous of the two. With the selection
			// gone, the fall-through below reads "exactly one agent is running,
			// send it there" — so the message AFTER a replaced target would be
			// delivered, with no note at all, into the agent that replaced it.
			// Refusing while keeping the aim cannot do that: a chat with a
			// selection never reaches the fall-through.
			//
			// It is wrapped so the caller can tell a refused conversation from a
			// refused reply and answer them differently (see standingFailure).
			return aim{}, standingFailure{err}
		}
		notes := make([]string, 0, 3)
		if n := unroutedReplyNote(m, b.deps.Registry.Snapshot()); n != "" {
			notes = append(notes, n)
		}
		if n := b.reconcileSelection(m.ChatID, t, a); n != "" {
			notes = append(notes, n)
		}
		if n := b.staleNote(m.ChatID, t, a); n != "" {
			notes = append(notes, n)
		}
		return aim{agent: a, note: strings.Join(notes, "\n")}, nil
	}

	switch list := b.deps.Registry.Snapshot(); len(list) {
	case 0:
		return aim{}, fmt.Errorf("%w: herdr sees no agent to send that to", ErrNoAgent)
	case 1:
		// No note even for an unroutable reply: with one agent running there is
		// nowhere else it could have gone, and a caveat on every mirrored turn
		// the user answers is noise.
		return aim{agent: list[0]}, nil
	default:
		return aim{}, fmt.Errorf("%w: %d agents are running", ErrAmbiguous, len(list))
	}
}

// boundTarget resolves a reply-to binding, or refuses it.
//
// An explicit target that is no longer there does NOT fall back to "the only
// agent left" and does not fall back to the selection either: the user aimed at
// one terminal, and typing into a different one is the failure this bridge
// exists to prevent.
func (b *bridge) boundTarget(bd binding) (aim, error) {
	if !bd.verified {
		// Written by a build that recorded only the seat. Delivering it would be
		// the very thing this wave closes, so it is refused — once per stale
		// binding, and the picker card is one tap away.
		return aim{}, fmt.Errorf("%w: I bound that message before this version, when I recorded only "+
			"the pane (%s) and not which agent was in it, so I cannot prove it is still the same one",
			ErrTargetReplaced, bd.Pane)
	}
	a, err := b.checkIdentity(bd.Pane, bd.identity())
	if err != nil {
		return aim{}, err
	}
	return aim{agent: a}, nil
}

// unroutedReplyNote is said when the user replied to something that carries no
// route and the message went to their selection instead.
//
// It is silent with fewer than two agents, where there is nowhere else it could
// have gone and the note would be noise on every mirrored turn they answer.
func unroutedReplyNote(m lark.Msg, list []agents.Agent) string {
	if m.ReplyToMessageID == "" || len(list) < 2 {
		return ""
	}
	return "↩️ The message you replied to is not bound to an agent — mirrored turns are streamed and " +
		"Feishu gives them no id I can register — so this went to the agent you have selected:"
}

// deliver sends prose to one agent through the only path that is safe.
//
// Controller.Say, never agent.prompt: Say presses esc first when the agent is
// blocked, because a bracketed paste at a permission dialog is discarded and
// the Enter that follows it selects the highlighted "1. Yes" — measured, with
// the pasted text being an explicit refusal (G1).
//
// NOTHING IS HELD BACK HERE, and this is where something used to be. The bridge
// kept a per-pane FIFO for prose aimed at a working agent, because Say refused
// that with ErrAgentBusy. Measured (G19/M1), a working agent ACCEPTS the text: it
// has an input queue of its own, the words land in its composer and are submitted
// as a prompt when the turn ends. The bridge's queue was therefore a second queue
// in front of the agent's, and its only observable effect was that a user who
// typed three sentences watched the bridge sit on two of them. Every message now
// goes straight through, in arrival order, for as long as the user keeps talking.
//
// THE SAFETY RULE THAT WENT WITH IT, and why its absence is not an oversight. The
// queue carried one: "if the agent is blocked when the queue drains, do not
// deliver the queued text — push a card instead", because a sentence written
// against one screen could arrive at a permission dialog that appeared while it
// waited, and prose typed at a dialog answers it (G1). That hazard was
// manufactured by the waiting. Nothing is held across a state change any more, so
// every message is delivered against the state it was written for, and the blocked
// case is handled at delivery time by Say — which escapes the dialog first,
// confirms it is gone before writing a byte, and reports that it did (G1, G2, and
// deliveryNote's Escaped line). The rule is retired because its precondition can
// no longer arise, not because it stopped mattering. Restoring any hold-and-drain
// here restores the hazard, and would need that card path restored with it.
//
// What is NOT promised is ordering between two messages that race: the larksuite
// SDK runs a goroutine per inbound frame, so two sentences a second apart reach
// this function concurrently and no lock here could pick a winner. agents.Say
// serialises per pane so that the second one SEES the first and separates itself
// from it rather than being glued to its tail (G19/M2, agents/paneLocks). A
// swapped pair is legible; a garbled merge is data loss.
func (b *bridge) deliver(ctx context.Context, chatID, replyTo string, t aim, text string) error {
	a := t.agent

	d, err := b.deps.Controller.Say(ctx, b.guardFor(a), text)
	if err != nil {
		b.log.Error("bridge: prose was not delivered", "pane", a.PaneID, "err", err)
		return afterInputAttempt(b.say(ctx, chatID, replyTo, a.PaneID, withNote(t.note, b.deliveryFailed(a, err))))
	}
	if b.tasks != nil && d.Acked {
		if err := b.tasks.AcceptInput(a.PaneID, d.Verified); err != nil {
			return afterInputAttempt(err)
		}
	}
	return afterInputAttempt(b.reportDelivery(ctx, chatID, replyTo, a, t.note, d))
}

// withNote puts the routing explanation above the delivery report, so the first
// thing read is "this did not go where you pointed" and the second is where it
// did go.
func withNote(note, report string) string {
	if note == "" {
		return report
	}
	return note + "\n" + report
}

// guardFor pins an input to the agent as it is being read right now. The
// Controller re-validates it against herdr before anything is typed, which is
// what stops a stale decision from reaching a pane that has moved on (G17).
func (b *bridge) guardFor(a agents.Agent) agents.Guard {
	return agents.Guard{
		PaneID:   a.PaneID,
		Kind:     a.Kind,
		StateSeq: a.StateSeq,
		IssuedAt: b.now(),
	}
}

// deliveryNote reports what actually happened to a prompt.
//
// Acked && !Verified is never dressed up as success (G3): agent.prompt returns
// success as soon as the bytes reach the PTY queue, and prompts sent just after
// a state change were measured being swallowed with no error at all. "Sent but
// not confirmed" is the honest description, and it is the one a user can act
// on — they go and look at the Mac.
//
// This is the full report. A clean delivery no longer reaches it on the ordinary
// path — reportDelivery folds that into one acknowledgement per burst — so every
// sentence below describes something the user has to know NOW.
func deliveryNote(a agents.Agent, d agents.Delivery) string {
	var lines []string
	// d.Escaped, not a status read from before the call: the agent can become
	// blocked between the read and Say's own check, and then Say escapes while
	// a caller-side snapshot still says it did not.
	if d.Escaped {
		lines = append(lines, fmt.Sprintf(
			"🛡️ %s was waiting for an answer, so I pressed esc first — that cancels the question "+
				"instead of answering it — and then sent your message.", agentLabel(a)))
	}

	switch {
	case d.Verified && d.Queued:
		// Delivered into the agent's own input queue rather than acted on: it was
		// mid-turn, so the text sits in its composer until the turn ends (G19/M1).
		lines = append(lines, fmt.Sprintf(
			"✅ Delivered to %s, which is mid-turn — it reads this when the current turn ends. It is now %s.",
			agentLabel(a), d.FinalStatus))
	case d.Verified:
		lines = append(lines, fmt.Sprintf("✅ Delivered to %s. It is now %s.", agentLabel(a), d.FinalStatus))
	case d.Acked:
		lines = append(lines, fmt.Sprintf(
			"⚠️ Sent to %s but not confirmed. herdr took the text, and I could not find it on the "+
				"agent's screen afterwards — it may never have reached the TUI. It is now %s; "+
				"check the Mac before assuming it arrived.", agentLabel(a), d.FinalStatus))
	default:
		lines = append(lines, fmt.Sprintf(
			"⚠️ %s did not acknowledge your message and I could not confirm it on screen. "+
				"Treat it as not sent.", agentLabel(a)))
	}

	if d.MayHaveAnsweredADialog {
		// The G1 disclosure, and the reason a delivery to a working agent can never
		// be silent. herdr's agent.prompt writes the paste and then a lone Enter
		// 300ms later; that Enter is not ours to see or cancel, and a working agent
		// can raise `Do you want to proceed? ❯ 1. Yes` inside that window, where an
		// Enter selects the highlighted default. Say refuses when it can see a
		// dialog beforehand; this says a dialog is there NOW, so one may have been
		// there during the write. The inverse does not clear it, which is why the
		// wording asks the user to look rather than reassuring them.
		lines = append(lines, fmt.Sprintf(
			"🚨 %s is showing a permission dialog now. herdr sends its own Enter 300ms after the text, "+
				"and at a dialog an Enter picks the highlighted option — so your message may have ANSWERED "+
				"a question you never saw, whatever it said. Check the Mac before trusting anything it did.",
			agentLabel(a)))
	}
	if d.Attempts > 1 {
		// Not a footnote about plumbing: this is the only sign, from the chat, that
		// the agent may be holding the same sentence twice. herdr's stall report
		// means "no state change observed", not "the text is absent" (G3) — a paste
		// in a composer the agent has not consumed changes no state — so a retry
		// can paste a second copy below the first. The newline the retry prepends
		// (G19/M2) keeps the duplicate legible on the AGENT'S screen; it does not
		// make it one instruction, and the phone cannot see that screen at all.
		// This is also why a retried delivery is never folded into a burst
		// acknowledgement (mustReportNow).
		earlier := "the earlier attempt"
		if d.Attempts > 2 {
			earlier = "the earlier attempts"
		}
		lines = append(lines, fmt.Sprintf(
			"🔁 %s: herdr reported %s stalled, which is not proof the text never arrived — %s may have "+
				"your message more than once, one copy per line. Check the Mac before trusting the result if "+
				"doing it twice would matter.", plural(d.Attempts, "attempt", "attempts"), earlier, agentLabel(a)))
	}
	return strings.Join(lines, "\n")
}

// deliveryFailed explains a Say that returned an error, in terms of what the
// user should do next.
func (b *bridge) deliveryFailed(a agents.Agent, err error) string {
	switch {
	case errors.Is(err, agents.ErrCannotUnblock):
		return fmt.Sprintf(
			"🛑 %s is still waiting for an answer after I pressed esc, so your message was NOT sent. "+
				"Text typed at an open dialog answers the dialog rather than being read, so I will not "+
				"send it while it is there. Answer the card, or /stop %s and try again.",
			agentLabel(a), a.PaneID)

	case errors.Is(err, agents.ErrPaneGone):
		return fmt.Sprintf("👋 %s is gone — the pane was closed or the agent exited. Nothing was sent.", a.PaneID)

	case errors.Is(err, agents.ErrAgentReplaced):
		return fmt.Sprintf(
			"🔄 A different agent now occupies %s, so nothing was sent. Run /ls and aim again.", a.PaneID)

	case errors.Is(err, agents.ErrGuardStale):
		return fmt.Sprintf("⌛ That decision was too old to act on, so nothing was sent to %s. Send it again.", a.PaneID)

	case errors.Is(err, agents.ErrAgentBusy):
		// No longer "it is working, I will queue it": prose to a working agent is
		// delivered (G19/M1). What is left under this sentinel is the set of states
		// that genuinely cannot take text — a managed agent still launching, a
		// status herdr reported that we cannot map, or a retry after a stall into an
		// agent that has started working again. None of them is worth parking a
		// message on: by the time such a state clears, the user has moved on, and
		// re-sending is one tap.
		//
		// THIS MAY NOT CLAIM THE MESSAGE WAS NOT SENT, and that is not hedging for
		// its own sake. The third state above is reached AFTER bytes were written:
		// Say's retry gate (agents/input.go, "the agent picked the prompt up after
		// all") only runs because attempt 1 already called agent.prompt and herdr
		// answered agent_prompt_stalled — and a stall means "no state change
		// observed", not "the text is absent" (G3, measured as routine right after
		// esc or agent.start). Nothing available here separates that case from the
		// two harmless ones: the error is one sentinel for all three, and the
		// Delivery cannot help either (Say returns the refusal before the attempt
		// count is bumped, and deliver drops the Delivery on the error path
		// regardless). So the honest report is the one that covers both, and it must
		// not end in "send it again": telling a user to re-send a command that may
		// already be sitting in a live coding agent's composer is the bridge asking
		// for the second injection that G14 cites persistent dedup to prevent —
		// the migration runs twice.
		return fmt.Sprintf(
			"⏳ %s is in a state I will not type into — herdr reports it as %q — so I could not confirm your "+
				"message was sent. It is a launch still finishing, a state herdr could not identify, or an "+
				"agent that started working again while I was retrying — and in that last case an earlier "+
				"attempt may already have left your text in its input box. Look at the Mac before sending it "+
				"again, or /stop %s if it is stuck.", agentLabel(a), a.Status, a.PaneID)

	default:
		return fmt.Sprintf("❌ Could not deliver to %s: %v", agentLabel(a), err)
	}
}

// ---------- explicit pane commands ----------

// commandSay is /say <pane> <text>: prose with the target spelled out, so it
// works when reply-routing cannot (several agents, or a message the bridge did
// not send).
func (b *bridge) commandSay(ctx context.Context, m lark.Msg, paneID, text string) error {
	a, err := b.agent(paneID)
	if err != nil {
		return b.noSuchPane(ctx, m, err)
	}
	// No identity check and no note: the user named this pane in this message,
	// so there is no remembered destination to have gone stale. The Guard the
	// Controller re-validates still pins the agent as it is being read now.
	return b.deliver(ctx, m.ChatID, m.MessageID, aim{agent: a}, text)
}

// commandStop is /stop <pane>: esc and nothing else.
//
// This is the escape hatch. Measured (G2): esc dismisses a permission dialog
// without answering it — the command it was asking about is not run and the
// agent returns to idle.
func (b *bridge) commandStop(ctx context.Context, m lark.Msg, paneID string) error {
	a, err := b.agent(paneID)
	if err != nil {
		return b.noSuchPane(ctx, m, err)
	}

	next, err := b.deps.Controller.Interrupt(ctx, b.guardFor(a))
	if err != nil {
		if errors.Is(err, agents.ErrInputUnconfirmed) {
			b.log.Warn("bridge: esc outcome was not confirmed", "pane", paneID, "err", err)
			return afterInputAttempt(b.reply(ctx, m, paneID, fmt.Sprintf("⚠️ The result of esc for %s was not confirmed. "+
				"It may already have interrupted the agent. Check the current screen before repeating the operation.", agentLabel(a))))
		}
		b.log.Error("bridge: esc was not delivered", "pane", paneID, "err", err)
		return afterInputAttempt(b.reply(ctx, m, paneID, fmt.Sprintf("❌ Could not send esc to %s: %v", agentLabel(a), err)))
	}

	// Nothing to add about held-back messages: the bridge holds none. Anything
	// the user typed is already in the agent, which is what makes esc the escape
	// hatch rather than half of one — see deliver.
	return afterInputAttempt(b.reply(ctx, m, paneID, fmt.Sprintf("⎋ esc sent to %s. It is now %s.", agentLabel(a), next.Status)))
}

// commandCard is /card <pane>: push that pane's current screen as a card.
//
// A card built for an agent that is not blocked carries buttons that will be
// refused when pressed — SendKey requires the agent to still be blocked at the
// very state sequence the card was built against (G17) — so the reply says so
// rather than letting the user discover it by pressing one.
func (b *bridge) commandCard(ctx context.Context, m lark.Msg, paneID string) error {
	a, err := b.agent(paneID)
	if err != nil {
		return b.noSuchPane(ctx, m, err)
	}

	dialog, err := b.deps.Extractor.Dialog(paneID)
	if err != nil {
		b.log.Error("bridge: could not read a pane's screen for /card", "pane", paneID, "err", err)
		return b.reply(ctx, m, paneID, fmt.Sprintf("❌ Could not read %s's screen: %v", agentLabel(a), err))
	}

	if a.Status != agents.StatusBlocked {
		if err := b.reply(ctx, m, paneID, fmt.Sprintf(
			"ℹ️ %s is %s, not waiting for an answer. Here is its screen; the buttons are pinned to the "+
				"state you are looking at, so they will refuse unless it blocks at exactly this point.",
			agentLabel(a), a.Status)); err != nil {
			return err
		}
	}
	return b.pushBlockedTo(ctx, cardTarget{ChatID: m.ChatID, ReplyTo: m.MessageID}, a, dialog)
}

// commandMirror is /mirror <pane> on|off.
//
// Off by default and per agent, because a chatty agent mirrored into a phone is
// a phone nobody reads (S2 §3.9).
func (b *bridge) commandMirror(ctx context.Context, m lark.Msg, paneID string, on bool) error {
	a, err := b.agent(paneID)
	if err != nil {
		return b.noSuchPane(ctx, m, err)
	}

	if !on {
		b.deps.Watcher.Disable(paneID)
		return b.reply(ctx, m, paneID, fmt.Sprintf("🪞 Mirroring off for %s.", agentLabel(a)))
	}

	if err := b.deps.Watcher.Enable(paneID); err != nil {
		b.log.Error("bridge: could not enable mirroring", "pane", paneID, "err", err)
		return b.reply(ctx, m, paneID, fmt.Sprintf("❌ Could not mirror %s: %v", agentLabel(a), err))
	}

	note := fmt.Sprintf("🪞 Mirroring %s from here on. History is not back-filled.", agentLabel(a))
	if len(b.deps.Registry.Snapshot()) > 1 {
		// Only worth saying with more than one agent running: with one, a bare
		// reply routes to it anyway. A mirrored turn is streamed into an edited
		// message, which Feishu gives no id, so there is nothing to register for
		// reply-routing (see pumpMirror) — and a user who replies to the answer
		// they can see would otherwise just get "which agent did you mean?".
		note += "\nReplying to a mirrored turn will not route back to it: those are streamed messages and " +
			"Feishu gives them no id I can register. Use /say " + a.PaneID + " <text>, or reply to one of my " +
			"other messages about it."
	}
	if _, ok := b.deps.Resolver.Resolve(a); !ok {
		// Not an error: claude only publishes a session id once its
		// trust-this-directory prompt has been accepted and SessionStart has
		// fired, and codex needs its hook trusted with `t` first (G8).
		note += "\nIt has no transcript yet, so nothing will appear until the agent publishes a session " +
			"— for claude that happens after you accept its trust-this-directory prompt."
	}
	return b.reply(ctx, m, paneID, note)
}

// commandClose is /close: the one way a user ends the conversation.
//
// It is the other half of Select, and the pair is what makes a selection safe
// to keep for as long as the user wants it. One deliberate act opens the
// channel; one deliberate act closes it. Nothing in between — not the clock,
// not a /clear inside the agent, not the agent exiting and coming back, not
// this bridge restarting — takes the aim away, so there is exactly one answer
// to "why am I being asked to pick again?": because you asked to be.
//
// The card the chat already has is repainted first, so the message that used to
// say "your typing goes to claude · w1:p1" stops saying it where it stands, and
// a fresh one is posted at the bottom where the user is typing. Two messages,
// deliberately: the old card is history that must not lie, the new one is the
// thing they need under their thumb.
func (b *bridge) commandClose(ctx context.Context, m lark.Msg) error {
	if b.sel == nil {
		// Nothing was ever aimed, because there is nowhere to record an aim. The
		// picker still lists what is running, which is the useful half.
		b.log.Warn("bridge: /close arrived but this bridge has no selection store", "chat_id", m.ChatID)
		return b.postPicker(ctx, m.ChatID, m.MessageID,
			"ℹ️ This bridge has nowhere to remember a selection, so nothing was aimed to begin with. "+
				"Use `/say <pane> <text>` to send a single message.")
	}

	t, had := b.currentSelection(m.ChatID)
	if !had {
		return b.postPicker(ctx, m.ChatID, m.MessageID,
			"ℹ️ This chat was not aimed at anything, so there was nothing to close.")
	}

	// forgetSelection rather than clearSelection: the id of the picker card
	// lives inside the target being destroyed, and the repaint below is what
	// stops that card from going on claiming a target this chat no longer has.
	b.forgetSelection(m.ChatID)
	b.repaintPicker(ctx, m.ChatID, b.pickerCard(m.ChatID))

	return b.postPicker(ctx, m.ChatID, m.MessageID, fmt.Sprintf(
		"👋 Closed. This chat is no longer aimed at %s, and plain text will not reach any agent until "+
			"you tap **Select** below.", targetLabel(t)))
}

// ---------- the picker ----------

// commandList is /ls: the picker card, which is the primary interface of the
// product.
//
// It replaced a plain-text list because that list could only be READ. Aiming at
// an agent afterwards cost either a long-press-and-reply or typing a pane id
// like "w1:p1" on a phone keyboard; the card makes it one tap, after which
// plain typing goes there.
func (b *bridge) commandList(ctx context.Context, m lark.Msg) error {
	return b.postPicker(ctx, m.ChatID, m.MessageID, "")
}

// postPicker sends the agent picker and remembers it as this chat's live card.
//
// preamble is the reason the picker is being shown, when it was not asked for.
// It goes in its own message because BuildAgentList is a pure function of the
// agent list and the current selection — it takes no free text, deliberately, so
// that re-rendering it in place never changes what the eye is reading.
//
// Both fallbacks land on the plain-text list rather than on nothing: a user who
// cannot see the picker still has to be able to find out what is running.
func (b *bridge) postPicker(ctx context.Context, chatID, replyTo, preamble string) error {
	notes := make([]string, 0, 2)
	if preamble != "" {
		notes = append(notes, preamble)
	}
	if b.deps.Registry.Degraded() {
		// The card cannot say this: it is a fact about herdr, not about any
		// agent, and the rows below are the last view we had (G10).
		notes = append(notes, "⚠️ herdr is not answering right now; this is the last view I had of it, "+
			"and a tap may be refused.")
	}

	card, err := b.buildPicker(chatID)
	if err != nil {
		b.log.Error("bridge: could not build the agent picker", "chat_id", chatID, "err", err)
		return b.say(ctx, chatID, replyTo, "", joinNonEmpty(append(notes[:len(notes):len(notes)], b.agentList())))
	}

	if len(notes) > 0 {
		if err := b.say(ctx, chatID, replyTo, "", joinNonEmpty(notes)); err != nil {
			return err
		}
	}

	// Deliberately unbound (PaneID ""): the picker is about every agent, so
	// binding it to one would make a reply to it aim at whichever row happened
	// to be first.
	ids, err := b.send(ctx, outgoing{ChatID: chatID, ReplyTo: replyTo, Card: card})
	if err != nil {
		b.log.Error("bridge: the agent picker was not delivered; falling back to text",
			"chat_id", chatID, "err", err)
		return b.say(ctx, chatID, replyTo, "", b.agentList())
	}
	if len(ids) > 0 {
		b.rememberPicker(chatID, ids[0])
	}
	return nil
}

func joinNonEmpty(parts []string) string {
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "\n\n")
}

// ---------- reports ----------

// agentList renders the text fallback for the picker card, and doubles as the
// answer to "which agent did you mean?" inside a longer reply.
//
// Plain text, not a markdown table: Feishu's post renderer turns a
// GitHub-style table into a blank bubble, and this is the message a lost user
// reads (S2 §3.8).
func (b *bridge) agentList() string {
	list := b.deps.Registry.Snapshot()

	var lines []string
	if b.deps.Registry.Degraded() {
		lines = append(lines, "⚠️ herdr is not answering right now; this is the last view I had of it.")
	}
	if len(list) == 0 {
		lines = append(lines, "No agents: herdr sees no pane running a coding agent.")
		return strings.Join(lines, "\n")
	}

	lines = append(lines, fmt.Sprintf("%s:", plural(len(list), "agent", "agents")))
	for _, a := range list {
		row := fmt.Sprintf("%s %s · %s · %s", statusEmoji(a.Status), a.PaneID, orUnknown(a.Kind), a.Status)
		if cwd := strings.TrimSpace(a.Cwd); cwd != "" {
			row += " · " + cwd
		}
		if title := strings.TrimSpace(a.Title); title != "" {
			row += "\n    " + title
		}
		lines = append(lines, row)
	}
	lines = append(lines, "Send /ls for the card that lets you pick one with a tap, "+
		"or /say <pane> <text> to aim a single message.")
	return strings.Join(lines, "\n")
}

// doctor answers /doctor with what the bridge can see from where it stands.
//
// It is not the whole of `herdr-agent doctor`: the environment checks that
// matter most (a CLAUDE_CODE_* variable inherited by the herdr server turns
// transcript saving off and kills mirroring, G7; the detection manifest being
// hot-updated over the network, G10) are about processes on the Mac, not about
// this bridge's dependencies, so this report names them and points at the CLI
// rather than pretending to have run them.
func (b *bridge) doctor() string {
	lines := []string{"🩺 What the bridge can see from here:"}

	if b.deps.Registry.Degraded() {
		lines = append(lines, "🛑 herdr is not answering. Nothing below is current, and no card will "+
			"reach you until it comes back. Check that `herdr server` is running.")
	} else {
		lines = append(lines, "✅ herdr is answering.")
	}

	list := b.deps.Registry.Snapshot()
	if len(list) == 0 {
		lines = append(lines, "No agents are running.")
	}
	for _, a := range list {
		lines = append(lines, fmt.Sprintf("%s %s · %s · %s", statusEmoji(a.Status), a.PaneID, orUnknown(a.Kind), a.Status))
		lines = append(lines, "    "+b.paneWidthNote(a))
		if path, ok := b.deps.Resolver.Resolve(a); ok {
			lines = append(lines, "    transcript: "+path)
		} else {
			lines = append(lines, "    transcript: none yet — the agent has not published a session id "+
				"(claude does that once you accept its trust-this-directory prompt).")
		}
		mirroring := "off"
		if b.deps.Watcher.Enabled(a.PaneID) {
			mirroring = "on"
		}
		// No queue line: there is no queue to report. A message the bridge accepted
		// is in the agent (deliver), so what would once have shown up here as
		// "2 messages waiting" is now visible on the agent's own screen.
		lines = append(lines, "    mirror: "+mirroring)
	}

	lines = append(lines,
		"Run `herdr-agent doctor` on the Mac for what I cannot check from here: the herdr server's "+
			"own environment (a CLAUDE_CODE_* variable in it turns transcript saving off and mirroring "+
			"goes silent), the agent integration hooks, and whether detection manifests are pinned.")
	return strings.Join(lines, "\n")
}

// paneWidthNote reports the one screen property that silently breaks detection.
//
// A pane herdr never attached a client to is 53 columns wide (G5). Claude's TUI
// wraps at that width, so the English strings herdr matches on to decide
// "blocked" stop matching — and an unmatched screen is reported as idle, not as
// unknown (G11). The failure is a card that never arrives.
func (b *bridge) paneWidthNote(a agents.Agent) string {
	s, err := b.deps.Extractor.Dialog(a.PaneID)
	if err != nil {
		return fmt.Sprintf("screen: could not read it (%v)", err)
	}
	if s.Narrow {
		return fmt.Sprintf("⚠️ screen: %d columns. This pane was probably never attached to a terminal; "+
			"claude's dialogs wrap at that width and herdr then reports it idle instead of blocked, "+
			"so you would stop getting cards. Attach a terminal to it once to widen it.", s.Cols)
	}
	return fmt.Sprintf("screen: %d columns", s.Cols)
}

// ---------- plumbing ----------

// noSuchPane answers a command that named a pane herdr does not know, with the
// list of the ones it does. The command is refused outright rather than
// re-aimed: the user named a terminal, and typing into a different one is the
// failure this bridge exists to prevent.
func (b *bridge) noSuchPane(ctx context.Context, m lark.Msg, err error) error {
	return b.reply(ctx, m, "", "🤷 "+err.Error()+"\n\n"+b.agentList())
}

// agent resolves a pane id the user named.
func (b *bridge) agent(paneID string) (agents.Agent, error) {
	if a, ok := b.deps.Registry.Get(paneID); ok {
		return a, nil
	}
	return agents.Agent{}, fmt.Errorf("%w: herdr has no agent at %s", ErrNoAgent, paneID)
}

// reply answers an inbound message in its own thread.
//
// paneID binds the reply for reply-routing when the message is about an agent,
// which is what lets the user answer it in prose and have that reach the same
// agent (S2 §3.5).
func (b *bridge) reply(ctx context.Context, m lark.Msg, paneID, text string) error {
	return b.say(ctx, m.ChatID, m.MessageID, paneID, text)
}

// say delivers one plain-text message and reports whether it got there.
func (b *bridge) say(ctx context.Context, chatID, replyTo, paneID, text string) error {
	if _, err := b.send(ctx, outgoing{
		ChatID:  chatID,
		ReplyTo: replyTo,
		Text:    text,
		PaneID:  paneID,
	}); err != nil {
		return fmt.Errorf("bridge: reply to %s: %w", chatID, err)
	}
	return nil
}

// statusEmoji is the glyph the CLI uses for the same status, so the phone and
// the terminal describe an agent the same way.
func statusEmoji(s agents.Status) string {
	switch s {
	case agents.StatusBlocked:
		return "🛑"
	case agents.StatusWorking:
		return "⚙️"
	case agents.StatusDone:
		return "✅"
	case agents.StatusIdle:
		return "💤"
	case agents.StatusGone:
		return "👻"
	default:
		return "❓"
	}
}

func orUnknown(kind string) string {
	if k := strings.TrimSpace(kind); k != "" {
		return k
	}
	// An agent herdr has not identified yet. Saying "unknown" beats an empty
	// column the user has to guess at.
	return "unknown"
}
