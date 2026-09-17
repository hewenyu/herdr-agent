package projectweb

import (
	"net/http"
	"time"

	"github.com/hewenyu/herdr-agent/internal/feishuurl"
)

// AuthorizationStatus is the current startup permission check, without app
// credentials or authorization tokens. A URL is a temporary user login link.
type AuthorizationStatus struct {
	State         string    `json:"state"`
	Message       string    `json:"message"`
	URL           string    `json:"url"`
	ExpiresAt     time.Time `json:"expires_at,omitempty,omitzero"`
	CheckedAt     time.Time `json:"checked_at,omitempty,omitzero"`
	MissingScopes []string  `json:"missing_scopes,omitempty"`
}

// Option configures the local configuration server.
type Option func(*server)

// WithAuthorizationStatus exposes a live, read-only snapshot. The callback must
// be safe for concurrent requests and must not start a login flow on reads.
func WithAuthorizationStatus(snapshot func() AuthorizationStatus) Option {
	return func(s *server) { s.authorizationStatus = snapshot }
}

func (s *server) authorization(w http.ResponseWriter, _ *http.Request) {
	status := AuthorizationStatus{State: "disabled", Message: "请启动 herdr-agent serve 检查飞书权限。"}
	if s.authorizationStatus != nil {
		status = s.authorizationStatus()
	}
	if !feishuurl.ValidAuthorization(status.URL) || !status.ExpiresAt.IsZero() && !time.Now().Before(status.ExpiresAt) {
		status.URL = ""
	}
	writeJSON(w, http.StatusOK, status)
}
