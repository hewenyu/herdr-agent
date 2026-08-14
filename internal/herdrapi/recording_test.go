package herdrapi

import (
	"context"
	"errors"
	"slices"
	"testing"
)

func TestRecordingClientRecordsEveryMethod(t *testing.T) {
	rec := &RecordingClient{}
	ctx := context.Background()

	if _, err := rec.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}
	if _, err := rec.AgentList(ctx); err != nil {
		t.Fatalf("AgentList: %v", err)
	}
	if _, err := rec.AgentGet(ctx, "w1:p1"); err != nil {
		t.Fatalf("AgentGet: %v", err)
	}
	if _, err := rec.AgentRead(ctx, "w1:p1", SourceDetection, 0); err != nil {
		t.Fatalf("AgentRead: %v", err)
	}
	if _, err := rec.PaneGet(ctx, "w1:p1"); err != nil {
		t.Fatalf("PaneGet: %v", err)
	}
	if _, err := rec.AgentPrompt(ctx, "w1:p1", "hi", nil); err != nil {
		t.Fatalf("AgentPrompt: %v", err)
	}
	if err := rec.AgentSendKeys(ctx, "w1:p1", []string{"1"}); err != nil {
		t.Fatalf("AgentSendKeys: %v", err)
	}
	if err := rec.NotificationShow(ctx, "t", "b"); err != nil {
		t.Fatalf("NotificationShow: %v", err)
	}
	if err := rec.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	want := []string{
		"ping", "agent.list", "agent.get", "agent.read",
		"pane.get", "agent.prompt", "agent.send_keys", "notification.show",
	}
	if got := rec.Methods(); !slices.Equal(got, want) {
		t.Fatalf("methods = %v, want %v", got, want)
	}
	// Structural, not behavioural: Client cannot express a forbidden method, so
	// this intersection is empty by construction and can only catch someone
	// widening the interface. The behavioural check is
	// TestForbiddenMethodCannotBeSent, which drives call() directly.
	for _, m := range rec.Methods() {
		if slices.Contains(ForbiddenMethods, m) {
			t.Errorf("recorded forbidden method %q", m)
		}
		if _, ok := allowedMethods[m]; !ok {
			t.Errorf("recorded method %q is not whitelisted", m)
		}
	}
	if rec.CloseCount() != 1 {
		t.Errorf("close count = %d", rec.CloseCount())
	}
	if rec.Count("agent.send_keys") != 1 {
		t.Errorf("send_keys count = %d", rec.Count("agent.send_keys"))
	}

	keys := rec.Calls()[6]
	if keys.Target != "w1:p1" || !slices.Equal(keys.Keys, []string{"1"}) {
		t.Errorf("send_keys call = %+v", keys)
	}

	rec.Reset()
	if len(rec.Calls()) != 0 || rec.CloseCount() != 0 {
		t.Error("Reset did not clear the log")
	}
}

// A higher layer that asks for a forbidden read source must fail in tests
// rather than in the user's live pane (G9), and no call is recorded as sent.
func TestRecordingClientEnforcesReadSource(t *testing.T) {
	tests := []struct {
		name string
		read func(rec *RecordingClient) error
	}{
		{
			name: "AgentRead",
			read: func(rec *RecordingClient) error {
				_, err := rec.AgentRead(context.Background(), "w1:p1", ReadSource("recent"), 500)
				return err
			},
		},
		{
			name: "AgentReadFull",
			read: func(rec *RecordingClient) error {
				_, _, err := rec.AgentReadFull(context.Background(), "w1:p1", ReadSource("recent"), 500)
				return err
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := &RecordingClient{}

			if err := tt.read(rec); !errors.Is(err, ErrReadSourceForbidden) {
				t.Fatalf("want ErrReadSourceForbidden, got %v", err)
			}
			if got := rec.Methods(); len(got) != 0 {
				t.Errorf("a rejected read was recorded as sent: %v", got)
			}
			rejected := rec.Rejected()
			if len(rejected) != 1 || rejected[0].Source != ReadSource("recent") || rejected[0].Lines != 500 {
				t.Fatalf("rejected = %+v", rejected)
			}
		})
	}
}

// AgentRead delegates to AgentReadFull, so neither may record twice, and both
// must answer from whichever hook is set.
func TestRecordingClientAgentReadFull(t *testing.T) {
	rec := &RecordingClient{
		OnAgentReadFull: func(context.Context, string, ReadSource, int) (string, bool, error) {
			return "cut off", true, nil
		},
	}
	ctx := context.Background()

	text, truncated, err := ReadFull(ctx, rec, "w1:p1", SourceDetection, 0)
	if err != nil || text != "cut off" || !truncated {
		t.Fatalf("ReadFull = %q, %v, %v", text, truncated, err)
	}
	if text, err := rec.AgentRead(ctx, "w1:p1", SourceVisible, 30); err != nil || text != "cut off" {
		t.Fatalf("AgentRead = %q, %v", text, err)
	}
	if n := rec.Count("agent.read"); n != 2 {
		t.Errorf("agent.read recorded %d times, want 2 (one per call, no double counting)", n)
	}

	// With only OnAgentRead set, truncated is false rather than a nil-hook zero.
	plain := &RecordingClient{
		OnAgentRead: func(context.Context, string, ReadSource, int) (string, error) { return "whole", nil },
	}
	if text, truncated, err := plain.AgentReadFull(ctx, "w1:p1", SourceVisible, 30); err != nil || text != "whole" || truncated {
		t.Fatalf("AgentReadFull = %q, %v, %v", text, truncated, err)
	}
}

func TestRecordingClientHooks(t *testing.T) {
	boom := errors.New("boom")
	rec := &RecordingClient{
		OnPing: func(context.Context) (PingResult, error) {
			return PingResult{Protocol: 19, Version: "0.8.0"}, nil
		},
		OnAgentList: func(context.Context) ([]AgentInfo, error) {
			return []AgentInfo{{PaneID: "w1:p1"}}, nil
		},
		OnAgentSendKeys: func(context.Context, string, []string) error { return boom },
	}
	ctx := context.Background()

	res, err := CheckProtocol(ctx, rec)
	if err != nil {
		t.Fatalf("CheckProtocol: %v", err)
	}
	if res.Version != "0.8.0" {
		t.Errorf("version = %q", res.Version)
	}
	agents, err := rec.AgentList(ctx)
	if err != nil || len(agents) != 1 || agents[0].PaneID != "w1:p1" {
		t.Fatalf("AgentList = %v, %v", agents, err)
	}
	if err := rec.AgentSendKeys(ctx, "w1:p1", []string{"1"}); !errors.Is(err, boom) {
		t.Fatalf("want the hook's error, got %v", err)
	}
	// The attempt is recorded even though the hook failed: a test asserting
	// "no key was sent" must see it.
	if rec.Count("agent.send_keys") != 1 {
		t.Errorf("failed send_keys was not recorded")
	}
}

func TestForbiddenMethodsListMatchesTheContract(t *testing.T) {
	// The contract names these explicitly; losing one would silently allow it.
	for _, m := range []string{"agent.focus", "pane.focus", "server.stop", "pane.close", "workspace.close"} {
		if !slices.Contains(ForbiddenMethods, m) {
			t.Errorf("%q is missing from ForbiddenMethods", m)
		}
	}
}
