package bridge

import (
	"context"
	"errors"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/lark"
)

// Assistant handles natural-language task management in the bot's private chat.
// Task-group messages continue to reach their bound coding agent directly.
type Assistant interface {
	Reply(context.Context, AssistantMessage) (string, error)
}

// AssistantMessage carries the authorized Feishu sender and the source message.
// OwnerID is supplied by the bridge guard, never by a model's tool arguments.
type AssistantMessage struct {
	OwnerID, ChatID, MessageID, Text string
}

// WithAssistant enables natural-language task management for private messages.
// Without an assistant the existing command and agent routing remains available.
func WithAssistant(a Assistant) Option {
	return func(b *bridge) { b.assistant = a }
}

const assistantUnavailable = "AI 暂时无法生成回复。若刚才涉及任务操作，请先查看任务列表确认结果，再决定下一步。"

// assistantMessage must run after guard and before taskMessage: the task parser
// also recognizes natural language, but the assistant can resolve the project
// and task from context. Once selected, this route must never fall through to
// a terminal, including when the assistant fails or returns an empty response.
func (b *bridge) assistantMessage(ctx context.Context, m lark.Msg) (bool, error) {
	if b.assistant == nil || m.ChatType != lark.ChatP2P {
		return false, nil
	}
	if b.tasks != nil {
		if _, bound := b.tasks.ByChat(m.ChatID); bound {
			return false, nil
		}
	}
	text := strings.TrimSpace(m.Text)
	if strings.HasPrefix(text, "/") {
		return false, nil
	}
	if text == "" {
		return true, nil
	}

	answer, err := b.assistant.Reply(ctx, AssistantMessage{
		OwnerID: m.UserID, ChatID: m.ChatID, MessageID: m.MessageID, Text: m.Text,
	})
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
		b.log.Warn("bridge: assistant could not produce a reply", "kind", kind)
		answer = assistantUnavailable
	}
	_, sendErr := b.send(ctx, outgoing{
		ChatID: m.ChatID, ReplyTo: m.MessageID, Markdown: answer,
	})
	return true, sendErr
}
