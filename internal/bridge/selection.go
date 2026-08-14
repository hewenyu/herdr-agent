package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
// An empty recorded session matches ONLY a live agent that also reports none.
// Reading it as "matches anything" would turn G8's detection window into a
// permanent wildcard: aim at claude before it publishes a session, that claude
// exits hours later, another claude starts in the same seat in another project,
// the kind still matches, and the next thing typed lands in the wrong agent's
// context. The selection store documents the same rule and says the caller must
// not soften it; this is the caller.
//
// Two runs that have BOTH still to publish a session are the case that rule
// cannot separate — start claude, quit before accepting its trust-this-directory
// prompt, start claude again elsewhere in the same pane — so when the record
// carries a cwd it must match too. It is a weaker fact than a session id (an
// agent restarted in the same directory still passes), which is why it is a
// last resort rather than a fourth thing checked always: a project moved to a
// new checkout would otherwise refuse a selection that is genuinely live.
func (id identity) matches(a agents.Agent) bool {
	if id.Kind != a.Kind || id.Session != sessionID(a) {
		return false
	}
	if id.Session == "" && id.Cwd != "" && id.Cwd != a.Cwd {
		return false
	}
	return true
}

// replacedError explains WHICH part of the identity stopped matching, because
// they mean different things to the person reading it: a changed kind is a
// different program in that pane, a changed session is the same program started
// again — with a different conversation, a different cwd, possibly a different
// project.
func replacedError(pane string, id identity, a agents.Agent) error {
	switch {
	case id.Kind != a.Kind:
		return fmt.Errorf("%w: %s was running %s and now runs %s",
			ErrTargetReplaced, pane, orUnknown(id.Kind), orUnknown(a.Kind))

	case id.Session == "" && sessionID(a) != "":
		// The G8 window: recorded before herdr had published a session id for
		// that pane. Same agent or not, we cannot tell — and cannot deliver.
		return fmt.Errorf("%w: %s had not published a session id when I recorded it, and the %s "+
			"there now has one, so I cannot tell whether it is still the same run",
			ErrTargetReplaced, pane, orUnknown(a.Kind))

	case id.Session == "":
		// Neither run ever published one, so the directory is all there is to go
		// on — and it changed.
		return fmt.Errorf("%w: neither run in %s had published a session id, and the %s there now works "+
			"in %s where I recorded %s, so it is a different run",
			ErrTargetReplaced, pane, orUnknown(a.Kind), orNoCwd(a.Cwd), id.Cwd)

	default:
		return fmt.Errorf("%w: the %s in %s is a different session from the one I recorded, so it is a "+
			"different run of that agent", ErrTargetReplaced, orUnknown(a.Kind), pane)
	}
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
		return agents.Agent{}, fmt.Errorf("%w: %s is gone — the pane was closed or the agent exited",
			ErrTargetReplaced, pane)
	}
	if !id.matches(a) {
		return agents.Agent{}, replacedError(pane, id, a)
	}
	return a, nil
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
// The store evaluates selection.TTL at read time, so an expired selection is
// reported as absent here and routing falls through to the picker card.
func (b *bridge) currentSelection(chatID string) (selection.Target, bool) {
	if b.sel == nil || chatID == "" {
		return selection.Target{}, false
	}
	return b.sel.Get(chatID)
}

// selectionIdentity is everything a stored Target can prove about its agent.
//
// It carries no cwd, and cannot: selection.Target is a frozen contract with no
// field for one, and a bridge-local memory copy would make the check true in one
// process and absent in the next — S2 §3.1 has the bridge killed and restarted
// routinely — which is a worse thing to reason about than the kind+session rule
// the store documents. The two encodings this package does own, route bindings
// and parked prose, carry it.
func selectionIdentity(t selection.Target) identity {
	return identity{Kind: t.Kind, Session: t.Session}
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
		// A press is a human confirming this target, so the TTL restarts here.
		// rememberPicker, which rewrites the same target for another reason,
		// deliberately does not.
		SelectedAt:    b.now(),
		CardMessageID: cardMessageID,
	})

	t, ok := b.sel.Get(chatID)
	return ok && t.Pane == a.PaneID
}

// clearSelection forgets a chat's target, nil-safe.
//
// Called when the recorded agent turns out not to be there any more. Clearing
// rather than keeping is deliberate: the next plain message must land on the
// picker card, not on whoever now occupies that seat.
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
// selection lasts twelve hours. The card left in the chat would then keep saying
// "your typing goes to claude · w1:p1" for an agent that has been replaced, with
// nothing left to repaint. So the id is copied into the index before the clear,
// which is exactly what makes the repaint one line later find it.
func (b *bridge) forgetSelection(chatID string) {
	if t, ok := b.currentSelection(chatID); ok {
		b.pickers.remember(chatID, t.CardMessageID)
	}
	b.clearSelection(chatID)
}

// rememberPicker records which message holds this chat's live picker card, so
// the selection can be re-rendered in place instead of posting another list.
//
// It rewrites the target with the SAME SelectedAt: posting a list is not a human
// re-confirming a selection, and restarting the 12h TTL on it would let a chat
// that keeps running /ls hold a selection forever — which is the staleness the
// TTL exists to bound.
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
