package setup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
)

// New builds a Runner that writes into stateDir and reports through p.
//
// It performs no I/O: nothing is created, locked or dialled until Run.
func New(stateDir string, p Progress, opts ...Option) (*Runner, error) {
	if strings.TrimSpace(stateDir) == "" {
		// Without this, setup would write .env and config.toml into whatever
		// directory it happened to be started from, and the bridge — which
		// reads ~/.herdr-agent — would never see either of them.
		return nil, fmt.Errorf("setup: no state directory given (use %s or config.DefaultDir)", config.StateDir)
	}
	if p == nil {
		// Every un-automatable step reaches the human through Progress. A run
		// with nowhere to report is a run that ends in silence.
		return nil, errors.New("setup: a Progress implementation is required")
	}
	r := &Runner{stateDir: stateDir, progress: p, now: time.Now}
	for _, o := range opts {
		if o != nil {
			o(r)
		}
	}
	if r.now == nil {
		r.now = time.Now
	}
	return r, nil
}

// WithClock replaces the clock used for the timestamps setup writes — the .env
// header and the card stamp.
//
// It deliberately does not affect how long anything waits: those bounds are
// wall-clock waits on a human, and a fake clock that shortened them would make
// a test pass while proving nothing about the real flow. Use the context's
// deadline for that.
func WithClock(f func() time.Time) Option {
	return func(r *Runner) {
		if f != nil {
			r.now = f
		}
	}
}

// WithPrompter replaces the terminal question-asker.
//
// Without it, Run uses stdin when stdin is a terminal and asks nothing at all
// when it is not. Supply one to own the presentation of the two questions this
// package asks, or to drive them in a test.
func WithPrompter(p Prompter) Option {
	return func(r *Runner) {
		if p != nil {
			r.prompt = p
		}
	}
}

// WithAssumeYes stops the run from ever asking a question.
//
// It does NOT answer them affirmatively, and the name is the CLI's convention
// rather than a promise: the two questions here are "which of these two apps
// did you mean" and "shall I keep waiting", and both have consequences a script
// cannot consent to on a human's behalf. Choosing the wrong app points the
// bridge at a bot the user has never messaged, and the symptom is silence. So
// this makes the run fail with the explicit error instead.
func WithAssumeYes(yes bool) Option {
	return func(r *Runner) { r.assumeYes = yes }
}

// WithReuseAppID pins the app to use.
//
// If a file the bridge loads already holds that app's secret, the run touches
// no confirmation page at all. If it does not — Feishu shows a secret once, so
// this is the normal case for an app created by hand in the console — the run
// opens the page for THAT app (Options.AppID, CreateOnly unset: the SDK's
// documented update flow), which re-grants our scopes, events and callbacks to
// it rather than leaving a second app behind.
func WithReuseAppID(appID string) Option {
	return func(r *Runner) { r.reuseAppID = strings.TrimSpace(appID) }
}

// acquireLock takes the bridge's single-instance lock. Behind a variable only
// so tests can prove the refusal path without racing a real bridge.
var acquireLock = func(dir string) (io.Closer, error) {
	l, err := bridge.AcquireInstanceLock(dir, bridge.WithLockLogger(
		slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
	))
	if err != nil {
		return nil, err
	}
	return releaseCloser(l.Release), nil
}

type releaseCloser func() error

func (f releaseCloser) Close() error { return f() }

// newCapture installs the stdout redirect for the duration of a run. Behind a
// variable so tests can assert what it captures — and so most tests can skip
// swapping a process-wide file handle they are not testing.
var newCapture = func() (*stdoutCapture, error) { return newStdoutCapture(os.Stderr) }

