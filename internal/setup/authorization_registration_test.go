package setup

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

type registrationTransport func(*http.Request) (*http.Response, error)

func (f registrationTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Exercise the actual SDK's begin -> URL callback -> poll path. Its current
// begin response uses open.feishu.cn/page/launcher, not the accounts host that
// serves the registration API. A fake RegisterApp returning an accounts URL
// would miss the production failure before any link reaches the user.
func TestRefreshAuthorizationAcceptsSDKLauncherLinks(t *testing.T) {
	for _, launcher := range []string{
		"https://open.feishu.cn/page/launcher?user_code=example",
		"https://open.larksuite.com/page/launcher?user_code=example",
		"https://accounts.feishu.cn/confirm?user_code=example",
		"https://OPEN.FEISHU.CN:443/page/launcher?user_code=example",
	} {
		t.Run(launcher, func(t *testing.T) {
			dir := t.TempDir()
			cfg := authorizationConfig()
			cfg.Tasks.Enabled = true
			previousClient := http.DefaultClient
			t.Cleanup(func() { http.DefaultClient = previousClient })
			callbacks, begins, polls := 0, 0, 0
			http.DefaultClient = &http.Client{Transport: registrationTransport(func(r *http.Request) (*http.Response, error) {
				if err := r.Context().Err(); err != nil {
					return nil, err
				}
				if r.Method != http.MethodPost || r.URL.Host != "accounts.feishu.cn" || r.URL.Path != "/oauth/v1/app/registration" {
					t.Fatalf("unexpected registration request: %s %s", r.Method, r.URL.Path)
				}
				if err := r.ParseForm(); err != nil {
					t.Fatal(err)
				}
				switch r.Form.Get("action") {
				case "begin":
					begins++
					body, _ := json.Marshal(map[string]any{
						"device_code": "example-device", "verification_uri_complete": launcher,
						"expire_in": 123, "interval": 5,
					})
					return authorizationResponse(string(body)), nil
				case "poll":
					polls++
					if callbacks != 1 || r.Form.Get("device_code") != "example-device" {
						t.Fatal("poll must follow the user-visible launcher link")
					}
					body, _ := json.Marshal(map[string]string{"client_id": cfg.Feishu.AppID, "client_secret": otherSecret})
					return authorizationResponse(string(body)), nil
				default:
					t.Fatal("unexpected registration action")
					return nil, nil
				}
			})}
			stubRegister(t, registration.RegisterApp)
			updated, err := RefreshAuthorization(context.Background(), dir, cfg, func(raw string, expires time.Time) {
				callbacks++
				u, err := url.Parse(raw)
				if err != nil || !strings.HasPrefix(raw, strings.Split(launcher, "?")[0]+"?") {
					t.Fatal("launcher URL was lost")
				}
				q := u.Query()
				if q.Get("clientID") != cfg.Feishu.AppID || q.Get("createOnly") != "" || q.Get("addons") == "" || q.Get("user_code") != "example" {
					t.Fatal("launcher must target the same app and retain its permission update and user code")
				}
				if remaining := time.Until(expires); remaining <= 0 || remaining > 123*time.Second {
					t.Fatal("launcher expiry was lost")
				}
			})
			if err != nil {
				t.Fatalf("SDK launcher must reach the user and continue authorization: %v", err)
			}
			stored, err := readCredentials(envPath(dir))
			if err != nil || stored.AppID != cfg.Feishu.AppID || stored.AppSecret != otherSecret || updated.Feishu.AppSecret != otherSecret {
				t.Fatal("authorization did not save credentials for the configured app")
			}
			if begins != 1 || callbacks != 1 || polls != 1 {
				t.Fatalf("begin=%d callback=%d poll=%d; want one complete attempt", begins, callbacks, polls)
			}
		})
	}
}
