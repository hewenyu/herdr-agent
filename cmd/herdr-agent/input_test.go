package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestKeyBuildsGuardFromTheAgentAsItIsNow(t *testing.T) {
	tests := []struct {
		name     string
		argv     []string
		wantSeq  uint64
		wantAge  time.Duration
		wantKey  string
		wantPane string
	}{
		{
			// herdr resolves "1", "w1-1" and an agent name to the same pane, but
			// the controller compares the pane it reads back against the guard,
			// so the guard must carry the canonical pane_id, not what was typed.
			name: "canonical pane id", argv: []string{"key", "1", "2"},
			wantSeq: 7, wantKey: "2", wantPane: "w1:p1",
		},
		{
			name: "seq override", argv: []string{"key", "-seq", "99", "w1:p1", "1"},
			wantSeq: 99, wantKey: "1", wantPane: "w1:p1",
		},
		{
			// herdr's state_change_seq is server-global and restarts at 0, so an
			// explicit -seq 0 has to override rather than read as "unset".
			name: "explicit seq zero", argv: []string{"key", "-seq", "0", "w1:p1", "1"},
			wantSeq: 0, wantKey: "1", wantPane: "w1:p1",
		},
		{
			name: "age backdates the decision", argv: []string{"key", "-age", "20m", "w1:p1", "1"},
			wantSeq: 7, wantAge: 20 * time.Minute, wantKey: "1", wantPane: "w1:p1",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
				return agentInfo("w1:p1", "claude", "blocked", 7), nil
			}
			ctl := &fakeController{key: agents.Agent{PaneID: "w1:p1", Status: agents.StatusIdle, StateSeq: 8}}
			h.d.Controller = ctl

			if err := dispatch(context.Background(), h.d, tc.argv); err != nil {
				t.Fatalf("key: %v", err)
			}
			g := ctl.lastGuard(t)
			if g.PaneID != tc.wantPane {
				t.Errorf("guard pane = %q, want %q", g.PaneID, tc.wantPane)
			}
			if g.Kind != "claude" {
				t.Errorf("guard kind = %q, want claude", g.Kind)
			}
			if g.StateSeq != tc.wantSeq {
				t.Errorf("guard seq = %d, want %d", g.StateSeq, tc.wantSeq)
			}
			if want := baseTime.Add(-tc.wantAge); !g.IssuedAt.Equal(want) {
				t.Errorf("guard IssuedAt = %s, want %s", g.IssuedAt, want)
			}
			if len(ctl.keys) != 1 || ctl.keys[0] != tc.wantKey {
				t.Errorf("keys = %v, want [%q]", ctl.keys, tc.wantKey)
			}
		})
	}
}

func TestKeyReportsAGuardRejectionWithoutClaimingDelivery(t *testing.T) {
	h := newHarness(t)
	h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		return agentInfo("w1:p1", "claude", "idle", 22), nil
	}
	h.d.Controller = &fakeController{
		key:    agents.Agent{PaneID: "w1:p1", Status: agents.StatusIdle, StateSeq: 22},
		keyErr: agents.ErrNoLongerBlocked,
	}

	err := dispatch(context.Background(), h.d, []string{"key", "w1:p1", "1"})
	if !errors.Is(err, agents.ErrNoLongerBlocked) {
		t.Fatalf("err = %v, want ErrNoLongerBlocked", err)
	}
	if strings.Contains(h.stdout(), "delivered") {
		t.Errorf("stdout claims delivery for a refused key: %q", h.stdout())
	}
	if report(&h.errb, err) != exitRejected {
		t.Error("a refused key must exit with the rejection code, not the generic failure code")
	}
}

