// Package dedup suppresses re-processing of redelivered Feishu events.
//
// This is not defensive programming. Feishu redelivers events whose handler
// failed — measured at ~5 minutes later, byte-identical (G14). For this
// product a redelivered event means re-injecting a command into a live coding
// agent: re-running a build, or re-approving something that was refused.
//
// The store MUST be on disk. The SDK's own safety.DedupCache is in-memory, and
// a bridge restart is exactly when redelivery is most likely.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package dedup

import "time"

// Namespaces. Card callbacks get their own, with a much shorter window.
const (
	NSMessage = "msg"
	NSCard    = "card"
)

// TTLs per namespace.
const (
	MessageTTL = 24 * time.Hour
	CardTTL    = 15 * time.Minute
)

// MaxEntries bounds the on-disk store.
const MaxEntries = 2048

// Store records which events have been handled.
type Store interface {
	// SeenOrMark reports whether key was already recorded, and records it if
	// not. The TTL check happens HERE, at read time — purging only on overflow
	// makes every previously seen id a permanent duplicate under normal load.
	SeenOrMark(ns, key string) (seen bool)

	// Unmark removes a key. Call this when the handler returned an error, so
	// that Feishu's redelivery gets a real second chance.
	Unmark(ns, key string)

	// Flush persists to disk atomically (tmp + fsync + rename, mode 0600).
	Flush() error

	Close() error
}
