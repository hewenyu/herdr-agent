package bridge

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

func completionFixture(t *testing.T) (*harness, agents.Agent, mirror.PaneTurn, string) {
	return completionFixtureFor(t, "claude")
}

func completionFixtureFor(t *testing.T, kind string) (*harness, agents.Agent, mirror.PaneTurn, string) {
	t.Helper()
	h := newHarness(t)
	a := finishedAgent()
	a.Kind = kind
	r := taskBinding("completion", "oc_task", a.PaneID)
	r.Agent = kind
	a.WorkspaceID = r.WorkspaceID
	attachTaskManager(t, h, r)
	h.reg.setAgents(a)
	records := claudeFixture(t)
	path := writeTranscript(t, records[fxUserRead], records[fxAssistantAMD])
	if kind == "codex" {
		data, err := os.ReadFile(filepath.Join("..", "mirror", "testdata", "codex-rollout.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		path = writeTranscript(t, strings.TrimSpace(string(data)))
	}
	h.transcript(a.PaneID, path)
	turns, err := mirror.LastTurns(path, a.Kind, 2)
	if err != nil || len(turns) != 2 {
		t.Fatalf("read fixture: %v / %+v", err, turns)
	}
	// The live parser and LastTurns start counting at different file offsets.
	turns[1].Seq += 100
	if kind == "codex" {
		// Parse the live rollout independently, including a split JSONL record.
		// Done later reads it through LastTurns with its own parser/window.
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		parser, _ := mirror.ParserFor(kind)
		_, rest, err := parser.Parse(data[:len(data)/2])
		if err != nil {
			t.Fatal(err)
		}
		live, _, err := parser.Parse(append(rest, data[len(data)/2:]...))
		if err != nil || len(live) == 0 {
			t.Fatalf("parse live Codex rollout: %v", err)
		}
		turns[1] = live[len(live)-1]
	}
	return h, a, mirror.PaneTurn{PaneID: a.PaneID, Turn: turns[1]}, path
}

func TestCompletionAndMirrorPublishAnswerOnceInEitherOrder(t *testing.T) {
	for _, kind := range []string{"claude", "codex"} {
		for _, order := range []string{"mirror-first", "done-first", "concurrent"} {
			t.Run(kind+"/"+order, func(t *testing.T) {
				h, a, turn, _ := completionFixtureFor(t, kind)
				ctx := context.Background()
				streams := map[string]*mirrorStream{}
				done := func() {
					if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
						t.Errorf("completion: %v", err)
					}
				}
				mirrored := func() { h.b.mirrorTurn(ctx, streams, turn) }
				switch order {
				case "mirror-first":
					mirrored()
					done()
				case "done-first":
					done()
					mirrored()
				case "concurrent":
					var wg sync.WaitGroup
					wg.Add(2)
					go func() { defer wg.Done(); mirrored() }()
					go func() { defer wg.Done(); done() }()
					wg.Wait()
				}
				h.b.closeAllMirrorStreams(ctx, streams)
				if count := len(h.bot.openStreams()) + len(h.bot.sends()); count != 1 {
					t.Fatalf("answer published %d times", count)
				}
			})
		}
	}
}

type flushCheckingStream struct {
	*fakeStream
	flushes int
	err     error
}

func (s *flushCheckingStream) Flush(context.Context) error {
	s.flushes++
	return s.err
}

type flushCheckingBot struct {
	*fakeBot
	stream *flushCheckingStream
}

func (b *flushCheckingBot) Stream(ctx context.Context, out lark.Out) (lark.Stream, error) {
	s, err := b.fakeBot.Stream(ctx, out)
	if err != nil {
		return nil, err
	}
	b.stream.fakeStream = s.(*fakeStream)
	return b.stream, nil
}

func TestCompletionConfirmsMirrorFlushAndFallsBackOnFailure(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "flushed", true: "failed"}[fail], func(t *testing.T) {
			h, a, turn, _ := completionFixture(t)
			stream := &flushCheckingStream{}
			if fail {
				stream.err = errors.New("final edit rejected")
			}
			h.b.deps.Bot = &flushCheckingBot{fakeBot: h.bot, stream: stream}
			h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, turn)
			if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
				t.Fatal(err)
			}
			if stream.flushes != 1 {
				t.Fatal("completion did not flush the buffered answer")
			}
			if got := len(h.bot.sends()); got != map[bool]int{false: 0, true: 1}[fail] {
				t.Fatalf("completion fallback sends = %d", got)
			}
		})
	}
}

