package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/outbound"
)

const testPane = "w1:p1"

func TestSendRequiresATarget(t *testing.T) {
	h := newHarness(t)

	_, err := h.b.send(context.Background(), outgoing{Text: "hello", PaneID: testPane})
	if !errors.Is(err, ErrNoSendTarget) {
		t.Fatalf("send = %v, want ErrNoSendTarget", err)
	}
	if sends := h.bot.sends(); len(sends) != 0 {
		t.Fatalf("a message with no target was still handed to the SDK: %+v", sends)
	}
}

// TestSendBindsEveryDeliveredMessageToItsPane. Reply-to-route is the primary
// interaction model (S2 §3.5): it is what lets one chat drive several agents
// without a /use command. An unbound message is a dead end on the phone.
func TestSendBindsEveryDeliveredMessageToItsPane(t *testing.T) {
	h := newHarness(t)

	ids, err := h.b.send(context.Background(), outgoing{
		ChatID: testChat,
		Text:   "the agent said hello",
		PaneID: testPane,
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(ids) != 1 {
		t.Fatalf("ids = %v, want one", ids)
	}

	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].MessageID != ids[0] || bound[0].PaneID != testPane {
		t.Fatalf("Bind calls = %+v, want %s -> %s", bound, ids[0], testPane)
	}
}

func TestSendDoesNotBindWhenNoPaneIsNamed(t *testing.T) {
	h := newHarness(t)

	if _, err := h.b.send(context.Background(), outgoing{ChatID: testChat, Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	if bound := h.routes.bound(); len(bound) != 0 {
		t.Fatalf("a message about no agent was bound to one: %+v", bound)
	}
}

// TestSendSplitsLongTextAndBindsEveryChunk: a reply to any of the bubbles must
// route back, so every id is bound, not just the first.
func TestSendSplitsLongTextAndBindsEveryChunk(t *testing.T) {
	h := newHarness(t)
	long := strings.Repeat("the agent is thinking out loud. ", 500) // ~16k runes

	ids, err := h.b.send(context.Background(), outgoing{
		ChatID: testChat,
		Text:   long,
		PaneID: testPane,
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(ids) < 2 {
		t.Fatalf("%d message(s) for %d runes; it was not split", len(ids), len([]rune(long)))
	}

	for i, c := range h.bot.sends() {
		if n := len([]rune(c.Out.Text)); n > outbound.MaxMessageRunes {
			t.Errorf("chunk %d is %d runes, over Feishu's %d limit", i+1, n, outbound.MaxMessageRunes)
		}
	}
	if got, want := len(h.routes.bound()), len(ids); got != want {
		t.Fatalf("%d Bind calls for %d messages", got, want)
	}
}

// TestSendDowngradesAMarkdownTable is a measured Feishu behaviour, not a
// stylistic choice: the post renderer turns a GitHub-style table into a BLANK
// bubble. The message is delivered, the user sees an empty box, and nothing
// reports a failure anywhere.
func TestSendDowngradesAMarkdownTable(t *testing.T) {
	h := newHarness(t)
	md := strings.Join([]string{
		"| pane | status |",
		"|------|--------|",
		"| w1:p1 | blocked |",
	}, "\n")

	if _, err := h.b.send(context.Background(), outgoing{
		ChatID:   testChat,
		Markdown: md,
		Title:    "agents",
		PaneID:   testPane,
	}); err != nil {
		t.Fatalf("send: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 1 {
		t.Fatalf("%d sends, want 1", len(sends))
	}
	out := sends[0].Out
	if out.Markdown != "" {
		t.Fatalf("the table was sent as markdown and would render as a blank bubble: %q", out.Markdown)
	}
	if out.Text == "" {
		t.Fatal("the downgraded message has no text at all")
	}
	// The content has to survive the downgrade; an empty bubble and a bubble
	// with no rows are the same failure.
	if !strings.Contains(out.Text, "w1:p1") || !strings.Contains(out.Text, "blocked") {
		t.Errorf("the table's rows did not survive the downgrade: %q", out.Text)
	}
}

func TestSendKeepsMarkdownWithoutATable(t *testing.T) {
	h := newHarness(t)

	if _, err := h.b.send(context.Background(), outgoing{
		ChatID:   testChat,
		Markdown: "**done** — nothing to see here",
		Title:    "claude",
		PaneID:   testPane,
	}); err != nil {
		t.Fatal(err)
	}

	out := h.bot.sends()[0].Out
	if out.Markdown == "" || out.Text != "" {
		t.Fatalf("markdown was downgraded without a table: %+v", out)
	}
	if out.Title != "claude" {
		t.Errorf("Title = %q, want the post title to survive", out.Title)
	}
}

// TestSendDowngradesOnceOnAFormatError: Feishu rejected the payload, so strip
// the markup and try again — the content is what matters, and here it is
// usually the command the user is being asked to approve.
func TestSendDowngradesOnceOnAFormatError(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrFormat))

	ids, err := h.b.send(context.Background(), outgoing{
		ChatID:   testChat,
		Markdown: "run `rm -rf /tmp/x` first",
		PaneID:   testPane,
	})
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 2 {
		t.Fatalf("%d attempts, want 2 (the original and one plain-text retry)", len(sends))
	}
	if sends[0].Out.Markdown == "" {
		t.Error("the first attempt was not the markdown one")
	}
	retry := sends[1].Out
	if retry.Markdown != "" || retry.Text == "" {
		t.Fatalf("the retry was not plain text: %+v", retry)
	}
	if !strings.Contains(retry.Text, "rm -rf /tmp/x") {
		t.Errorf("the command was lost in the downgrade: %q", retry.Text)
	}
	if bound := h.routes.bound(); len(bound) != 1 || bound[0].MessageID != ids[0] {
		t.Errorf("the downgraded message was not bound: %+v", bound)
	}
}

func TestSendGivesUpAfterASecondFormatError(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrFormat), failing(lark.ErrFormat))

	if _, err := h.b.send(context.Background(), outgoing{
		ChatID:   testChat,
		Markdown: "**hi**",
		PaneID:   testPane,
	}); err == nil {
		t.Fatal("send reported success after two format errors")
	}
	if n := len(h.bot.sends()); n != 2 {
		t.Fatalf("%d attempts, want 2: the plain-text downgrade is one-shot", n)
	}
}

// TestSendRetriesOnlyWhatNeverLeftTheMachine.
func TestSendRetriesOnlyWhatNeverLeftTheMachine(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(dialFailure())

	if _, err := h.b.send(context.Background(), outgoing{
		ChatID: testChat,
		Text:   "hello",
		PaneID: testPane,
	}); err != nil {
		t.Fatalf("send: %v", err)
	}

	if n := len(h.bot.sends()); n != 2 {
		t.Fatalf("%d attempts, want 2", n)
	}
	if backoffs := h.backoffs(); len(backoffs) != 1 || backoffs[0] != sendBackoff {
		t.Errorf("backoffs = %v, want one of %s", backoffs, sendBackoff)
	}
}

func TestSendStopsRetryingAfterTheBudget(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(dialFailure(), dialFailure(), dialFailure(), dialFailure())

	if _, err := h.b.send(context.Background(), outgoing{ChatID: testChat, Text: "hello"}); err == nil {
		t.Fatal("send reported success after every attempt failed")
	}
	if got, want := len(h.bot.sends()), maxSendRetries+1; got != want {
		t.Fatalf("%d attempts, want %d", got, want)
	}
	// Exponential, so a flapping connection is not hammered.
	if backoffs := h.backoffs(); len(backoffs) != maxSendRetries ||
		backoffs[0] != sendBackoff || backoffs[1] != 2*sendBackoff {
		t.Errorf("backoffs = %v, want %v then %v", backoffs, sendBackoff, 2*sendBackoff)
	}
}

// TestSendNeverRetriesATimeout is the rule with teeth. A timed-out request may
// already have reached Feishu; resending posts the message twice, and in this
// product a second copy of a card is a second live button aimed at a running
// agent (G14, G17).
func TestSendNeverRetriesATimeout(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{"transport timeout", timeoutError{}},
		{"feishu send_timeout", failing(lark.ErrSendTimeout)},
		{"context deadline", context.DeadlineExceeded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t)
			h.bot.failNext(tt.err)

			_, err := h.b.send(context.Background(), outgoing{
				ChatID: testChat,
				Text:   "please run the tests",
				PaneID: testPane,
			})
			if err == nil {
				t.Fatal("send reported success")
			}
			if n := len(h.bot.sends()); n != 1 {
				t.Fatalf("%d attempts for a timeout; a resend would post the message twice", n)
			}
			if backoffs := h.backoffs(); len(backoffs) != 0 {
				t.Errorf("a timeout was backed off and retried: %v", backoffs)
			}
			if bound := h.routes.bound(); len(bound) != 0 {
				t.Errorf("an undelivered message was bound for reply-routing: %+v", bound)
			}
		})
	}
}

