package tasks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

type Options struct {
	// AllowedOwner rechecks persisted owners against the current installation allowlist.
	AllowedOwner func(string) bool
	Report       func(context.Context, Record) error
	Config       config.Tasks
	// Projects supplies the current local configuration for each new task.
	Projects interface{ Snapshot() config.Tasks }
	// PrepareProject initializes/checks the configured primary repository before
	// creating a workspace. It must be safe to retry after a local failure.
	PrepareProject func(context.Context, string) error
	Platform       Platform
	Client         herdrapi.Client
	Lifecycle      herdrapi.LifecycleClient
	Controller     agents.Controller
	Registry       agents.Registry
	// Announce links the entry chat to the newly provisioned task group.
	Announce func(context.Context, Record) error
	// BeforeClose sends the final result and closing notice before deleting a
	// task group. A failed notice leaves the group and agent available for retry.
	BeforeClose func(context.Context, Record) error
	// Follow enables transcript mirroring for the owned pane.
	Follow func(string) error
}
type Manager struct {
	store *Store
	opts  Options
	wake  chan struct{}
	mu    sync.Mutex
	busy  map[string]bool
}

func New(store *Store, o Options) (*Manager, error) {
	if store == nil || o.Platform == nil || o.Client == nil || o.Lifecycle == nil || o.Controller == nil || o.Registry == nil {
		return nil, errors.New("tasks: missing dependency")
	}
	if o.Config.PollInterval <= 0 {
		o.Config.PollInterval = 30 * time.Second
	}
	return &Manager{store: store, opts: o, wake: make(chan struct{}, 1), busy: map[string]bool{}}, nil
}
func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}
func (m *Manager) List(owner string, all bool) []Record {
	var out []Record
	for _, r := range m.store.List() {
		if r.OwnerID == owner && (all || ((r.Status != Completed || (r.CloseRequested && !r.ChatDeleted)) && (r.Status != Destroyed || r.Pending != ""))) {
			out = append(out, r)
		}
	}
	return out
}
func (m *Manager) ByChat(chat string) (Record, bool) {
	for _, r := range m.store.List() {
		if r.ChatID == chat && chat != "" {
			return r, true
		}
	}
	return Record{}, false
}
func (m *Manager) ByPane(pane string) (Record, bool) {
	for _, r := range m.store.List() {
		if r.PaneID == pane && pane != "" {
			return r, true
		}
	}
	return Record{}, false
}
func (m *Manager) Get(id string) (Record, bool) { return m.store.Get(id) }
func (m *Manager) projectConfig() config.Tasks {
	if m.opts.Projects != nil {
		return m.opts.Projects.Snapshot()
	}
	return m.opts.Config
}
func (m *Manager) Projects() string {
	cfg := m.projectConfig()
	names := make([]string, 0, len(cfg.Projects))
	for name := range cfg.Projects {
		names = append(names, name)
	}
	// Stable display order matters when several repositories have similar names.
	sortStrings(names)
	var lines []string
	for _, name := range names {
		p := cfg.Projects[name]
		mark := ""
		if name == cfg.DefaultProject {
			mark = "（默认）"
		}
		dirs := p.Directories
		if len(dirs) == 0 {
			dirs = []string{p.Path}
		}
		lines = append(lines, fmt.Sprintf("%s%s · %s · %s", name, mark, p.Agent, strings.Join(dirs, "、")))
	}
	if len(lines) == 0 {
		return "尚未配置项目；请在本地配置页面关联目录，或明确要求新建项目。"
	}
	return strings.Join(lines, "\n")
}
func (m *Manager) Create(owner, entry, messageID, project, kind, title string) (Record, error) {
	if messageID == "" {
		return Record{}, errors.New("任务创建缺少消息 ID，无法保证不会重复创建")
	}
	sum := sha256.Sum256([]byte(owner + "\x00" + messageID))
	id := "t_" + hex.EncodeToString(sum[:12])
	if existing, ok := m.store.Get(id); ok {
		return existing, nil
	}
	cfg := m.projectConfig()
	if project == "" {
		project = cfg.DefaultProject
	}
	p, ok := cfg.Projects[project]
	if !ok {
		return Record{}, fmt.Errorf("项目 %q 未配置；请查看项目列表或在本地配置页面关联目录。只有明确新建项目时才会创建目录", project)
	}
	if m.opts.Projects != nil {
		var err error
		p, err = config.NormalizeProject(p)
		if err != nil {
			return Record{}, fmt.Errorf("项目目录不可用，请在本地配置页面修正：%w", err)
		}
	}
	if kind == "" {
		kind = p.Agent
	}
	if kind != "codex" && kind != "claude" {
		return Record{}, errors.New("agent 只支持 codex 或 claude")
	}
	title = strings.TrimSpace(title)
	if title == "" || len([]rune(title)) > 3000 {
		return Record{}, errors.New("任务内容必须为 1–3000 个字符")
	}
	dirs := append([]string(nil), p.Directories...)
	if len(dirs) == 0 {
		dirs = []string{p.Path}
	}
	if len(dirs) > 1 || cfg.Bypass {
		if _, ok := m.opts.Lifecycle.(herdrapi.ConfiguredLifecycleClient); !ok {
			return Record{}, errors.New("当前 herdr 客户端不支持项目目录或 Bypass 启动参数，请升级")
		}
	}
	r, err := m.store.Update(id, func(r *Record) error {
		if r.ID != "" {
			return nil
		}
		now := time.Now()
		*r = Record{ID: id, OwnerID: owner, EntryChatID: entry, Project: project, Path: dirs[0], Directories: append([]string(nil), dirs...), Bypass: cfg.Bypass, Agent: kind, Title: title, Status: Queued, CreatedAt: now, UpdatedAt: now}
		return nil
	})
	if err == nil {
		m.Wake()
	}
	return r, err
}
func (m *Manager) Request(owner, id, action string) (Record, error) {
	r, err := m.store.Update(id, func(r *Record) error {
		if r.ID == "" || r.OwnerID != owner {
			return errors.New("找不到你拥有的任务")
		}
		if r.Status == Destroyed {
			return errors.New("会话已销毁，不能继续操作；可以新建任务")
		}
		if r.Status == Destroying && action != "destroy" {
			return errors.New("会话正在销毁")
		}
		if (action == "complete" || action == "close" || action == "reopen") && r.GUID == "" {
			return errors.New("飞书任务尚在创建，请稍后再完成或重开")
		}
		switch action {
		case "complete":
			r.CompletionRequest = "complete"
		case "close":
			if !r.CloseRequested {
				r.CloseRequested = true
				r.CloseNotifiedAt = time.Time{}
				r.CompletionRequest = "complete"
			}
		case "reopen":
			r.CompletionRequest = "reopen"
			r.CloseRequested = false
			r.CloseNotifiedAt = time.Time{}
		case "destroy":
			r.Status = Destroying
			r.Detail = "关闭任务窗口并解散临时群；保留代码、任务和结果"
		case "retry":
			if r.CloseRequested {
				return errors.New("任务正在结单，系统会重试同步；如需继续开发，请先重开任务")
			}
			if r.Pending != "" {
				return fmt.Errorf("%s 操作结果未确认，为避免重复创建或重复执行，不能自动重试；请检查资源后销毁已绑定会话或重新发出指令", r.Pending)
			}
			r.Error = ""
			r.ReportedNotice = ""
			r.Status = Starting
		default:
			return errors.New("未知任务操作")
		}
		r.UpdatedAt = time.Now()
		return nil
	})
	if err == nil {
		m.Wake()
	}
	return r, err
}
func (m *Manager) Observe(pane string, status Status, detail, result string) error {
	r, ok := m.ByPane(pane)
	if !ok {
		return nil
	}
	changed := false
	_, err := m.store.Update(r.ID, func(r *Record) error {
		if r.Status == Completed || r.Status == Destroying || r.Status == Destroyed || r.CloseRequested {
			return nil
		}
		if !r.PromptSent && status == Review {
			return nil
		}
		if r.Status != status || (detail != "" && r.Detail != detail) || (result != "" && r.Result != result) {
			changed = true
			r.Status = status
			if detail != "" {
				r.Detail = clip(detail, 2000)
			}
			if result != "" {
				r.Result = clip(result, 6000)
			}
			r.UpdatedAt = time.Now()
		}
		return nil
	})
	if changed && err == nil {
		m.Wake()
	}
	return err
}
func (m *Manager) Event(ctx context.Context, e TaskEvent) error {
	for _, r := range m.store.List() {
		if r.GUID == e.GUID {
			_, err := m.store.Update(r.ID, func(r *Record) error { r.RemoteCheckedAt = time.Time{}; return nil })
			m.Wake()
			return err
		}
	}
	return nil
}
func (m *Manager) Run(ctx context.Context) error {
	// Subscription failure does not disable the panel: reconciliation still reads
	// the tasks this application created. This uses the existing bot connection.
	subscribeCtx, cancelSubscribe := context.WithTimeout(ctx, 10*time.Second)
	err := m.opts.Platform.SubscribeTasks(subscribeCtx)
	cancelSubscribe()
	if err != nil {
		slog.Warn("tasks: event subscription unavailable; polling remains active", "err", err)
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	var wg sync.WaitGroup
	slots := make(chan struct{}, 4)
	defer wg.Wait()
	for {
		for _, r := range m.store.List() {
			if !m.OwnerAllowed(r.OwnerID) {
				continue
			}
			if r.Status == Destroyed && (r.GUID == "" || r.SyncedDescription == Description(r)) && (m.opts.Report == nil || r.ReportedNotice == Notice(r)) {
				continue
			}
			m.mu.Lock()
			busy := m.busy[r.ID]
			if !busy {
				m.busy[r.ID] = true
			}
			m.mu.Unlock()
			if busy {
				continue
			}
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				defer func() { m.mu.Lock(); delete(m.busy, id); m.mu.Unlock() }()
				select {
				case slots <- struct{}{}:
					defer func() { <-slots }()
				case <-ctx.Done():
					return
				}
				opCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
				defer cancel()
				if err := m.reconcile(opCtx, id); err != nil {
					slog.Warn("tasks: reconcile failed", "task", id, "err", err)
				}
			}(r.ID)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		case <-m.wake:
		}
	}
}
func (m *Manager) change(id string, fn func(*Record)) (Record, error) {
	return m.store.Update(id, func(r *Record) error {
		closing := r.Status == Destroying
		fn(r)
		if closing && r.Status != Destroyed {
			r.Status = Destroying
		}
		return nil
	})
}