func TestSuccessfulStreamCloseDoesNotHideAnUndeliveredFinalUpdate(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "update-failed"}[failed], func(t *testing.T) {
			h, a, turn, _ := completionFixture(t)
			stream := &flushCheckingStream{}
			if failed {
				stream.err = errors.New("background update failed")
			}
			h.b.deps.Bot = &flushCheckingBot{fakeBot: h.bot, stream: stream}
			ctx := context.Background()
			streams := map[string]*mirrorStream{}
			h.b.mirrorTurn(ctx, streams, assistantTurn("正在处理"))
			// Append accepts a buffered final answer, while Close succeeds even
			// when a later background update failed, as in the Lark SDK.
			h.b.mirrorTurn(ctx, streams, turn)
			h.b.closeAllMirrorStreams(ctx, streams)
			if !stream.closed || stream.flushes != 1 {
				t.Fatal("stream was closed without confirming the pending final update")
			}
			if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
				t.Fatal(err)
			}
			sends := h.bot.sends()
			if len(sends) != map[bool]int{false: 0, true: 1}[failed] {
				t.Fatalf("completion delivery ignored the actual flush result: %+v", sends)
			}
			if failed && !strings.Contains(sends[0].Out.Markdown, fxAnswerAMD) {
				t.Fatal("undelivered final answer was lost")
			}
		})
	}
}

func TestCompletionFallsBackWhenMirrorOpenAndPostBothFail(t *testing.T) {
	h, a, turn, _ := completionFixture(t)
	h.b.deps.Bot = &flakyBot{fakeBot: h.bot, streamErr: errors.New("stream rejected")}
	h.bot.failNext(failing(errors.New("post rejected")))
	h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, turn)
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	sends := h.bot.sends()
	if len(sends) != 2 || sends[0].Err == nil || sends[1].Err != nil || !strings.Contains(sends[1].Out.Markdown, fxAnswerAMD) {
		t.Fatalf("missing completion fallback: %+v", sends)
	}
}

func TestCompletionFallsBackAfterFailedAppendOrClose(t *testing.T) {
	for _, failure := range []string{"append", "close"} {
		t.Run(failure, func(t *testing.T) {
			h, a, turn, _ := completionFixture(t)
			ctx := context.Background()
			streams := map[string]*mirrorStream{}
			if failure == "append" {
				h.b.deps.Bot = &appendFailingBot{fakeBot: h.bot}
				h.b.mirrorTurn(ctx, streams, assistantTurn("正在处理"))
			} else {
				h.b.deps.Bot = &closeFailingBot{fakeBot: h.bot}
			}
			h.b.mirrorTurn(ctx, streams, turn)
			h.b.closeAllMirrorStreams(ctx, streams)
			if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
				t.Fatal(err)
			}
			sends := h.bot.sends()
			if len(sends) != 1 || !strings.Contains(sends[0].Out.Markdown, fxAnswerAMD) {
				t.Fatalf("failed %s swallowed the completion result: %+v", failure, sends)
			}
		})
	}
}

func TestSuccessfulMirrorPostDoesNotNeedAnotherDoneCard(t *testing.T) {
	h, a, turn, _ := completionFixture(t)
	h.b.deps.Bot = &flakyBot{fakeBot: h.bot, streamErr: errors.New("stream rejected")}
	h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, turn)
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	sends := h.bot.sends()
	if len(sends) != 1 || sends[0].Out.Card != "" || !strings.Contains(sends[0].Out.Markdown, fxAnswerAMD) {
		t.Fatalf("successful mirror post was duplicated or lost: %+v", sends)
	}
}

