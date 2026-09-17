package agents

import "github.com/hewenyu/herdr-agent/internal/codexui"

// codexTrustConfirmKeys recognizes Codex's directory trust screen, including
// its currently highlighted choice. In Codex 0.154, key 1 leaves this menu
// waiting for Enter, while key 2 exits immediately. Never append Enter to
// arbitrary numeric keys: it could reach the shell after a declined prompt.
func codexTrustConfirmKeys(raw string) []string {
	prompt, ok := codexui.ParseTrustScreen(raw)
	if !ok {
		return nil
	}
	return prompt.ConfirmKeys
}
