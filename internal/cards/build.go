package cards

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// errUnbuildable rejects a card that would be armed with something the
// controller must later refuse — an empty nonce, no pane, a key outside the
// allowlist. Failing here beats posting a card whose every button answers
// ErrBadDecision to a user who is watching an agent sit blocked.
var errUnbuildable = errors.New("cards: card cannot be built")

// stampLayout renders a wall-clock time with its zone, because a card is read
// hours later by a human who needs to know whether "01:23" was this morning.
const stampLayout = "2006-01-02 15:04:05 MST"

// ParseOptions extracts the numbered choices from the dialog region.
//
// The count is read from the screen rather than hardcoded because it varies by
// agent and by version: Claude's Bash permission prompt shows three, its
// trust-directory prompt two, codex two of its own. When nothing parses the
// result is empty and BuildBlocked degrades to Esc plus an instruction to
// reply in prose, which is the only honest answer — a guessed button sends a
// real keystroke to a live agent.
func ParseOptions(s screen.Screen) []Option {
	return parseOptions(s.Lines)
}

// BuildBlocked renders the actionable card for an agent that is waiting.
//
// Every button carries a full Decision, so the callback needs no server-side
// state to route (the pane id comes back verbatim, measured G16) and can be
// re-checked against the agent as it is at press time. That is the fix for the
// loaded gun in the chat history: Feishu messages never expire, and a card
// from three days ago would otherwise still deliver a keystroke into whatever
// occupies that pane today (G17).
//
// now is the issue time recorded in every Decision; agents.MaxGuardAge is
// measured from it.
func BuildBlocked(a agents.Agent, s screen.Screen, opts []Option, nonce string, now time.Time) (string, error) {
	if a.PaneID == "" {
		return "", fmt.Errorf("%w: no pane id", errUnbuildable)
	}
	if nonce == "" {
		// A card without a nonce cannot be consumed exactly once, and
		// DecodeDecision refuses it on the way back. Never post one.
		return "", fmt.Errorf("%w: no nonce for %s", errUnbuildable, a.PaneID)
	}

	buttons := make([]buttonElement, 0, len(opts)+1)
	for _, o := range opts {
		if !slices.Contains(agents.AllowedKeys, o.Key) {
			return "", fmt.Errorf("%w: option key %q for %s is not in agents.AllowedKeys",
				errUnbuildable, o.Key, a.PaneID)
		}
		buttons = append(buttons, newButton(buttonText(o), btnNeutral, decision(a, o.Key, nonce, now)))
	}
	// Esc is always offered and always last: it is the measured safe exit from
	// a permission dialog — the command is not run and the agent returns to
	// idle (G2) — and danger styling keeps the eye off the approval buttons.
	buttons = append(buttons, newButton("Esc · back out", btnDanger, decision(a, "esc", nonce, now)))

	elements := []any{newMarkdown("%s", codeBlock(dialogText(s)))}
	if s.Cropped {
		elements = append(elements, newMarkdown(
			"_Long lines were cropped to phone width, not wrapped._"))
	}
	if s.Narrow {
		elements = append(elements, newMarkdown("%s", narrowWarning(s.Cols)))
	}
	if len(opts) == 0 {
		elements = append(elements, newMarkdown(
			"**No numbered options could be read off this screen.** Press **Esc** to back "+
				"out, or reply to this message in plain words — prose goes through the safe "+
				"path (esc first), so it can never become an approval."))
	}
	elements = append(elements,
		newColumnSet(buttons),
		// Select sits in a row of its own, below the answer buttons. It is the
		// one button here that sends nothing, and the shortest path from a
		// notification to a conversation: tap it, then just type — no reply,
		// no pane id. Keeping it out of the answer row also keeps a thumb
		// reaching for it away from "1. Yes" (G1).
		//
		// Its value is inert: no key, no nonce. A consumer MUST branch on
		// Decision.Inert() BEFORE the ActKey pipeline. Sending this press down
		// that pipeline instead would consume a dedup entry keyed on the empty
		// string, hand SendKey an empty key — refused — and then replace this
		// card with the disarmed one, taking the numbered buttons away from an
		// agent that is still sitting at the question. A press whose entire
		// purpose is "I am about to type" must leave the card exactly as armed
		// as it found it.
		newColumnSet([]buttonElement{
			newButton(selectAndTypeText, btnNeutral, inertDecision(a, ActSelect, now)),
		}),
		newMarkdown("%s", selectNote(a)),
		newMarkdown("pane `%s` · seq %d · issued %s · buttons stop working after %s",
			a.PaneID, a.StateSeq, now.Format(stampLayout), agents.MaxGuardAge),
	)

	return render(card{
		Schema: schemaVersion,
		Config: cardConfig{
			UpdateMulti: true,
			Summary:     &cardSummary{Content: truncate(summary(a), maxSummary)},
		},
		Header: newHeader(headline(a), subtitle(a), templateBlocked),
		Body:   cardBody{Elements: elements},
	}, "blocked")
}

