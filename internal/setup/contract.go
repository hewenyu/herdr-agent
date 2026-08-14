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
	"context"
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

// AppPresetName is the name this package asks the confirmation page to pre-fill
// when the human chooses to create a NEW app there.
//
// It is a WISH, not a fact, and the distinction is the whole subject of this file:
// the page lets the human rename the app before pressing 确认 and one did — the
// app came back called herdr-agent-e1 — so this value may only ever describe what
// that page will offer. It must never name the app that came back. That name is
// App.Name, from bot/v3/info, and empty means say so rather than fall back here.
//
// Exported because the CLI has to tell the reader what the page will pre-fill
// BEFORE they press anything, and the alternative was a second hand-written
// "herdr-agent" in the CLI's prose with nothing linking it to the value actually
// sent. register.go must interpolate this constant for the same reason.
const AppPresetName = "herdr-agent"

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

// Origin says HOW the run arrived at the app it reports. The five paths are
// five different sentences, and only one of them may contain the word
// "created".
//
// The distinction is forced by the platform, not by taste: RegisterAppResult is
// byte-identical whether the confirmation page created an app or handed back
// one the human picked from the list of apps their tenant already has, so a run
// that did not set CreateOnly cannot know which happened. It was measured — a
// run printed "App cli_aaf4… created." for an app that had existed since
// earlier that day and was merely selected on that page.
type Origin int

const (
	// OriginUnknown: no app was established. The zero value, so a Result from a
	// failed run cannot claim a path it never took.
	OriginUnknown Origin = iota
	// OriginRegistered: the confirmation page ran with neither CreateOnly nor a
	// target app id. It may have created a new app, or returned one the human
	// already had; both are fine and the two are indistinguishable from here.
	OriginRegistered
	// OriginCreated: the page ran with CreateOnly set, so it could only create.
	// This is the ONE origin that licenses the word "created".
	OriginCreated
	// OriginAdopted: credentials were found in a file the bridge loads but not
	// in <stateDir>/.env, and were copied there. Nothing was created, and
	// nothing was confirmed by a human during this run.
	OriginAdopted
	// OriginReused: <stateDir>/.env already held a usable pair. Nothing was
	// created, confirmed or written.
	OriginReused
	// OriginUpdated: the page ran against a specific existing app (Options.AppID
	// with CreateOnly unset) — the SDK's documented update flow, which re-grants
	// our scopes, events and callbacks to THAT app instead of making another.
	OriginUpdated
)

func (o Origin) String() string {
	switch o {
	case OriginRegistered:
		// Names the PATH, not the outcome. "registered" reads as "a new app was
		// registered", which is the one thing this origin exists to say cannot
		// be known — and it would print two lines under prose admitting exactly
		// that.
		return "page-confirmed"
	case OriginCreated:
		return "created"
	case OriginAdopted:
		return "adopted"
	case OriginReused:
		return "reused"
	case OriginUpdated:
		return "updated"
	default:
		return "unknown"
	}
}

// PageConfigured reports whether this app's scopes, events and callbacks were
// granted by a confirmation page during THIS run, on THIS app.
//
// Exported because two renderers partition Origin on exactly this question and
// their output lands in the same paragraph: the card checklist step this package
// emits (stepCardTimeout) and the CLI's card hedge. The CLI used to hand-copy the
// switch, and a seventh Origin classified in one copy but not the other would
// print "a button nobody pressed is by far the likeliest cause" directly above
// "the two really are indistinguishable from here".
//
// The answer it encodes was measured, twice, on the SAME app: the E1 probe saw no
// card.action.trigger in 120s, and a later run on that app completed the button
// round trip. So an app that came through the page has a working card path, and
// the surviving hedge belongs to an app somebody built by hand in the console.
func (o Origin) PageConfigured() bool { return o.pageConfigured() }

