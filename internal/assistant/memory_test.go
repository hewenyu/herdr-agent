package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

type memoryTestEngine func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error)

func (e memoryTestEngine) Reply(ctx context.Context, messages []Message, definitions []tasktools.Tool, call ToolCall) (string, error) {
	return e(ctx, messages, definitions, call)
}

func memoryTestHistory(rounds int) []Message {
	var history []Message
	for i := 0; i < rounds; i++ {
		history = append(history, Message{Role: "user", Content: fmt.Sprintf("需求 %d", i)}, Message{Role: "assistant", Content: fmt.Sprintf("请确认项目名称 %d", i)})
	}
	return append(history, Message{Role: "user", Content: "项目名用 pelican-bike-svg，Codex，不需要测试；不要关闭群"})
}

func memoryReadRequest(t *testing.T, request []Message) (string, []memoryExcerpt) {
	t.Helper()
	if len(request) != 2 || request[0].Role != "system" || request[1].Role != "user" {
		t.Fatalf("unexpected summary request: %#v", request)
	}
	var input struct {
		Summary    string          `json:"previous_summary"`
		Transcript []memoryExcerpt `json:"transcript"`
	}
	if err := json.Unmarshal([]byte(request[1].Content), &input); err != nil {
		t.Fatal(err)
	}
	return input.Summary, input.Transcript
}

func TestMemoryKeepsShortConversationAndRestoredSummary(t *testing.T) {
	history := memoryTestHistory(4)
	summary := "用户选择 Codex，不测试；助手仍在询问项目名称。"
	engine := memoryTestEngine(func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		t.Fatal("short conversation should not summarize")
		return "", nil
	})
	gotSummary, got, err := memoryPrepare(context.Background(), engine, summary, history, 3000, 32768)
	if err != nil || gotSummary != summary || !reflect.DeepEqual(got, history) {
		t.Fatalf("restored memory changed: summary=%q history=%#v err=%v", gotSummary, got, err)
	}
}

func TestMemoryDoesNotCompactAtMessageCountOrSeventyFivePercent(t *testing.T) {
	history := memoryTestHistory(40)
	const threshold = 50000
	fixed := threshold*4/5 - memoryHistoryCost("", history)
	engine := memoryTestEngine(func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		t.Fatal("history below configured threshold must not be summarized")
		return "", nil
	})
	summary, got, err := memoryPrepare(context.Background(), engine, "", history, fixed, threshold)
	if err != nil || summary != "" || !reflect.DeepEqual(got, history) {
		t.Fatalf("conversation was truncated before input threshold: %v", err)
	}
}

