package setup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	larksdk "github.com/larksuite/oapi-sdk-go/v3"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
	larkauth "github.com/larksuite/oapi-sdk-go/v3/service/auth/v3"
)

// ErrAuthorizationRequired identifies credentials or grants that require the
// owner to sign in again. Transport failures never carry this sentinel.
var ErrAuthorizationRequired = errors.New("Feishu authorization is required")

type AuthorizationCheck struct {
	MissingScopes []string
}

var authorizationHTTP larkcore.HttpClient = &http.Client{Timeout: 15 * time.Second}

// CheckAuthorization reads the current app's tenant grants without opening a
// WebSocket or changing the app. A missing grant is returned in MissingScopes;
// invalid credentials are returned as ErrAuthorizationRequired.
func CheckAuthorization(ctx context.Context, cfg config.Config) (AuthorizationCheck, error) {
	result := AuthorizationCheck{MissingScopes: []string{}}
	if !appIDShape.MatchString(cfg.Feishu.AppID) || strings.TrimSpace(cfg.Feishu.AppSecret) == "" {
		return result, ErrAuthorizationRequired
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	api := larksdk.NewClient(cfg.Feishu.AppID, cfg.Feishu.AppSecret,
		larksdk.WithHttpClient(authorizationHTTP), larksdk.WithLogLevel(larkcore.LogLevelError),
		larksdk.WithEnableTokenCache(false))
	// The SDK's shared token cache is keyed only by app ID. Explicit acquisition
	// makes this check validate the current secret, including after renewal.
	resp, err := api.Auth.V3.TenantAccessToken.Internal(ctx, larkauth.NewInternalTenantAccessTokenReqBuilder().Body(
		larkauth.NewInternalTenantAccessTokenReqBodyBuilder().AppId(cfg.Feishu.AppID).AppSecret(cfg.Feishu.AppSecret).Build()).Build())
	if err != nil {
		return result, authorizationFailure("check credentials", err)
	}
	if resp == nil || resp.ApiResp == nil {
		return result, errors.New("setup: Feishu returned no credential response")
	}
	if !resp.Success() {
		return result, authorizationCodeFailure("check credentials", resp.Code)
	}
	// The token endpoint returns top-level fields; the generated service model
	// also supports a data envelope, so accept both without printing either.
	var token struct {
		TenantAccessToken string `json:"tenant_access_token"`
	}
	if err := json.Unmarshal(resp.RawBody, &token); err != nil {
		return result, errors.New("setup: Feishu returned an invalid credential response")
	}
	if token.TenantAccessToken == "" && resp.Data != nil && resp.Data.TenantAccessToken != nil {
		token.TenantAccessToken = *resp.Data.TenantAccessToken
	}
	if token.TenantAccessToken == "" {
		return result, errors.New("setup: Feishu returned an empty tenant token")
	}
	scopes, err := api.Application.V6.Scope.List(ctx, larkcore.WithTenantAccessToken(token.TenantAccessToken))
	if err != nil {
		return result, authorizationFailure("check permissions", err)
	}
	if scopes == nil {
		return result, errors.New("setup: Feishu returned no permission response")
	}
	if !scopes.Success() {
		return result, authorizationCodeFailure("check permissions", scopes.Code)
	}
	if scopes.Data == nil {
		return result, errors.New("setup: Feishu returned no permission data")
	}
	granted := make(map[string]bool)
	for _, scope := range scopes.Data.Scopes {
		if scope != nil && scope.ScopeName != nil && scope.ScopeType != nil && *scope.ScopeType == "tenant" &&
			scope.GrantStatus != nil && *scope.GrantStatus == 1 {
			granted[*scope.ScopeName] = true
		}
	}
	for _, required := range requestedScopes(registerRequest{permissionUpgrade: cfg.Tasks.Enabled}) {
		if !granted[required] {
			result.MissingScopes = append(result.MissingScopes, required)
		}
	}
	return result, nil
}

// RefreshAuthorization updates only the configured app and persists its new
// secret. The caller owns the instance lock, retries, and subsequent grant
// verification; this function opens no WebSocket and never changes the allowlist.
func RefreshAuthorization(ctx context.Context, stateDir string, cfg config.Config, onURL func(string, time.Time)) (config.Config, error) {
	if !appIDShape.MatchString(cfg.Feishu.AppID) {
		return cfg, ErrMalformedAppID
	}
	if strings.TrimSpace(stateDir) == "" || onURL == nil {
		return cfg, errors.New("setup: a state directory and authorization URL callback are required")
	}
	if err := ctx.Err(); err != nil {
		return cfg, err
	}
	if err := ensureStateDir(stateDir); err != nil {
		return cfg, authorizationFailure("prepare credential storage", err)
	}
	previous, err := readCredentials(envPath(stateDir))
	if err != nil {
		return cfg, authorizationFailure("read credential storage", err)
	}
	if previous.AppID != "" && previous.AppID != cfg.Feishu.AppID {
		return cfg, ErrCredentialsExist
	}
	ctx, cancel := context.WithTimeout(ctx, RegisterTimeout)
	defer cancel()
	progress := &authorizationProgress{onURL: onURL, cancel: cancel}
	res, _, err := registerOnce(ctx, &reporter{progress: progress}, registerRequest{
		appID: cfg.Feishu.AppID, permissionUpgrade: cfg.Tasks.Enabled,
	})
	if progress.invalidURL {
		return cfg, errors.New("setup: Feishu returned an invalid authorization URL")
	}
	if err != nil {
		return cfg, authorizationFailure("refresh authorization", err)
	}
	if res == nil || res.ClientID != cfg.Feishu.AppID {
		return cfg, errors.New("setup: authorization returned a different app; existing credentials were not changed")
	}
	if strings.TrimSpace(res.ClientSecret) == "" {
		return cfg, errors.New("setup: authorization returned no app secret")
	}
	if err := writeCredentials(envPath(stateDir), credentials{AppID: res.ClientID, AppSecret: res.ClientSecret}, time.Now(), false); err != nil {
		return cfg, authorizationFailure("save renewed credentials", err)
	}
	cfg.Feishu.AppSecret = res.ClientSecret
	return cfg, nil
}

type authorizationProgress struct {
	onURL      func(string, time.Time)
	cancel     context.CancelFunc
	invalidURL bool
}

func (p *authorizationProgress) Verification(raw string, expiresIn int) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || (u.Host != "accounts.feishu.cn" && u.Host != "accounts.larksuite.com") {
		p.invalidURL = true
		p.cancel()
		return
	}
	if expiresIn <= 0 {
		expiresIn = 600
	}
	p.onURL(raw, time.Now().Add(time.Duration(expiresIn)*time.Second))
}
func (*authorizationProgress) Registered(string, string)  {}
func (*authorizationProgress) AwaitInbound(time.Duration) {}
func (*authorizationProgress) AwaitCard(time.Duration)    {}
func (*authorizationProgress) Note(string)                {}

// Hide remote messages and transport URLs, which can include credentials, while
// retaining errors.Is/As for cancellation and registration-expiry handling.
type authorizationError struct {
	stage string
	cause error
}

func (e *authorizationError) Error() string { return "setup: " + e.stage + " failed" }
func (e *authorizationError) Unwrap() error { return e.cause }
func authorizationFailure(stage string, err error) error {
	return &authorizationError{stage: stage, cause: err}
}

func authorizationCodeFailure(stage string, code int) error {
	switch code {
	// Feishu's common error-code documentation identifies these as app
	// authorization/secret failures. In particular, 10015 is wrong app secret;
	// 10003 only means invalid parameters and must not trigger reauthorization.
	case 10005, 10014, 10015, 20002, 99991663, 99991664, 99991671, 99991672:
		return fmt.Errorf("setup: %s refused (code %d): %w", stage, code, ErrAuthorizationRequired)
	default:
		return fmt.Errorf("setup: %s refused (code %d)", stage, code)
	}
}
