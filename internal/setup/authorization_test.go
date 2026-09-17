package setup

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

type authorizationHTTPFunc func(*http.Request) (*http.Response, error)

func (f authorizationHTTPFunc) Do(r *http.Request) (*http.Response, error) { return f(r) }

func authorizationConfig() config.Config {
	cfg := config.Default()
	cfg.Feishu.AppID = testAppID
	cfg.Feishu.AppSecret = testSecret
	cfg.Feishu.AllowedOpenIDs = []string{"ou_existing_owner"}
	return cfg
}

func stubAuthorizationHTTP(t *testing.T, f authorizationHTTPFunc) {
	t.Helper()
	previous := authorizationHTTP
	authorizationHTTP = f
	t.Cleanup(func() { authorizationHTTP = previous })
}

func authorizationResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestCheckAuthorizationUsesTenantGrantsForEnabledFeatures(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "base", true: "task_sessions"}[enabled], func(t *testing.T) {
			cfg := authorizationConfig()
			cfg.Tasks.Enabled = enabled
			calls := 0
			stubAuthorizationHTTP(t, func(r *http.Request) (*http.Response, error) {
				calls++
				switch r.URL.Path {
				case "/open-apis/auth/v3/tenant_access_token/internal":
					var body map[string]string
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["app_id"] != cfg.Feishu.AppID || body["app_secret"] != cfg.Feishu.AppSecret {
						t.Fatal("credential check did not use the current configuration")
					}
					return authorizationResponse(`{"code":0,"tenant_access_token":"fresh_token","expire":7200}`), nil
				case "/open-apis/application/v6/scopes":
					if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer fresh_token" {
						t.Fatal("scope check must read using the freshly acquired token")
					}
					// A user grant, a pending grant, and a missing scope must not
					// satisfy tenant permissions. Unknown extra grants are harmless.
					return authorizationResponse(`{"code":0,"data":{"scopes":[
						{"scope_name":"im:message","scope_type":"tenant","grant_status":1},
						{"scope_name":"im:message.p2p_msg:readonly","scope_type":"user","grant_status":1},
						{"scope_name":"im:message:send_as_bot","scope_type":"tenant","grant_status":0},
						{"scope_name":"task:task:read","scope_type":"tenant","grant_status":1},
						{"scope_name":"other:scope","scope_type":"tenant","grant_status":1},null,{}
					]}}`), nil
				default:
					t.Fatalf("unexpected request path %s", r.URL.Path)
					return nil, nil
				}
			})
			result, err := CheckAuthorization(context.Background(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"im:message.p2p_msg:readonly", "im:message:send_as_bot", "im:resource"}
			if enabled {
				want = append(want, "task:task:write", "im:chat:create", "im:chat:delete", "im:message.group_msg")
			}
			if !slices.Equal(result.MissingScopes, want) || calls != 2 {
				t.Fatalf("missing=%v calls=%d, want %v and 2", result.MissingScopes, calls, want)
			}
		})
	}
}

func TestCheckAuthorizationGrantedAndRenewedCredentialsAreCheckedEveryTime(t *testing.T) {
	cfg := authorizationConfig()
	cfg.Tasks.Enabled = true
	tokens := 0
	stubAuthorizationHTTP(t, func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/internal") {
			tokens++
			return authorizationResponse(`{"code":0,"tenant_access_token":"fresh","expire":7200}`), nil
		}
		scopes := []map[string]any{}
		for _, scope := range append(append([]string(nil), Scopes...), TaskScopes...) {
			scopes = append(scopes, map[string]any{"scope_name": scope, "scope_type": "tenant", "grant_status": 1})
		}
		body, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"scopes": scopes}})
		return authorizationResponse(string(body)), nil
	})
	for _, secret := range []string{testSecret, otherSecret} {
		cfg.Feishu.AppSecret = secret
		result, err := CheckAuthorization(context.Background(), cfg)
		if err != nil || len(result.MissingScopes) != 0 {
			t.Fatalf("result=%v error=%v", result, err)
		}
	}
	if tokens != 2 {
		t.Fatalf("credential checks=%d, want 2 (must bypass SDK cache)", tokens)
	}
}

