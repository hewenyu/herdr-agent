// Package feishuurl validates official links shown during Feishu authorization.
package feishuurl

import (
	"net/url"
	"strings"
)

// ValidAuthorization permits the official HTTPS login and developer-console
// hosts. The registration API can return a launcher on open.feishu.cn even
// though the API request itself goes to accounts.feishu.cn. Startup and the
// local configuration page must agree on which links can reach the user.
func ValidAuthorization(raw string) bool {
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
