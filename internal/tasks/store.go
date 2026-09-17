package tasks

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/hewenyu/herdr-agent/internal/statefile"
)

type Status string

const (
	Queued     Status = "queued"
	Starting   Status = "starting"
	Running    Status = "running"
	Blocked    Status = "blocked"
	Review     Status = "review"
	Attention  Status = "attention"
	Completed  Status = "completed"
	Destroying Status = "destroying"
	Destroyed  Status = "destroyed"
)

func (s Status) Label() string {
	switch s {
	case Queued:
		return "排队中"
	case Starting:
		return "启动中"
	case Running:
		return "执行中"
	case Blocked:
		return "等待你处理"
	case Review:
		return "待验收 / 等待下一步"
	case Attention:
		return "需要处理"
	case Completed:
		return "已完成"
	case Destroying:
		return "正在销毁会话"
	case Destroyed:
		return "会话已销毁"
	default:
		return "状态未知"
	}
}

type Record struct {
	ID                string    `json:"id"`
	OwnerID           string    `json:"owner_id"`
	EntryChatID       string    `json:"entry_chat_id"`
	Project           string    `json:"project"`
	Path              string    `json:"path"`
	Directories       []string  `json:"directories,omitempty"`
	Bypass            bool      `json:"bypass,omitempty"`
	Agent             string    `json:"agent"`
	Title             string    `json:"title"`
	GUID              string    `json:"task_guid,omitempty"`
	URL               string    `json:"task_url,omitempty"`
	ChatID            string    `json:"chat_id,omitempty"`
	WorkspaceID       string    `json:"workspace_id,omitempty"`
	WorkspaceCwd      string    `json:"workspace_cwd,omitempty"`
	AgentCwd          string    `json:"agent_cwd,omitempty"`
	PaneID            string    `json:"pane_id,omitempty"`
	SessionID         string    `json:"session_id,omitempty"`
	Started           bool      `json:"started"`
	PromptSent        bool      `json:"prompt_sent"`
	PromptReceipt     string    `json:"prompt_receipt,omitempty"`
	Pending           string    `json:"pending,omitempty"`
	Status            Status    `json:"status"`
	Detail            string    `json:"detail,omitempty"`
	Result            string    `json:"result,omitempty"`
	Error             string    `json:"error,omitempty"`
	SyncError         string    `json:"sync_error,omitempty"`
	CompletionRequest string    `json:"completion_request,omitempty"`
	CloseRequested    bool      `json:"close_requested,omitempty"`
	CloseNotifiedAt   time.Time `json:"close_notified_at,omitempty"`
	CompletedAt       string    `json:"completed_at,omitempty"`
	PaneClosed        bool      `json:"pane_closed,omitempty"`
	ChatDeleted       bool      `json:"chat_deleted,omitempty"`
	Announced         bool      `json:"announced,omitempty"`
	UpdatedAt         time.Time `json:"updated_at"`
	CreatedAt         time.Time `json:"created_at"`
	RemoteCheckedAt   time.Time `json:"remote_checked_at"`
	ReportedNotice    string    `json:"reported_notice,omitempty"`
	ReportedChatID    string    `json:"reported_chat_id,omitempty"`
	ReportedAt        time.Time `json:"reported_at,omitempty"`
	SyncedDescription string    `json:"synced_description,omitempty"`
}

// Store fails closed on corruption. Losing these bindings could orphan running
// processes or let a replay create a second task, so an empty fallback is unsafe.
type Store struct {
	mu      sync.RWMutex
	path    string
	records map[string]Record
}

func Open(path string) (*Store, error) {
	s := &Store{path: path, records: map[string]Record{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var disk struct {
		Version int               `json:"version"`
		Records map[string]Record `json:"records"`
	}
	if err = json.Unmarshal(data, &disk); err != nil {
		return nil, fmt.Errorf("tasks: corrupt state: %w", err)
	}
	if disk.Version != 1 || disk.Records == nil {
		return nil, errors.New("tasks: unsupported or incomplete state")
	}
	for id, r := range disk.Records {
		if id != r.ID || id == "" || r.OwnerID == "" {
			return nil, errors.New("tasks: invalid persisted binding")
		}
	}
	s.records = disk.Records
	return s, nil
}
func (s *Store) Get(id string) (Record, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.records[id]
	return cloneRecord(r), ok
}
func (s *Store) List() []Record {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Record, 0, len(s.records))
	for _, r := range s.records {
		out = append(out, cloneRecord(r))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}
func (s *Store) Update(id string, fn func(*Record) error) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := cloneRecord(s.records[id])
	original, existed := s.records[id]
	if err := fn(&r); err != nil {
		return r, err
	}
	if r.ID != id || r.OwnerID == "" {
		return r, errors.New("tasks: invalid record")
	}
	if existed && reflect.DeepEqual(r, original) {
		return r, nil
	}
	next := make(map[string]Record, len(s.records)+1)
	for k, v := range s.records {
		next[k] = v
	}
	next[id] = cloneRecord(r)
	data, err := json.MarshalIndent(struct {
		Version int               `json:"version"`
		Records map[string]Record `json:"records"`
	}{1, next}, "", "  ")
	if err != nil {
		return r, err
	}
	dir := filepath.Dir(s.path)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return r, err
	}
	committed, err := statefile.Write(s.path, data, 0600)
	if committed {
		// Rename committed the intent even if directory fsync then failed.
		s.records = next
	}
	return r, err
}

func cloneRecord(r Record) Record {
	r.Directories = slices.Clone(r.Directories)
	return r
}
