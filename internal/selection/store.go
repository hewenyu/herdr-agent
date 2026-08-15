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
// belong to the handful of chats one allowed human has with the bot. It matters
// more than it used to, because nothing expires here any more: this bound is now
// the ONLY thing that reclaims an entry, so it is the only reason a selection can
// go away without a human asking. Dropping the chat that picked longest ago is
// the safe direction — that loss costs one tap on the picker card, while an
// unbounded file costs an fsync per message forever.
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
	// Session is deliberately NOT required, and is deliberately not part of the
	// identity the caller compares either: G8 measures a real window in which an
	// agent is already detected but its session ref is still None (Claude until
	// SessionStart, Codex until the hook is trusted with `t`), and claude mints a
	// new one on every /clear and every compaction. A selection held to it was a
	// selection that ended several times a day, for an agent that never moved.
	//
	// Cwd is what carries the weight the session used to, and the caller must
	// compare it: "the claude in ~/project" is the thing a person picked. It is
	// not required here because herdr reports no cwd for a pane whose foreground
	// process it cannot resolve, and refusing to store those would make an agent
	// unselectable for a reason the user cannot see or fix. An absent cwd refutes
	// nothing; a present one that changed is a different job (see
	// bridge.identity.matches).
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
//
// A read has no clock in it any more. There used to be an expiry evaluated
// here, and it is gone on purpose (see StaleAfter): a selection is a
// conversation the user opened, and the only things that may end it are the
// user ending it and the agent provably not being there — neither of which a
// read of this map can observe. Age is still visible to the caller through
// SelectedAt, which is what the bridge uses to remind rather than to forget.
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

// Len is the number of selections currently held. Nothing expires, so this is
// simply the size of the map.
func (s *FileStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.targets)
}

// evictLocked bounds the store, never dropping keep — the chat whose selection
// was just written, or "" when no entry is privileged.
//
// This is now the only path that removes a selection nobody asked to remove, so
// it runs at capacity and nowhere else. keep exists because ordering is purely
// by SelectedAt and Set deliberately honours a caller-supplied timestamp: at
// capacity a fresh selection carrying an older stamp (the issuing card's
// IssuedAt, say) sorts oldest and would be deleted the instant it was stored —
// the user is told the selection was made and the store never holds it.
func (s *FileStore) evictLocked(_ time.Time, keep string) {
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
