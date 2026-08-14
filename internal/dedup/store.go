package dedup

import (
	"container/list"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ErrClosed is returned by Flush after Close.
var ErrClosed = errors.New("dedup: store is closed")

// FileStore is the disk-backed Store: an LRU of at most MaxEntries keys,
// each with an absolute expiry, persisted as a single JSON file.
type FileStore struct {
	path       string
	now        func() time.Time
	maxEntries int
	autoFlush  bool
	loadWarn   error

	mu     sync.Mutex
	lru    *list.List               // front = most recently used
	index  map[string]*list.Element // "<ns>:<key>" -> element holding *entry
	closed bool

	// persistErr remembers a failed write-through, which SeenOrMark and Unmark
	// cannot report: they have no error return. Exposed via LastError so a
	// store that has quietly stopped being durable can be noticed.
	persistErr error
}

var _ Store = (*FileStore)(nil)

type entry struct {
	Key     string    `json:"k"`
	Expires time.Time `json:"exp"`
}

// Option configures a FileStore.
type Option func(*settings)

type settings struct {
	now        func() time.Time
	maxEntries int
	autoFlush  bool
}

// WithClock injects the time source. Tests use it to cross a TTL boundary
// without sleeping.
func WithClock(now func() time.Time) Option {
	return func(s *settings) {
		if now != nil {
			s.now = now
		}
	}
}

// WithMaxEntries overrides MaxEntries. Values <= 0 are ignored.
func WithMaxEntries(n int) Option {
	return func(s *settings) {
		if n > 0 {
			s.maxEntries = n
		}
	}
}

// WithAutoFlush controls write-through persistence, on by default.
//
// On is the safe default: the bridge can be killed at any moment, and the
// window right after a restart is exactly when Feishu redelivers (G14). A mark
// that only lives in memory is a mark that lets a command be injected twice.
// Turning it off batches writes until Flush/Close.
func WithAutoFlush(on bool) Option {
	return func(s *settings) { s.autoFlush = on }
}

// Open loads the store at path, creating its parent directory if needed.
//
// A missing, corrupt or truncated file is NOT an error: the store starts empty
// and the reason is available from LoadWarning. Refusing to boot the bridge
// because a cache file got mangled would trade a duplicate-event risk for a
// total outage. Open only fails when the path itself is unusable, in which case
// nothing could be persisted at all.
func Open(path string, opts ...Option) (*FileStore, error) {
	if path == "" {
		return nil, errors.New("dedup: empty store path")
	}
	cfg := settings{now: time.Now, maxEntries: MaxEntries, autoFlush: true}
	for _, opt := range opts {
		opt(&cfg)
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("dedup: create state dir %s: %w", dir, err)
		}
	}
	s := &FileStore{
		path:       path,
		now:        cfg.now,
		maxEntries: cfg.maxEntries,
		autoFlush:  cfg.autoFlush,
		lru:        list.New(),
		index:      make(map[string]*list.Element),
	}
	s.loadWarn = s.load()
	return s, nil
}

// LoadWarning reports why the on-disk state was discarded at Open, or nil if it
// was loaded (or simply absent). Callers should log it: a store that silently
// resets is a store that silently allows a redelivered event through.
func (s *FileStore) LoadWarning() error { return s.loadWarn }