// BuildResolved renders the disarmed replacement posted once a press has been
// honoured. It has no buttons at all — that is the point of it — and it says
// who pressed what, when, and what came of it, so the chat history reads as a
// record instead of a row of buttons that look pressable forever (G17).
func BuildResolved(a agents.Agent, d Decision, operator, outcome string, at time.Time) (string, error) {
	outcome = fallback(outcome, "not reported")
	elements := []any{
		newMarkdown("**Sent** `%s` to `%s`", d.Key, d.Pane),
		newMarkdown("**By** %s · **at** %s", fallback(operator, "an unknown operator"), at.Format(stampLayout)),
		newMarkdown("**Outcome** %s", outcome),
		newMarkdown("_This card is spent: its buttons are gone and it can no longer send anything._"),
		newMarkdown("%s", provenance(d)),
	}
	return render(card{
		Schema: schemaVersion,
		Config: cardConfig{
			UpdateMulti: true,
			Summary:     &cardSummary{Content: truncate(fmt.Sprintf("handled · %s · %s", d.Pane, outcome), maxSummary)},
		},
		Header: newHeader(headline(a), "handled", templateResolved),
		Body:   cardBody{Elements: elements},
	}, "resolved")
}

// BuildExpired renders the disarmed replacement for a press that was refused.
//
// It exists so that a rejection is visible rather than silent: the user tapped
// something and must be told that nothing reached the agent, and why.
func BuildExpired(d Decision, reason string) (string, error) {
	reason = fallback(reason, "this card is no longer valid")
	elements := []any{
		newMarkdown("**`%s` was NOT sent to `%s`.**", d.Key, d.Pane),
		newMarkdown("**Why** %s", reason),
		newMarkdown("_Nothing reached the agent. Ask again with a fresh card (`/card %s`) if you still want this._", d.Pane),
		newMarkdown("%s", provenance(d)),
	}
	return render(card{
		Schema: schemaVersion,
		Config: cardConfig{
			UpdateMulti: true,
			Summary:     &cardSummary{Content: truncate(fmt.Sprintf("ignored · %s · %s", d.Pane, reason), maxSummary)},
		},
		Header: newHeader(expiredHeadline(d), "no key was sent", templateExpired),
		Body:   cardBody{Elements: elements},
	}, "expired")
}