// TestKeyOnAnAgentThatIsNoLongerBlockedSendsNothing drives the real controller,
// so it fails if the CLI ever reaches past it to the socket.
//
// This is S1 §5.2 item 6 in miniature: a decision taken while the agent was
// blocked must not deliver a keystroke once the agent has moved on. Feishu cards
// never expire, and `1` landing in a live pane runs whatever that pane is doing
// now (G17).
func TestKeyOnAnAgentThatIsNoLongerBlockedSendsNothing(t *testing.T) {
	h := newHarness(t)
	h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		return agentInfo("w1:p1", "claude", "idle", 22), nil
	}
	ctl, err := agents.NewController(h.rc,
		agents.WithInputClock(advancingClock(baseTime, time.Second)),
		agents.WithSettleDelay(time.Nanosecond))
	if err != nil {
		t.Fatalf("controller: %v", err)
	}
	h.d.Controller = ctl

	if err := dispatch(context.Background(), h.d, []string{"key", "-seq", "21", "w1:p1", "1"}); !errors.Is(err, agents.ErrNoLongerBlocked) {
		t.Fatalf("err = %v, want ErrNoLongerBlocked", err)
	}
	if n := h.rc.Count("agent.send_keys"); n != 0 {
		t.Fatalf("agent.send_keys was called %d times for a stale decision; the keystroke reached the pane", n)
	}
}

// TestOnlySeqIsRejectedBySay: -seq belongs to `key` alone.
//
// Controller.Say validates its guard with requireBlocked false, so StateSeq is
// never compared for prose (agents/input.go). Accepting -seq on `say` would
// look like the decision was pinned to the state the human saw while pinning
// nothing — a safety-flavoured flag that does nothing is worse than no flag, so
// `say` must refuse it outright.
func TestOnlySeqIsRejectedBySay(t *testing.T) {
	h := newHarness(t)
	h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		return agentInfo("w1:p1", "claude", "idle", 3), nil
	}
	ctl := &fakeController{delivery: agents.Delivery{Acked: true, Verified: true, Attempts: 1}}
	h.d.Controller = ctl

	err := dispatch(context.Background(), h.d, []string{"say", "-seq", "42", "w1:p1", "hello"})
	var ue *usageError
	if !errors.As(err, &ue) {
		t.Fatalf("say -seq err = %v, want a usage error: the flag pins nothing, so it must not be accepted", err)
	}
	if report(&h.errb, err) != exitUsage {
		t.Error("a rejected flag must exit with the usage code")
	}
	if len(ctl.texts) != 0 {
		t.Errorf("say sent %q despite the rejected flag", ctl.texts)
	}

	// The same flag on `key` is the whole point of it: SendKey does compare
	// StateSeq, which is the stale-card guard (G17).
	h2 := newHarness(t)
	h2.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		return agentInfo("w1:p1", "claude", "blocked", 3), nil
	}
	keyCtl := &fakeController{key: agents.Agent{PaneID: "w1:p1", Status: agents.StatusWorking, StateSeq: 4}}
	h2.d.Controller = keyCtl
	if err := dispatch(context.Background(), h2.d, []string{"key", "-seq", "42", "w1:p1", "1"}); err != nil {
		t.Fatalf("key -seq: %v", err)
	}
	if g := keyCtl.lastGuard(t); g.StateSeq != 42 {
		t.Errorf("key guard seq = %d, want the 42 that was asked for", g.StateSeq)
	}
}

