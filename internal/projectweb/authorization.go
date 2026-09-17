package projectweb

import (
	"net/http"
	"net/url"
	"strings"
	"time"
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
	if !safeAuthorizationURL(status.URL) || !status.ExpiresAt.IsZero() && !time.Now().Before(status.ExpiresAt) {
		status.URL = ""
	}
	writeJSON(w, http.StatusOK, status)
}

func safeAuthorizationURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.Port() != "" && u.Port() != "443" {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "accounts.feishu.cn", "open.feishu.cn", "passport.feishu.cn",
		"accounts.larksuite.com", "open.larksuite.com", "passport.larksuite.com":
		return true
	default:
		return false
	}
}
