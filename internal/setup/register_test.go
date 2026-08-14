package setup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

// newRegisterRun builds just enough Runner to drive the registration half.
func newRegisterRun(t *testing.T) (*Runner, *fakeProgress, *reporter) {
	t.Helper()
	r, p, _ := newRun(t, nil)
	return r, p, &reporter{progress: p}
}

// TestClassifyRecognisesEveryShapeExpiryArrivesIn.
//
// Expiry reaches us as a typed *ExpiredError when the platform says so, and as
// a bare wrapped context.DeadlineExceeded when the SDK's own poll deadline
// trips first (registration.go:82-92). Confusing the two for a cancellation
// would tell a user who pressed Ctrl-C that their link expired.
func TestClassifyRecognisesEveryShapeExpiryArrivesIn(t *testing.T) {
	live := context.Background()
	dead, cancel := context.WithCancel(context.Background())
	cancel()

	cases := []struct {
		name string
		ctx  context.Context
		err  error
		want failureKind
	}{
		{"our own context ended", dead, errors.New("anything"), failAborted},
		{"typed access denied", live,
			&registration.AccessDeniedError{RegisterAppError: &registration.RegisterAppError{Code: "access_denied"}},
			failDenied},
		{"typed expiry", live,
			&registration.ExpiredError{RegisterAppError: &registration.RegisterAppError{Code: "expired_token"}},
			failExpired},
		{"bare expiry code", live, &registration.RegisterAppError{Code: "expired_token"}, failExpired},
		{"bare denial code", live, &registration.RegisterAppError{Code: "access_denied"}, failDenied},
		{"empty or malformed response", live, &registration.RegisterAppError{Code: "invalid_response"}, failTransient},
		{"an error we do not understand", live, &registration.RegisterAppError{Code: "unsupported_grant"}, failFatal},
		{"deadline from inside the SDK", live,
			fmt.Errorf("registration: %w", context.DeadlineExceeded), failExpired},
		{"an HTML error page from a proxy", live,
			fmt.Errorf("registration: decode response failed: %w",
				&json.SyntaxError{Offset: 1}), failTransient},
		{"a dropped connection", live,
			fmt.Errorf("post: %w", &net.OpError{Op: "dial", Err: errors.New("connection refused")}),
			failTransient},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classify(tc.ctx, tc.err); got != tc.want {
				t.Errorf("classify = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestTransportErrorRetriesWithAFreshLink.
//
// The SDK owns the device code and returns on the first transport error
// (registration.go:96-99), so there is no way to resume the flow: retrying
// means a new link and a new scan. Doing it silently would leave the user
// staring at a dead QR code.
func TestTransportErrorRetriesWithAFreshLink(t *testing.T) {
	r, p, rep := newRegisterRun(t)

	attempts := 0
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		attempts++
		o.OnQRCode(&registration.QRCodeInfo{URL: fmt.Sprintf("https://example.invalid/link-%d", attempts), ExpireIn: 600})
		if attempts == 1 {
			return nil, &net.OpError{Op: "read", Err: errors.New("connection reset by peer")}
		}
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})

	out, err := r.register(context.Background(), rep, registerRequest{})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts = %d, want 2", attempts)
	}
	if out.AppID != testAppID || out.OpenID != testOpenID {
		t.Errorf("result = %+v", out)
	}

	urls := 0
	for _, c := range p.snapshot() {
		if c.Method == "Verification" {
			urls++
		}
	}
	if urls != 2 {
		t.Errorf("the human was shown %d links for 2 attempts", urls)
	}
	if !strings.Contains(p.text(), "NEW link") {
		t.Errorf("the retry was not explained; the first link is dead:\n%s", p.text())
	}
}

// TestDenialAndExpiryAreDistinguished. Both need a fresh link, but only one of
// them means the human has to press a different button this time.
func TestDenialAndExpiryAreDistinguished(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"declined", &registration.AccessDeniedError{
			RegisterAppError: &registration.RegisterAppError{Code: "access_denied"}}, "declined"},
		{"expired", &registration.ExpiredError{
			RegisterAppError: &registration.RegisterAppError{Code: "expired_token"}}, "expired"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, p, rep := newRegisterRun(t)
			attempts := 0
			stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
				attempts++
				o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
				if attempts == 1 {
					return nil, tc.err
				}
				return &registration.RegisterAppResult{
					ClientID: testAppID, ClientSecret: testSecret,
					UserInfo: &registration.UserInfo{OpenID: testOpenID},
				}, nil
			})

			if _, err := r.register(context.Background(), rep, registerRequest{}); err != nil {
				t.Fatalf("register: %v", err)
			}
			if !strings.Contains(strings.ToLower(p.text()), tc.want) {
				t.Errorf("the note does not say %q:\n%s", tc.want, p.text())
			}
		})
	}
}

