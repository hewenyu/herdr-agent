package lark

import (
	"errors"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkevent "github.com/larksuite/oapi-sdk-go/v3/event"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

func strptr(s string) *string { return &s }

// rawMessageEvent synthesises the wire struct the SDK hands to
// normalize.ParseMessage, which is where the reply target has to come from.
func rawMessageEvent(eventID, parentID, rootID string) *larkim.P2MessageReceiveV1 {
	msg := &larkim.EventMessage{MessageId: strptr("om_1")}
	if parentID != "" {
		msg.ParentId = strptr(parentID)
	}
	if rootID != "" {
		msg.RootId = strptr(rootID)
	}
	return &larkim.P2MessageReceiveV1{
		EventV2Base: &larkevent.EventV2Base{
			Header: &larkevent.EventHeader{EventID: eventID, EventType: "im.message.receive_v1"},
		},
		Event: &larkim.P2MessageReceiveV1Data{Message: msg},
	}
}

func TestToMsg(t *testing.T) {
	tests := []struct {
		name string
		in   *types.NormalizedMessage
		want Msg
	}{
		{
			name: "nil is the zero message",
			in:   nil,
			want: Msg{},
		},
		{
			name: "plain p2p text",
			in: &types.NormalizedMessage{
				EventID:      "evt-1",
				MessageID:    "om_1",
				ChatID:       "oc_1",
				ChatType:     ChatP2P,
				UserID:       "ou_user",
				Content:      "/ls",
				MentionedBot: false,
				RawEvent:     rawMessageEvent("evt-1", "", ""),
			},
			want: Msg{
				EventID:   "evt-1",
				MessageID: "om_1",
				ChatID:    "oc_1",
				ChatType:  ChatP2P,
				UserID:    "ou_user",
				Text:      "/ls",
			},
		},
		{
			name: "reply carries parent_id",
			in: &types.NormalizedMessage{
				EventID:  "evt-2",
				ChatType: ChatP2P,
				Content:  "yes go ahead",
				RawEvent: rawMessageEvent("evt-2", "om_bridge_card", "om_thread_root"),
			},
			want: Msg{
				EventID:          "evt-2",
				ChatType:         ChatP2P,
				Text:             "yes go ahead",
				ReplyToMessageID: "om_bridge_card",
			},
		},
		{
			name: "thread reply falls back to root_id",
			in: &types.NormalizedMessage{
				EventID:  "evt-3",
				RawEvent: rawMessageEvent("evt-3", "", "om_thread_root"),
			},
			want: Msg{EventID: "evt-3", ReplyToMessageID: "om_thread_root"},
		},
		{
			name: "unknown raw event shape leaves reply empty",
			in: &types.NormalizedMessage{
				EventID:  "evt-4",
				RawEvent: map[string]any{"parent_id": "om_x"},
			},
			want: Msg{EventID: "evt-4"},
		},
		{
			name: "group mention",
			in: &types.NormalizedMessage{
				EventID:      "evt-5",
				ChatType:     ChatGroup,
				MentionedBot: true,
			},
			want: Msg{EventID: "evt-5", ChatType: ChatGroup, MentionedBot: true},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := toMsg(tc.in)
			if got != tc.want {
				t.Fatalf("toMsg =\n %+v\nwant\n %+v", got, tc.want)
			}
		})
	}
}

// The EventID is the dedup key. G14 measured Feishu redelivering an unhandled
// event byte-identical five minutes later, and here a redelivery re-injects a
// command into a live agent, so this field must never be dropped in mapping.
func TestToMsgKeepsEventIDForDedup(t *testing.T) {
	const id = "0bd206ca7f1e4d2f9c0a"
	got := toMsg(&types.NormalizedMessage{EventID: id, MessageID: "om_x100b68e9b40a2ca"})
	if got.EventID != id {
		t.Fatalf("EventID = %q, want %q (G14 dedup key)", got.EventID, id)
	}
}

