// Package tasktools exposes managed tasks to an authenticated personal assistant.
// The caller's identity is bound at construction, never supplied by a model.
package tasktools

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

type Manager interface {
	OwnerAllowed(string) bool
	List(string, bool) []tasks.Record
	Get(string) (tasks.Record, bool)
	Create(owner, entry, requestID, project, kind, title string) (tasks.Record, error)
	Request(owner, id, action string) (tasks.Record, error)
	AcceptInput(pane string, verified bool) error
}

type Registry interface {
	Get(string) (agents.Agent, bool)
}
type Controller interface {
	Say(context.Context, agents.Guard, string) (agents.Delivery, error)
}

type Options struct {
	OwnerID     string
	EntryChatID string
	StatePath   string
	Config      config.Tasks
	Projects    interface {
		Snapshot() config.Tasks
		Create(context.Context, string, string, bool) (config.Project, error)
	}
	Manager    Manager
	Registry   Registry
	Controller Controller
}

type Service struct {
	opts    Options
	journal *journal
	mu      *sync.Mutex
	taskID  string
	chatID  string
}

// Tool describes the controlled operations exposed to the conversational agent.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"parameters"`
	ReadOnly    bool           `json:"read_only"`
	Destructive bool           `json:"destructive"`
}

func New(o Options) (*Service, error) {
	if o.OwnerID == "" || o.Manager == nil || o.Registry == nil || o.Controller == nil || !o.Manager.OwnerAllowed(o.OwnerID) {
		return nil, errors.New("assistant: missing dependency or unauthorized owner")
	}
	j, err := openJournal(o.StatePath)
	if err != nil {
		return nil, err
	}
	projects := make(map[string]config.Project, len(o.Config.Projects))
	for k, v := range o.Config.Projects {
		v.Directories = append([]string(nil), v.Directories...)
		projects[k] = v
	}
	o.Config.Projects = projects
	return &Service{opts: o, journal: j, mu: &sync.Mutex{}}, nil
}

// ForOwner binds a verified Feishu sender while sharing the operation journal.
// Only the trusted chat bridge chooses this identity; tool arguments cannot.
func (s *Service) ForOwner(owner string) (*Service, error) {
	if owner == "" || !s.opts.Manager.OwnerAllowed(owner) {
		return nil, errors.New("当前用户不在本项目允许名单内")
	}
	if s.taskID != "" && owner != s.opts.OwnerID {
		return nil, errors.New("任务群不能切换用户或任务")
	}
	o := s.opts
	if o.OwnerID != owner {
		// An entry chat belongs to its authenticated sender. Rebinding only an
		// identity must not retain another person's notification destination.
		o.EntryChatID = ""
	}
	o.OwnerID = owner
	return &Service{opts: o, journal: s.journal, mu: s.mu, taskID: s.taskID, chatID: s.chatID}, nil
}

// ForChat binds notification routing from the authenticated inbound event.
func (s *Service) ForChat(owner, chat string) (*Service, error) {
	bound, err := s.ForOwner(owner)
	if err != nil {
		return nil, err
	}
	if chat == "" {
		return nil, errors.New("assistant: missing entry chat")
	}
	if s.taskID != "" && chat != s.chatID {
		return nil, errors.New("任务群不能切换用户或任务")
	}
	bound.opts.EntryChatID = chat
	return bound, nil
}

// ForTask limits the assistant to the task associated with this verified group.
// A claimed task ID is not sufficient: ownership and the persisted group binding
// are checked now and on every call, including replayed operation receipts.
func (s *Service) ForTask(owner, chat, taskID string) (*Service, error) {
	bound, err := s.ForChat(owner, chat)
	if err != nil {
		return nil, err
	}
	if taskID == "" || (s.taskID != "" && s.taskID != taskID) {
		return nil, errors.New("任务群缺少有效的任务绑定")
	}
	bound.taskID, bound.chatID = taskID, chat
	if _, err := bound.owned(taskID); err != nil {
		return nil, err
	}
	return bound, nil
}

