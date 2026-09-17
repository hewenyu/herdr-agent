package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

func addEndedTasks(h *serviceHarness) {
	h.manager.records["completed"] = tasks.Record{ID: "completed", OwnerID: "alice", Title: "HISTORICAL_COMPLETED", Status: tasks.Completed, Started: true, PromptSent: true}
	h.manager.records["destroyed"] = tasks.Record{ID: "destroyed", OwnerID: "alice", Title: "HISTORICAL_DESTROYED", Status: tasks.Destroyed, CloseRequested: true, Started: true, PromptSent: true, ChatDeleted: true}
}

func assertNoHistory(t *testing.T, text string) {
	t.Helper()
	for _, historical := range []string{"HISTORICAL_COMPLETED", "HISTORICAL_DESTROYED", "结单已登记，正在同步完成并关闭会话"} {
		if strings.Contains(text, historical) {
			t.Fatalf("current-task overview exposed historical detail %q: %s", historical, text)
		}
	}
}

func TestDefaultChineseTaskQueriesOnlyShowUnfinishedTasks(t *testing.T) {
	for _, text := range []string{"现在还有哪些任务", "现在有哪些任务？", "正在进行哪些任务", "请告诉我目前还有哪些任务？"} {
		for _, active := range []bool{true, false} {
			t.Run(text+map[bool]string{true: "/with-active", false: "/only-history"}[active], func(t *testing.T) {
				h := newServiceHarness(t)
				addEndedTasks(h)
				if !active {
					delete(h.manager.records, "owned")
				}
				e := &serviceTestEngine{run: func(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error) {
					return "", errors.New("bounded current-task question should not call the model")
				}}
				answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "query", text))
				assertNoHistory(t, answer)
				if active && !strings.Contains(answer, "alice-private-task") || !active && !strings.Contains(answer, "没有正在进行的任务") {
					t.Fatalf("incorrect current task overview: %s", answer)
				}
				if len(e.calls()) != 0 || len(h.manager.requests) != 0 {
					t.Fatal("read-only overview invoked model or mutation")
				}
			})
		}
	}
}

func TestDefaultTaskOverviewCannotBeExpandedByModelOrFallback(t *testing.T) {
	for _, withTool := range []bool{false, true} {
		t.Run(map[bool]string{false: "no-tool-fallback", true: "model-all-true"}[withTool], func(t *testing.T) {
			h := newServiceHarness(t)
			addEndedTasks(h)
			e := &serviceTestEngine{run: func(ctx context.Context, messages []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
				assertNoHistory(t, messages[0].Content)
				if withTool {
					result, err := call(ctx, "herdr_list", json.RawMessage(`{"all":true}`))
					if err != nil {
						return "", err
					}
					listed := result.([]tasktools.Task)
					if len(listed) != 1 || listed[0].ID != "owned" {
						t.Fatalf("model expanded current overview with all=true: %+v", listed)
					}
				}
				return inventedStatus, nil
			}}
			answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "overview", "帮我汇总眼下手头还有什么工作"))
			assertNoHistory(t, answer)
			if len(e.calls()) != 1 || !strings.Contains(answer, "alice-private-task") {
				t.Fatalf("model/fallback overview lost active task: %s", answer)
			}
		})
	}
}

func TestExplicitHistoricalTaskQueriesIncludeEndedRecordsWithoutPendingClosure(t *testing.T) {
	for _, text := range []string{"查看历史任务", "查看所有任务", "有哪些已完成的任务", "列出 all 任务", "请汇总历史任务的执行详情"} {
		for _, withTool := range []bool{false, true} {
			t.Run(text+map[bool]string{false: "/fallback", true: "/tool"}[withTool], func(t *testing.T) {
				h := newServiceHarness(t)
				addEndedTasks(h)
				e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
					if withTool {
						if _, err := call(ctx, "herdr_list", json.RawMessage(`{"all":true}`)); err != nil {
							return "", err
						}
					}
					return inventedStatus, nil
				}}
				answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "history", text))
				for _, want := range []string{"HISTORICAL_COMPLETED", "HISTORICAL_DESTROYED", "会话已销毁"} {
					if !strings.Contains(answer, want) {
						t.Fatalf("explicit history query lost %q: %s", want, answer)
					}
				}
				if strings.Contains(answer, "正在同步完成并关闭会话") {
					t.Fatalf("destroyed history claimed closure still pending: %s", answer)
				}
			})
		}
	}
}

func TestGroupTaskQueryStillShowsItsCompletedBoundTask(t *testing.T) {
	h := newGroupServiceHarness(t)
	r := h.manager.records["owned"]
	r.Status = tasks.Completed
	h.manager.records[r.ID] = r
	e := &serviceTestEngine{}
	answer := serviceReply(t, h.service(t, e), groupMessage("group-progress", "现在还有哪些任务"))
	if !strings.Contains(answer, "任务：owned") || !strings.Contains(answer, "当前状态：已完成") || strings.Contains(answer, "ANOTHER_TASK_PRIVATE") {
		t.Fatalf("default list filtering changed group-bound query: %s", answer)
	}
}