// App is what the run established about the app it settled on.
//
// It carries the NAME because a name is the only thing that makes an app
// answerable to a human: "cli_aaf76546b438dbfc or cli_aaf4647d33f95be8?" is not
// a question anyone can answer, and the run that motivated this file told its
// user to look for a bot called herdr-agent while bot/v3/info had already
// answered herdr-agent-e1 in the debug log.
type App struct {
	ID string
	// Name is what Feishu calls the app, from bot/v3/info. EMPTY means the
	// lookup did not succeed; say so and print the id rather than falling back
	// to the name we asked the page to pre-fill, which the human may rename on
	// that page and did.
	Name   string
	Origin Origin
	// From is the file this app's credentials were found in, set only for
	// OriginAdopted: the file that NAMED the app. It is where they used to be,
	// not where they are now.
	From string
	// FromSecret is the file the SECRET came from, set only when the pair was
	// assembled out of two different files — an app id in one and a secret in
	// the other, which is a pair to the bridge (config.loadDotEnv merges key by
	// key) and to nothing else. Empty means From held both halves.
	//
	// It exists because one field was measured to be a lie: with the id in
	// <stateDir>/.env and the secret in the repository .env, the run reported
	// that the credentials "were in <stateDir>/.env" and that it was copying
	// that file into itself, while the file that actually held the secret was
	// never mentioned.
	FromSecret string
	// EnvPath is where the credentials live now: <stateDir>/.env, mode 0600.
	EnvPath string
	// OpenID is the confirming user when the page told us who they were.
	OpenID string
}

// Result reports what happened, in enough detail for the CLI to print a
// checklist naming the exact remaining click.
type Result struct {
	Outcome Outcome
	AppID   string
	// AppName is the app's real name from bot/v3/info, empty when the lookup
	// failed. A caller that prints a name must print this one or none.
	AppName string
	// Origin says how this app was arrived at, so the caller can render each
	// path differently — above all, so that "created" is printed only when it
	// is OriginCreated.
	Origin Origin
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
	// A failure here is not proof of a broken capability. It was measured twice
	// on the SAME app: the E1 probe saw no callback in 120s, and a later run saw
	// the press arrive and the round trip complete. An app configured through the
	// confirmation page therefore HAS a working card path, and an un-pressed
	// button is the likeliest cause — see Origin.PageConfigured, which is what
	// decides whether the checklist hedges about the 交互卡片 toggle, and which a
	// caller rendering its own hedge must call rather than re-derive.
	CardOK bool
	// Reused is true when usable credentials already existed anywhere the bridge
	// loads them, i.e. for OriginReused and OriginAdopted. Origin is the finer
	// statement and the one to render from.
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
	//
	// It is NOT returned merely because credentials were found somewhere: those
	// are adopted and verified (see Origin). It survives as the .env write guard,
	// which refuses to point a file at a different app without being told to.
	ErrCredentialsExist = errors.New("credentials already exist; pass --reregister to create another app")
	// ErrAmbiguousApps means two files the bridge loads name two DIFFERENT apps
	// and there is no human to ask.
	//
	// This is the one genuine ambiguity in the whole flow, and it is answered
	// with a question when a human is present. Guessing which app a script meant
	// is worse than stopping: the wrong guess points the bridge at an app whose
	// bot the user has never messaged, and the symptom is silence.
	ErrAmbiguousApps = errors.New("two apps are configured on this machine and there is no terminal to ask which to use")
	// ErrMalformedAppID rejects a reuse target that cannot be an app id, before
	// any network call. Same shape internal/config enforces (cli_ + alphanumerics),
	// for the same reason: a secret pasted into the id field must not travel into
	// a console URL or a log line.
	ErrMalformedAppID = errors.New("that does not look like a Feishu app id (expected cli_...)")
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
	// Registered fires once an app was CREATED and its credentials are on disk.
	//
	// Only OriginCreated reaches it, because a caller cannot render this
	// callback without asserting a creation: the argument list carries no
	// origin, and the one implementation that exists prints "App <id> created."
	// Every other path is reported through Narrator.Configured, or, for a
	// Progress that does not implement Narrator, as Notes that say what is
	// actually known.
	Registered(appID, openID string)
	// AwaitInbound asked the human to message the bot. It is RETAINED so that
	// existing implementations still compile, and this package NO LONGER CALLS
	// IT on any path. Implement Narrator.AwaitMessage instead.
	//
	// The reason is its argument list: it carries no app, so the only sentence a
	// caller can write is one that names the bot from somewhere else. The one
	// implementation that exists names it from the AppPreset this package asks
	// the confirmation page to pre-fill — "the app you just confirmed (named
	// herdr-agent unless you changed the name on that page)" — which was
	// measured wrong twice over: the app was called herdr-agent-e1 while
	// bot/v3/info was already saying so, and the same sentence was reproduced on
	// the reuse path, which opens no confirmation page at all. Narrowing WHEN it
	// fired left the false sentence one line above the true one on the primary
	// path, so it now fires nowhere: a plain Progress gets the whole request —
	// the bot's real name, the DIRECT-message requirement and the countdown — as
	// Notes, one per line.
	AwaitInbound(d time.Duration)
	// AwaitCard asks the human to press the button.
	AwaitCard(d time.Duration)
	// Note is an intermediate observation worth printing.
	Note(msg string)
}