type Task struct {
	ID                 string       `json:"id"`
	Title              string       `json:"title"`
	Project            string       `json:"project"`
	Agent              string       `json:"agent"`
	DirectoryCount     int          `json:"directory_count"`
	WorkingDirectory   string       `json:"working_directory,omitempty"`
	WorkingDirectories []Directory  `json:"working_directories,omitempty"`
	Bypass             bool         `json:"bypass"`
	Started            bool         `json:"started"`
	PromptSent         bool         `json:"prompt_sent"`
	Status             tasks.Status `json:"status"`
	StatusLabel        string       `json:"status_label"`
	Progress           string       `json:"progress,omitempty"`
	LatestReply        string       `json:"latest_reply,omitempty"`
	Error              string       `json:"error,omitempty"`
	SyncError          string       `json:"sync_error,omitempty"`
	PendingOperation   string       `json:"pending_operation,omitempty"`
	CompletionRequest  string       `json:"completion_request,omitempty"`
	CloseRequested     bool         `json:"close_requested,omitempty"`
	CloseNotifiedAt    time.Time    `json:"close_notified_at,omitempty"`
	CompletedAt        string       `json:"completed_at,omitempty"`
	TaskURL            string       `json:"task_url,omitempty"`
	ChatURL            string       `json:"chat_url,omitempty"`
	UpdatedAt          time.Time    `json:"updated_at"`
	RemoteCheckedAt    time.Time    `json:"remote_checked_at"`
}

func view(r tasks.Record) Task {
	v := Task{ID: r.ID, Title: r.Title, Project: r.Project, Agent: r.Agent, Started: r.Started, PromptSent: r.PromptSent, Status: r.Status, StatusLabel: r.Status.Label(), Progress: r.Detail, LatestReply: r.Result, Error: r.Error, SyncError: r.SyncError, PendingOperation: r.Pending, CompletionRequest: r.CompletionRequest, CloseRequested: r.CloseRequested, CloseNotifiedAt: r.CloseNotifiedAt, CompletedAt: r.CompletedAt, TaskURL: r.URL, UpdatedAt: r.UpdatedAt, RemoteCheckedAt: r.RemoteCheckedAt}
	v.DirectoryCount = len(r.Directories)
	if v.DirectoryCount == 0 && r.Path != "" {
		v.DirectoryCount = 1
	}
	v.Bypass = r.Bypass
	v.WorkingDirectory = r.Path
	v.WorkingDirectories = inspectDirectories(r.Path, r.Directories)
	if r.ChatID != "" && !r.ChatDeleted {
		v.ChatURL = tasks.ChatURL(r.ChatID)
	}
	return v
}

type receipt struct {
	RequestID string    `json:"request_id"`
	Replayed  bool      `json:"replayed"`
	Outcome   string    `json:"outcome"`
	Task      Task      `json:"task"`
	Delivery  *delivery `json:"delivery,omitempty"`
}

type delivery struct {
	Acked                 bool `json:"acked"`
	Verified              bool `json:"verified"`
	Queued                bool `json:"queued"`
	CancelledDialog       bool `json:"cancelled_dialog"`
	MayHaveAnsweredDialog bool `json:"may_have_answered_dialog"`
}

type arguments struct {
	RequestID  string `json:"request_id,omitempty"`
	TaskID     string `json:"task_id,omitempty"`
	Project    string `json:"project,omitempty"`
	NewProject bool   `json:"new_project,omitempty"`
	Agent      string `json:"agent,omitempty"`
	Text       string `json:"text,omitempty"`
	All        bool   `json:"all,omitempty"`
}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

