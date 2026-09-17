// Package codexui recognizes the actionable startup dialogs shown by Codex.
package codexui

import (
	"strings"
	"unicode"
)

// TrustScreen describes a complete, currently visible directory trust prompt.
// ConfirmKeys selects Yes and submits it; callers must obtain the user's
// approval and recheck their state guard before sending these keys.
type TrustScreen struct {
	Directory   string
	ConfirmKeys []string
}

// ParseTrustScreen accepts the native directory trust dialog, with or without
// Codex's initial ASCII logo and welcome banner. It refuses arbitrary prose
// preceding a printed example, incomplete menus, and a later composer prompt.
func ParseTrustScreen(raw string) (TrustScreen, bool) {
	var lines []string
	for _, line := range strings.Split(raw, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) < 5 || lines[len(lines)-1] != "Press enter to continue" {
		return TrustScreen{}, false
	}
	const location = "> You are in "
	start := 0
	for start < len(lines) && !strings.HasPrefix(lines[start], location) {
		start++
	}
	if start == len(lines) || start > len(lines)-5 {
		return TrustScreen{}, false
	}
	if start > 0 {
		if lines[start-1] != "Welcome to Codex, OpenAI's command-line coding agent" {
			return TrustScreen{}, false
		}
		for _, line := range lines[:start-1] {
			// The native ASCII logo contains punctuation, not prose or numbers.
			if strings.ContainsFunc(line, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }) {
				return TrustScreen{}, false
			}
		}
	}
	// A narrow pane wraps long directory paths onto continuation lines before
	// the question. Locate the question independently before joining the path.
	questionStart := start + 1
	for questionStart < len(lines)-3 {
		question := strings.Join(strings.Fields(strings.Join(lines[questionStart:len(lines)-3], "\n")), "")
		if strings.HasPrefix(question, "Doyoutrustthecontentsofthisdirectory?") {
			break
		}
		questionStart++
	}
	if questionStart == len(lines)-3 {
		return TrustScreen{}, false
	}
	directory := strings.TrimSpace(strings.TrimPrefix(lines[start], location)) + strings.Join(lines[start+1:questionStart], "")
	if directory == "" {
		return TrustScreen{}, false
	}
	yes, no := lines[len(lines)-3], lines[len(lines)-2]
	switch {
	case yes == "› 1. Yes, continue" && no == "2. No, quit":
		return TrustScreen{Directory: directory, ConfirmKeys: []string{"enter"}}, true
	case yes == "1. Yes, continue" && no == "› 2. No, quit":
		return TrustScreen{Directory: directory, ConfirmKeys: []string{"up", "enter"}}, true
	default:
		return TrustScreen{}, false
	}
}
