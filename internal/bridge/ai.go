package bridge

import (
	"context"
	"errors"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/lark"
)

// Assistant handles task management in the entry chat and bound task groups.
type Assistant interface {
	Reply(context.Context, AssistantMessage) (string, error)
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

const assistantUnavailable = "AI 暂时无法生成回复。若刚才涉及任务操作，请先查看任务列表确认结果，再决定下一步。"

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
	if strings.HasPrefix(text, "/") {
		return false, nil
	}
	if text == "" {
		return true, nil
	}

	answer, err := b.assistant.Reply(ctx, AssistantMessage{
		OwnerID: m.UserID, ChatID: m.ChatID, MessageID: m.MessageID, Text: m.Text,
		TaskID: taskID,
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
		if taskID != "" {
			answer = "任务助手暂时无法回复。你可以直接在本群发 /tasks 查看当前任务，或用 /screen 查看执行窗口；刚才的操作结果请以任务状态为准。"
		}
	}
	_, sendErr := b.send(ctx, outgoing{
		ChatID: m.ChatID, ReplyTo: m.MessageID, Markdown: answer,
	})
	return true, sendErr
}
