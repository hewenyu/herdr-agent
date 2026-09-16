package tasks

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestManagerAcceptanceSavesResultThenNotifiesAndClosesAcrossRestart(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "accept-close").ID, 1)
	if err := h.manager.Observe(r.PaneID, Review, "待验收", "修复完成，全部回归测试通过"); err != nil {
		t.Fatal(err)
	}
	notices := 0
	h.manager.opts.BeforeClose = func(ctx context.Context, r Record) error {
		notices++
		h.log.add("closing-notice")
		remote, err := h.platform.GetTask(ctx, r.GUID)
		if err != nil || remote.CompletedAt == "" || remote.CompletedAt == "0" || !strings.Contains(remote.Description, r.Result) {
			t.Fatalf("closing notice preceded confirmed completion/result: %+v, %v", remote, err)
		}
		if r.Result != "修复完成，全部回归测试通过" || len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 0 {
			t.Fatal("closing notice lost the result or arrived after session deletion")
		}
		return nil
	}
	if _, err := h.manager.Request(r.OwnerID, r.ID, "close"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Completed || !r.CloseRequested || r.CompletionRequest != "" || r.CloseNotifiedAt.IsZero() || len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 0 {
		t.Fatalf("acceptance did not pause for the closing notice: %+v", r)
	}
	h.restart(t)
	r = h.reconcile(t, r.ID, 1)
	if notices != 1 || r.Status != Completed || len(h.lifecycle.closed) != 0 {
		t.Fatalf("restart replayed the notice or skipped its grace period: %+v, notices %d", r, notices)
	}
	if _, err := h.store.Update(r.ID, func(r *Record) error { r.CloseNotifiedAt = time.Now().Add(-closeNoticeGrace); return nil }); err != nil {
		t.Fatal(err)
	}
	h.restart(t)
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Destroyed || !r.ChatDeleted || !r.PaneClosed || notices != 1 || len(h.platform.deleted) != 1 || len(h.lifecycle.closed) != 1 {
		t.Fatalf("accepted task was not cleaned up once: %+v / %v", r, h.log.snapshot())
	}
	remote, err := h.platform.GetTask(context.Background(), r.GUID)
	if err != nil || remote.CompletedAt != r.CompletedAt || !strings.Contains(remote.Description, r.Result) || !strings.Contains(remote.Description, Destroyed.Label()) {
		t.Fatalf("closed task lost its accepted state or results: %+v, %v", remote, err)
	}
	h.restart(t)
	h.reconcile(t, r.ID, 1)
	if notices != 1 || len(h.platform.deleted) != 1 || len(h.lifecycle.closed) != 1 {
		t.Fatal("restart repeated teardown of the accepted task")
	}
}

func TestManagerAcceptanceFailuresKeepGroupAndAgent(t *testing.T) {
	for _, failure := range []string{"completion-write", "completion-readback", "closing-notice"} {
		t.Run(failure, func(t *testing.T) {
			h := newTaskTestHarness(t, "claude")
			r := h.reconcile(t, h.create(t, failure).ID, 1)
			notices := 0
			h.manager.opts.BeforeClose = func(context.Context, Record) error {
				notices++
				if failure == "closing-notice" {
					return errors.New("notification temporarily unavailable")
				}
				return nil
			}
			switch failure {
			case "completion-write":
				h.platform.updateErr = errors.New("completion update unavailable")
			case "completion-readback":
				h.platform.ignoreCompletion = true
			}
			if _, err := h.manager.Request(r.OwnerID, r.ID, "close"); err != nil {
				t.Fatal(err)
			}
			if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
				t.Fatal("expected closure prerequisite failure")
			}
			r, _ = h.store.Get(r.ID)
			if !r.CloseRequested || r.SyncError == "" || !r.CloseNotifiedAt.IsZero() || len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 0 || len(h.manager.List(r.OwnerID, false)) != 1 {
				t.Fatalf("failed close hid the task or deleted resources: %+v", r)
			}
			if failure != "closing-notice" && notices != 0 {
				t.Fatal("closing notice sent without confirmed completion")
			}
		})
	}
}

func TestManagerReopenCancelsPendingCloseAndPreservesSession(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "cancel-close").ID, 1)
	h.manager.opts.BeforeClose = func(context.Context, Record) error { return nil }
	if _, err := h.manager.Request(r.OwnerID, r.ID, "close"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.CloseNotifiedAt.IsZero() {
		t.Fatal("test did not reach closing grace period")
	}
	if _, err := h.manager.Request(r.OwnerID, r.ID, "reopen"); err != nil {
		t.Fatal(err)
	}
	h.restart(t)
	r = h.reconcile(t, r.ID, 1)
	remote, _ := h.platform.GetTask(context.Background(), r.GUID)
	if r.CloseRequested || !r.CloseNotifiedAt.IsZero() || r.Status != Review || remote.CompletedAt != "0" || len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 0 {
		t.Fatalf("reopening during grace did not cancel closure: %+v / %+v", r, remote)
	}
}

func TestManagerReopenDuringClosingNoticeCannotBeOverwritten(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "reopen-notice").ID, 1)
	h.manager.opts.BeforeClose = func(_ context.Context, r Record) error {
		_, err := h.manager.Request(r.OwnerID, r.ID, "reopen")
		return err
	}
	if _, err := h.manager.Request(r.OwnerID, r.ID, "close"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.CloseRequested || !r.CloseNotifiedAt.IsZero() || r.CompletionRequest != "reopen" || len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 0 {
		t.Fatalf("notice delivery overwrote the owner's reopen request: %+v", r)
	}
}

func TestManagerCompletionWithoutClosePreservesSession(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "complete-only").ID, 1)
	h.manager.opts.BeforeClose = func(context.Context, Record) error { t.Fatal("complete requested closure"); return nil }
	if _, err := h.manager.Request(r.OwnerID, r.ID, "complete"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 2)
	if r.Status != Completed || r.CloseRequested || len(h.lifecycle.closed) != 0 || len(h.platform.deleted) != 0 {
		t.Fatalf("complete erased a session without a close request: %+v", r)
	}
}
