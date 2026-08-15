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

// StaleAfter is how long a selection may go without a human confirming it
// before the bridge says so out loud. It is NOT an expiry, and this is a
// retraction of the constant that used to live here.
//
// A 12h TTL was the first answer to "a forgotten selection must not silently
// receive tomorrow's first message". Measured against how the product is
// actually used, it answered a question nobody was asking and broke the one
// thing the picker exists to provide: a person picks an agent in the morning,
// works with it all day across a lunch break and a night, and finds the chat
// has quietly stopped being aimed anywhere — with no event to point at, because
// the thing that ended it was a clock. The user reads that as the bridge
// forgetting, and they are right.
//
// What replaces it is not silence. A selection now ends only when a human ends
// it (/close, or picking another agent) or when the agent it names provably is
// not there (a different KIND or a different CWD in that seat — checked before
// every single delivery, which is the check that was doing the real work all
// along). Time alone no longer ends it; instead the bridge delivers and SAYS
// how long it has been, once, so the fact the TTL was protecting still reaches
// the user — as information rather than as a dropped conversation.
const StaleAfter = 12 * time.Hour

// Target is a chat's current agent — which in practice means a WINDOW, because
// that is what a person picks when they pick an agent.
//
// Pane is the window and it is the identity. herdr never recycles a pane id:
// the public pane number only ever goes up, is not released when a pane closes,
// and the counter is persisted across restarts, so w2:p2 names one pane for the
// life of the install. Only KIND is checked alongside it, and only because a
// window outlives the agent inside it — quit claude in that pane, run codex
// there, and the id is unchanged while the program is not.
//
// Session and Cwd are recorded to be REPORTED, never compared. Both were
// compared, and both cost conversations that had not ended: a session id is
// absent until claude's trust prompt is accepted and brand new after every
// /clear, and a cwd is equal across two agents in one project while also
// following a Bash tool call into a subdirectory. See bridge.identity.matches
// for the measurements.
type Target struct {
	Pane    string `json:"pane"`
	Kind    string `json:"kind"`
	Session string `json:"session,omitempty"`
	// Cwd is the directory the agent was working in when it was picked. It names
	// the target in a refusal when no live agent is left to read one off, and a
	// change in it — paired with a new session id — is how the bridge says a
	// window was restarted on a different job. Empty means the record has none:
	// written by an older build, or herdr could not resolve the pane's
	// foreground process.
	Cwd        string    `json:"cwd,omitempty"`
	SelectedAt time.Time `json:"selected_at"`
	// RemindedAt is when the user was last told how old this selection is. Zero
	// means never. It exists so the reminder that replaced the TTL is said once
	// per quiet period instead of on every message.
	RemindedAt time.Time `json:"reminded_at,omitempty"`
	// CardMessageID is the picker card to re-render when the selection changes,
	// so switching is one tap on a card the user already has.
	CardMessageID string `json:"card_message_id,omitempty"`
}

// Store maps chat_id -> Target, persisted across restarts.
type Store interface {
	// Set replaces the chat's target.
	Set(chatID string, t Target)
	// Get returns the chat's target. ok is false only when the chat has none:
	// nothing here expires, and a stored selection is returned however old it
	// is. Clear is the only thing that removes one, and above this store the
	// only things that call it are /close and picking another agent.
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
