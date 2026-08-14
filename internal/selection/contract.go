// Package selection remembers which agent a chat is currently talking to, so
// that plain typing reaches it without a reply or a pane id.
//
// This is the product's primary routing mechanism. Reply-to-route still works
// and overrides the selection for that one message, but it costs a long-press
// on every message, and the common case is several turns with ONE agent rather
// than round-robin across many.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package selection

import "time"

// TTL bounds how long a selection stays valid without being re-confirmed.
// Long enough to survive a night, short enough that a forgotten selection does
// not silently receive tomorrow's first message.
const TTL = 12 * time.Hour

// Target is a chat's current agent.
//
// Pane is where it lives; Kind and Session are what it IS. A pane id is a
// seat, not an identity — an agent can exit and another take the same seat, and
// routing on the seat alone would deliver a later message into a different
// context entirely (G8, G17). Both are checked before every delivery.
type Target struct {
	Pane       string    `json:"pane"`
	Kind       string    `json:"kind"`
	Session    string    `json:"session,omitempty"`
	SelectedAt time.Time `json:"selected_at"`
	// CardMessageID is the picker card to re-render when the selection changes,
	// so switching is one tap on a card the user already has.
	CardMessageID string `json:"card_message_id,omitempty"`
}

// Store maps chat_id -> Target, persisted across restarts.
type Store interface {
	// Set replaces the chat's target.
	Set(chatID string, t Target)
	// Get returns the chat's target. ok is false when there is none or it has
	// expired (TTL evaluated at read time).
	Get(chatID string) (Target, bool)
	Clear(chatID string)
	// Flush persists atomically (tmp + fsync + rename, mode 0600).
	Flush() error
	Close() error
}

// Open loads or creates the store at path.
//
// Implementations must provide, in store.go, exactly:
//
//	func Open(path string) (Store, error)
//
// A corrupt file must start empty rather than block startup.
type Opener interface {
	Open(path string) (Store, error)
}
