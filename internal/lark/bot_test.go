package lark

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	"github.com/larksuite/oapi-sdk-go/v3/event/dispatcher/callback"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func newTestBot(t *testing.T, opts ...Option) (*bot, *stubHTTP) {
	t.Helper()
	http := &stubHTTP{}
	opts = append([]Option{WithHTTPClient(http), WithBotOpenID(stubBotOpenID), WithLogger(discardLogger())}, opts...)
	b, err := New("cli_test", "secret_test", opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	impl, ok := b.(*bot)
	if !ok {
		t.Fatalf("New returned %T, want *bot", b)
	}
	return impl, http
}

// TestNewInstallsEventHandler is the one test this package exists for.
//
// G13: larkws.NewClient without WithEventHandler leaves Client.eventHandler
// nil. ws.(*Client).handleDataFrame then calls eventHandler.Do() on a nil
// receiver and every inbound event panics; Feishu redelivers the unhandled
// event five minutes later (G14). The official doc/channel.zh.md example omits
// the option, so the broken form is the one people copy.
func TestNewInstallsEventHandler(t *testing.T) {
	b, _ := newTestBot(t)

	if b.ws.EventHandler() == nil {
		t.Fatal("ws client has no EventHandler: every inbound event will panic on a nil dispatcher (G13)")
	}
}

// TestNewRegistersHandlersOnDispatcher closes the other half of G13.
//
// EventHandler() being non-nil is necessary but not sufficient: channelImpl
// only registers its message handler if the dispatcher exists at the moment
// OnMessage is called, and if it does not, ensureMessageHandler still sets
// messageHandlerReg and never tries again. Re-registering the same event type
// on the dispatcher panics, so a panic here PROVES the channel got its
// handlers in. If the wiring regressed, these registrations would succeed
// quietly — which is exactly the silent failure mode we are guarding.
func TestNewRegistersHandlersOnDispatcher(t *testing.T) {
	b, _ := newTestBot(t)
	evt := b.ws.EventHandler()
	if evt == nil {
		t.Fatal("no dispatcher")
	}

	assertPanics(t, "im.message.receive_v1", func() {
		evt.OnP2MessageReceiveV1(func(context.Context, *larkim.P2MessageReceiveV1) error { return nil })
	})
	assertPanics(t, "card.action.trigger", func() {
		evt.OnP2CardActionTrigger(func(context.Context, *callback.CardActionTriggerEvent) (*callback.CardActionTriggerResponse, error) {
			return nil, nil
		})
	})
}

func assertPanics(t *testing.T, what string, fn func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Fatalf("%s was never registered on the dispatcher: the channel silently skipped it (G13)", what)
		}
	}()
	fn()
}

func TestNewRejectsMissingCredentials(t *testing.T) {
	tests := []struct {
		name      string
		appID     string
		appSecret string
	}{
		{"no id", "", "secret_test"},
		{"no secret", "cli_test", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, err := New(tc.appID, tc.appSecret)
			if err == nil {
				t.Fatal("want error, got nil")
			}
			if b != nil {
				t.Fatalf("want nil Bot, got %T", b)
			}
			// S2 §3.1: the secret must never reach a log line, and an error
			// string is a log line.
			if tc.appSecret != "" && strings.Contains(err.Error(), tc.appSecret) {
				t.Fatalf("error leaks the app secret: %v", err)
			}
		})
	}
}

// TestNotConnectedBeforeStart pins the contract: Send/UpdateCard/Stream before
// Start (or after Stop) report ErrNotConnected rather than attempting an API
// call with a half-built client.
func TestNotConnectedBeforeStart(t *testing.T) {
	ctx := context.Background()
	out := Out{ChatID: "oc_1", Text: "hi"}

	t.Run("before start", func(t *testing.T) {
		b, http := newTestBot(t)

		if _, err := b.Send(ctx, out); !errors.Is(err, ErrNotConnected) {
			t.Fatalf("Send: got %v, want ErrNotConnected", err)
		}
		if err := b.UpdateCard(ctx, "om_1", `{}`); !errors.Is(err, ErrNotConnected) {
			t.Fatalf("UpdateCard: got %v, want ErrNotConnected", err)
		}
		if _, err := b.Stream(ctx, out); !errors.Is(err, ErrNotConnected) {
			t.Fatalf("Stream: got %v, want ErrNotConnected", err)
		}
		if calls := http.snapshot(); len(calls) != 0 {
			t.Fatalf("disconnected bot made %d API calls: %+v", len(calls), calls)
		}
	})

	t.Run("after stop", func(t *testing.T) {
		b, _ := newTestBot(t)
		b.setState(stateRunning)
		if err := b.Stop(ctx); err != nil {
			t.Fatalf("Stop: %v", err)
		}
		if _, err := b.Send(ctx, out); !errors.Is(err, ErrNotConnected) {
			t.Fatalf("Send after Stop: got %v, want ErrNotConnected", err)
		}
	})
}

