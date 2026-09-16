package tasks

import (
	"strings"
	"testing"
	"time"
)

func TestDescriptionFitsFeishuLimitAndKeepsTrackingFields(t *testing.T) {
	r := Record{ID: "t_abc", OwnerID: "ou_me", Project: "项目", Agent: "codex", Status: Review, Title: strings.Repeat("任", 3000), Detail: strings.Repeat("进", 2000), Result: strings.Repeat("答", 6000), Error: strings.Repeat("错", 2000), ChatID: "oc_chat", UpdatedAt: time.Now()}
	d := Description(r)
	if n := len([]rune(d)); n > 3000 {
		t.Fatalf("description has %d chars, Feishu accepts 3000", n)
	}
	for _, want := range []string{r.ID, r.Status.Label(), ChatURL(r.ChatID), "最近交付", "答", "已截取"} {
		if !strings.Contains(d, want) {
			t.Errorf("missing %q", want)
		}
	}
}

func TestNaturalTaskCreationUsesConfiguredDefaultProject(t *testing.T) {
	for _, input := range []string{"新建一个任务，修复登录问题", "帮我新建一个任务：修复登录问题", "新建任务 修复登录问题"} {
		c, ok := Parse(input)
		if !ok || c.Kind != "new" || c.Text != "修复登录问题" || c.Project != "" {
			t.Errorf("Parse(%q)=%+v,%v", input, c, ok)
		}
	}
	if _, ok := Parse("新建任务的时候报错了，请检查"); ok {
		t.Fatal("ordinary diagnostic message treated as a creation command")
	}
}
