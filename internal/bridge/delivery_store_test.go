package bridge

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
)

func useDeliveryStore(t *testing.T, h *harness, path string) {
	t.Helper()
	store, err := OpenDeliveryStore(path)
	if err != nil {
		t.Fatal(err)
	}
	WithDeliveryStore(store)(h.b)
}

func restartDeliveryBridge(t *testing.T, h *harness, path string) {
	t.Helper()
	store, err := OpenDeliveryStore(path)
	if err != nil {
		t.Fatal(err)
	}
	b, err := newBridge(h.b.deps, WithTasks(h.b.tasks), WithAssistant(h.b.assistant), WithDeliveryStore(store))
	if err != nil {
		t.Fatal(err)
	}
	h.b = b
}

func TestTaskResultAcknowledgementSurvivesBridgeRestart(t *testing.T) {
	for _, source := range []string{"post", "stream"} {
		t.Run(source, func(t *testing.T) {
			h, a, turn, _ := completionFixtureFor(t, "codex")
			path := filepath.Join(t.TempDir(), "deliveries.json")
			useDeliveryStore(t, h, path)
			ctx := context.Background()
			if source == "stream" {
				streams := map[string]*mirrorStream{}
				h.b.mirrorTurn(ctx, streams, turn)
				h.b.closeAllMirrorStreams(ctx, streams)
			} else if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
				t.Fatal(err)
			}
			before := len(h.bot.sends()) + len(h.bot.openStreams())
			restartDeliveryBridge(t, h, path)
			if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
				t.Fatal(err)
			}
			h.b.mirrorTurn(ctx, map[string]*mirrorStream{}, turn)
			if got := len(h.bot.sends()) + len(h.bot.openStreams()); got != before {
				t.Fatalf("restart repeated an acknowledged result: %d -> %d", before, got)
			}
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm()&0077 != 0 {
				t.Fatalf("delivery acknowledgements not private: %v / %v", info, err)
			}
		})
	}
}

func TestPendingOrFailedStreamIsNotPersistedAsDelivered(t *testing.T) {
	for _, closeFailed := range []bool{false, true} {
		t.Run(fmt.Sprint(closeFailed), func(t *testing.T) {
			h, a, turn, _ := completionFixture(t)
			path := filepath.Join(t.TempDir(), "deliveries.json")
			useDeliveryStore(t, h, path)
			ctx := context.Background()
			streams := map[string]*mirrorStream{}
			if closeFailed {
				h.b.deps.Bot = &flushCheckingBot{fakeBot: h.bot, stream: &flushCheckingStream{err: errors.New("update rejected")}}
			}
			h.b.mirrorTurn(ctx, streams, assistantTurn("progress before buffered final"))
			h.b.mirrorTurn(ctx, streams, turn)
			if closeFailed {
				h.b.closeAllMirrorStreams(ctx, streams)
			}
			restartDeliveryBridge(t, h, path)
			if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
				t.Fatal(err)
			}
			if sends := h.bot.sends(); len(sends) != 1 || !strings.Contains(sends[0].Out.Markdown, turn.Turn.Text) {
				t.Fatalf("restart lost an unconfirmed answer: %+v", sends)
			}
		})
	}
}

