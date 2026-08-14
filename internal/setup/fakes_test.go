package setup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

// The credentials used throughout the tests. The secret is a distinctive
// literal so that "does this string appear anywhere it must not" is a question
// with an unambiguous answer.
const (
	testAppID  = "cli_a1b2c3d4e5f6g7h8"
	testSecret = "SeCrEtVaLuE-must-never-be-printed-0123456789"
	testOpenID = "ou_1111111111111111111111111111abcd"
	testChatID = "oc_2222222222222222222222222222ef01"
)

// call is one Progress callback, flattened so a test can search every argument
// of every call for a string that must not be there.
type call struct {
	Method string
	Args   []any
	// Stdout is os.Stdout as seen from inside the callback. The run redirects
	// stdout for the SDK's benefit and must lift that redirect around every
	// Progress call, or the CLI's own output — the confirmation URL above all —
	// disappears into it.
	Stdout *os.File
}

type fakeProgress struct {
	mu    sync.Mutex
	calls []call
}

func (p *fakeProgress) record(method string, args ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, call{Method: method, Args: args, Stdout: os.Stdout})
}

func (p *fakeProgress) Verification(url string, expiresIn int) {
	p.record("Verification", url, expiresIn)
}
func (p *fakeProgress) Registered(appID, openID string) { p.record("Registered", appID, openID) }
func (p *fakeProgress) AwaitInbound(d time.Duration)    { p.record("AwaitInbound", d) }
func (p *fakeProgress) AwaitCard(d time.Duration)       { p.record("AwaitCard", d) }
func (p *fakeProgress) Note(msg string)                 { p.record("Note", msg) }

func (p *fakeProgress) snapshot() []call {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]call(nil), p.calls...)
}

// text renders every argument of every call as one searchable blob.
func (p *fakeProgress) text() string {
	var b strings.Builder
	for _, c := range p.snapshot() {
		b.WriteString(c.Method)
		for _, a := range c.Args {
			b.WriteString(" ")
			b.WriteString(strings.TrimSpace(strings.Join(strings.Fields(sprint(a)), " ")))
		}
		b.WriteString("\n")
	}
	return b.String()
}

func (p *fakeProgress) methods() []string {
	var out []string
	for _, c := range p.snapshot() {
		out = append(out, c.Method)
	}
	return out
}

func (p *fakeProgress) called(method string) bool {
	for _, c := range p.snapshot() {
		if c.Method == method {
			return true
		}
	}
	return false
}

func sprint(a any) string {
	switch v := a.(type) {
	case string:
		return v
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

// fakeBot stands in for the Feishu long connection.
type fakeBot struct {
	mu      sync.Mutex
	onMsg   func(context.Context, lark.Msg) error
	onAct   func(context.Context, lark.Action) error
	life    lark.Lifecycle
	sends   []lark.Out
	updates []string
	stopped bool

	// Behaviour, set by the test before Run.
	startErr  error         // Start returns this immediately instead of blocking
	deliver   []lark.Msg    // delivered as soon as Start runs
	pressCard bool          // press the sent card's button, with its real nonce
	pressWith string        // nonce to press with; empty means "the real one"
	operator  string        // who presses; defaults to testOpenID
	sendErr   error         // Send fails with this
	updateErr error         // UpdateCard fails with this
	endOnSend chan struct{} // non-nil: the connection dies when a card is sent
}

func (b *fakeBot) Start(ctx context.Context) error {
	if b.startErr != nil {
		return b.startErr
	}
	b.mu.Lock()
	h := b.onMsg
	msgs := append([]lark.Msg(nil), b.deliver...)
	ready := b.life.OnReady
	end := b.endOnSend // captured before Send can clear it
	b.mu.Unlock()

	if ready != nil {
		ready()
	}
	for _, m := range msgs {
		if h != nil {
			_ = h(ctx, m)
		}
	}

	select {
	case <-end: // nil unless the test asked for it; only ever closed by Send
		return errors.New("websocket closed by the peer")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *fakeBot) Stop(context.Context) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stopped = true
	return nil
}

func (b *fakeBot) OnMessage(h func(context.Context, lark.Msg) error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onMsg = h
}

func (b *fakeBot) OnCardAction(h func(context.Context, lark.Action) error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onAct = h
}

func (b *fakeBot) SetLifecycle(l lark.Lifecycle) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.life = l
}

func (b *fakeBot) Send(ctx context.Context, o lark.Out) (string, error) {
	b.mu.Lock()
	b.sends = append(b.sends, o)
	press, h, operator, nonce := b.pressCard, b.onAct, b.operator, b.pressWith
	err := b.sendErr
	end := b.endOnSend
	b.endOnSend = nil
	b.mu.Unlock()

	if err != nil {
		return "", err
	}
	if end != nil {
		close(end)
	}
	if press && h != nil {
		if nonce == "" {
			nonce = nonceOf(o.Card)
		}
		if operator == "" {
			operator = testOpenID
		}
		_ = h(ctx, lark.Action{
			EventID:   "evt_card",
			MessageID: "om_card",
			ChatID:    o.ChatID,
			Operator:  operator,
			Value:     map[string]any{"act": actVerify, "n": nonce},
		})
	}
	return "om_card", nil
}

func (b *fakeBot) UpdateCard(_ context.Context, messageID, cardJSON string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.updates = append(b.updates, messageID+" "+cardJSON)
	return b.updateErr
}

func (b *fakeBot) Stream(context.Context, lark.Out) (lark.Stream, error) {
	return nil, errors.New("stream is not used by setup")
}

func (b *fakeBot) BotOpenID(context.Context) string { return "ob_bot" }

func (b *fakeBot) sent() []lark.Out {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]lark.Out(nil), b.sends...)
}

