// Package routes remembers which agent a Feishu message was about, so that
// replying to it routes back to that agent.
//
// This is the primary interaction model: reply-to-route. It lets one chat
// drive several agents at once, which a "current session" model cannot.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package routes

import "time"

// TTL bounds how long a message stays routable.
const TTL = 7 * 24 * time.Hour

// MaxEntries bounds the on-disk store.
const MaxEntries = 4096

// Store maps message_id -> pane_id, persisted across restarts.
type Store interface {
	// Bind records that messageID concerns paneID. Called for every outbound
	// message the bridge sends about an agent.
	Bind(messageID, paneID string)
	// Lookup resolves a reply target. ok is false when unknown or expired
	// (TTL evaluated at read time).
	Lookup(messageID string) (paneID string, ok bool)
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