// DecodeDecision converts a card callback value back into a Decision.
//
// It is strict on purpose. This map is the only thing standing between a tap
// in a chat window and a keystroke in a live terminal, so a value that is not
// exactly what a builder here wrote is rejected rather than repaired: a
// repaired decision would be a decision the user never made. Age, kind and
// sequence are checked later by agents.Guard against the agent's current
// state; what is checked here is that the fields exist and mean something at
// all.
//
// The three acts are not equally dangerous and are not checked equally. ActKey
// produces a keystroke in a live terminal and keeps every rule it ever had.
// The inert acts produce no input at all — ActSelect moves a pointer in the
// bridge's own selection store, ActScreen re-reads the visible and detection
// buffers, neither of which puts a byte into the pane (the read that WOULD,
// herdr's alt-screen scroll synthesis, is out of bounds for this bridge, G9) —
// so the two rules that exist to make a keystroke single-use and legal (a
// nonce, a key from the allowlist) have nothing to protect there. Demanding
// them anyway would only mean an old picker card, whose nonce is long spent,
// could no longer be used to re-aim typing: a refusal with no safety behind it.
func DecodeDecision(v map[string]any) (Decision, error) {
	if v == nil {
		return Decision{}, fmt.Errorf("cards: empty card value: %w", ErrBadDecision)
	}

	act, err := str(v, "act", true)
	if err != nil {
		return Decision{}, err
	}
	if act != ActKey && act != ActSelect && act != ActScreen {
		return Decision{}, fmt.Errorf("cards: act %q is not one of %q, %q, %q: %w",
			act, ActKey, ActSelect, ActScreen, ErrBadDecision)
	}
	// Inert() is the contract's own definition of "sends nothing", so the
	// relaxations below cannot drift away from what the bridge acts on.
	inert := Decision{Act: act}.Inert()

	key, err := str(v, "key", !inert)
	if err != nil {
		return Decision{}, err
	}
	switch {
	case !inert && !slices.Contains(agents.AllowedKeys, key):
		return Decision{}, fmt.Errorf("cards: key %q is not in agents.AllowedKeys: %w", key, ErrBadDecision)
	case inert && key != "":
		// An inert act carrying a sendable key is a contradiction: nothing here
		// wrote it, and a Decision that says "sends nothing" while holding a key
		// is exactly the shape a later caller could send by mistake.
		return Decision{}, fmt.Errorf("cards: act %q carries key %q but sends nothing: %w",
			act, key, ErrBadDecision)
	}

	pane, err := str(v, "pane", true)
	if err != nil {
		return Decision{}, err
	}
	// Kind may legitimately be empty: an agent that herdr has not finished
	// detecting has none (G8). It is not validated here because the Guard
	// compares it against the live agent, and a second, weaker copy of that
	// rule here could only ever disagree with the real one.
	kind, err := str(v, "kind", false)
	if err != nil {
		return Decision{}, err
	}
	nonce, err := str(v, "n", !inert)
	if err != nil {
		return Decision{}, err
	}
	if inert && nonce != "" {
		// The mirror of the key rule above, for the same reason. Nothing in this
		// package writes a nonce onto an inert button, so a value carrying one
		// was not written here — and a consumer that spends whatever nonce it is
		// handed would spend a live blocked card's single use on a press that
		// sends nothing, disarming the buttons the agent is still waiting on.
		return Decision{}, fmt.Errorf("cards: act %q carries a nonce but sends nothing: %w",
			act, ErrBadDecision)
	}
	// Session is herdr's value, so only its length is ours to judge; see
	// maxSessionID. It is absent for an agent herdr has not issued a ref for
	// yet, which is a normal state rather than an error (G8).
	session, err := str(v, "sid", false)
	if err != nil {
		return Decision{}, err
	}
	if n := utf8.RuneCountInString(session); n > maxSessionID {
		return Decision{}, fmt.Errorf("cards: %q is %d runes, want at most %d: %w",
			"sid", n, maxSessionID, ErrBadDecision)
	}

	// seq and iat stay required for every act, inert included: every builder in
	// this package writes both, so a value missing one was not written here.
	// They also remain meaningful for a selection — they say which state of the
	// agent the row the user tapped was drawn against.
	seq, err := integer(v, "seq", true)
	if err != nil {
		return Decision{}, err
	}
	iat, err := integer(v, "iat", true)
	if err != nil {
		return Decision{}, err
	}
	if iat == 0 {
		// Unix second zero is 1970: not a card this bridge ever issued, and an
		// unset IssuedAt would look ancient to the Guard for the wrong reason.
		return Decision{}, fmt.Errorf("cards: %q is zero: %w", "iat", ErrBadDecision)
	}

	return Decision{
		Act:      act,
		Key:      key,
		Pane:     pane,
		Kind:     kind,
		Seq:      seq,
		IssuedAt: int64(iat),
		Nonce:    nonce,
		Session:  session,
	}, nil
}

