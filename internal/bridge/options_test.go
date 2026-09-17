package bridge

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

type notificationBot struct {
	*fakeBot
	sent chan time.Time
}

func (b notificationBot) Send(ctx context.Context, out lark.Out) (string, error) {
	id, err := b.fakeBot.Send(ctx, out)
	if err == nil {
		b.sent <- time.Now()
	}
	return id, err
}

func TestNotifyCooldownControlsActualNotifications(t *testing.T) {
	h := newHarness(t)
	bot := notificationBot{fakeBot: h.bot, sent: make(chan time.Time, 2)}
	d := h.b.deps
	d.Bot, d.Now = bot, time.Now
	const cooldown = 40 * time.Millisecond
	b, err := newBridge(d, WithNotifyCooldown(cooldown))
	if err != nil {
		t.Fatal(err)
	}
	b.log = discardLogger()
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- b.notifier.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-finished:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("notifier: %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Error("notifier did not stop")
		}
	})

	nextNotification := func() time.Time {
		t.Helper()
		select {
		case at := <-bot.sent:
			return at
		case <-time.After(2 * time.Second):
			t.Fatal("configured notification cooldown was not used")
			return time.Time{}
		}
	}
	a := finishedAgent()
	h.reg.ch <- agents.Transition{Agent: a, To: agents.StatusDone, Seq: 1}
	first := nextNotification()
	h.reg.ch <- agents.Transition{Agent: a, To: agents.StatusDone, Seq: 2}
	second := nextNotification()
	if second.Sub(first) < cooldown/2 {
		t.Fatal("second notification ignored the configured cooldown")
	}
}
