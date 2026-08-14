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
	CodeEmptyAgentPrompt = "empty_agent_prompt"
	CodeTimeout          = "timeout"
	CodeFeatureDisabled  = "feature_disabled"
)

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
// Methods deliberately absent, and which implementations MUST NOT add:
//
//	agent.focus / pane.focus   clears `done` and yanks the desktop user's UI (G10)
//	server.stop                out of scope and irreversible
//	pane.close / workspace.close / *.create
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
