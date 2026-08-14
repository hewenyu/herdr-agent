package lark

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// TestHandleMessageSelfEcho exercises OUR filter, not the SDK's.
//
// channelImpl has its own self-echo check, but it only runs when
// GetBotIdentity succeeds — a REST call that fails silently, and then the SDK
// forwards the bot's own messages. The fake channel here reports no identity,
// which is exactly that case, so the drop below can only come from
// Bot.handleMessage using the open_id pinned from config.
func TestHandleMessageSelfEcho(t *testing.T) {
	tests := []struct {
		name          string
		botOpenID     string
		sender        string
		wantDelivered bool
	}{
		{"own message is dropped", "ou_bot_self", "ou_bot_self", false},
		{"user message is delivered", "ou_bot_self", "ou_user", true},
		{"unknown bot id cannot filter", "", "ou_bot_self", true},
		{"anonymous sender is delivered", "ou_bot_self", "", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fc := newFakeChannel() // identity nil: the SDK's own filter is off
			b := newFakeBot(fc, tc.botOpenID)

			var got []Msg
			b.OnMessage(func(ctx context.Context, m Msg) error {
				got = append(got, m)
				return nil
			})

			err := b.handleMessage(context.Background(), &types.NormalizedMessage{
				EventID: "evt-1",
				UserID:  tc.sender,
				Content: "text",
			})
			if err != nil {
				t.Fatalf("handleMessage: %v", err)
			}

			if delivered := len(got) == 1; delivered != tc.wantDelivered {
				t.Fatalf("delivered = %v, want %v", delivered, tc.wantDelivered)
			}
		})
	}
}

// The bridge registers its SDK-facing handlers at construction, so an event
// arriving before OnMessage/OnCardAction is set must be dropped, not crash.
func TestHandlersWithoutCallbacks(t *testing.T) {
	fc := newFakeChannel()
	b := newFakeBot(fc, "")
	ctx := context.Background()

	if fc.onMessage == nil || fc.onCardAction == nil {
		t.Fatal("the channel never received the bridge's handlers")
	}
	if err := b.handleMessage(ctx, &types.NormalizedMessage{EventID: "e"}); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if err := b.handleCardAction(ctx, &types.CardActionEvent{EventID: "e"}); err != nil {
		t.Fatalf("handleCardAction: %v", err)
	}
	if err := b.handleMessage(ctx, nil); err != nil {
		t.Fatalf("nil message: %v", err)
	}
	if err := b.handleCardAction(ctx, nil); err != nil {
		t.Fatalf("nil card action: %v", err)
	}
}

// A failing handler must report upward, but WHERE the report lands differs by
// event type and the difference is not cosmetic.
//
// For a card action the returned error reaches ws.handleDataFrame (through
// pipelineManager.Run), the frame goes unacknowledged, and Feishu redelivers
// it (G14) — the right outcome for a press we failed to execute.
//
// For a message it does not. channelImpl calls the handler as
// `h(ctx, batch.Message)`, discarding the result, on a pipeline worker
// goroutine that starts after the frame was already ACKed. So the return value
// below is uniformity, not a retry mechanism, and the only thing a caller can
// actually observe is Lifecycle.OnError. S2 §3.8 needs that signal to tell the
// user "你的指令没能执行" instead of leaving them waiting.
func TestHandlerErrorsAreWrappedNotSwallowed(t *testing.T) {
	fc := newFakeChannel()
	b := newFakeBot(fc, "")
	ctx := context.Background()
	sentinel := errors.New("herdr socket refused")

	var reported []error
	b.SetLifecycle(Lifecycle{OnError: func(err error) { reported = append(reported, err) }})
	b.OnMessage(func(context.Context, Msg) error { return sentinel })
	b.OnCardAction(func(context.Context, Action) error { return sentinel })

	if err := b.handleMessage(ctx, &types.NormalizedMessage{UserID: "ou_user"}); !errors.Is(err, sentinel) {
		t.Fatalf("message: %v, want it to wrap %v", err, sentinel)
	}
	// The load-bearing half: nobody upstream reads the return value, so a
	// failed message that raised nothing here would vanish without trace.
	if len(reported) != 1 || !errors.Is(reported[0], sentinel) {
		t.Fatalf("Lifecycle.OnError saw %v, want exactly one error wrapping %v", reported, sentinel)
	}
	if err := b.handleCardAction(ctx, &types.CardActionEvent{Operator: types.CardActionOperator{OpenID: "ou_user"}}); !errors.Is(err, sentinel) {
		t.Fatalf("card action: %v, want it to wrap %v", err, sentinel)
	}
}

