package tasktools

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func TestTaskDirectoryObservationReportsRealEmptyMissingAndMultipleDirectories(t *testing.T) {
	empty, populated := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(empty, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(populated, "index.html"), []byte("PRIVATE_FILE_CONTENT_MUST_NOT_BE_READ"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(populated, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	r := view(tasks.Record{ID: "task", Path: empty, Directories: []string{empty, populated, filepath.Join(empty, "missing")}})
	if r.WorkingDirectory != empty || len(r.WorkingDirectories) != 3 {
		t.Fatalf("missing working locations: %+v", r)
	}
	first, second, third := r.WorkingDirectories[0], r.WorkingDirectories[1], r.WorkingDirectories[2]
	if !first.Available || !first.Empty || len(first.Entries) != 0 {
		t.Fatalf("Git metadata was mistaken for task artifacts: %+v", first)
	}
	if !second.Available || second.Empty || !slices.Equal(second.Entries, []string{"assets/", "index.html"}) {
		t.Fatalf("directory snapshot did not match actual top-level entries: %+v", second)
	}
	if third.Available || third.Empty || third.Problem == "" {
		t.Fatalf("missing directory was reported as empty or verified: %+v", third)
	}
}

func TestTaskDirectoryObservationIsBoundedAndDoesNotRecurse(t *testing.T) {
	dir := t.TempDir()
	for i := range 30 {
		if err := os.Mkdir(filepath.Join(dir, fmt.Sprintf("dir-%02d", i)), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "dir-00", "nested-private-file"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	r := view(tasks.Record{Path: dir})
	if len(r.WorkingDirectories) != 1 {
		t.Fatalf("legacy primary directory missing: %+v", r)
	}
	d := r.WorkingDirectories[0]
	if !d.Available || !d.Truncated || len(d.Entries) != 20 || slices.Contains(d.Entries, "nested-private-file") {
		t.Fatalf("directory observation was unbounded or recursive: %+v", d)
	}
}
