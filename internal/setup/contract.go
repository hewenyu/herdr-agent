// Package setup registers a Feishu app and proves it works, so that onboarding
// is one confirmation instead of sixteen console interactions.
//
// What it does NOT do, and why: the Feishu application/v7 configuration API
// (ability / config / publish) is not used at all. It was measured to be
// unnecessary — an app created through the confirmation flow already arrives
// with the bot capability enabled, the event subscribed, long-connection
// delivery selected and a version PUBLISHED (online_version_id non-empty), and
// a real inbound message was received from it without any console visit while
// all three v7 calls were failing. Writing that code would add a maintenance
// surface that buys nothing.
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package setup

import (
	"errors"
	"time"
)

// Scopes, events and callbacks requested on the confirmation page.
//
// Request exactly what the bridge uses and nothing more: the confirmation page
// shows this list to the human, and asking for authority we never exercise
// both scares the reader and widens the blast radius of a leaked secret.
// application:application:* is deliberately absent — see the package comment.
var (
	Scopes = []string{
		"im:message",                  // send, and read messages in chats the bot is in
		"im:message.p2p_msg:readonly", // read the DMs a human sends the bot
		"im:message:send_as_bot",      // send as the bot identity
		"im:resource",                 // upload/download images and files
	}
	Events    = []string{"im.message.receive_v1"}
	Callbacks = []string{"card.action.trigger"}
)

// Timeouts for the two halves of verification.
const (
	// RegisterTimeout bounds the whole device-authorization flow. The platform
	// expires its own code in ~600s; this is the outer bound.
	RegisterTimeout = 12 * time.Minute
	// InboundTimeout is how long we wait for the human to message the bot.
	InboundTimeout = 150 * time.Second
	// CardTimeout is how long we wait for them to press the card button.
	CardTimeout = 120 * time.Second
)

// Outcome is what setup achieved. Anything less than Verified is reported with
// a named cause and the exact remaining step, never as a bare failure.
type Outcome int

const (
	// OutcomeFailed: nothing usable was produced.
	OutcomeFailed Outcome = iota
	// OutcomeCredentials: an app exists and credentials are on disk, but the
	// round trip did not complete. The user owns a working configuration and a
	// checklist, which is why registration is persisted before anything that
	// can fail.
	OutcomeCredentials
	// OutcomeVerified: a real message arrived AND a card button round-tripped.
	OutcomeVerified
)

func (o Outcome) String() string {
	switch o {
	case OutcomeVerified:
		return "verified"
	case OutcomeCredentials:
		return "credentials-only"
	default:
		return "failed"
	}
}

// Result reports what happened, in enough detail for the CLI to print a
// checklist naming the exact remaining click.
type Result struct {
	Outcome Outcome
	AppID   string
	// OpenID is the confirming user, written into allowed_open_ids.
	OpenID string
	// ChatID is the DM the verification message arrived in, written into
	// notify_chat_id. Empty when inbound verification did not complete.
	ChatID string
	// InboundOK proves credentials, bot capability, event subscription,
	// delivery mode, publication, scopes and the allowlist in one observation.
	InboundOK bool
	// CardOK proves the interactive-card path end to end.
	//
	// A failure here is NOT conclusive about the cause: the measured E1 probe
	// could not distinguish "the 交互卡片 capability needs a manual toggle"
	// from "the human did not press the button in time". The CLI must say both.
	CardOK bool
	// Reused is true when a valid credential file already existed.
	Reused bool
	// Steps are the remaining manual actions, each with a concrete URL.
	Steps []Step
}

// Step is one thing the human still has to do, named precisely. "Configure the
// app" is not a step; "open <url>, 应用能力 → 机器人 → 交互卡片 → 开启" is.
type Step struct {
	What string
	URL  string
	Why  string
}

var (
	// ErrCredentialsExist guards against burning a second app: no deletion API
	// was found for apps created this way, so every registration is permanent
	// tenant clutter.
	ErrCredentialsExist = errors.New("credentials already exist; pass --reregister to create another app")
	// ErrEnvOverride means FEISHU_APP_ID or FEISHU_APP_SECRET is exported in
	// the process environment. Process env beats the .env file, so a stale
	// export silently defeats everything setup is about to write.
	ErrEnvOverride = errors.New("FEISHU_APP_ID/FEISHU_APP_SECRET are set in the environment and would override the file setup writes")
	// ErrBridgeRunning means the single-instance lock is held. Long-connection
	// delivery is cluster-mode: a second client does not fail, it silently
	// takes a random share of the user's real messages.
	ErrBridgeRunning = errors.New("the bridge is running; stop it before running setup")
)

// Progress reports what setup is doing, so the CLI owns all presentation.
type Progress interface {
	// Verification hands the human the confirmation URL.
	Verification(url string, expiresIn int)
	// Registered fires once credentials exist and are on disk.
	Registered(appID, openID string)
	// AwaitInbound asks the human to message the bot.
	AwaitInbound(d time.Duration)
	// AwaitCard asks the human to press the button.
	AwaitCard(d time.Duration)
	// Note is an intermediate observation worth printing.
	Note(msg string)
}

// Runner performs the flow.
//
// Implementations must provide, in setup.go, exactly:
//
//	func New(stateDir string, p Progress, opts ...Option) (*Runner, error)
//	func (r *Runner) Run(ctx context.Context, reregister bool) (Result, error)
//	func WithClock(f func() time.Time) Option
//
// Run must be idempotent and re-runnable: with valid credentials present and
// reregister false it skips registration entirely and goes straight to
// verification, which makes setup double as the repair path.
//
// Ordering is load-bearing. Credentials are written to disk the instant
// registration returns, BEFORE the WebSocket is started or anything is
// verified. If verification then fails the user still owns a usable
// configuration plus a checklist, rather than nothing.
type Option func(*Runner)

// Runner is the setup flow.
type Runner struct {
	stateDir string
	progress Progress
	now      func() time.Time
}
