package routes

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
var ErrClosed = errors.New("routes: store is closed")

// FileStore is the disk-backed Store: at most maxEntries bindings, oldest
// binding evicted first, persisted as a single JSON file.
type FileStore struct {
	path       string
	now        func() time.Time
	maxEntries int
	autoFlush  bool
	loadWarn   error

	mu     sync.Mutex
	order  *list.List               // front = most recently bound
	index  map[string]*list.Element // message_id -> element holding *entry
	closed bool

	// persistErr remembers a failed write-through, which Bind cannot report:
	// it has no error return. Exposed via LastError so a store that quietly
	// stopped being durable can be noticed.
	persistErr error
}

var _ Store = (*FileStore)(nil)

// entry is one binding. boundAt is stored rather than an absolute expiry so
// that TTL is a property of this build, not of whatever wrote the file.
type entry struct {
	MessageID string    `json:"m"`
	PaneID    string    `json:"p"`
	BoundAt   time.Time `json:"t"`
}

// Option configures a FileStore.
type Option func(*settings)

type settings struct {
	now        func() time.Time
	maxEntries int
	autoFlush  bool
}

// WithClock injects the time source. Tests use it to cross the 7-day TTL
// boundary without sleeping.
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
// On is the safe default: the bridge is killed and restarted routinely, and a
// binding that only ever lived in memory turns a reply into an unroutable
// message. Turning it off batches writes until Flush/Close.
func WithAutoFlush(on bool) Option {
	return func(s *settings) { s.autoFlush = on }
}

// Open loads or creates the store at path.
//
// Signature fixed by contract.go; use OpenWith to inject a clock or bounds.
// The Store interface deliberately exposes neither LoadWarning nor LastError,
// so a caller that wants to log a discarded file or a store that stopped being
// durable must call OpenWith or type-assert the result to *FileStore.
func Open(path string) (Store, error) {
	return OpenWith(path)
}

// OpenWith is Open with options, and the concrete type so that callers can
// reach LoadWarning and LastError.
//
// A missing, corrupt or truncated file is NOT an error: the store starts empty
// and the reason is available from LoadWarning. Refusing to boot the bridge
// because a routing cache got mangled would trade "replies fall back to the
// bare-text path" for a total outage.
//
// A state dir that cannot be written IS an error. That is not the same failure:
// it costs every future binding, not the ones already lost, and Bind has no
// error return to report it with. OpenWith therefore writes once before
// returning, so an unwritable dir stops the bridge at boot instead of letting
// it look healthy while dropping all reply-to-route state on every restart.
func OpenWith(path string, opts ...Option) (*FileStore, error) {
	if path == "" {
		return nil, errors.New("routes: empty store path")
	}
	cfg := settings{now: time.Now, maxEntries: MaxEntries, autoFlush: true}
	for _, opt := range opts {
		opt(&cfg)
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("routes: create state dir %s: %w", dir, err)
		}
	}
	s := &FileStore{
		path:       path,
		now:        cfg.now,
		maxEntries: cfg.maxEntries,
		autoFlush:  cfg.autoFlush,
		order:      list.New(),
		index:      make(map[string]*list.Element),
	}
	s.loadWarn = s.load()

	// A dot-prefixed temp file survives any kill between CreateTemp and Rename.
	// With write-through on there is one such window per outbound message and
	// S2 3.1 says the bridge is killed and restarted routinely, so without a
	// sweep here the state dir accumulates hidden junk for the life of the
	// install. Removing them unconditionally is safe because 3.1 enforces
	// single-instance via the pid lock: no other process owns one.
	reclaimTempFiles(filepath.Dir(path), filepath.Base(path))

	// Prove writability now, while there is still an error return to say it in.
	// An existing but non-writable dir gets past MkdirAll, and load() reads the
	// resulting ENOENT as "first run", so nothing else on this path notices.
	s.mu.Lock()
	err := s.persistLocked()
	s.mu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("routes: state dir %s is not writable: %w", filepath.Dir(path), err)
	}
	return s, nil
}

// LoadWarning reports why the on-disk state was discarded at Open, or nil if it
// was loaded (or simply absent). Callers should log it: after a silent reset
// every reply-to-route falls back to guessing, which for more than one live
// agent means the bridge asks the user to disambiguate instead of routing.
func (s *FileStore) LoadWarning() error { return s.loadWarn }