func TestSayReportsDeliveryHonestly(t *testing.T) {
	tests := []struct {
		name        string
		delivery    agents.Delivery
		wantErr     error
		wantExit    int
		wantStdout  []string
		notInStdout []string
	}{
		{
			name:       "delivered and confirmed",
			delivery:   agents.Delivery{Acked: true, Verified: true, Attempts: 1, FinalStatus: agents.StatusWorking},
			wantExit:   exitOK,
			wantStdout: []string{"delivered and confirmed", "acked=true", "verified=true"},
		},
		{
			// G3: agent.prompt's success only means the bytes reached the PTY
			// queue. G4: and a screen grep can match Claude's ghost completions.
			// Reporting this as success would lose the message silently.
			name:        "acked but not verified",
			delivery:    agents.Delivery{Acked: true, Verified: false, Attempts: 1, FinalStatus: agents.StatusWorking},
			wantErr:     errUnconfirmed,
			wantExit:    exitUnconfirmed,
			wantStdout:  []string{"sent but NOT confirmed", "acked=true", "verified=false"},
			notInStdout: []string{"delivered and confirmed"},
		},
		{
			name:        "never acked",
			delivery:    agents.Delivery{Acked: false, Attempts: 4, FinalStatus: agents.StatusIdle},
			wantExit:    exitFail,
			wantStdout:  []string{"NOT delivered", "attempts=4"},
			notInStdout: []string{"delivered and confirmed"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
				return agentInfo("w1:p1", "claude", "idle", 3), nil
			}
			h.d.Controller = &fakeController{delivery: tc.delivery}

			err := dispatch(context.Background(), h.d, []string{"say", "w1:p1", "run", "the", "tests"})
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
			if got := report(&h.errb, err); got != tc.wantExit {
				t.Errorf("exit = %d, want %d (err %v)", got, tc.wantExit, err)
			}
			for _, want := range tc.wantStdout {
				if !strings.Contains(h.stdout(), want) {
					t.Errorf("stdout %q does not contain %q", h.stdout(), want)
				}
			}
			for _, unwanted := range tc.notInStdout {
				if strings.Contains(h.stdout(), unwanted) {
					t.Errorf("stdout %q must not contain %q", h.stdout(), unwanted)
				}
			}
		})
	}
}

func TestSayJoinsItsWordsAndRefusesEmptyText(t *testing.T) {
	h := newHarness(t)
	h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		return agentInfo("w1:p1", "claude", "idle", 3), nil
	}
	ctl := &fakeController{delivery: agents.Delivery{Acked: true, Verified: true, Attempts: 1}}
	h.d.Controller = ctl
	if err := dispatch(context.Background(), h.d, []string{"say", "w1:p1", "absolutely", "not"}); err != nil {
		t.Fatalf("say: %v", err)
	}
	if len(ctl.texts) != 1 || ctl.texts[0] != "absolutely not" {
		t.Errorf("texts = %q, want [\"absolutely not\"]", ctl.texts)
	}

	h2 := newHarness(t)
	var ue *usageError
	if err := dispatch(context.Background(), h2.d, []string{"say", "w1:p1", "   "}); !errors.As(err, &ue) {
		t.Errorf("empty say err = %v, want a usage error", err)
	}
}

