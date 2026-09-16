package agents

import "strings"

// codexTrustConfirmKeys recognizes Codex's directory trust screen, including
// its currently highlighted choice. In Codex 0.154, key 1 leaves this menu
// waiting for Enter, while key 2 exits immediately. Never append Enter to
// arbitrary numeric keys: it could reach the shell after a declined prompt.
func codexTrustConfirmKeys(raw string) []string {
	var lines []string
	for _, line := range strings.Split(raw, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) < 5 || !strings.HasPrefix(lines[0], "> You are in ") || lines[len(lines)-1] != "Press enter to continue" {
		return nil
	}
	yes, no := lines[len(lines)-3], lines[len(lines)-2]
	if !strings.Contains(normalizeEcho(strings.Join(lines[:len(lines)-3], "\n")), "Doyoutrustthecontentsofthisdirectory?") {
		return nil
	}
	switch {
	case yes == "› 1. Yes, continue" && no == "2. No, quit":
		return []string{"enter"}
	case yes == "1. Yes, continue" && no == "› 2. No, quit":
		return []string{"up", "enter"}
	default:
		return nil
	}
}
