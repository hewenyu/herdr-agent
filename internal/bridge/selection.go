package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/selection"
)

// ErrTargetReplaced reports that the agent a route or a selection was recorded
// against is not the agent sitting in that pane now — or that the bridge cannot
// prove it is.
//
// It is a separate sentinel from ErrNoAgent because the two need different
// answers. "No agent" is a fact about herdr; this one is a fact about US: we
// remembered a destination and it stopped being the destination we remembered.
// A pane id is a SEAT, not an identity (G8): select claude at w1:p1, walk away,
// claude exits, codex starts in the same pane — routing on the seat alone puts
// the next thing typed into a different context, and text typed at an agent
// that happens to be sitting at a permission dialog answers that dialog (G1).
var ErrTargetReplaced = errors.New("the agent that was there has been replaced")

// ErrTargetGone reports that herdr has no agent at that pane right now.
//
// Separate from ErrTargetReplaced because the two are opposite situations for
// the person reading them, and only one of them is a reason to stop. "Replaced"
// means somebody else is sitting in that seat: the thing you picked is
// provably not what is there. "Gone" means nothing is there — the agent exited,
// the pane was closed, or it has not been started back up yet — and the honest
// thing to say is "not right now", not "pick again". A chat aimed at a claude
// that is currently not running is still aimed at it; start claude back up in
// that pane and typing resumes, which is what a person expects from a
// conversation they never closed.
var ErrTargetGone = errors.New("there is no agent at that pane right now")

// standingFailure marks a refusal that came from the chat's STANDING selection
// rather than from a reply-to binding.
//
// The two need opposite answers and the sentinel inside them cannot tell them
// apart. A refused reply is one message that could not be aimed where the user
// pointed it, and the right next step is the picker. A refused STANDING target
// is the conversation the chat is in the middle of: the right next step is to
// say what happened and leave the aim exactly where it is, because posting a
// picker there is indistinguishable from "pick your agent again", which is the
// complaint this whole wave answers.
type standingFailure struct{ err error }

func (e standingFailure) Error() string { return e.err.Error() }
func (e standingFailure) Unwrap() error { return e.err }

// fromStanding reports whether a routing error came from the chat's selection.
func fromStanding(err error) bool {
	var sf standingFailure
	return errors.As(err, &sf)
}

// maxSessionID bounds a session id the same way the cards package does.
//
// The two MUST agree. A selection made by pressing a card carries the session
// id that cards put in the button, and it is compared here against the live
// agent's: if one side dropped an over-long id and the other kept it, that
// agent's selection could never match and every message to it would be refused
// for a reason no reply could explain.
const maxSessionID = 256

// ---------- identity ----------

// sessionID is the agent's native session id, as this bridge records and
// compares it.
//
// Empty means "herdr has published no session for this pane". That is a real,
// normal state and not an error: claude only publishes one once its
// trust-this-directory prompt is accepted and SessionStart fires, and codex
// needs its hook trusted with `t` first (G8).
//
// An over-long id is dropped rather than truncated, matching cards.sessionID: a
// truncated id would never again equal the live one.
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

// identity is what the bridge recorded about an agent, so that a destination it
// remembers can be CHECKED before it is delivered to rather than merely aimed
// at.
//
// Kind and Session are what the agent IS. Cwd is the one further discriminator
// agents.Agent carries, and it is consulted only in the window where the
// session cannot discriminate at all (see matches). Empty Cwd means "this
// record has no cwd", not "the agent had none" — selection.Target is a frozen
// contract with no field for one — so it refutes nothing.
type identity struct {
	Kind    string
	Session string
	Cwd     string
}

// identityOf reads the identity of a live agent, which is the only place any
// identity may be recorded from: a card can be days old, and what has to match
// later is what is in the pane now (G8, G17).
func identityOf(a agents.Agent) identity {
	return identity{Kind: a.Kind, Session: sessionID(a), Cwd: a.Cwd}
}