// TestPersistentFailureGivesUpAndSaysWhy rather than asking forever.
func TestPersistentFailureGivesUpAndSaysWhy(t *testing.T) {
	r, _, rep := newRegisterRun(t)
	attempts := 0
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		attempts++
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return nil, &registration.ExpiredError{
			RegisterAppError: &registration.RegisterAppError{Code: "expired_token", Description: "registration expired"}}
	})

	_, err := r.register(context.Background(), rep, registerRequest{})
	if err == nil {
		t.Fatal("register succeeded with an always-expiring link")
	}
	if attempts != registerAttempts {
		t.Errorf("attempts = %d, want %d", attempts, registerAttempts)
	}
	if !strings.Contains(err.Error(), "expired") {
		t.Errorf("the error does not name the cause: %v", err)
	}
}

// TestAFreshLinkIsNotOfferedWithoutTimeToUseIt.
//
// The platform expires its link at ~600s and RegisterTimeout is 720s, so an
// attempt that ran to expiry leaves about 120s. Showing a new 10-minute link and
// then tripping our own deadline hands a new user `context deadline exceeded`
// on the first command they ever run, seconds after being told to scan.
func TestAFreshLinkIsNotOfferedWithoutTimeToUseIt(t *testing.T) {
	r, p, rep := newRegisterRun(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	attempts := 0
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		attempts++
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return nil, &registration.ExpiredError{
			RegisterAppError: &registration.RegisterAppError{Code: "expired_token"}}
	})

	_, err := r.register(ctx, rep, registerRequest{})
	if err == nil {
		t.Fatal("register reported success")
	}
	if attempts != 1 {
		t.Errorf("attempts = %d; a link nobody has time to confirm must not be opened", attempts)
	}
	if !strings.Contains(err.Error(), "herdr-agent setup") {
		t.Errorf("the error does not name the next action: %v", err)
	}
	if strings.Contains(p.text(), "Opening a fresh one") {
		t.Errorf("a fresh link was promised anyway:\n%s", p.text())
	}
}

// TestRetriesStillHappenWithBudgetLeft: the refusal above must not become a
// blanket ban on the retry that survives a network blip.
func TestRetriesStillHappenWithBudgetLeft(t *testing.T) {
	r, _, rep := newRegisterRun(t)
	ctx, cancel := context.WithTimeout(context.Background(), RegisterTimeout)
	defer cancel()

	attempts := 0
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		attempts++
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		if attempts == 1 {
			return nil, &registration.ExpiredError{
				RegisterAppError: &registration.RegisterAppError{Code: "expired_token"}}
		}
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})

	if _, err := r.register(ctx, rep, registerRequest{}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts = %d, want 2", attempts)
	}
}

// TestAFatalRefusalIsNotRetried: asking a human to scan twice more for an error
// no rescan can fix is worse than stopping.
func TestAFatalRefusalIsNotRetried(t *testing.T) {
	r, _, rep := newRegisterRun(t)
	attempts := 0
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		attempts++
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return nil, &registration.RegisterAppError{Code: "unsupported_archetype", Description: "no"}
	})

	if _, err := r.register(context.Background(), rep, registerRequest{}); err == nil {
		t.Fatal("a fatal refusal was reported as success")
	}
	if attempts != 1 {
		t.Errorf("attempts = %d, want 1", attempts)
	}
}

// TestBeginWatchdogCancelsAHangingRequest.
//
// The SDK dials with http.DefaultClient, which has no timeout of its own
// (registration.go:201). Without this watchdog a black-holed connection would
// hold the whole RegisterTimeout with nothing on screen.
func TestBeginWatchdogCancelsAHangingRequest(t *testing.T) {
	prev := beginTimeout
	beginTimeout = 20 * time.Millisecond
	t.Cleanup(func() { beginTimeout = prev })

	r, _, rep := newRegisterRun(t)
	attempts := 0
	stubRegister(t, func(ctx context.Context, _ *registration.Options) (*registration.RegisterAppResult, error) {
		attempts++
		<-ctx.Done() // never reaches OnQRCode, exactly like a black hole
		return nil, ctx.Err()
	})

	done := make(chan error, 1)
	go func() {
		_, err := r.register(context.Background(), rep, registerRequest{})
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a hanging endpoint was reported as success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("register did not give up; the watchdog never fired")
	}
	if attempts != registerAttempts {
		t.Errorf("attempts = %d, want %d — a hang is transient and worth retrying", attempts, registerAttempts)
	}
}

