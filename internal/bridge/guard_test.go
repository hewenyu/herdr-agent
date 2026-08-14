package bridge

import (
	"context"
	"errors"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/dedup"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

// TestAuthorizedIsExactAndDefaultDeny. This one comparison is the security
// boundary of the product: everything past it types into a live terminal, and
// the herdr socket it reaches has no authentication of its own (G10).
func TestAuthorizedIsExactAndDefaultDeny(t *testing.T) {
	h := newHarness(t, func(d *Deps) {
		d.AllowedOpenIDs = []string{testOwner, "ou_second"}
	})

	tests := []struct {
		name   string
		openID string
		want   bool
	}{
		{"configured", testOwner, true},
		{"second entry", "ou_second", true},
		{"stranger", testStranger, false},
		{"empty", "", false},
		{"whitespace", "   ", false},
		{"padded", " " + testOwner + " ", false},
		{"prefix", testOwner[:len(testOwner)-1], false},
		{"suffixed", testOwner + "x", false},
		{"case folded", "OU_A90A043A4D5ADA881180931D822651DB", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := h.b.authorized(tt.openID); got != tt.want {
				t.Fatalf("authorized(%q) = %v, want %v", tt.openID, got, tt.want)
			}
		})
	}
}

// TestUnauthorizedEventsGetNoReplyAtAll covers both entry points.
//
// Silence is the requirement, not politeness (S2 §3.4): any reply — including
// "you are not allowed" — confirms that the bot exists, that it is online, and
// that an allowlist is in force. The WARN in the log is the only trace.
func TestUnauthorizedEventsGetNoReplyAtAll(t *testing.T) {
	tests := []struct {
		name string
		ev   inboundEvent
	}{
		{"message from a stranger", messageEvent(lark.Msg{EventID: "e1", UserID: testStranger, ChatID: "oc_x"})},
		{"message with no sender", messageEvent(lark.Msg{EventID: "e2", ChatID: "oc_x"})},
		{"card press by a stranger", actionEvent(lark.Action{EventID: "e3", Operator: testStranger, ChatID: "oc_x"})},
		{"card press with no operator", actionEvent(lark.Action{EventID: "e4", ChatID: "oc_x"})},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			ran := false

			err := h.b.guard(context.Background(), tt.ev, func(context.Context) error {
				ran = true
				return nil
			})

			if !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("guard = %v, want ErrUnauthorized", err)
			}
			if ran {
				t.Fatal("the handler ran for an unauthorized sender")
			}
			if sends := h.bot.sends(); len(sends) != 0 {
				t.Fatalf("the bridge replied to an unauthorized sender: %+v", sends)
			}
			if ups := h.bot.cardUpdates(); len(ups) != 0 {
				t.Fatalf("the bridge updated a card for an unauthorized sender: %+v", ups)
			}
			// Authorization comes FIRST: a dedup entry would let a stranger
			// probe the bridge by watching which of two identical events
			// behaves differently.
			if ops := h.dedup.history(); len(ops) != 0 {
				t.Fatalf("an unauthorized event touched the dedup store: %+v", ops)
			}
		})
	}
}

// TestGuardDedupsBeforeAnySideEffect is the G14 guard. Feishu redelivers an
// event whose handler failed, byte-identical, about five minutes later; here a
// redelivery means re-injecting a command into a live coding agent.
func TestGuardDedupsBeforeAnySideEffect(t *testing.T) {
	h := newHarness(t)
	ev := messageEvent(lark.Msg{EventID: "e-dup", UserID: testOwner, ChatID: testChat})

	runs := 0
	run := func(context.Context) error { runs++; return nil }

	if err := h.b.guard(context.Background(), ev, run); err != nil {
		t.Fatalf("first delivery: %v", err)
	}
	if err := h.b.guard(context.Background(), ev, run); err != nil {
		t.Fatalf("redelivery: %v", err)
	}

	if runs != 1 {
		t.Fatalf("handler ran %d times, want 1", runs)
	}
	ops := h.dedup.history()
	if len(ops) != 2 || ops[0].Op != "SeenOrMark" || ops[1].Op != "SeenOrMark" {
		t.Fatalf("dedup ops = %+v", ops)
	}
	if ops[0].NS != dedup.NSMessage || ops[0].Key != "e-dup" {
		t.Errorf("marked %q/%q, want %q/e-dup", ops[0].NS, ops[0].Key, dedup.NSMessage)
	}
}

