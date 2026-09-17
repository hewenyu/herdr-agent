package mirror

import (
	"strings"
	"testing"
)

func TestSanitizeText(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain text is untouched", "hello there", "hello there"},
		{"csi colour", "\x1b[31mred\x1b[0m and \x1b[1;32mgreen\x1b[m", "red and green"},
		{"csi cursor movement", "a\x1b[2K\x1b[1Gb", "ab"},
		{"osc title terminated by bel", "\x1b]0;Action Required\x07after", "after"},
		{"osc title terminated by st", "\x1b]2;title\x1b\\after", "after"},
		{"truncated csi eats the tail rather than leaking it", "keep\x1b[3", "keep"},
		{"lone trailing esc", "keep\x1b", "keep"},
		{"two byte escape", "a\x1b(Bb", "ab"},
		{"box drawing frame", "╭─────╮\n│ hi  │\n╰─────╯", "hi"},
		{"block elements", "progress ███░░", "progress"},
		{"geometric shapes are prose, not frames", "• bullet ▶ play", "• bullet ▶ play"},
		{"crlf collapses", "a\r\nb\r\n", "a\nb"},
		{"lone cr becomes a newline", "a\rb", "a\nb"},
		{"nul and bell are dropped", "a\x00b\x07c", "abc"},
		{"tabs survive", "a\tb", "a\tb"},
		{"trailing whitespace per line", "a   \n\tb\t\t\nc", "a\n\tb\nc"},
		{"indentation survives", "line\n    indented", "line\n    indented"},
		{"surrounding blank space is trimmed", "\n\n  hi  \n\n", "hi"},
		{"cjk is not mangled", "中文 — dash", "中文 — dash"},
		{"empty", "", ""},
		{"only escapes", "\x1b[0m\x1b[0m", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeText(tt.in); got != tt.want {
				t.Errorf("sanitizeText(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestToolSummary(t *testing.T) {
	tests := []struct {
		name, tool, arg, want string
	}{
		{"contract example", "Bash", "touch x.txt", "Bash(touch x.txt)"},
		{"no argument means no parentheses", "TodoWrite", "", "TodoWrite"},
		{"nameless call still renders", "", "ls", "tool(ls)"},
		{"multi-line command becomes one line", "Bash", "cd /tmp &&\n  make   test", "Bash(cd /tmp && make test)"},
		{"ansi in the argument is stripped", "Bash", "echo \x1b[31mred\x1b[0m", "Bash(echo red)"},
		{
			name: "long argument is truncated",
			tool: "Bash",
			arg:  strings.Repeat("x", 200),
			want: "Bash(" + strings.Repeat("x", maxToolArgRunes) + "…)",
		},
		{
			name: "truncation counts runes, not bytes",
			tool: "Bash",
			arg:  strings.Repeat("中", 100),
			want: "Bash(" + strings.Repeat("中", maxToolArgRunes) + "…)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := toolSummary(tt.tool, tt.arg); got != tt.want {
				t.Errorf("toolSummary(%q, %q) = %q, want %q", tt.tool, tt.arg, got, tt.want)
			}
		})
	}
}

func TestPickToolArg(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]any
		want  string
	}{
		{
			name:  "the command beats the description",
			input: map[string]any{"description": "Create empty file", "command": "touch x.txt"},
			want:  "touch x.txt",
		},
		{
			name:  "file_path beats content",
			input: map[string]any{"content": "the whole file", "file_path": "/tmp/a.md"},
			want:  "/tmp/a.md",
		},
		{
			name:  "pattern for a search",
			input: map[string]any{"pattern": "TODO", "path": "/src", "output_mode": "content"},
			want:  "TODO",
		},
		{
			name:  "argv list is joined",
			input: map[string]any{"cmd": []any{"/bin/zsh", "-lc", "ls -la"}},
			want:  "/bin/zsh -lc ls -la",
		},
		{
			name:  "a single unknown field is unambiguous",
			input: map[string]any{"expression": "1+1"},
			want:  "1+1",
		},
		{
			name:  "nothing identifying",
			input: map[string]any{"todos": []any{}, "count": 3.0},
			want:  "",
		},
		{"empty", map[string]any{}, ""},
		{"nil", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := pickToolArg(tt.input); got != tt.want {
				t.Errorf("pickToolArg(%v) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestIsInjectedContext(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"agents md preamble", "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nx\n</INSTRUCTIONS>", true},
		{"environment context", "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>", true},
		{"user instructions", "<user_instructions>be nice</user_instructions>", true},
		{"prose", "please run the tests", false},
		{"prose that mentions agents md", "update AGENTS.md for me", false},
		{"markup inside prose", "<b>bold</b> and then some", false},
		{"unclosed tag", "<environment_context> oh no", false},
		{"mismatched tag", "<a>x</b>", false},
		{"not a tag name", "<3 this> x </3 this>", false},
		// The filter is an allowlist, not a shape test: prose the human really
		// typed is often one well-formed element, and dropping it leaves the
		// assistant answering a question the chat never shows.
		{"a single element the human typed", "<div>fix this markup for me</div>", false},
		{"an element Codex does not write", "<note>remember this</note>", false},
		{"an injected wrapper with prose after it", "<environment_context>x</environment_context> and now do the thing", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isInjectedContext(tt.in); got != tt.want {
				t.Errorf("isInjectedContext(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestIsInjectedClaudeText(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		// The real shape: three elements in a row, indented as claude writes it.
		{
			name: "slash command",
			in:   "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>",
			want: true,
		},
		{"command output", "<local-command-stdout>Set model to Opus</local-command-stdout>", true},
		{"system reminder", "<system-reminder>Your todo list is empty</system-reminder>", true},
		{"prose", "run the tests and tell me what breaks", false},
		{"markup the human typed", "<div>fix this markup for me</div>", false},
		{"a command wrapper quoted inside prose", "what does <command-name>/clear</command-name> do?", false},
		{"half a wrapper", "<command-name>/clear", false},
		{"an opening angle bracket and nothing else", "<oops", false},
		{"an empty element", "<></>", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isInjectedClaudeText(tt.in); got != tt.want {
				t.Errorf("isInjectedClaudeText(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}