// matches reports whether the agent in the pane right now is the one that was
// recorded.
//
// Identity here is pane + KIND + CWD. The native session id is recorded for
// diagnosis and deliberately NOT compared, which is a retraction: comparing it
// made the selection unusable in practice.
//
// Two guards exist in this bridge and they are not the same guard. A KEYSTROKE
// needs a tight one — cards.Decision carries state_change_seq and SendKey
// refuses anything staler, because a three-day-old card would otherwise answer
// whatever dialog is up today (G17). A CONVERSATIONAL TARGET needs a STABLE
// one: "the claude in ~/project" is what a person means by picking an agent,
// and it stays true across a /clear, across a compaction, and across that agent
// being restarted in the same directory. Holding the target to keystroke-grade
// identity is what this function used to do, and the result was that a session
// id — the most volatile field herdr exposes — silently ended the conversation:
//
//   - claude publishes its session id only after SessionStart, which for a new
//     directory is only after the trust prompt is accepted (G8). Tapping Select
//     before that records an empty session; minutes later herdr has one, the
//     comparison fails, and the selection is dropped.
//   - /clear starts a new session id. The same agent, the same directory, the
//     same window on screen — and the binding is gone.
//
// Each of those printed "I cannot tell whether it is still the same run" and
// made the user pick their agent again, for an agent that had never moved.
//
// What is given up: an agent that exited and was replaced by another of the
// same kind in the same directory now keeps the binding. That is the right
// trade. A fresh claude in ~/project is what the user asked for when they
// picked "claude · ~/project", the messages it receives are prose rather than
// keystrokes, and prose still cannot answer a dialog — Say escapes first (G1).
// A different KIND in that pane, or a different directory, is a different
// target and is still refused.
//
// The cwd comparison is what carries the weight the session used to, so it is
// the half that must not be weakened further: it is the only thing left that
// separates "my claude restarted" from "somebody else's claude took this seat".
// selection.Target gained a Cwd field for exactly this reason — before it, a
// selection could only be compared on kind, and kind alone is one bit.
func (id identity) matches(a agents.Agent) bool {
	if id.Kind != a.Kind {
		return false
	}
	// Compared only when both are known: herdr reports no cwd for a pane whose
	// foreground process it cannot resolve, and an unknown cwd is not evidence
	// of a move.
	if id.Cwd != "" && a.Cwd != "" && id.Cwd != a.Cwd {
		return false
	}
	return true
}

// replacedError explains WHICH part of the identity stopped matching, because
// the two mean different things to the person reading it: a changed KIND is a
// different program in that pane, a changed CWD is the same program on a
// different job — a different project, a different conversation, a different
// set of files it is willing to touch.
func replacedError(pane string, id identity, a agents.Agent) error {
	// Only two things end a binding now, and each means something different to
	// the person reading it. Session-id changes are not among them: see matches.
	if id.Kind != a.Kind {
		return fmt.Errorf("%w: %s was running %s and now runs %s",
			ErrTargetReplaced, pane, orUnknown(id.Kind), orUnknown(a.Kind))
	}
	return fmt.Errorf("%w: the %s in %s now works in %s, and I recorded it in %s — a different directory "+
		"is a different job, so I am not sending there without you saying so",
		ErrTargetReplaced, orUnknown(a.Kind), pane, orNoCwd(a.Cwd), orNoCwd(id.Cwd))
}

func orNoCwd(cwd string) string {
	if c := strings.TrimSpace(cwd); c != "" {
		return c
	}
	return "a directory herdr does not report"
}

// checkIdentity resolves a recorded destination to the live agent, refusing
// unless it is still the same agent.
func (b *bridge) checkIdentity(pane string, id identity) (agents.Agent, error) {
	a, ok := b.deps.Registry.Get(pane)
	if !ok {
		return agents.Agent{}, fmt.Errorf("%w: herdr sees no agent at %s — the pane was closed, "+
			"the agent exited, or it has not been started again yet", ErrTargetGone, pane)
	}
	if !id.matches(a) {
		return agents.Agent{}, replacedError(pane, id, a)
	}
	return a, nil
}

// restartNote reports that the agent kept its seat, its kind and its directory
// but is on a NEW native session — a /clear, a compaction, or that agent having
// been restarted where it stood.
//
// The binding survives this, because "the claude in ~/project" is what a person
// picks and it is still true. But the conversation behind it does not: whatever
// was discussed before is gone, so "rm -rf the thing we discussed" now reaches
// something that never discussed it. Refusing would end the binding for an
// agent that never moved, which is the failure this file just retracted; saying
// nothing would let the user address a memory the agent does not have. So it is
// delivered, once, with the fact attached.
//
// Empty when nothing changed, when either side has no session id to compare
// (the G8 window is not a restart), or when the recorded id is already current.
func restartNote(id identity, a agents.Agent) string {
	live := sessionID(a)
	if id.Session == "" || live == "" || id.Session == live {
		return ""
	}
	return fmt.Sprintf("♻️ Note: %s in %s has started a NEW conversation since you selected it "+
		"(a /clear, a compaction, or a restart). It is the same agent in the same directory, so you are "+
		"still aimed at it — but it does not remember what you discussed before.",
		orUnknown(a.Kind), orNoCwd(a.Cwd))
}

