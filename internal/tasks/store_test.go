package tasks

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestStorePersistsBindingsAndRejectsFailedUpdates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "tasks.json")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	want := Record{ID: "t_first", OwnerID: "ou_owner", Project: "repo", Path: "/repo", Agent: "claude", Title: "修复登录", GUID: "guid-1", ChatID: "oc_task", WorkspaceID: "w1", PaneID: "w1:p1", SessionID: "session-1", Status: Running, Started: true, PromptSent: true, CreatedAt: created, UpdatedAt: created}
	if _, err := store.Update(want.ID, func(r *Record) error { *r = want; return nil }); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("reject this update")
	if _, err := store.Update(want.ID, func(r *Record) error { r.Title = "must not persist"; return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("update error = %v", err)
	}
	if got, _ := store.Get(want.ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("failed update changed memory: %+v", got)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := reopened.Get(want.ID); !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("reopened binding = %+v, %v; want %+v", got, ok, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Errorf("task state exposes owner/session bindings: mode %o", info.Mode().Perm())
	}
}

func TestStoreRejectsCorruptOrIncompatibleState(t *testing.T) {
	for _, body := range []string{
		`{"version":1,"records":`,
		`{"version":2,"records":{}}`,
		`{"version":1}`,
		`{"version":1,"records":{"t_1":{"id":"t_other","owner_id":"ou_owner"}}}`,
		`{"version":1,"records":{"t_1":{"id":"t_1"}}}`,
		`{"version":1,"records":{"":{"id":"","owner_id":"ou_owner"}}}`,
	} {
		t.Run(strings.ReplaceAll(body, "/", "_"), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "tasks.json")
			if err := os.WriteFile(path, []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			if store, err := Open(path); err == nil || store != nil {
				t.Fatalf("Open corrupt state = %v, %v; must not fall back to empty state", store, err)
			}
			unchanged, err := os.ReadFile(path)
			if err != nil || string(unchanged) != body {
				t.Fatalf("corrupt file was modified: %q, %v", unchanged, err)
			}
		})
	}
}

func TestStoreWriteFailureDoesNotPublishRecord(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(parent, []byte("existing file"), 0600); err != nil {
		t.Fatal(err)
	}
	store := &Store{path: filepath.Join(parent, "tasks.json"), records: map[string]Record{}}
	if _, err := store.Update("t_1", func(r *Record) error { *r = Record{ID: "t_1", OwnerID: "ou_owner"}; return nil }); err == nil {
		t.Fatal("expected persistence error")
	}
	if _, ok := store.Get("t_1"); ok {
		t.Fatal("unpersisted task became visible and could trigger side effects")
	}
}