func (b *fakeBot) updated() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.updates...)
}

// nonceOf digs the button's nonce out of a rendered card.
func nonceOf(cardJSON string) string {
	var card struct {
		Body struct {
			Elements []struct {
				Columns []struct {
					Elements []struct {
						Behaviors []struct {
							Value struct {
								Nonce string `json:"n"`
							} `json:"value"`
						} `json:"behaviors"`
					} `json:"elements"`
				} `json:"columns"`
			} `json:"elements"`
		} `json:"body"`
	}
	if err := json.Unmarshal([]byte(cardJSON), &card); err != nil {
		return ""
	}
	for _, e := range card.Body.Elements {
		for _, c := range e.Columns {
			for _, el := range c.Elements {
				for _, bh := range el.Behaviors {
					if bh.Value.Nonce != "" {
						return bh.Value.Nonce
					}
				}
			}
		}
	}
	return ""
}

// syncBuffer is a bytes.Buffer that survives being written by the capture's
// forwarder goroutine while a test reads it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// --- seams -----------------------------------------------------------------

// stubRegister replaces the SDK entry point for one test.
func stubRegister(t *testing.T, f func(context.Context, *registration.Options) (*registration.RegisterAppResult, error)) {
	t.Helper()
	prev := registerApp
	registerApp = f
	t.Cleanup(func() { registerApp = prev })
}

// okRegister is the measured happy path: the page hands back an app plus the
// confirming user's open_id.
func okRegister(t *testing.T) {
	t.Helper()
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://accounts.feishu.cn/open-apis/...", ExpireIn: 600})
		return &registration.RegisterAppResult{
			ClientID:     testAppID,
			ClientSecret: testSecret,
			UserInfo:     &registration.UserInfo{OpenID: testOpenID, TenantBrand: "feishu"},
		}, nil
	})
}

// noRegister fails the test if registration is attempted at all.
func noRegister(t *testing.T) {
	t.Helper()
	stubRegister(t, func(context.Context, *registration.Options) (*registration.RegisterAppResult, error) {
		t.Error("registration was attempted; valid credentials were already on disk")
		return nil, errors.New("must not be called")
	})
}

func stubBot(t *testing.T, b *fakeBot) *fakeBot {
	t.Helper()
	prev := newBot
	newBot = func(appID, appSecret string) (lark.Bot, error) {
		if appID == "" || appSecret == "" {
			t.Errorf("bot built with empty credentials: appID=%q secret set=%v", appID, appSecret != "")
		}
		return b, nil
	}
	t.Cleanup(func() { newBot = prev })
	return b
}

// noCapture skips the process-wide stdout swap. Every test that is not about
// the capture uses it: swapping os.Stdout in a test that fails elsewhere would
// take the test binary's own output with it.
func noCapture(t *testing.T) {
	t.Helper()
	prev := newCapture
	newCapture = func() (*stdoutCapture, error) { return nil, nil }
	t.Cleanup(func() { newCapture = prev })
}

// captureInto routes the run's stdout redirect into buf.
func captureInto(t *testing.T, buf *syncBuffer) {
	t.Helper()
	prev := newCapture
	newCapture = func() (*stdoutCapture, error) { return newStdoutCapture(buf) }
	t.Cleanup(func() { newCapture = prev })
}

// stubRepoEnv replaces the repository-root .env lookup for one test.
//
// Every Run test needs it: this package's tests run with their working
// directory inside a checkout that HAS a .env naming an app, so the real
// lookup would refuse every registration with ErrCredentialsExist. That is not
// a testing inconvenience, it is the hazard the guard exists for, reproduced.
func stubRepoEnv(t *testing.T, c credentials, path string) {
	t.Helper()
	prev := repoEnvCredentials
	repoEnvCredentials = func() (credentials, string) { return c, path }
	t.Cleanup(func() { repoEnvCredentials = prev })
}

// clearCredEnv removes exported credentials for the duration of a test.
// Without it, a developer with FEISHU_APP_ID in their shell would see every
// Run test fail with ErrEnvOverride — which is, at least, the check working.
func clearCredEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{config.EnvAppID, config.EnvAppSecret} {
		if v, ok := os.LookupEnv(key); ok {
			os.Unsetenv(key)
			t.Cleanup(func() { os.Setenv(key, v) })
		}
	}
}

// newRun assembles a Runner over a temp state directory with every seam stubbed.
func newRun(t *testing.T, bot *fakeBot) (*Runner, *fakeProgress, string) {
	t.Helper()
	clearCredEnv(t)
	noCapture(t)
	stubRepoEnv(t, credentials{}, "")
	dir := t.TempDir()
	p := &fakeProgress{}
	if bot != nil {
		stubBot(t, bot)
	}
	r, err := New(dir, p, WithClock(func() time.Time {
		return time.Date(2026, 8, 14, 10, 30, 0, 0, time.UTC)
	}))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return r, p, dir
}

// p2p is the message a human sends the bot to complete verification.
func p2p(text string) lark.Msg {
	return lark.Msg{
		EventID:   "evt_msg",
		MessageID: "om_msg",
		ChatID:    testChatID,
		ChatType:  lark.ChatP2P,
		UserID:    testOpenID,
		Text:      text,
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(data)
}
