package lark

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// messagePayload builds the JSON Feishu actually pushes down the long
// connection for im.message.receive_v1.
func messagePayload(eventID, senderOpenID, text string, extra map[string]string) []byte {
	msg := map[string]any{
		"message_id":   "om_1",
		"chat_id":      "oc_1",
		"chat_type":    "p2p",
		"message_type": "text",
		"content":      fmt.Sprintf(`{"text":%q}`, text),
		// Recent: safety.IsStale drops anything older than 30 minutes.
		"create_time": fmt.Sprint(time.Now().UnixMilli()),
	}
	for k, v := range extra {
		msg[k] = v
	}
	payload := map[string]any{
		"schema": "2.0",
		"header": map[string]any{
			"event_id":    eventID,
			"event_type":  "im.message.receive_v1",
			"create_time": fmt.Sprint(time.Now().UnixMilli()),
			"app_id":      "cli_test",
			"tenant_key":  "tk",
		},
		"event": map[string]any{
			"sender": map[string]any{
				"sender_id":   map[string]any{"open_id": senderOpenID},
				"sender_type": "user",
			},
			"message": msg,
		},
	}
	b, _ := json.Marshal(payload)
	return b
}

func cardPayload(eventID, operatorOpenID string, value map[string]any) []byte {
	payload := map[string]any{
		"schema": "2.0",
		"header": map[string]any{
			"event_id":    eventID,
			"event_type":  "card.action.trigger",
			"create_time": fmt.Sprint(time.Now().UnixMilli()),
			"app_id":      "cli_test",
			"tenant_key":  "tk",
		},
		"event": map[string]any{
			"operator": map[string]any{"open_id": operatorOpenID},
			"token":    "c-token",
			"action":   map[string]any{"tag": "button", "value": value},
			"context": map[string]any{
				"open_message_id": "om_card_1",
				"open_chat_id":    "oc_1",
			},
		},
	}
	b, _ := json.Marshal(payload)
	return b
}

