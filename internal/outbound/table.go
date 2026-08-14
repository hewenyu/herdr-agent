package outbound

import "strings"

// HasMarkdownTable reports whether s contains a GitHub-style table.
//
// Detection is deliberately unconditional: a table inside a code fence counts
// too. The asymmetry justifies it — a false positive costs formatting (the
// caller sends plain text), a false negative costs the entire message (the
// Feishu post renderer emits a blank bubble and the user never learns the
// agent said anything).
func HasMarkdownTable(s string) bool {
	lines := strings.Split(s, "\n")
	for i := 0; i+1 < len(lines); i++ {
		if isTableHeader(lines[i]) && isTableDelimiter(lines[i+1]) {
			return true
		}
	}
	return false
}

// isTableHeader reports whether the line could be a table's header row: it has
// at least one pipe and at least one cell with real content. The content check
// is what stops a delimiter row from being read as the header of a second,
// imaginary table.
func isTableHeader(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.Contains(t, "|") {
		return false
	}
	return strings.Trim(t, "|-: \t") != ""
}

// isTableDelimiter matches rows like "|---|---|", "| :--- | ---: |", "|-|".
func isTableDelimiter(line string) bool {
	t := strings.TrimSpace(line)
	if !strings.Contains(t, "|") || !strings.Contains(t, "-") {
		return false
	}
	// Cell count is not compared against the header row. GFM requires a match,
	// but we do not know that Feishu's renderer is equally strict, and being
	// wrong in that direction loses the whole message.
	for _, cell := range strings.Split(strings.Trim(t, "|"), "|") {
		if !isDelimiterCell(strings.TrimSpace(cell)) {
			return false
		}
	}
	return true
}

func isDelimiterCell(c string) bool {
	c = strings.TrimPrefix(c, ":")
	c = strings.TrimSuffix(c, ":")
	return c != "" && strings.Trim(c, "-") == ""
}