// Button texts on the picker.
//
// They are short because a phone renders four words per button before it starts
// eliding, and the card carries one explanatory line for all of them rather
// than repeating the explanation on every row.
const (
	selectText   = "Select"
	selectedText = "✓ Selected"
	screenText   = "Screen"
	// selectAndTypeText is the same action on a blocked card, where there is no
	// hint line and the button has to explain itself.
	selectAndTypeText = "Select · then just type"
)

// currentMarker prefixes the selected row. The button style says the same
// thing, but style alone is a colour difference on a small screen: the marker
// survives a glance, a grey-scale screenshot and a user who is not looking
// closely — and getting this wrong means typing into the wrong agent.
const currentMarker = "▶"

// BuildAgentList renders the agent picker. This is the PRIMARY interface of the
// product.
//
// The reason it exists is measured in taps, not in features. Typing is the one
// thing a phone is good at; everything else costs a long-press or a pane id
// typed by hand, and the common case is several turns with ONE agent rather
// than round-robin across five. So the card carries the interaction: one row
// per agent, a select button that aims plain typing at it, and a screen button
// for a look at what it is doing. Slash commands stay available underneath as
// an escape hatch.
//
// Every button is inert — nothing on this card can reach an agent's keyboard —
// which is why the rows carry no nonce and why the card is never disarmed. It
// is re-rendered in place instead (config.update_multi, S2 §3.6 uses the same
// mechanism to disarm), so switching agents is one tap on a card the user
// already has rather than another /ls.
//
// It is therefore a pure function of (list, current) apart from one footer
// line: anything else that moved with the clock would rewrite the card in the
// user's chat every time a selection changed.
//
// current is the pane id of the chat's current target, or "" for none.
func BuildAgentList(list []agents.Agent, current string, now time.Time) (string, error) {
	rows, unaddressable := listable(list)

	elements := make([]any, 0, 3*len(rows)+3)
	if len(rows) == 0 {
		elements = append(elements, newMarkdown("%s", noAgentsText()))
	}
	for i, a := range rows {
		if i > 0 {
			elements = append(elements, newHR())
		}
		isCurrent := a.PaneID == current
		elements = append(elements,
			newMarkdown("%s", agentRow(a, isCurrent)),
			newColumnSet([]buttonElement{
				selectButton(a, isCurrent, now),
				newButton(screenText, btnNeutral, inertDecision(a, ActScreen, now)),
			}),
		)
	}
	if unaddressable > 0 {
		// Silently dropping them would leave the user hunting for an agent the
		// bridge can see and they cannot; this at least names the gap.
		elements = append(elements, newMarkdown(
			"_%d agent(s) herdr reported are not listed: they arrived without a pane id, or with a "+
				"state sequence too large to put in a button, so there is no way to aim anything at them._",
			unaddressable))
	}
	if len(rows) > 0 {
		elements = append(elements, newMarkdown("%s", listHint))
	}
	// The one line that moves with the clock. It is last, so a re-render that
	// changes nothing else changes nothing the eye is reading.
	elements = append(elements, newMarkdown("_as of %s · `/help` for commands_", now.Format(stampLayout)))

	return render(card{
		Schema: schemaVersion,
		Config: cardConfig{
			UpdateMulti: true,
			Summary:     &cardSummary{Content: truncate(listSummary(rows), maxSummary)},
		},
		Header: newHeader(listHeadline(len(rows)), aimLine(rows, current), templateList),
		Body:   cardBody{Elements: elements},
	}, "agent list")
}

// listHint teaches the interaction once, on the card that is the interaction.
//
// The esc clause is not a detail. Blocked agents sort FIRST here, so Select is
// most likely to be tapped on exactly the row where typing has a consequence
// the user did not ask for: Controller.Say cancels the pending dialog before it
// submits prose, because prose typed at a menu is discarded and the Enter
// behind it approves the highlighted default (G1, G2).
const listHint = "Tap **Select** to aim your typing at an agent: after that, plain text goes " +
	"there — no reply, no pane id. If that agent is waiting at a question, the first thing you " +
	"type backs out of the question first (esc), so nothing gets approved. " +
	"**Screen** shows what it is looking at right now. " +
	"Replying to a message still wins for that one message."