// TestInboundMessageReachesHandler drives a real Feishu payload through the
// real dispatcher and the real channel into our handler. This is the G13
// regression test with teeth: drop WithEventHandler and there is no dispatcher
// to hand the payload to; drop the channel registration and Do reports no
// handler for the event type. Either way this fails.
func TestInboundMessageReachesHandler(t *testing.T) {
	b, _ := newTestBot(t)

	got := make(chan Msg, 1)
	b.OnMessage(func(ctx context.Context, m Msg) error {
		got <- m
		return nil
	})

	if _, err := b.ws.EventHandler().Do(context.Background(),
		messagePayload("evt-inbound-1", "ou_user", "/ls", map[string]string{"parent_id": "om_parent"})); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	select {
	case m := <-got:
		if m.EventID != "evt-inbound-1" {
			t.Errorf("EventID = %q", m.EventID)
		}
		if m.Text != "/ls" {
			t.Errorf("Text = %q", m.Text)
		}
		if m.UserID != "ou_user" {
			t.Errorf("UserID = %q", m.UserID)
		}
		if m.ChatID != "oc_1" || m.ChatType != ChatP2P {
			t.Errorf("chat = %q/%q", m.ChatID, m.ChatType)
		}
		if m.ReplyToMessageID != "om_parent" {
			t.Errorf("ReplyToMessageID = %q, want om_parent", m.ReplyToMessageID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no message reached the handler")
	}
}

func TestBotRemovalEventIsAcknowledgedWithoutBecomingTaskInput(t *testing.T) {
	b, http := newTestBot(t)
	b.OnMessage(func(context.Context, Msg) error {
		t.Error("bot removal was converted into a user message")
		return nil
	})
	payload := []byte(`{"schema":"2.0","header":{"event_id":"evt-bot-removed","event_type":"im.chat.member.bot.deleted_v1","app_id":"cli_test","tenant_key":"tk"},"event":{"chat_id":"oc_closed_task"}}`)
	for range 2 {
		if _, err := b.ws.EventHandler().Do(context.Background(), payload); err != nil {
			t.Fatalf("bot removal dispatch: %v", err)
		}
	}
	if calls := http.snapshot(); len(calls) != 0 {
		t.Fatalf("bot removal triggered external operations: %+v", calls)
	}
}

// Task chats must deliver plain text through the real SDK policy gate. Task
// ownership and binding are enforced by the bridge after this adapter delivers
// the message; with task chats disabled the SDK's mention requirement remains.
func TestTaskChatMessagesWithoutMention(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(fmt.Sprintf("enabled=%v", enabled), func(t *testing.T) {
			b, _ := newTestBot(t, WithTaskChats(enabled))
			got := make(chan Msg, 3)
			rejected := make(chan string, 1)
			b.OnMessage(func(_ context.Context, m Msg) error {
				got <- m
				return nil
			})
			b.ch.OnReject(func(_ context.Context, event *types.RejectEvent) error {
				rejected <- event.MessageID
				return nil
			})
			dispatch := func(eventID, senderID, messageID, chatType, text string) {
				t.Helper()
				_, err := b.ws.EventHandler().Do(context.Background(), messagePayload(eventID, senderID, text,
					map[string]string{"message_id": messageID, "chat_type": chatType}))
				if err != nil {
					t.Fatalf("dispatch: %v", err)
				}
			}
			if enabled {
				// The SDK resolves a different bot ID in this fixture, so the
				// adapter's own echo filter must work for task groups too.
				dispatch("evt-group-self", stubBotOpenID, "om_group_self", "group", "任务进展回写")
			}
			dispatch("evt-group-user", "ou_user", "om_group_user", "group", "现在任务进度怎么样了")
			if enabled {
				select {
				case m := <-got:
					if m.MessageID != "om_group_user" || m.Text != "现在任务进度怎么样了" || m.ChatType != ChatGroup || m.MentionedBot {
						t.Fatalf("unexpected unmentioned task group message: %+v", m)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("plain task group message never reached the handler")
				}
			} else {
				select {
				case id := <-rejected:
					if id != "om_group_user" {
						t.Fatalf("rejected %q, want group message", id)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("plain group message should require a mention without task chats")
				}
			}
			// Keep the DM entry available in both modes, and prove that no
			// rejected group message or self echo reached the handler.
			dispatch("evt-dm", "ou_user", "om_dm", "p2p", "有哪些项目")
			select {
			case m := <-got:
				if m.MessageID != "om_dm" || m.ChatType != ChatP2P {
					t.Fatalf("unexpected DM or leaked group message: %+v", m)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("DM never reached the handler")
			}
		})
	}
}

// TestEachEventIsDeliveredSeparately pins the batching override.
//
// By default the SDK buffers a chat for 600ms and merges everything that
// lands in it into ONE NormalizedMessage carrying only the last EventID. The
// bridge cannot live with that: the discarded EventIDs are the dedup keys G14
// needs, and a merged body would splice two user messages — say "/stop w1:p1"
// and a following sentence — into one blob that the command parser must not
// treat as free text (S2 §3.5). With batching on, this test sees one message
// instead of two.
func TestEachEventIsDeliveredSeparately(t *testing.T) {
	b, _ := newTestBot(t)

	got := make(chan Msg, 4)
	b.OnMessage(func(ctx context.Context, m Msg) error {
		got <- m
		return nil
	})

	ctx := context.Background()
	if _, err := b.ws.EventHandler().Do(ctx,
		messagePayload("evt-a", "ou_user", "/stop w1:p1", map[string]string{"message_id": "om_a"})); err != nil {
		t.Fatalf("dispatch a: %v", err)
	}
	if _, err := b.ws.EventHandler().Do(ctx,
		messagePayload("evt-b", "ou_user", "and then run the tests", map[string]string{"message_id": "om_b"})); err != nil {
		t.Fatalf("dispatch b: %v", err)
	}

	seen := map[string]string{}
	for range 2 {
		select {
		case m := <-got:
			seen[m.EventID] = m.Text
		case <-time.After(5 * time.Second):
			t.Fatalf("only got %v; the two events were merged into one", seen)
		}
	}
	if seen["evt-a"] != "/stop w1:p1" || seen["evt-b"] != "and then run the tests" {
		t.Fatalf("messages came through mangled: %v", seen)
	}
}

// The bridge's own messages come back as events. Feeding one back into the
// router would type into a live pane.
//
// This runs through the real dispatcher with the SDK's own self-echo filter
// neutralised: the stub answers /open-apis/bot/v3/info with
// stubSDKIdentityOpenID while the bot is configured with stubBotOpenID, so
// channelImpl compares the sender against the wrong id and forwards the event.
// The drop below can therefore only be ours. (Delete the filter in
// bot.handleMessage and this test fails.)
func TestSelfEchoIsDropped(t *testing.T) {
	b, _ := newTestBot(t)

	got := make(chan Msg, 1)
	b.OnMessage(func(ctx context.Context, m Msg) error {
		got <- m
		return nil
	})

	// From the bot itself. Distinct message ids matter: the SDK dedups on
	// message_id, and now that its self-echo filter no longer fires first, a
	// shared id would make the SECOND event the one that gets dropped and the
	// test would pass for the wrong reason.
	if _, err := b.ws.EventHandler().Do(context.Background(),
		messagePayload("evt-self", stubBotOpenID, "mirrored agent output",
			map[string]string{"message_id": "om_self"})); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	// From the user, to prove the pipeline is alive and the drop above was
	// selective rather than a hang.
	if _, err := b.ws.EventHandler().Do(context.Background(),
		messagePayload("evt-user", "ou_user", "hello",
			map[string]string{"message_id": "om_user"})); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	select {
	case m := <-got:
		if m.EventID != "evt-user" {
			t.Fatalf("handler saw %q; the bot's own message was not filtered", m.EventID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the user's message never arrived")
	}
	select {
	case m := <-got:
		t.Fatalf("a second message arrived: %+v", m)
	default:
	}
}

func TestInboundCardActionReachesHandler(t *testing.T) {
	b, _ := newTestBot(t)

	got := make(chan Action, 1)
	b.OnCardAction(func(ctx context.Context, a Action) error {
		got <- a
		return nil
	})

	value := map[string]any{"act": "key", "key": "1", "pane": "w1:p1", "kind": "claude", "n": "nonce-1"}
	if _, err := b.ws.EventHandler().Do(context.Background(),
		cardPayload("evt-card-1", "ou_user", value)); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	select {
	case a := <-got:
		if a.EventID != "evt-card-1" {
			t.Errorf("EventID = %q", a.EventID)
		}
		if a.MessageID != "om_card_1" {
			t.Errorf("MessageID = %q, want the card's own id (needed to disarm it, G17)", a.MessageID)
		}
		if a.ChatID != "oc_1" {
			t.Errorf("ChatID = %q", a.ChatID)
		}
		if a.Operator != "ou_user" {
			t.Errorf("Operator = %q; this is the authorization subject", a.Operator)
		}
		if a.Value["pane"] != "w1:p1" || a.Value["key"] != "1" || a.Value["n"] != "nonce-1" {
			t.Errorf("guard value lost in mapping: %v", a.Value)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no card action reached the handler")
	}
}

// A handler error must surface to the SDK rather than being swallowed: for
// card callbacks the dispatcher propagates it, and an unhandled event is what
// makes Feishu redeliver (G14) — which is the right outcome when we failed.
func TestCardActionHandlerErrorPropagates(t *testing.T) {
	b, _ := newTestBot(t)

	sentinel := errors.New("herdr socket down")
	b.OnCardAction(func(ctx context.Context, a Action) error { return sentinel })

	_, err := b.ws.EventHandler().Do(context.Background(),
		cardPayload("evt-card-err", "ou_user", map[string]any{"act": "key"}))
	if !errors.Is(err, sentinel) {
		t.Fatalf("dispatch error = %v, want it to wrap %v", err, sentinel)
	}
}

// Events that arrive before a handler is installed must be dropped quietly,
// not panic.
func TestNoHandlerIsNotAPanic(t *testing.T) {
	b, _ := newTestBot(t)

	if _, err := b.ws.EventHandler().Do(context.Background(),
		messagePayload("evt-nohandler", "ou_user", "hi", nil)); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if _, err := b.ws.EventHandler().Do(context.Background(),
		cardPayload("evt-nohandler-card", "ou_user", nil)); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
}