const runningReportInterval = 30 * time.Second
const closeNoticeGrace = 5 * time.Second

func (m *Manager) report(ctx context.Context, id string) {
	if m.opts.Report == nil {
		return
	}
	r, ok := m.store.Get(id)
	if !ok {
		return
	}
	notice := Notice(r)
	chat := NotificationChat(r)
	if notice == "" || (notice == r.ReportedNotice && chat == r.ReportedChatID) {
		return
	}
	// Only incremental running progress is throttled. State changes, blockers,
	// acceptance, reopened tasks and errors must always reach the owner promptly.
	if chat == r.ReportedChatID && r.Status == Running && r.Error == "" && r.SyncError == "" &&
		strings.HasPrefix(r.ReportedNotice, noticePrefix(Running)) && time.Since(r.ReportedAt) < runningReportInterval {
		return
	}
	if err := m.opts.Report(ctx, r); err != nil {
		slog.Warn("tasks: report failed", "task", id, "err", err)
		return
	}
	if _, err := m.change(id, func(r *Record) { r.ReportedNotice = notice; r.ReportedChatID = chat; r.ReportedAt = time.Now() }); err != nil {
		slog.Warn("tasks: report checkpoint failed", "task", id, "err", err)
	}
}

func (m *Manager) reconcile(ctx context.Context, id string) error {
	// Publishing before provisioning and on every exit makes startup and failure
	// visible even when the next external operation takes a long time.
	m.report(ctx, id)
	defer m.report(ctx, id)
	r, _ := m.store.Get(id)
	if r.Status == Destroying {
		if err := m.destroy(ctx, r); err != nil {
			return m.syncFailure(id, err)
		}
		return nil
	}
	if r.GUID != "" {
		if err := m.syncRemote(ctx, r); err != nil {
			return err
		}
		r, _ = m.store.Get(id)
		if !r.CloseRequested || r.Status != Completed {
			m.report(ctx, id)
		}
	}
	if r.CloseRequested && r.Status == Completed && r.CompletionRequest == "" {
		return m.closeAccepted(ctx, r)
	}
	if r.Status == Completed || r.Status == Destroyed || r.Status == Destroying {
		return nil
	}
	// agent.get cannot prove launch argv. A lost start response for configured
	// directories or bypass must remain unresolved rather than silently dropping
	// the requested launch behavior during recovery.
	if r.Pending == "agent" && r.PaneID != "" && len(r.Directories) <= 1 && !r.Bypass {
		a, getErr := m.opts.Client.AgentGet(ctx, r.PaneID)
		if getErr == nil && a.Agent != nil && *a.Agent == r.Agent && a.WorkspaceID == r.WorkspaceID && a.Name != nil && *a.Name == r.ID {
			_, err := m.change(id, func(r *Record) {
				r.Started = true
				r.Pending = ""
				r.Error = ""
				r.Status = Starting
				r.UpdatedAt = time.Now()
			})
			if err != nil {
				return err
			}
		}
		r, _ = m.store.Get(id)
	}
	if r.Pending != "" && r.Error == "" {
		// A persisted intent without a result is ambiguous after process death.
		// Never replay a create or prompt merely because its response was lost.
		_, err := m.change(id, func(r *Record) {
			r.Status = Attention
			r.Error = "上一次 " + r.Pending + " 操作结果未确认；请检查资源，系统不会自动重复执行"
			r.UpdatedAt = time.Now()
		})
		return err
	}
	if r.Error != "" {
		return nil
	}
	if r.GUID == "" {
		if err := m.step(ctx, id, "task", func(r Record) (func(*Record), error) {
			task, err := m.opts.Platform.CreateTask(ctx, TaskSpec{Title: r.Title, Description: Description(r), OwnerID: r.OwnerID, Key: r.ID})
			return func(r *Record) { r.GUID = task.GUID; r.URL = task.URL }, err
		}); err != nil {
			return err
		}
		r, _ = m.store.Get(id)
	}
	if r.ChatID == "" {
		if err := m.step(ctx, id, "chat", func(r Record) (func(*Record), error) {
			chat, err := m.opts.Platform.CreateTaskChat(ctx, ChatSpec{Name: clip("任务 · "+r.Project+" · "+r.Title, 55), OwnerID: r.OwnerID, Key: r.ID})
			return func(r *Record) { r.ChatID = chat }, err
		}); err != nil {
			return err
		}
		r, _ = m.store.Get(id)
	}
	if !r.Announced && m.opts.Announce != nil {
		if err := m.opts.Announce(ctx, r); err != nil {
			return err
		}
		if _, err := m.change(id, func(r *Record) { r.Announced = true }); err != nil {
			return err
		}
	}
	if r.PaneID == "" {
		if err := m.step(ctx, id, "workspace", func(r Record) (func(*Record), error) {
			if m.opts.PrepareProject != nil {
				if err := m.opts.PrepareProject(ctx, r.Path); err != nil {
					return nil, preparationFailure{fmt.Errorf("准备项目目录：%w", err)}
				}
			}
			w, err := m.opts.Lifecycle.WorkspaceCreate(ctx, r.Path, r.ID)
			return func(r *Record) { r.WorkspaceID = w.ID; r.PaneID = w.PaneID; r.WorkspaceCwd = w.Cwd }, err
		}); err != nil {
			return err
		}
		r, _ = m.store.Get(id)
	}
	if !r.Started && r.WorkspaceCwd != "" {
		if err := verifyWorkspaceDirectory(r.Path, r.WorkspaceCwd); err != nil {
			return m.fail(id, err.Error(), false)
		}
	}
	if m.opts.Follow != nil {
		if err := m.opts.Follow(r.PaneID); err != nil {
			slog.Warn("tasks: cannot enable mirror", "task", id, "err", err)
		}
	}
	if !r.Started {
		if err := m.step(ctx, id, "agent", func(r Record) (func(*Record), error) {
			var a herdrapi.AgentInfo
			var err error
			if configured, ok := m.opts.Lifecycle.(herdrapi.ConfiguredLifecycleClient); ok {
				var extra []string
				if len(r.Directories) > 1 {
					extra = r.Directories[1:]
				}
				a, err = configured.AgentStartWithOptions(ctx, r.PaneID, r.Agent, r.ID, herdrapi.AgentStartOptions{Directories: extra, Bypass: r.Bypass})
			} else if len(r.Directories) > 1 || r.Bypass {
				err = errors.New("当前 herdr 客户端无法传递任务保存的目录和 Bypass 参数")
			} else {
				a, err = m.opts.Lifecycle.AgentStart(ctx, r.PaneID, r.Agent, r.ID)
			}
			return func(r *Record) {
				r.Started = true
				if a.AgentSession != nil {
					r.SessionID = a.AgentSession.Value
				}
				if a.AgentStatus == "blocked" {
					r.Status = Blocked
					r.Detail = "请先在任务群处理 agent 的启动确认，随后自动发送任务"
				}
			}, err
		}); err != nil {
			return err
		}
		r, _ = m.store.Get(id)
	}
	a, err := m.opts.Client.AgentGet(ctx, r.PaneID)
	if err != nil {
		return m.fail(id, "读取 agent: "+err.Error(), false)
	}
	if a.Agent == nil || *a.Agent != r.Agent || a.WorkspaceID != r.WorkspaceID {
		return m.fail(id, "任务窗口中的 agent 或工作区已改变，已停止自动输入", false)
	}
	if a.AgentSession != nil && a.AgentSession.Value != r.SessionID {
		if _, err = m.change(id, func(r *Record) { r.SessionID = a.AgentSession.Value }); err != nil {
			return err
		}
	}
	if !r.PromptSent {
		if a.AgentStatus == "blocked" {
			return m.Observe(r.PaneID, Blocked, "等待 agent 启动确认；任务内容尚未发送", "")
		}
		if !a.InteractiveReady || a.LaunchPending || (a.AgentStatus != "idle" && a.AgentStatus != "done") {
			return nil
		}
		// The shell may have changed directory since workspace creation (for
		// example, in its startup script or while awaiting a trust decision).
		// Validate the running agent immediately before the first task input.
		if actual := initialAgentDirectory(a); actual != "" {
			if actual != r.AgentCwd {
				if _, err := m.change(id, func(r *Record) { r.AgentCwd = actual }); err != nil {
					return err
				}
			}
			if err := verifyWorkspaceDirectory(r.Path, actual); err != nil {
				return m.fail(id, err.Error(), false)
			}
		}
		if r.PromptReceipt == "" {
			marker, markerErr := newReceiptMarker()
			if markerErr != nil {
				return m.fail(id, "无法生成任务投递标识", false)
			}
			if _, err := m.change(id, func(r *Record) { r.PromptReceipt = marker }); err != nil {
				return err
			}
		}
		err = m.step(ctx, id, "prompt", func(r Record) (func(*Record), error) {
			d, err := m.opts.Controller.Say(ctx, agents.Guard{PaneID: r.PaneID, Kind: r.Agent, StateSeq: a.StateChangeSeq, IssuedAt: time.Now(), RequireUnblocked: true, ReceiptMarker: r.PromptReceipt}, promptWithReceipt(r))
			if initialPromptDeferred(d, err) {
				return func(r *Record) {
					r.Status = Blocked
					r.Detail = "等待 agent 启动确认或输入就绪；任务内容尚未发送，处理后将自动继续"
					r.Error = ""
				}, nil
			}
			if err == nil && (!d.Acked || !d.Verified) {
				err = errors.New("初始任务已尝试发送，但尚未确认；请检查会话，不会自动重复发送")
			}
			return func(r *Record) {
				r.PromptSent = true
				r.Status = Running
				r.Detail = "任务已发送，agent 正在处理"
			}, err
		})
		return err
	}
	switch a.AgentStatus {
	case "working":
		return m.Observe(r.PaneID, Running, value(a.TerminalTitleStripped, "agent 正在执行任务"), "")
	case "blocked":
		if r.Status == Blocked {
			return nil
		}
		return m.Observe(r.PaneID, Blocked, "等待你的输入或审批", "")
	case "idle", "done":
		return m.Observe(r.PaneID, Review, "本轮已结束；请查看回复并验收或补充要求", "")
	default:
		return m.Observe(r.PaneID, Attention, "无法识别 agent 状态", "")
	}
}
func (m *Manager) step(ctx context.Context, id, step string, fn func(Record) (func(*Record), error)) error {
	r, err := m.store.Update(id, func(r *Record) error {
		if r.Status == Destroying || r.Status == Destroyed || r.Status == Completed || r.CompletionRequest != "" || r.CloseRequested {
			return errors.New("task lifecycle changed; provisioning paused")
		}
		r.Pending = step
		// A held prompt can be refused repeatedly by the screen preflight while
		// agent.get still says idle. Keep its waiting state stable until delivery.
		waitingPrompt := step == "prompt" && r.Status == Blocked
		if !waitingPrompt {
			r.Status = Starting
		}
		switch step {
		case "task":
			r.Detail = "正在创建飞书任务"
		case "chat":
			r.Detail = "正在创建任务群，后续沟通与验收都在群内进行"
		case "workspace":
			r.Detail = "正在准备项目执行会话"
		case "agent":
			r.Detail = "正在启动 " + r.Agent
		case "prompt":
			if !waitingPrompt {
				r.Detail = "正在发送任务要求"
			}
		}
		r.UpdatedAt = time.Now()
		return nil
	})
	if err != nil {
		return err
	}
	m.report(ctx, id)
	// A lifecycle request can arrive while the progress notification is in
	// flight. No external side effect has started yet, so abandon its intent.
	current, _ := m.store.Get(id)
	if current.Status == Destroying || current.Status == Destroyed || current.Status == Completed || current.CompletionRequest != "" || current.CloseRequested {
		_, err := m.change(id, func(r *Record) {
			if r.Pending == step {
				r.Pending = ""
			}
		})
		return errors.Join(errors.New("task lifecycle changed; provisioning paused"), err)
	}
	apply, callErr := fn(r)
	if callErr != nil {
		ambiguous := true
		var rejected interface{ DefinitiveFailure() bool }
		if errors.As(callErr, &rejected) && rejected.DefinitiveFailure() {
			ambiguous = false
		}
		var apiErr *herdrapi.APIError
		if errors.As(callErr, &apiErr) {
			if step == "agent" && apiErr.Code == herdrapi.CodeAgentPaneBusy {
				// herdr rejects busy shells before writing the launch command.
				// The task can retry its own pane once it becomes available.
				ambiguous = false
			}
			switch apiErr.Code {
			case herdrapi.CodeInvalidParams, herdrapi.CodeInvalidRequest, herdrapi.CodeFeatureDisabled:
				ambiguous = false
			}
		}
		return m.fail(id, step+": "+callErr.Error(), ambiguous)
	}
	_, err = m.change(id, func(r *Record) { apply(r); r.Pending = ""; r.UpdatedAt = time.Now() })
	if err == nil {
		m.report(ctx, id)
	}
	return err
}
func (m *Manager) fail(id, msg string, ambiguous bool) error {
	_, err := m.change(id, func(r *Record) {
		r.Status = Attention
		r.Error = clip(msg, 2000)
		if !ambiguous {
			r.Pending = ""
		}
		r.UpdatedAt = time.Now()
	})
	if err != nil {
		return err
	}
	return errors.New(msg)
}
func (m *Manager) syncRemote(ctx context.Context, r Record) error {
	// Recheck pending closure on every pass so reopening in the task panel can
	// cancel the grace period even when its change event has not arrived.
	if time.Since(r.RemoteCheckedAt) < m.opts.Config.PollInterval && r.CompletionRequest == "" && !r.CloseRequested && r.SyncedDescription == Description(r) {
		return nil
	}
	remote, err := m.opts.Platform.GetTask(ctx, r.GUID)
	if err != nil {
		return m.syncFailure(r.ID, err)
	}
	desired := r.CompletionRequest
	r, err = m.change(r.ID, func(r *Record) {
		r.RemoteCheckedAt = time.Now()
		if desired == "" && r.CompletionRequest == "" {
			completed := remote.CompletedAt != "" && remote.CompletedAt != "0"
			if completed && r.Status != Destroyed && r.Status != Destroying && (r.Status != Completed || r.CompletedAt != remote.CompletedAt) {
				// A new panel completion is acceptance and closure. An unchanged
				// completion already recorded by /task complete keeps its session.
				if !r.CloseRequested {
					r.CloseRequested = true
					r.CloseNotifiedAt = time.Time{}
				}
				r.Status = Completed
				r.CompletedAt = remote.CompletedAt
				r.Detail = "已在飞书任务中完成验收，正在保存结果并关闭执行会话和临时群"
				r.UpdatedAt = time.Now()
			}
			if !completed && r.Status == Completed {
				r.Status = Review
				r.CompletedAt = ""
				r.CloseRequested = false
				r.CloseNotifiedAt = time.Time{}
				r.Detail = "任务已重新打开，可以继续对话"
				r.UpdatedAt = time.Now()
			}
		}
	})
	if err != nil {
		return err
	}
	var completedAt *string
	if desired != "" {
		ts := "0"
		if desired == "complete" {
			ts = fmt.Sprint(time.Now().UnixMilli())
			if remote.CompletedAt != "" && remote.CompletedAt != "0" {
				ts = remote.CompletedAt
			}
		}
		if ts != remote.CompletedAt && !(ts == "0" && remote.CompletedAt == "") {
			completedAt = &ts
		}
		r.CompletedAt = ts
		if desired == "complete" {
			r.Status = Completed
			r.Detail = "用户已确认任务完成"
		} else {
			r.Status = Review
			r.Detail = "任务已重新打开，可以继续对话"
		}
		r.UpdatedAt = time.Now()
	}
	candidate := r
	desc := Description(r)
	if desc != r.SyncedDescription || completedAt != nil {
		if err = m.opts.Platform.UpdateTask(ctx, r.GUID, desc, completedAt); err != nil {
			return m.syncFailure(r.ID, err)
		}
	}
	_, err = m.change(r.ID, func(r *Record) {
		r.SyncedDescription = desc
		r.SyncError = ""
		if r.CompletionRequest == desired {
			if desired != "" {
				r.Status = candidate.Status
				r.Detail = candidate.Detail
				r.CompletedAt = candidate.CompletedAt
				r.UpdatedAt = candidate.UpdatedAt
			}
			r.CompletionRequest = ""
		}
	})
	return err
}
func (m *Manager) syncFailure(id string, err error) error {
	_, saveErr := m.change(id, func(r *Record) { r.SyncError = clip(err.Error(), 1000) })
	return errors.Join(err, saveErr)
}

