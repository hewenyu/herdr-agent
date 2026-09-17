// Package statefile provides the atomic replacement used by local state stores.
// Callers own locking, directory creation, serialization and recovery policy.
package statefile

import (
	"fmt"
	"os"
	"path/filepath"
)

// Write replaces path with data at mode, syncing both the file and its directory.
// committed becomes true at rename, even if syncing the directory then fails.
// Callers must publish the new in-memory state when committed is true; retrying
// as though nothing was written could duplicate an external operation.
// A false result preserves the previous destination. The parent must exist.
func Write(path string, data []byte, mode os.FileMode) (committed bool, err error) {
	return write(path, data, mode, syncDir)
}

func write(path string, data []byte, mode os.FileMode, syncDirectory func(string) error) (bool, error) {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return false, fmt.Errorf("statefile: create temporary file: %w", err)
	}
	temporary := f.Name()
	defer os.Remove(temporary)
	// Close on every failure before rename, without masking the original error.
	defer f.Close()
	if err := f.Chmod(mode); err != nil {
		return false, fmt.Errorf("statefile: set permissions: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		return false, fmt.Errorf("statefile: write: %w", err)
	}
	if err := f.Sync(); err != nil {
		return false, fmt.Errorf("statefile: sync file: %w", err)
	}
	if err := f.Close(); err != nil {
		return false, fmt.Errorf("statefile: close file: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		return false, fmt.Errorf("statefile: replace: %w", err)
	}
	if err := syncDirectory(dir); err != nil {
		return true, fmt.Errorf("statefile: sync directory: %w", err)
	}
	return true, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
