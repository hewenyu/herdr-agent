// Package bridge is the orchestrator: it owns every policy decision that sits
// between a Feishu event and an agent keystroke.
//
// The security boundary of the whole product lives here. herdr's socket has no
// authentication and access to it is equivalent to shell access (G10), so an
// authorization hole is arbitrary code execution on the user's machine.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package bridge

import (
	"context"
	"errors"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/dedup"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/routes"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// NSNonce is the dedup namespace used to make a card button single-use.
// Reusing the persistent dedup store means a nonce survives a bridge restart,
// which matters because a restart is exactly when Feishu redelivers (G14).
const NSNonce = "nonce"

// NonceTTL bounds how long a card's buttons remain pressable at all. It is a
// backstop; the real protection is the guard's StateSeq check (G17).
const NonceTTL = 24 * time.Hour

// QueueLimit caps per-pane queued prose.
const DefaultQueueLimit = 5

// BusyAckCooldown throttles "queued" receipts for one pane.
const BusyAckCooldown = 30 * time.Second

var (
	// ErrUnauthorized is returned for any actor not on the allowlist. Callers
	// must drop silently: replying would confirm the bot exists and leak that
	// the allowlist is configured.
	ErrUnauthorized = errors.New("sender not authorized")
	ErrQueueFull    = errors.New("queue full for this pane")
	ErrNoAgent      = errors.New("no agent to route to")
	ErrAmbiguous    = errors.New("several agents; name one")
)

// Deps are everything the bridge needs. All are interfaces so the whole
// orchestration is testable without a network or a herdr server.
type Deps struct {
	Bot        lark.Bot
	Registry   agents.Registry
	Controller agents.Controller
	Extractor  screen.Extractor
	Resolver   agents.TranscriptResolver
	Dedup      dedup.Store
	Routes     routes.Store
	Watcher    mirror.Watcher

	AllowedOpenIDs []string
	NotifyChatID   string
	MaxCols        int
	TailLines      int
	QueueLimit     int

	Now func() time.Time
}

// Bridge wires inbound Feishu events to agents and agent state to Feishu.
//
// Run installs handlers, starts the notifier and the mirror pump, then blocks
// until ctx is cancelled.
type Bridge interface {
	Run(ctx context.Context) error

	// Sink methods, so the bridge can be handed to notify.New.
	PushBlocked(ctx context.Context, a agents.Agent, dialog screen.Screen) error
	PushDone(ctx context.Context, a agents.Agent, tail screen.Screen) error
	PushGone(ctx context.Context, a agents.Agent) error
}

// New builds a Bridge.
//
// Implementations must provide, in bridge.go, exactly:
//
//	func New(d Deps) (Bridge, error)
//
// and must enforce, in this order, for EVERY inbound event:
//
//  1. authorization — Msg.UserID / Action.Operator against AllowedOpenIDs.
//     Default deny; unauthorized events are logged at WARN and dropped with
//     no reply. Enforced at every entry point, not just the happy path.
//  2. deduplication — dedup.Store on EventID, before any side effect. When
//     the handler subsequently returns an error, Unmark so Feishu's retry gets
//     a real second chance (G14).
//  3. the action itself.
//
// Card actions additionally require, in this exact order (S2 §3.6):
//
//  3. nonce consumed exactly once (NSNonce)
//  4. cards.DecodeDecision then agents guard validation
//  5. Controller.SendKey
//  6. UpdateCard to a disarmed card — ALWAYS, success or failure. A card left
//     armed in chat history keeps working forever (G17).
//
// Prose routing must never reach a blocked agent directly: it goes through
// Controller.Say, which escapes first (G1). A parsed command that is unknown
// or malformed must produce an error reply and must NOT fall through to prose.
type Factory interface {
	New(d Deps) (Bridge, error)
}
