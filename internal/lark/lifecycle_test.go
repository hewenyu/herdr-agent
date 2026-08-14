package lark

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// TestStartUsesChannelStart: S2 §3.2 requires ch.Start, never ws.Start,
// because only ch.Start installs the lifecycle callbacks on the ws client and
// resolves the bot identity on ready.
func TestStartUsesChannelStart(t *testing.T) {
	fc := newFakeChannel()
	fc.startBlocks = true
	b := newFakeBot(fc, stubBotOpenID)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- b.Start(ctx) }()
	awaitStart(t, fc)

	// A started bot may send.
	if err := b.requireConnected(); err != nil {
		t.Fatalf("running bot reports %v", err)
	}

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Start returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Start did not return after the context was cancelled")
	}

	// The connection must be released. Feishu deals each event to a randomly
	// chosen one of the connections open for this app (G15), so one left open
	// after cancellation keeps drawing a share of the events with nobody reading.
	if _, stops := fc.counts(); stops != 1 {
		t.Fatalf("ch.Stop called %d times after cancellation, want 1", stops)
	}
	if err := b.requireConnected(); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("after cancellation: %v, want ErrNotConnected", err)
	}
	close(fc.release)
}

func TestStartPropagatesChannelError(t *testing.T) {
	fc := newFakeChannel()
	fc.startErr = errors.New("dial refused")
	b := newFakeBot(fc, "")

	err := b.Start(context.Background())
	if err == nil || !errors.Is(err, fc.startErr) {
		t.Fatalf("Start returned %v, want it to wrap %v", err, fc.startErr)
	}
	if err := b.requireConnected(); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("after a failed Start: %v, want ErrNotConnected", err)
	}
}

func TestDoubleStartRefused(t *testing.T) {
	fc := newFakeChannel()
	fc.startBlocks = true
	b := newFakeBot(fc, "")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = b.Start(ctx) }()
	awaitStart(t, fc)

	if err := b.Start(context.Background()); err == nil {
		t.Fatal("second Start succeeded; a second connection would join this app's pool and be dealt a " +
			"random share of its events instead of conflicting with the first (G15)")
	}
	if s, _ := fc.counts(); s != 1 {
		t.Fatalf("ch.Start called %d times, want 1", s)
	}
	close(fc.release)
}

// TestSetLifecycleFanOut: the five callbacks are registered with the SDK once,
// at construction, and SetLifecycle only swaps the functions behind them.
// Registering per SetLifecycle call would fire every generation of callbacks.
func TestSetLifecycleFanOut(t *testing.T) {
	fc := newFakeChannel()
	b := newFakeBot(fc, "")

	var got []string
	b.SetLifecycle(Lifecycle{
		OnReady:        func() { got = append(got, "ready") },
		OnError:        func(error) { got = append(got, "error") },
		OnReconnecting: func() { got = append(got, "reconnecting") },
		OnReconnected:  func() { got = append(got, "reconnected") },
		OnDisconnected: func() { got = append(got, "disconnected") },
	})

	fc.fire(fc.onReady)
	for _, h := range fc.onError {
		h(errors.New("boom"))
	}
	fc.fire(fc.onReconnecting)
	fc.fire(fc.onReconnected)
	fc.fire(fc.onDisconnected)

	want := []string{"ready", "error", "reconnecting", "reconnected", "disconnected"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}

	// Replacing the set must not leave the old callbacks attached.
	got = nil
	second := 0
	b.SetLifecycle(Lifecycle{OnReady: func() { second++ }})
	fc.fire(fc.onReady)
	if second != 1 || len(got) != 0 {
		t.Fatalf("after replacement: second=%d, old=%v", second, got)
	}
}

// A Lifecycle with nil fields is legal ("All optional"): firing must not panic.
func TestLifecycleZeroValueIsSafe(t *testing.T) {
	fc := newFakeChannel()
	newFakeBot(fc, "")

	fc.fire(fc.onReady)
	for _, h := range fc.onError {
		h(errors.New("boom"))
	}
	fc.fire(fc.onReconnecting)
	fc.fire(fc.onReconnected)
	fc.fire(fc.onDisconnected)
}

