package dedup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/hewenyu/herdr-agent/internal/statefile"
)

// fileVersion guards against reading a layout written by a future build. A
// mismatch is treated exactly like corruption: start empty, keep booting.
const fileVersion = 1

// fileMode is mandated by S2 3.1 for everything under the state dir.
const fileMode os.FileMode = 0o600

type fileFormat struct {
	Version int      `json:"version"`
	Entries []*entry `json:"entries"` // least-recently-used first
}

// load restores state from disk. The returned error is a warning, never fatal.
func (s *FileStore) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // first run
		}
		return fmt.Errorf("dedup: read %s (starting empty): %w", s.path, err)
	}

	var f fileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		return fmt.Errorf("dedup: parse %s (starting empty): %w", s.path, err)
	}
	if f.Version != fileVersion {
		return fmt.Errorf("dedup: %s has unsupported version %d (starting empty)", s.path, f.Version)
	}

	now := s.now()
	for _, e := range f.Entries { // oldest first, so PushFront rebuilds the order
		if e == nil || e.Key == "" || !now.Before(e.Expires) {
			continue
		}
		if el, ok := s.index[e.Key]; ok {
			s.removeLocked(el)
		}
		s.index[e.Key] = s.lru.PushFront(&entry{Key: e.Key, Expires: e.Expires})
	}
	s.evictLocked(now)
	return nil
}

// persistLocked writes the live set out atomically.
//
// Dead entries are purged first. Nothing else reclaims them below capacity —
// SeenOrMark only drops the key it was asked about — so with write-through on
// (the default) every incoming event would otherwise re-encode and re-fsync a
// file bigger than the set it actually protects, and a low-traffic bridge
// would accumulate keys in dedup.json forever.
func (s *FileStore) persistLocked() (err error) {
	// One exit point for the error: LastError must never disagree with what
	// the caller was told, and the callers that need it most (SeenOrMark,
	// Unmark) have no error return of their own.
	defer func() { s.persistErr = err }()

	s.purgeExpiredLocked(s.now())

	f := fileFormat{Version: fileVersion, Entries: make([]*entry, 0, s.lru.Len())}
	for el := s.lru.Back(); el != nil; el = el.Prev() { // oldest first
		f.Entries = append(f.Entries, el.Value.(*entry))
	}
	data, err := json.Marshal(&f)
	if err != nil {
		return fmt.Errorf("dedup: encode %s: %w", s.path, err)
	}
	if err = writeFileAtomic(s.path, append(data, '\n')); err != nil {
		return err
	}
	return nil
}

// writeFileAtomic preserves the cache stores' best-effort directory sync policy.
// The common writer still reports every failure before the atomic replacement.
func writeFileAtomic(path string, data []byte) error {
	committed, err := statefile.Write(path, data, fileMode)
	if committed {
		return nil
	}
	return err
}
