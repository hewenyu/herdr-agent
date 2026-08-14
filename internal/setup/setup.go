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
//	preflight (no network) → register → PERSIST → verify
//
// Credentials go to disk the instant registration returns, before the WebSocket
// is dialled and before anything is verified. Feishu shows an app secret once
// and offers no deletion API for apps created this way, so a run that verified
// first and crashed would have burned a permanent app and lost its only secret.
func (r *Runner) Run(ctx context.Context, reregister bool) (Result, error) {
	if err := checkEnvOverride(); err != nil {
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

	res, creds, con, err := r.credentials(ctx, rep, reregister)
	if err != nil {
		return res, err
	}

	// PHASE 3 — verify. Success is a round trip and nothing less.
	v := r.verify(ctx, rep, verifyInput{
		creds:     creds,
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

// credentials produces a usable app: either the one already on disk, or a new
// one, persisted before this function returns.
func (r *Runner) credentials(ctx context.Context, rep *reporter, reregister bool) (Result, credentials, console, error) {
	var res Result

	path := envPath(r.stateDir)
	existing, err := readCredentials(path)
	if err != nil {
		return res, credentials{}, console{}, err
	}

	if existing.complete() && !reregister {
		// This is what makes setup the repair path as well as the install
		// path: the credentials are fine, so re-run it to find out which of the
		// six invisible things is broken.
		rep.useSecret(existing.AppSecret)
		rep.note("Credentials for app %s are already in %s; skipping registration and going "+
			"straight to verification. Pass --reregister to create a second app instead.",
			existing.AppID, path)
		// The tenant brand is only ever learned from the registration flow
		// (StatusDomainSwitched) and is not persisted, so on this path every URL
		// below is a guess. Saying so costs one line; a Lark operator following
		// a checklist of links that 404 has no way back from it.
		rep.note("Console links below assume a Feishu tenant. On Lark, replace open.feishu.cn " +
			"with open.larksuite.com.")
		res.Reused = true
		res.AppID = existing.AppID
		return res, existing, console{appID: existing.AppID}, nil
	}

	if existing.AppID != "" && !reregister {
		// Half a credential. Registering would create a permanent second app
		// and overwrite the id of one that already exists somewhere in the
		// tenant, so it is the caller's decision, not ours.
		return res, credentials{}, console{}, fmt.Errorf(
			"%w: %s names app %s but has no usable %s, and Feishu shows an app secret only once",
			ErrCredentialsExist, path, existing.AppID, config.EnvAppSecret)
	}

	if existing.AppID == "" && !reregister {
		// Nothing in the state directory, but the bridge ALSO reads the
		// repository-root .env, so "nothing here" is not "no app". The user
		// running setup as the documented repair path from inside a checkout is
		// exactly the one who hits this, and registering would leave them with a
		// permanent second app plus a state-directory file that silently shadows
		// the working one.
		if repo, repoPath := repoEnvCredentials(); repo.AppID != "" {
			return res, credentials{}, console{}, fmt.Errorf(
				"%w: %s already names app %s and the bridge loads that file too, so registering now "+
					"would create a second app that Feishu offers no way to delete — move it to %s, "+
					"or pass --reregister to create a second app on purpose",
				ErrCredentialsExist, repoPath, repo.AppID, path)
		}
	}

	// PHASE 1 — register.
	regCtx, cancel := context.WithTimeout(ctx, RegisterTimeout)
	defer cancel()
	out, err := r.register(regCtx, rep)
	if err != nil {
		return Result{Outcome: OutcomeFailed}, credentials{}, console{}, err
	}
	// Armed before the first Progress call that could carry it.
	rep.useSecret(out.AppSecret)

	res.AppID, res.OpenID = out.AppID, out.OpenID
	con := console{appID: out.AppID, lark: out.Lark}

	// PHASE 2 — persist IMMEDIATELY, before anything that can fail.
	if err := writeCredentials(path, out.credentials, r.now(), reregister); err != nil {
		return Result{Outcome: OutcomeFailed, AppID: out.AppID, OpenID: out.OpenID}, credentials{}, con,
			fmt.Errorf("setup: app %s was created but its credentials could not be stored, and the "+
				"secret is not recoverable: %w", out.AppID, err)
	}
	if out.OpenID != "" {
		r.writeAllowlist(rep, &res, out.OpenID)
	} else {
		rep.note("Feishu did not return the confirming user's open_id; the allowlist will be taken " +
			"from the first message instead.")
	}

	rep.registered(out.AppID, out.OpenID)
	return res, out.credentials, con, nil
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