// listable drops what cannot be offered and puts what is left in the order the
// list exists for. The second return is how many rows were dropped for want of
// an address, which the card admits rather than hides.
//
// Three things are dropped, and only the first two are counted:
//
//   - No pane id. The pane is the address the press comes back with, and
//     routing needs nothing else (G16). herdr keys its agents by pane id so this
//     should never happen.
//   - A state sequence at or past the largest integer a JSON float64 holds
//     exactly. Such a button is undecodable by construction — DecodeDecision
//     refuses the value on the way back — and arming one only produces a press
//     that gets refused. This is the same class of check as BuildBlocked's
//     nonce and key checks: refuse to draw a button that must later be refused.
//   - StatusGone. A gone agent has nothing to select and nothing to show; it is
//     not counted because it is not a gap in the list, it is an agent that
//     stopped existing. Registry.Snapshot never returns one — only a caller
//     building a list out of transitions can — and a gone selection is already
//     explained by aimLine. Dropping it also removes the only source of the
//     synthesised MaxUint64-n sequence the check above exists for.
//
// The sort is what makes this a tool for finding the agent that needs a human:
// blocked first (something is stopped until you answer), then done (finished,
// and `done` is the one status herdr derives without a regex, so it is the
// signal we trust most, G11), then working, then idle. Pane id breaks ties so
// two renders of the same set are the same card.
func listable(list []agents.Agent) (rows []agents.Agent, unaddressable int) {
	rows = make([]agents.Agent, 0, len(list))
	for _, a := range list {
		switch {
		case a.Status == agents.StatusGone:
			continue
		case strings.TrimSpace(a.PaneID) == "", a.StateSeq >= maxSafeInt:
			unaddressable++
		default:
			rows = append(rows, a)
		}
	}
	slices.SortStableFunc(rows, func(x, y agents.Agent) int {
		if c := statusRank(x.Status) - statusRank(y.Status); c != 0 {
			return c
		}
		return strings.Compare(x.PaneID, y.PaneID)
	})
	return rows, unaddressable
}

func statusRank(s agents.Status) int {
	switch s {
	case agents.StatusBlocked:
		return 0
	case agents.StatusDone:
		return 1
	case agents.StatusWorking:
		return 2
	case agents.StatusIdle:
		return 3
	case agents.StatusUnknown:
		return 4
	default:
		// Whatever a later herdr invents, last: it is not a state this build
		// knows how to talk to. StatusGone never reaches here — listable drops
		// it, because selecting a gone agent is the one thing that cannot work.
		return 5
	}
}

// statusEmoji is the leading glyph of a row. Red is reserved for blocked, the
// only status that means a machine is stopped until a human answers (G1).
func statusEmoji(s agents.Status) string {
	switch s {
	case agents.StatusBlocked:
		return "🔴"
	case agents.StatusDone:
		return "✅"
	case agents.StatusWorking:
		return "⏳"
	case agents.StatusIdle:
		return "💤"
	case agents.StatusGone:
		return "⚫"
	default:
		return "❔"
	}
}

// agentRow is the two lines above one row's buttons: what the agent is and
// where it lives, then its address, its state and what it says it is doing.
//
// The status word is printed beside the emoji rather than instead of it: a
// glyph is scannable but not readable, and "blocked" is the word the rest of
// the product — and every error message the user will ever see — uses.
func agentRow(a agents.Agent, current bool) string {
	head := fmt.Sprintf("%s **%s**", statusEmoji(a.Status), fallback(a.Kind, "agent"))
	if base := cwdBase(a.Cwd); base != "" {
		head += " · " + base
	}
	if current {
		head = currentMarker + " " + head
	}

	detail := fmt.Sprintf("`%s` · %s", a.PaneID, fallback(string(a.Status), string(agents.StatusUnknown)))
	if t := taskTitle(a); t != "" {
		detail += " · " + truncate(t, maxRowTitle)
	}
	return head + "\n" + detail
}

