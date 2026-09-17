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

// DefaultQueueLimit is RETIRED and has no effect.
//
// The bridge no longer queues prose: a working agent accepts it and queues it
// itself (G19/M1), so the per-pane FIFO this capped is gone — see deliver. The
// constant and Deps.QueueLimit stay because they are contract surface that other
// packages still wire (cmd passes cfg.UI.QueueLimit through, and internal/config
// still publishes ui.queue_limit); the value is accepted and ignored. Removing
// them is a coordinated change across those packages, not this wave.
const DefaultQueueLimit = 5

// BusyAckCooldown throttles the per-pane delivery acknowledgement.
//
// It used to throttle "your message is queued" receipts. There are no receipts
// now, and the reason for a throttle survived them unchanged: a phone that
// vibrates for every line typed at one agent gets muted, and a muted phone misses
// the card that says an agent is waiting for a human. So this is how long one
// acknowledgement covers a run of messages to the same pane when no settle
// notification closes it first (bursts).
const BusyAckCooldown = 30 * time.Second

var (
	// ErrUnauthorized is returned for any actor not on the allowlist. Callers
	// must drop silently: replying would confirm the bot exists and leak that
	// the allowlist is configured.
	ErrUnauthorized = errors.New("sender not authorized")
	// ErrQueueFull is RETIRED and is never returned: there is no queue to fill
	// (see DefaultQueueLimit). Kept as contract surface only.
	ErrQueueFull = errors.New("queue full for this pane")
	ErrNoAgent   = errors.New("no agent to route to")
	ErrAmbiguous = errors.New("several agents; name one")
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
	// QueueLimit is accepted and ignored; see DefaultQueueLimit.
	QueueLimit int

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
//     the handler fails before a terminal operation is attempted, Unmark so
//     Feishu's retry gets a second chance (G14). Keep the mark after an input
//     attempt even if its receipt or bookkeeping fails: replay could type twice.
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
//
// Prose must also never be HELD: a working agent accepts text and queues it
// itself (G19/M1), so every accepted message is delivered when it arrives, in
// arrival order. Only the success chatter is deferred — a clean delivery is
// folded into one acknowledgement per pane per burst, and the substantive reply
// is the settle notification the notifier pushes on `done` / `blocked`. What may
// never be deferred: an unproven send (Acked && !Verified, G3), a delivery that
// escaped or may have answered a dialog (G1), a message routed somewhere other
// than where the user aimed it, and every error.
type Factory interface {
	New(d Deps) (Bridge, error)
}
