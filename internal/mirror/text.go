package mirror

import (
	"strings"
	"unicode"
)

// maxToolArgRunes bounds the argument inside a collapsed tool summary.
//
// The summary exists so a phone can see WHAT the agent is doing without being
// handed the payload; a 4 KB heredoc or a base64 blob in `Bash(...)` would
// defeat that. 72 runes is about one wrapped line on a phone.
const maxToolArgRunes = 72

// sanitizeText makes transcript text safe to put in a chat message: no ANSI
// escapes, no box drawing, no stray control bytes, no \r.
//
// Transcript JSON is usually already plain, but not reliably: a tool_result
// carries whatever the command printed, agents echo coloured diffs, and Claude
// occasionally stores a rendered box. S2 §4.9 makes "no ANSI/box characters on
// the phone" an acceptance criterion, so the mirror strips rather than hopes.
func sanitizeText(s string) string {
	if s == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s))

	r := []rune(s)
	for i := 0; i < len(r); {
		switch c := r[i]; {
		case c == 0x1b:
			i = skipEscape(r, i)
		case c == '\r':
			// Lone CR becomes a newline; CRLF collapses to one newline.
			if i+1 < len(r) && r[i+1] == '\n' {
				i++
				continue
			}
			b.WriteByte('\n')
			i++
		case c == '\n' || c == '\t':
			b.WriteRune(c)
			i++
		case isBoxDrawing(c):
			i++
		case unicode.IsControl(c):
			i++
		default:
			b.WriteRune(c)
			i++
		}
	}
	return trimLines(b.String())
}

// skipEscape returns the index just past the escape sequence starting at i.
//
// It covers the three shapes that actually reach a transcript: CSI (colour,
// cursor movement), OSC (terminal title — how Codex signals "Action Required",
// G11) and the DCS/SOS/PM/APC string family. Anything else is treated as a
// two-byte escape, which is the common case for the rest of them.
func skipEscape(r []rune, i int) int {
	i++ // consume ESC
	if i >= len(r) {
		return i
	}
	switch r[i] {
	case '[': // CSI: parameters, then a final byte in @..~
		i++
		for i < len(r) && (r[i] < 0x40 || r[i] > 0x7e) {
			i++
		}
		if i < len(r) {
			i++
		}
		return i
	case ']', 'P', 'X', '^', '_': // string sequences, terminated by BEL or ST
		i++
		for i < len(r) {
			if r[i] == 0x07 {
				return i + 1
			}
			if r[i] == 0x1b && i+1 < len(r) && r[i+1] == '\\' {
				return i + 2
			}
			i++
		}
		return i
	case '(', ')', '*', '+', '#', '%': // charset designation: ESC ( B
		return i + 2
	default:
		return i + 1
	}
}

// isBoxDrawing reports whether c is a Box Drawing (U+2500..U+257F) or Block
// Element (U+2580..U+259F) rune — the two blocks TUIs use to draw frames.
// Geometric shapes are deliberately left alone: agents write "•" and "▶" in
// ordinary prose.
func isBoxDrawing(c rune) bool {
	return c >= 0x2500 && c <= 0x259f
}

// trimLines drops trailing whitespace from every line and blank space from the
// whole block. Leading whitespace survives, because it is code indentation.
func trimLines(s string) string {
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// collapseSpace folds every run of whitespace into a single space. Tool
// summaries are one-liners: a multi-line shell command has to survive as one
// line or the "one line per tool call" promise is broken.
func collapseSpace(s string) string {
	return strings.Join(strings.FieldsFunc(s, unicode.IsSpace), " ")
}

// truncateRunes cuts s to at most n runes, marking the cut with an ellipsis.
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// toolSummary renders one tool call as `Name(arg)` — `Bash(touch x.txt)`.
//
// The argument is the one that identifies the call to a human; everything else
// in the payload is dropped. A call whose payload has no such argument renders
// as the bare name rather than as empty parentheses.
func toolSummary(name, arg string) string {
	name = collapseSpace(sanitizeText(name))
	if name == "" {
		name = "tool"
	}
	arg = truncateRunes(collapseSpace(sanitizeText(arg)), maxToolArgRunes)
	if arg == "" {
		return name
	}
	return name + "(" + arg + ")"
}

// toolArgKeys is the search order for the identifying argument of a tool call,
// most specific first. `command` before `description` because the command IS
// the thing a human is being asked to judge; `file_path` before `content`
// because a Write's payload is the whole file; `pattern` before `path` because
// a search is identified by what it looks for, not by where.
var toolArgKeys = []string{
	"command", "cmd", "file_path", "notebook_path",
	"pattern", "path", "query", "url", "prompt", "description",
}

// pickToolArg finds the identifying argument in a decoded tool input object.
func pickToolArg(input map[string]any) string {
	for _, key := range toolArgKeys {
		if s, ok := stringish(input[key]); ok {
			return s
		}
	}
	// A single-field payload is unambiguous whatever the field is called.
	if len(input) == 1 {
		for _, v := range input {
			if s, ok := stringish(v); ok {
				return s
			}
		}
	}
	return ""
}

// stringish accepts a string, or a list of strings such as Codex's
// ["/bin/zsh","-lc","ls -la"] argv form.
func stringish(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		if t == "" {
			return "", false
		}
		return t, true
	case []any:
		parts := make([]string, 0, len(t))
		for _, e := range t {
			s, ok := e.(string)
			if !ok {
				return "", false
			}
			parts = append(parts, s)
		}
		if len(parts) == 0 {
			return "", false
		}
		return strings.Join(parts, " "), true
	default:
		return "", false
	}
}
