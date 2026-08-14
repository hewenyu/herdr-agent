package routes

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// fileVersion guards against reading a layout written by a future build. A
// mismatch is treated exactly like corruption: start empty, keep booting.
const fileVersion = 1

// fileMode is mandated by S2 3.1 for everything under the state dir. The file
// names which agent every message concerns; it is not world-readable.
const fileMode os.FileMode = 0o600

type fileFormat struct {
	Version int      `json:"version"`
	Entries []*entry `json:"entries"` // oldest binding first
}

// load restores state from disk. The returned error is a warning, never fatal.
func (s *FileStore) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // first run
		}
		return fmt.Errorf("routes: read %s (starting empty): %w", s.path, err)
	}

	var f fileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		return fmt.Errorf("routes: parse %s (starting empty): %w", s.path, err)
	}
	if f.Version != fileVersion {
		return fmt.Errorf("routes: %s has unsupported version %d (starting empty)", s.path, f.Version)
	}

	now := s.now()
	for _, e := range f.Entries { // oldest first, so PushFront rebuilds the order
		if e == nil || e.MessageID == "" || e.PaneID == "" || !s.liveLocked(e, now) {
			continue
		}
		if el, ok := s.index[e.MessageID]; ok {
			s.removeLocked(el)
		}
		s.index[e.MessageID] = s.order.PushFront(&entry{MessageID: e.MessageID, PaneID: e.PaneID, BoundAt: e.BoundAt})
	}
	s.evictLocked(now)
	return nil
}

// persistLocked writes the live set out atomically.
//
// Dead bindings are purged first. Nothing else reclaims them below capacity —
// Lookup only drops the one binding it was asked about — so with write-through
// on (the default) a bridge that sends many messages and receives few replies
// would re-encode and re-fsync a file far bigger than the set it can still
// route, and would keep week-old message ids on disk indefinitely.
func (s *FileStore) persistLocked() (err error) {
	// One exit point for the error: LastError must never disagree with what
	// the caller was told, and the caller that needs it most (Bind) has no
	// error return of its own.
	defer func() { s.persistErr = err }()

	s.purgeExpiredLocked(s.now())

	f := fileFormat{Version: fileVersion, Entries: make([]*entry, 0, s.order.Len())}
	for el := s.order.Back(); el != nil; el = el.Prev() { // oldest first
		f.Entries = append(f.Entries, el.Value.(*entry))
	}
	data, err := json.Marshal(&f)
	if err != nil {
		return fmt.Errorf("routes: encode %s: %w", s.path, err)
	}
	if err = writeFileAtomic(s.path, append(data, '\n')); err != nil {
		return err
	}
	return nil
}

// tempPrefix names the in-progress writes for one state file. Dot-prefixed so
// the sweep at Open cannot mistake an unrelated file for its own litter.
func tempPrefix(base string) string { return "." + base + ".tmp-" }

// reclaimTempFiles deletes temp files abandoned by a killed process.
//
// Best effort on purpose: this is junk collection, and being unable to unlink
// stale junk is not a reason to refuse to boot the bridge. A dir that is truly
// unwritable is caught by the write probe in OpenWith, which does have an error
// to return. Matched by prefix rather than filepath.Glob because a base name
// containing a glob metacharacter would silently match nothing.
func reclaimTempFiles(dir, base string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	prefix := tempPrefix(base)
	for _, e := range ents {
		if !e.IsDir() && strings.HasPrefix(e.Name(), prefix) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// writeFileAtomic writes data to path via tmp + fsync + rename so a crash
// mid-write leaves either the old file or the new one, never a half file that
// would be discarded at boot.
func writeFileAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, tempPrefix(filepath.Base(path))+"*")
	if err != nil {
		return fmt.Errorf("routes: create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	// Explicit, even though CreateTemp already uses 0600: the mode is a
	// requirement of this file, not an inherited default.
	if err = tmp.Chmod(fileMode); err != nil {
		return fmt.Errorf("routes: chmod %s: %w", tmpName, err)
	}
	if _, err = tmp.Write(data); err != nil {
		return fmt.Errorf("routes: write %s: %w", tmpName, err)
	}
	// Rename is atomic with respect to the directory entry only; without this
	// the new name can point at unwritten blocks after a power loss.
	if err = tmp.Sync(); err != nil {
		return fmt.Errorf("routes: fsync %s: %w", tmpName, err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("routes: close %s: %w", tmpName, err)
	}
	if err = os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("routes: rename %s -> %s: %w", tmpName, path, err)
	}
	syncDir(dir)
	return nil
}

// syncDir persists the rename itself. Best effort: not every filesystem allows
// fsync on a directory, and failing there must not fail an otherwise good write.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}
