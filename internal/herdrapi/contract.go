// Package herdrapi is the ONLY code in this repo that speaks the herdr socket
// protocol. Everything above it goes through the whitelisted methods below.
//
// Hard constraints (see specs/00-ground-truth.md G10):
//   - one request per connection, no reuse
//   - request "id" must be a JSON string
//   - the server has no timeout of its own; the client must impose one
//   - the socket has no authentication; access == shell access
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package herdrapi

import (
	"context"
	"errors"
	"time"
)

// ---------- errors ----------

// APIError is a structured error returned by herdr.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

// Error codes herdr returns that callers branch on.
const (
	CodeNotFound         = "not_found"
	CodeInvalidRequest   = "invalid_request"
	CodeInvalidParams    = "invalid_params"
	CodeAgentNotReady    = "agent_not_ready"
	CodeAgentPromptStall = "agent_prompt_stalled"
	CodeAgentNotIdle     = "agent_not_idle"
	CodeAgentPaneBusy    = "agent_pane_busy"
	CodeEmptyAgentPrompt = "empty_agent_prompt"
	CodeTimeout          = "timeout"
	CodeFeatureDisabled  = "feature_disabled"
)

// CodeAgentOptionsUnconfirmed means agent.start returned without confirming
// the requested startup arguments. The agent may exist, but callers must not
// submit its task or recover it as a successfully configured session.
const CodeAgentOptionsUnconfirmed = "agent_options_unconfirmed"

// ErrServerUnavailable means the socket could not be reached at all.
var ErrServerUnavailable = errors.New("herdr server not running")

// ErrProtocolTooOld means the running server predates what we support.
var ErrProtocolTooOld = errors.New("herdr protocol too old")

// MinProtocol is the lowest herdr protocol version this bridge supports.
const MinProtocol = 19

// ---------- wire types ----------

// SessionRef is the agent's native session reference, when herdr has one.
// Kind is "id" or "path". For claude/codex it is always "id" (G8).
type SessionRef struct {
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Kind   string `json:"kind"`
	Value  string `json:"value"`
}

// AgentInfo mirrors herdr's AgentInfo. Only fields the bridge uses are decoded.
type AgentInfo struct {
	PaneID                string      `json:"pane_id"`
	WorkspaceID           string      `json:"workspace_id"`
	TabID                 string      `json:"tab_id"`
	TerminalID            string      `json:"terminal_id"` // NOT restart-stable; never use as a key
	Agent                 *string     `json:"agent"`
	AgentStatus           string      `json:"agent_status"`
	Cwd                   *string     `json:"cwd"`
	ForegroundCwd         *string     `json:"foreground_cwd"`
	Name                  *string     `json:"name"`
	TerminalTitle         *string     `json:"terminal_title"`
	TerminalTitleStripped *string     `json:"terminal_title_stripped"`
	Title                 *string     `json:"title"`
	AgentSession          *SessionRef `json:"agent_session"`
	StateChangeSeq        uint64      `json:"state_change_seq"`
	InteractiveReady      bool        `json:"interactive_ready"`
	LaunchPending         bool        `json:"launch_pending"`
	Focused               bool        `json:"focused"`
	Revision              uint64      `json:"revision"`
}

// ScrollInfo carries the pane's viewport metrics when herdr exposes them.
type ScrollInfo struct {
	OffsetFromBottom    int `json:"offset_from_bottom"`
	MaxOffsetFromBottom int `json:"max_offset_from_bottom"`
	ViewportRows        int `json:"viewport_rows"`
}

// PaneInfo mirrors herdr's PaneInfo (subset).
type PaneInfo struct {
	PaneID      string      `json:"pane_id"`
	WorkspaceID string      `json:"workspace_id"`
	TabID       string      `json:"tab_id"`
	TerminalID  string      `json:"terminal_id"`
	Agent       *string     `json:"agent"`
	AgentStatus string      `json:"agent_status"`
	Cwd         *string     `json:"cwd"`
	Scroll      *ScrollInfo `json:"scroll"`
}

// ReadSource selects which buffer herdr returns.
//
// Only SourceVisible and SourceDetection are permitted by this package.
// SourceRecent with lines > viewport rows makes herdr synthesise real mouse
// wheel events into the user's live pane for up to 15s (G9), and clients
// cannot opt out of that.
type ReadSource string

const (
	SourceVisible   ReadSource = "visible"
	SourceDetection ReadSource = "detection"
)

// PromptWait asks agent.prompt to block until the agent settles.
// Used as a delivery acknowledgement (G3).
type PromptWait struct {
	Until     []string `json:"until,omitempty"`
	TimeoutMs *uint64  `json:"timeout_ms,omitempty"`
}