// Bind records that messageID concerns paneID.
func (s *FileStore) Bind(messageID, paneID string) {
	// Neither half is usable alone. A blank message_id would collapse every
	// such binding onto one key, and a blank pane_id would make Lookup report
	// success for a target that SendKeys/Say cannot address — better to fall
	// through to the bare-text route than to aim at nothing.
	if messageID == "" || paneID == "" {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	if el, ok := s.index[messageID]; ok {
		// Rebinding is a fresh binding: the TTL and the eviction age both
		// restart, and the pane may legitimately have changed (the same
		// message updated to be about another agent).
		e := el.Value.(*entry)
		e.PaneID = paneID
		e.BoundAt = now
		s.order.MoveToFront(el)
	} else {
		s.index[messageID] = s.order.PushFront(&entry{MessageID: messageID, PaneID: paneID, BoundAt: now})
	}
	s.evictLocked(now)
	s.afterMutateLocked()
}

// Lookup resolves a reply target.
func (s *FileStore) Lookup(messageID string) (string, bool) {
	if messageID == "" {
		return "", false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	el, ok := s.index[messageID]
	if !ok {
		return "", false
	}
	e := el.Value.(*entry)
	if !s.liveLocked(e, s.now()) {
		// Expired, evaluated HERE at read time. Feishu messages never expire
		// (G17): a reply to a three-day-old message must not steer a pane that
		// is now running something else, and purging only on overflow would
		// keep every binding routable until 4096 more arrive.
		//
		// Drop it while we hold the lock, but do not write through: a read
		// should not cost an fsync, and load() ignores dead entries anyway.
		s.removeLocked(el)
		return "", false
	}
	// Deliberately no MoveToFront: eviction order is by binding age, not by
	// access. Reading a route must not let an old binding outlive newer ones.
	return e.PaneID, true
}

// Flush persists to disk atomically (tmp + fsync + rename, mode 0600).
func (s *FileStore) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("routes: flush %s: %w", s.path, ErrClosed)
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
// write succeeded. Bind writes through to disk but cannot return an error;
// without this a store that stopped being durable would be silent until the
// next restart lost every route.
func (s *FileStore) LastError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.persistErr
}

// Len is the number of live bindings currently held.
//
// Entries past their TTL are excluded even when they are still in the list:
// nothing purges a dead binding until it is looked up again, the store
// overflows, or it is written out, so the raw length can stay high for days
// after the routes it counts stopped resolving.
func (s *FileStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	n := 0
	for el := s.order.Front(); el != nil; el = el.Next() {
		if s.liveLocked(el.Value.(*entry), now) {
			n++
		}
	}
	return n
}

func (s *FileStore) liveLocked(e *entry, now time.Time) bool {
	d := now.Sub(e.BoundAt)
	// Fail closed on a binding dated in the future. A Mac whose clock is wrong
	// at boot (VM snapshot restore, dead RTC, the window before NTP lands)
	// writes exactly those, and a plain `d < TTL` would call them live until
	// the clock caught up — a 2099 timestamp stays routable for 73 years,
	// which is precisely the unbounded staleness G17 says must not exist.
	// Losing a route only costs a fallback to the bare-text path; keeping a
	// stale one aims a reply at a pane that now runs something else.
	return d >= 0 && d < TTL
}

func (s *FileStore) removeLocked(el *list.Element) {
	delete(s.index, el.Value.(*entry).MessageID)
	s.order.Remove(el)
}

func (s *FileStore) evictLocked(now time.Time) {
	if s.order.Len() <= s.maxEntries {
		return
	}
	// At capacity: drop everything already dead before evicting anything still
	// inside its window. An expired binding routes nothing; a live one is
	// somebody's reply target.
	//
	// While the clock only moves forward this is redundant — the list is sorted
	// by BoundAt, so the dead entries are the oldest and the loop below would
	// take them anyway. It earns its keep when the clock jumps backwards: then
	// a binding made after another can carry an earlier BoundAt, and the dead
	// one is no longer at the back.
	s.purgeExpiredLocked(now)
	for s.order.Len() > s.maxEntries {
		s.removeLocked(s.order.Back()) // oldest binding first
	}
}

// purgeExpiredLocked drops every binding past its TTL. It is deliberately NOT
// called on every Bind: the scan is O(n) and Lookup already ignores a dead
// binding when it reads one. It runs where the cost is already paid — at
// capacity, and just before a write-through.
func (s *FileStore) purgeExpiredLocked(now time.Time) {
	for el := s.order.Back(); el != nil; {
		prev := el.Prev()
		if !s.liveLocked(el.Value.(*entry), now) {
			s.removeLocked(el)
		}
		el = prev
	}
}

func (s *FileStore) afterMutateLocked() {
	if s.closed {
		// A mutation after Close is lost whatever autoFlush says, because Flush
		// is closed too. Record it: Bind has no error return, so this is the
		// only signal that the binding never reached disk, and Flush already
		// reports the same condition — the two must not disagree.
		s.persistErr = fmt.Errorf("routes: mutation after close %s: %w", s.path, ErrClosed)
		return
	}
	if !s.autoFlush {
		return
	}
	// The error is not dropped: persistLocked records it in persistErr, which
	// is the only way Bind — which cannot return an error — reports that the
	// store stopped being durable.
	_ = s.persistLocked()
}
