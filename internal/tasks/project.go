package tasks

import (
	"fmt"
	"strings"
)

// The launch args grant access; this context also tells the coding agent where
// the other parts of a multi-directory project actually live.
func initialPrompt(r Record) string {
	if len(r.Directories) < 2 {
		return r.Title
	}
	var b strings.Builder
	fmt.Fprintf(&b, "项目 %s 的已配置目录（第一个为工作目录，其余已通过 --add-dir 加入）：\n", r.Project)
	for _, dir := range r.Directories {
		fmt.Fprintf(&b, "- %q\n", dir)
	}
	b.WriteString("请使用这些已有目录完成任务，不要另建项目目录。\n\n任务要求：\n")
	b.WriteString(r.Title)
	return b.String()
}