func TestExplicitTaskIDStillFindsEndedRecordForDetailsAndReopen(t *testing.T) {
	for _, text := range []string{"destroyed 任务状态如何", "重开 completed 任务"} {
		t.Run(text, func(t *testing.T) {
			h := newServiceHarness(t)
			addEndedTasks(h)
			e := &serviceTestEngine{run: func(ctx context.Context, messages []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
				if !strings.Contains(messages[0].Content, "HISTORICAL_COMPLETED") {
					return "", errors.New("explicit completed task ID was removed from context")
				}
				_, err := call(ctx, "herdr_reopen", json.RawMessage(`{"task_id":"completed"}`))
				return "已登记请求", err
			}}
			answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "specific", text))
			if text == "destroyed 任务状态如何" {
				if !strings.Contains(answer, "HISTORICAL_DESTROYED") || len(e.calls()) != 0 {
					t.Fatalf("explicit destroyed detail was hidden: %s", answer)
				}
			} else if !strings.Contains(answer, "重新打开任务") || len(h.manager.requests) != 1 || h.manager.requests[0].ID != "completed" {
				t.Fatalf("explicit completed target could not be reopened: %s", answer)
			}
		})
	}
}

func TestDestroyedReceiptDoesNotClaimClosureInProgress(t *testing.T) {
	answer := renderTasks([]tasktools.Task{{ID: "closed", Status: tasks.Destroyed, CloseRequested: true}})
	if !strings.Contains(answer, "会话已销毁") || strings.Contains(answer, "正在同步完成并关闭会话") {
		t.Fatalf("old receipt was rendered as pending closure: %s", answer)
	}
}

func TestCurrentScopeIsNotMistakenForHistory(t *testing.T) {
	for _, text := range []string{"现在还有哪些任务", "现在有哪些任务", "正在进行哪些任务", "所有未完成任务", "查看所有项目正在进行的任务", "查看任务，不要历史", "call 函数还有问题"} {
		if taskHistoryRequested(text) {
			t.Fatalf("current query expanded to history: %s", text)
		}
	}
}

func TestNamedEndedProjectDoesNotFallBackToUnrelatedActiveTasks(t *testing.T) {
	for _, status := range []tasks.Status{tasks.Completed, tasks.Destroyed} {
		for _, text := range []string{"archived-project 任务进度如何", "请汇总 archived-project 的执行细节"} {
			t.Run(string(status)+"/"+text, func(t *testing.T) {
				h := newServiceHarness(t)
				h.manager.records["old-task-record"] = tasks.Record{
					ID: "old-task-record", OwnerID: "alice", Project: "archived-project", Title: "ARCHIVED_TASK", Status: status,
				}
				e := &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
					if strings.Contains(history[0].Content, "alice-private-task") {
						t.Fatal("named project query supplied an unrelated task to the model")
					}
					for _, raw := range []string{`{}`, `{"all":true}`} {
						result, err := call(ctx, "herdr_list", json.RawMessage(raw))
						if err != nil {
							return "", err
						}
						if listed := result.([]tasktools.Task); len(listed) != 0 {
							t.Fatalf("named project query returned unrelated or ended tasks: %+v", listed)
						}
					}
					return inventedStatus, nil
				}}
				answer := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "scoped-query", text))
				if strings.Contains(answer, "alice-private-task") || strings.Contains(answer, "ARCHIVED_TASK") || !strings.Contains(answer, "没有正在进行的任务") {
					t.Fatalf("named project query was broadened: %s", answer)
				}
			})
		}
	}
}

func TestTaskReferencesPreferCompleteNamesAndPreserveSeparateMentions(t *testing.T) {
	records := []tasktools.Task{
		{ID: "task-short", Project: "api", Title: "Short project", Status: tasks.Running},
		{ID: "task-long", Project: "api-web", Title: "Long project", Status: tasks.Running},
		{ID: "task-ended", Project: "archive", Title: "Ended task", Status: tasks.Completed},
	}
	for _, tc := range []struct {
		query string
		ids   string
	}{
		{"api-web 进度如何", "task-long"},
		{"api 和 api-web 进度如何", "task-short,task-long"},
		{"查看 archive 历史任务", "task-ended"},
		{"archive 进度如何", ""},
		{"task-ended 进度如何", "task-ended"},
	} {
		t.Run(tc.query, func(t *testing.T) {
			var ids []string
			for _, task := range progressRecords(tc.query, records, false) {
				ids = append(ids, task.ID)
			}
			if got := strings.Join(ids, ","); got != tc.ids {
				t.Fatalf("task selection = %q; want %q", got, tc.ids)
			}
		})
	}
	for _, ordered := range [][]tasktools.Task{records, {records[2], records[1], records[0]}} {
		if !progressOnly("api-web 进度如何", ordered) {
			t.Fatal("overlapping project names sent a bounded progress question to the model")
		}
	}
}