// Run performs the whole onboarding flow.
//
// The error return means "nothing usable came out of this": the preflight
// refused, registration failed, or credentials could not be written. Whenever
// credentials exist on disk it returns a nil error and a Result whose Outcome
// says how far the round trip got — a card that was never pressed is a
// checklist, not a failure, and callers must branch on Outcome rather than on
// err alone.
//
// While Run executes it redirects os.Stdout to os.Stderr, because two
// dependencies print there unconditionally and neither can be configured (see
// capture.go). The redirect is lifted around every Progress callback, so a CLI
// that prints from inside Progress — which is where all of its output belongs —
// is unaffected; anything it writes to stdout from another goroutine
// meanwhile lands on stderr.
//
// Ordering is the load-bearing part:
//
//	preflight (no network) → discover → decide and SAY SO → register → PERSIST → verify
//
// Discovery and the decision come before any output, so the run can state its
// plan in one sentence. The shape this replaced discovered a problem halfway
// through and abandoned the user at it, having already promised a link.
//
// Credentials go to disk the instant registration returns, before the WebSocket
// is dialled and before anything is verified. Feishu shows an app secret once
// and offers no deletion API for apps created this way, so a run that verified
// first and crashed would have burned a permanent app and lost its only secret.
func (r *Runner) Run(ctx context.Context, reregister bool) (Result, error) {
	if err := checkEnvOverride(); err != nil {
		return Result{}, err
	}
	if r.prompt == nil && !r.assumeYes {
		// Resolved here rather than in New, which promises to touch nothing
		// until Run. A terminal makes the difference between a question and a
		// refusal, so it is part of the preflight, not of construction.
		r.prompt = newTerminalPrompter()
	}
	// Before the lock, because the lock's own failure message is about locking:
	// a state directory nobody can write must be reported as what it is, in the
	// one command whose whole job is to put a secret in it.
	if err := ensureStateDir(r.stateDir); err != nil {
		return Result{}, err
	}

	// The lock is held for the WHOLE run, and it is correctness rather than
	// hygiene. Long-connection delivery is CLUSTER MODE — up to 50 connections
	// per app, events split randomly between them — so a setup probe running
	// next to a live bridge does not fail cleanly: it silently steals a random
	// share of the user's real messages, some of which are answers to an agent
	// that is waiting on one.
	lock, err := acquireLock(r.stateDir)
	if err != nil {
		if errors.Is(err, bridge.ErrAlreadyRunning) {
			return Result{}, fmt.Errorf("%w: %w", ErrBridgeRunning, err)
		}
		return Result{}, fmt.Errorf("setup: take the single-instance lock: %w", err)
	}
	defer func() { _ = lock.Close() }()

	capture, err := newCapture()
	if err != nil {
		// Degrade rather than fail: the cost is that the SDK's prints land on
		// stdout, which is untidy, not wrong.
		capture = nil
	}
	defer func() { _ = capture.Close() }()
	rep := &reporter{progress: r.progress, capture: capture}

	// PHASE 1 — discover every location the bridge would load credentials from,
	// then decide, then say what was decided. Nothing above this line printed
	// anything, and nothing here touches the network except the identity lookup
	// the two-app question cannot be asked without.
	d, err := r.discover()
	if err != nil {
		return Result{}, err
	}
	p, err := r.choose(ctx, rep, d, reregister)
	if err != nil {
		return Result{}, err
	}
	rep.note("%s", p.says)

	res, creds, con, err := r.establish(ctx, rep, p)
	if err != nil {
		return res, err
	}

	// PHASE 3 — ask Feishu what this app is CALLED, then narrate.
	//
	// Asking is the whole point: the alternative is repeating the name we asked
	// the confirmation page to pre-fill, which the human is free to change on
	// that page and did — the run that motivated this told its user to look for
	// "herdr-agent" while bot/v3/info had already answered "herdr-agent-e1".
	app := App{
		ID:      res.AppID,
		Origin:  res.Origin,
		EnvPath: envPath(r.stateDir),
		OpenID:  res.OpenID,
	}
	if res.Origin == OriginAdopted {
		app.From = p.app.Path
		if p.app.SecretPath != p.app.Path {
			// The two halves came from two files. Reporting only the id's file
			// attributes the secret to a file that never held it, which is the
			// one thing every sentence about credentials must get right.
			app.FromSecret = p.app.SecretPath
		}
	}
	name, problem := r.appName(ctx, rep, candidate{AppID: creds.AppID, Secret: creds.AppSecret})
	if name == "" {
		rep.note("Feishu would not say what app %s is called (%s), so nothing below guesses at its name.",
			creds.AppID, problem)
	}
	app.Name, res.AppName = name, name
	rep.configured(app)

	// PHASE 4 — verify. Success is a round trip and nothing less.
	v := r.verify(ctx, rep, verifyInput{
		creds:     creds,
		app:       app,
		allowed:   r.allowlist(rep, res.OpenID),
		console:   con,
		onInbound: func(openID, chatID string) { r.recordChat(rep, &res, openID, chatID) },
	})

	res.InboundOK, res.CardOK = v.InboundOK, v.CardOK
	if v.OpenID != "" {
		res.OpenID = v.OpenID
	}
	if v.ChatID != "" {
		res.ChatID = v.ChatID
	}
	res.Steps = append(res.Steps, v.Steps...)

	res.Steps = dedupeSteps(res.Steps)

	res.Outcome = OutcomeCredentials
	if v.InboundOK && v.CardOK {
		res.Outcome = OutcomeVerified
	}
	return res, nil
}