func TestStream(t *testing.T) {
	fc := newFakeChannel()
	fs := &fakeStream{}
	fc.stream = fs
	b := newFakeBot(fc, "")
	b.setState(stateRunning)
	ctx := context.Background()

	s, err := b.Stream(ctx, Out{ChatID: "oc_1", Markdown: "start", Title: "claude"})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if fc.streamInput == nil || fc.streamInput.ReceiveID != "oc_1" || fc.streamInput.Markdown != "start" {
		t.Fatalf("stream input = %+v", fc.streamInput)
	}

	if err := s.Append(ctx, "hello"); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if err := s.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Idempotent: a mirror both defers Close and closes at end of turn.
	if err := s.Close(ctx); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if err := s.Append(ctx, "after close"); err == nil {
		t.Fatal("Append after Close succeeded")
	}

	appended, flushes, closes := fs.state()
	if len(appended) != 1 || appended[0] != "hello" {
		t.Fatalf("appended = %v", appended)
	}
	if flushes != 1 || closes != 1 {
		t.Fatalf("flushes=%d closes=%d, want 1 and 1", flushes, closes)
	}
}

// TestStreamCloseFailureSurvivesASecondClose.
//
// Close is idempotent because the mirror both defers it and calls it at the
// end of a turn (S2 §3.9). Idempotent must not mean "the second call reports
// success": Close is what flushes the controller's last buffered text, so a
// failed Close means the tail of an agent's answer never reached the phone.
// If only the first call reported it, the mirror's own deferred Close would
// paper over the failure and nobody would ever tell the user (S2 §3.8).
func TestStreamCloseFailureSurvivesASecondClose(t *testing.T) {
	fc := newFakeChannel()
	boom := errors.New("feishu refused the final flush")
	fs := &fakeStream{closeErr: boom}
	fc.stream = fs
	b := newFakeBot(fc, "")
	b.setState(stateRunning)
	ctx := context.Background()

	s, err := b.Stream(ctx, Out{ChatID: "oc_1", Markdown: "start"})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	first := s.Close(ctx)
	if !errors.Is(first, boom) {
		t.Fatalf("first Close = %v, want it to wrap %v", first, boom)
	}
	second := s.Close(ctx)
	if !errors.Is(second, boom) {
		t.Fatalf("second Close = %v, want the recorded failure, not nil", second)
	}
	// One attempt only: retrying the controller's Close is not this adapter's
	// decision to make.
	if _, _, closes := fs.state(); closes != 1 {
		t.Fatalf("sc.Close called %d times, want 1", closes)
	}

	// Later use reports the real reason rather than a bare "closed", which is
	// what a caller needs in order to say anything useful to the user.
	for _, op := range []struct {
		name string
		err  error
	}{
		{"Append", s.Append(ctx, "more")},
		{"Flush", s.Flush(ctx)},
	} {
		if op.err == nil {
			t.Fatalf("%s after a failed Close succeeded", op.name)
		}
		if !errors.Is(op.err, boom) {
			t.Fatalf("%s reported %v, want the close failure %v", op.name, op.err, boom)
		}
	}
}

func TestStreamRejectsInvalidOut(t *testing.T) {
	fc := newFakeChannel()
	b := newFakeBot(fc, "")
	b.setState(stateRunning)

	if _, err := b.Stream(context.Background(), Out{ChatID: "oc_1", Text: "a", Card: "{}"}); !errors.Is(err, ErrInvalidOut) {
		t.Fatalf("got %v, want ErrInvalidOut", err)
	}
	if fc.streamInput != nil {
		t.Fatal("invalid Out still opened a stream")
	}
}

func TestBotOpenIDCachesLookup(t *testing.T) {
	fc := newFakeChannel()
	fc.identity = &types.BotIdentity{OpenID: "ou_from_api"}
	b := newFakeBot(fc, "")

	if got := b.BotOpenID(context.Background()); got != "ou_from_api" {
		t.Fatalf("BotOpenID = %q", got)
	}
	// Once resolved it is remembered, so a later identity failure cannot make
	// self-echo suppression flap.
	fc.mu.Lock()
	fc.identity = nil
	fc.mu.Unlock()
	if got := b.BotOpenID(context.Background()); got != "ou_from_api" {
		t.Fatalf("BotOpenID after a failed refresh = %q, want the cached value", got)
	}
}

func TestBotOpenIDEmptyWhenUnknown(t *testing.T) {
	fc := newFakeChannel() // identity nil: the REST lookup failed
	b := newFakeBot(fc, "")

	if got := b.BotOpenID(context.Background()); got != "" {
		t.Fatalf("BotOpenID = %q, want empty", got)
	}
}

func awaitStart(t *testing.T, fc *fakeChannel) {
	t.Helper()
	select {
	case <-fc.started:
	case <-time.After(2 * time.Second):
		t.Fatal("ch.Start was never called")
	}
}