// selectButton is the whole point of the card.
//
// On the current row it states a fact instead of inviting a tap that would do
// nothing visible — but it stays pressable, and deliberately so: a selection
// expires (selection.TTL), and re-confirming the row that already looks
// selected must be the thing that renews it, not a no-op.
func selectButton(a agents.Agent, current bool, now time.Time) buttonElement {
	text, style := selectText, btnNeutral
	if current {
		text, style = selectedText, btnCurrent
	}
	return newButton(text, style, inertDecision(a, ActSelect, now))
}

func listHeadline(n int) string {
	switch n {
	case 0:
		return "no agents"
	case 1:
		return "1 agent"
	default:
		return fmt.Sprintf("%d agents", n)
	}
}

// aimLine is the header subtitle: where the next thing you type will go. It is
// the first line of the card a reader's eye lands on, and it answers the only
// question the picker exists to answer.
//
// It searches the RENDERED rows, not the caller's list, which is what keeps it
// honest: listable has already dropped everything that cannot be talked to, so
// a selection pointing at one of those falls through to the line below rather
// than promising a destination the row's own ⚫ contradicts and delivery would
// refuse with ErrPaneGone.
func aimLine(rows []agents.Agent, current string) string {
	if strings.TrimSpace(current) == "" {
		if len(rows) == 0 {
			return "nothing to talk to yet"
		}
		return "nothing selected — tap Select to aim your typing"
	}
	for _, a := range rows {
		if a.PaneID == current {
			return "your typing goes to " + headline(a)
		}
	}
	// The selection outlives the agent: selection.TTL is 12 hours and an agent
	// can exit in a minute. Saying so beats a card that quietly marks no row.
	return fmt.Sprintf("%s is gone — nothing is selected", current)
}

// listSummary is the notification-bar preview, where the card itself is not
// rendered at all. It leads with the number that would make someone open it.
func listSummary(rows []agents.Agent) string {
	if len(rows) == 0 {
		return "no agents are running"
	}
	blocked := 0
	for _, a := range rows {
		if a.Status == agents.StatusBlocked {
			blocked++
		}
	}
	if blocked == 0 {
		return listHeadline(len(rows))
	}
	return fmt.Sprintf("%s · %d waiting for you", listHeadline(len(rows)), blocked)
}

// noAgentsText is the empty list. An empty card that just said "none" would
// read as a failure of the bridge, when in v1 it is the expected state until
// the user starts an agent themselves — the bridge does not start them.
func noAgentsText() string {
	return fmt.Sprintf("**No agent is running right now.**\n"+
		"Start one on the Mac: open a pane in herdr, `cd` into the project and run `claude` or "+
		"`codex`. This bridge does not start agents.\n"+
		"It re-reads herdr every %s, so a new agent appears here on its own — send `/ls` for a "+
		"fresh list. Give the pane a real terminal at least once: a pane nothing ever attached to "+
		"is 53 columns wide, and at that width herdr stops recognising claude's permission prompts "+
		"and reports `idle` instead of asking you.", agents.DefaultPollInterval)
}

// decision is the value one button carries back.
//
// All the buttons of one card share a nonce: a card is a single question, so
// the first press of any button consumes the whole thing. Pressing a second
// button afterwards is refused for the same reason pressing the same one twice
// is (G17).
func decision(a agents.Agent, key, nonce string, now time.Time) Decision {
	return Decision{
		Act:      ActKey,
		Key:      key,
		Pane:     a.PaneID,
		Kind:     a.Kind,
		Seq:      a.StateSeq,
		IssuedAt: now.Unix(),
		Nonce:    nonce,
	}
}