// ---------- what a message is bound to ----------

// binding is what the bridge recorded about an outbound message so that a reply
// to it can be CHECKED, not merely routed.
//
// routes.Store maps a message id to one opaque string and may not be changed,
// so the identity travels inside that string. The alternative — a second,
// bridge-local map — would not survive a restart, and S2 §3.1 says the bridge is
// killed and restarted routinely while a route stays live for seven days
// (routes.TTL); the hole this closes would then be open for exactly as long as
// the routes file outlives the process that wrote it.
type binding struct {
	Pane    string `json:"p"`
	Kind    string `json:"k"`
	Session string `json:"s,omitempty"`
	// Cwd is carried because this encoding is the bridge's own and has room for
	// it; it is what separates two runs that have both still to publish a
	// session id (see identity.matches).
	Cwd string `json:"c,omitempty"`

	// verified is false for a value that carries no identity at all: a
	// routes.json written by a build before this one. Not serialised — it is a
	// property of what was read, not of what was written.
	verified bool
}

// identity is what this binding claims about the agent it points at.
func (bd binding) identity() identity {
	return identity{Kind: bd.Kind, Session: bd.Session, Cwd: bd.Cwd}
}

// encodeBinding records the pane AND who is sitting in it.
func encodeBinding(a agents.Agent) string {
	id := identityOf(a)
	raw, err := json.Marshal(binding{Pane: a.PaneID, Kind: id.Kind, Session: id.Session, Cwd: id.Cwd})
	if err != nil {
		// Unreachable for three strings. Falling back to the bare pane keeps the
		// message routable, and an unverifiable route is refused rather than
		// delivered blind, so the failure costs a tap on the picker card.
		return a.PaneID
	}
	return string(raw)
}

// decodeBinding reads back what encodeBinding wrote, tolerating the bare pane
// ids that older builds stored.
//
// ok is false when nothing usable came back, which the caller treats exactly as
// an unbound reply: there is no pane to aim at and no identity to complain
// about, so the message falls through to the chat's selection.
func decodeBinding(raw string) (binding, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return binding{}, false
	}
	if !strings.HasPrefix(raw, "{") {
		// A pane id and nothing else: bound by a build that recorded only the
		// seat. It stays routable-looking here and is refused one layer up,
		// where the refusal can be explained.
		return binding{Pane: raw}, true
	}

	var b binding
	if err := json.Unmarshal([]byte(raw), &b); err != nil || strings.TrimSpace(b.Pane) == "" {
		return binding{}, false
	}
	b.verified = true
	return b, true
}

// ---------- the chat's current selection ----------

// currentSelection reads the chat's target, nil-safe.
//
// It is absent only when the chat has never picked an agent or has closed the
// one it picked. Nothing in the store expires, so "no selection" here is always
// something a human did.
func (b *bridge) currentSelection(chatID string) (selection.Target, bool) {
	if b.sel == nil || chatID == "" {
		return selection.Target{}, false
	}
	return b.sel.Get(chatID)
}

// selectionIdentity is everything a stored Target can prove about its agent.
//
// It carries the cwd now, and that is not a convenience: the session id is no
// longer compared (see identity.matches), so without a cwd a selection would be
// checked on KIND ALONE — one bit — and "a claude is in that seat" would be
// enough to deliver into a claude the user never picked, in a project they were
// not talking about. selection.Target gained the field so the two facts that
// make up "the agent I chose" travel together, in the store that outlives the
// process (S2 §3.1 has this bridge killed and restarted routinely).
//
// An empty Cwd — a selection stored by an older build, or a pane whose
// foreground process herdr could not resolve — refutes nothing rather than
// refusing everything. It is repaired in place by refreshSelectionIdentity on
// the first message that resolves cleanly.
func selectionIdentity(t selection.Target) identity {
	return identity{Kind: t.Kind, Session: t.Session, Cwd: t.Cwd}
}

// targetLabel names a selection the way agentLabel names a live agent, so that
// a refusal can say WHAT the chat is still aimed at when there is no live agent
// left to read it off.
func targetLabel(t selection.Target) string {
	label := orUnknown(t.Kind)
	if base := cwdBase(t.Cwd); base != "" {
		label += " · " + base
	}
	if t.Pane != "" {
		label += " · " + t.Pane
	}
	return label
}

