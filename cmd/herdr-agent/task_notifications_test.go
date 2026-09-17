package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func TestModelTaskAnnouncementUsesDistinctEventsAndReportsEntryFailure(t *testing.T) {
	r := tasks.Record{ID: "task", OwnerID: "owner", ChatID: "group", EntryChatID: "entry"}
	var kinds []tasks.NotificationKind
	var chats []string
	errEntry := errors.New("entry notification was not confirmed")
	notify := func(_ context.Context, got tasks.Record, kind tasks.NotificationKind, chat string) error {
		if got.ID != r.ID {
			t.Fatal("announcement switched task")
		}
		kinds, chats = append(kinds, kind), append(chats, chat)
		if kind == tasks.NotificationGroupReady {
			return errEntry
		}
		return nil
	}
	if err := announceModelTaskGroup(context.Background(), r, notify); !errors.Is(err, errEntry) {
		t.Fatalf("entry failure hidden: %v", err)
	}
	if !reflect.DeepEqual(kinds, []tasks.NotificationKind{tasks.NotificationWelcome, tasks.NotificationGroupReady}) || !reflect.DeepEqual(chats, []string{"group", "entry"}) {
		t.Fatalf("wrong events or destinations: %v %v", kinds, chats)
	}
	group := tasks.NewNotificationEvent(r, tasks.NotificationWelcome, r.ChatID)
	entry := tasks.NewNotificationEvent(r, tasks.NotificationGroupReady, r.EntryChatID)
	if group.ID == entry.ID {
		t.Fatal("independent destinations share a replay identity")
	}
}

func TestModelWelcomeFailureDoesNotClaimGroupHandoff(t *testing.T) {
	r := tasks.Record{ID: "task", OwnerID: "owner", ChatID: "group", EntryChatID: "entry"}
	calls := 0
	if err := announceModelTaskGroup(context.Background(), r, func(context.Context, tasks.Record, tasks.NotificationKind, string) error {
		calls++
		return errors.New("model unavailable")
	}); err == nil || calls != 1 {
		t.Fatalf("failed welcome became a successful handoff: calls=%d, err=%v", calls, err)
	}
}
