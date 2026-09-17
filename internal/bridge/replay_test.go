package bridge

import (
	"context"
	"errors"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// A Feishu reply is a separate side effect from terminal input. Losing the reply
// must never make a redelivery type that input, or press Esc, a second time.
func TestFailedTerminalReceiptDoesNotReplayInput(t *testing.T) {
	for _, tt := range []struct {
		name, text   string
		operationErr error
		count        func(*fakeController) int
	}{
		{"prose", "run the migration", nil, func(c *fakeController) int { return len(c.said()) }},
		{"uncertain prose", "run the migration", context.DeadlineExceeded, func(c *fakeController) int { return len(c.said()) }},
		{"interrupt", "/stop " + testPane, nil, func(c *fakeController) int { return len(c.interrupted()) }},
		{"uncertain interrupt", "/stop " + testPane, context.DeadlineExceeded, func(c *fakeController) int { return len(c.interrupted()) }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h, _ := burstHarness(t)
			h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true, Attempts: 1}, tt.operationErr)
			h.ctrl.keyErr = tt.operationErr
			h.bot.failNext(failing(lark.ErrRateLimited))
			h.b.installHandlers()
			handler, _ := h.bot.handlers()
			message := inbound(tt.text)
			if err := handler(context.Background(), message); !errors.Is(err, lark.ErrRateLimited) {
				t.Fatalf("first delivery error = %v; want observable receipt failure", err)
			}
			if err := handler(context.Background(), message); err != nil {
				t.Fatalf("redelivery: %v", err)
			}
			if got := tt.count(h.ctrl); got != 1 {
				t.Fatalf("terminal operation ran %d times after a failed receipt and redelivery; want 1", got)
			}
			// An explicit new message remains actionable after the first receipt
			// failed: deduplication must cover one event, not silence the pane.
			message.EventID = "next-input"
			message.MessageID = "next-message"
			if err := handler(context.Background(), message); err != nil {
				t.Fatalf("next message: %v", err)
			}
			if got := tt.count(h.ctrl); got != 2 {
				t.Fatalf("terminal operation count after a new message = %d; want 2", got)
			}
			if len(chatReceived(h)) != 1 {
				t.Fatal("the failed receipt silenced the next message's receipt")
			}
		})
	}
}