func setCompletionText(t *testing.T, h *harness, path, text string) mirror.PaneTurn {
	t.Helper()
	record := retextAssistant(t, claudeFixture(t)[fxAssistantAMD], text)
	if err := os.WriteFile(path, []byte(record+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	turns, err := mirror.LastTurns(path, "claude", 1)
	if err != nil || len(turns) != 1 {
		t.Fatalf("read result: %v", err)
	}
	return mirror.PaneTurn{PaneID: testPane, Turn: turns[0]}
}

var chunkSuffix = regexp.MustCompile(`\n\n\([0-9]+/[0-9]+\)$`)

func deliveredPostText(t *testing.T, h *harness) string {
	t.Helper()
	var text strings.Builder
	for _, send := range h.bot.sends() {
		if send.Err != nil {
			continue
		}
		body := send.Out.Markdown + send.Out.Text
		if send.Out.Card != "" || utf8.RuneCountInString(body) > 4000 {
			t.Fatalf("task result did not use complete bounded posts: %+v", send.Out)
		}
		text.WriteString(chunkSuffix.ReplaceAllString(body, ""))
	}
	return text.String()
}

func TestTaskCompletionPreservesContentAcrossCardAndPostLimits(t *testing.T) {
	for _, tc := range []struct{ name, text string }{
		{"cell limit", strings.Repeat("x", 1200)},
		{"over cell limit", strings.Repeat("x", 1201)},
		{"post limit", strings.Repeat("x", 4000)},
		{"over post limit", strings.Repeat("x", 4001)},
		{"newlines", "start" + strings.Repeat("\n", 9000) + "end"},
		{"zero width", "start" + strings.Repeat("\u200d", 9000) + "end"},
		{"combining marks", "e" + strings.Repeat("\u0301", 9000) + " end"},
	} {
		for _, order := range []string{"done-first", "mirror-first"} {
			t.Run(tc.name+"/"+order, func(t *testing.T) {
				h, a, _, path := completionFixture(t)
				turn := setCompletionText(t, h, path, tc.text)
				ctx := context.Background()
				streams := map[string]*mirrorStream{}
				if order == "mirror-first" {
					h.b.mirrorTurn(ctx, streams, turn)
				}
				if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
					t.Fatal(err)
				}
				if order == "done-first" {
					h.b.mirrorTurn(ctx, streams, turn)
				}
				h.b.closeAllMirrorStreams(ctx, streams)
				text := deliveredPostText(t, h)
				for _, stream := range h.bot.openStreams() {
					text += stream.content()
				}
				if text != tc.text {
					t.Fatalf("result was truncated or repeated: got %d runes, want %d", utf8.RuneCountInString(text), utf8.RuneCountInString(tc.text))
				}
			})
		}
	}
}

func TestPartialTaskPostResumesAcrossPathsAndBridgeRestart(t *testing.T) {
	for _, source := range []string{"done", "mirror"} {
		t.Run(source, func(t *testing.T) {
			h, a, _, transcript := completionFixture(t)
			path := filepath.Join(t.TempDir(), "deliveries.json")
			useDeliveryStore(t, h, path)
			full := "begin " + strings.Repeat("0123456789", 1100) + " end"
			turn := setCompletionText(t, h, transcript, full)
			h.bot.failNext(nil, failing(errors.New("second chunk rejected")))
			if source == "done" {
				if err := h.b.PushDone(context.Background(), a, scrollback()); err == nil {
					t.Fatal("partial result reported complete")
				}
			} else {
				h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, turn)
			}
			if len(h.bot.sends()) != 2 {
				t.Fatalf("expected one acknowledged chunk and one failure: %+v", h.bot.sends())
			}
			id, _ := h.b.deliveryID(a, turn.Turn)
			disk, err := OpenDeliveryStore(path)
			if err != nil || disk.receipt(id.String()).Complete {
				t.Fatalf("partial result persisted as complete: %v", err)
			}
			restartDeliveryBridge(t, h, path)
			if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
				t.Fatal(err)
			}
			if got := deliveredPostText(t, h); got != full {
				t.Fatalf("resuming repeated or lost an acknowledged prefix: got %d runes, want %d", utf8.RuneCountInString(got), utf8.RuneCountInString(full))
			}
			count := len(h.bot.sends())
			restartDeliveryBridge(t, h, path)
			h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, turn)
			if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil || len(h.bot.sends()) != count {
				t.Fatalf("completed result replayed after another restart: %v", err)
			}
		})
	}
}

