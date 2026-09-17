package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	localmemory "github.com/hewenyu/herdr-agent/internal/memory"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

func TestNaturalConversationPreservesQuestionsAndSuggestions(t *testing.T) {
	for _, text := range []string{
		"请确认新项目名称；例如可用 `pelican-bike-svg`。你确认后，我会用 codex 创建任务。",
		"好的，请告诉我新项目叫什么？",
		"**项目名建议**：`pelican-bike-svg`，文件叫 `index.html` 可以吗？",
		"可以先讨论动画风格。建议使用 CSS 动画，轮子与踏板同步转动。",
		"建议参考 https://developer.mozilla.org/ 的 SVG 文档。",
		"按钮文案可改成“已完成”，是否采用？",
		"等验收通过后再关闭群；现在先确认动画效果。",
		"待验收通过之后再关闭任务，当前先讨论。",
		"验收通过才会关闭群。",
		"你是否已完成验收？",
	} {
		h := newServiceHarness(t)
		e := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
			return text, nil
		}}
		if got := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "discuss", "先讨论方案")); got != text {
			t.Fatalf("natural conversation changed: %q => %q", text, got)
		}
	}
}

func TestClarificationSurvivesRestartAndShortAnswerInBothChats(t *testing.T) {
	for _, group := range []bool{false, true} {
		for _, discover := range []bool{false, true} {
			t.Run(fmt.Sprintf("group=%v/discover=%v", group, discover), func(t *testing.T) {
				h := newGroupServiceHarness(t)
				question := "好的，建议采用蓝色背景和 SVG 动画，输出 index.html。你确认采用这个方案吗？"
				first := serviceMessage("alice", "entry", "first", "使用 Codex，做鹈鹕骑车动画，不用进行测试，先和我讨论方案")
				if group {
					first = groupMessage("first", first.Text)
				}
				e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
					if discover {
						name, args := "herdr_projects", `{}`
						if group {
							name = "herdr_get"
						}
						if _, err := call(ctx, name, json.RawMessage(args)); err != nil {
							return "", err
						}
					}
					return question, nil
				}}
				if answer := serviceReply(t, h.service(t, e), first); !strings.Contains(answer, question) {
					t.Fatalf("question was swallowed: %s", answer)
				}
				restarted := h.service(t, &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
					if history[len(history)-2].Content != question || !strings.Contains(history[len(history)-3].Content, "不用进行测试") {
						t.Fatal("short answer lost the visible proposal or original constraint")
					}
					name, payload := "herdr_create", map[string]any{"project": "project", "agent": "codex", "text": "制作鹈鹕骑车SVG动画，蓝色背景，index.html，不用进行测试"}
					if group {
						name = "herdr_send"
						delete(payload, "project")
						delete(payload, "agent")
					}
					data, _ := json.Marshal(payload)
					_, err := call(ctx, name, data)
					return "好的。", err
				}})
				next := first
				next.MessageID, next.Text = "next", "就按这个做"
				serviceReply(t, restarted, next)
				if group && (len(h.controller.texts) != 1 || !strings.Contains(h.controller.texts[0], "不用进行测试")) {
					t.Fatal("group feedback was not delivered once")
				}
				if !group && (len(h.manager.created()) != 1 || !strings.Contains(h.manager.created()[0].Text, "不用进行测试")) {
					t.Fatal("entry creation was not registered once")
				}
			})
		}
	}
}

func TestFailedReplyDoesNotBecomeAProposalAfterRestart(t *testing.T) {
	for _, group := range []bool{false, true} {
		t.Run(fmt.Sprintf("group=%v", group), func(t *testing.T) {
			h := newGroupServiceHarness(t)
			first := serviceMessage("alice", "entry", "failed", "使用 Codex，做鹈鹕骑车动画，不用进行测试，先讨论方案")
			if group {
				first = groupMessage("failed", first.Text)
			}
			failing := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
				return "用户没有看到的方案 invisible-proposal", errModelCall
			}}
			if _, err := h.service(t, failing).Reply(context.Background(), first); !errors.Is(err, errModelCall) {
				t.Fatalf("provider failure: %v", err)
			}
			const clarification = "上次未能提供方案，你希望采用什么名称和风格？"
			restarted := h.service(t, &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
				previous := history[len(history)-2]
				if previous.Role != "assistant" || !strings.Contains(previous.Content, "没有给出可供确认") || !strings.Contains(previous.Content, "未调用任务工具") {
					t.Fatalf("failure mistaken for a visible suggestion: %+v", previous)
				}
				for _, message := range history {
					if strings.Contains(message.Content, "invisible-proposal") {
						t.Fatal("failed model output was stored as a proposal")
					}
				}
				return clarification, nil
			}})
			first.MessageID, first.Text = "short-answer", "就叫这个"
			if answer := serviceReply(t, restarted, first); answer != clarification {
				t.Fatalf("missing referent clarification changed: %s", answer)
			}
			if len(h.manager.created()) != 0 || len(h.controller.texts) != 0 {
				t.Fatal("failed dialogue caused task operations")
			}
		})
	}
}

