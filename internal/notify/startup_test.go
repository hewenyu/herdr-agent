package notify

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// The registry and bridge run in separate goroutines. A notifier which starts
// after the first successful poll must still report an existing approval or
// finished answer, even when that pane never changes state again.
func TestLateNotifierReportsExistingAgent(t *testing.T) {
	for _, status := range []agents.Status{agents.StatusBlocked, agents.StatusDone, agents.StatusIdle, agents.StatusWorking} {
		t.Run(string(status), func(t *testing.T) {
			kind := "claude"
			client := &herdrapi.RecordingClient{OnAgentList: func(context.Context) ([]herdrapi.AgentInfo, error) {
				return []herdrapi.AgentInfo{{PaneID: "w1:p1", Agent: &kind, AgentStatus: string(status), StateChangeSeq: 7}}, nil
			}}
			reg, err := agents.NewRegistry(client, agents.WithPollInterval(time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			// This early observer provides a deterministic barrier: receiving its
			// event proves reconcile finished before the notifier subscribes.
			early := reg.Subscribe()
			ctx, cancel := context.WithCancel(context.Background())
			registryDone := make(chan error, 1)
			go func() { registryDone <- reg.Run(ctx) }()
			t.Cleanup(func() {
				cancel()
				select {
				case err := <-registryDone:
					if !errors.Is(err, context.Canceled) {
						t.Errorf("registry: %v", err)
					}
				case <-time.After(testTimeout):
					t.Error("registry did not stop")
				}
			})
			select {
			case <-early:
			case <-time.After(testTimeout):
				t.Fatal("registry did not publish its initial snapshot")
			}

			sink, tm := &recordingSink{}, newFakeTimer()
			n := New(reg, newFakeExtractor(), sink).(*notifier)
			n.newTimer = func() timer { return tm }
			n.log = discardLogger()
			notifierDone := make(chan error, 1)
			go func() { notifierDone <- n.Run(ctx) }()
			t.Cleanup(func() {
				cancel()
				select {
				case err := <-notifierDone:
					if !errors.Is(err, context.Canceled) {
						t.Errorf("notifier: %v", err)
					}
				case <-time.After(testTimeout):
					t.Error("notifier did not stop")
				}
			})
			select {
			case <-tm.arms:
			case <-time.After(testTimeout):
				t.Fatal("late notifier missed the already-existing agent")
			}
			want := 0
			if status == agents.StatusBlocked || status == agents.StatusDone {
				want = 1
			}
			if got := sink.count(); got != want {
				t.Fatalf("notifications for existing %s agent = %d; want %d", status, got, want)
			}
		})
	}
}