// inertDecision is the value behind a button that sends nothing: select and
// screen.
//
// It carries no nonce, because there is no single use to enforce — nothing it
// can do to the agent happens at all — and a nonce here would be consumed by
// the first tap, disarming the numbered buttons of the very card the user is
// still deciding on.
//
// It DOES carry the session, and that is the point of the field. A pane id is
// a seat, not an identity: claude can exit and codex start in the same pane, so
// a selection that remembered only the seat would silently aim tomorrow's
// typing at whoever is sitting there now (G8, G17). Kind and Session are what
// the bridge re-checks before every delivery.
//
// That re-check only has teeth when herdr issued a ref, and for a coding agent
// it usually has not yet: codex yields None until the user presses `t` inside
// codex to trust the hook, and claude has none until the trust-directory prompt
// is accepted (G8). With Session empty the check degrades to pane+kind — which a
// replacement of the SAME kind in the same seat satisfies, and typing into it
// lands in a different context that can execute what it reads. No card value can
// close that: there is no identity to record. The consumer has to, and this
// package's other output is what it needs to do it —
//
//  1. clear every selection for a pane the moment the Registry reports it
//     `→ Gone` (exactly one such transition per disappearance), which catches
//     the same-kind replacement without needing a ref at all;
//  2. re-read the live agent at select time and store ITS kind and ref rather
//     than the card's, refusing the press when the card's kind no longer
//     matches;
//  3. keep refusing at delivery time when a stored non-empty Session differs
//     from the live one.
//
// What is left after all three is a replacement that happens while the bridge is
// down, to an agent that never had a ref. Nothing observes that, here or
// anywhere else in this program.
func inertDecision(a agents.Agent, act string, now time.Time) Decision {
	return Decision{
		Act:      act,
		Pane:     a.PaneID,
		Kind:     a.Kind,
		Seq:      a.StateSeq,
		IssuedAt: now.Unix(),
		Session:  sessionID(a),
	}
}

// sessionID is the agent's native session ref, when herdr has issued one.
//
// A ref longer than DecodeDecision accepts is dropped rather than truncated: a
// truncated id would never again equal the live one, so every delivery would
// be refused for a reason no message could explain, whereas an absent one
// degrades to the pane+kind check that an agent without a ref yet already
// lives with (G8).
func sessionID(a agents.Agent) string {
	if a.SessionRef == nil {
		return ""
	}
	v := strings.TrimSpace(a.SessionRef.Value)
	if utf8.RuneCountInString(v) > maxSessionID {
		return ""
	}
	return v
}

// buttonText is what the user actually reads before tapping.
func buttonText(o Option) string {
	if o.Label == "" {
		return o.Key
	}
	return o.Key + ". " + truncate(o.Label, maxButtonLabel)
}

// dialogText is the screen as the screen package cropped it, or an admission
// that there was nothing to show. An empty code block would read as "the agent
// is asking nothing", which is never why this card exists.
func dialogText(s screen.Screen) string {
	if strings.TrimSpace(s.Text()) == "" {
		return "(herdr returned no screen content for this pane)"
	}
	return s.Text()
}

// narrowWarning is required whenever the pane is narrow (G5, G11): such a pane
// was never attached by a terminal client, so herdr gave it 53 columns, at
// which width Claude's TUI wraps and the English strings its blocked detection
// matches on stop matching — and herdr then reports `idle` rather than
// `unknown`, silently. The dialog below may be partial, or the agent may be
// blocked without the bridge ever hearing about it.
//
// cols <= 0 is not a measurement. screen.Clean derives Cols from the widest
// line it saw, so a pane herdr returned nothing for reports 0 — and therefore
// Narrow, deliberately failing safe. Printing "only 0 columns wide" as a fact
// on the one line of the card that asks the user to distrust what they see
// would be inventing the very evidence we are warning about the absence of.
func narrowWarning(cols int) string {
	lead := fmt.Sprintf("**This pane is only %d columns wide** — nothing has ever attached "+
		"a terminal to it", cols)
	if cols <= 0 {
		lead = "**This pane's width is unknown** — herdr returned no screen content to measure"
	}
	return "⚠️ " + lead + ". At the 53 columns herdr gives an unattached pane, Claude's TUI " +
		"wraps and herdr's blocked detection stops matching: it then reports `idle` and says " +
		"nothing. Treat the screen above as possibly incomplete."
}