type recordingMemory struct {
	entries    map[localmemory.Scope]localmemory.Entry
	recalls    []localmemory.Scope
	stores     []localmemory.Scope
	err        error
	storeErr   error
	afterStore func()
}

func (m *recordingMemory) Recall(_ context.Context, scope localmemory.Scope) (localmemory.Entry, error) {
	m.recalls = append(m.recalls, scope)
	return m.entries[scope], m.err
}
func (m *recordingMemory) Store(_ context.Context, scope localmemory.Scope, entry localmemory.Entry) error {
	if m.err != nil {
		return m.err
	}
	if m.storeErr != nil {
		return m.storeErr
	}
	if m.entries == nil {
		m.entries = map[localmemory.Scope]localmemory.Entry{}
	}
	m.entries[scope] = entry
	m.stores = append(m.stores, scope)
	if m.afterStore != nil {
		m.afterStore()
	}
	return nil
}
func (m *recordingMemory) Forget(_ context.Context, scope localmemory.Scope) error {
	delete(m.entries, scope)
	return m.err
}

func longConversationState(t *testing.T, h *serviceHarness) string {
	t.Helper()
	s := h.service(t, &serviceTestEngine{})
	serviceReply(t, s, serviceMessage("alice", "entry", "original", "使用Codex做鹈鹕SVG，不要测试。先讨论项目名"))
	path := onlySessionFile(t, h)
	state, err := readSession(path, "alice", "entry", "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 25; i++ {
		state.Messages = append(state.Messages, Message{Role: "user", Content: strings.Repeat("补充动画的视觉细节，", 130)}, Message{Role: "assistant", Kind: "dialogue", Content: "可以，我们继续讨论。"})
	}
	state.Messages = append(state.Messages, Message{Role: "user", Content: "项目名你推荐什么？"}, Message{Role: "assistant", Kind: "dialogue", Content: "建议使用 pelican-bike-svg，你确认这个名字吗？"})
	if err := writeSession(path, state); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCompactionPersistsMemoryAndOriginalDialogueWithoutLosingReceipts(t *testing.T) {
	h := newServiceHarness(t)
	path := longConversationState(t, h)
	memory := &recordingMemory{}
	summaries := 0
	e := &serviceTestEngine{run: func(_ context.Context, history []Message, tools []tasktools.Tool, call ToolCall) (string, error) {
		if len(tools) == 0 {
			summaries++
			if call != nil {
				t.Fatal("summarizer can operate tasks")
			}
			return "用户要求Codex制作鹈鹕SVG，不要测试；助手建议pelican-bike-svg，尚待用户确认。", nil
		}
		if !strings.Contains(history[0].Content, "不要测试") || !strings.Contains(history[len(history)-2].Content, "pelican-bike-svg") || history[len(history)-1].Content != "就叫这个" {
			t.Fatal("compaction lost constraint, unresolved question or short answer")
		}
		return "这个名字可以使用，我们继续确认需求。", nil
	}}
	s := h.service(t, e)
	s.memoryProvider = memory
	answer := serviceReply(t, s, serviceMessage("alice", "entry", "continue", "就叫这个"))
	state, err := readSession(path, "alice", "entry", "")
	if err != nil {
		t.Fatal(err)
	}
	if summaries == 0 || state.Memory.Summary == "" || len(state.Messages) > 10 || len(memory.stores) != 1 {
		t.Fatal("history was not summarized and persisted")
	}
	archives, _ := filepath.Glob(filepath.Join(h.dir, "archive", "*", "*.json"))
	if len(archives) != 1 {
		t.Fatal("source conversation was not archived")
	}
	data, _ := os.ReadFile(archives[0])
	if !strings.Contains(string(data), "不要测试") {
		t.Fatal("archive lost original constraints")
	}
	restarted := h.service(t, &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
		t.Fatal("duplicate reached model")
		return "", nil
	}})
	restarted.memoryProvider = memory
	if got := serviceReply(t, restarted, serviceMessage("alice", "entry", "continue", "就叫这个")); got != answer {
		t.Fatal("compaction discarded message receipt")
	}
	if _, ok := state.Receipts["original"]; !ok {
		t.Fatal("compaction removed old dedup receipt")
	}
}