func TestStopIsIdempotentAndRestartRefused(t *testing.T) {
	ctx := context.Background()
	fc := newFakeChannel()
	b := newFakeBot(fc, "")

	if err := b.Stop(ctx); err != nil {
		t.Fatalf("Stop before Start: %v", err)
	}
	if err := b.Stop(ctx); err != nil {
		t.Fatalf("second Stop: %v", err)
	}
	// ws.Client.Start never returns (it ends in `select {}`), so a stopped Bot
	// cannot be restarted without leaking a parked goroutine and a second
	// connection in this app's pool — and Feishu deals events at random across
	// every open connection (G15), so the abandoned one would swallow a share of
	// them without anybody seeing an error.
	if err := b.Start(ctx); err == nil {
		t.Fatal("Start after Stop succeeded; want refusal")
	}
	if s, _ := fc.counts(); s != 0 {
		t.Fatalf("refused Start still called ch.Start %d times", s)
	}
}

func TestSend(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name        string
		out         Out
		wantMsgType string
		wantPath    string
	}{
		{
			name:        "text",
			out:         Out{ChatID: "oc_1", Text: "hello"},
			wantMsgType: "text",
			wantPath:    "/open-apis/im/v1/messages",
		},
		{
			name:        "card",
			out:         Out{ChatID: "oc_1", Card: `{"schema":"2.0"}`},
			wantMsgType: "interactive",
			wantPath:    "/open-apis/im/v1/messages",
		},
		{
			name:        "markdown becomes a post",
			out:         Out{ChatID: "oc_1", Markdown: "**bold**", Title: "t"},
			wantMsgType: "post",
			wantPath:    "/open-apis/im/v1/messages",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, http := newTestBot(t)
			b.setState(stateRunning)

			id, err := b.Send(ctx, tc.out)
			if err != nil {
				t.Fatalf("Send: %v", err)
			}
			if id != stubSentMsgID {
				t.Fatalf("message id = %q, want %q", id, stubSentMsgID)
			}

			call, ok := http.find("POST", tc.wantPath)
			if !ok {
				t.Fatalf("no POST to %s; calls: %+v", tc.wantPath, http.snapshot())
			}
			if got := call.bodyField("msg_type"); got != tc.wantMsgType {
				t.Fatalf("msg_type = %q, want %q", got, tc.wantMsgType)
			}
			if got := call.bodyField("receive_id"); got != "oc_1" {
				t.Fatalf("receive_id = %q, want oc_1", got)
			}
			if !strings.Contains(call.Query, "receive_id_type=chat_id") {
				t.Fatalf("query = %q, want receive_id_type=chat_id", call.Query)
			}
		})
	}
}

// TestSendToOpenID: the notify target from config may be an open_id rather
// than a chat_id (S2 §3.4), so the id type has to be sniffed, not assumed.
func TestSendToOpenID(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)

	if _, err := b.Send(context.Background(), Out{ChatID: "ou_user", Text: "hi"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	call, ok := http.find("POST", "/open-apis/im/v1/messages")
	if !ok {
		t.Fatal("no send call")
	}
	if !strings.Contains(call.Query, "receive_id_type=open_id") {
		t.Fatalf("query = %q, want receive_id_type=open_id", call.Query)
	}
}

func TestSendRejectsInvalidOut(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)

	if _, err := b.Send(context.Background(), Out{ChatID: "oc_1"}); !errors.Is(err, ErrInvalidOut) {
		t.Fatalf("got %v, want ErrInvalidOut", err)
	}
	if calls := http.snapshot(); len(calls) != 0 {
		t.Fatalf("invalid Out still hit the API: %+v", calls)
	}
}

// TestUpdateCard covers the disarming path (G17): a card is replaced in place
// with PATCH /open-apis/im/v1/messages/:id, never through a stream controller
// (a card callback does not own one).
func TestUpdateCard(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)
	const card = `{"schema":"2.0","body":{"elements":[]}}`

	if err := b.UpdateCard(context.Background(), "om_card_1", card); err != nil {
		t.Fatalf("UpdateCard: %v", err)
	}

	call, ok := http.find("PATCH", "/open-apis/im/v1/messages/om_card_1")
	if !ok {
		t.Fatalf("no PATCH to the message; calls: %+v", http.snapshot())
	}
	if got := call.bodyField("content"); got != card {
		t.Fatalf("content = %q, want %q", got, card)
	}
}

func TestUpdateCardReportsAPIFailure(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)
	http.patchCode = 230011 // message withdrawn

	err := b.UpdateCard(context.Background(), "om_gone", `{"schema":"2.0"}`)
	if err == nil {
		t.Fatal("want error when Feishu refuses the patch")
	}
	if !strings.Contains(err.Error(), "om_gone") {
		t.Fatalf("error should name the message: %v", err)
	}
}

