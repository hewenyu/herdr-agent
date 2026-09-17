package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestLegacyReviewNoticeMigrationDoesNotRepeatOldCompletion(t *testing.T) {
	for _, reported := range []bool{false, true} {
		t.Run(map[bool]string{false: "unreported", true: "reported"}[reported], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "tasks.json")
			r := Record{ID: "task", OwnerID: "owner", ChatID: "group", Status: Review, PromptSent: true}
			if reported {
				r.ReportedNotice = noticePrefix(Review) + "本轮已结束，等待验收或下一步指令\n旧版提示"
				r.ReportedChatID, r.ReportedAt = r.ChatID, time.Now()
			}
			data, _ := json.Marshal(map[string]any{"version": 1, "records": map[string]Record{r.ID: r}})
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			store, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			migrated, _ := store.Get(r.ID)
			if migrated.ReviewVersion != 1 || notificationAlreadyReported(migrated) != reported {
				t.Fatalf("wrong migration: %+v", migrated)
			}
			reopened, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			again, _ := reopened.Get(r.ID)
			if again.ReviewVersion != 1 || again.ReportedStateKey != migrated.ReportedStateKey {
				t.Fatal("migration was not durable")
			}
			if _, err := reopened.Update(r.ID, func(r *Record) error { r.Status = Running; return nil }); err != nil {
				t.Fatal(err)
			}
			next, err := reopened.Update(r.ID, func(r *Record) error { r.Status = Review; return nil })
			if err != nil || next.ReviewVersion != 2 || notificationAlreadyReported(next) {
				t.Fatalf("new execution inherited legacy completion: %+v, %v", next, err)
			}
		})
	}
}

func TestNotificationKeysUseStateAndFreshOccurrenceInsteadOfText(t *testing.T) {
	r := Record{ID: "task", OwnerID: "owner", ChatID: "group", Status: Review, ReviewVersion: 3}
	first := NewNotificationEvent(r, NotificationProgress, r.ChatID)
	r.Detail, r.Result = "another observer description", "new agent result fragment"
	if next := NewNotificationEvent(r, NotificationProgress, r.ChatID); next.ID != first.ID {
		t.Fatal("observer wording changed notification identity")
	}
	r.ReportedSequence++
	if next := NewNotificationEvent(r, NotificationProgress, r.ChatID); next.ID == first.ID {
		t.Fatal("later state occurrence replayed an earlier notification")
	}
	r.CloseVersion = 1
	closing := NewNotificationEvent(r, NotificationClosing, r.ChatID)
	r.SyncError = "notification transport failed"
	if next := NewNotificationEvent(r, NotificationClosing, r.ChatID); next.ID != closing.ID {
		t.Fatal("closing retry changed its identity")
	}
	r.CloseVersion++
	if next := NewNotificationEvent(r, NotificationClosing, r.ChatID); next.ID == closing.ID {
		t.Fatal("a later user closure was suppressed")
	}
}

func TestResultDeliveryReceiptDoesNotChangeLifecycleAndResetsOnNewExecution(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "delivery-marker").ID, 1)
	if err := h.manager.Observe(r.PaneID, Review, ReviewDetail, "最终正文"); err != nil {
		t.Fatal(err)
	}
	before, _ := h.store.Get(r.ID)
	if err := h.manager.MarkResultDelivered(r.PaneID, "不同结果"); err != nil {
		t.Fatal(err)
	}
	wrong, _ := h.store.Get(r.ID)
	if wrong.ResultDelivered {
		t.Fatal("unrelated result marked delivered")
	}
	if err := h.manager.MarkResultDelivered(r.PaneID, "最终正文"); err != nil {
		t.Fatal(err)
	}
	marked, _ := h.store.Get(r.ID)
	if !marked.ResultDelivered || marked.ResultDeliveredAt.IsZero() || marked.ReviewVersion != before.ReviewVersion || NotificationStateKey(marked) != NotificationStateKey(before) {
		t.Fatalf("delivery was not a pure receipt: %+v", marked)
	}
	if err := h.manager.Observe(r.PaneID, Running, "继续", ""); err != nil {
		t.Fatal(err)
	}
	next, _ := h.store.Get(r.ID)
	if next.ResultDelivered || !next.ResultDeliveredAt.IsZero() {
		t.Fatal("next execution inherited delivery receipt")
	}
	h.manager.opts.Report = func(context.Context, Record) error { return nil }
	h.manager.report(context.Background(), r.ID)
}

func TestAsyncNotificationFailuresNeverBlockOrRepeatTaskStartup(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	h.manager.opts.AsyncNotifications = true
	announcements, reports := 0, 0
	h.manager.opts.Announce = func(context.Context, Record) error {
		announcements++
		return errors.New("notification model unavailable")
	}
	h.manager.opts.Report = func(context.Context, Record) error {
		reports++
		return errors.New("notification transport unavailable")
	}
	r := h.reconcile(t, h.create(t, "async-notifications").ID, 1)
	if !r.Started || !r.PromptSent || r.Status != Running || announcements != 0 || reports != 0 {
		t.Fatalf("startup depended on notifications: %+v announcements=%d reports=%d", r, announcements, reports)
	}
	h.manager.notifyLifecycle(context.Background(), r.ID)
	failed, _ := h.store.Get(r.ID)
	if failed.Announced || failed.ReportedStateKey != "" || failed.Error != "" || failed.SyncError != "" {
		t.Fatalf("notification failure changed task execution or claimed delivery: %+v", failed)
	}
	h.restart(t)
	h.reconcile(t, r.ID, 1)
	h.manager.notifyLifecycle(context.Background(), r.ID)
	if announcements != 2 || reports != 2 || len(h.lifecycle.starts) != 1 || len(h.platform.created) != 1 || len(h.controller.says) != 1 {
		t.Fatalf("notification retry repeated task resources: announcements=%d reports=%d starts=%d tasks=%d prompts=%d", announcements, reports, len(h.lifecycle.starts), len(h.platform.created), len(h.controller.says))
	}
}

func TestAsyncBlockedReportDoesNotDelayInitialPrompt(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	h.manager.opts.AsyncNotifications = true
	h.lifecycle.startupStatus = "blocked"
	r := h.reconcile(t, h.create(t, "blocked-notification").ID, 1)
	if r.PromptSent || r.Status != Blocked {
		t.Fatalf("expected startup approval before the first prompt: %+v", r)
	}
	entered, release, noticeDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var enteredOnce, releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	h.manager.opts.Report = func(ctx context.Context, _ Record) error {
		enteredOnce.Do(func() { close(entered) })
		select {
		case <-release:
			return errors.New("notification model unavailable")
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	go func() {
		defer close(noticeDone)
		h.manager.notifyLifecycle(context.Background(), r.ID)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("background notification did not start")
	}
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) {
		a.AgentStatus, a.InteractiveReady, a.LaunchPending = "idle", true, false
	})
	reconciled := make(chan error, 1)
	go func() { reconciled <- h.manager.reconcile(context.Background(), r.ID) }()
	select {
	case err := <-reconciled:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		unblock()
		<-reconciled
		t.Fatal("initial prompt waited for the blocked notification")
	}
	started, _ := h.store.Get(r.ID)
	if !started.PromptSent || started.Status != Running || len(h.controller.says) != 1 {
		t.Fatalf("initial prompt was not delivered while notification remained blocked: %+v", started)
	}
	unblock()
	<-noticeDone
}
