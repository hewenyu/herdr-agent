package selection

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// fileVersion guards against reading a layout written by a future build. A
// mismatch is treated exactly like corruption: start empty, keep booting.
const fileVersion = 1

// fileMode is mandated by S2 3.1 for everything under the state dir. The file
// names which agent each chat is talking to, and its pane and session ids are
// enough to address that agent through the herdr socket; it is not
// world-readable.
const fileMode os.FileMode = 0o600

// entry is one chat's selection on disk. The Target is nested rather than
// flattened so that its field names stay owned by contract.go — the wire format
// of Target is fixed there, and this file must not be able to drift from it.
type entry struct {
	ChatID string `json:"c"`
	Target Target `json:"t"`
}

type fileFormat struct {
	Version int      `json:"version"`
	Entries []*entry `json:"entries"` // sorted by chat id
}

// load restores state from disk. The returned error is a warning, never fatal.
func (s *FileStore) load() error {
	data, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil // first run
		}
		return fmt.Errorf("selection: read %s (starting empty): %w", s.path, err)
	}

	var f fileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		return fmt.Errorf("selection: parse %s (starting empty): %w", s.path, err)
	}
	if f.Version != fileVersion {
		return fmt.Errorf("selection: %s has unsupported version %d (starting empty)", s.path, f.Version)
	}

	now := s.now()
	for _, e := range f.Entries {
		// Same admission rules as Set, applied again here: the file is state
		// this process did not write in this run, and a selection with no Kind
		// could not be identity-checked before delivery (G8, G17).
		if e == nil || e.ChatID == "" || e.Target.Pane == "" || e.Target.Kind == "" || !live(e.Target, now) {
			continue
		}
		// A duplicate chat id can only come from a hand-edited or merged file.
		// Keep the newest, so the result does not depend on file order.
		if prev, ok := s.targets[e.ChatID]; ok && prev.SelectedAt.After(e.Target.SelectedAt) {
			continue
		}
		s.targets[e.ChatID] = e.Target
	}
	// Nothing in a file this process did not write is privileged, so the whole
	// loaded set competes on selection age.
	s.evictLocked(now, "")
	return nil
}

// persistLocked writes the live set out atomically.
//
// Dead selections are purged first. Nothing else reclaims them below capacity —
// Get only drops the one chat it was asked about — so a bridge whose user
// selected an agent and then went quiet would keep re-encoding and re-fsyncing
// entries that can no longer route anything.
func (s *FileStore) persistLocked() (err error) {
	// One exit point for the error: LastError must never disagree with what the
	// caller was told, and the callers that need it most (Set, Clear) have no
	// error return of their own.
	defer func() { s.persistErr = err }()

	s.purgeExpiredLocked(s.now())

	chats := make([]string, 0, len(s.targets))
	for c := range s.targets {
		chats = append(chats, c)
	}
	// Sorted so that unchanged state produces byte-identical output. Map order
	// is random, and without this every write would look like a change to
	// anything watching the state dir.
	slices.Sort(chats)

	f := fileFormat{Version: fileVersion, Entries: make([]*entry, 0, len(chats))}
	for _, c := range chats {
		f.Entries = append(f.Entries, &entry{ChatID: c, Target: s.targets[c]})
	}
	data, err := json.Marshal(&f)
	if err != nil {
		return fmt.Errorf("selection: encode %s: %w", s.path, err)
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
		return fmt.Errorf("selection: create temp file in %s: %w", dir, err)
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
		return fmt.Errorf("selection: chmod %s: %w", tmpName, err)
	}
	if _, err = tmp.Write(data); err != nil {
		return fmt.Errorf("selection: write %s: %w", tmpName, err)
	}
	// Rename is atomic with respect to the directory entry only; without this
	// the new name can point at unwritten blocks after a power loss.
	if err = tmp.Sync(); err != nil {
		return fmt.Errorf("selection: fsync %s: %w", tmpName, err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("selection: close %s: %w", tmpName, err)
	}
	if err = os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("selection: rename %s -> %s: %w", tmpName, path, err)
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
