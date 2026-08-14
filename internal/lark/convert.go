package lark

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
)

// ErrInvalidOut is returned by Send/Stream for an Out that Feishu could not
// render: no body, or more than one body. It is a programming error, not a
// transport error, and is deliberately distinct from ErrNotConnected so a
// caller retrying "connection" failures does not retry this forever.
var ErrInvalidOut = errors.New("lark: invalid outbound message")

// toMsg maps the SDK's normalised message onto ours.
//
// EventID is carried across verbatim: it is the dedup key, and G14 measured
// Feishu redelivering an unhandled event byte-identical five minutes later. A
// redelivery here means re-injecting a command into a live coding agent, so
// losing this field is not a cosmetic bug.
func toMsg(n *types.NormalizedMessage) Msg {
	if n == nil {
		return Msg{}
	}
	return Msg{
		EventID:          n.EventID,
		MessageID:        n.MessageID,
		ChatID:           n.ChatID,
		ChatType:         n.ChatType,
		UserID:           n.UserID,
		Text:             n.Content,
		ReplyToMessageID: replyTarget(n.RawEvent),
		MentionedBot:     n.MentionedBot,
	}
}

// replyTarget digs the replied-to message id out of the raw event.
//
// NormalizedMessage does not expose it, but reply-to is the bridge's primary
// routing mechanism (S2 §3.5: reply to a message, drive that agent, no /use
// command), so we go back to the wire struct for it. parent_id is the message
// actually replied to; root_id is the thread root and is only used when there
// is no parent_id. Both are absent for a plain message, and then routing falls
// through to the bare-text path — which is why this returning "" must stay
// harmless.
func replyTarget(raw any) string {
	ev, ok := raw.(*larkim.P2MessageReceiveV1)
	if !ok || ev == nil || ev.Event == nil || ev.Event.Message == nil {
		return ""
	}
	m := ev.Event.Message
	if m.ParentId != nil && *m.ParentId != "" {
		return *m.ParentId
	}
	if m.RootId != nil && *m.RootId != "" {
		return *m.RootId
	}
	return ""
}

// toAction maps a card button press. Operator.OpenID is the authorization
// subject (S2 §3.4) and Value carries the whole Guard the card was built with
// (S2 §3.6) — pane, kind, seq, iat, nonce — so routing needs no server state
// (G16). MessageID is the card's own message id, needed to disarm it (G17).
//
// EventID is guaranteed non-empty for any press that carries a message id,
// because the caller turns it into the persistent dedup key `card:<event_id>`
// (S2 §3.6 step 2). See syntheticActionID for why that guarantee needs work.
func toAction(e *types.CardActionEvent) Action {
	if e == nil {
		return Action{}
	}
	a := Action{
		EventID:   e.EventID,
		MessageID: e.MessageID,
		ChatID:    e.ChatID,
		Operator:  e.Operator.OpenID,
		Value:     e.Action.Value,
	}
	if a.EventID == "" {
		a.EventID = syntheticActionID(e)
	}
	return a
}

// syntheticActionID builds a dedup key for a press that arrived without one.
//
// normalize.ParseCardAction only fills EventID when the callback carries an
// EventV2Base with a Header; otherwise it is "". Propagating that would give
// every headerless press the same key `card:`, so the first one would be
// deduped forever and every later press would vanish with no feedback and no
// disarmed card — a silent drop, which S2 §3.6 cannot afford.
//
// The replacement has to be stable across a redelivery of the SAME press (G14
// redelivers events byte-identical) and distinct across different buttons and
// cards, so it is derived from exactly the things that distinguish one press:
// the card's message id, who pressed it, and the button's own payload. That is
// the same identity channelImpl.cardActionDedupKey falls back to. Two presses
// of the same button on the same card do collapse to one key — which is what
// S2 §3.6 step 3 requires anyway ("同一张卡片的同一个按钮只能生效一次").
//
// json.Marshal sorts map keys, so the payload encoding is deterministic; the
// hash keeps card content out of the on-disk dedup file.
func syntheticActionID(e *types.CardActionEvent) string {
	payload, err := json.Marshal(e.Action.Value)
	if err != nil {
		// Values come off the wire as map[string]any, so this is unreachable
		// in practice; fall back to the button tag rather than to "".
		payload = []byte(e.Action.Tag)
	}
	h := sha256.New()
	for _, part := range []string{e.MessageID, e.ChatID, e.Operator.OpenID, e.Action.Tag, string(payload)} {
		h.Write([]byte(part))
		h.Write([]byte{0}) // NUL separator: no concatenation can be ambiguous
	}
	return "synth-card-" + hex.EncodeToString(h.Sum(nil))[:32]
}

