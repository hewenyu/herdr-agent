package lark

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// countPosts returns how many messages the bot actually created.
func countPosts(h *stubHTTP) int {
	n := 0
	for _, c := range h.snapshot() {
		if c.Method == "POST" && c.Path == "/open-apis/im/v1/messages" {
			n++
		}
	}
	return n
}

// TestSendIsOneMessage is the reply-routing regression test.
//
// channelImpl.Send splits Text with splitPlain and Markdown with
// SplitWithCodeFences at Outbound.TextChunkLimit, whose SDK default is 3500 —
// BELOW internal/outbound's SplitTarget of 4000. Every maximal chunk the
// bridge produced was therefore cut in two, and Send returns only the first of
// the resulting ids. routes.json would bind that first bubble while the user
// replies to the last one they can see, so reply-routing (S2 §3.5 path 2, the
// primary interaction path) would miss and fall through to bare-text routing.
//
// With the default config this test reports 2 messages for every case below.
func TestSendIsOneMessage(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name string
		out  Out
	}{
		{
			// Exactly what internal/outbound emits at its split target.
			name: "a maximal outbound text chunk",
			out:  Out{ChatID: "oc_1", Text: strings.Repeat("a", 4000)},
		},
		{
			// 4000 runes, 12000 bytes: splitPlain's fast path is byte-based,
			// so CJK takes the rune loop even well under the limit.
			name: "a maximal chunk of CJK",
			out:  Out{ChatID: "oc_1", Text: strings.Repeat("字", 4000)},
		},
		{
			// Multi-line on purpose: SplitWithCodeFences splits at line
			// boundaries, so a single 4000-char line would not exercise it and
			// the case would pass with the broken config.
			// 108 lines x 37 chars = 3996.
			name: "a maximal mirrored assistant turn as markdown",
			out: Out{
				ChatID:   "oc_1",
				Markdown: strings.Repeat("mirrored assistant turn line of text\n", 108),
				Title:    "claude",
			},
		},
		{
			// The ceiling itself: 8000 is Feishu's hard limit (S2 §3.8).
			name: "text at feishu's hard limit",
			out:  Out{ChatID: "oc_1", Text: strings.Repeat("b", 8000)},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b, http := newTestBot(t)
			b.setState(stateRunning)

			id, err := b.Send(ctx, tc.out)
			if err != nil {
				t.Fatalf("Send: %v", err)
			}
			if id != stubSentMsgID {
				t.Fatalf("message id = %q, want %q", id, stubSentMsgID)
			}
			if n := countPosts(http); n != 1 {
				t.Fatalf("Send created %d feishu messages, want 1: only the first id comes back, so the rest are unbindable for reply-routing", n)
			}
		})
	}
}

// TestSendReportsASplit: an Out above Feishu's own ceiling can still be split
// by the SDK. That is a caller bug — internal/outbound is supposed to be the
// only splitter — but it must not pass silently, because a silently split
// message means a route binding that points at a bubble the user will not
// reply to.
func TestSendReportsASplit(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)

	id, err := b.Send(context.Background(), Out{ChatID: "oc_1", Text: strings.Repeat("c", 9000)})
	if !errors.Is(err, ErrSplit) {
		t.Fatalf("err = %v, want it to wrap ErrSplit", err)
	}
	// The first id still comes back: the messages exist, and the caller may
	// need to update or disarm something.
	if id != stubSentMsgID {
		t.Fatalf("message id = %q, want %q alongside the error", id, stubSentMsgID)
	}
	if n := countPosts(http); n < 2 {
		t.Fatalf("only %d messages posted; the test no longer exercises a split", n)
	}
	// It is not a Feishu failure, so it must not be classified as one — a
	// caller retrying on FailureKind would duplicate every bubble.
	if got := FailureKind(err); got != FailNone {
		t.Fatalf("FailureKind = %q, want FailNone", got)
	}
}

// TestOneMessagePerSend pins the config that makes the above work, and pins
// what must NOT change with it: Retry and the stream throttle are the SDK's
// business and the bridge has no measured reason to touch them.
func TestOneMessagePerSend(t *testing.T) {
	o := oneMessagePerSend()
	def := types.DefaultChannelConfig().Outbound

	if o.TextChunkLimit != feishuHardCharLimit {
		t.Fatalf("TextChunkLimit = %d, want %d (Feishu's hard limit, S2 §3.8)", o.TextChunkLimit, feishuHardCharLimit)
	}
	// Below internal/outbound's SplitTarget of 4000 and the SDK re-splits every
	// maximal chunk the bridge produces.
	if o.TextChunkLimit <= 4000 {
		t.Fatalf("TextChunkLimit = %d, must exceed internal/outbound's 4000 split target", o.TextChunkLimit)
	}
	if o.Retry != def.Retry {
		t.Fatalf("Retry = %+v, want the SDK default %+v", o.Retry, def.Retry)
	}
	if o.StreamThrottleMs != def.StreamThrottleMs || o.StreamThrottleChars != def.StreamThrottleChars {
		t.Fatalf("stream throttle = %v/%d, want the SDK defaults %v/%d",
			o.StreamThrottleMs, o.StreamThrottleChars, def.StreamThrottleMs, def.StreamThrottleChars)
	}
}