// currentPane is the selected pane id, or "" — the shape cards.BuildAgentList
// wants for marking the current row.
func (b *bridge) currentPane(chatID string) string {
	t, ok := b.currentSelection(chatID)
	if !ok {
		return ""
	}
	return t.Pane
}

// setSelection aims a chat at an agent, recording WHAT it is and not merely
// where it sits, and reports whether the store took it.
//
// The identity comes from the LIVE agent the caller just resolved, never from
// the card that asked for the selection: a card can be days old, and what has
// to be re-checked before every later delivery is the thing that is in that
// pane now (G8, G17).
//
// false means the store refused it, which it does for a target with no kind —
// there would be nothing to compare the live agent against later, so it could
// only ever be honoured blind, and typing into the wrong agent is how prose
// becomes an approval (G1). The caller has to say so rather than report a
// selection that was never made.
func (b *bridge) setSelection(chatID string, a agents.Agent, cardMessageID string) bool {
	if b.sel == nil || chatID == "" {
		return false
	}

	id := identityOf(a)
	b.sel.Set(chatID, selection.Target{
		Pane:    a.PaneID,
		Kind:    id.Kind,
		Session: id.Session,
		Cwd:     id.Cwd,
		// A press is a human confirming this target, so the age this chat is
		// reminded about starts here — and RemindedAt goes back to zero, because
		// a fresh selection has nothing to be reminded of yet. rememberPicker and
		// refreshSelectionIdentity, which rewrite the same target for reasons the
		// human did not cause, deliberately preserve both.
		SelectedAt:    b.now(),
		CardMessageID: cardMessageID,
	})

	t, ok := b.sel.Get(chatID)
	return ok && t.Pane == a.PaneID
}

// clearSelection forgets a chat's target, nil-safe.
//
// THIS IS NOW REACHED FROM ONE PLACE ONLY: /close. That is the point of the
// whole wave. It used to be called whenever a recorded agent could not be
// resolved — the agent exited, herdr blinked, claude started a new session —
// and every one of those quietly ended a conversation the user had not
// finished, which is what "I have to pick my agent again on every message"
// looked like from the phone.
//
// Clearing on a failed lookup is not merely annoying, it is unsafe in the one
// configuration where it matters most. target() falls through to "exactly one
// agent is running, send it there" when a chat has no selection: clear the
// selection because the agent the user picked was replaced, and the very next
// message is delivered — silently, with no note — to the agent that replaced it.
// Keeping the selection and refusing is both what the user asked for and the
// safer of the two.
func (b *bridge) clearSelection(chatID string) {
	if b.sel == nil || chatID == "" {
		return
	}
	b.sel.Clear(chatID)
}

// forgetSelection clears a chat's target and keeps the one thing in it that is
// still true: which message holds the picker card.
//
// The durable copy of that id lives INSIDE the target, so clearing destroys it
// (see pickerIndex). Within one process the memory index usually still has it,
// but after a restart it is empty — and a restart is routine (S2 §3.1) while a
// selection now lasts until the user closes it. The card left in the chat would
// then keep saying "your typing goes to claude · w1:p1" for a chat that is no
// longer aimed anywhere, with nothing left to repaint. So the id is copied into
// the index before the clear, which is exactly what makes the repaint one line
// later find it.
func (b *bridge) forgetSelection(chatID string) {
	if t, ok := b.currentSelection(chatID); ok {
		b.pickers.remember(chatID, t.CardMessageID)
	}
	b.clearSelection(chatID)
}

// rememberPicker records which message holds this chat's live picker card, so
// the selection can be re-rendered in place instead of posting another list.
//
// It rewrites the target with the SAME SelectedAt: posting a list is not a
// human re-confirming a selection, and moving that stamp would silence the age
// reminder for any chat that runs /ls now and then — which is most of them.
//
// With no selection there is nothing to hang the id on in the store (it refuses
// a target with no pane, by design: a target with no identity could only ever be
// honoured blind), which is why the in-memory index is written first and always.
// The first /ls in a chat happens before anything is selected, and the card it
// posts is precisely the one the user is about to tap Select on.
func (b *bridge) rememberPicker(chatID, messageID string) {
	if chatID == "" || messageID == "" {
		return
	}
	b.pickers.remember(chatID, messageID)

	if b.sel == nil {
		return
	}
	t, ok := b.sel.Get(chatID)
	if !ok || t.CardMessageID == messageID {
		return
	}
	t.CardMessageID = messageID
	b.sel.Set(chatID, t)
}