func (s *Service) Call(ctx context.Context, name string, raw json.RawMessage) (any, error) {
	if !s.opts.Manager.OwnerAllowed(s.opts.OwnerID) {
		return nil, errors.New("当前用户不在本项目允许名单内")
	}
	if s.taskID != "" {
		if _, err := s.owned(s.taskID); err != nil {
			return nil, err
		}
	}
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var a arguments
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&a); err != nil {
		return nil, errors.New("工具参数无效；不能指定用户、仓库路径或终端窗口")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, errors.New("工具参数必须是单个 JSON 对象")
	}
	// Apply the schema here too, so callers cannot smuggle irrelevant fields
	// past a framework implementation that does not validate input schemas.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, errors.New("工具参数必须是 JSON 对象")
	}
	var tool *Tool
	for _, t := range s.Tools() {
		if t.Name == name {
			tool = &t
			break
		}
	}
	if tool == nil {
		return nil, errors.New("未知任务工具")
	}
	allowed := tool.InputSchema["properties"].(map[string]any)
	for field, rawValue := range fields {
		property, ok := allowed[field]
		if !ok {
			return nil, fmt.Errorf("此工具不接受参数 %s", field)
		}
		// encoding/json accepts null into string/bool fields as their zero
		// value. The tool schema does not: null project/agent must not quietly
		// select a default, nor null all pretend to be a valid boolean.
		if bytes.Equal(bytes.TrimSpace(rawValue), []byte("null")) {
			return nil, fmt.Errorf("参数 %s 不能为 null", field)
		}
		if values, ok := property.(map[string]any)["enum"].([]string); ok {
			var value string
			_ = json.Unmarshal(rawValue, &value) // its type was checked above
			matched := false
			for _, candidate := range values {
				matched = matched || value == candidate
			}
			if !matched {
				return nil, fmt.Errorf("参数 %s 不在允许值内", field)
			}
		}
	}
	for _, field := range tool.InputSchema["required"].([]string) {
		if _, ok := fields[field]; !ok {
			return nil, fmt.Errorf("缺少参数 %s", field)
		}
	}
	if s.taskID != "" {
		if a.TaskID != "" && a.TaskID != s.taskID {
			return nil, errors.New("任务群只能查询或操作当前任务")
		}
		a.TaskID = s.taskID
	}
	switch name {
	case "herdr_projects":
		type project struct {
			Name           string `json:"name"`
			Agent          string `json:"default_agent"`
			Default        bool   `json:"default"`
			DirectoryCount int    `json:"directory_count"`
			Bypass         bool   `json:"bypass"`
		}
		cfg := s.projectConfig()
		out := make([]project, 0, len(cfg.Projects))
		for n, p := range cfg.Projects {
			count := len(p.Directories)
			if count == 0 && p.Path != "" {
				count = 1
			}
			out = append(out, project{n, p.Agent, n == cfg.DefaultProject, count, cfg.Bypass})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
		return out, nil
	case "herdr_list":
		out := []Task{}
		for _, r := range s.opts.Manager.List(s.opts.OwnerID, a.All) {
			if r.OwnerID == s.opts.OwnerID {
				out = append(out, view(r))
			}
		}
		return out, nil
	case "herdr_get":
		r, err := s.owned(a.TaskID)
		return view(r), err
	}
	if !requestIDPattern.MatchString(a.RequestID) {
		return nil, errors.New("request_id 必须是 8–128 位字母、数字、下划线或短横线；重试必须复用原 ID")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.opts.Manager.OwnerAllowed(s.opts.OwnerID) {
		return nil, errors.New("当前用户不在本项目允许名单内")
	}
	canonical, _ := json.Marshal(a)
	sum := sha256.Sum256(append([]byte(name+"\x00"), canonical...))
	fingerprint := hex.EncodeToString(sum[:])
	key := s.opts.OwnerID + "\x00" + a.RequestID
	if op, ok := s.journal.ops[key]; ok {
		if op.Fingerprint != fingerprint {
			return nil, errors.New("request_id 已用于另一项操作或不同参数，请为新操作生成新 ID")
		}
		if !op.Done {
			return nil, errors.New("此请求的执行结果尚未确认，已阻止重复执行；请查询任务和会话，不要自动换 ID 重发")
		}
		if op.Error != "" {
			return nil, errors.New(op.Error)
		}
		var result receipt
		if err := json.Unmarshal(op.Result, &result); err != nil {
			return nil, errors.New("assistant: invalid saved receipt")
		}
		result.Replayed = true
		if r, err := s.owned(result.Task.ID); err == nil {
			result.Task = view(r)
		} else {
			return nil, err
		}
		return result, nil
	}
	// Validate before reserving the key; rejected calls have no side effects.
	if err := s.validate(name, a); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	op := operation{Fingerprint: fingerprint}
	if err := s.journal.put(key, op); err != nil {
		return nil, fmt.Errorf("保存操作记录失败，未执行: %w", err)
	}
	result, callErr := s.mutate(ctx, name, a)
	op.Done = true
	if callErr != nil {
		op.Error = callErr.Error()
	} else {
		op.Result, _ = json.Marshal(result)
	}
	if err := s.journal.put(key, op); err != nil {
		return nil, errors.New("操作可能已经执行，但无法保存回执；请查询任务状态，不要自动重发")
	}
	return result, callErr
}

func (s *Service) owned(id string) (tasks.Record, error) {
	r, ok := s.opts.Manager.Get(id)
	if id == "" || !ok || r.ID != id || r.OwnerID != s.opts.OwnerID {
		return tasks.Record{}, errors.New("找不到你拥有的任务")
	}
	if s.taskID != "" && (id != s.taskID || r.ChatID != s.chatID || r.ChatDeleted) {
		return tasks.Record{}, errors.New("任务群绑定已失效，不能查询或操作其他任务")
	}
	return r, nil
}

func (s *Service) validate(name string, a arguments) error {
	if name == "herdr_create" {
		cfg := s.projectConfig()
		p := a.Project
		if p == "" {
			p = cfg.DefaultProject
		}
		_, exists := cfg.Projects[p]
		if a.NewProject {
			if s.opts.Projects == nil {
				return errors.New("本地项目配置服务不可用，不能新建项目")
			}
			if err := config.ValidateProjectName(a.Project); err != nil {
				return err
			}
			if exists {
				return errors.New("项目已存在，请使用已配置项目，不能再次新建目录")
			}
		} else if !exists {
			return errors.New("项目未配置，请先调用 herdr_projects；仅在用户明确要求新建项目时设置 new_project=true")
		}
		if a.Agent != "" && a.Agent != "codex" && a.Agent != "claude" {
			return errors.New("agent 仅支持 codex 或 claude")
		}
	} else if _, err := s.owned(a.TaskID); err != nil {
		return err
	}
	if name == "herdr_create" || name == "herdr_send" {
		if n := len([]rune(strings.TrimSpace(a.Text))); n < 1 || n > 3000 {
			return errors.New("任务内容必须为 1–3000 个字符")
		}
	}
	return nil
}

func (s *Service) mutate(ctx context.Context, name string, a arguments) (receipt, error) {
	out := receipt{RequestID: a.RequestID, Outcome: "accepted"}
	var r tasks.Record
	var err error
	if name == "herdr_create" {
		if a.NewProject {
			if _, err := s.opts.Projects.Create(ctx, a.Project, a.Agent, false); err != nil {
				return out, fmt.Errorf("新建项目失败，请查询项目列表，不要自动重试：%w", err)
			}
		}
		r, err = s.opts.Manager.Create(s.opts.OwnerID, s.opts.EntryChatID, "ai:"+a.RequestID, a.Project, a.Agent, a.Text)
	} else {
		r, err = s.owned(a.TaskID)
		if err != nil {
			return out, err
		}
		if name == "herdr_send" {
			if r.CloseRequested || r.Status == tasks.Completed || r.Status == tasks.Destroying || r.Status == tasks.Destroyed || !r.Started || r.PaneID == "" {
				return out, errors.New("任务当前不能接收指令，请先查询状态；已完成任务须先重新打开")
			}
			agent, ok := s.opts.Registry.Get(r.PaneID)
			if !ok || agent.PaneID != r.PaneID || agent.Kind != r.Agent || agent.WorkspaceID != r.WorkspaceID {
				return out, errors.New("任务 agent 不可用或已被替换")
			}
			// Approval stays with the human in the task group. A plain follow-up
			// must not intentionally cancel an existing approval prompt.
			if agent.Status == agents.StatusBlocked {
				return out, errors.New("agent 正在等待审批，请先在任务会话中处理")
			}
			d, sendErr := s.opts.Controller.Say(ctx, agents.Guard{PaneID: agent.PaneID, Kind: agent.Kind, StateSeq: agent.StateSeq, IssuedAt: time.Now(), RequireUnblocked: true}, a.Text)
			if sendErr != nil {
				return out, fmt.Errorf("消息投递未确认，未自动重发；请检查任务会话: %w", sendErr)
			}
			out.Delivery = &delivery{d.Acked, d.Verified, d.Queued, d.Escaped, d.MayHaveAnsweredADialog}
			out.Outcome = "unconfirmed"
			if d.Acked && d.Verified {
				out.Outcome = "delivered"
			}
			if d.Acked {
				if err := s.opts.Manager.AcceptInput(r.PaneID, d.Verified); err != nil {
					return out, errors.New("消息可能已送达，但状态保存失败；不要重发，请检查会话")
				}
			}
			if updated, ok := s.opts.Manager.Get(r.ID); ok {
				r = updated
			}
		} else if name == "herdr_destroy" && r.Status == tasks.Destroyed {
			out.Outcome = "already_destroyed"
		} else {
			r, err = s.opts.Manager.Request(s.opts.OwnerID, a.TaskID, strings.TrimPrefix(name, "herdr_"))
		}
	}
	out.Task = view(r)
	return out, err
}

func (s *Service) Tools() []Tool {
	str := func(description string) any { return map[string]any{"type": "string", "description": description} }
	req := str("此操作的唯一 ID（8–128 位字母、数字、_、-）。首次调用生成；网络重试必须复用相同 ID 和参数，不要为未知结果生成新 ID。")
	id := str("herdr_list 或 herdr_create 返回的任务 id")
	makeTool := func(name, description string, read, destructive bool, props map[string]any, required ...string) Tool {
		if required == nil {
			required = []string{}
		}
		return Tool{Name: name, Description: description, ReadOnly: read, Destructive: destructive, InputSchema: map[string]any{"type": "object", "properties": props, "required": required, "additionalProperties": false}}
	}
	tools := []Tool{
		makeTool("herdr_projects", "查看本地页面最新配置的项目、默认 agent、目录数量和 Bypass 模式。项目可以关联多个文件夹，不可指定任意路径。", true, false, map[string]any{}),
		makeTool("herdr_list", "查询本人正在跟踪的任务，用状态、进展、最近回复和同步错误总结。review 表示待验收，不等于完成。all=true 包含已完成和已销毁记录。", true, false, map[string]any{"all": map[string]any{"type": "boolean"}}),
		makeTool("herdr_get", "查询一个任务的当前状态、最近回复、飞书任务和会话链接。remote_checked_at 是最近核对飞书的时间，sync_error 表示同步问题。", true, false, map[string]any{"task_id": id}, "task_id"),
		makeTool("herdr_create", "按用户要求登记编码任务，使用项目的全部目录启动 agent，自动创建飞书任务、独立群和 herdr 会话。默认使用已配置项目；仅用户明确要求新建项目时设置 new_project=true，并给出新项目名称，会在本机用户 ~/herder-agent-code/<项目名>/ 创建目录并保存关联。未知项目不能自动当作新项目。accepted 仅表示登记，调用 herdr_get 查询进展。", false, false, map[string]any{"request_id": req, "text": str("完整任务要求"), "project": str("项目名称；已有项目省略时使用默认项目，新项目必须明确命名"), "new_project": map[string]any{"type": "boolean", "description": "仅用户明确要求新建项目时为 true；新建任务不等于新建项目，默认 false"}, "agent": map[string]any{"type": "string", "enum": []string{"codex", "claude"}}}, "request_id", "text"),
		makeTool("herdr_send", "给指定任务的 agent 发送用户的后续要求。不会代替人处理审批。delivered 只代表投递已验证，queued 表示 agent 稍后读取；unconfirmed 不得称为成功或自动重发。", false, false, map[string]any{"request_id": req, "task_id": id, "text": str("用户的后续要求")}, "request_id", "task_id", "text"),
	}
	for _, a := range []struct {
		name, description string
		destructive       bool
	}{
		{"complete", "用户验收后登记完成任务。此操作不会终止 agent 或销毁会话；accepted 不代表飞书面板已经同步，请查询 completion_request 和 sync_error。", false},
		{"reopen", "按用户要求重新打开已完成任务，随后可继续发送要求；已销毁会话不能重开。", false},
		{"destroy", "仅在用户明确要求销毁会话时调用。关闭任务执行窗口并解散私有群，群聊天记录不会保留；代码、飞书任务和结果摘要保留。不会自动将任务标记完成。", true},
		{"retry", "重试明确失败且没有未确认副作用的任务创建步骤。未知操作结果不会自动重试。", false},
	} {
		tools = append(tools, makeTool("herdr_"+a.name, a.description, false, a.destructive, map[string]any{"request_id": req, "task_id": id}, "request_id", "task_id"))
	}
	if s.taskID != "" {
		groupTools := make([]Tool, 0, 7)
		for _, tool := range tools {
			if tool.Name == "herdr_projects" || tool.Name == "herdr_list" || tool.Name == "herdr_create" {
				continue
			}
			required := []string{}
			for _, field := range tool.InputSchema["required"].([]string) {
				if field != "task_id" {
					required = append(required, field)
				}
			}
			tool.InputSchema["required"] = required
			tool.InputSchema["properties"].(map[string]any)["task_id"] = str("当前任务 id；可省略，始终绑定本群对应任务，不能指定其他任务")
			groupTools = append(groupTools, tool)
		}
		groupTools = append(groupTools, makeTool("herdr_close", "用户明确验收通过、结单或关闭这个问题时调用。先确认飞书任务完成，再通知并关闭执行会话、解散任务群；保留代码、飞书任务和结果摘要。accepted 仅表示登记，close_requested 表示正在收尾，必须如实说明尚待同步或关闭。不能把未通过验收、不要关闭、仅询问进度或条件性的将来操作视为结单。", false, true, map[string]any{"request_id": req, "task_id": str("当前任务 id；省略时使用本群任务，不能指定其他任务")}, "request_id"))
		return groupTools
	}
	return tools
}

func (s *Service) projectConfig() config.Tasks {
	if s.opts.Projects != nil {
		return s.opts.Projects.Snapshot()
	}
	return s.opts.Config
}
