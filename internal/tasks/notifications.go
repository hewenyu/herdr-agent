package tasks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

type NotificationKind string

const (
	NotificationProgress   NotificationKind = "progress"
	NotificationWelcome    NotificationKind = "welcome"
	NotificationGroupReady NotificationKind = "group_ready"
	NotificationClosing    NotificationKind = "before_close"
)

// NotificationEvent is trusted lifecycle data, never an instruction to run a
// task. The stable ID is independent of the model's choice of words.
type NotificationEvent struct {
	ID       string           `json:"id"`
	Kind     NotificationKind `json:"kind"`
	OwnerID  string           `json:"owner_id"`
	ChatID   string           `json:"chat_id"`
	TaskURL  string           `json:"task_url,omitempty"`
	GroupURL string           `json:"group_url,omitempty"`
	Task     Record           `json:"task"`
}

func NewNotificationEvent(r Record, kind NotificationKind, chat string) NotificationEvent {
	version := ""
	switch kind {
	case NotificationProgress:
		version = fmt.Sprintf("%d:%s", r.ReportedSequence+1, NotificationStateKey(r))
	case NotificationClosing:
		version = fmt.Sprint(r.CloseVersion)
	}
	groupURL := ""
	if r.ChatID != "" && !r.ChatDeleted {
		groupURL = ChatURL(r.ChatID)
	}
	return NotificationEvent{ID: notificationDigest(r.ID + "\x00" + string(kind) + "\x00" + chat + "\x00" + version), Kind: kind, OwnerID: r.OwnerID, ChatID: chat, TaskURL: r.URL, GroupURL: groupURL, Task: r}
}

func notificationDigest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// NotificationStateKey normalizes observer noise but preserves operational
// changes. Frequency control and replay protection never compare generated text.
func NotificationStateKey(r Record) string {
	if r.ID == "" || ((r.Status == Queued || r.Status == Starting) && r.Error == "" && r.SyncError == "") {
		return ""
	}
	detail := r.Detail
	if r.Status == Review || r.Status == Completed || (r.Status == Blocked && !r.PromptSent) || r.Error != "" || r.SyncError != "" {
		detail = ""
	}
	data, _ := json.Marshal(struct {
		Status                     Status
		Detail, Error, SyncError   string
		ReviewVersion              uint64
		CloseRequested, PromptSent bool
	}{r.Status, detail, r.Error, r.SyncError, r.ReviewVersion, r.CloseRequested, r.PromptSent})
	return notificationDigest(string(data))
}

func notificationAlreadyReported(r Record) bool {
	key := NotificationStateKey(r)
	if r.ReportedStateKey != "" {
		return r.ReportedStateKey == key && r.ReportedChatID == NotificationChat(r)
	}
	return r.ReportedNotice != "" && r.ReportedNotice == Notice(r) && r.ReportedChatID == NotificationChat(r) && (r.Status != Review || r.ReviewVersion == r.ReportedReviewVersion)
}

func migrateNotificationState(r *Record) bool {
	changed := false
	legacyReview := r.Status == Review && r.ReviewVersion == 0
	if legacyReview {
		r.ReviewVersion = 1
		changed = true
	}
	if r.ReportedStateKey == "" && r.ReportedChatID == NotificationChat(*r) && r.ReportedNotice != "" {
		matched := r.ReportedNotice == Notice(*r)
		// Old versions alternated two detail strings for the same review.
		// A persisted review notice still proves that round was reported.
		if legacyReview && r.Error == "" && r.SyncError == "" && strings.HasPrefix(r.ReportedNotice, noticePrefix(Review)) {
			matched = true
		}
		if matched {
			r.ReportedStateKey = NotificationStateKey(*r)
			r.ReportedStatus = r.Status
			if r.Error != "" || r.SyncError != "" {
				r.ReportedStatus = ""
			}
			r.ReportedReviewVersion = r.ReviewVersion
			changed = true
		}
	}
	return changed
}

// MarkResultDelivered is a transport receipt, not a lifecycle transition. A
// delayed confirmation must not mark another execution's result as delivered.
func (m *Manager) MarkResultDelivered(pane, result string) error {
	r, ok := m.ByPane(pane)
	if !ok || result == "" {
		return nil
	}
	_, err := m.store.Update(r.ID, func(r *Record) error {
		if r.Status == Review && r.Result == clip(result, 6000) && !r.ResultDelivered {
			r.ResultDelivered, r.ResultDeliveredAt = true, time.Now()
		}
		return nil
	})
	return err
}

func (m *Manager) notifyLifecycle(ctx context.Context, id string) {
	r, ok := m.store.Get(id)
	if !ok || !m.OwnerAllowed(r.OwnerID) {
		return
	}
	if !r.Announced && r.ChatID != "" && !r.ChatDeleted && r.Status != Destroying && r.Status != Destroyed && m.opts.Announce != nil {
		if err := m.opts.Announce(ctx, r); err != nil {
			slog.Warn("tasks: group announcement failed; execution continues", "task", id, "err", err)
		} else if _, err := m.change(id, func(current *Record) {
			if current.ChatID == r.ChatID && !current.ChatDeleted {
				current.Announced = true
			}
		}); err != nil {
			slog.Warn("tasks: announcement checkpoint failed", "task", id, "err", err)
		}
	}
	m.report(ctx, id)
}