func TestToAction(t *testing.T) {
	value := map[string]any{
		"act":  "key",
		"key":  "1",
		"pane": "w1:p1",
		"kind": "claude",
		"seq":  float64(42),
		"n":    "nonce-1",
	}

	tests := []struct {
		name string
		in   *types.CardActionEvent
		want Action
	}{
		{"nil", nil, Action{}},
		{
			// normalize.ParseCardAction only fills EventID when the callback
			// carries an EventV2Base with a Header. Propagating "" would give
			// every headerless press the same dedup key `card:`, so the first
			// would poison the cache and every later press would vanish with
			// no feedback and no disarmed card (S2 §3.6).
			name: "a press with no event header still gets a key",
			in: &types.CardActionEvent{
				MessageID: "om_card_1",
				ChatID:    "oc_1",
				Operator:  types.CardActionOperator{OpenID: "ou_user"},
				Action:    types.CardActionPayload{Tag: "button", Value: value},
			},
			want: Action{
				EventID:   anySyntheticID,
				MessageID: "om_card_1",
				ChatID:    "oc_1",
				Operator:  "ou_user",
				Value:     value,
			},
		},
		{
			name: "button press carries the whole guard",
			in: &types.CardActionEvent{
				EventID:   "evt-card-1",
				MessageID: "om_card_1",
				ChatID:    "oc_1",
				Operator:  types.CardActionOperator{OpenID: "ou_user", UserID: "u-1"},
				Action:    types.CardActionPayload{Tag: "button", Value: value},
			},
			want: Action{
				EventID:   "evt-card-1",
				MessageID: "om_card_1",
				ChatID:    "oc_1",
				Operator:  "ou_user",
				Value:     value,
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := toAction(tc.in)
			if tc.want.EventID == anySyntheticID {
				if !strings.HasPrefix(got.EventID, "synth-card-") {
					t.Fatalf("EventID = %q, want a synthesised key", got.EventID)
				}
				tc.want.EventID = got.EventID
			}
			if got.EventID != tc.want.EventID || got.MessageID != tc.want.MessageID ||
				got.ChatID != tc.want.ChatID || got.Operator != tc.want.Operator {
				t.Fatalf("toAction = %+v, want %+v", got, tc.want)
			}
			if len(got.Value) != len(tc.want.Value) {
				t.Fatalf("value = %v, want %v", got.Value, tc.want.Value)
			}
			for k, v := range tc.want.Value {
				if got.Value[k] != v {
					t.Fatalf("value[%s] = %v, want %v", k, got.Value[k], v)
				}
			}
		})
	}
}

// anySyntheticID marks a table row whose expected EventID is generated rather
// than fixed.
const anySyntheticID = "<synthetic>"

// TestSyntheticActionIDIsStableAndDistinct pins the two properties the dedup
// key depends on.
//
// Stable, because G14 measured Feishu redelivering an event byte-identical
// five minutes later, and a key that changed per delivery would let the same
// press reach the agent twice. Distinct, because a key shared between two
// buttons would silently swallow the second press.
func TestSyntheticActionIDIsStableAndDistinct(t *testing.T) {
	press := func(msgID, operator string, value map[string]any) *types.CardActionEvent {
		return &types.CardActionEvent{
			MessageID: msgID,
			ChatID:    "oc_1",
			Operator:  types.CardActionOperator{OpenID: operator},
			Action:    types.CardActionPayload{Tag: "button", Value: value},
		}
	}
	yes := map[string]any{"act": "key", "key": "1", "pane": "w1:p1", "n": "nonce-1"}
	esc := map[string]any{"act": "key", "key": "esc", "pane": "w1:p1", "n": "nonce-1"}

	base := syntheticActionID(press("om_card_1", "ou_user", yes))

	// A redelivery of the same press: same key, so dedup catches it.
	if got := syntheticActionID(press("om_card_1", "ou_user", yes)); got != base {
		t.Fatalf("the same press hashed differently: %q vs %q; a redelivery would be executed twice (G14)", got, base)
	}
	// Map iteration order is random, so a naive concatenation would flap. Run
	// it enough times that an unsorted encoding could not survive.
	for range 32 {
		if got := syntheticActionID(press("om_card_1", "ou_user", yes)); got != base {
			t.Fatalf("key is not deterministic across map iterations: %q vs %q", got, base)
		}
	}

	distinct := map[string]*types.CardActionEvent{
		"a different button on the same card": press("om_card_1", "ou_user", esc),
		"the same button on another card":     press("om_card_2", "ou_user", yes),
		"another operator":                    press("om_card_1", "ou_other", yes),
	}
	for name, e := range distinct {
		if got := syntheticActionID(e); got == base {
			t.Fatalf("%s hashed to the same key; that press would be silently dropped", name)
		}
	}
}

// G16: the pane id travels inside the button value and comes back untouched,
// which is why card routing needs no server-side state.
func TestToActionPreservesPaneID(t *testing.T) {
	got := toAction(&types.CardActionEvent{
		Action: types.CardActionPayload{Value: map[string]any{"pane": "w1:p1"}},
	})
	if got.Value["pane"] != "w1:p1" {
		t.Fatalf("pane = %v, want w1:p1", got.Value["pane"])
	}
}