// toSendInput validates an Out and maps it onto the SDK's SendInput.
//
// The target goes in ReceiveID, not ChatID: the SDK sniffs the id type from
// its prefix there (oc_ chat, ou_ open id), and config's notify target is
// allowed to be either (S2 §3.4).
func toSendInput(o Out) (*types.SendInput, error) {
	if o.ChatID == "" {
		return nil, fmt.Errorf("%w: no target chat", ErrInvalidOut)
	}

	set := 0
	if o.Text != "" {
		set++
	}
	if o.Markdown != "" {
		set++
	}
	if o.Card != "" {
		set++
	}
	switch set {
	case 1:
	case 0:
		return nil, fmt.Errorf("%w: exactly one of Text, Markdown or Card must be set, none is", ErrInvalidOut)
	default:
		return nil, fmt.Errorf("%w: exactly one of Text, Markdown or Card must be set, %d are", ErrInvalidOut, set)
	}

	in := &types.SendInput{
		ReceiveID:      o.ChatID,
		ReplyMessageID: o.ReplyMessageID,
	}
	switch {
	case o.Card != "":
		// Caught here rather than at Feishu: a card that fails to parse comes
		// back as a generic API error, and the card is the one message whose
		// delivery the safety story depends on.
		if !isJSONObject(o.Card) {
			return nil, fmt.Errorf("%w: card is not a JSON object", ErrInvalidOut)
		}
		in.Card = o.Card
	case o.Markdown != "":
		in.Markdown = o.Markdown
		in.Title = o.Title
	default:
		in.Text = o.Text
	}
	return in, nil
}

// isJSONObject reports whether s is a JSON object — `{...}`, not `[]`, `123`,
// `"x"` or `null`.
//
// json.Valid accepts any JSON value, which lets the cheapest class of
// card-builder bug (a card body that is an array, or a `null` from a template
// that produced nothing) sail past the local check and fail at Feishu as a
// generic API error instead. Every Feishu card is an object.
//
// Note that `null` unmarshals into a map without error and leaves it nil,
// hence the second half of the condition.
func isJSONObject(s string) bool {
	var probe map[string]json.RawMessage
	return json.Unmarshal([]byte(s), &probe) == nil && probe != nil
}

// singleMessageDispatch disables the SDK's per-chat batching window.
//
// By default the channel buffers messages for 600ms and merges everything that
// lands in the same chat into ONE NormalizedMessage: bodies joined with a
// blank line, and only the LAST event's EventID surviving. Both halves of that
// are wrong here. The dropped EventIDs are exactly the dedup keys G14 needs,
// and a merged body would splice a command and a following sentence into one
// blob, which S2 §3.5 forbids from being treated as free text. One event in,
// one Msg out.
func singleMessageDispatch() types.SafetyConfig {
	s := types.DefaultChannelConfig().Safety
	s.Batch.MaxMessages = 1
	s.Batch.DelayMs = 0
	return s
}

// feishuHardCharLimit is Feishu's real per-message ceiling (S2 §3.8: 单条上限
// 8000 字符). internal/outbound.MaxMessageRunes carries the same number.
const feishuHardCharLimit = 8000

// oneMessagePerSend stops the SDK from splitting an Out behind our back.
//
// channelImpl.Send runs Text through splitPlain and Markdown through
// SplitWithCodeFences at Outbound.TextChunkLimit, which DEFAULTS TO 3500 —
// below the 4000 internal/outbound splits at (its SplitTarget), so every
// maximal chunk the bridge produced was being cut in two again, and mirrored
// assistant turns (S2 §3.9) routinely cross 3500. Only the first of the
// resulting ids comes back from Send, so the extra bubbles were unbindable:
// a user replying to the bubble they can actually see — the last one — would
// miss the route entirely (S2 §3.5 path 2 is the primary interaction path).
//
// Raising the limit to Feishu's own ceiling makes internal/outbound the single
// splitter in the system and one Out exactly one message. Everything else,
// notably Retry and the stream throttle, keeps the SDK defaults.
func oneMessagePerSend() types.OutboundConfig {
	o := types.DefaultChannelConfig().Outbound
	o.TextChunkLimit = feishuHardCharLimit
	return o
}
