package projectweb

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAuthorizationStatusUpdatesWithoutRestartingPageServer(t *testing.T) {
	status := AuthorizationStatus{
		State: "checking", Message: "正在检查权限", CheckedAt: time.Now().UTC().Truncate(time.Second),
	}
	f := setup(t, WithAuthorizationStatus(func() AuthorizationStatus { return status }))
	read := func() AuthorizationStatus {
		t.Helper()
		response := f.request(t, "GET", "/api/feishu/authorization", "", nil)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("authorization response: %d %v", response.Code, response.Header())
		}
		var got AuthorizationStatus
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := read(); !reflect.DeepEqual(got, status) {
		t.Fatalf("checking status: %+v", got)
	}
	status.State, status.Message = "required", "登录飞书以补充权限"
	status.URL = "https://accounts.feishu.cn/oauth/v1/app/registration?code=temporary"
	status.ExpiresAt = time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	status.MissingScopes = []string{"task:task:write", "im:message"}
	if got := read(); !reflect.DeepEqual(got, status) {
		t.Fatalf("authorization link not available: %+v", got)
	}
	if got := f.request(t, "PUT", "/api/settings", `{"bypass":false}`, nil); got.Code != http.StatusOK {
		t.Fatalf("pending authorization prevented project configuration: %d", got.Code)
	}
	status = AuthorizationStatus{State: "ready", Message: "飞书权限检查通过", CheckedAt: time.Now().UTC().Truncate(time.Second)}
	if got := read(); !reflect.DeepEqual(got, status) {
		t.Fatalf("ready status retained stale login data: %+v", got)
	}
	if got := f.request(t, "GET", "/api/projects", "", nil); got.Code != http.StatusOK {
		t.Fatalf("authorization status interfered with projects: %d", got.Code)
	}
}

func TestAuthorizationStatusWithoutStartupCheckIsDisabled(t *testing.T) {
	f := setup(t)
	response := f.request(t, "GET", "/api/feishu/authorization", "", nil)
	var got map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || got["state"] != "disabled" || !strings.Contains(got["message"].(string), "serve") || got["url"] != "" {
		t.Fatalf("default status: %s", response.Body.String())
	}
	for _, key := range []string{"expires_at", "checked_at", "missing_scopes"} {
		if _, found := got[key]; found {
			t.Errorf("unset %s should be omitted: %s", key, response.Body.String())
		}
	}
}

func TestAuthorizationStatusOnlyPublishesValidUnexpiredOfficialLinks(t *testing.T) {
	status := AuthorizationStatus{State: "required"}
	f := setup(t, WithAuthorizationStatus(func() AuthorizationStatus { return status }))
	for _, test := range []struct {
		url     string
		expires time.Time
		want    bool
	}{
		{"https://accounts.feishu.cn/oauth/v1/app/registration?code=example", time.Now().Add(time.Minute), true},
		{"https://open.feishu.cn/app/cli_example/auth", time.Time{}, true},
		{"https://accounts.larksuite.com/oauth/v1/app/registration?code=example", time.Now().Add(time.Minute), true},
		{"https://accounts.feishu.cn/oauth/v1/app/registration?code=expired", time.Now().Add(-time.Second), false},
		{"http://accounts.feishu.cn/oauth/v1/app/registration", time.Time{}, false},
		{"javascript:alert(1)", time.Time{}, false},
		{"//accounts.feishu.cn/oauth/v1/app/registration", time.Time{}, false},
		{"https://accounts.feishu.cn.evil.example/login", time.Time{}, false},
		{"https://accounts.feishu.cn@evil.example/login", time.Time{}, false},
		{"https://evil.example@accounts.feishu.cn/login", time.Time{}, false},
		{"https://accounts.feishu.cn:8443/login", time.Time{}, false},
	} {
		t.Run(test.url, func(t *testing.T) {
			status.URL, status.ExpiresAt = test.url, test.expires
			response := f.request(t, "GET", "/api/feishu/authorization", "", nil)
			var got AuthorizationStatus
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if test.want && got.URL != test.url || !test.want && got.URL != "" {
				t.Fatalf("published authorization URL %q, permitted=%t", got.URL, test.want)
			}
			if status.URL != test.url {
				t.Fatal("read-only endpoint changed the source snapshot")
			}
		})
	}
}

func TestAuthorizationStatusUsesLocalSecurityGuard(t *testing.T) {
	f := setup(t, WithAuthorizationStatus(func() AuthorizationStatus {
		return AuthorizationStatus{State: "required", URL: "https://accounts.feishu.cn/login?code=local-only"}
	}))
	for _, modify := range []func(*http.Request){
		func(r *http.Request) { r.Host = "evil.example:18790" },
		func(r *http.Request) { r.RemoteAddr = "192.168.1.10:40000" },
		func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") },
		func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
	} {
		response := f.request(t, "GET", "/api/feishu/authorization", "", modify)
		if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "local-only") {
			t.Fatalf("untrusted request obtained authorization status: %d %s", response.Code, response.Body.String())
		}
	}
	response := f.request(t, "POST", "/api/feishu/authorization", "{}", nil)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("authorization endpoint must be read-only: %d", response.Code)
	}
}