// A handler that succeeds must not raise anything, or the caller's error path
// becomes noise it learns to ignore.
func TestSuccessfulHandlerRaisesNothing(t *testing.T) {
	fc := newFakeChannel()
	b := newFakeBot(fc, "")

	var reported []error
	b.SetLifecycle(Lifecycle{OnError: func(err error) { reported = append(reported, err) }})
	b.OnMessage(func(context.Context, Msg) error { return nil })

	if err := b.handleMessage(context.Background(), &types.NormalizedMessage{UserID: "ou_user"}); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if len(reported) != 0 {
		t.Fatalf("Lifecycle.OnError fired on success: %v", reported)
	}
}

// The bot must survive a handler failure with no Lifecycle installed at all
// ("All optional" — contract.go).
func TestHandlerErrorWithoutLifecycle(t *testing.T) {
	fc := newFakeChannel()
	b := newFakeBot(fc, "")
	b.OnMessage(func(context.Context, Msg) error { return errors.New("boom") })

	if err := b.handleMessage(context.Background(), &types.NormalizedMessage{UserID: "ou_user"}); err == nil {
		t.Fatal("want the handler error back")
	}
}

// TestRejectIsObservable: S2 §3.2 lists OnReject among the callbacks to wire,
// and it is the one that used to be missing.
//
// The SDK's policy gate drops a message before OnMessage ever runs. Without
// this hook the drop leaves no trace whatsoever — the same silent failure the
// spec warns about everywhere else, and invisible debt the moment a policy is
// actually configured. Ids and the reason are logged; message content is not,
// because a rejected message is by definition from someone we do not trust.
func TestRejectIsObservable(t *testing.T) {
	fc := newFakeChannel()
	var logged bytes.Buffer
	b := &bot{ch: fc, log: captureLogger(&logged)}
	b.wire()

	if len(fc.onReject) != 1 {
		t.Fatalf("the channel got %d reject handlers, want 1 (S2 §3.2)", len(fc.onReject))
	}

	err := fc.onReject[0](context.Background(), &types.RejectEvent{
		MessageID: "om_rejected",
		ChatID:    "oc_group",
		SenderID:  "ou_stranger",
		Reason:    "group_message_without_mention",
	})
	if err != nil {
		t.Fatalf("reject handler: %v", err)
	}

	out := logged.String()
	for _, want := range []string{"om_rejected", "oc_group", "ou_stranger", "group_message_without_mention"} {
		if !strings.Contains(out, want) {
			t.Fatalf("log line is missing %q: %s", want, out)
		}
	}
	if !strings.Contains(out, "WARN") {
		t.Fatalf("rejection was not logged at WARN: %s", out)
	}

	// A nil event must not panic; the SDK owns the call site.
	if err := fc.onReject[0](context.Background(), nil); err != nil {
		t.Fatalf("nil reject event: %v", err)
	}
}

// Handlers can be replaced; only the current one runs.
func TestHandlerReplacement(t *testing.T) {
	fc := newFakeChannel()
	b := newFakeBot(fc, "")

	first, second := 0, 0
	b.OnMessage(func(context.Context, Msg) error { first++; return nil })
	b.OnMessage(func(context.Context, Msg) error { second++; return nil })

	if err := b.handleMessage(context.Background(), &types.NormalizedMessage{UserID: "ou_user"}); err != nil {
		t.Fatalf("handleMessage: %v", err)
	}
	if first != 0 || second != 1 {
		t.Fatalf("first=%d second=%d, want 0 and 1", first, second)
	}
}
