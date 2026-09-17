package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

func addEndedTasks(h *serviceHarness) {
	h.manager.records["completed"] = tasks.Record{ID: "completed", OwnerID: "alice", Title: "HISTORICAL_COMPLETED", Status: tasks.Completed, Started: true, PromptSent: true}
	h.manager.records["destroyed"] = tasks.Record{ID: "destroyed", OwnerID: "alice", Title: "HISTORICAL_DESTROYED", Status: tasks.Destroyed, CloseRequested: true, Started: true, PromptSent: true, ChatDeleted: true}
}

func TestTaskListingUsesModelArgumentsWithoutLanguageOverrides(t *testing.T) {
	for _, query := range []string{"现在还有哪些任务", "查看所有任务", "archived-project 任务进度如何", "api 和 api-web 进度如何"} {
		for _, all := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/all=%v", query, all), func(t *testing.T) {
				h := newServiceHarness(t)
				addEndedTasks(h)
				const answer = "这是根据本次查询结果整理的任务概况。"
				e := &serviceTestEngine{run: func(ctx context.Context, history []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
					if history[len(history)-1].Content != query {
						t.Fatal("query did not reach the model")
					}
					for _, name := range []string{"alice-private-task", "HISTORICAL_COMPLETED", "HISTORICAL_DESTROYED", "bob-private-task"} {
						if strings.Contains(history[0].Content, name) {
							t.Fatalf("service queried and injected task data before tool selection: %s", name)
						}
					}
					args, _ := json.Marshal(map[string]bool{"all": all})
					result, err := call(ctx, "herdr_list", args)
					if err != nil {
						return "", err
					}
					listed := result.([]tasktools.Task)
					wantCount := 1
					if all {
						wantCount = 3
					}
					if len(listed) != wantCount {
						t.Fatalf("model all=%v was overridden by query text: %+v", all, listed)
					}
					for _, task := range listed {
						if task.ID == "other" || task.Title == "bob-private-task" {
							t.Fatal("model list arguments escaped authenticated ownership")
						}
						if !all && (task.Status == tasks.Completed || task.Status == tasks.Destroyed) {
							t.Fatal("task backend ignored all=false")
						}
					}
					return answer, nil
				}}
				if got := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "query", query)); got != answer || len(e.calls()) != 1 {
					t.Fatalf("model task overview replaced by deterministic output: %q", got)
				}
				if len(h.manager.created()) != 0 || len(h.manager.requests) != 0 {
					t.Fatal("list query caused a mutation")
				}
			})
		}
	}
}

func TestGroupModelCanQueryCompletedBoundTask(t *testing.T) {
	h := newGroupServiceHarness(t)
	r := h.manager.records["owned"]
	r.Status = tasks.Completed
	h.manager.records[r.ID] = r
	const answer = "当前任务已经完成，群仍保留。"
	e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
		result, err := call(ctx, "herdr_get", json.RawMessage(`{}`))
		if err != nil {
			return "", err
		}
		if task := result.(tasktools.Task); task.ID != "owned" || task.Status != tasks.Completed {
			t.Fatalf("group query changed its bound completed task: %+v", task)
		}
		return answer, nil
	}}
	if got := serviceReply(t, h.service(t, e), groupMessage("group-progress", "现在还有哪些任务")); got != answer || len(e.calls()) != 1 {
		t.Fatalf("group task query bypassed model response: %q", got)
	}
}

func TestModelCanQueryOrReopenExplicitEndedTask(t *testing.T) {
	for _, tc := range []struct{ text, tool, args, answer string }{
		{"destroyed 任务状态如何", "herdr_get", `{"task_id":"destroyed"}`, "destroyed 的会话已经关闭。"},
		{"重开 completed 任务", "herdr_reopen", `{"task_id":"completed"}`, "已提交重新打开 completed 的请求。"},
	} {
		t.Run(tc.tool, func(t *testing.T) {
			h := newServiceHarness(t)
			addEndedTasks(h)
			e := &serviceTestEngine{run: func(ctx context.Context, _ []Message, _ []tasktools.Tool, call ToolCall) (string, error) {
				result, err := call(ctx, tc.tool, json.RawMessage(tc.args))
				if err != nil {
					return "", err
				}
				if tc.tool == "herdr_get" {
					task := result.(tasktools.Task)
					if task.Status != tasks.Destroyed || task.CloseRequested || task.ChatURL != "" {
						t.Fatalf("closed task tool data suggests pending closure: %+v", task)
					}
				}
				return tc.answer, nil
			}}
			if got := serviceReply(t, h.service(t, e), serviceMessage("alice", "entry", "specific", tc.text)); got != tc.answer || len(e.calls()) != 1 {
				t.Fatalf("explicit ended task request did not use model response: %q", got)
			}
			if tc.tool == "herdr_reopen" && (len(h.manager.requests) != 1 || h.manager.requests[0] != (serviceRequest{"alice", "completed", "reopen"})) {
				t.Fatalf("model reopen request did not reach backend: %+v", h.manager.requests)
			}
		})
	}
}