// Narrator is an OPTIONAL extension of Progress, for a caller that wants to
// render what this run actually established instead of the prose it could write
// without knowing it.
//
// It exists because the two facts that made setup lie are only knowable at run
// time — WHICH app is in use and how it got there, and what the bot is really
// called — while the sentences that got them wrong were compiled into the CLI.
// A Progress that implements Narrator receives Configured instead of Registered
// and Notes, and AwaitMessage in place of the Notes that would otherwise carry
// the wait request. It is the only way to render this package's two
// human-facing moments from facts rather than from prose written in advance.
type Narrator interface {
	Progress
	// Configured reports the app the run settled on, once its credentials are on
	// disk and before verification starts.
	//
	// A Narrator gets exactly one Configured per run, on every path. A plain
	// Progress gets Registered for OriginCreated — the one origin on which a
	// creation is provable — and Notes on every other path; it never gets both,
	// and on four of the five origins it gets neither callback.
	Configured(App)
	// AwaitMessage asks for the DIRECT message, naming the bot, and owns the
	// countdown. A group chat cannot complete verification: the chat it arrives
	// in becomes notify_chat_id, where agent screens get pushed.
	//
	// It replaces AwaitInbound on every path, including the retry waits, because
	// it is the only one of the two that is handed the app it is talking about.
	AwaitMessage(app App, d time.Duration)
}

// Prompter asks the human one question, on the terminal, and returns the line
// they typed.
//
// It is what turns the two dead ends this command used to have — "two files
// name two apps" and "nothing arrived in 150s" — into questions. A Runner
// without one (no terminal, or WithAssumeYes) never asks and never guesses: it
// fails with the explicit error instead, because picking an app on a script's
// behalf points the bridge at the wrong bot and the symptom is silence.
type Prompter interface {
	// Ask writes question and returns the answer with surrounding space
	// trimmed. An empty answer means the human pressed enter, which callers
	// treat as accepting the default named in the question.
	//
	// It must return an error rather than block forever when the input ends
	// (a closed stdin) or ctx is done.
	Ask(ctx context.Context, question string) (string, error)
}

// Runner performs the flow.
//
// Implementations must provide, in setup.go, exactly:
//
//	func New(stateDir string, p Progress, opts ...Option) (*Runner, error)
//	func (r *Runner) Run(ctx context.Context, reregister bool) (Result, error)
//	func WithClock(f func() time.Time) Option
//	func WithPrompter(p Prompter) Option
//	func WithAssumeYes(yes bool) Option
//	func WithReuseAppID(appID string) Option
//
// Run must be idempotent and re-runnable, and it must handle every state of the
// machine without a flag: credentials found anywhere the bridge loads them are
// adopted into <stateDir>/.env and verified, rather than reported as a conflict
// for the human to resolve by moving files around.
//
// Ordering is load-bearing, twice over. Discovery comes before any decision or
// any output, so the plan can be stated in one sentence instead of discovered
// halfway through and abandoned at a prompt. Credentials are written to disk the
// instant registration returns, BEFORE the WebSocket is started or anything is
// verified: if verification then fails the user still owns a usable
// configuration plus a checklist, rather than nothing.
type Option func(*Runner)

// Runner is the setup flow.
type Runner struct {
	stateDir string
	progress Progress
	now      func() time.Time

	// prompt asks the human the questions that are genuinely theirs. Nil means
	// non-interactive.
	prompt Prompter
	// assumeYes suppresses every question. It does NOT answer them: the run
	// fails with the explicit error, because the questions this package asks
	// have no safe default.
	assumeYes bool
	// reuseAppID pins the app to use. Empty means "work it out".
	reuseAppID string
}
