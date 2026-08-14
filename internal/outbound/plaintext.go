package outbound

import "strings"

// ToPlainText strips markdown markup and keeps the content.
//
// It is the fallback path after a format_error: whatever Feishu refused to
// render, this produces something it will accept. Code fence CONTENT survives
// — in this product the fenced text is usually the command the user is being
// asked to approve, so dropping it would be worse than dropping the markup.
func ToPlainText(s string) string {
	lines := strings.Split(s, "\n")
	out := make([]string, 0, len(lines))

	inFence := false
	openLen := 0
	for _, line := range lines {
		if marker, info, ok := fenceLine([]rune(line)); ok {
			if !inFence {
				inFence, openLen = true, len(marker)
				continue // drop the opening marker and its language tag
			}
			if len(marker) >= openLen && info == "" {
				inFence, openLen = false, 0
				continue // drop the closing marker
			}
		}
		if inFence {
			// Verbatim: `*` and `_` inside code are code, not emphasis.
			out = append(out, deFence(strings.TrimRight(line, " \t")))
			continue
		}
		out = append(out, deFence(strings.TrimRight(plainLine(line), " \t")))
	}
	return strings.Join(out, "\n")
}

// deFence strips the leading backtick run from a line that came out of the
// stripper looking like a fence marker.
//
// Two ways to get there: collapsing a code span can remove the very backtick
// that disqualified the line as a fence (" ````0`" -> " ```0"), and a shorter
// marker nested inside a longer fence is content, not a delimiter, so it is
// emitted verbatim. ToPlainText is the format_error fallback; a fallback that
// itself opens a code block nothing closes is worse than one that loses three
// backticks.
func deFence(line string) string {
	if _, _, ok := fenceLine([]rune(line)); !ok {
		return line
	}
	r := []rune(line)
	i := 0
	for i < len(r) && r[i] == ' ' {
		i++
	}
	j := i
	for j < len(r) && r[j] == '`' {
		j++
	}
	return string(r[:i]) + string(r[j:])
}

// plainLine strips block markers from one non-code line, then its inline
// markup.
func plainLine(line string) string {
	trimmed := strings.TrimLeft(line, " \t")
	indent := line[:len(line)-len(trimmed)]

	// ATX heading: "## Title" -> "Title". A bare "#" run with no text is left
	// alone; it is more likely a comment than a heading.
	if h := strings.TrimLeft(trimmed, "#"); h != trimmed {
		if rest := strings.TrimLeft(h, " \t"); rest != h && rest != "" {
			trimmed = rest
		}
	}
	return indent + plainInline([]rune(trimmed))
}

// plainInline rewrites emphasis, inline code and links. It is a scanner rather
// than a set of regexps so that a delimiter without a partner survives as
// itself: "2 * 3 * 4" must not lose its asterisks.
func plainInline(r []rune) string {
	var b strings.Builder
	for i := 0; i < len(r); {
		switch c := r[i]; {
		case c == '\\' && i+1 < len(r) && isMarkdownPunct(r[i+1]):
			b.WriteRune(r[i+1])
			i += 2

		case c == '`':
			n := runLength(r, i, '`')
			if j := findRun(r, i+n, '`', n); j >= 0 {
				// Code span content is emitted verbatim; it is not markdown.
				b.WriteString(strings.TrimSpace(string(r[i+n : j])))
				i = j + n
				continue
			}
			b.WriteRune(c)
			i++

		case c == '*' || c == '_' || c == '~':
			n := runLength(r, i, c)
			if j, ok := emphasisClose(r, i, n, c); ok {
				b.WriteString(plainInline(r[i+n : j]))
				i = j + n
				continue
			}
			for k := 0; k < n; k++ {
				b.WriteRune(c)
			}
			i += n

		case c == '[' || (c == '!' && i+1 < len(r) && r[i+1] == '['):
			if text, target, end, ok := parseLink(r, i); ok {
				b.WriteString(renderLink(text, target))
				i = end
				continue
			}
			b.WriteRune(c)
			i++

		case c == '<':
			if j := indexFrom(r, i+1, '>'); j >= 0 && isAutolink(string(r[i+1:j])) {
				b.WriteString(string(r[i+1 : j]))
				i = j + 1
				continue
			}
			b.WriteRune(c)
			i++

		default:
			b.WriteRune(c)
			i++
		}
	}
	return b.String()
}