// TestGuardUnmarksWhenTheHandlerFails: a failed handler must leave the event
// re-deliverable, or Feishu's retry is swallowed as "already seen" and the
// user's command is lost with no error anywhere.
func TestGuardUnmarksWhenTheHandlerFails(t *testing.T) {
	h := newHarness(t)
	ev := actionEvent(lark.Action{EventID: "e-fail", Operator: testOwner, ChatID: testChat})
	boom := errors.New("herdr socket closed")

	attempts := 0
	err := h.b.guard(context.Background(), ev, func(context.Context) error {
		attempts++
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("guard = %v, want the handler error", err)
	}

	ops := h.dedup.history()
	want := []dedupOp{
		{"SeenOrMark", dedup.NSCard, "e-fail"},
		{"Unmark", dedup.NSCard, "e-fail"},
	}
	if len(ops) != len(want) {
		t.Fatalf("dedup ops = %+v, want %+v", ops, want)
	}
	for i := range want {
		if ops[i] != want[i] {
			t.Fatalf("dedup op %d = %+v, want %+v", i, ops[i], want[i])
		}
	}

	// And the redelivery really does get a second chance.
	if err := h.b.guard(context.Background(), ev, func(context.Context) error {
		attempts++
		return nil
	}); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("handler ran %d times across the failure and the retry, want 2", attempts)
	}
}

// TestGuardKeepsTheMarkWhenTheHandlerSucceeds is the other half: a successful
// handler's event must stay marked, or a redelivery re-runs the command.
func TestGuardKeepsTheMarkWhenTheHandlerSucceeds(t *testing.T) {
	h := newHarness(t)
	ev := actionEvent(lark.Action{EventID: "e-ok", Operator: testOwner})

	if err := h.b.guard(context.Background(), ev, func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	for _, op := range h.dedup.history() {
		if op.Op == "Unmark" {
			t.Fatalf("a successful handler un-marked its event: %+v", h.dedup.history())
		}
	}
}

// TestGuardWithoutAnEventIDStillRuns. Feishu always sends an id and lark
// synthesises one for headerless card presses, so this is a cannot-happen —
// but swallowing an authorized user's command is worse than the risk of acting
// on it twice.
func TestGuardWithoutAnEventIDStillRuns(t *testing.T) {
	h := newHarness(t)
	ran := 0

	ev := messageEvent(lark.Msg{UserID: testOwner, ChatID: testChat})
	for range 2 {
		if err := h.b.guard(context.Background(), ev, func(context.Context) error {
			ran++
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}

	if ran != 2 {
		t.Fatalf("handler ran %d times, want 2 (no id means no deduplication)", ran)
	}
	if ops := h.dedup.history(); len(ops) != 0 {
		t.Fatalf("an event without an id was written to the dedup store: %+v", ops)
	}
}

// TestGuardSubjectsAreFixedPerEntryPoint: the authorization subject is chosen
// by the constructor, not by the handler, so a new entry point cannot
// accidentally authorize some other field that happened to look plausible.
func TestGuardSubjectsAreFixedPerEntryPoint(t *testing.T) {
	msg := messageEvent(lark.Msg{EventID: "e1", UserID: testOwner, ChatID: "oc_a"})
	if msg.Actor != testOwner || msg.NS != dedup.NSMessage || msg.EventID != "e1" {
		t.Errorf("messageEvent = %+v", msg)
	}
	act := actionEvent(lark.Action{EventID: "e2", Operator: testOwner, ChatID: "oc_b"})
	if act.Actor != testOwner || act.NS != dedup.NSCard || act.EventID != "e2" {
		t.Errorf("actionEvent = %+v", act)
	}
	if msg.NS == act.NS {
		t.Error("messages and card presses share a dedup namespace; their TTLs differ by design")
	}
}
