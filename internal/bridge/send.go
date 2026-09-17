package bridge

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/outbound"
)

const (
	// maxSendRetries is how many extra attempts a ClassRetryable failure gets.
	// Retryable means the connection was never established, so nothing was
	// delivered and a resend cannot duplicate; three attempts is enough to ride
	// out a WebSocket that is still coming up without making a caller wait.
	maxSendRetries = 2

	// sendBackoff is the pause before the first retry; it doubles after that.
	sendBackoff = 250 * time.Millisecond
)

// ErrNoSendTarget rejects an outgoing message with nowhere to go, rather than
// letting the SDK answer with a generic API error.
var ErrNoSendTarget = errors.New("bridge: outgoing message has no target chat")

// outgoing is one logical message the bridge wants delivered. Exactly one of
// Text, Markdown and Card carries the body.
type outgoing struct {
	ChatID  string
	ReplyTo string

	Text     string
	Markdown string
	Card     string
	Title    string // post title, only meaningful with Markdown

	// PaneID is the agent this message is about, "" when it is about none.
	// Every delivered message that names an agent is bound to it, because
	// replying to a message is how the user drives that agent (S2 §3.5): this
	// is the primary interaction model, not a convenience.
	PaneID string
	// DeliveryKey identifies a task transcript record. Confirmed post chunks
	// can be resumed after failure or restart without repeating their prefix.
	DeliveryKey string
}

// send delivers o, splitting, downgrading and retrying as the measured
// failures require, and binds every delivered message to o.PaneID.
//
// It returns the ids that were actually created, even on failure: a partial
// delivery is a real state the caller may need to update or disarm.
func (b *bridge) send(ctx context.Context, o outgoing) ([]string, error) {
	if o.ChatID == "" {
		return nil, fmt.Errorf("%w (pane %q)", ErrNoSendTarget, o.PaneID)
	}

	if o.Card != "" {
		id, err := b.sendOne(ctx, lark.Out{
			ChatID:         o.ChatID,
			ReplyMessageID: o.ReplyTo,
			Card:           o.Card,
		})
		if err != nil {
			b.log.Error("bridge: card was not delivered", "pane", o.PaneID, "chat_id", o.ChatID, "err", err)
			return nil, err
		}
		b.bind(id, o.PaneID)
		return []string{id}, nil
	}

	body, markdown := o.Markdown, true
	if body == "" {
		body, markdown = o.Text, false
	}
	if body == "" {
		return nil, fmt.Errorf("%w: nothing to send", lark.ErrInvalidOut)
	}

	// A GitHub-style table makes the Feishu post renderer produce a BLANK
	// bubble: the message is delivered, the user sees an empty box, and nothing
	// anywhere reports a failure. Sending the same content as plain text is
	// ugly and legible, which is the right trade for a phone.
	if markdown && outbound.HasMarkdownTable(body) {
		b.log.Info("bridge: downgrading a markdown table to plain text; feishu renders tables as an empty bubble",
			"pane", o.PaneID)
		body, markdown = outbound.ToPlainText(body), false
	}

	chunks := outbound.Split(body, outbound.SplitTarget)
	var checkpoint string
	if o.DeliveryKey != "" {
		checkpoint = fmt.Sprintf("post:%x", sha256.Sum256([]byte(fmt.Sprintf("%s\n%t\n%d\n%s", o.DeliveryKey, markdown, outbound.SplitTarget, body))))
	}
	confirmed := 0
	if checkpoint != "" {
		confirmed = b.deliveryStore.receipt(checkpoint).Chunks
		if confirmed > len(chunks) {
			return nil, errors.New("bridge: delivered chunk checkpoint exceeds this message")
		}
	}
	ids := make([]string, 0, len(chunks))
	for index, c := range chunks {
		if index < confirmed {
			continue
		}
		out := lark.Out{
			ChatID: o.ChatID,
			// Every chunk replies to the same target rather than chaining onto
			// its predecessor: the "(i/n)" indicator already orders them, and a
			// chain would bury the later ones behind expanders on a phone.
			ReplyMessageID: o.ReplyTo,
		}
		if markdown {
			out.Markdown, out.Title = c.Text, o.Title
		} else {
			out.Text = c.Text
		}

		id, err := b.sendOne(ctx, out)
		if err != nil {
			b.log.Error("bridge: giving up on an outbound message",
				"pane", o.PaneID, "chat_id", o.ChatID,
				"chunk", c.Index, "of", c.Total, "delivered", len(ids), "err", err)
			return ids, fmt.Errorf("bridge: send chunk %d/%d: %w", c.Index, c.Total, err)
		}
		b.bind(id, o.PaneID)
		ids = append(ids, id)
		if checkpoint != "" {
			if err := b.deliveryStore.acknowledge(checkpoint, deliveryReceipt{Chunks: index + 1}); err != nil {
				return ids, fmt.Errorf("bridge: persist delivered chunk: %w", err)
			}
		}
	}
	return ids, nil
}

