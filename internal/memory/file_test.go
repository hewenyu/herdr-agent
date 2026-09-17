package memory

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileSurvivesRestartAndIsolatesOwnerChatAndTask(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "memory")
	provider, err := NewFile(directory)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	scope := Scope{OwnerID: "../alice", ChatID: "../../chat", TaskID: "task-one"}
	entry := Entry{Summary: "建议项目 pelican-bike-svg；用户尚未确认；不要测试。", Revision: "r1"}
	if err := provider.Store(ctx, scope, entry); err != nil {
		t.Fatal(err)
	}
	provider, err = NewFile(directory)
	if err != nil {
		t.Fatal(err)
	}
	got, err := provider.Recall(ctx, scope)
	if err != nil || got != entry {
		t.Fatalf("restart recall = %+v, %v", got, err)
	}
	for _, other := range []Scope{
		{OwnerID: "bob", ChatID: scope.ChatID, TaskID: scope.TaskID},
		{OwnerID: scope.OwnerID, ChatID: "other-chat", TaskID: scope.TaskID},
		{OwnerID: scope.OwnerID, ChatID: scope.ChatID, TaskID: "task-two"},
		{OwnerID: scope.OwnerID, ChatID: scope.ChatID},
	} {
		got, err := provider.Recall(ctx, other)
		if err != nil || got != (Entry{}) {
			t.Fatalf("other scope accessed summary: %+v, %v", got, err)
		}
	}
	files, err := os.ReadDir(directory)
	if err != nil || len(files) != 1 || len(files[0].Name()) != 69 || strings.Contains(files[0].Name(), "alice") {
		t.Fatalf("scope did not map to one hashed file: %v, %v", files, err)
	}
	for _, check := range []struct {
		path string
		mode os.FileMode
	}{{directory, 0700}, {filepath.Join(directory, files[0].Name()), 0600}} {
		info, err := os.Stat(check.path)
		if err != nil || info.Mode().Perm() != check.mode {
			t.Fatalf("permissions for %s: %v, %v", check.path, info, err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := provider.Forget(ctx, scope); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := provider.Recall(ctx, scope); err != nil || got != (Entry{}) {
		t.Fatalf("forgotten summary returned: %+v, %v", got, err)
	}
}

func TestFileRejectsTamperedScopeAndPreservesInvalidState(t *testing.T) {
	provider, err := NewFile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := provider.(*fileProvider)
	scope := Scope{OwnerID: "alice", ChatID: "chat"}
	data, _ := json.Marshal(fileEntry{Version: 1, Scope: Scope{OwnerID: "bob", ChatID: "chat"}, Entry: &Entry{Summary: "private"}})
	path := p.path(scope)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := p.Recall(context.Background(), scope); err == nil || got != (Entry{}) {
		t.Fatalf("mismatched scope accepted: %+v, %v", got, err)
	}
	if after, err := os.ReadFile(path); err != nil || string(after) != string(data) {
		t.Fatal("failed read overwrote original state")
	}
}

func TestFileCancellationAndInvalidEntriesDoNotReplaceMemory(t *testing.T) {
	provider, err := NewFile(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	scope := Scope{OwnerID: "alice", ChatID: "chat"}
	original := Entry{Summary: "keep this"}
	if err := provider.Store(context.Background(), scope, original); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := provider.Store(ctx, scope, Entry{Summary: "replace"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled store = %v", err)
	}
	if err := provider.Forget(ctx, scope); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled forget = %v", err)
	}
	if _, err := provider.Recall(ctx, scope); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled recall = %v", err)
	}
	if err := provider.Store(context.Background(), scope, Entry{Summary: strings.Repeat("x", maxSummaryBytes+1)}); err == nil {
		t.Fatal("oversized summary was stored")
	}
	if got, err := provider.Recall(context.Background(), scope); err != nil || got != original {
		t.Fatalf("failed mutation changed summary: %+v, %v", got, err)
	}
	if _, err := provider.Recall(context.Background(), Scope{ChatID: "chat"}); err == nil {
		t.Fatal("missing owner accepted")
	}
}
