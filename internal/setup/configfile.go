package setup

import (
	_ "embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/config"
)

// exampleConfig is deploy/config.example.toml, embedded byte for byte.
//
// It is a copy because go:embed cannot reach outside the package directory and
// a released binary has no repository next to it — setup has to be able to
// create a config.toml on a machine that only ever downloaded an executable.
// TestEmbeddedExampleMatchesDeploy fails the build if the two drift, so this is
// a copy that cannot rot rather than a second source of truth.
//
//go:embed config.example.toml
var exampleConfig []byte

// feishuSection is the TOML table both keys setup writes live in.
const feishuSection = "feishu"

const (
	keyAllowedOpenIDs = "allowed_open_ids"
	keyNotifyChatID   = "notify_chat_id"
)

// configPath is <stateDir>/config.toml.
func configPath(stateDir string) string {
	return joinPath(stateDir, config.ConfigFileName)
}

// updateConfig creates <stateDir>/config.toml from the shipped example if it
// is absent, then replaces the two lines setup owns — in place, one line each.
//
// It is a LINE EDIT and not a decode/encode round trip on purpose. The example
// is about a hundred lines of comments that ARE the documentation for this
// product's security model, and BurntSushi/toml has no comment-preserving
// encoder: marshalling the struct back out would silently delete every one of
// them and leave the operator with a file that no longer explains what
// allowed_open_ids costs them if they get it wrong.
//
// An empty openID or chatID means "leave that key alone". untouched names the
// keys that were deliberately not edited because doing so safely was not
// possible; the caller turns those into a manual step.
func updateConfig(path, openID, chatID string) (untouched []string, err error) {
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		// The example already carries every default plus the comments that
		// explain them, so a fresh file starts as documentation rather than as
		// three keys with no context.
		data = exampleConfig
	case err != nil:
		return nil, fmt.Errorf("setup: read %s: %w", path, err)
	}

	lines := splitLines(string(data))

	if openID != "" {
		next, ok := addAllowedOpenID(lines, openID)
		if !ok {
			untouched = append(untouched, keyAllowedOpenIDs)
		} else {
			lines = next
		}
	}
	if chatID != "" {
		lines = setStringValue(lines, keyNotifyChatID, chatID)
	}

	if err := writeFileAtomic(path, joinLines(lines), 0o600); err != nil {
		return untouched, err
	}
	return untouched, nil
}

// addAllowedOpenID adds id to feishu.allowed_open_ids, keeping any entries that
// are already there.
//
// ok is false when the array could not be edited safely — an array spread over
// several lines is the case that matters — in which case lines is unchanged.
// Refusing beats guessing: this list is the authorization boundary of the whole
// product (G10), and a bad edit either locks the operator out of their own
// bridge or hands it to somebody else.
func addAllowedOpenID(lines []string, id string) ([]string, bool) {
	i := findKeyLine(lines, feishuSection, keyAllowedOpenIDs)
	if i < 0 {
		return insertKeyLine(lines, fmt.Sprintf("%s = [%q]", keyAllowedOpenIDs, id)), true
	}

	indent, rhs, ok := splitAssignment(lines[i])
	if !ok {
		return lines, false
	}
	items, tail, ok := parseInlineArray(rhs)
	if !ok {
		return lines, false
	}
	for _, item := range items {
		if item == id {
			// Already listed. Leaving the line untouched preserves whatever
			// formatting and neighbours the operator chose.
			return lines, true
		}
	}
	items = append(items, id)

	quoted := make([]string, 0, len(items))
	for _, item := range items {
		quoted = append(quoted, fmt.Sprintf("%q", item))
	}
	out := make([]string, len(lines))
	copy(out, lines)
	out[i] = fmt.Sprintf("%s%s = [%s]%s", indent, keyAllowedOpenIDs, strings.Join(quoted, ", "), tail)
	return out, true
}

// setStringValue replaces the value of a string key, preserving its indent and
// any comment after it.
func setStringValue(lines []string, key, value string) []string {
	i := findKeyLine(lines, feishuSection, key)
	if i < 0 {
		return insertKeyLine(lines, fmt.Sprintf("%s = %q", key, value))
	}
	indent, rhs, ok := splitAssignment(lines[i])
	if !ok {
		return lines
	}
	out := make([]string, len(lines))
	copy(out, lines)
	out[i] = fmt.Sprintf("%s%s = %q%s", indent, key, value, stringTail(rhs))
	return out
}