// closeAccepted never erases a live session based solely on an intent to mark
// the task complete. Confirm Feishu's accepted state and durable result first.
func (m *Manager) closeAccepted(ctx context.Context, r Record) error {
	remote, err := m.opts.Platform.GetTask(ctx, r.GUID)
	if err != nil {
		return m.syncFailure(r.ID, err)
	}
	if remote.CompletedAt == "" || remote.CompletedAt == "0" {
		return m.syncFailure(r.ID, errors.New("飞书尚未确认任务完成，已保留执行会话和任务群"))
	}
	desc := Description(r)
	if remote.Description != desc {
		if err := m.opts.Platform.UpdateTask(ctx, r.GUID, desc, nil); err != nil {
			return m.syncFailure(r.ID, err)
		}
	}
	r, err = m.change(r.ID, func(current *Record) {
		current.SyncedDescription = desc
		current.SyncError = ""
	})
	if err != nil {
		return err
	}
	if !r.CloseRequested || r.Status != Completed || r.CompletionRequest != "" || Description(r) != desc {
		return nil
	}
	ready, err := m.closingNotice(ctx, r)
	if err != nil {
		return m.syncFailure(r.ID, err)
	}
	if !ready {
		return nil
	}
	r, err = m.change(r.ID, func(r *Record) {
		if r.CloseRequested && r.Status == Completed && r.CompletionRequest == "" {
			r.Status = Destroying
			r.Detail = "验收已完成，正在关闭执行会话和临时群；代码与任务记录保留"
			r.UpdatedAt = time.Now()
		}
	})
	if err != nil || r.Status != Destroying {
		return err
	}
	if err := m.destroy(ctx, r); err != nil {
		return m.syncFailure(r.ID, err)
	}
	return nil
}

