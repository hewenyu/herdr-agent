package bridge

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/lark"
)

// fullDeps is a Deps that New accepts, as the starting point for the
// subtractive tests below.
func fullDeps() Deps {
	return Deps{
		Bot:            newFakeBot(),
		Registry:       newFakeRegistry(),
		Controller:     &fakeController{},
		Extractor:      &fakeExtractor{},
		Resolver:       &fakeResolver{},
		Dedup:          newFakeDedup(),
		Routes:         newFakeRoutes(),
		Watcher:        newFakeWatcher(),
		AllowedOpenIDs: []string{testOwner},
		NotifyChatID:   testChat,
	}
}

func TestNewRejectsAMissingDependency(t *testing.T) {
	tests := []struct {
		name  string
		clear func(*Deps)
	}{
		{"Bot", func(d *Deps) { d.Bot = nil }},
		{"Registry", func(d *Deps) { d.Registry = nil }},
		{"Controller", func(d *Deps) { d.Controller = nil }},
		{"Extractor", func(d *Deps) { d.Extractor = nil }},
		{"Resolver", func(d *Deps) { d.Resolver = nil }},
		{"Dedup", func(d *Deps) { d.Dedup = nil }},
		{"Routes", func(d *Deps) { d.Routes = nil }},
		{"Watcher", func(d *Deps) { d.Watcher = nil }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := fullDeps()
			tt.clear(&d)

			b, err := New(d)
			if err == nil {
				t.Fatalf("New accepted a nil %s; the first inbound event would panic", tt.name)
			}
			if b != nil {
				t.Error("New returned a Bridge alongside an error")
			}
			if !errors.Is(err, ErrMissingDep) {
				t.Fatalf("err = %v, want ErrMissingDep", err)
			}
			if !strings.Contains(err.Error(), tt.name) {
				t.Errorf("error does not name the missing field: %v", err)
			}
		})
	}
}