func TestCheckAuthorizationDistinguishesCredentialFailureFromOutage(t *testing.T) {
	for _, tc := range []struct {
		name         string
		body         string
		err          error
		wantRequired bool
	}{
		{name: "invalid secret", body: `{"code":10015,"msg":"private secret details"}`, wantRequired: true},
		{name: "unavailable app", body: `{"code":10014}`, wantRequired: true},
		{name: "unauthorized app", body: `{"code":10005}`, wantRequired: true},
		{name: "mismatched credentials", body: `{"code":20002}`, wantRequired: true},
		{name: "invalid parameters", body: `{"code":10003}`},
		{name: "missing scope", body: `{"code":99991672}`, wantRequired: true},
		{name: "rate limit", body: `{"code":99991400}`},
		{name: "network", err: errors.New("private secret details")},
		{name: "timeout", err: context.DeadlineExceeded},
		{name: "cancelled", err: context.Canceled},
		{name: "invalid response", body: `{"code":0}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stubAuthorizationHTTP(t, func(*http.Request) (*http.Response, error) {
				if tc.err != nil {
					return nil, tc.err
				}
				return authorizationResponse(tc.body), nil
			})
			_, err := CheckAuthorization(context.Background(), authorizationConfig())
			if err == nil || errors.Is(err, ErrAuthorizationRequired) != tc.wantRequired {
				t.Fatalf("error=%v, required=%v", err, tc.wantRequired)
			}
			if strings.Contains(err.Error(), "private secret details") {
				t.Fatal("raw response or transport details escaped")
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatal("transport error cause was not retained")
			}
		})
	}
}

func TestCheckAuthorizationMissingCredentialsDoesNotCallFeishu(t *testing.T) {
	stubAuthorizationHTTP(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("missing credentials must not call Feishu")
		return nil, nil
	})
	for _, cfg := range []config.Config{config.Default(), {Feishu: config.Feishu{AppID: testAppID}}} {
		if _, err := CheckAuthorization(context.Background(), cfg); !errors.Is(err, ErrAuthorizationRequired) {
			t.Fatalf("error=%v", err)
		}
	}
}

func TestRefreshAuthorizationPersistsCurrentAppWithoutChangingOwners(t *testing.T) {
	for _, tasksEnabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "base", true: "tasks"}[tasksEnabled], func(t *testing.T) {
			dir := t.TempDir()
			cfg := authorizationConfig()
			cfg.Tasks.Enabled = tasksEnabled
			original := "# preserved\nHERDR_AGENT_AI_API_KEY=unrelated-key\nFEISHU_APP_ID=" + cfg.Feishu.AppID + "\nFEISHU_APP_SECRET=" + cfg.Feishu.AppSecret + "\n"
			if err := os.WriteFile(envPath(dir), []byte(original), 0600); err != nil {
				t.Fatal(err)
			}
			configPath := filepath.Join(dir, config.ConfigFileName)
			if err := os.WriteFile(configPath, []byte("existing config must not change\n"), 0600); err != nil {
				t.Fatal(err)
			}
			var callback bool
			stubRegister(t, func(_ context.Context, opts *registration.Options) (*registration.RegisterAppResult, error) {
				if opts.AppID != cfg.Feishu.AppID || opts.CreateOnly {
					t.Fatal("registration must update only the current app")
				}
				if !slices.Equal(opts.Addons.Scopes.Tenant, requestedScopes(registerRequest{permissionUpgrade: tasksEnabled})) {
					t.Fatal("registration requested the wrong feature permissions")
				}
				opts.OnQRCode(&registration.QRCodeInfo{URL: "https://accounts.feishu.cn/confirm?code=example", ExpireIn: 600})
				return &registration.RegisterAppResult{ClientID: cfg.Feishu.AppID, ClientSecret: otherSecret, UserInfo: &registration.UserInfo{OpenID: "ou_someone_else"}}, nil
			})
			updated, err := RefreshAuthorization(context.Background(), dir, cfg, func(url string, expiresAt time.Time) {
				callback = true
				if !strings.HasPrefix(url, "https://accounts.feishu.cn/") || time.Until(expiresAt) < 599*time.Second {
					t.Fatal("authorization URL or expiry was not forwarded")
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			if !callback || updated.Feishu.AppSecret != otherSecret || !reflect.DeepEqual(updated.Feishu.AllowedOpenIDs, cfg.Feishu.AllowedOpenIDs) {
				t.Fatal("renewal did not preserve owners or return new credentials")
			}
			stored, err := readCredentials(envPath(dir))
			if err != nil || stored.AppID != cfg.Feishu.AppID || stored.AppSecret != otherSecret {
				t.Fatal("new secret was not persisted")
			}
			env, _ := os.ReadFile(envPath(dir))
			if !strings.Contains(string(env), "HERDR_AGENT_AI_API_KEY=unrelated-key") || !strings.Contains(string(env), "# preserved") {
				t.Fatal("unrelated environment entries were changed")
			}
			info, _ := os.Stat(envPath(dir))
			if info.Mode().Perm() != 0600 {
				t.Fatal("secret file mode is not 0600")
			}
			configBytes, _ := os.ReadFile(configPath)
			if string(configBytes) != "existing config must not change\n" {
				t.Fatal("refresh modified configuration/allowlist")
			}
		})
	}
}

func TestRefreshAuthorizationRejectsWrongAppAndUnsafeURL(t *testing.T) {
	for _, tc := range []struct{ name, returnedApp, url string }{
		{"different app", otherAppID, "https://accounts.feishu.cn/confirm"},
		{"unsafe url", testAppID, "javascript:alert(1)"},
		{"foreign host", testAppID, "https://accounts.feishu.cn.example.com/confirm"},
		{"foreign launcher host", testAppID, "https://open.feishu.cn.example.com/page/launcher"},
		{"insecure launcher", testAppID, "http://open.feishu.cn/page/launcher"},
		{"launcher userinfo", testAppID, "https://other@open.feishu.cn/page/launcher"},
		{"launcher foreign authority", testAppID, "https://open.feishu.cn@evil.example/page/launcher"},
		{"launcher nonstandard port", testAppID, "https://open.feishu.cn:8443/page/launcher"},
		{"relative launcher", testAppID, "//open.feishu.cn/page/launcher"},
		{"opaque launcher", testAppID, "https:open.feishu.cn/page/launcher"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			cfg := authorizationConfig()
			stubRegister(t, func(_ context.Context, opts *registration.Options) (*registration.RegisterAppResult, error) {
				opts.OnQRCode(&registration.QRCodeInfo{URL: tc.url, ExpireIn: 600})
				return &registration.RegisterAppResult{ClientID: tc.returnedApp, ClientSecret: otherSecret}, nil
			})
			callbacks := 0
			_, err := RefreshAuthorization(context.Background(), dir, cfg, func(string, time.Time) { callbacks++ })
			if err == nil {
				t.Fatal("unsafe renewal accepted")
			}
			if _, err := os.Stat(envPath(dir)); !os.IsNotExist(err) {
				t.Fatal("failed renewal wrote credentials")
			}
			if tc.returnedApp == testAppID && callbacks != 0 {
				t.Fatal("unsafe URL was exposed to the user")
			}
		})
	}
}

func TestRefreshAuthorizationRetainsCancellationAndExpiry(t *testing.T) {
	for _, cause := range []error{context.Canceled, &registration.ExpiredError{RegisterAppError: &registration.RegisterAppError{Code: "expired_token"}}} {
		t.Run(cause.Error(), func(t *testing.T) {
			stubRegister(t, func(context.Context, *registration.Options) (*registration.RegisterAppResult, error) {
				return nil, cause
			})
			_, err := RefreshAuthorization(context.Background(), t.TempDir(), authorizationConfig(), func(string, time.Time) {})
			if !errors.Is(err, cause) {
				t.Fatalf("error=%v, cause not preserved", err)
			}
		})
	}
}