// TestCallerCancellationIsNotReportedAsExpiry.
func TestCallerCancellationIsNotReportedAsExpiry(t *testing.T) {
	r, _, rep := newRegisterRun(t)
	ctx, cancel := context.WithCancel(context.Background())
	attempts := 0
	stubRegister(t, func(ctx context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		attempts++
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		cancel()
		<-ctx.Done()
		return nil, ctx.Err()
	})

	_, err := r.register(ctx, rep, registerRequest{})
	if err == nil {
		t.Fatal("a cancelled registration reported success")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want it to wrap context.Canceled", err)
	}
	if attempts != 1 {
		t.Errorf("attempts = %d; a cancelled run must not open new links", attempts)
	}
}

// TestTheConfirmationPageIsAskedForExactlyWhatTheBridgeUses.
//
// The page shows this list to the human and GRANTS what it lists, so asking for
// authority the bridge never exercises both scares the reader and widens the
// blast radius of a leaked secret. application:application:* is absent on
// purpose: the v7 configuration API is not used at all.
func TestTheConfirmationPageIsAskedForExactlyWhatTheBridgeUses(t *testing.T) {
	r, _, rep := newRegisterRun(t)
	var got *registration.Options
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		got = o
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})

	if _, err := r.register(context.Background(), rep, registerRequest{}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if got == nil || got.Addons == nil {
		t.Fatal("no addons were sent; the page would grant nothing")
	}
	if !slices.Equal(got.Addons.Scopes.Tenant, Scopes) {
		t.Errorf("scopes = %v, want %v", got.Addons.Scopes.Tenant, Scopes)
	}
	if !slices.Equal(got.Addons.Events.Items.Tenant, Events) {
		t.Errorf("events = %v, want %v", got.Addons.Events.Items.Tenant, Events)
	}
	if !slices.Equal(got.Addons.Callbacks.Items, Callbacks) {
		t.Errorf("callbacks = %v, want %v", got.Addons.Callbacks.Items, Callbacks)
	}
	for _, s := range got.Addons.Scopes.Tenant {
		if strings.HasPrefix(s, "application:") {
			t.Errorf("scope %q was requested; the v7 configuration path is deliberately not used", s)
		}
	}
	if len(got.Addons.Scopes.User) != 0 {
		t.Errorf("user-identity scopes were requested: %v", got.Addons.Scopes.User)
	}
	if got.AppPreset == nil || got.AppPreset.Name != appName {
		t.Errorf("app preset = %+v, want the name pre-filled", got.AppPreset)
	}
	if got.Addons.Preset != nil {
		t.Error("Addons.Preset was set; the default template is what was measured to arrive " +
			"with the bot capability enabled")
	}
}

// TestALarkTenantGetsLarkConsoleURLs.
func TestALarkTenantGetsLarkConsoleURLs(t *testing.T) {
	r, _, rep := newRegisterRun(t)
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		o.OnStatusChange(&registration.StatusChangeInfo{Status: registration.StatusDomainSwitched})
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID, TenantBrand: "lark"},
		}, nil
	})

	out, err := r.register(context.Background(), rep, registerRequest{})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if !out.Lark {
		t.Fatal("the domain switch was not recorded; every step would point at the wrong console")
	}
	if host := (console{appID: testAppID, lark: true}).event(); !strings.Contains(host, "larksuite.com") {
		t.Errorf("event URL = %s", host)
	}
}

// TestPollingStatusIsNotReported: it fires every five seconds and says nothing.
func TestPollingStatusIsNotReported(t *testing.T) {
	r, p, rep := newRegisterRun(t)
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		for i := 0; i < 20; i++ {
			o.OnStatusChange(&registration.StatusChangeInfo{Status: registration.StatusPolling})
		}
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})

	if _, err := r.register(context.Background(), rep, registerRequest{}); err != nil {
		t.Fatalf("register: %v", err)
	}
	notes := 0
	for _, c := range p.snapshot() {
		if c.Method == "Note" {
			notes++
		}
	}
	if notes > 1 {
		t.Errorf("%d notes for a clean registration; polling must be silent:\n%s", notes, p.text())
	}
}