// TestNewRejectsAnEmptyAllowlist is the security boundary of the product.
// Reading an unset allowlist as "allow everyone" would hand a shell to whoever
// finds the bot, because driving an agent is driving a terminal (G10).
func TestNewRejectsAnEmptyAllowlist(t *testing.T) {
	tests := []struct {
		name string
		ids  []string
		want error
	}{
		{"nil", nil, ErrEmptyAllowlist},
		{"empty", []string{}, ErrEmptyAllowlist},
		{"blank entry", []string{""}, ErrBlankOpenID},
		{"whitespace entry", []string{testOwner, "   "}, ErrBlankOpenID},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := fullDeps()
			d.AllowedOpenIDs = tt.ids

			if _, err := New(d); !errors.Is(err, tt.want) {
				t.Fatalf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

// TestNewCopiesTheAllowlist: Deps is a value but the slice inside it is not,
// and a caller that keeps a reference must not be able to widen the security
// boundary after construction.
func TestNewCopiesTheAllowlist(t *testing.T) {
	ids := []string{testOwner}
	d := fullDeps()
	d.AllowedOpenIDs = ids

	b, err := newBridge(d)
	if err != nil {
		t.Fatal(err)
	}
	ids[0] = testStranger

	if b.authorized(testStranger) {
		t.Fatal("mutating the caller's slice widened the allowlist")
	}
	if !b.authorized(testOwner) {
		t.Fatal("the configured open_id stopped being authorized")
	}
}

func TestNewFillsDefaults(t *testing.T) {
	d := fullDeps()
	d.QueueLimit = 0
	d.Now = nil

	b, err := newBridge(d)
	if err != nil {
		t.Fatal(err)
	}
	if b.deps.QueueLimit != DefaultQueueLimit {
		t.Errorf("QueueLimit = %d, want %d", b.deps.QueueLimit, DefaultQueueLimit)
	}
	if b.deps.Now == nil {
		t.Fatal("Now was left nil")
	}
	if got := b.now(); got.IsZero() {
		t.Error("the default clock returned the zero time")
	}
}

func TestNewKeepsAnExplicitQueueLimit(t *testing.T) {
	d := fullDeps()
	d.QueueLimit = 2

	b, err := newBridge(d)
	if err != nil {
		t.Fatal(err)
	}
	if b.deps.QueueLimit != 2 {
		t.Errorf("QueueLimit = %d, want 2", b.deps.QueueLimit)
	}
}

// TestNewWithoutANotifyChatStillBuilds: config.Validate does not require
// notify_chat_id, so New must not either — a bridge that only answers messages
// is a usable, if reduced, product. It must say so, though: silently never
// pushing anything looks exactly like a broken notifier.
func TestNewWithoutANotifyChatStillBuilds(t *testing.T) {
	var logged strings.Builder
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
	t.Cleanup(func() { slog.SetDefault(restore) })

	d := fullDeps()
	d.NotifyChatID = ""

	if _, err := New(d); err != nil {
		t.Fatalf("New: %v", err)
	}
	if !strings.Contains(logged.String(), "notify_chat_id") {
		t.Errorf("no warning about the missing notify chat; log was %q", logged.String())
	}
}

// TestRunRegistersHandlersBeforeStarting locks down the ordering the lark
// contract requires: the WebSocket delivers its backlog the instant it
// connects, so a handler registered after Start would miss it.
func TestRunRegistersHandlersBeforeStarting(t *testing.T) {
	h := newHarness(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- h.b.Run(ctx) }()

	select {
	case <-h.bot.started:
	case err := <-done:
		t.Fatalf("Run returned before Start: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("Start was never called")
	}

	if got := h.bot.handlersAtStart; got != 2 {
		t.Errorf("%d handlers were registered when Start ran, want 2 (message and card action)", got)
	}

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run: %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after the context was cancelled")
	}
}

func TestRunMayNotBeCalledTwice(t *testing.T) {
	h := newHarness(t)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.b.Run(ctx) }()
	<-h.bot.started

	if err := h.b.Run(context.Background()); !errors.Is(err, ErrRunOnce) {
		t.Fatalf("second Run = %v, want ErrRunOnce", err)
	}

	cancel()
	<-done
}

func TestRunReportsAFailedConnection(t *testing.T) {
	h := newHarness(t)
	boom := errors.New("websocket handshake failed")
	h.bot.startErr = boom

	err := h.b.Run(context.Background())
	if !errors.Is(err, boom) {
		t.Fatalf("Run = %v, want the Start error", err)
	}
}

// TestRunSetsTheLifecycleHooks: reconnect churn is the only local evidence of
// two instances sharing one app_id (G15), so it has to be logged somewhere.
func TestRunSetsTheLifecycleHooks(t *testing.T) {
	h := newHarness(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.b.Run(ctx) }()
	<-h.bot.started

	h.bot.mu.Lock()
	life := h.bot.life
	h.bot.mu.Unlock()

	for name, hook := range map[string]func(){
		"OnReady":        life.OnReady,
		"OnReconnecting": life.OnReconnecting,
		"OnReconnected":  life.OnReconnected,
		"OnDisconnected": life.OnDisconnected,
	} {
		if hook == nil {
			t.Errorf("lifecycle hook %s was not set", name)
			continue
		}
		hook()
	}
	if life.OnError == nil {
		t.Error("lifecycle hook OnError was not set")
	} else {
		life.OnError(errors.New("boom"))
	}

	cancel()
	<-done
}

// TestBridgeImplementsTheSinkInterface keeps the notifier wiring honest: the
// bridge is handed to notify.New as its Sink inside New.
func TestBridgeImplementsTheSinkInterface(t *testing.T) {
	h := newHarness(t)
	if h.b.notifier == nil {
		t.Fatal("New did not build a notifier")
	}
	var _ = []any{h.b.PushBlocked, h.b.PushDone, h.b.PushGone}
}

// TestFirstEventIsAnnouncedOnceAndOnlyOnce.
//
// The two halves are one behaviour: a connection that came up says nothing
// about whether events will arrive — an app with no published version, no
// subscribed event or the wrong delivery mode connects perfectly and then stays
// silent forever — so OnReady must not claim it works, and the line that DOES
// claim it must fire on the first event and never again. A line per event would
// be a log of the user's whole conversation.
func TestFirstEventIsAnnouncedOnceAndOnlyOnce(t *testing.T) {
	h := newHarness(t)
	var logged safeBuffer
	h.b.log = slog.New(slog.NewTextHandler(&logged, nil))
	h.b.installHandlers()

	msg, act := h.bot.handlers()
	if msg == nil || act == nil {
		t.Fatal("installHandlers did not register both handlers")
	}

	// The connection comes up first, and says only what it knows.
	h.b.lifecycle().OnReady()
	if got := logged.String(); strings.Contains(got, "first feishu event") {
		t.Errorf("connecting was reported as an event being delivered:\n%s", got)
	}
	for _, want := range []string{"NOT that", "credentials only"} {
		if !strings.Contains(logged.String(), want) {
			t.Errorf("the OnReady line does not say a connection proves nothing about delivery (%q missing):\n%s",
				want, logged.String())
		}
	}

	for _, id := range []string{"e1", "e2"} {
		if err := msg(context.Background(), lark.Msg{EventID: id, UserID: testOwner, ChatID: testChat}); err != nil {
			t.Fatalf("message handler: %v", err)
		}
	}
	if err := act(context.Background(), lark.Action{EventID: "e3", Operator: testOwner, ChatID: testChat}); err != nil {
		t.Fatalf("card handler: %v", err)
	}
	// A stranger proves delivery works just as well as the owner does, and this
	// is the case where the allowlist is what is wrong.
	if err := msg(context.Background(), lark.Msg{EventID: "e4", UserID: testStranger, ChatID: testChat}); err != nil {
		t.Fatalf("message handler: %v", err)
	}

	if n := strings.Count(logged.String(), "first feishu event delivered"); n != 1 {
		t.Fatalf("the first-event line was logged %d times, want exactly 1:\n%s", n, logged.String())
	}
}

// TestFirstEventIsAnnouncedForAnUnauthorizedSenderToo pins the half of the rule
// above that is easiest to "tidy up" by moving the call inside the guard.
func TestFirstEventIsAnnouncedForAnUnauthorizedSenderToo(t *testing.T) {
	h := newHarness(t)
	var logged safeBuffer
	h.b.log = slog.New(slog.NewTextHandler(&logged, nil))
	h.b.installHandlers()

	msg, _ := h.bot.handlers()
	if err := msg(context.Background(), lark.Msg{EventID: "e1", UserID: testStranger, ChatID: testChat}); err != nil {
		t.Fatalf("message handler: %v", err)
	}
	if !strings.Contains(logged.String(), "first feishu event delivered") {
		t.Errorf("an event from a stranger proves delivery works and was not reported:\n%s", logged.String())
	}
}

// safeBuffer is a strings.Builder a handler may write to from any goroutine.
type safeBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *safeBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestSilenceUnauthorized(t *testing.T) {
	other := errors.New("something else")
	if err := silenceUnauthorized(ErrUnauthorized); err != nil {
		t.Errorf("ErrUnauthorized reached the SDK as %v; Feishu would redeliver it forever", err)
	}
	if err := silenceUnauthorized(other); !errors.Is(err, other) {
		t.Errorf("a real handler error was swallowed: %v", err)
	}
	if err := silenceUnauthorized(nil); err != nil {
		t.Errorf("nil became %v", err)
	}
}

func TestRealSleepStopsWhenTheContextDies(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := realSleep(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("realSleep = %v, want context.Canceled", err)
	}
	if err := realSleep(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("realSleep: %v", err)
	}
}

// TestInstalledHandlersAreTheGuardedOnes proves the wiring, not just the
// helper: both entry points must run through guard(), so neither can be
// written in a way that forgets to authorize or to deduplicate.
func TestInstalledHandlersAreTheGuardedOnes(t *testing.T) {
	h := newHarness(t)
	h.b.installHandlers()

	msg, act := h.bot.handlers()
	if msg == nil || act == nil {
		t.Fatal("installHandlers did not register both handlers")
	}

	if err := msg(context.Background(), lark.Msg{EventID: "e1", UserID: testOwner, ChatID: testChat}); err != nil {
		t.Fatalf("message handler: %v", err)
	}
	if err := act(context.Background(), lark.Action{EventID: "e2", Operator: testOwner, ChatID: testChat}); err != nil {
		t.Fatalf("card handler: %v", err)
	}

	ops := h.dedup.history()
	if len(ops) != 2 {
		t.Fatalf("dedup ops = %+v, want one per entry point", ops)
	}
	if ops[0].NS != "msg" || ops[1].NS != "card" {
		t.Errorf("namespaces = %q/%q, want msg/card: a card press must expire on its own short window", ops[0].NS, ops[1].NS)
	}
}
