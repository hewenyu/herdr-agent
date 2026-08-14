package setup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// joinPath is filepath.Join, named so that the state-directory layout reads in
// one place.
func joinPath(dir, name string) string { return filepath.Join(dir, name) }

// splitLines splits a file into lines without inventing a trailing empty one,
// so that read → modify → write is byte-stable when nothing changed.
func splitLines(data string) []string {
	if data == "" {
		return nil
	}
	lines := strings.Split(data, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	return lines
}

// joinLines is splitLines' inverse: every line is terminated, including the
// last, because a file whose final line has no newline confuses every tool
// that appends to it.
func joinLines(lines []string) []byte {
	if len(lines) == 0 {
		return nil
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// writeFileAtomic writes data to path via tmp + fsync + rename, so a crash
// mid-write leaves either the previous file or the new one.
//
// This matters more here than anywhere else in the bridge: the file being
// written is the only copy of a secret Feishu will never show again, and a
// half-written .env is indistinguishable from a wrong one.
func writeFileAtomic(path string, data []byte, mode os.FileMode) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("setup: create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	// Explicit even though CreateTemp already uses 0600: the mode is a
	// requirement of these files, not an inherited default.
	if err = tmp.Chmod(mode); err != nil {
		return fmt.Errorf("setup: chmod %s: %w", tmpName, err)
	}
	if _, err = tmp.Write(data); err != nil {
		return fmt.Errorf("setup: write %s: %w", tmpName, err)
	}
	// Rename is atomic with respect to the directory entry only; without this
	// the new name can point at unwritten blocks after a power loss.
	if err = tmp.Sync(); err != nil {
		return fmt.Errorf("setup: fsync %s: %w", tmpName, err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("setup: close %s: %w", tmpName, err)
	}
	if err = os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("setup: rename %s -> %s: %w", tmpName, path, err)
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
