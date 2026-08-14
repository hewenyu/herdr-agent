package setup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

// App identity offered on the confirmation page. The human can edit both
// before confirming, so these are a starting point, not a guarantee.
const (
	appName = "herdr-agent"
	appDesc = "把这台 Mac 上 coding agent 的授权请求推到飞书，手机上点一下就能接管。"
	// sourceTag reaches the platform as source=go-sdk/herdr-agent. It is the
	// only marker distinguishing our registrations from any other SDK user's.
	sourceTag = "herdr-agent"
)

// registerAttempts bounds how many times a human is asked to open a fresh link.
//
// Each retry costs a rescan, because the SDK owns the device code and offers no
// way to resume a flow whose poll failed: RegisterApp is begin+poll in one call
// (registration.go:41-154) and returns on the first transport error
// (registration.go:96-99). Three is enough to survive a blip and few enough
// that a genuinely broken network gives up before the human does.
const registerAttempts = 3

// beginTimeout bounds the wait for the first sign of life from the endpoint.
//
// The SDK uses http.DefaultClient directly (registration.go:201), which has no
// timeout of its own, so a black-holed connection would otherwise sit there for
// the entire RegisterTimeout with nothing on screen. Once the confirmation URL
// has been handed over, the wait belongs to the human and this watchdog
// disarms.
var beginTimeout = 30 * time.Second

// minRetryBudget is how much of the run must be left for a fresh confirmation
// link to be worth opening.
//
// The platform expires its link at ~600s and RegisterTimeout is 720s, so an
// attempt that ran all the way to expiry leaves about 120s. Handing the human a
// new link with ExpireIn=600 and then tripping our own deadline two minutes
// later turns one actionable sentence into `context deadline exceeded` — a bare
// Go error, on the first command a new user ever runs, seconds after being told
// to scan something.
const minRetryBudget = 2 * time.Minute

// registerApp is the SDK entry point, behind a variable so the whole flow can
// be driven in tests without a network. The device-authorization endpoint is
// undocumented — it appears nowhere on open.feishu.cn, and archetype=
// PersonalAgent appears exactly once in the entire SDK — so a test that hit it
// for real would be testing something that can change without notice.
var registerApp = registration.RegisterApp

// registered is what a successful registration produced.
type registered struct {
	credentials
	// OpenID is the confirming user. It is the allowlist, so an empty one is a
	// degraded but not fatal result: verification learns it from the first
	// inbound message instead.
	OpenID string
	// Lark reports an international tenant, which changes the console host in
	// every step we print afterwards.
	Lark bool
}

// failureKind classifies why an attempt ended, because the four cases need four
// different things from the human.
type failureKind int

const (
	// failTransient: the network or an intermediary broke. Retry costs a rescan.
	failTransient failureKind = iota
	// failDenied: the human pressed 拒绝 on the confirmation page.
	failDenied
	// failExpired: the link went stale; the platform expires it in ~600s.
	failExpired
	// failFatal: the platform refused in a way retrying cannot fix.
	failFatal
	// failAborted: our own context ended — the caller cancelled, or the overall
	// RegisterTimeout elapsed.
	failAborted
)

// register runs the device-authorization flow until it produces credentials or
// runs out of attempts.
func (r *Runner) register(ctx context.Context, rep *reporter) (registered, error) {
	var lastErr error

	for attempt := 1; attempt <= registerAttempts; attempt++ {
		res, lark, err := registerOnce(ctx, rep)
		if err == nil {
			out := registered{
				credentials: credentials{AppID: res.ClientID, AppSecret: res.ClientSecret},
				Lark:        lark,
			}
			if res.UserInfo != nil {
				out.OpenID = res.UserInfo.OpenID
			}
			if !out.complete() {
				// The SDK only returns when both are non-empty, so this is a
				// contract violation rather than a user-visible condition; it
				// must still never become a .env with half a credential in it.
				return registered{}, fmt.Errorf("setup: registration returned an incomplete credential pair")
			}
			return out, nil
		}
		lastErr = err

		switch classify(ctx, err) {
		case failAborted:
			return registered{}, fmt.Errorf("setup: registration did not finish: %w", err)
		case failFatal:
			return registered{}, fmt.Errorf("setup: registration was refused: %w", err)
		case failDenied:
			if attempt == registerAttempts {
				return registered{}, fmt.Errorf("setup: registration was declined on the confirmation page: %w", err)
			}
			if e := outOfBudget(ctx, err); e != nil {
				return registered{}, e
			}
			rep.note("The confirmation page was declined. Opening a fresh link — press 确认 on it; " +
				"the previous link is dead and cannot be reused.")
		case failExpired:
			if attempt == registerAttempts {
				return registered{}, fmt.Errorf("setup: the confirmation link expired before it was confirmed: %w", err)
			}
			if e := outOfBudget(ctx, err); e != nil {
				return registered{}, e
			}
			rep.note("The confirmation link expired (the platform gives it about 10 minutes). " +
				"Opening a fresh one.")
		default: // failTransient
			if attempt == registerAttempts {
				return registered{}, fmt.Errorf("setup: registration failed to reach Feishu: %w", err)
			}
			if e := outOfBudget(ctx, err); e != nil {
				return registered{}, e
			}
			rep.note("Registration lost contact with Feishu (%s). Retrying with a NEW link — "+
				"the one above is dead, because the SDK holds the device code and cannot resume a flow.",
				rep.errText(err))
		}

		if err := ctx.Err(); err != nil {
			return registered{}, fmt.Errorf("setup: registration did not finish: %w", err)
		}
	}

	return registered{}, fmt.Errorf("setup: registration failed after %d attempts: %w", registerAttempts, lastErr)
}