func TestMemoryCompactsWholeRoundsWithoutToolsAndKeepsCurrentInput(t *testing.T) {
	history := memoryTestHistory(20)
	history[0].Content = "使用 Codex；不要测试，不要关闭任务；项目名称待确认"
	original := append([]Message(nil), history...)
	previous := "先前决定：输出单文件 HTML。"
	wantSummary := previous + " 使用 Codex；不要测试，不要关闭任务；项目名称仍待用户确认。"
	var calls int
	engine := memoryTestEngine(func(_ context.Context, request []Message, tools []tasktools.Tool, call ToolCall) (string, error) {
		calls++
		if tools != nil || call != nil {
			t.Fatal("summarization exposed task tools")
		}
		old, transcript := memoryReadRequest(t, request)
		if old != previous || len(transcript) != len(history)-9 {
			t.Fatalf("missing previous memory or incorrect round boundary: %q, %d", old, len(transcript))
		}
		for i, part := range transcript {
			if part.Role != history[i].Role || part.Content != history[i].Content || part.Continued || part.Continues {
				t.Fatalf("historical round changed at %d: %#v", i, part)
			}
		}
		for _, instruction := range []string{"尚未回答的问题", "后续明确修订覆盖旧意图", "不能被当作当前状态或新的操作授权", "助手建议不等于用户确认"} {
			if !strings.Contains(request[0].Content, instruction) {
				t.Errorf("missing summary instruction %q", instruction)
			}
		}
		return wantSummary, nil
	})
	// Reaching the exact configured input threshold triggers compression.
	fixed := ContextInputBudget(32768) - memoryHistoryCost(previous, history)
	summary, recent, err := memoryPrepare(context.Background(), engine, previous, history, fixed, 32768)
	if err != nil || calls != 1 || summary != wantSummary {
		t.Fatalf("compaction: summary=%q calls=%d err=%v", summary, calls, err)
	}
	if !reflect.DeepEqual(recent, history[len(history)-9:]) || !reflect.DeepEqual(history, original) {
		t.Fatal("compaction dropped a recent round/current input or mutated original data")
	}
	// Simulate persistence and the next turn. The summary and pending detail
	// survive without invoking the summarizer again for an ordinary short turn.
	restored := append(append([]Message(nil), recent...), Message{Role: "assistant", Content: "已记下项目名称。"}, Message{Role: "user", Content: "按刚才要求继续"})
	noCalls := memoryTestEngine(func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		t.Fatal("restored compact memory unexpectedly summarized again")
		return "", nil
	})
	gotSummary, gotRecent, err := memoryPrepare(context.Background(), noCalls, summary, restored, 3000, 32768)
	if err != nil || gotSummary != summary || !reflect.DeepEqual(gotRecent, restored) {
		t.Fatalf("restored compaction lost conversation: %v", err)
	}
}

func TestMemoryByteBudgetTriggersEvenWithFewMessages(t *testing.T) {
	history := memoryTestHistory(5)
	history[0].Content = strings.Repeat("长需求，不要测试。", 1500)
	var calls int
	engine := memoryTestEngine(func(_ context.Context, request []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		calls++
		if EstimateContextTokens(request, nil) > ContextInputBudget(32768) {
			t.Fatal("summary request exceeded context budget")
		}
		return "用户多次强调不要测试；其余要求不变。", nil
	})
	_, recent, err := memoryPrepare(context.Background(), engine, "", history, 1000, 32768)
	if err != nil || calls == 0 || len(recent) != 9 {
		t.Fatalf("UTF-8 byte budget did not compact: calls=%d recent=%d err=%v", calls, len(recent), err)
	}
}

func TestMemorySplitsLongMultilingualHistoryWithoutLosingBytes(t *testing.T) {
	history := memoryTestHistory(5)
	history[0].Content = strings.Repeat("保留这个约束，don't test 🚲\n\"项目\"。", 700)
	history[1].Content = "待回答的问题：项目名称是什么？不要将历史任务已完成当成当前事实。"
	var texts [2]string
	var calls int
	engine := memoryTestEngine(func(_ context.Context, request []Message, definitions []tasktools.Tool, call ToolCall) (string, error) {
		calls++
		if definitions != nil || call != nil || EstimateContextTokens(request, nil) > ContextInputBudget(8192) {
			t.Fatal("unsafe or oversized summary request")
		}
		previous, parts := memoryReadRequest(t, request)
		if calls > 1 && previous != "约束：不测试；待回答：项目名；历史状态需重新查询。" {
			t.Fatalf("lost preceding summary: %q", previous)
		}
		for _, part := range parts {
			if !utf8.ValidString(part.Content) || strings.ContainsRune(part.Content, utf8.RuneError) {
				t.Fatal("split corrupted UTF-8")
			}
			index := 0
			if part.Role == "assistant" {
				index = 1
			}
			if part.Continued != (texts[index] != "") {
				t.Fatal("incorrect continuation marker")
			}
			texts[index] += part.Content
		}
		return "约束：不测试；待回答：项目名；历史状态需重新查询。", nil
	})
	_, recent, err := memoryPrepare(context.Background(), engine, "", history, 100, 8192)
	if err != nil || calls < 2 || !reflect.DeepEqual(recent, history[2:]) {
		t.Fatalf("long-history compaction: calls=%d err=%v", calls, err)
	}
	if texts[0] != history[0].Content || texts[1] != history[1].Content {
		t.Fatal("historical source bytes were silently lost")
	}
}