func TestCompletionDoesNotSuppressTheSameAnswerInANewTurn(t *testing.T) {
	h, a, turn, path := completionFixture(t)
	ctx := context.Background()
	if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// A new execution may legitimately produce exactly the same words.
	later := turn.Turn.At.Add(time.Minute)
	data = []byte(strings.ReplaceAll(string(data), turn.Turn.At.Format(time.RFC3339Nano), later.Format(time.RFC3339Nano)))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	turn.Turn.At = later
	a.StateSeq += 2
	h.reg.setAgents(a)
	streams := map[string]*mirrorStream{}
	h.b.mirrorTurn(ctx, streams, turn)
	if err := h.b.PushDone(ctx, a, scrollback()); err != nil {
		t.Fatal(err)
	}
	h.b.closeAllMirrorStreams(ctx, streams)
	if len(h.bot.sends()) != 1 || len(h.bot.openStreams()) != 1 {
		t.Fatalf("new answer suppressed or repeated: posts=%d streams=%d", len(h.bot.sends()), len(h.bot.openStreams()))
	}
}

func TestGeneralChatKeepsItsRoutableDoneCardAfterMirroring(t *testing.T) {
	h, a, turn, _ := completionFixture(t)
	h.b.tasks = nil
	h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, turn)
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	sends := h.bot.sends()
	if len(sends) != 1 || sends[0].Out.Card == "" || len(h.routes.boundPanes()) != 1 {
		t.Fatalf("general chat lost its routable completion card: %+v", sends)
	}
}

func TestUndatedAnswersAreNotSuppressedAcrossExecutions(t *testing.T) {
	h, a, turn, path := completionFixture(t)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.ReplaceAll(string(data), turn.Turn.At.Format(time.RFC3339Nano), ""))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	turn.Turn.At = time.Time{}
	for i := 0; i < 2; i++ {
		if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
			t.Fatal(err)
		}
		a.StateSeq += 2
	}
	if len(h.bot.sends()) != 2 {
		t.Fatal("timestamp-free identical answers swallowed a new execution")
	}
}

func TestTranscriptReplacementDoesNotSuppressAnIdenticalAnswer(t *testing.T) {
	h, a, _, path := completionFixture(t)
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	h.transcript(a.PaneID, writeTranscript(t, strings.TrimSpace(string(data))))
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	if len(h.bot.sends()) != 2 {
		t.Fatal("new transcript inherited old answer delivery state")
	}
}

func TestTaskCompletionFallbackKeepsTheWholeLongAnswer(t *testing.T) {
	h, a, _, path := completionFixture(t)
	full := strings.Repeat("完整交付说明。", 300) + "末尾交付事项"
	record := retextAssistant(t, claudeFixture(t)[fxAssistantAMD], full)
	if err := os.WriteFile(path, []byte(record+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.b.PushDone(context.Background(), a, scrollback()); err != nil {
		t.Fatal(err)
	}
	var delivered strings.Builder
	for _, send := range h.bot.sends() {
		delivered.WriteString(send.Out.Markdown + send.Out.Text)
	}
	if !strings.Contains(delivered.String(), full) {
		t.Fatal("task completion fallback clipped the result before marking it delivered")
	}
	turns, err := mirror.LastTurns(path, a.Kind, 1)
	if err != nil || len(turns) != 1 {
		t.Fatalf("read long answer: %v", err)
	}
	h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, mirror.PaneTurn{PaneID: a.PaneID, Turn: turns[0]})
	if len(h.bot.openStreams()) != 0 {
		t.Fatal("long answer was repeated after the complete fallback")
	}
}

func TestLateMirroredTextCannotReopenAReviewingTask(t *testing.T) {
	h := newHarness(t)
	r := taskBinding("late-result", "oc_task", testPane)
	r.Status, r.Result = tasks.Review, "已交付最终结果"
	_, store := attachTaskManager(t, h, r)
	h.reg.setAgents(taskAgent(r))
	h.b.mirrorTurn(context.Background(), map[string]*mirrorStream{}, assistantTurn("迟到的进度文本"))
	after, _ := store.Get(r.ID)
	if after.Status != tasks.Review || after.Result != r.Result {
		t.Fatalf("late transcript overwrote completed state: %+v", after)
	}
}
