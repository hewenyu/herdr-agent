package mirror

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestCodexToolCallsSummarizeOperations(t *testing.T) {
	patch := "*** Begin Patch\n*** Add File: index.html\n+<html>private file contents</html>\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch"
	quotedPatch, _ := json.Marshal(patch)
	cases := []struct {
		name, tool string
		input      any
		want       []string
	}{
		{
			name: "unquoted object keys in text await wrapper", tool: "exec",
			input: `text(await tools.exec_command({cmd: "ls -la", workdir: "/tmp", yield_time_ms: 10000}));`,
			want:  []string{"exec_command(ls -la)"},
		},
		{
			name: "single quotes and trailing commas", tool: "functions.exec",
			input: `const r = await tools.exec_command({'cmd': 'echo \'hello\'', workdir: '/tmp',}); text(r);`,
			want:  []string{"exec_command(echo 'hello')"},
		},
		{
			name: "patch wrapper only shows affected files", tool: "exec",
			input: "text(await tools.apply_patch(" + string(quotedPatch) + "));",
			want:  []string{"apply_patch(index.html, README.md)"},
		},
		{
			name: "template patch wrapper", tool: "exec",
			input: "text(await tools.apply_patch(`" + patch + "`));",
			want:  []string{"apply_patch(index.html, README.md)"},
		},
		{
			name: "direct freeform patch", tool: "apply_patch", input: patch,
			want: []string{"apply_patch(index.html, README.md)"},
		},
		{
			name: "parallel calls have separate summaries", tool: "exec",
			input: `const r = await Promise.allSettled([tools.exec_command({cmd: "pwd"}), tools.view_image({path: "/tmp/pelican.png"})]); r.forEach(text);`,
			want:  []string{"exec_command(pwd)", "view_image(/tmp/pelican.png)"},
		},
		{
			name: "argv command in a literal object", tool: "exec",
			input: `await tools.exec_command({cmd: ["/bin/zsh", "-lc", "ls -la"]});`,
			want:  []string{"exec_command(/bin/zsh -lc ls -la)"},
		},
		{
			name: "JSON encoded object remains supported", tool: "exec_command",
			input: `{"cmd":"echo \"hi\"","workdir":"/tmp"}`,
			want:  []string{`exec_command(echo "hi")`},
		},
		{
			name: "plain object keeps path not file content", tool: "apply_patch",
			input: map[string]any{"file_path": "index.html", "content": "private file content"},
			want:  []string{"apply_patch(index.html)"},
		},
		{
			name: "quoted and commented fake calls are opaque", tool: "exec",
			input: `const example = "tools.exec_command({cmd: 'fake'})"; /* tools.apply_patch("fake") */
// tools.exec_command({cmd: "fake"})
text(await tools.exec_command({cmd: "pwd"}));`,
			want: []string{"exec_command(pwd)"},
		},
		{
			name: "unknown single field cannot expose script", tool: "exec",
			input: map[string]any{"code": "text(await tools.apply_patch(privatePatch))"},
			want:  []string{"exec"},
		},
		{
			name: "unknown call arguments use only its name", tool: "exec",
			input: `text(await tools.some_tool({content: "private payload"}));`,
			want:  []string{"some_tool"},
		},
		{
			name: "dynamic command is not guessed", tool: "exec",
			input: `text(await tools.exec_command({cmd: "prefix" + command}));`,
			want:  []string{"exec_command"},
		},
		{
			name: "a dynamic override cannot reuse an earlier literal", tool: "exec",
			input: `text(await tools.exec_command({cmd: "prefix", ...options}));`,
			want:  []string{"exec_command"},
		},
		{
			name: "a regex cannot masquerade as a tool call", tool: "exec",
			input: `const regex = /tools.exec_command({cmd: "fake"})/; text(regex);`,
			want:  []string{"exec"},
		},
		{
			name: "control escapes still use summary sanitization", tool: "exec",
			input: `text(await tools.exec_command({cmd: "echo \x1b[31mred\x1b[0m"}));`,
			want:  []string{"exec_command(echo red)"},
		},
		{
			name: "dynamic patch variable uses only operation name", tool: "exec",
			input: `text(await tools.apply_patch(patch));`,
			want:  []string{"apply_patch"},
		},
		{
			name: "interpolated template falls back without raw code", tool: "exec",
			input: "text(await tools.exec_command({cmd: `echo ${secret}`}));",
			want:  []string{"exec"},
		},
		{
			name: "unsupported wrapper never echoes its first line", tool: "exec",
			input: `text(await invoke(privateScript));`,
			want:  []string{"exec"},
		},
		{
			name: "incomplete script falls back", tool: "exec",
			input: `text(await tools.exec_command({cmd: "unterminated`,
			want:  []string{"exec"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.input)
			if err != nil {
				t.Fatal(err)
			}
			got := newCodexParser(nil).toolCalls(tc.tool, raw, 1)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("tool summaries = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCodexFunctionCallUsesArgumentsAndDropsOutput(t *testing.T) {
	input := `{"ordinal":1,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}
{"ordinal":2,"type":"response_item","payload":{"type":"function_call_output","output":"private output"}}
{"ordinal":3,"type":"response_item","payload":{"type":"reasoning","text":"private reasoning"}}
`
	turns, _, err := newCodexParser(nil).Parse([]byte(input))
	if err != nil || len(turns) != 1 || !reflect.DeepEqual(turns[0].ToolCalls, []string{"exec_command(pwd)"}) || turns[0].Text != "" {
		t.Fatalf("unexpected mirrored turns: %+v, %v", turns, err)
	}
}
