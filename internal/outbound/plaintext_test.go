package outbound

import (
	"strings"
	"testing"
)

func TestToPlainText(t *testing.T) {
	tests := []struct {
		name string
		src  string
		want string
	}{
		{"empty", "", ""},
		{"plain prose survives", "nothing to strip here", "nothing to strip here"},

		{"strong", "a **bold** claim", "a bold claim"},
		{"strong underscores", "a __bold__ claim", "a bold claim"},
		{"emphasis", "an *italic* word", "an italic word"},
		{"emphasis underscore", "an _italic_ word", "an italic word"},
		{"strikethrough", "it is ~~gone~~ now", "it is gone now"},
		{"nested emphasis", "**very *very* bold**", "very very bold"},

		{"snake_case is not emphasis", "call agent_status_changed now", "call agent_status_changed now"},
		{"arithmetic is not emphasis", "2 * 3 * 4 = 24", "2 * 3 * 4 = 24"},
		{"list bullet is not emphasis", "* first item", "* first item"},
		{"lone tilde", "a ~ b", "a ~ b"},

		{"inline code", "run `herdr agent list` first", "run herdr agent list first"},
		{"inline code keeps its markup", "`**not bold**`", "**not bold**"},
		{"unmatched backtick", "a ` dangling tick", "a ` dangling tick"},

		{"link", "see [the docs](https://example.com/x)", "see the docs (https://example.com/x)"},
		{"link whose text is the url", "[https://x.dev](https://x.dev)", "https://x.dev"},
		{"link with title", `[docs](https://x.dev "Title")`, "docs (https://x.dev)"},
		{"image", "![diagram](https://x.dev/a.png)", "diagram (https://x.dev/a.png)"},
		{"bracket that is not a link", "an array [0] index", "an array [0] index"},
		{"autolink", "visit <https://x.dev> today", "visit https://x.dev today"},
		{"angle brackets that are not a link", "if a<b>c then", "if a<b>c then"},

		{"heading", "## Build failed", "Build failed"},
		{"hash without a space is not a heading", "#herdr channel", "#herdr channel"},

		{"escaped star", `\*literally starred\*`, "*literally starred*"},

		{
			name: "fence markers go, code stays",
			src:  "before\n```go\nfmt.Printf(\"%d *stars*\\n\", 2)\n```\nafter",
			want: "before\nfmt.Printf(\"%d *stars*\\n\", 2)\nafter",
		},
		{
			name: "unterminated fence",
			src:  "```sh\nrm -rf /tmp/x",
			want: "rm -rf /tmp/x",
		},
		{
			// Collapsing the code span removes the backtick that kept this line
			// from being a fence, so the leading run has to go with it.
			name: "stripping must not manufacture a fence marker",
			src:  " ````0`",
			want: " 0",
		},
		{
			name: "trailing whitespace is dropped",
			src:  "line one   \nline two\t",
			want: "line one\nline two",
		},
		{
			name: "blockquote marker is kept, its markup is not",
			src:  "> the agent said **yes**",
			want: "> the agent said yes",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ToPlainText(tc.src)
			if got != tc.want {
				t.Errorf("ToPlainText(%q)\n got %q\nwant %q", tc.src, got, tc.want)
			}
		})
	}
}

// ToPlainText is the format_error fallback. A fallback that itself opens a code
// block nothing closes reproduces, on the retry, the garbled render it was sent
// to repair.
func TestToPlainTextNeverEmitsAFenceLine(t *testing.T) {
	for _, src := range []string{
		" ````0`",                 // the span that disqualified the line gets collapsed away
		"`````\n```\ncode\n`````", // a shorter marker nested in a longer fence is content, not a delimiter
		"``` `x` ```",
		"prose\n``` `y`\nmore prose",
		"  ```` `a` ```` b",
	} {
		got := ToPlainText(src)
		for _, line := range strings.Split(got, "\n") {
			if _, _, ok := fenceLine([]rune(line)); ok {
				t.Errorf("ToPlainText(%q) produced the fence line %q (full output %q)", src, line, got)
			}
		}
	}
}

func TestToPlainTextLeavesNoFences(t *testing.T) {
	src := "here:\n```json\n{\"a\": 1}\n```\nand:\n```\nplain\n```\n"
	got := ToPlainText(src)
	if strings.Contains(got, "```") {
		t.Errorf("fence markers survived: %q", got)
	}
	for _, want := range []string{`{"a": 1}`, "plain"} {
		if !strings.Contains(got, want) {
			t.Errorf("code content %q was dropped from %q", want, got)
		}
	}
}