// sendOne delivers exactly one Feishu message, applying the recovery each
// failure class allows and no more.
func (b *bridge) sendOne(ctx context.Context, out lark.Out) (string, error) {
	var (
		retries    int
		downgraded bool // format downgrade is one-shot
		unreplied  bool // dropping ReplyMessageID is one-shot
		backoff    = sendBackoff
	)

	for {
		id, err := b.deps.Bot.Send(ctx, out)
		if err == nil {
			if id == "" {
				return "", errors.New("bridge: send returned no message ID; delivery is unconfirmed")
			}
			return id, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", errors.Join(err, ctxErr)
		}

		switch class := classifySend(err); class {
		case outbound.ClassRetryable:
			// The request never left this machine, so resending cannot post
			// twice. This is the ONLY class that is retried.
			if retries >= maxSendRetries {
				return "", err
			}
			retries++
			b.log.Warn("bridge: retrying a send that never reached feishu",
				"attempt", retries, "backoff", backoff, "err", err)
			if sleepErr := b.sleep(ctx, backoff); sleepErr != nil {
				return "", errors.Join(err, sleepErr)
			}
			backoff *= 2

		case outbound.ClassFormat:
			// Feishu could not render the payload. Strip the markup and try
			// once; the content is what matters, and for this product it is
			// usually the command the user is being asked to approve.
			if downgraded || out.Card != "" {
				// A card that fails to render cannot be "downgraded" here: its
				// body is JSON, not prose, and posting that would be noise. The
				// caller decides what to say instead.
				return "", err
			}
			downgraded = true
			b.log.Warn("bridge: feishu rejected the format; resending as plain text", "err", err)
			out = toPlain(out)

		case outbound.ClassRevoked:
			// The reply target is gone (deleted, or older than Feishu keeps).
			// The message itself is fine, so resend it as a fresh one. The SDK
			// performs this fallback internally too; seeing it here means that
			// attempt did not stick, and S2 §3.8 asks for it either way.
			if unreplied || out.ReplyMessageID == "" {
				return "", err
			}
			unreplied = true
			b.log.Warn("bridge: reply target is gone; resending without it",
				"reply_to", out.ReplyMessageID, "err", err)
			out.ReplyMessageID = ""

		case outbound.ClassRateLimited:
			// The SDK already backed off and retried inside this call, so
			// arriving here means those attempts were exhausted. Doing it again
			// would only deepen the hole.
			b.log.Error("bridge: rate limited by feishu; message dropped", "err", err)
			return "", err

		default: // outbound.ClassPermanent
			// Includes every timeout. The request may already have reached
			// Feishu, and a resend would post a second copy — in this product a
			// second copy of a card is a second live button aimed at an agent
			// (G14, G17). One undelivered message, reported honestly, is the
			// cheaper failure.
			return "", err
		}
	}
}

// bind records what messageID is about, so replying to it routes there.
//
// It records WHO is in the pane, not only which pane it was. A pane id is a
// seat: the agent that was in it when this message went out can exit, and
// another can take the same seat before the reply arrives — days later, since
// Feishu messages never expire and a binding lives for routes.TTL (G8, G17).
// The identity travels inside the routes value because routes.Store maps a
// message to one opaque string and cannot be changed; keeping it in a
// bridge-local map instead would lose it on every restart, and S2 §3.1 says the
// bridge is restarted routinely.
func (b *bridge) bind(messageID, paneID string) {
	if messageID == "" || paneID == "" {
		return
	}

	a, ok := b.deps.Registry.Get(paneID)
	if !ok {
		// herdr does not know this pane, so there is no identity to record. The
		// bare pane id is stored, which decodes as unverifiable and is refused
		// on the way back in — the right answer for a reply to a message about
		// an agent that was already gone when we sent it.
		b.deps.Routes.Bind(messageID, paneID)
		return
	}
	b.deps.Routes.Bind(messageID, encodeBinding(a))
}

// toPlain strips an Out back to text for a resend after a format error.
func toPlain(out lark.Out) lark.Out {
	body := out.Markdown
	if body == "" {
		body = out.Text
	}
	return lark.Out{
		ChatID:         out.ChatID,
		ReplyMessageID: out.ReplyMessageID,
		Text:           outbound.ToPlainText(body),
	}
}

// classifySend turns a lark write failure into the action to take.
//
// lark exports its own taxonomy precisely so that nothing outside it imports
// the Feishu SDK, so the sentinels are consulted first; outbound.Classify
// handles everything else, including bare network errors, and is the authority
// on the rule that matters — a timeout is NOT retryable.
func classifySend(err error) outbound.ErrorClass {
	switch {
	case err == nil:
		return outbound.ClassPermanent
	case errors.Is(err, lark.ErrFormat):
		return outbound.ClassFormat
	case errors.Is(err, lark.ErrRateLimited):
		return outbound.ClassRateLimited
	case errors.Is(err, lark.ErrTargetRevoked):
		return outbound.ClassRevoked
	case errors.Is(err, lark.ErrNotConnected):
		// Nothing was written: the bot has not finished connecting, or has
		// stopped. Same guarantee as a dial failure, so the same handling —
		// which is what gets a push through when it beat the WebSocket up.
		return outbound.ClassRetryable
	case errors.Is(err, lark.ErrSendTimeout),
		errors.Is(err, lark.ErrPermissionDenied),
		errors.Is(err, lark.ErrSSRFBlocked),
		errors.Is(err, lark.ErrInvalidOut),
		errors.Is(err, lark.ErrSplit):
		return outbound.ClassPermanent
	default:
		return outbound.Classify(err)
	}
}
