package herdrapi

import (
	"context"

	"github.com/hewenyu/herdr-agent/internal/codexui"
)

// Codex can be waiting for directory trust while herdr's version-specific
// detector still reports idle. Normalize that one native startup menu at the
// client boundary, so the registry, task manager and input guards agree. This
// only reads the viewport; it never answers or dismisses the trust question.
func (c *socketClient) codexStartupState(ctx context.Context, a AgentInfo) AgentInfo {
	if a.Agent == nil || *a.Agent != "codex" || a.PaneID == "" {
		return a
	}
	if a.AgentStatus == "working" || (a.AgentSession != nil && a.InteractiveReady && !a.LaunchPending) {
		return a
	}
	raw, truncated, err := c.AgentReadFull(ctx, a.PaneID, SourceVisible, 0)
	if err != nil || truncated {
		return a
	}
	if _, ok := codexui.ParseTrustScreen(raw); ok {
		a.AgentStatus = "blocked"
	}
	return a
}
