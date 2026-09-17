package bridge

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/outbound"
)

// Assistant handles task management in the entry chat and bound task groups.
type Assistant interface {
	Reply(context.Context, AssistantMessage) (string, error)
}

// AssistantReplyDelivery records the complete logical reply, not just its first
// Feishu message. Incomplete delivery is never evidence that the user saw a proposal.
type AssistantReplyDelivery struct {
	MessageIDs []string
	Complete   bool
	Retryable  bool // known that no part left the machine
}

// AssistantDelivery optionally adds a durable outbox to the conversation.
// Reserving before sending prevents duplicate posts after a lost acknowledgement.
type AssistantDelivery interface {
	BeginReplyDelivery(context.Context, AssistantMessage, string) (bool, error)
	RecordReplyDelivery(context.Context, AssistantMessage, string, AssistantReplyDelivery) error
}

// AssistantMessage carries the authorized Feishu sender and the source message.
// OwnerID is supplied by the bridge guard, never by a model's tool arguments.
type AssistantMessage struct {
	OwnerID, ChatID, MessageID, Text string
	// TaskID is set only from the bridge's durable task/chat binding. The model
	// cannot select this scope or use it to operate on another task.
	TaskID string
}

// WithAssistant enables natural-language task management in entry/task chats.
// Without an assistant the existing command and agent routing remains available.
func WithAssistant(a Assistant) Option {
	return func(b *bridge) { b.assistant = a }
}

// assistantMessage must run after guard and before taskMessage: the task parser
// also recognizes natural language, but the assistant can resolve the project
// and task from context. Once selected, this route must never fall through to
// a terminal, including when the assistant fails or returns an empty response.
func (b *bridge) assistantMessage(ctx context.Context, m lark.Msg) (bool, error) {
	if b.assistant == nil {
		return false, nil
	}
	var taskID string
	if b.tasks != nil {
		if task, bound := b.tasks.ByChat(m.ChatID); bound {
			if task.OwnerID != m.UserID || !b.tasks.OwnerAllowed(m.UserID) {
				return true, ErrUnauthorized
			}
			taskID = task.ID
		}
	}
	if taskID == "" && m.ChatType != lark.ChatP2P {
		return false, nil
	}
	text := strings.TrimSpace(m.Text)
	if strings.HasPrefix(text, "/") || strings.HasPrefix(text, "／") {
		return false, nil
	}
	if text == "" {
		return true, nil
	}

	in := AssistantMessage{
		OwnerID: m.UserID, ChatID: m.ChatID, MessageID: m.MessageID, Text: m.Text,
		TaskID: taskID,
	}
	answer, err := b.assistant.Reply(ctx, in)
	if err != nil || strings.TrimSpace(answer) == "" {
		// Provider errors may contain request bodies or credentials. Neither the
		// user-facing reply nor logs may include the original error or input.
		kind := "empty_response"
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			kind = "timeout"
		case errors.Is(err, context.Canceled):
			kind = "cancelled"
		case err != nil:
			kind = "failure"
		}
		b.log.Warn("bridge: assistant could not produce a reply", "kind", kind,
			"message_id", m.MessageID, "task_id", taskID)
		// Only model-authored replies belong in this conversation. Keep the
		// event handled: tools may already have acted before generation failed.
		return true, nil
	}
	delivery, tracksDelivery := b.assistant.(AssistantDelivery)
	if tracksDelivery {
		start, err := delivery.BeginReplyDelivery(ctx, in, answer)
		if err != nil || !start {
			return true, err
		}
	}
	ids, sendErr := b.send(ctx, outgoing{
		ChatID: m.ChatID, ReplyTo: m.MessageID, Markdown: answer,
	})
	if tracksDelivery {
		complete := sendErr == nil && len(ids) > 0
		for _, id := range ids {
			complete = complete && id != ""
		}
		// Persist the outcome even if cancellation interrupted the network call.
		// An incomplete/unknown send must not become visible history or be replayed.
		recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		err := delivery.RecordReplyDelivery(recordCtx, in, answer, AssistantReplyDelivery{
			MessageIDs: ids, Complete: complete,
			Retryable: len(ids) == 0 && sendErr != nil && classifySend(sendErr) == outbound.ClassRetryable,
		})
		if err != nil {
			return true, errors.Join(sendErr, err)
		}
	}
	return true, sendErr
}
