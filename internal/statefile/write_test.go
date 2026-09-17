package statefile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteReplacesAndProtectsState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	committed, err := Write(path, []byte("new state"), 0600)
	if err != nil || !committed {
		t.Fatalf("Write = %v, %v", committed, err)
	}
	b, err := os.ReadFile(path)
	if err != nil || string(b) != "new state" {
		t.Fatalf("contents = %q, %v", b, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("file permissions: %v, %v", info, err)
	}
	assertNoTemporaryFiles(t, dir)
}

func TestFailedRenamePreservesDestinationAndCleansTemporaryFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "existing")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	kept := filepath.Join(path, "keep")
	if err := os.WriteFile(kept, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	committed, err := Write(path, []byte("replacement"), 0600)
	if err == nil || committed {
		t.Fatalf("Write = %v, %v; expected pre-commit failure", committed, err)
	}
	if b, err := os.ReadFile(kept); err != nil || string(b) != "old" {
		t.Fatalf("destination damaged: %q, %v", b, err)
	}
	assertNoTemporaryFiles(t, dir)
}

func TestDirectorySyncFailureReportsCommittedState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	failure := errors.New("directory sync unavailable")
	committed, err := write(path, []byte("intent"), 0600, func(got string) error {
		if got != dir {
			t.Fatalf("sync directory = %q", got)
		}
		if b, err := os.ReadFile(path); err != nil || string(b) != "intent" {
			t.Fatalf("sync preceded commit: %q, %v", b, err)
		}
		return failure
	})
	if !committed || !errors.Is(err, failure) {
		t.Fatalf("Write = %v, %v; must preserve commit despite uncertain durability", committed, err)
	}
	assertNoTemporaryFiles(t, dir)
}

func TestMissingParentDoesNotCommit(t *testing.T) {
	committed, err := Write(filepath.Join(t.TempDir(), "missing", "state"), []byte("intent"), 0600)
	if committed || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Write = %v, %v", committed, err)
	}
}

func assertNoTemporaryFiles(t *testing.T, dir string) {
	t.Helper()
	left, err := filepath.Glob(filepath.Join(dir, ".*.tmp-*"))
	if err != nil || len(left) != 0 {
		t.Fatalf("temporary files = %v, %v", left, err)
	}
}