// Send and UpdateCard failures must stay classifiable WITHOUT the caller
// importing the Feishu SDK — that is the whole reason this package exists
// (contract.go line 1). internal/outbound decides between "downgrade to plain
// text", "back off" and "give up" (S2 §3.8), and it must be able to do that
// through lark.FailureKind / the ErrX sentinels alone.
//
// Only non-retryable codes are driven end-to-end here: the SDK's own retry
// sleeps for real on a retryable one (500ms, then 1.5s). The full code table,
// rate limiting included, is covered without I/O in TestFailureKindMapping.
func TestFailuresStayClassifiable(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name     string
		arrange  func(*stubHTTP)
		call     func(*bot) error
		wantKind FailKind
		wantIs   error
	}{
		{
			name:     "send hits a format error",
			arrange:  func(h *stubHTTP) { h.sendResp = `{"code":230001,"msg":"invalid content"}` },
			call:     func(b *bot) error { _, err := b.Send(ctx, Out{ChatID: "oc_1", Text: "x"}); return err },
			wantKind: FailFormat,
			wantIs:   ErrFormat,
		},
		{
			name:     "send is refused",
			arrange:  func(h *stubHTTP) { h.sendResp = `{"code":99991400,"msg":"no permission"}` },
			call:     func(b *bot) error { _, err := b.Send(ctx, Out{ChatID: "oc_1", Text: "x"}); return err },
			wantKind: FailPermissionDenied,
			wantIs:   ErrPermissionDenied,
		},
		{
			name:     "the card being patched was withdrawn",
			arrange:  func(h *stubHTTP) { h.patchCode = 230011 },
			call:     func(b *bot) error { return b.UpdateCard(ctx, "om_gone", `{"schema":"2.0"}`) },
			wantKind: FailTargetRevoked,
			wantIs:   ErrTargetRevoked,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, http := newTestBot(t)
			b.setState(stateRunning)
			tc.arrange(http)

			err := tc.call(b)
			if err == nil {
				t.Fatal("want an error")
			}
			if got := FailureKind(err); got != tc.wantKind {
				t.Fatalf("FailureKind = %q, want %q (err: %v)", got, tc.wantKind, err)
			}
			if !errors.Is(err, tc.wantIs) {
				t.Fatalf("errors.Is(%v, %v) = false", err, tc.wantIs)
			}
			// A sentinel must not match the wrong failure, or a caller
			// switching on them would take the wrong fallback.
			if errors.Is(err, ErrNotConnected) || errors.Is(err, ErrInvalidOut) {
				t.Fatalf("%v matches an unrelated sentinel", err)
			}
		})
	}
}

// TestFailureKindIgnoresNonChannelErrors: FailNone means "this is not a Feishu
// write failure", which is what lets a caller fall through to its own
// transport checks instead of mistaking ErrNotConnected for a rate limit.
func TestFailureKindIgnoresNonChannelErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{"nil", nil},
		{"not connected", ErrNotConnected},
		{"invalid out", ErrInvalidOut},
		{"wrapped invalid out", fmt.Errorf("send: %w", ErrInvalidOut)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := FailureKind(tc.err); got != FailNone {
				t.Fatalf("FailureKind(%v) = %q, want FailNone", tc.err, got)
			}
		})
	}
}

// TestFailureStillUnwrapsToTheSDKError documents a deliberate, temporary
// compromise rather than an invariant worth keeping.
//
// internal/outbound.Classify currently unwraps *types.FeishuChannelError
// directly. Hiding the SDK error today would silently downgrade every
// classified failure there to "permanent" — worse than the layering violation
// it fixes. Once internal/outbound switches to FailureKind, drop this test and
// the Unwrap that feeds it, and the SDK type stops escaping the package.
func TestFailureStillUnwrapsToTheSDKError(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)
	http.sendResp = `{"code":230001,"msg":"invalid content"}`

	_, err := b.Send(context.Background(), Out{ChatID: "oc_1", Text: "x"})
	var fce *types.FeishuChannelError
	if !errors.As(err, &fce) {
		t.Fatalf("err = %v (%T); internal/outbound.Classify still needs this", err, err)
	}
	if fce.Code != types.ErrCodeFormatError {
		t.Fatalf("code = %v, want %v", fce.Code, types.ErrCodeFormatError)
	}
}

func TestUpdateCardRejectsBadInput(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name      string
		messageID string
		card      string
	}{
		{"empty message id", "", `{}`},
		{"malformed json", "om_1", `{not json`},
		// json.Valid accepts these; a Feishu card is always an object, and a
		// non-object body would only fail once it reached Feishu, as a generic
		// API error. This is the disarming path (G17) — the cheapest bug class
		// belongs here, not on the wire.
		{"json array", "om_1", `[]`},
		{"json number", "om_1", `123`},
		{"json string", "om_1", `"x"`},
		{"json null", "om_1", `null`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, http := newTestBot(t)
			b.setState(stateRunning)

			if err := b.UpdateCard(ctx, tc.messageID, tc.card); !errors.Is(err, ErrInvalidOut) {
				t.Fatalf("got %v, want ErrInvalidOut", err)
			}
			if calls := http.snapshot(); len(calls) != 0 {
				t.Fatalf("rejected input still hit the API: %+v", calls)
			}
		})
	}
}