// emphasisClose finds the closing delimiter run for an opener of n copies of c
// starting at i, applying the flanking rules that keep snake_case identifiers
// and bare arithmetic intact.
func emphasisClose(r []rune, i, n int, c rune) (int, bool) {
	if n > 3 || i+n >= len(r) {
		return 0, false
	}
	if isSpaceRune(r[i+n]) {
		return 0, false // "* item" is a list bullet, not emphasis
	}
	if c == '_' && i > 0 && isWordRune(r[i-1]) {
		return 0, false // foo_bar_baz
	}
	if c == '~' && n < 2 {
		return 0, false // single ~ is not strikethrough
	}
	for j := i + n; j+n <= len(r); j++ {
		if r[j] != c {
			continue
		}
		if runLength(r, j, c) != n {
			continue
		}
		if isSpaceRune(r[j-1]) {
			continue // closing delimiter may not be preceded by a space
		}
		if c == '_' && j+n < len(r) && isWordRune(r[j+n]) {
			continue
		}
		return j, true
	}
	return 0, false
}

// parseLink handles [text](target) and ![alt](target), returning the index one
// past the closing paren.
func parseLink(r []rune, i int) (text, target string, end int, ok bool) {
	start := i
	if r[i] == '!' {
		i++
	}
	if i >= len(r) || r[i] != '[' {
		return "", "", start, false
	}
	bracket := matchBracket(r, i, '[', ']')
	if bracket < 0 || bracket+1 >= len(r) || r[bracket+1] != '(' {
		return "", "", start, false
	}
	paren := matchBracket(r, bracket+1, '(', ')')
	if paren < 0 {
		return "", "", start, false
	}
	text = plainInline(r[i+1 : bracket])
	target = strings.TrimSpace(string(r[bracket+2 : paren]))
	// "(url \"title\")": keep the url, drop the title.
	if sp := strings.IndexAny(target, " \t"); sp >= 0 {
		target = target[:sp]
	}
	return text, target, paren + 1, true
}

func renderLink(text, target string) string {
	switch {
	case target == "" || target == text:
		return text
	case text == "":
		return target
	default:
		return text + " (" + target + ")"
	}
}

// matchBracket returns the index of the delimiter closing the one at i,
// honouring nesting and backslash escapes.
func matchBracket(r []rune, i int, opening, closing rune) int {
	depth := 0
	for j := i; j < len(r); j++ {
		switch r[j] {
		case '\\':
			j++
		case opening:
			depth++
		case closing:
			if depth--; depth == 0 {
				return j
			}
		}
	}
	return -1
}

func isAutolink(s string) bool {
	for _, scheme := range []string{"http://", "https://", "mailto:", "ftp://"} {
		if strings.HasPrefix(s, scheme) {
			return true
		}
	}
	return false
}

func runLength(r []rune, i int, c rune) int {
	n := 0
	for i+n < len(r) && r[i+n] == c {
		n++
	}
	return n
}

// findRun returns the index of the next run of exactly n copies of c at or
// after i.
func findRun(r []rune, i int, c rune, n int) int {
	for j := i; j+n <= len(r); j++ {
		if r[j] == c && runLength(r, j, c) == n {
			return j
		}
	}
	return -1
}

func indexFrom(r []rune, i int, c rune) int {
	for j := i; j < len(r); j++ {
		if r[j] == c {
			return j
		}
	}
	return -1
}

func isSpaceRune(c rune) bool { return c == ' ' || c == '\t' }

func isWordRune(c rune) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func isMarkdownPunct(c rune) bool {
	return strings.ContainsRune("\\`*_{}[]()#+-.!|~<>", c)
}