// insertKeyLine puts line directly under the [feishu] header, creating the
// table if the operator deleted it.
//
// Appending at the end of the file would be wrong: the last table in the
// example is [mirror], so an appended feishu key would land inside it and be
// rejected as an unknown key at startup (config.rejectUnknownKeys).
func insertKeyLine(lines []string, line string) []string {
	header := findSectionHeader(lines, feishuSection)
	if header < 0 {
		out := append([]string{}, lines...)
		if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
			out = append(out, "")
		}
		return append(out, "["+feishuSection+"]", line)
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, lines[:header+1]...)
	out = append(out, line)
	return append(out, lines[header+1:]...)
}

// findSectionHeader returns the index of the [section] line, or -1.
func findSectionHeader(lines []string, section string) int {
	for i, line := range lines {
		if name, ok := sectionName(line); ok && name == section {
			return i
		}
	}
	return -1
}

// findKeyLine returns the index of the line assigning key inside section, or
// -1. Comments are skipped, which is what keeps the example's commented-out
// `#   allowed_open_ids = [...]` illustration from being mistaken for the
// live assignment two lines below it.
func findKeyLine(lines []string, section, key string) int {
	current := ""
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if name, ok := sectionName(trimmed); ok {
			current = name
			continue
		}
		if current != section {
			continue
		}
		if k, _, found := strings.Cut(trimmed, "="); found && strings.TrimSpace(k) == key {
			return i
		}
	}
	return -1
}

// sectionName reports the table a `[name]` line opens.
func sectionName(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "[") || !strings.HasSuffix(trimmed, "]") {
		return "", false
	}
	// `[[array]]` is not a table this file ever uses, and treating it as one
	// would misattribute the keys under it.
	if strings.HasPrefix(trimmed, "[[") {
		return "", false
	}
	return strings.TrimSpace(trimmed[1 : len(trimmed)-1]), true
}

// splitAssignment separates a `  key = value` line into its indent and its
// right-hand side.
func splitAssignment(line string) (indent, rhs string, ok bool) {
	_, rhs, ok = strings.Cut(line, "=")
	if !ok {
		return "", "", false
	}
	indent = line[:len(line)-len(strings.TrimLeft(line, " \t"))]
	return indent, rhs, true
}

// parseInlineArray reads the quoted items of a single-line TOML array and
// returns whatever followed the closing bracket, so an inline comment survives
// the rewrite.
//
// The array ends at the FIRST ']' outside a quoted run, never the last one on
// the line. Taking the last would swallow an inline comment that contains a
// bracket — and the shipped example teaches exactly that shape two lines above
// this key (`#   allowed_open_ids = ["ou_REPLACE_WITH_YOUR_OWN_OPEN_ID"]`), so
// `allowed_open_ids = []  # e.g. [...]` would delete the comment AND promote
// the id inside it into the live authorization boundary (G10). Refusing beats
// guessing here: an unterminated quote returns ok=false and the caller prints a
// manual step instead.
//
// ok is also false for an array that does not open and close on this line. Open
// ids contain no quotes or escapes, so scanning for quoted runs is enough;
// anything stranger than that is refused rather than reformatted.
func parseInlineArray(rhs string) (items []string, tail string, ok bool) {
	open := strings.Index(rhs, "[")
	if open < 0 {
		return nil, "", false
	}

	for i := open + 1; i < len(rhs); {
		switch c := rhs[i]; c {
		case ']':
			return items, rhs[i+1:], true
		case '"', '\'':
			end := strings.IndexByte(rhs[i+1:], c)
			if end < 0 {
				return nil, "", false
			}
			items = append(items, rhs[i+1:i+1+end])
			i += end + 2
		default:
			i++
		}
	}
	return nil, "", false
}

// stringTail returns whatever follows a quoted value, typically a comment.
func stringTail(rhs string) string {
	start := strings.IndexAny(rhs, `"'`)
	if start < 0 {
		return ""
	}
	quote := rhs[start]
	end := strings.IndexByte(rhs[start+1:], quote)
	if end < 0 {
		return ""
	}
	return rhs[start+1+end+1:]
}
