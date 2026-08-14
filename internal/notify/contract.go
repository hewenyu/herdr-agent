// Package notify turns agent state transitions into phone pushes.
//
// It deliberately knows nothing about Feishu: it watches the registry, decides
// WHAT deserves a push and WHEN, and hands the decision to a Sink. That makes
// the interesting logic (idempotency, cooldown, which edges matter) testable
// without a network.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package notify

import (
	"context"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// DefaultCooldown is the minimum gap between pushes about the same pane.
const DefaultCooldown = 30 * time.Second

// Sink delivers a decided notification. Implemented by the bridge.
type Sink interface {
	// PushBlocked sends an actionable card. dialog is already cropped for a
	// phone. The sink is responsible for building the card and binding the
	// resulting message for reply-routing.
	PushBlocked(ctx context.Context, a agents.Agent, dialog screen.Screen) error
	// PushDone reports that an agent finished and nobody has looked at it.
	PushDone(ctx context.Context, a agents.Agent, tail screen.Screen) error
	// PushGone reports that an agent's pane disappeared.
	PushGone(ctx context.Context, a agents.Agent) error
}

// Notifier consumes registry transitions and drives a Sink.
//
// Rules it must enforce:
//   - Edges that notify: -> blocked, -> done, -> gone. Nothing else.
//     done is idle-and-unseen; it is derived by herdr and does not depend on
//     any screen regex, which makes it the most reliable trigger we have (G11).
//     -> idle is NOT an edge: it means the desktop user is already looking.
//   - Idempotency key is (paneID, stateSeq). The same pair is pushed once,
//     ever. This matters because a reconnect makes the registry re-reconcile.
//   - Per-pane cooldown; transitions arriving inside it are coalesced to the
//     latest one and emitted when the cooldown expires.
//   - It must NEVER call agent.focus or pane.focus to "mark as read": that
//     would clear `done` and yank the desktop user's UI (G10).
//   - A Sink error is logged and the (pane, seq) is NOT marked delivered, so
//     the next transition can retry.
type Notifier interface {
	Run(ctx context.Context) error
}

// New builds a Notifier.
//
// Implementations must provide, in notify.go, exactly:
//
//	func New(reg agents.Registry, ex screen.Extractor, sink Sink, opts ...Option) Notifier
//	func WithCooldown(d time.Duration) Option
//	func WithClock(f func() time.Time) Option
//	func WithTailLines(n int) Option
type Option func(*options)

type options struct {
	cooldown  time.Duration
	clock     func() time.Time
	tailLines int
}