func TestDeliveryCacheEvictionKeepsPendingAndDurableReceipts(t *testing.T) {
	h := newHarness(t)
	path := filepath.Join(t.TempDir(), "deliveries.json")
	useDeliveryStore(t, h, path)
	d := h.b.paneDelivery(testPane)
	stream := &mirrorStream{}
	var keys []deliveryID
	for i := 0; i < 300; i++ {
		id := deliveryID(sha256.Sum256([]byte(fmt.Sprint(i))))
		keys = append(keys, id)
		d.remember(id, stream)
	}
	if len(d.records) != 256 || len(d.order) != 256 {
		t.Fatalf("recent cache exceeded its bound: %d / %d", len(d.records), len(d.order))
	}
	for _, id := range keys {
		if pending, ok := d.lookup(id); !ok || pending != stream {
			t.Fatal("eviction forgot a pending stream record")
		}
	}
	if err := d.finishStream(stream, true); err != nil {
		t.Fatal(err)
	}
	if len(d.pending) != 0 || len(stream.records) != 0 || len(d.records) != 256 {
		t.Fatal("flushed stream records were retained or exceeded the cache bound")
	}
	restartDeliveryBridge(t, h, path)
	d = h.b.paneDelivery(testPane)
	for _, id := range keys {
		if pending, ok := d.lookup(id); !ok || pending != nil {
			t.Fatal("evicted acknowledgement did not survive restart")
		}
	}
	failed := &mirrorStream{}
	for i := 0; i < 300; i++ {
		d.remember(deliveryID(sha256.Sum256([]byte(fmt.Sprintf("failed-%d", i)))), failed)
	}
	if err := d.finishStream(failed, false); err != nil {
		t.Fatal(err)
	}
	if len(d.pending) != 0 || len(failed.records) != 0 || len(d.records) != 0 || len(d.order) != 0 {
		t.Fatal("failed stream retained pending or cached records after eviction")
	}
	for _, id := range keys {
		if pending, ok := d.lookup(id); !ok || pending != nil {
			t.Fatal("discarding a failed stream erased an older durable receipt")
		}
	}
}

