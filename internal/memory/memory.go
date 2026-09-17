// Package memory stores conversation summaries independently of the model
// provider. Scope must come from authenticated application state, never from
// model arguments. A summary is historical context, not permission to act.
package memory

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"
)

// Scope isolates one owner's conversation and, when present, its bound task.
type Scope struct {
	OwnerID string `json:"owner_id"`
	ChatID  string `json:"chat_id"`
	TaskID  string `json:"task_id,omitempty"`
}

// Entry contains only a conversation summary. Revision is optional opaque
// provider metadata; the interface does not promise compare-and-swap semantics.
type Entry struct {
	Summary  string `json:"summary"`
	Revision string `json:"revision,omitempty"`
}

// Provider persists and recalls an exact scope. A missing summary is an empty
// Entry, and forgetting a missing scope succeeds. Operations are idempotent.
// Implementations must not put credentials or remote response bodies in errors.
type Provider interface {
	Recall(context.Context, Scope) (Entry, error)
	Store(context.Context, Scope, Entry) error
	Forget(context.Context, Scope) error
}

const (
	maxResponseBytes = 1 << 20
	maxSummaryBytes  = 256 << 10
	maxFieldBytes    = 4096
)

var (
	errConfiguration = errors.New("memory: invalid provider configuration")
	errScope         = errors.New("memory: invalid conversation scope")
	errEntry         = errors.New("memory: invalid summary entry")
	errRead          = errors.New("memory: could not read summary")
	errWrite         = errors.New("memory: could not store summary")
	errForget        = errors.New("memory: could not forget summary")
	errResponse      = errors.New("memory: invalid provider response")
	errRequest       = errors.New("memory: provider request failed")
)

func validScope(scope Scope) bool {
	if strings.TrimSpace(scope.OwnerID) == "" || strings.TrimSpace(scope.ChatID) == "" {
		return false
	}
	for _, field := range []string{scope.OwnerID, scope.ChatID, scope.TaskID} {
		if len(field) > maxFieldBytes || !utf8.ValidString(field) {
			return false
		}
	}
	return true
}

func validEntry(entry Entry) bool {
	return len(entry.Summary) <= maxSummaryBytes && len(entry.Revision) <= maxFieldBytes &&
		utf8.ValidString(entry.Summary) && utf8.ValidString(entry.Revision)
}
