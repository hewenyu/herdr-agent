package bridge

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestCardDoesNotClaimUnsentAfterKeyWriteAttempt(t *testing.T) {
	for _, tt := range []struct {
		name              string
		writeErr, readErr error
		failCardUpdate    bool
	}{
		{name: "lost write response", writeErr: context.DeadlineExceeded},
		{name: "readback disconnected", readErr: io.EOF},
		{name: "pane exited after approval", readErr: &herdrapi.APIError{Code: herdrapi.CodeNotFound}},
		{name: "plain text fallback", readErr: io.EOF, failCardUpdate: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			a := blockedAgent()
			h.reg.setAgents(a)
			gets := 0
			client := &herdrapi.RecordingClient{
				OnAgentGet: func(context.Context, string) (herdrapi.AgentInfo, error) {
					gets++
					if gets > 1 && tt.readErr != nil {
						return herdrapi.AgentInfo{}, tt.readErr
					}
					return herdrapi.AgentInfo{PaneID: a.PaneID, Agent: &a.Kind, AgentStatus: string(a.Status), StateChangeSeq: a.StateSeq}, nil
				},
				OnAgentSendKeys: func(context.Context, string, []string) error { return tt.writeErr },
			}
			controller, err := agents.NewController(client, agents.WithInputClock(func() time.Time { return epoch }), agents.WithSettleDelay(time.Nanosecond))
			if err != nil {
				t.Fatal(err)
			}
			h.b.deps.Controller = controller
			if tt.failCardUpdate {
				h.b.deps.Bot = &flakyBot{fakeBot: h.bot, updateErr: errors.New("card update failed")}
			}
			action := cardPress(t, a, "1")
			pressed(t, h, action)
			var shown string
			if tt.failCardUpdate {
				shown = lastText(t, h)
			} else {
				shown = disarmedCard(t, h)
			}
			for _, falseClaim := range []string{"NOT sent", "Nothing was sent", "Nothing reached", "no key was sent"} {
				if strings.Contains(shown, falseClaim) {
					t.Fatalf("key write was attempted but the user was told %q: %s", falseClaim, shown)
				}
			}
			if !strings.Contains(shown, "not confirmed") || !strings.Contains(shown, "Do not repeat") {
				t.Fatalf("uncertain approval lacks outcome/retry guidance: %s", shown)
			}
			// Neither platform redelivery nor another press of the consumed card
			// is allowed to repeat the approval while its outcome is unknown.
			pressed(t, h, action)
			action.EventID = "second-press"
			pressed(t, h, action)
			if got := client.Count("agent.send_keys"); got != 1 {
				t.Fatalf("key writes after duplicate/second press = %d; want 1", got)
			}
		})
	}
}

func TestUnclassifiedCardFailureDoesNotClaimDefinitiveRefusal(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)
	h.ctrl.keyErr = errors.New("dial unix /tmp/herdr.sock: connection refused")
	pressed(t, h, cardPress(t, a, "1"))
	shown := disarmedCard(t, h)
	if strings.Contains(shown, "NOT sent") || !strings.Contains(shown, "not confirmed") {
		t.Fatalf("an unclassified controller failure made a definitive delivery claim: %s", shown)
	}
}

func TestInterruptReadbackFailureIsReportedAsUnconfirmed(t *testing.T) {
	h := newHarness(t)
	a := blockedAgent()
	h.reg.setAgents(a)
	gets := 0
	client := &herdrapi.RecordingClient{OnAgentGet: func(context.Context, string) (herdrapi.AgentInfo, error) {
		gets++
		if gets > 1 {
			return herdrapi.AgentInfo{}, &herdrapi.APIError{Code: herdrapi.CodeNotFound}
		}
		return herdrapi.AgentInfo{PaneID: a.PaneID, Agent: &a.Kind, AgentStatus: string(a.Status), StateChangeSeq: a.StateSeq}, nil
	}}
	controller, err := agents.NewController(client, agents.WithInputClock(func() time.Time { return epoch }), agents.WithSettleDelay(time.Nanosecond))
	if err != nil {
		t.Fatal(err)
	}
	h.b.deps.Controller = controller
	h.b.installHandlers()
	handler, _ := h.bot.handlers()
	if err := handler(context.Background(), inbound("/stop "+a.PaneID)); err != nil {
		t.Fatal(err)
	}
	shown := lastText(t, h)
	if strings.Contains(shown, "Could not send esc") || !strings.Contains(shown, "not confirmed") || client.Count("agent.send_keys") != 1 {
		t.Fatalf("interrupt response misreported an already-attempted key: %s", shown)
	}
}