func TestSendDoesNotRetryRateLimiting(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrRateLimited))

	if _, err := h.b.send(context.Background(), outgoing{ChatID: testChat, Text: "hi"}); err == nil {
		t.Fatal("send reported success")
	}
	// The SDK already backed off and retried inside that one call; doing it
	// again here would only deepen the hole.
	if n := len(h.bot.sends()); n != 1 {
		t.Fatalf("%d attempts, want 1", n)
	}
}

// TestSendResendsWithoutARevokedReplyTarget (S2 §3.8): the message is fine,
// only the thing it was replying to is gone.
func TestSendResendsWithoutARevokedReplyTarget(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrTargetRevoked))

	if _, err := h.b.send(context.Background(), outgoing{
		ChatID:  testChat,
		ReplyTo: "om_deleted",
		Text:    "here you go",
		PaneID:  testPane,
	}); err != nil {
		t.Fatalf("send: %v", err)
	}

	sends := h.bot.sends()
	if len(sends) != 2 {
		t.Fatalf("%d attempts, want 2", len(sends))
	}
	if sends[0].Out.ReplyMessageID != "om_deleted" {
		t.Errorf("the first attempt did not carry the reply target: %+v", sends[0].Out)
	}
	if sends[1].Out.ReplyMessageID != "" {
		t.Errorf("the retry kept the revoked reply target: %+v", sends[1].Out)
	}
}