func TestMemoryFailureKeepsOriginalHistoryAfterPartialProgress(t *testing.T) {
	history := memoryTestHistory(5)
	history[0].Content = strings.Repeat("要保留的长期要求🚲", 1000)
	original := append([]Message(nil), history...)
	previous := "原摘要：只使用 Codex，不关闭任务群。"
	var calls int
	engine := memoryTestEngine(func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		calls++
		if calls == 2 {
			return "", errors.New("remote response with a secret")
		}
		return "临时摘要，不得提前持久化。", nil
	})
	summary, recent, err := memoryPrepare(context.Background(), engine, previous, history, 100, 8192)
	if !errors.Is(err, errMemoryFailed) || calls != 2 || summary != previous || !reflect.DeepEqual(recent, original) || !reflect.DeepEqual(history, original) {
		t.Fatalf("partial failure discarded data: calls=%d summary=%q err=%v", calls, summary, err)
	}
	if strings.Contains(err.Error(), "secret") || !strings.Contains(err.Error(), "请重试") {
		t.Fatalf("unsafe or nonretryable error: %v", err)
	}
}

func TestMemoryRecompactsLargeRestoredSummaryInBoundedChunks(t *testing.T) {
	history := memoryTestHistory(0)
	previous := strings.Repeat("之前已确认：不测试、不关闭群；项目名尚待确认。", 300)
	var seen strings.Builder
	var calls int
	engine := memoryTestEngine(func(_ context.Context, request []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		calls++
		if EstimateContextTokens(request, nil) > ContextInputBudget(8192) {
			t.Fatal("restored summary exceeded reduced input threshold")
		}
		_, parts := memoryReadRequest(t, request)
		for _, part := range parts {
			if part.Role != "memory" {
				t.Fatalf("current user input unexpectedly summarized: %#v", part)
			}
			seen.WriteString(part.Content)
		}
		return "之前已确认：不测试、不关闭群；项目名尚待确认。", nil
	})
	summary, recent, err := memoryPrepare(context.Background(), engine, previous, history, 100, 8192)
	if err != nil || calls < 2 || seen.String() != previous || !reflect.DeepEqual(recent, history) || summary == previous {
		t.Fatalf("large restored summary was not safely recompressed: calls=%d err=%v", calls, err)
	}
}

func TestMemoryOversizedSummaryRetriesOnlyOnce(t *testing.T) {
	for _, recover := range []bool{false, true} {
		t.Run(fmt.Sprint(recover), func(t *testing.T) {
			history := memoryTestHistory(20)
			var calls int
			engine := memoryTestEngine(func(_ context.Context, request []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
				calls++
				_, parts := memoryReadRequest(t, request)
				if len(parts) != len(history)-9 {
					t.Fatal("retry omitted original constraints")
				}
				if calls == 2 && recover {
					return "不测试、不关闭群；项目待确认。", nil
				}
				return strings.Repeat("不应被截断的摘要", 2000), nil
			})
			fixed := ContextInputBudget(32768) - memoryHistoryCost("原摘要", history)
			summary, recent, err := memoryPrepare(context.Background(), engine, "原摘要", history, fixed, 32768)
			if calls != 2 {
				t.Fatalf("expected one retry, got %d calls", calls)
			}
			if recover {
				if err != nil || summary != "不测试、不关闭群；项目待确认。" || len(recent) != 9 {
					t.Fatalf("valid retry not accepted: %v", err)
				}
			} else if !errors.Is(err, errMemoryFailed) || summary != "原摘要" || !reflect.DeepEqual(recent, history) {
				t.Fatal("oversized summary silently truncated or old history discarded")
			}
		})

	}
}