func (m *Manager) closingNotice(ctx context.Context, r Record) (bool, error) {
	if m.opts.BeforeClose == nil || r.ChatID == "" || r.ChatDeleted {
		return true, nil
	}
	if !r.CloseNotifiedAt.IsZero() {
		return time.Since(r.CloseNotifiedAt) >= closeNoticeGrace, nil
	}
	if err := m.opts.BeforeClose(ctx, r); err != nil {
		return false, err
	}
	_, err := m.change(r.ID, func(r *Record) {
		if r.Status == Destroying || (r.CloseRequested && r.Status == Completed && r.CompletionRequest == "") {
			r.CloseNotifiedAt = time.Now()
		}
	})
	return false, err
}

func (m *Manager) destroy(ctx context.Context, r Record) error {
	// Save the final summary before closing either resource. If Feishu cannot
	// store the result, keep both the coding session and task group available.
	if r.GUID != "" {
		desc := Description(r)
		if err := m.opts.Platform.UpdateTask(ctx, r.GUID, desc, nil); err != nil {
			return m.syncFailure(r.ID, err)
		}
		var err error
		r, err = m.change(r.ID, func(r *Record) { r.SyncedDescription = desc; r.SyncError = "" })
		if err != nil {
			return err
		}
	}
	ready, err := m.closingNotice(ctx, r)
	if err != nil || !ready {
		return err
	}
	if r.PaneID != "" && !r.PaneClosed {
		p, err := m.opts.Client.PaneGet(ctx, r.PaneID)
		var apiErr *herdrapi.APIError
		if err != nil && !(errors.As(err, &apiErr) && (apiErr.Code == herdrapi.CodeNotFound || apiErr.Code == "pane_not_found")) {
			return err
		}
		if err == nil {
			if p.WorkspaceID != r.WorkspaceID {
				return errors.New("拒绝关闭不属于该任务工作区的窗口")
			}
			if err = m.opts.Lifecycle.PaneClose(ctx, r.PaneID); err != nil {
				return err
			}
		}
		r, err = m.change(r.ID, func(r *Record) { r.PaneClosed = true })
		if err != nil {
			return err
		}
	}
	if r.ChatID != "" && !r.ChatDeleted {
		if err := m.opts.Platform.DeleteTaskChat(ctx, r.ChatID); err != nil {
			return m.syncFailure(r.ID, err)
		}
		var err error
		r, err = m.change(r.ID, func(r *Record) { r.ChatDeleted = true })
		if err != nil {
			return err
		}
	}
	r, err = m.change(r.ID, func(r *Record) {
		r.Status = Destroyed
		r.Detail = "执行窗口和临时群已关闭；代码与任务记录保留"
		r.CompletionRequest = ""
		switch r.Pending {
		case "task", "chat", "workspace":
			r.Error = "上次 " + r.Pending + " 创建结果未确认，可能存在未绑定资源，需要手动核对；系统未重复创建"
			r.Detail = "已关闭所有已绑定资源；仍有创建结果需要核对"
		default:
			r.Pending = ""
			r.Error = ""
		}
		r.UpdatedAt = time.Now()
	})
	if err != nil {
		return err
	}
	if r.GUID != "" {
		return m.syncRemote(ctx, r)
	}
	return nil
}
func value(p *string, fallback string) string {
	if p != nil && *p != "" {
		return *p
	}
	return fallback
}
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// AcceptInput records a human's explicit follow-up, including recovery from an
// uncertain initial delivery. The controller already reported delivery quality
// to the human; the manager never silently replays that text.
func (m *Manager) AcceptInput(pane string, verified bool) error {
	r, ok := m.ByPane(pane)
	if !ok {
		return nil
	}
	_, err := m.change(r.ID, func(r *Record) {
		if r.Status == Completed || r.Status == Destroying || r.Status == Destroyed || r.CloseRequested {
			return
		}
		r.PromptSent = true
		if r.Pending == "prompt" {
			r.Pending = ""
			r.Error = ""
		}
		r.Status = Running
		r.Detail = "已收到新的任务指令"
		if !verified {
			r.Status = Attention
			r.Detail = "指令已发送但尚未确认，请检查会话"
		}
		r.UpdatedAt = time.Now()
	})
	m.Wake()
	return err
}

func (m *Manager) OwnerAllowed(owner string) bool {
	return m.opts.AllowedOwner == nil || m.opts.AllowedOwner(owner)
}
