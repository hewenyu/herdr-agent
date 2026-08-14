package outbound

import "testing"

func TestHasMarkdownTable(t *testing.T) {
	tests := []struct {
		name string
		src  string
		want bool
	}{
		{
			name: "canonical GFM table",
			src:  "| name | status |\n|------|--------|\n| w1p1 | idle   |",
			want: true,
		},
		{
			name: "no outer pipes",
			src:  "name | status\n--- | ---",
			want: true,
		},
		{
			name: "alignment colons",
			src:  "| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |",
			want: true,
		},
		{
			name: "single column",
			src:  "| pane |\n|-|\n| w1:p1 |",
			want: true,
		},
		{
			name: "padded delimiter row",
			src:  "  | a | b |  \n  |  ---  |  ---  |  ",
			want: true,
		},
		{
			name: "table after prose",
			src:  "The agent asked:\n\n| key | label |\n|---|---|\n| 1 | Yes |\n",
			want: true,
		},
		{
			name: "table inside a code fence still counts",
			src:  "```\n| a | b |\n|---|---|\n```",
			want: true,
		},
		{
			name: "empty",
			src:  "",
			want: false,
		},
		{
			name: "prose only",
			src:  "no pipes at all\njust two lines",
			want: false,
		},
		{
			name: "pipes but no delimiter row",
			src:  "run `a | b` in the shell\nand then wait",
			want: false,
		},
		{
			name: "horizontal rule under prose",
			src:  "a heading of sorts\n------------------",
			want: false,
		},
		{
			name: "setext heading",
			src:  "Title\n=====",
			want: false,
		},
		{
			name: "delimiter row with no header above it",
			src:  "|---|---|\n| 1 | 2 |",
			want: false,
		},
		{
			name: "two data rows, no delimiter",
			src:  "| a | b |\n| c | d |",
			want: false,
		},
		{
			name: "bullet list with pipes and dashes",
			src:  "- item | other\n- another | thing",
			want: false,
		},
		{
			name: "delimiter row without pipes",
			src:  "a | b\n-----",
			want: false,
		},
		{
			name: "shell pipeline over two lines",
			src:  "cat x | grep y \\\n  | wc -l",
			want: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := HasMarkdownTable(tc.src); got != tc.want {
				t.Errorf("HasMarkdownTable(%q) = %v, want %v", tc.src, got, tc.want)
			}
		})
	}
}

// A downgraded table must still be readable: ToPlainText leaves the pipes
// alone, because the rows are the content.
func TestTableDowngradeKeepsRows(t *testing.T) {
	src := "| pane | status |\n|---|---|\n| w1:p1 | blocked |"
	if got := ToPlainText(src); got != src {
		t.Errorf("ToPlainText mangled a table:\n got %q\nwant %q", got, src)
	}
}
