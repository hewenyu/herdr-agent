package selection

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// ErrClosed is returned by Flush after Close.
var ErrClosed = errors.New("selection: store is closed")

// DefaultMaxEntries bounds the on-disk store.
//
// Nothing in the product should ever approach it: authorization is a default-
// deny open_id allowlist (S2 3.4), so the only chat ids that can ever reach Set
// belong to the handful of chats one allowed human has with the bot, and the
// 12h TTL retires them anyway. It exists so that a misconfigured allowlist
// cannot grow the state file without limit, and dropping the least recently
// selected chat is the safe direction: a missing selection costs one tap on the
// picker card, while an unbounded file costs an fsync per message forever.
const DefaultMaxEntries = 256

// FileStore is the disk-backed Store: chat_id -> Target, persisted as a single
// JSON file, written through on every change.
type FileStore struct {
	path       string
	now        func() time.Time
	maxEntries int
	autoFlush  bool
	loadWarn   error

	mu      sync.Mutex
	targets map[string]Target
	closed  bool

	// persistErr remembers a failed write-through, which Set and Clear cannot
	// report: neither has an error return. Exposed via LastError so a store
	// that quietly stopped being durable can be noticed.
	persistErr error
}

var _ Store = (*FileStore)(nil)

// Option configures a FileStore.
type Option func(*settings)

type settings struct {
	now        func() time.Time
	maxEntries int
	autoFlush  bool
}

// WithClock injects the time source. Tests use it to cross the 12h TTL
// boundary without sleeping.
func WithClock(now func() time.Time) Option {
	return func(s *settings) {
		if now != nil {
			s.now = now
		}
	}
}

// WithMaxEntries overrides DefaultMaxEntries. Values <= 0 are ignored.
func WithMaxEntries(n int) Option {
	return func(s *settings) {
		if n > 0 {
			s.maxEntries = n
		}
	}
}

// WithAutoFlush controls write-through persistence, on by default.
//
// On is the safe default in both directions. A selection that only ever lived
// in memory would make the next plain message after a restart hit the picker
// card instead of the agent the user was mid-conversation with; worse, a Clear
// that only ever lived in memory would resurrect a selection that was cleared
// precisely because delivering to it had become unsafe. Turning it off batches
// writes until Flush/Close.
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
// because a selection cache got mangled would trade "the user taps the picker
// card once" for a total outage.
//
// A state dir that cannot be written IS an error. That is not the same failure:
// it costs every future selection, not the ones already lost, and Set has no
// error return to report it with. OpenWith therefore writes once before
// returning, so an unwritable dir stops the bridge at boot instead of letting
// it look healthy while dropping the selection on every restart.
func OpenWith(path string, opts ...Option) (*FileStore, error) {
	if path == "" {
		return nil, errors.New("selection: empty store path")
	}
	cfg := settings{now: time.Now, maxEntries: DefaultMaxEntries, autoFlush: true}
	for _, opt := range opts {
		opt(&cfg)
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("selection: create state dir %s: %w", dir, err)
		}
	}
	s := &FileStore{
		path:       path,
		now:        cfg.now,
		maxEntries: cfg.maxEntries,
		autoFlush:  cfg.autoFlush,
		targets:    make(map[string]Target),
	}
	s.loadWarn = s.load()

	// A dot-prefixed temp file survives any kill between CreateTemp and Rename.
	// With write-through on there is one such window per selection change and
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
		return nil, fmt.Errorf("selection: state dir %s is not writable: %w", filepath.Dir(path), err)
	}
	return s, nil
}

// LoadWarning reports why the on-disk state was discarded at Open, or nil if it
// was loaded (or simply absent). Callers should log it: after a silent reset
// the first plain message in every chat lands on the picker card instead of the
// agent the user was talking to, which looks like the bridge forgetting rather
// than like a damaged file.
func (s *FileStore) LoadWarning() error { return s.loadWarn }