// SeenOrMark reports whether key was already recorded, and records it if not.
func (s *FileStore) SeenOrMark(ns, key string) bool {
	if key == "" {
		// An event with no id cannot be deduplicated. Recording it under a
		// single shared store key would collapse every such event into one and
		// silently drop all but the first — losing real user messages is worse
		// than the rare double-delivery this lets through.
		return false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	k := storeKey(ns, key)

	if el, ok := s.index[k]; ok {
		e := el.Value.(*entry)
		if now.Before(e.Expires) {
			// Recency only. The expiry is deliberately NOT extended: the window
			// is measured from first sight, so a key cannot be kept alive
			// forever by a redelivery loop.
			// Only the ordering changed, so no write here: a redelivery burst
			// must not turn into one fsync per duplicate. Close persists the
			// final order.
			s.lru.MoveToFront(el)
			return true
		}
		// Expired, evaluated HERE at read time. Purging only on overflow would
		// make every id still inside the 2048-entry LRU a permanent duplicate
		// under normal load (S2 3.3).
		s.removeLocked(el)
	}

	s.insertLocked(k, now.Add(ttlFor(ns)), now)
	s.afterMutateLocked()
	return false
}

// Unmark removes a key so Feishu's redelivery gets a real second chance.
func (s *FileStore) Unmark(ns, key string) {
	if key == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if el, ok := s.index[storeKey(ns, key)]; ok {
		s.removeLocked(el)
		s.afterMutateLocked()
	}
}

// Flush persists to disk atomically (tmp + fsync + rename, mode 0600).
func (s *FileStore) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("dedup: flush %s: %w", s.path, ErrClosed)
	}
	return s.persistLocked()
}

// Close flushes and then rejects further disk writes. It is idempotent; only
// the first call can report a persistence error.
func (s *FileStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	err := s.persistLocked()
	s.closed = true
	return err
}

// LastError reports the most recent persistence failure, or nil if the last
// write succeeded. SeenOrMark and Unmark write through to disk but cannot
// return an error; without this a store that stopped being durable — and would
// therefore let every event through again after a restart — would be silent.
func (s *FileStore) LastError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.persistErr
}

// Len is the number of live entries currently held.
//
// Entries past their expiry are excluded even when they are still in the LRU:
// nothing purges a dead key until that same key is read again, the store
// overflows, or it is written out, so the raw list length can stay high for
// hours after the windows it counts have closed. SeenOrMark already treats
// those keys as absent, and a /doctor line saying "1893 events remembered"
// when none of them still suppresses anything is a lie about durability.
func (s *FileStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	n := 0
	for el := s.lru.Front(); el != nil; el = el.Next() {
		if now.Before(el.Value.(*entry).Expires) {
			n++
		}
	}
	return n
}

func (s *FileStore) insertLocked(k string, expires, now time.Time) {
	s.index[k] = s.lru.PushFront(&entry{Key: k, Expires: expires})
	s.evictLocked(now)
}

func (s *FileStore) removeLocked(el *list.Element) {
	delete(s.index, el.Value.(*entry).Key)
	s.lru.Remove(el)
}

func (s *FileStore) evictLocked(now time.Time) {
	if s.lru.Len() <= s.maxEntries {
		return
	}
	// At capacity: drop everything already dead before evicting anything that
	// is still inside its window. An expired entry has no value at all, a live
	// one is still suppressing a redelivery.
	s.purgeExpiredLocked(now)
	for s.lru.Len() > s.maxEntries {
		s.removeLocked(s.lru.Back())
	}
}

// purgeExpiredLocked drops every entry whose window has already closed. It is
// deliberately NOT called on every insert: the scan is O(n) and SeenOrMark
// already ignores a dead key when it reads it. It runs where the cost is
// already paid — at capacity, and just before a write-through.
func (s *FileStore) purgeExpiredLocked(now time.Time) {
	for el := s.lru.Back(); el != nil; {
		prev := el.Prev()
		if !now.Before(el.Value.(*entry).Expires) {
			s.removeLocked(el)
		}
		el = prev
	}
}

func (s *FileStore) afterMutateLocked() {
	if !s.autoFlush || s.closed {
		return
	}
	// The error is not dropped: persistLocked records it in persistErr, which
	// is the only way SeenOrMark and Unmark — neither of which can return an
	// error — can report that the store stopped being durable.
	_ = s.persistLocked()
}

func storeKey(ns, key string) string { return ns + ":" + key }

func ttlFor(ns string) time.Duration {
	switch ns {
	case NSCard:
		return CardTTL
	case NSMessage:
		return MessageTTL
	default:
		// An unknown namespace is a caller bug. Fall back to the LONGER window:
		// here a missed duplicate re-injects a command into a live coding agent
		// (G14), which is worse than holding a key past its usefulness.
		return MessageTTL
	}
}
