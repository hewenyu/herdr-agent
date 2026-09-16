package tasks

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestManagerReportsStartupBeforeLaunchingAndDeduplicatesAfterRestart(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error {
		reports = append(reports, r)
		h.log.add("report:" + string(r.Status))
		return nil
	}
	h.lifecycle.workspaceCreated = func() {
		if len(reports) == 0 || reports[0].Status != Queued {
			t.Error("queued progress was not delivered before provisioning")
		}
		groupReported := false
		for _, r := range reports {
			if r.ChatID != "" && r.Status == Starting {
				groupReported = true
			}
		}
		if !groupReported {
			t.Error("task group received no startup progress before creating its agent")
		}
	}
	r := h.reconcile(t, h.create(t, "early-progress").ID, 1)
	if reports[len(reports)-1].Status != Running || r.ReportedAt.IsZero() || r.ReportedNotice != Notice(r) {
		t.Fatalf("initial running report not checkpointed: %+v / %+v", r, reports)
	}
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) {
		a.AgentStatus = "working"
		a.TerminalTitleStripped = &r.Detail
	})
	count := len(reports)
	h.restart(t)
	h.reconcile(t, r.ID, 2)
	if len(reports) != count {
		t.Fatalf("restart repeated stable progress: before %d, after %d", count, len(reports))
	}
}

func TestManagerRateLimitsRunningProgressButReportsTransitionsImmediately(t *testing.T) {
	h := newTaskTestHarness(t, "claude")
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error { reports = append(reports, r); return nil }
	r := h.reconcile(t, h.create(t, "progress-rate").ID, 1)
	count := len(reports)
	progress := "正在检查第二个接口"
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "working"; a.TerminalTitleStripped = &progress })
	if err := h.manager.Observe(r.PaneID, Running, progress, ""); err != nil {
		t.Fatal(err)
	}
	h.reconcile(t, r.ID, 2)
	if len(reports) != count {
		t.Fatal("incremental progress flooded the task group before its cooldown")
	}
	if _, err := h.store.Update(r.ID, func(r *Record) error { r.ReportedAt = time.Now().Add(-runningReportInterval); return nil }); err != nil {
		t.Fatal(err)
	}
	h.reconcile(t, r.ID, 1)
	if len(reports) != count+1 || reports[len(reports)-1].Detail != progress {
		t.Fatalf("latest progress was not sent after cooldown: %+v", reports)
	}
	count = len(reports)
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "blocked" })
	if err := h.manager.Observe(r.PaneID, Blocked, "等待批准测试命令", ""); err != nil {
		t.Fatal(err)
	}
	h.reconcile(t, r.ID, 1)
	if len(reports) != count+1 || reports[len(reports)-1].Status != Blocked {
		t.Fatal("running cooldown delayed an approval blocker")
	}
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "idle" })
	h.reconcile(t, r.ID, 1)
	if last := reports[len(reports)-1]; last.Status != Review || !strings.Contains(Notice(last), "本群") || !strings.Contains(Notice(last), "验收") {
		t.Fatalf("completed agent turn did not invite acceptance in its group: %+v", last)
	}
}

func TestManagerReportsSameSyncFailureAgainAfterRecovery(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error { reports = append(reports, r); return nil }
	r := h.reconcile(t, h.create(t, "sync-recurrence").ID, 1)
	progress := "正在验证修复"
	h.lifecycle.setAgent(r.PaneID, func(a *herdrapi.AgentInfo) { a.AgentStatus = "working"; a.TerminalTitleStripped = &progress })
	h.platform.updateErr = errors.New("temporary synchronization error")
	if err := h.manager.Observe(r.PaneID, Running, progress, ""); err != nil {
		t.Fatal(err)
	}
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("expected failed synchronization")
	}
	count := len(reports)
	if reports[count-1].SyncError == "" {
		t.Fatal("sync failure was not reported")
	}
	_ = h.manager.reconcile(context.Background(), r.ID)
	if len(reports) != count {
		t.Fatal("constant sync failure was reported repeatedly")
	}
	h.platform.updateErr = nil
	h.reconcile(t, r.ID, 1)
	if reports[len(reports)-1].SyncError != "" {
		t.Fatal("successful recovery did not clear the reported failure")
	}
	progress = "正在执行回归测试"
	if err := h.manager.Observe(r.PaneID, Running, progress, ""); err != nil {
		t.Fatal(err)
	}
	h.platform.updateErr = errors.New("temporary synchronization error")
	count = len(reports)
	_ = h.manager.reconcile(context.Background(), r.ID)
	if len(reports) != count+1 || reports[len(reports)-1].SyncError == "" {
		t.Fatal("the same error after recovery was suppressed as an old duplicate")
	}
}

func TestManagerClosingNoticeFailureDoesNotFloodGroup(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.reconcile(t, h.create(t, "notice-outage").ID, 1)
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error { reports = append(reports, r); return nil }
	h.manager.opts.BeforeClose = func(context.Context, Record) error { return errors.New("temporary notice outage") }
	if _, err := h.manager.Request(r.OwnerID, r.ID, "close"); err != nil {
		t.Fatal(err)
	}
	_ = h.manager.reconcile(context.Background(), r.ID)
	count := len(reports)
	_ = h.manager.reconcile(context.Background(), r.ID)
	_ = h.manager.reconcile(context.Background(), r.ID)
	if len(reports) != count || reports[len(reports)-1].SyncError == "" {
		t.Fatalf("closing retries flooded the group: %+v", reports)
	}
}

func TestManagerReportFailureDoesNotCheckpointUnsentNotice(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.create(t, "report-retry")
	h.manager.opts.Report = func(context.Context, Record) error { return errors.New("delivery unavailable") }
	h.manager.report(context.Background(), r.ID)
	r, _ = h.store.Get(r.ID)
	if r.ReportedNotice != "" || !r.ReportedAt.IsZero() {
		t.Fatal("failed delivery was checkpointed as sent")
	}
	h.manager.opts.Report = func(context.Context, Record) error { return nil }
	h.manager.report(context.Background(), r.ID)
	r, _ = h.store.Get(r.ID)
	if r.ReportedNotice != Notice(r) || r.ReportedAt.IsZero() {
		t.Fatal("successful retry was not checkpointed")
	}
}

func TestManagerReportsExistingNoticeOnceInNewDestination(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.create(t, "notice-route-migration")
	r, err := h.store.Update(r.ID, func(r *Record) error {
		r.Status, r.Error, r.ChatID = Attention, "initial prompt not confirmed", "task-group"
		r.ReportedNotice = Notice(*r)
		// Older versions recorded the text but sent it to the entry chat.
		r.ReportedChatID = ""
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var destinations []string
	h.manager.opts.Report = func(_ context.Context, r Record) error {
		destinations = append(destinations, NotificationChat(r))
		return nil
	}
	h.manager.report(context.Background(), r.ID)
	h.restart(t)
	h.manager.report(context.Background(), r.ID)
	if len(destinations) != 1 || destinations[0] != r.ChatID {
		t.Fatalf("legacy notice was lost or repeated after restart: %v", destinations)
	}
	if _, err := h.store.Update(r.ID, func(r *Record) error { r.ChatDeleted = true; return nil }); err != nil {
		t.Fatal(err)
	}
	h.manager.report(context.Background(), r.ID)
	h.manager.report(context.Background(), r.ID)
	if len(destinations) != 2 || destinations[1] != r.EntryChatID {
		t.Fatalf("same notice did not follow the surviving destination exactly once: %v", destinations)
	}
}
