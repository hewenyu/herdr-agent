package tasks

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestManagerReportsRunningOnceAfterQuietStartupAndDeduplicatesAfterRestart(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error {
		reports = append(reports, r)
		h.log.add("report:" + string(r.Status))
		return nil
	}
	h.lifecycle.workspaceCreated = func() {
		if len(reports) != 0 {
			t.Errorf("normal provisioning duplicated the group welcome: %+v", reports)
		}
	}
	r := h.reconcile(t, h.create(t, "early-progress").ID, 1)
	if len(reports) != 1 || reports[0].Status != Running || NotificationChat(reports[0]) != r.ChatID || r.ReportedAt.IsZero() || r.ReportedNotice != Notice(r) {
		t.Fatalf("initial running report not checkpointed: %+v / %+v", r, reports)
	}
	if strings.Contains(Notice(r), r.Title) {
		t.Fatal("progress repeated the full task requirements from the welcome")
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

func TestManagerStartupBlockerScreenChangesDoNotRepeatNoticeOrHideErrors(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	r := h.create(t, "stable-startup-blocker")
	var reports []string
	h.manager.opts.Report = func(_ context.Context, r Record) error {
		reports = append(reports, Notice(r))
		return nil
	}
	updateAndReport := func(fn func(*Record)) {
		t.Helper()
		if _, err := h.store.Update(r.ID, func(r *Record) error { fn(r); return nil }); err != nil {
			t.Fatal(err)
		}
		h.manager.report(context.Background(), r.ID)
	}
	updateAndReport(func(r *Record) {
		r.Status, r.ChatID = Blocked, "task-group"
		r.Detail = "Welcome to Codex\nDo you trust the contents of this directory?\n1. Yes, continue\n2. No, quit"
	})
	if len(reports) != 1 || strings.Contains(reports[0], "Welcome to Codex") || !strings.Contains(reports[0], "启动确认卡片") {
		t.Fatalf("startup blocker did not use a compact actionable notice: %v", reports)
	}
	updateAndReport(func(r *Record) { r.Detail = "等待你的输入或审批" })
	h.restart(t)
	updateAndReport(func(r *Record) { r.Detail = "Do you trust the contents of this directory?" })
	if len(reports) != 1 {
		t.Fatalf("screen and polling summaries repeated the same startup blocker: %v", reports)
	}
	updateAndReport(func(r *Record) { r.Error = "启动会话失去连接" })
	if len(reports) != 2 || !strings.Contains(reports[1], "启动会话失去连接") {
		t.Fatalf("stable startup notice hid an execution error: %v", reports)
	}
	updateAndReport(func(r *Record) { r.Error = ""; r.SyncError = "飞书任务同步失败" })
	if len(reports) != 3 || !strings.Contains(reports[2], "飞书任务同步失败") {
		t.Fatalf("stable startup notice hid a synchronization error: %v", reports)
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
	r := h.reconcile(t, h.create(t, "report-retry").ID, 1)
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
	h.restart(t)
	h.manager.report(context.Background(), r.ID)
	if len(destinations) != 1 {
		t.Fatalf("deleted group's notice escaped to the entry chat: %v", destinations)
	}
	after, _ := h.store.Get(r.ID)
	if after.ReportedChatID != r.ChatID {
		t.Fatalf("suppressed notice changed its delivery checkpoint: %+v", after)
	}
}

func TestManagerNormalProvisioningDoesNotReportOrCheckpointWithoutGroup(t *testing.T) {
	for _, status := range []Status{Queued, Starting} {
		t.Run(string(status), func(t *testing.T) {
			h := newTaskTestHarness(t, "codex")
			r := h.create(t, "quiet-provisioning")
			if _, err := h.store.Update(r.ID, func(r *Record) error { r.Status = status; return nil }); err != nil {
				t.Fatal(err)
			}
			h.manager.opts.Report = func(context.Context, Record) error {
				t.Fatal("normal provisioning sent a duplicate entry-chat progress message")
				return nil
			}
			h.manager.report(context.Background(), r.ID)
			h.restart(t)
			h.manager.report(context.Background(), r.ID)
			r, _ = h.store.Get(r.ID)
			if r.ReportedNotice != "" || r.ReportedChatID != "" || !r.ReportedAt.IsZero() {
				t.Fatalf("notification with no destination was checkpointed as sent: %+v", r)
			}
		})
	}
}

func TestManagerPreGroupFailureUsesEntryUntilRecoveryCreatesGroup(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error { reports = append(reports, r); return nil }
	h.platform.createErr = &herdrapi.APIError{Code: herdrapi.CodeInvalidParams, Message: "task creation rejected"}
	r := h.create(t, "create-failure-route")
	if err := h.manager.reconcile(context.Background(), r.ID); err == nil {
		t.Fatal("task creation failure was hidden")
	}
	if len(reports) != 1 || reports[0].Error == "" || NotificationChat(reports[0]) != r.EntryChatID {
		t.Fatalf("entry chat did not receive exactly the creation failure: %+v", reports)
	}
	h.restart(t)
	h.manager.report(context.Background(), r.ID)
	if len(reports) != 1 {
		t.Fatal("restart duplicated the entry-chat failure")
	}
	h.platform.createErr = nil
	if _, err := h.manager.Request(r.OwnerID, r.ID, "retry"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if len(reports) < 2 || r.ChatID == "" || r.Status != Running {
		t.Fatalf("retry did not reach a running task group: %+v", r)
	}
	for _, report := range reports[1:] {
		if NotificationChat(report) != r.ChatID {
			t.Fatalf("recovered lifecycle progress returned to the entry chat: %+v", report)
		}
	}
}

func TestManagerCompletedCleanupNeverReportsBackToEntryChat(t *testing.T) {
	h := newTaskTestHarness(t, "codex")
	var reports []Record
	h.manager.opts.Report = func(_ context.Context, r Record) error { reports = append(reports, r); return nil }
	r := h.reconcile(t, h.create(t, "close-group-only").ID, 1)
	if _, err := h.manager.Request(r.OwnerID, r.ID, "close"); err != nil {
		t.Fatal(err)
	}
	r = h.reconcile(t, r.ID, 1)
	if r.Status != Destroyed || !r.ChatDeleted {
		t.Fatalf("test never reached completed cleanup: %+v", r)
	}
	for _, report := range reports {
		if NotificationChat(report) != r.ChatID || report.Status == Destroyed {
			t.Fatalf("task lifecycle escaped the group or sent a post-deletion receipt: %+v", report)
		}
	}
	count := len(reports)
	h.restart(t)
	h.reconcile(t, r.ID, 1)
	if len(reports) != count {
		t.Fatal("restart sent cleanup results to the entry chat")
	}
}