// outOfBudget refuses to open a confirmation link there is not enough time left
// to confirm. It returns nil when a retry is still worth offering.
//
// A promise we cannot keep is worse than a refusal: the alternative is showing a
// fresh 10-minute link and then failing with a raw context error before the
// human has finished reading it (see minRetryBudget).
func outOfBudget(ctx context.Context, err error) error {
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) >= minRetryBudget {
		return nil
	}
	return fmt.Errorf("setup: the confirmation attempt ended before it was confirmed, and there is not "+
		"enough time left in this run to open another link; run `herdr-agent setup` again: %w", err)
}

// registerOnce performs one whole device-authorization flow.
func registerOnce(ctx context.Context, rep *reporter) (*registration.RegisterAppResult, bool, error) {
	attemptCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var (
		once     sync.Once
		gotQR    = make(chan struct{})
		larkMu   sync.Mutex
		isLark   bool
		watchdog sync.WaitGroup
	)

	opts := &registration.Options{
		Source:    sourceTag,
		AppPreset: &registration.AppPreset{Name: appName, Desc: appDesc},
		// Preset is left nil: the platform default template. It is what the
		// measured run used, and that run produced an app whose bot capability
		// was already enabled and whose version was already published. The
		// minimal base template (Preset false) would show the human a shorter
		// list, and might well produce an app with no bot at all — which is the
		// one failure this whole command exists to prevent.
		Addons: &registration.AppAddons{
			Scopes:    registration.AppAddonsScopes{Tenant: Scopes},
			Events:    registration.AppAddonsEvents{Items: registration.AppAddonsEventItems{Tenant: Events}},
			Callbacks: registration.AppAddonsCallbacks{Items: Callbacks},
		},
		OnQRCode: func(info *registration.QRCodeInfo) {
			if info == nil {
				return
			}
			once.Do(func() { close(gotQR) })
			rep.verification(info.URL, info.ExpireIn)
		},
		OnStatusChange: func(info *registration.StatusChangeInfo) {
			if info == nil {
				return
			}
			switch info.Status {
			case registration.StatusSlowDown:
				// Worth saying: the platform asked us to back off, so the next
				// few seconds of silence are expected rather than a hang.
				rep.note("Feishu asked us to poll more slowly; waiting %ds between checks.", info.Interval)
			case registration.StatusDomainSwitched:
				larkMu.Lock()
				isLark = true
				larkMu.Unlock()
				rep.note("This is a Lark tenant; continuing on accounts.larksuite.com.")
			}
			// StatusPolling is deliberately not reported: it fires on every
			// poll, and a line every five seconds is noise, not progress.
		},
	}

	// Watchdog for the begin request only (see beginTimeout).
	watchdog.Add(1)
	go func() {
		defer watchdog.Done()
		timer := time.NewTimer(beginTimeout)
		defer timer.Stop()
		select {
		case <-gotQR:
		case <-attemptCtx.Done():
		case <-timer.C:
			cancel()
		}
	}()

	res, err := registerApp(attemptCtx, opts)
	cancel()
	watchdog.Wait()

	larkMu.Lock()
	lark := isLark
	larkMu.Unlock()

	if err != nil {
		return nil, lark, err
	}
	if res == nil {
		return nil, lark, errors.New("setup: registration returned no result")
	}
	return res, lark, nil
}

// classify decides what an attempt's error means.
//
// The order is load-bearing. Expiry reaches us as EITHER a typed
// *registration.ExpiredError or a bare wrapped context.DeadlineExceeded,
// depending on whether the platform's own deadline tripped while the SDK was
// sleeping between polls or while a request was in flight
// (registration.go:82-92), so the typed checks have to run before the context
// ones — and our own cancellation has to be recognised before either, or a
// caller's Ctrl-C would be reported to them as "the link expired".
//
// Note that AccessDeniedError and ExpiredError embed *RegisterAppError by
// value-less embedding and implement no Unwrap, so errors.As for the base type
// does NOT match them. They must be tested for first.
func classify(ctx context.Context, err error) failureKind {
	if ctx.Err() != nil {
		return failAborted
	}

	var denied *registration.AccessDeniedError
	if errors.As(err, &denied) {
		return failDenied
	}
	var expired *registration.ExpiredError
	if errors.As(err, &expired) {
		return failExpired
	}

	var base *registration.RegisterAppError
	if errors.As(err, &base) {
		switch base.Code {
		case "access_denied":
			return failDenied
		case "expired_token":
			return failExpired
		case "invalid_response":
			// The endpoint answered with something structurally wrong — an
			// empty body, or a payload missing device_code. An intermediary
			// having a bad minute looks exactly like this.
			return failTransient
		default:
			return failFatal
		}
	}

	// The SDK never checks the HTTP status (registration.go:201-220), so a 502
	// HTML error page from a proxy arrives here as a JSON decode failure. That
	// is a transport problem wearing a parser's clothes; matching the error
	// TYPE rather than the message keeps this from depending on the wording of
	// the SDK's fmt.Errorf.
	var syntaxErr *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &syntaxErr) || errors.As(err, &typeErr) {
		return failTransient
	}

	if errors.Is(err, context.DeadlineExceeded) {
		// Our own context is fine (checked above), so this deadline is the
		// platform's ~600s expiry, tripped inside the SDK's poll wait.
		return failExpired
	}
	// Either the begin watchdog fired or the transport failed; both mean the
	// same thing to the human: nothing is coming, take a fresh link.
	return failTransient
}