// dedupeSteps keeps the first of each identical step.
//
// The same manual action is reachable from two places — the allowlist is
// written once after registration and again when the first message arrives —
// and a checklist that says the same thing twice invites the reader to assume
// the second one is different and go looking for the difference.
func dedupeSteps(steps []Step) []Step {
	if len(steps) < 2 {
		return steps
	}
	seen := make(map[Step]bool, len(steps))
	out := steps[:0]
	for _, s := range steps {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// establish produces the usable app the plan named, persisted before this
// function returns.
//
// PHASE 2 of the run. Every branch ends with credentials in <stateDir>/.env and
// a Result whose Origin is what actually happened, not what was intended: the
// two are allowed to differ, and when they do it is the Origin that gets
// corrected, never the narration.
func (r *Runner) establish(ctx context.Context, rep *reporter, p plan) (Result, credentials, console, error) {
	switch p.kind {
	case planReuse, planAdopt:
		// The credentials are already good, which is what makes setup the
		// repair path as well as the install path: re-run it to find out which
		// of the six invisible things is broken.
		rep.useSecret(p.app.Secret)
		if p.kind == planAdopt {
			if err := r.adopt(rep, p); err != nil {
				return Result{Outcome: OutcomeFailed, AppID: p.app.AppID}, credentials{}, console{}, err
			}
		}
		// The tenant brand is only ever learned from the registration flow
		// (StatusDomainSwitched) and is not persisted, so on these paths every
		// console URL is a guess. Saying so costs one line; a Lark operator
		// following a checklist of links that 404 has no way back from it.
		rep.note("Console links below assume a Feishu tenant. On Lark, replace open.feishu.cn " +
			"with open.larksuite.com.")
		// Outcome is deliberately left at its zero value: Run sets it from what
		// verification observed, and this function has observed nothing yet.
		return Result{
			AppID:  p.app.AppID,
			Origin: p.origin(),
			Reused: true,
		}, p.app.creds(), console{appID: p.app.AppID}, nil
	}

	req := requestFor(p)

	regCtx, cancel := context.WithTimeout(ctx, RegisterTimeout)
	defer cancel()
	out, err := r.register(regCtx, rep, req)
	if err != nil {
		return Result{Outcome: OutcomeFailed}, credentials{}, console{}, err
	}
	// Armed before the first Progress call that could carry it.
	rep.useSecret(out.AppSecret)

	res := Result{AppID: out.AppID, OpenID: out.OpenID, Origin: p.origin()}
	if req.appID != "" && out.AppID != req.appID {
		// The page was opened for one app and came back with another. Whatever
		// the human did on it, "updated <that app>" is no longer true, and the
		// only honest thing left to say is what a page with no CreateOnly always
		// leaves us: it either created this one or handed back an existing one.
		rep.note("The confirmation page returned app %s, not the %s this run opened it for. Using %s.",
			out.AppID, req.appID, out.AppID)
		res.Origin = OriginRegistered
	}
	con := console{appID: out.AppID, lark: out.Lark}

	// Persist IMMEDIATELY, before anything that can fail.
	if err := writeCredentials(envPath(r.stateDir), out.credentials, r.now(), p.replace); err != nil {
		return Result{Outcome: OutcomeFailed, AppID: out.AppID, OpenID: out.OpenID, Origin: res.Origin},
			credentials{}, con,
			fmt.Errorf("setup: app %s is configured but its credentials could not be stored, and the "+
				"secret is not recoverable: %w", out.AppID, err)
	}
	if out.OpenID != "" {
		r.writeAllowlist(rep, &res, out.OpenID)
	} else {
		rep.note("Feishu did not return the confirming user's open_id; the allowlist will be taken " +
			"from the first message instead.")
	}
	return res, out.credentials, con, nil
}

// requestFor maps a plan to the confirmation-page flow it needs.
//
// The three are mutually exclusive on the platform side: with both CreateOnly
// and AppID set the page gives the create flow precedence, so a request to
// update one specific app would quietly become a new one.
func requestFor(p plan) registerRequest {
	switch p.kind {
	case planCreate:
		return registerRequest{createOnly: true}
	case planUpdate:
		return registerRequest{appID: p.app.AppID}
	default:
		return registerRequest{}
	}
}

// writeAllowlist adds openID to feishu.allowed_open_ids, creating config.toml
// from the shipped example if it does not exist yet.
func (r *Runner) writeAllowlist(rep *reporter, res *Result, openID string) {
	path := configPath(r.stateDir)
	untouched, err := updateConfig(path, openID, "")
	if err != nil {
		rep.note("Could not update %s: %s", path, rep.errText(err))
		res.Steps = append(res.Steps, stepManualFile(path,
			fmt.Sprintf("Add %q to feishu.allowed_open_ids in %s by hand.", openID, path),
			"Writing it automatically failed: "+rep.errText(err)+
				". Without it the bridge refuses every message, by design."))
		return
	}
	for _, key := range untouched {
		res.Steps = append(res.Steps, stepManualFile(path,
			fmt.Sprintf("Add %q to feishu.%s in %s by hand.", openID, key, path),
			"That key is spread over several lines, and rewriting it automatically risked "+
				"corrupting the one list that decides who can drive your agents."))
	}
}

// recordChat writes what the first accepted message taught us: the sender goes
// on the allowlist, the chat becomes notify_chat_id.
//
// It runs BEFORE the card half, so an interactive-card problem cannot cost the
// user the configuration the message already proved.
func (r *Runner) recordChat(rep *reporter, res *Result, openID, chatID string) {
	path := configPath(r.stateDir)
	untouched, err := updateConfig(path, openID, chatID)
	if err != nil {
		rep.note("Could not write notify_chat_id to %s: %s", path, rep.errText(err))
		res.Steps = append(res.Steps, stepManualFile(path,
			fmt.Sprintf("Set feishu.notify_chat_id = %q in %s by hand.", chatID, path),
			"Writing it automatically failed: "+rep.errText(err)+
				". Without it the bridge can still be driven, but it will never tell you an agent is waiting."))
		return
	}
	for _, key := range untouched {
		res.Steps = append(res.Steps, stepManualFile(path,
			fmt.Sprintf("Add %q to feishu.%s in %s by hand.", openID, key, path),
			"That key is spread over several lines, and rewriting it automatically risked "+
				"corrupting the one list that decides who can drive your agents."))
	}
}

// allowlist decides who may complete the verification.
//
// After a registration that is the confirming user and nobody else. On the
// repair path it is whatever config.toml already says, so that re-running setup
// verifies the configured owner's round trip rather than whoever happens to
// message first.
func (r *Runner) allowlist(rep *reporter, openID string) []string {
	if openID != "" {
		return []string{openID}
	}
	cfg, err := config.Load(r.stateDir)
	if err != nil {
		// A config.toml the bridge will refuse to start on. Say so — it is the
		// next thing that would go wrong — and carry on: the line-based writes
		// this package does still work on a file that does not parse.
		rep.note("%s could not be parsed, which will also stop the bridge from starting: %s",
			configPath(r.stateDir), rep.errText(err))
		return nil
	}
	return cfg.Feishu.AllowedOpenIDs
}

// checkEnvOverride refuses to run while the credentials are exported.
//
// internal/config prefers the process environment over the .env file, and
// treats a variable that is present but EMPTY as set — so a stale `export
// FEISHU_APP_ID=` in a shell profile silently defeats everything this command
// writes. The user would then be debugging a bridge that is authenticating with
// credentials they cannot see, which is the most expensive kind of wrong.
//
// The value is never printed. Naming the variable is enough to act on, and
// FEISHU_APP_SECRET is the one string in this program that must not be echoed.
func checkEnvOverride() error {
	var set []string
	for _, key := range []string{config.EnvAppID, config.EnvAppSecret} {
		if _, ok := os.LookupEnv(key); ok {
			set = append(set, key)
		}
	}
	if len(set) == 0 {
		return nil
	}
	return fmt.Errorf("%w: %s is exported in this shell (an empty value counts, and beats the file); "+
		"unset it and run setup again", ErrEnvOverride, strings.Join(set, " and "))
}