func TestToSendInput(t *testing.T) {
	tests := []struct {
		name    string
		out     Out
		wantErr bool
		check   func(*testing.T, *types.SendInput)
	}{
		{
			name: "text",
			out:  Out{ChatID: "oc_1", Text: "hi", ReplyMessageID: "om_prev"},
			check: func(t *testing.T, in *types.SendInput) {
				if in.Text != "hi" || in.ReceiveID != "oc_1" || in.ReplyMessageID != "om_prev" {
					t.Fatalf("in = %+v", in)
				}
				if in.ChatID != "" {
					t.Fatalf("ChatID should stay empty so the SDK sniffs the id type: %+v", in)
				}
			},
		},
		{
			name: "markdown keeps the title",
			out:  Out{ChatID: "oc_1", Markdown: "**x**", Title: "claude · /tmp"},
			check: func(t *testing.T, in *types.SendInput) {
				if in.Markdown != "**x**" || in.Title != "claude · /tmp" {
					t.Fatalf("in = %+v", in)
				}
			},
		},
		{
			name: "title is ignored for plain text",
			out:  Out{ChatID: "oc_1", Text: "x", Title: "ignored"},
			check: func(t *testing.T, in *types.SendInput) {
				if in.Title != "" {
					t.Fatalf("Title = %q, want empty for a text message", in.Title)
				}
			},
		},
		{
			name: "card",
			out:  Out{ChatID: "oc_1", Card: `{"schema":"2.0"}`},
			check: func(t *testing.T, in *types.SendInput) {
				if in.Card != `{"schema":"2.0"}` {
					t.Fatalf("in = %+v", in)
				}
			},
		},
		{name: "no target", out: Out{Text: "hi"}, wantErr: true},
		{name: "no body", out: Out{ChatID: "oc_1"}, wantErr: true},
		{name: "text and card", out: Out{ChatID: "oc_1", Text: "a", Card: "{}"}, wantErr: true},
		{name: "text and markdown", out: Out{ChatID: "oc_1", Text: "a", Markdown: "b"}, wantErr: true},
		{name: "all three", out: Out{ChatID: "oc_1", Text: "a", Markdown: "b", Card: "{}"}, wantErr: true},
		{name: "card is not json", out: Out{ChatID: "oc_1", Card: "not a card"}, wantErr: true},
		// json.Valid accepts any JSON value, so these four used to sail past
		// the local check and come back from Feishu as a generic API error.
		// Every Feishu card is an object, and the card is the one message the
		// safety story depends on (S2 §3.6) — catch it here.
		{name: "card is a json array", out: Out{ChatID: "oc_1", Card: "[]"}, wantErr: true},
		{name: "card is a json number", out: Out{ChatID: "oc_1", Card: "123"}, wantErr: true},
		{name: "card is a json string", out: Out{ChatID: "oc_1", Card: `"x"`}, wantErr: true},
		{name: "card is json null", out: Out{ChatID: "oc_1", Card: "null"}, wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			in, err := toSendInput(tc.out)
			if tc.wantErr {
				if !errors.Is(err, ErrInvalidOut) {
					t.Fatalf("err = %v, want ErrInvalidOut", err)
				}
				if in != nil {
					t.Fatalf("got input %+v alongside the error", in)
				}
				return
			}
			if err != nil {
				t.Fatalf("toSendInput: %v", err)
			}
			tc.check(t, in)
		})
	}
}

// The SDK's 600ms batcher merges same-chat messages into one, keeping only the
// last EventID and joining the bodies. Both halves break this bridge: the
// dropped ids are the dedup keys (G14) and a merged body would splice a
// command onto free text (S2 §3.5).
func TestSingleMessageDispatchDisablesBatching(t *testing.T) {
	s := singleMessageDispatch()

	if s.Batch.MaxMessages != 1 {
		t.Fatalf("Batch.MaxMessages = %d, want 1", s.Batch.MaxMessages)
	}
	if s.Batch.DelayMs != 0 {
		t.Fatalf("Batch.DelayMs = %v, want 0", s.Batch.DelayMs)
	}
	// The rest of SafetyConfig must keep its defaults: a zero stale window
	// makes safety.IsStale true for every message and the bridge goes deaf.
	def := types.DefaultChannelConfig().Safety
	if s.StaleMessageWindowMs != def.StaleMessageWindowMs {
		t.Fatalf("stale window = %v, want the SDK default %v", s.StaleMessageWindowMs, def.StaleMessageWindowMs)
	}
	if s.Dedup.MaxEntries != def.Dedup.MaxEntries {
		t.Fatalf("dedup capacity = %d, want the SDK default %d", s.Dedup.MaxEntries, def.Dedup.MaxEntries)
	}
}