func TestDeliveryStoreRejectsCorruptionAndRecoversAfterWriteFailure(t *testing.T) {
	for _, data := range []string{`{`, `{"version":2,"receipts":{}}`, `{"version":1}`, `{"version":1,"receipts":{"x":{"chunks":-1}}}`} {
		path := filepath.Join(t.TempDir(), "deliveries.json")
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenDeliveryStore(path); err == nil {
			t.Fatalf("silently discarded corrupt acknowledgements: %s", data)
		}
	}
	h, a, turn, _ := completionFixture(t)
	parent := filepath.Join(t.TempDir(), "state")
	path := filepath.Join(parent, "deliveries.json")
	useDeliveryStore(t, h, path)
	if err := os.WriteFile(parent, []byte("temporarily blocks directory creation"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := h.b.PushDone(context.Background(), a, scrollback()); err == nil {
		t.Fatal("delivery checkpoint failure was hidden")
	}
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	if len(h.bot.sends()) != 1 {
		t.Fatal("retrying the checkpoint repeated an acknowledged network send")
	}
	restartDeliveryBridge(t, h, path)
	h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, turn)
	if len(h.bot.openStreams()) != 0 {
		t.Fatal("recovered checkpoint was not durable")
	}
}

type missingMessageIDBot struct{ *fakeBot }

func (b *missingMessageIDBot) Send(ctx context.Context, out lark.Out) (string, error) {
	_, err := b.fakeBot.Send(ctx, out)
	return "", err
}

type resultHistoryAssistant struct {
	messages []AssistantMessage
	err      error
}

func (*resultHistoryAssistant) Reply(context.Context, AssistantMessage) (string, error) {
	return "", nil
}

func (a *resultHistoryAssistant) RecordDeliveredMessage(_ context.Context, in AssistantMessage) error {
	a.messages = append(a.messages, in)
	err := a.err
	a.err = nil
	return err
}

func TestMissingMessageIDCannotConfirmTaskDeliveryOrHistory(t *testing.T) {
	h, a, turn, _ := completionFixture(t)
	path := filepath.Join(t.TempDir(), "deliveries.json")
	useDeliveryStore(t, h, path)
	history := &resultHistoryAssistant{}
	WithAssistant(history)(h.b)
	h.b.deps.Bot = &missingMessageIDBot{fakeBot: h.bot}
	if err := h.b.PushDone(context.Background(), a, scrollback()); err == nil {
		t.Fatal("empty message ID treated as successful delivery")
	}
	id, _ := h.b.deliveryID(a, turn.Turn)
	if h.b.deliveryStore.receipt(id.String()).Complete || len(history.messages) != 0 {
		t.Fatal("unconfirmed send entered delivery ledger or conversation history")
	}
	r, _ := h.b.tasks.ByPane(a.PaneID)
	if r.ResultDelivered {
		t.Fatal("task notification was told an unconfirmed result was delivered")
	}
	disk, err := OpenDeliveryStore(path)
	if err != nil || len(disk.receipts) != 0 {
		t.Fatalf("unconfirmed result persisted a receipt: %v / %+v", err, disk)
	}
}

func TestTaskResultHistoryIsRecordedOnlyAfterCompleteDelivery(t *testing.T) {
	h, a, _, transcript := completionFixture(t)
	full := "answer " + strings.Repeat("x", 9000) + " end"
	setCompletionText(t, h, transcript, full)
	history := &resultHistoryAssistant{}
	WithAssistant(history)(h.b)
	h.bot.failNext(nil, failing(errors.New("second chunk rejected")))
	if err := h.b.PushDone(context.Background(), a, scrollback()); err == nil {
		t.Fatal("partial result treated as complete")
	}
	if len(history.messages) != 0 {
		t.Fatal("partial result was added to model-visible conversation history")
	}
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	if len(history.messages) != 1 {
		t.Fatalf("complete result missing from conversation: %+v", history.messages)
	}
	in := history.messages[0]
	r, _ := h.b.tasks.ByPane(a.PaneID)
	if in.Text != full || in.OwnerID != r.OwnerID || in.ChatID != r.ChatID || in.TaskID != r.ID || !strings.HasPrefix(in.MessageID, "agent-result:") || !r.ResultDelivered {
		t.Fatalf("result history lost its trusted identity or full content: %+v", in)
	}
}

func TestDeliveredResultRetriesHistoryWithoutSendingAgain(t *testing.T) {
	h, a, _, _ := completionFixture(t)
	history := &resultHistoryAssistant{err: errors.New("history checkpoint unavailable")}
	WithAssistant(history)(h.b)
	if err := h.b.PushDone(context.Background(), a, scrollback()); err == nil {
		t.Fatal("history checkpoint failure was hidden")
	}
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	if len(h.bot.sends()) != 1 || len(history.messages) != 2 || history.messages[0] != history.messages[1] {
		t.Fatal("history recovery repeated the network send or changed result identity")
	}
}

func TestTaskCompletionWithoutAssistantTextDoesNotPublishScreen(t *testing.T) {
	for _, source := range []string{"missing-transcript", "tool-only"} {
		t.Run(source, func(t *testing.T) {
			h, a, _, transcript := completionFixture(t)
			if source == "tool-only" {
				if err := os.WriteFile(transcript, []byte(claudeFixture(t)[fxAssistantBash]+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Remove(transcript); err != nil {
				t.Fatal(err)
			}
			if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
				t.Fatal(err)
			}
			r, _ := h.b.tasks.ByPane(a.PaneID)
			if len(h.bot.sends()) != 0 || r.Result != "" || r.ResultDelivered {
				t.Fatalf("screen/tool metadata became a fictitious final answer: %+v", r)
			}
		})
	}
}
