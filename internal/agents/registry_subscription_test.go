package agents

import (
	"fmt"
	"sync"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

func TestLateSubscriberGetsCompleteOrderedSnapshotAndNextTransition(t *testing.T) {
	registered, err := NewRegistry(&herdrapi.RecordingClient{}, withSubscriberBuffer(1))
	if err != nil {
		t.Fatal(err)
	}
	r := registered.(*registry)
	var initial []herdrapi.AgentInfo
	for i := 79; i >= 0; i-- {
		status := "blocked"
		if i%2 == 0 {
			status = "done"
		}
		initial = append(initial, info(fmt.Sprintf("w1:p%02d", i), "claude", status, uint64(i+1)))
	}
	r.reconcile(initial)
	sub := r.Subscribe()
	initial[0].AgentStatus = "working"
	initial[0].StateChangeSeq = 100
	r.reconcile(initial)
	got := drain(sub)
	if len(got) != 81 || r.dropped() != 0 {
		t.Fatalf("late subscription lost snapshot or first update: len=%d dropped=%d", len(got), r.dropped())
	}
	for i, event := range got[:80] {
		if event.Agent.PaneID != fmt.Sprintf("w1:p%02d", i) || event.From != StatusUnknown || event.Seq != uint64(i+1) || !event.At.Equal(event.Agent.SeenAt) {
			t.Fatalf("unexpected snapshot transition %d: %+v", i, event)
		}
	}
	if last := got[80]; last.From != StatusBlocked || last.To != StatusWorking || last.Seq != 100 {
		t.Fatalf("next transition did not follow replay: %+v", last)
	}
}

func TestSubscribeConcurrentWithReconciliationPreservesPerPaneOrder(t *testing.T) {
	for iteration := 0; iteration < 100; iteration++ {
		registered, err := NewRegistry(&herdrapi.RecordingClient{}, withSubscriberBuffer(64))
		if err != nil {
			t.Fatal(err)
		}
		r := registered.(*registry)
		r.reconcile([]herdrapi.AgentInfo{info("w1:p1", "claude", "blocked", 1)})
		start := make(chan struct{})
		var subscribed <-chan Transition
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			subscribed = r.Subscribe()
		}()
		go func() {
			defer workers.Done()
			<-start
			for seq := uint64(2); seq <= 32; seq++ {
				r.reconcile([]herdrapi.AgentInfo{info("w1:p1", "claude", "blocked", seq)})
			}
		}()
		close(start)
		workers.Wait()
		got := drain(subscribed)
		if len(got) == 0 || got[0].From != StatusUnknown || got[len(got)-1].Seq != 32 {
			t.Fatalf("subscription did not catch current state through final update: %+v", got)
		}
		for i := 1; i < len(got); i++ {
			if got[i].Seq != got[i-1].Seq+1 || got[i].From != StatusBlocked {
				t.Fatalf("snapshot interleaved with older publication: %+v", got)
			}
		}
	}
}