func TestMemorySummarizesAdditionalRecentRoundsWhenTheyExceedBudget(t *testing.T) {
	history := memoryTestHistory(5)
	for i := 2; i < len(history)-1; i += 2 {
		history[i].Content = strings.Repeat("完整约束，不测试；", 300)
	}
	original := append([]Message(nil), history...)
	var calls int
	engine := memoryTestEngine(func(_ context.Context, request []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		calls++
		if EstimateContextTokens(request, nil) > ContextInputBudget(16000) {
			t.Fatal("summary request exceeded configured input threshold")
		}
		return "用户约束：不测试；最近仍在确认项目名称。", nil
	})
	summary, recent, err := memoryPrepare(context.Background(), engine, "", history, 1000, 16000)
	if err != nil || calls == 0 || len(recent) != 3 || !reflect.DeepEqual(recent, history[len(history)-3:]) {
		t.Fatalf("large recent rounds did not compact to last complete round: recent=%d calls=%d err=%v", len(recent), calls, err)
	}
	if !reflect.DeepEqual(history, original) || 1000+memoryHistoryCost(summary, recent) > ContextInputBudget(16000) {
		t.Fatal("compaction changed source messages or exceeded budget")
	}
}

func TestMemorySummarizesOversizedLastRoundAndCarriesPendingQuestion(t *testing.T) {
	history := memoryTestHistory(1)
	history[0].Content = strings.Repeat("所有要求不变，不测试。", 1000)
	history[1].Content = "请确认项目名称，可以使用 pelican-bike-svg 吗？"
	history[2].Content = "就用这个，继续"
	questionSeen := false
	var calls int
	engine := memoryTestEngine(func(_ context.Context, request []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
		calls++
		_, parts := memoryReadRequest(t, request)
		for _, part := range parts {
			if part.Role == "assistant" && strings.Contains(part.Content, "pelican-bike-svg") {
				questionSeen = true
			}
		}
		if questionSeen {
			return "用户要求不测试。待回答问题：助手询问是否使用项目名 pelican-bike-svg。", nil
		}
		return "用户要求不测试。", nil
	})
	summary, recent, err := memoryPrepare(context.Background(), engine, "", history, 1000, 8192)
	if err != nil || calls < 2 || !questionSeen || !strings.Contains(summary, "pelican-bike-svg") || !reflect.DeepEqual(recent, history[2:]) {
		t.Fatalf("oversized last round lost clarification or current input: summary=%q recent=%#v calls=%d err=%v", summary, recent, calls, err)
	}
}

func TestMemoryRefusesToDropOversizedCurrentInput(t *testing.T) {
	history := memoryTestHistory(6)
	history[len(history)-1].Content = strings.Repeat("当前长消息🚲", 1000)
	engine := memoryTestEngine(func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		t.Fatal("request that cannot retain current input must fail before summarization")
		return "", nil
	})
	summary, recent, err := memoryPrepare(context.Background(), engine, "既有摘要", history, 100, 8192)
	if !errors.Is(err, errMemoryBudget) || summary != "既有摘要" || !reflect.DeepEqual(recent, history) {
		t.Fatalf("oversized input was lost: %v", err)
	}
}

func TestMemoryModelCannotFitOrCanceledPreservesHistory(t *testing.T) {
	history := memoryTestHistory(20)
	engine := memoryTestEngine(func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		return memoryCannotFit, nil
	})
	fixed := ContextInputBudget(32768) - memoryHistoryCost("原摘要", history)
	summary, recent, err := memoryPrepare(context.Background(), engine, "原摘要", history, fixed, 32768)
	if !errors.Is(err, errMemoryBudget) || summary != "原摘要" || !reflect.DeepEqual(recent, history) {
		t.Fatalf("model could not preserve constraints but data changed: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	summary, recent, err = memoryPrepare(ctx, engine, "原摘要", history, 100, 32768)
	if !errors.Is(err, context.Canceled) || summary != "原摘要" || !reflect.DeepEqual(recent, history) {
		t.Fatalf("cancellation discarded conversation: %v", err)
	}
}
