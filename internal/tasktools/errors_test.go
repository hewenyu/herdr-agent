package tasktools

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func TestValidationErrorsAreDefinitelyNotExecutedAndCanBeCorrected(t *testing.T) {
	for _, bad := range []string{
		`{"request_id":"create-001","project":"missing","text":"build"}`,
		`{"request_id":"create-001","project":"project","agent":"invalid","text":"build"}`,
		`{"request_id":"create-001","project":"project","owner_id":"bob","text":"build"}`,
		`{"request_id":"create-001","project":null,"text":"build"}`,
	} {
		t.Run(bad, func(t *testing.T) {
			s, m, c := harness(t)
			_, err := s.Call(context.Background(), "herdr_create", json.RawMessage(bad))
			if !errors.Is(err, ErrNotExecuted) || m.creates != 0 || c.count != 0 || len(s.journal.ops) != 0 {
				t.Fatalf("validation result lost its no-effect guarantee: %v", err)
			}
			_, err = s.Call(context.Background(), "herdr_create", json.RawMessage(`{"request_id":"create-001","project":"project","text":"build"}`))
			if err != nil || m.creates != 1 {
				t.Fatalf("corrected request could not execute once: %v", err)
			}
		})
	}
}

func TestSavedErrorsPreserveKnownRejectionVersusUnknownDelivery(t *testing.T) {
	for _, executed := range []bool{false, true} {
		t.Run(map[bool]string{false: "rejected-before-controller", true: "controller-response-lost"}[executed], func(t *testing.T) {
			s, m, c := harness(t)
			if executed {
				c.err = errors.New("acknowledgement lost")
			} else {
				r := m.records["owned"]
				r.Status = tasks.Completed
				m.records[r.ID] = r
			}
			args := map[string]any{"request_id": "send-0001", "task_id": "owned", "text": "continue"}
			_, err := call(s, "herdr_send", args)
			if err == nil || errors.Is(err, ErrNotExecuted) == executed {
				t.Fatalf("incorrect first execution certainty: %v", err)
			}
			restarted, err := New(s.opts)
			if err != nil {
				t.Fatal(err)
			}
			_, err = call(restarted, "herdr_send", args)
			if err == nil || errors.Is(err, ErrNotExecuted) == executed {
				t.Fatalf("restart lost execution certainty: %v", err)
			}
			want := 0
			if executed {
				want = 1
			}
			if c.count != want {
				t.Fatalf("saved error replayed terminal input: %d", c.count)
			}
		})
	}
}