// Set replaces the chat's target.
func (s *FileStore) Set(chatID string, t Target) {
	// Pane says where to deliver; Kind is half of the identity re-checked
	// before every delivery. A pane id is a seat, not an identity (G8, G17):
	// with no Kind recorded there is nothing to compare the live agent against,
	// so a stored selection could only ever be honoured blind — and typing into
	// the wrong agent is how prose becomes an approval (G1). Refusing to store
	// it costs the user one tap on the picker card.
	//
	// Session is deliberately NOT required: G8 measures a real window in which
	// an agent is already detected but its session ref is still None (Claude
	// until SessionStart, Codex until the hook is trusted with `t`), and a
	// selection made in that window is legitimate.
	//
	// Accepting an empty Session is only safe under one comparison rule, which
	// the caller owns and must not soften: a recorded empty Session matches
	// ONLY a live agent that also reports none. Once herdr reports a session
	// ref for that pane, an empty recorded Session is a MISMATCH — the bridge
	// clears the selection and re-posts the picker rather than delivering.
	// Reading the empty value as "matches anything" would turn G8's narrow
	// detection window into a permanent wildcard: select claude at w1:p1 before
	// SessionStart, that claude exits hours later, a different claude starts in
	// the same seat in another project, Kind still matches, and the next thing
	// typed lands in the wrong agent's context — which is how prose becomes an
	// approval (G1). The rule costs one extra tap, once, inside the detection
	// window, and closes the seat-vs-identity hole (G8, G17).
	if chatID == "" || t.Pane == "" || t.Kind == "" {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	// A caller-supplied timestamp is kept: it lets the bridge rewrite a target
	// (a new CardMessageID for the same selection, say) without silently
	// restarting a TTL that only a fresh human confirmation should restart.
	// The zero value cannot mean that — it is what a struct literal that forgot
	// the field carries, and honouring it would read as expired at the very
	// first Get, i.e. a selection that silently never worked.
	if t.SelectedAt.IsZero() {
		t.SelectedAt = now
	}
	s.targets[chatID] = t
	// Never evict what was just stored: see evictLocked.
	s.evictLocked(now, chatID)
	s.afterMutateLocked()
}

// Get returns the chat's target.
func (s *FileStore) Get(chatID string) (Target, bool) {
	if chatID == "" {
		return Target{}, false
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	t, ok := s.targets[chatID]
	if !ok {
		return Target{}, false
	}
	if !live(t, s.now()) {
		// Expired, evaluated HERE at read time, and deliberately NOT refreshed
		// by this read: the TTL bounds time since a human last confirmed the
		// selection, not time since it was last used. A chat that keeps typing
		// would otherwise hold a selection forever, which is exactly the
		// "tomorrow's first message goes somewhere forgotten" the TTL exists
		// to prevent.
		//
		// Drop it while we hold the lock, and make the drop durable. load()
		// ignoring dead entries is not enough on its own: the retired entry
		// would stay in the file, and a backwards clock correction (the same
		// wrong-clock-at-boot case live() fails closed on) plus a restart — S2
		// 3.1 says the bridge is killed and restarted routinely — would read it
		// back inside its old window, so the 12h bound would hold in memory
		// only. This is one fsync per stale selection, not one per read: the
		// entry is gone from the map afterwards, so the next Get on this chat
		// is a plain miss.
		//
		// Not afterMutateLocked: that records a lost-mutation error on a closed
		// store, which would be a false alarm raised by a read.
		delete(s.targets, chatID)
		if !s.closed && s.autoFlush {
			_ = s.persistLocked()
		}
		return Target{}, false
	}
	return t, true
}

// Clear forgets the chat's selection.
func (s *FileStore) Clear(chatID string) {
	if chatID == "" {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.targets[chatID]; !ok {
		// Nothing to forget: skip the write so a Clear on an already-clear chat
		// (the identity-mismatch path can run twice) is not an fsync.
		return
	}
	delete(s.targets, chatID)
	s.afterMutateLocked()
}

// Flush persists to disk atomically (tmp + fsync + rename, mode 0600).
func (s *FileStore) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fmt.Errorf("selection: flush %s: %w", s.path, ErrClosed)
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
// write succeeded. Set and Clear write through to disk but cannot return an
// error; without this a store that stopped being durable would be silent until
// the next restart resurrected a cleared selection.
func (s *FileStore) LastError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.persistErr
}

// Len is the number of live selections currently held.
//
// Entries past their TTL are excluded even when they are still in the map:
// nothing purges a dead selection until it is read again, the store overflows,
// or it is written out, so the raw size can stay high long after the selections
// it counts stopped resolving.
func (s *FileStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	n := 0
	for _, t := range s.targets {
		if live(t, now) {
			n++
		}
	}
	return n
}

// live reports whether a target is still inside its TTL window.
func live(t Target, now time.Time) bool {
	d := now.Sub(t.SelectedAt)
	// Fail closed on a selection dated in the future. A Mac whose clock is
	// wrong at boot (VM snapshot restore, dead RTC, the window before NTP
	// lands) writes exactly those, and a plain `d < TTL` would call them live
	// until the clock caught up — a 2099 timestamp stays selected for 73 years,
	// which is precisely the unbounded staleness G17 says must not exist.
	// Losing a selection costs one tap on the picker card; keeping a stale one
	// aims plain typing at a pane that may now hold a different agent.
	return d >= 0 && d < TTL
}

// evictLocked bounds the store, never dropping keep — the chat whose selection
// was just written, or "" when no entry is privileged.
//
// keep exists because ordering is purely by SelectedAt and Set deliberately
// honours a caller-supplied timestamp: at capacity a fresh selection carrying an
// older stamp (the issuing card's IssuedAt, say) sorts oldest and would be
// deleted the instant it was stored — the user is told the selection was made
// and the store never holds it. Protection is against eviction only, not the
// purge below: an entry stored already outside its TTL routes nothing anyway.
func (s *FileStore) evictLocked(now time.Time, keep string) {
	if len(s.targets) <= s.maxEntries {
		return
	}
	// At capacity: drop everything already dead before evicting anything still
	// inside its window. An expired selection routes nothing; a live one is
	// somebody's current conversation.
	s.purgeExpiredLocked(now)
	if len(s.targets) <= s.maxEntries {
		return
	}
	chats := make([]string, 0, len(s.targets))
	for c := range s.targets {
		chats = append(chats, c)
	}
	// Oldest selection first. Map iteration order is random, so the chat id
	// breaks ties: without it, two selections made in the same instant would
	// evict differently on every run and the store would be untestable.
	slices.SortFunc(chats, func(a, b string) int {
		if c := s.targets[a].SelectedAt.Compare(s.targets[b].SelectedAt); c != 0 {
			return c
		}
		return strings.Compare(a, b)
	})
	for _, c := range chats {
		if len(s.targets) <= s.maxEntries {
			break
		}
		if c == keep {
			continue
		}
		delete(s.targets, c)
	}
}

// purgeExpiredLocked drops every selection past its TTL. It is deliberately NOT
// called on every Set: the scan is O(n) and Get already ignores a dead
// selection when it reads one. It runs where the cost is already paid — at
// capacity, and just before a write-through.
func (s *FileStore) purgeExpiredLocked(now time.Time) {
	for c, t := range s.targets {
		if !live(t, now) {
			delete(s.targets, c)
		}
	}
}

func (s *FileStore) afterMutateLocked() {
	if s.closed {
		// A mutation after Close is lost whatever autoFlush says, because Flush
		// is closed too. Record it: Set and Clear have no error return, so this
		// is the only signal that the change never reached disk, and Flush
		// already reports the same condition — the two must not disagree.
		s.persistErr = fmt.Errorf("selection: mutation after close %s: %w", s.path, ErrClosed)
		return
	}
	if !s.autoFlush {
		return
	}
	// The error is not dropped: persistLocked records it in persistErr, which
	// is the only way Set and Clear — which cannot return an error — report
	// that the store stopped being durable.
	_ = s.persistLocked()
}