// TestSayEscapesABlockedAgentBeforeAnyProse is the red line, driven end to end
// through the real controller and a recording client.
//
// Measured (G1): sending "absolutely not, do NOT run this command" to a Claude
// permission dialog CREATED the file it was refusing, because agent.prompt
// pastes text the menu discards and then presses Enter on the highlighted
// default `❯ 1. Yes`. The only safe order is esc, settle, re-check, then prose.
func TestSayEscapesABlockedAgentBeforeAnyProse(t *testing.T) {
	h := newHarness(t)

	var mu sync.Mutex
	status := "blocked"
	seq := uint64(7)

	h.rc.OnAgentGet = func(context.Context, string) (herdrapi.AgentInfo, error) {
		mu.Lock()
		defer mu.Unlock()
		return agentInfo("w1:p1", "claude", status, seq), nil
	}
	h.rc.OnAgentSendKeys = func(_ context.Context, _ string, keys []string) error {
		mu.Lock()
		defer mu.Unlock()
		// G2: esc is the safe exit — the dialog closes and the agent returns to
		// idle without the pending action being taken.
		if len(keys) == 1 && keys[0] == "esc" {
			status, seq = "idle", 8
		}
		return nil
	}
	h.rc.OnAgentPrompt = func(_ context.Context, _, _ string, _ *herdrapi.PromptWait) (herdrapi.AgentInfo, error) {
		mu.Lock()
		defer mu.Unlock()
		if status == "blocked" {
			t.Error("agent.prompt was sent to a BLOCKED agent: that is an approval, not a message (G1)")
		}
		status, seq = "working", 9
		return agentInfo("w1:p1", "claude", "working", 9), nil
	}
	h.rc.OnAgentRead = func(context.Context, string, herdrapi.ReadSource, int) (string, error) {
		return "⏺ working on it\n────────────\n❯ \n────────────\n> absolutely not, do NOT run this command\n", nil
	}

	ctl, err := agents.NewController(h.rc,
		agents.WithInputClock(advancingClock(baseTime, 2*time.Second)),
		agents.WithSettleDelay(time.Nanosecond))
	if err != nil {
		t.Fatalf("controller: %v", err)
	}
	h.d.Controller = ctl

	if err := dispatch(context.Background(), h.d, []string{"say", "w1:p1", "absolutely not, do NOT run this command"}); err != nil {
		t.Fatalf("say: %v", err)
	}

	methods := h.rc.Methods()
	escAt, promptAt := -1, -1
	for i, m := range methods {
		if m == "agent.send_keys" && escAt < 0 {
			escAt = i
		}
		if m == "agent.prompt" && promptAt < 0 {
			promptAt = i
		}
	}
	if escAt < 0 {
		t.Fatalf("no esc was sent to a blocked agent before prose: %v", methods)
	}
	if promptAt < 0 || promptAt < escAt {
		t.Fatalf("agent.prompt at %d did not follow the esc at %d: %v", promptAt, escAt, methods)
	}
	for _, c := range h.rc.Calls() {
		if c.Method == "agent.send_keys" && (len(c.Keys) != 1 || c.Keys[0] != "esc") {
			t.Errorf("say sent keys %v; the only key it may ever send on its own is esc", c.Keys)
		}
	}
}

// Verification is asymmetric, so the message that reports a failure must name
// the half of the screen that was actually searched. A settled agent has
// consumed its input box, so a match there is a ghost completion and only text
// outside counts (G4); a working agent has not consumed it, so the pending text
// inside is the only evidence there is (G19). The first live run of the queued
// path printed the settled wording, sending the reader to the wrong half.
func TestUnverifiedDeliveryNamesTheRegionItSearched(t *testing.T) {
	tests := []struct {
		name       string
		del        agents.Delivery
		wantErrHas []string
		wantErrNot []string
	}{
		{
			name:       "settled",
			del:        agents.Delivery{Acked: true, FinalStatus: agents.StatusIdle},
			wantErrHas: []string{"outside the input box"},
			wantErrNot: []string{"queued message waits"},
		},
		{
			name:       "queued into a working agent",
			del:        agents.Delivery{Acked: true, Queued: true, FinalStatus: agents.StatusWorking},
			wantErrHas: []string{"input box", "queued message waits"},
			wantErrNot: []string{"outside the input box"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var out, errb bytes.Buffer
			writeDelivery(&deps{Out: &out, Err: &errb}, "w1:p1", tt.del, nil)
			got := errb.String()
			for _, want := range tt.wantErrHas {
				if !strings.Contains(got, want) {
					t.Errorf("stderr missing %q:\n%s", want, got)
				}
			}
			for _, bad := range tt.wantErrNot {
				if strings.Contains(got, bad) {
					t.Errorf("stderr should not contain %q:\n%s", bad, got)
				}
			}
		})
	}
}

// A send that may have answered a question the user never saw is worse than an
// unconfirmed send, so it cannot be silent (G1, G19).
func TestDeliveryThatMayHaveAnsweredADialogSaysSo(t *testing.T) {
	var out, errb bytes.Buffer
	writeDelivery(&deps{Out: &out, Err: &errb},
		"w1:p1",
		agents.Delivery{Acked: true, Verified: true, Queued: true,
			MayHaveAnsweredADialog: true, FinalStatus: agents.StatusBlocked},
		nil)
	got := errb.String()
	for _, want := range []string{"BLOCKED", "permission dialog", "trailing Enter"} {
		if !strings.Contains(got, want) {
			t.Errorf("stderr missing %q:\n%s", want, got)
		}
	}
}