// refreshSelectionIdentity updates what a chat's target IS without touching
// when it was chosen.
//
// SelectedAt and RemindedAt are deliberately preserved: an agent restarting is
// not the human re-confirming anything, and moving those stamps would silence
// the age reminder for a chat whose agent churns — which is the one chat most
// likely to need it.
//
// Cwd is only ever written when the live agent reports one. herdr reports no
// cwd for a pane whose foreground process it cannot resolve, and blanking a
// recorded directory on the strength of a reading herdr could not take would
// throw away the only discriminator a selection has left (see
// selectionIdentity).
func (b *bridge) refreshSelectionIdentity(chatID string, a agents.Agent) {
	if b.sel == nil || chatID == "" {
		return
	}
	t, ok := b.sel.Get(chatID)
	if !ok {
		return
	}
	t.Kind = a.Kind
	t.Session = sessionID(a)
	if cwd := strings.TrimSpace(a.Cwd); cwd != "" {
		t.Cwd = cwd
	}
	b.sel.Set(chatID, t)
}

// reconcileSelection writes back what this delivery just taught us about a
// standing target, and returns whatever the user has to be told about it.
//
// Two things move under a selection that is otherwise untouched: the agent
// mints a new session id (a /clear, a compaction, a restart in place), and a
// cwd appears for a record that had none — either a selection stored by a build
// before Target carried one, or one made while herdr still could not resolve
// the pane's foreground process. Recording both is what keeps the identity
// check sharp: an unrepaired record is compared on kind alone.
//
// The write is conditional because Set is a write-through to disk. An
// unconditional refresh here would be one fsync per message for a selection
// that has not changed in days.
func (b *bridge) reconcileSelection(chatID string, t selection.Target, a agents.Agent) string {
	// Read before anything is rewritten: this is the comparison against what the
	// user was last told, and refreshSelectionIdentity destroys it.
	note := restartNote(selectionIdentity(t), a)

	cwd := strings.TrimSpace(a.Cwd)
	if t.Session != sessionID(a) || (cwd != "" && t.Cwd != cwd) {
		b.refreshSelectionIdentity(chatID, a)
	}
	return note
}

// ---------- how old the aim is ----------

// staleNote is what replaced the 12h expiry.
//
// The expiry existed to stop a forgotten selection from silently receiving
// tomorrow's first message. The word doing the work in that sentence is
// SILENTLY — and dropping the selection was a strange way to fix it, because
// the user then got no message at all, just a picker card and no idea why. What
// they actually need is the delivery AND the fact: this went where you last
// aimed it, which was a while ago.
//
// It is said once per quiet period, not once per message: RemindedAt is stamped
// when it fires, so a chat that has been talking all day never sees it and a
// chat that comes back after a weekend sees it exactly once. Empty when the
// selection is younger than selection.StaleAfter, and empty for a stamp in the
// future — a Mac whose clock was wrong at boot (VM snapshot, dead RTC, the
// window before NTP lands) writes those, and the answer to a bad clock is
// silence, not a reminder about a negative duration.
func (b *bridge) staleNote(chatID string, t selection.Target, a agents.Agent) string {
	since := t.RemindedAt
	if since.IsZero() {
		since = t.SelectedAt
	}
	if since.IsZero() {
		return ""
	}
	age := b.now().Sub(since)
	if age < selection.StaleAfter {
		return ""
	}
	b.markReminded(chatID)
	return fmt.Sprintf("🕰️ Note: you aimed this chat at %s %s ago and it is still aimed there, so "+
		"that is where this went. Send /close to stop, or tap Select on the list to aim somewhere else.",
		agentLabel(a), humanAge(age))
}

// markReminded records that the age has just been said, so it is not said again
// until the chat has been quiet for another selection.StaleAfter.
//
// SelectedAt is untouched: it means "when a human chose this", and a reminder is
// not a human choosing anything. Conflating the two would make the reminder
// itself the thing that keeps resetting the clock it reports.
func (b *bridge) markReminded(chatID string) {
	if b.sel == nil || chatID == "" {
		return
	}
	t, ok := b.sel.Get(chatID)
	if !ok {
		return
	}
	t.RemindedAt = b.now()
	b.sel.Set(chatID, t)
}

// humanAge renders a duration the way someone glancing at a phone reads one.
// Deliberately coarse: the point is "this is old", not the exact number.
func humanAge(d time.Duration) string {
	switch h := int(d.Hours()); {
	case h >= 48:
		return fmt.Sprintf("%d days", h/24)
	case h >= 24:
		return "a day"
	default:
		return plural(max(h, 1), "hour", "hours")
	}
}