func TestSendGivesUpWhenTheChatItselfIsRevoked(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrTargetRevoked))

	if _, err := h.b.send(context.Background(), outgoing{ChatID: testChat, Text: "hi"}); err == nil {
		t.Fatal("send reported success")
	}
	if n := len(h.bot.sends()); n != 1 {
		t.Fatalf("%d attempts, want 1: there was no reply target to drop", n)
	}
}

// TestSendReturnsWhatWasAlreadyDelivered: a partial delivery is a real state,
// and the caller may need to say so or to update one of those messages.
func TestSendReturnsWhatWasAlreadyDelivered(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(nil, timeoutError{})

	ids, err := h.b.send(context.Background(), outgoing{
		ChatID: testChat,
		Text:   strings.Repeat("chatter chatter chatter. ", 400),
		PaneID: testPane,
	})
	if err == nil {
		t.Fatal("send reported success although a chunk failed")
	}
	if len(ids) != 1 {
		t.Fatalf("ids = %v, want the one chunk that made it", ids)
	}
	if bound := h.routes.bound(); len(bound) != 1 || bound[0].MessageID != ids[0] {
		t.Errorf("the delivered chunk was not bound: %+v", bound)
	}
}

// TestSendCardIsNeitherSplitNorDowngraded: a card body is JSON, so plain-text
// fallback would post raw JSON, and splitting it would produce two invalid
// halves. The caller decides what to say instead (see PushBlocked).
func TestSendCardIsNeitherSplitNorDowngraded(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(failing(lark.ErrFormat))

	_, err := h.b.send(context.Background(), outgoing{
		ChatID: testChat,
		Card:   `{"schema":"2.0"}`,
		PaneID: testPane,
	})
	if err == nil {
		t.Fatal("send reported success")
	}
	if n := len(h.bot.sends()); n != 1 {
		t.Fatalf("%d attempts, want 1", n)
	}
	if bound := h.routes.bound(); len(bound) != 0 {
		t.Errorf("an undelivered card was bound: %+v", bound)
	}
}

func TestSendCardBindsOnSuccess(t *testing.T) {
	h := newHarness(t)

	ids, err := h.b.send(context.Background(), outgoing{
		ChatID: testChat,
		Card:   `{"schema":"2.0"}`,
		PaneID: testPane,
	})
	if err != nil {
		t.Fatal(err)
	}
	bound := h.routes.boundPanes()
	if len(bound) != 1 || bound[0].MessageID != ids[0] || bound[0].PaneID != testPane {
		t.Fatalf("Bind calls = %+v", bound)
	}
}

func TestSendRejectsAnEmptyBody(t *testing.T) {
	h := newHarness(t)

	if _, err := h.b.send(context.Background(), outgoing{ChatID: testChat}); !errors.Is(err, lark.ErrInvalidOut) {
		t.Fatalf("send = %v, want lark.ErrInvalidOut", err)
	}
}

func TestSendStopsWhenTheContextIsCancelled(t *testing.T) {
	h := newHarness(t)
	h.bot.failNext(dialFailure())

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := h.b.send(ctx, outgoing{ChatID: testChat, Text: "hi"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("send = %v, want the cancellation to surface", err)
	}
	if n := len(h.bot.sends()); n != 1 {
		t.Fatalf("%d attempts after cancellation, want 1", n)
	}
}

func TestClassifySend(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want outbound.ErrorClass
	}{
		{"nil", nil, outbound.ClassPermanent},
		{"format", failing(lark.ErrFormat), outbound.ClassFormat},
		{"rate limited", failing(lark.ErrRateLimited), outbound.ClassRateLimited},
		{"revoked", failing(lark.ErrTargetRevoked), outbound.ClassRevoked},
		{"not connected", lark.ErrNotConnected, outbound.ClassRetryable},
		{"send timeout", failing(lark.ErrSendTimeout), outbound.ClassPermanent},
		{"permission denied", failing(lark.ErrPermissionDenied), outbound.ClassPermanent},
		{"ssrf blocked", failing(lark.ErrSSRFBlocked), outbound.ClassPermanent},
		{"invalid out", lark.ErrInvalidOut, outbound.ClassPermanent},
		{"already split", lark.ErrSplit, outbound.ClassPermanent},
		{"dial failure", dialFailure(), outbound.ClassRetryable},
		{"transport timeout", timeoutError{}, outbound.ClassPermanent},
		{"unknown", errors.New("who knows"), outbound.ClassPermanent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifySend(tt.err); got != tt.want {
				t.Fatalf("classifySend(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// TestSendBackoffIsBounded keeps the retry budget from turning into a stall:
// the whole pause is under a second, because a human is waiting on a phone.
func TestSendBackoffIsBounded(t *testing.T) {
	total := time.Duration(0)
	d := sendBackoff
	for range maxSendRetries {
		total += d
		d *= 2
	}
	if total > time.Second {
		t.Fatalf("total backoff is %s; a user waiting on a phone would notice", total)
	}
}