func TestCompactionAndProviderFailuresPreserveHistoryBeforeEffects(t *testing.T) {
	for _, providerFailure := range []bool{false, true} {
		t.Run(fmt.Sprint(providerFailure), func(t *testing.T) {
			h := newServiceHarness(t)
			path := longConversationState(t, h)
			before, _ := os.ReadFile(path)
			e := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
				return "", errors.New("private remote detail")
			}}
			s := h.service(t, e)
			if providerFailure {
				s.memoryProvider = &recordingMemory{err: errors.New("private provider credential")}
			}
			answer, err := s.Reply(context.Background(), serviceMessage("alice", "entry", "retryable", "继续讨论"))
			after, _ := os.ReadFile(path)
			if err == nil || answer != "" || strings.Contains(err.Error(), "private") {
				t.Fatalf("memory failure became a reply or exposed provider detail: answer=%q err=%v", answer, err)
			}
			if string(before) != string(after) || len(h.manager.created()) != 0 || len(h.manager.requests) != 0 {
				t.Fatal("memory failure changed history or operated tasks")
			}
		})
	}
}

func TestMemoryProviderRoutingUsesAuthenticatedScope(t *testing.T) {
	h := newGroupServiceHarness(t)
	base, user := &recordingMemory{}, &recordingMemory{}
	e := &serviceTestEngine{}
	s := h.service(t, e)
	if err := WithMemoryProviders(base, map[string]localmemory.Provider{"bob": user})(s); err != nil {
		t.Fatal(err)
	}
	for _, in := range []bridge.AssistantMessage{serviceMessage("alice", "entry", "1", "你好"), serviceMessage("bob", "entry", "2", "你好"), groupMessage("3", "我们先讨论方案")} {
		serviceReply(t, s, in)
	}
	if len(base.recalls) != 2 || base.recalls[0].OwnerID != "alice" || base.recalls[1].TaskID != "owned" || len(user.recalls) != 1 || user.recalls[0].OwnerID != "bob" {
		t.Fatal("memory provider or scope crossed user/chat/task boundaries")
	}
}

