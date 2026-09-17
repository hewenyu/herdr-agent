package tasks

import (
	"strings"
	"testing"
	"time"
)

func TestDescriptionExposesProgressAndResultAsReadableTaskText(t *testing.T) {
	r := Record{ID: "t_42", Project: "backend", Agent: "codex", Title: "修复登录问题", Status: Review, Detail: "修复已提交，登录测试通过，等待验收", Result: "修复了过期令牌重试；测试 8 项通过", Error: "还需确认线上回调地址", ChatID: "oc_task", UpdatedAt: time.Date(2026, 9, 16, 12, 34, 56, 0, time.UTC)}
	desc := Description(r)
	for _, want := range []string{r.Title, r.Project, r.Agent, r.Status.Label(), r.Detail, r.Result, r.Error, r.ID, "2026-09-16 12:34:56", ChatURL(r.ChatID), "验收", "勾选完成"} {
		if !strings.Contains(desc, want) {
			t.Errorf("public task description lacks %q: %s", want, desc)
		}
	}
	r.Status = Destroyed
	destroyed := Description(r)
	if strings.Contains(destroyed, ChatURL(r.ChatID)) {
		t.Error("destroyed task still advertises a deleted chat")
	}
	if !strings.Contains(destroyed, r.Result) || !strings.Contains(destroyed, r.Status.Label()) {
		t.Error("destroying a session lost the durable result or state")
	}
}

func TestDescriptionMakesLocalFileLinksReadableWithoutInvalidURLs(t *testing.T) {
	// This exact link caused Feishu error 1470400 in an agent's delivered result.
	const local = "/Users/yueban/herder-agent-code/pelican-bike-svg/index.html"
	const markdown = "[index.html](" + local + ")"
	r := Record{ID: "t_local", Project: "demo", Agent: "codex", Status: Review,
		Title: markdown, Detail: markdown, Error: markdown,
		Result: "已生成 " + markdown + "\n```js\nconst points = [1, 2];\n```", ChatID: "oc_task"}
	desc := Description(r)
	if strings.Contains(desc, markdown) || strings.Count(desc, "index.html（"+local+"）") != 4 {
		t.Fatalf("local links were retained or lost their label/path: %s", desc)
	}
	if !strings.Contains(desc, "const points = [1, 2];") || !strings.Contains(desc, ChatURL(r.ChatID)) {
		t.Fatal("normalizing file links lost code content or the task-group URL")
	}
	if r.Title != markdown || !strings.Contains(r.Result, markdown) {
		t.Fatal("description rendering modified the original agent result")
	}
}

