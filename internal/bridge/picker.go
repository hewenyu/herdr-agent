package bridge

import (
	"context"
	"sync"

	"github.com/hewenyu/herdr-agent/internal/cards"
)

// maxPickerChats bounds the in-memory index below.
//
// Nothing in this product should approach it: authorization is a default-deny
// open_id allowlist (S2 §3.4), so the only chats that can ever reach it are the
// handful one allowed human has with the bot. It exists because a map keyed by
// something an event carries must not grow without limit, and the cost of
// dropping an entry is one extra card posted where an edit would have done.
const maxPickerChats = 64

// pickerIndex remembers which message currently holds each chat's picker card.
//
// The durable copy of this lives in selection.Target.CardMessageID, and that is
// the one that survives a restart — but it can only exist while a selection
// does: the store refuses a target with no pane, by design, since a target with
// no identity could only ever be honoured blind. Two moments need the id and
// have no selection to hang it on:
//
//   - the first /ls in a chat, before anything has been selected. The card it
//     posts is the one the user is about to tap Select on, and the tap has to
//     re-render THAT card rather than post a second one under it.
//   - the instant a selection is cleared because the agent it named was
//     replaced (G8, G17). The id goes with the selection, and the card left in
//     the chat still shows the replaced agent as the current target.
//
// So this is memory only, deliberately, and it is a cache rather than a source
// of truth: losing it costs a posted card, never a wrong delivery.
type pickerIndex struct {
	mu   sync.Mutex
	last map[string]string
}

func newPickerIndex() *pickerIndex {
	return &pickerIndex{last: map[string]string{}}
}

func (p *pickerIndex) remember(chatID, messageID string) {
	if chatID == "" || messageID == "" {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if _, ok := p.last[chatID]; !ok && len(p.last) >= maxPickerChats {
		// Full, and this chat is new. Which entry goes is not worth ordering
		// state to decide: every entry is a hint whose loss costs one extra
		// card, and the newest chat is the one that is definitely in use.
		for c := range p.last {
			delete(p.last, c)
			break
		}
	}
	p.last[chatID] = messageID
}

func (p *pickerIndex) get(chatID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.last[chatID]
}

// pickerCard is the message this chat's live picker card occupies, or "".
//
// The selection is consulted first because it is the durable copy: after a
// restart it is the only one there is. The index is the fallback for the two
// windows a selection cannot cover (see pickerIndex).
func (b *bridge) pickerCard(chatID string) string {
	if t, ok := b.currentSelection(chatID); ok && t.CardMessageID != "" {
		return t.CardMessageID
	}
	return b.pickers.get(chatID)
}

// buildPicker renders the agent list as this chat would see it right now.
//
// BuildAgentList is a pure function of (agents, current selection), which is
// what makes re-rendering it in place safe: the card the user is looking at
// never changes for a reason they did not cause.
func (b *bridge) buildPicker(chatID string) (string, error) {
	return cards.BuildAgentList(b.deps.Registry.Snapshot(), b.currentPane(chatID), b.now())
}

// repaintPicker rewrites one picker message with the truth as it stands now,
// reporting whether the chat ended up holding an up-to-date card.
//
// This is what keeps the card honest. It is the primary interface of the
// product, it stays in the chat forever (G17), and it states which agent the
// user's typing goes to — so a selection that changed by ANY route (a Select
// press, an /ls, an identity mismatch that cleared it) leaves a card in the
// history claiming something that is no longer true. Feishu's update_multi
// edits it where it stands instead of pushing a second one under it.
//
// false means the card in the chat is stale and the caller has to post a fresh
// one: Feishu refuses an edit to a message that was revoked or is older than it
// keeps, and there may be no card to edit at all.
func (b *bridge) repaintPicker(ctx context.Context, chatID, messageID string) bool {
	if chatID == "" || messageID == "" {
		return false
	}

	card, err := b.buildPicker(chatID)
	if err != nil {
		b.log.Error("bridge: could not rebuild the agent picker", "chat_id", chatID, "err", err)
		return false
	}
	if err := b.deps.Bot.UpdateCard(ctx, messageID, card); err != nil {
		b.log.Warn("bridge: could not re-render the picker card in place; a fresh one will be posted",
			"chat_id", chatID, "message_id", messageID, "err", err)
		return false
	}
	return true
}