func TestMemoryStoreAndCheckpointFailureRemainRetryable(t *testing.T) {
	for _, checkpointFailure := range []bool{false, true} {
		t.Run(fmt.Sprint(checkpointFailure), func(t *testing.T) {
			h := newServiceHarness(t)
			path := longConversationState(t, h)
			before, _ := os.ReadFile(path)
			provider := &recordingMemory{}
			if checkpointFailure {
				provider.afterStore = func() {
					if err := os.Rename(path, path+".backup"); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(path, 0700); err != nil {
						t.Fatal(err)
					}
					provider.afterStore = nil
				}
			} else {
				provider.storeErr = errors.New("private store response")
			}
			summaries, actions := 0, 0
			expectFresh := true
			e := &serviceTestEngine{run: func(_ context.Context, history []Message, tools []tasktools.Tool, _ ToolCall) (string, error) {
				if len(tools) == 0 {
					summaries++
					if expectFresh && strings.Contains(history[1].Content, `"previous_summary":"LOCAL_`) {
						t.Fatal("uncommitted provider summary overrode the local checkpoint")
					}
					expectFresh = false
					return "LOCAL_用户要求Codex，不要测试，待确认pelican-bike-svg", nil
				}
				actions++
				return "继续讨论。", nil
			}}
			s := h.service(t, e)
			s.memoryProvider = provider
			in := serviceMessage("alice", "entry", "retryable", "就叫这个")
			answer, err := s.Reply(context.Background(), in)
			if checkpointFailure {
				if err == nil {
					t.Fatal("checkpoint write failure hidden")
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(path+".backup", path); err != nil {
					t.Fatal(err)
				}
			} else if !errors.Is(err, errMemoryProvider) || answer != "" {
				t.Fatalf("store failure produced a substitute reply: %q %v", answer, err)
			}
			after, _ := os.ReadFile(path)
			if string(before) != string(after) || actions != 0 {
				t.Fatal("failed commit changed local history or started execution")
			}
			provider.storeErr = nil
			expectFresh = true
			serviceReply(t, s, in)
			if summaries < 2 || actions != 1 || len(h.manager.created()) != 0 {
				t.Fatal("failed memory commit could not resume without task effects")
			}
		})
	}
}

func TestMidTurnBudgetFailureKeepsReceiptWithoutReplyOrRepeatedCreation(t *testing.T) {
	h := newServiceHarness(t)
	e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
		_, err := call(ctx, "herdr_create", json.RawMessage(`{"project":"project","text":"build SVG"}`))
		if err != nil {
			return "", err
		}
		return "", ErrContextBudget
	}}
	in := serviceMessage("alice", "entry", "budget", "创建一个任务")
	answer, err := h.service(t, e).Reply(context.Background(), in)
	if !errors.Is(err, ErrContextBudget) || answer != "" {
		t.Fatalf("budget failure produced a fabricated receipt reply: answer=%q err=%v", answer, err)
	}
	state, err := readSession(onlySessionFile(t, h), "alice", "entry", "")
	if err != nil || !state.Receipts[in.MessageID].Failed || len(h.manager.created()) != 1 {
		t.Fatalf("budget failure lost its failed checkpoint or registered task: %v", err)
	}
	afterRestart := &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
		if !strings.Contains(history[len(history)-2].Content, "可能已登记") {
			t.Fatal("recovery model was not told about previously executed tools")
		}
		result, err := call(ctx, "herdr_get", json.RawMessage(`{"task_id":"created-1"}`))
		if err != nil {
			return "", err
		}
		if current := result.(tasktools.Task); current.ID != "created-1" || current.Title != "build SVG" {
			t.Fatalf("recovery query lost successful operation: %+v", current)
		}
		return "已查询到此前登记的 SVG 任务。", nil
	}}
	restarted := h.service(t, afterRestart)
	if got, err := restarted.Reply(context.Background(), in); !errors.Is(err, errInterrupted) || got != "" || len(afterRestart.calls()) != 0 {
		t.Fatal("duplicate budget failure replayed a side effect or returned a substitute reply")
	}
	if got := serviceReply(t, restarted, serviceMessage("alice", "entry", "recover", "现在实际登记了吗")); got != "已查询到此前登记的 SVG 任务。" || len(h.manager.created()) != 1 {
		t.Fatal("fresh model query could not recover the earlier successful operation")
	}
}

func TestRestartPreservesAllVisibleDialogueAndLegacyReceipts(t *testing.T) {
	for _, kind := range []string{"", "dialogue", "receipt"} {
		t.Run("kind="+kind, func(t *testing.T) {
			h := newServiceHarness(t)
			serviceReply(t, h.service(t, &serviceTestEngine{}), serviceMessage("alice", "entry", "first", "讨论创建任务"))
			path := onlySessionFile(t, h)
			state, err := readSession(path, "alice", "entry", "")
			if err != nil {
				t.Fatal(err)
			}
			const visible = "  任务已登记：pelican-bike，状态：执行中。\n文件名建议使用 index.html。\n"
			state.Messages[len(state.Messages)-1] = Message{Role: "assistant", Kind: kind, Content: visible}
			if err := writeSession(path, state); err != nil {
				t.Fatal(err)
			}
			e := &serviceTestEngine{run: func(_ context.Context, history []Message, _ []tasktools.Tool, _ ToolCall) (string, error) {
				if got := history[len(history)-2]; got.Content != visible || got.Role != "assistant" {
					t.Fatalf("visible historical text was removed or rewritten: %+v", got)
				}
				return "这次的需求我已理解。", nil
			}}
			serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "next", "换一个新项目做宇宙飞船动画"))
		})
	}
}