func TestDescriptionLinkNormalizationPreservesSupportedLinksAndDestinations(t *testing.T) {
	for _, tc := range []struct{ text, want string }{
		{"[file](./src/main.go:12)", "file（./src/main.go:12）"},
		{"[file](file:///tmp/index.html)", "file（file:///tmp/index.html）"},
		{"![image](/tmp/screen.png)", "image（/tmp/screen.png）"},
		{"[file](</Users/example/My Project/main.go:3>)", "file（</Users/example/My Project/main.go:3>）"},
		{"[file](/tmp/project(copy)/index.html)", "file（/tmp/project(copy)/index.html）"},
		{"[section](#result)", "section（#result）"},
		{"[mail](mailto:dev@example.test)", "mail（mailto:dev@example.test）"},
		{"[docs](https://example.test/docs)", "[docs](https://example.test/docs)"},
		{"[docs](http://example.test/docs)", "[docs](http://example.test/docs)"},
		{"[task](applink://client/task/123)", "[task](applink://client/task/123)"},
		{`[docs](https://example.test/docs "Documentation")`, `[docs](https://example.test/docs "Documentation")`},
		{"[docs](<https://example.test/docs>)", "[docs](<https://example.test/docs>)"},
		{"[file][source]\n[source]: /tmp/index.html", "[file][source]\nsource：/tmp/index.html"},
		{"[docs][source]\n[source]: https://example.test/docs", "[docs][source]\n[source]: https://example.test/docs"},
		{"<file:///tmp/index.html>", "file:///tmp/index.html"},
		{"<https://example.test/docs>", "<https://example.test/docs>"},
	} {
		t.Run(tc.text, func(t *testing.T) {
			if got := descriptionText(tc.text); got != tc.want {
				t.Fatalf("descriptionText = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDescriptionNormalizesLocalLinksBeforeClipping(t *testing.T) {
	path := "/Users/example/" + strings.Repeat("folder/", 120) + "index.html"
	desc := Description(Record{Title: "[long path](" + path + ")", Result: "仍保留最终结果"})
	if strings.Contains(desc, "[long path](") || !strings.Contains(desc, "long path（/Users/example/") || !strings.Contains(desc, "仍保留最终结果") {
		t.Fatalf("clipping retained an unsupported Markdown URL or lost content: %s", desc)
	}
}

func TestDescriptionLinkNormalizationPreservesInlineAndFencedCode(t *testing.T) {
	const code = "handlers[0](ctx)\n[source]: /tmp/source.go\n[file](/tmp/source.go)\n<file:///tmp/source.go>"
	for _, tc := range []struct{ name, text string }{
		{"inline", "调用 `handlers[0](ctx)` 即可"},
		{"long inline", "调用 ``handlers[0](ctx); `nested` `` 即可"},
		{"multiline inline", "`" + code + "`"},
		{"backtick fence", "```go\n" + code + "\n```"},
		{"long backtick fence", "````go\n" + code + "\n```\nhandlers[0](ctx)\n`````"},
		{"tilde fence", "~~~go\n" + code + "\n~~~"},
		{"long tilde fence", "~~~~go\n" + code + "\n~~~\nhandlers[0](ctx)\n~~~~~"},
		{"indented fence", "  ```go\n" + code + "\n  ```"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text := tc.text + "\n[file](/tmp/real.go)\n[ref]: /tmp/real.go"
			want := tc.text + "\nfile（/tmp/real.go）\nref：/tmp/real.go"
			if got := descriptionText(text); got != want {
				t.Fatalf("code changed or ordinary links escaped normalization:\n got %q\nwant %q", got, want)
			}
			desc := Description(Record{Title: "修复处理器", Result: text})
			if !strings.Contains(desc, want) {
				t.Fatalf("task description lost code content: %s", desc)
			}
		})
	}
	openFence := "```go\n" + code
	if got := descriptionText(openFence); got != openFence {
		t.Fatalf("unfinished code fence lost code content: %q", got)
	}
}

func TestTaskCommandsPreserveTaskTextAndRecognizeProgressQueries(t *testing.T) {
	tests := []struct {
		input string
		want  Command
	}{
		{"新建一个任务：修复登录问题", Command{Kind: "new", Text: "修复登录问题"}},
		{"新建任务: 为接口补充测试", Command{Kind: "new", Text: "为接口补充测试"}},
		{"/new backend claude 修复登录\n并验证退出登录", Command{Kind: "new", Project: "backend", Agent: "claude", Text: "修复登录\n并验证退出登录"}},
		{"/new backend 处理超时错误", Command{Kind: "new", Project: "backend", Text: "处理超时错误"}},
		{"飞书", Command{}},
		{"正在进行哪些任务", Command{Kind: "list"}},
		{"现在有哪些任务在进行？", Command{Kind: "list"}},
		{"/tasks all", Command{Kind: "list", All: true}},
		{"/task destroy t_42", Command{Kind: "action", Action: "destroy", ID: "t_42"}},
		{"/task complete", Command{Kind: "action", Action: "complete"}},
		{"/task close", Command{Kind: "action", Action: "close"}},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, recognized := Parse(tt.input)
			if got != tt.want || recognized != (tt.want.Kind != "") {
				t.Fatalf("Parse = %+v, %v; want %+v", got, recognized, tt.want)
			}
		})
	}
	for _, input := range []string{"/new backend", "/task delete-all", "/tasks nonsense", "新建任务"} {
		if got, recognized := Parse(input); !recognized || got.Error == "" {
			t.Errorf("invalid command %q = %+v, %v", input, got, recognized)
		}
	}
}

func TestSummaryLetsUserIdentifyCurrentTasksAndSyncFailures(t *testing.T) {
	records := []Record{
		{ID: "t_1", Title: "修复登录", Project: "api", Agent: "codex", Status: Running, Detail: "正在验证重试逻辑", URL: "https://example.test/task/1", ChatID: "oc_1"},
		{ID: "t_2", Title: "排查构建", Project: "web", Agent: "claude", Status: Blocked, Detail: "等待审批", Error: "需要执行构建", SyncError: "temporary timeout"},
	}
	text := Summary(records)
	for _, want := range []string{"2", "修复登录", "执行中", "正在验证重试逻辑", "api", "codex", "t_1", records[0].URL, ChatURL("oc_1"), "排查构建", "等待你处理", "需要执行构建", "飞书同步暂未成功", "temporary timeout"} {
		if !strings.Contains(text, want) {
			t.Errorf("summary lacks %q: %s", want, text)
		}
	}
	if text := Summary(nil); !strings.Contains(text, "没有") || !strings.Contains(text, "新建任务") {
		t.Errorf("empty state = %s", text)
	}
}

func TestGroupCloseRequiresExplicitWholeMessage(t *testing.T) {
	for _, text := range []string{"/关闭项目", "关闭本项目", "已完成，关闭本项目", "已经完成了本项目，关闭本项目", " ／关闭项目 "} {
		cmd, ok := GroupCloseCommand(text)
		if !ok || cmd.Kind != "close_prompt" {
			t.Errorf("close request %q = %+v, %v", text, cmd, ok)
		}
	}
	for _, text := range []string{"确认关闭", "确认关闭本项目。", "/确认关闭"} {
		cmd, ok := GroupCloseCommand(text)
		if !ok || cmd.Kind != "action" || cmd.Action != "close" || cmd.ID != "" {
			t.Errorf("confirmation %q = %+v, %v", text, cmd, ok)
		}
	}
	for _, text := range []string{"不要确认关闭", "确认关闭？", "等完成后确认关闭", "他说“确认关闭”", "确认关闭 other-task", "已完成，关闭本项目，但保留群", "尚未完成，关闭本项目", "确认关闭\n还有一个问题"} {
		if cmd, ok := GroupCloseCommand(text); ok {
			t.Errorf("non-command %q matched %+v", text, cmd)
		}
	}
}