// selectNote explains the button that sends nothing, and warns about the one
// side effect of using it.
//
// This card is the shortest path from a phone notification to a conversation, so
// its Select is the select most likely to be tapped — and it is tapped on an
// agent that is, by the nature of this card, usually sitting at a question. The
// warning belongs here rather than in the delivery report: Controller.Say sends
// esc BEFORE prose, because text typed at a menu is discarded and the Enter that
// follows selects the highlighted default, which is usually "1. Yes" (G1, G2).
// Nothing gets approved, but the question the agent asked disappears, and
// Delivery.Escaped only says so afterwards. The user has to know before they
// type, on the card that invited them to type.
//
// /card posts this same card for an agent that is not waiting at anything
// (bridge commandCard), and there the warning would be a claim about a dialog
// that is not on screen, so it is stated only when the agent is really blocked.
func selectNote(a agents.Agent) string {
	note := "**Select · then just type** aims your typing at this agent — no reply, no pane id. " +
		"The button itself sends nothing."
	if a.Status != agents.StatusBlocked {
		return note
	}
	return note + " This agent is waiting at the question above, so the first thing you type " +
		"backs out of that question (esc) before it is delivered: nothing above gets approved, " +
		"but the question does go away."
}

// headline names the agent: kind, the last element of its cwd, and the pane.
func headline(a agents.Agent) string {
	parts := []string{fallback(a.Kind, "agent")}
	if base := cwdBase(a.Cwd); base != "" {
		parts = append(parts, base)
	}
	if a.PaneID != "" {
		parts = append(parts, a.PaneID)
	}
	return strings.Join(parts, " · ")
}

func expiredHeadline(d Decision) string {
	parts := []string{fallback(d.Kind, "agent")}
	if d.Pane != "" {
		parts = append(parts, d.Pane)
	}
	return strings.Join(parts, " · ")
}

// taskTitle is the agent's own summary of what it is doing, or "" when it has
// none worth showing. For claude that is a real task description ("Create
// hello.txt with touch"); for codex terminal_title_stripped is only the cwd,
// which every caller already prints beside it (G8).
func taskTitle(a agents.Agent) string {
	t := collapse(a.Title)
	if t == "" || t == cwdBase(a.Cwd) {
		return ""
	}
	return t
}

// collapse folds every run of whitespace, a newline included, into one space.
//
// Title is text the AGENT writes from model output (terminal_title_stripped,
// G8), and cwd is a path a user chose; both are concatenated into a picker row's
// markdown. A newline inside one becomes a new line INSIDE that element, and the
// buttons of the row live in a separate element below it — so a title such as
// "x\n▶ 💤 **codex** · herdr-probe2" draws a row that carries the
// current-selection marker and names an agent the buttons underneath do not
// point at. On this card that decides where the next thing the user types goes.
// parse.go's label() already does exactly this to button labels.
func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

// subtitle is the one line under a blocked card's headline.
func subtitle(a agents.Agent) string {
	if t := taskTitle(a); t != "" {
		return t
	}
	return "waiting for an answer"
}

func summary(a agents.Agent) string {
	return fmt.Sprintf("%s is waiting: %s", fallback(a.Kind, "agent"), subtitle(a))
}

// provenance restates what the card was issued against, so a rejected or spent
// card still explains itself.
//
// IssuedAt is a unix second and carries no zone, so it is rendered in the
// bridge's local zone — the same zone the caller's own timestamps arrive in.
// One card must not print one instant in two zones: BuildBlocked's footer says
// when the card was issued and BuildResolved says when it was pressed, both as
// the caller passed them, and a UTC provenance line beside them would read as a
// different moment. stampLayout names the zone, so nothing is left to guess.
func provenance(d Decision) string {
	return fmt.Sprintf("pane `%s` · kind `%s` · seq %d · card issued %s",
		d.Pane, fallback(d.Kind, "unknown"), d.Seq,
		time.Unix(d.IssuedAt, 0).Local().Format(stampLayout))
}

func cwdBase(cwd string) string {
	if strings.TrimSpace(cwd) == "" {
		return ""
	}
	base := filepath.Base(filepath.Clean(cwd))
	if base == "." || base == string(filepath.Separator) {
		return ""
	}
	// A directory name may legally contain a newline; see collapse.
	return collapse(base)
}

func fallback(s, or string) string {
	if strings.TrimSpace(s) == "" {
		return or
	}
	return s
}