// PingResult reports server identity and protocol version.
type PingResult struct {
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
}

// ---------- client ----------

// Client is the whitelisted herdr control surface.
//
// Lifecycle operations are deliberately absent from this interface. The task
// orchestrator opts into LifecycleClient separately, and may only close panes
// it owns. The following methods remain forbidden on both interfaces:
//
//	agent.focus / pane.focus   clears `done` and yanks the desktop user's UI (G10)
//	server.stop                out of scope and irreversible
//	workspace.close / tab.close / tab.create / pane.split
//	pane.read/agent.read with source=recent
type Client interface {
	Ping(ctx context.Context) (PingResult, error)
	AgentList(ctx context.Context) ([]AgentInfo, error)
	AgentGet(ctx context.Context, target string) (AgentInfo, error)
	// AgentRead returns terminal text. src must be SourceVisible or
	// SourceDetection; anything else returns an error without a network call.
	AgentRead(ctx context.Context, target string, src ReadSource, lines int) (string, error)
	PaneGet(ctx context.Context, paneID string) (PaneInfo, error)
	// AgentPrompt submits text. wait may be nil. A non-nil wait turns the call
	// into a delivery acknowledgement: CodeAgentPromptStall means not delivered.
	AgentPrompt(ctx context.Context, target, text string, wait *PromptWait) (AgentInfo, error)
	AgentSendKeys(ctx context.Context, target string, keys []string) error
	NotificationShow(ctx context.Context, title, body string) error
	// Close releases any cached resources. Safe to call more than once.
	Close() error
}

// WorkspaceInfo identifies a workspace created or discovered for a task.
// WorkspaceList does not return a root pane in herdr's protocol, so PaneID is
// empty for list results. Cwd is the root pane cwd after creation; in list
// results it is the Git worktree checkout path, or empty if unavailable.
type WorkspaceInfo struct {
	ID     string `json:"workspace_id"`
	Label  string `json:"label"`
	Cwd    string `json:"cwd,omitempty"`
	PaneID string `json:"pane_id,omitempty"`
}

// LifecycleClient is the explicitly opted-in task lifecycle control surface.
// New's socket client implements it without widening the ordinary Client used
// by message forwarding and permission handling. Callers must persist resource
// ownership and only pass owned pane IDs to PaneClose.
type LifecycleClient interface {
	WorkspaceCreate(ctx context.Context, cwd, label string) (WorkspaceInfo, error)
	WorkspaceList(ctx context.Context) ([]WorkspaceInfo, error)
	// AgentStart starts an interactive agent, then waits for idle/done readiness
	// or a blocked approval prompt. A blocked result is successful startup, not
	// permission to send a task: callers must hold the initial prompt until the
	// agent is interactive, not launch-pending, and idle/done. No prompt text or
	// approval keystrokes are sent by AgentStart. On a wait failure it returns
	// the latest observed AgentInfo along with the error for recovery.
	AgentStart(ctx context.Context, paneID, kind, name string) (AgentInfo, error)
	PaneClose(ctx context.Context, paneID string) error
}

// AgentStartOptions selects the explicitly supported native startup options.
type AgentStartOptions struct {
	Directories []string // existing absolute directories in addition to the pane's cwd
	Bypass      bool     // opt in to bypassing native agent permission checks
}

// ConfiguredLifecycleClient is the optional configured startup extension.
// It supports Codex and Claude native directory and permission-bypass flags;
// no task text, arbitrary flags, or approval keystrokes are accepted.
// Like AgentStart, an error can accompany an already-created agent. Callers
// must not send its task until this operation has succeeded and been persisted.
type ConfiguredLifecycleClient interface {
	AgentStartWithOptions(ctx context.Context, paneID, kind, name string, opts AgentStartOptions) (AgentInfo, error)
}

// AgentStartupTimeout bounds polling after a successful agent.start request.
// herdr accepts startup windows greater than 3 seconds and at most 5 minutes.
const AgentStartupTimeout = 30 * time.Second

// Options configure the socket client.
type Options struct {
	SocketPath string        // empty => resolve per ResolveSocketPath
	Timeout    time.Duration // per-call read deadline; 0 => DefaultTimeout
}

// DefaultTimeout bounds every call. herdr has no server-side timeout and is
// served by the single UI thread, so a modal dialog would otherwise wedge us.
const DefaultTimeout = 10 * time.Second

// WriteDeadline is herdr's own limit for receiving the request line (G10).
const WriteDeadline = 5 * time.Second

// MaxRequestBytes is herdr's limit for a single request line (G10).
const MaxRequestBytes = 1 << 20
