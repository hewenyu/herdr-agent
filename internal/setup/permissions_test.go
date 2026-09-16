package setup

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

func TestPermissionUpgradeOpensExistingAppWithSavedCredentials(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b, WithPermissionUpgrade(true))
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\nOTHER=keep\n")
	var got *registration.Options
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		got = o
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/permissions", ExpireIn: 600})
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: otherSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got == nil || got.AppID != testAppID || got.CreateOnly {
		t.Fatalf("update was not pinned to the existing app: %+v", got)
	}
	wantScopes := []string{
		"im:message", "im:message.p2p_msg:readonly", "im:message:send_as_bot", "im:resource",
		"task:task:write", "task:task:read", "im:chat:create", "im:chat:delete", "im:message.group_msg",
	}
	if !slices.Equal(got.Addons.Scopes.Tenant, wantScopes) || len(got.Addons.Scopes.User) != 0 {
		t.Fatalf("scopes = %+v, want only tenant scopes %v", got.Addons.Scopes, wantScopes)
	}
	if !slices.Equal(got.Addons.Events.Items.Tenant, Events) || !slices.Equal(got.Addons.Callbacks.Items, Callbacks) {
		t.Fatal("permission update lost the bridge events or card callback")
	}
	if res.Origin != OriginUpdated || res.AppID != testAppID {
		t.Fatalf("result = %+v, want updated existing app", res)
	}
	if !strings.Contains(p.text(), "https://example.invalid/permissions") {
		t.Fatal("permission update URL was not reported")
	}
	saved, err := readCredentials(envPath(dir))
	if err != nil || saved.AppID != testAppID || saved.AppSecret != otherSecret {
		t.Fatal("updated credentials were not saved for the same app")
	}
	if !strings.Contains(readFile(t, envPath(dir)), "OTHER=keep") {
		t.Fatal("unrelated environment setting was lost")
	}
}

func TestPermissionUpgradeRefusesDifferentReturnedApp(t *testing.T) {
	r, _, dir := newRun(t, nil, WithPermissionUpgrade(true))
	before := config.EnvAppID + "=" + testAppID + "\n" + config.EnvAppSecret + "=" + testSecret + "\n"
	writeEnvFixture(t, dir, before)
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/permissions", ExpireIn: 600})
		return &registration.RegisterAppResult{ClientID: otherAppID, ClientSecret: otherSecret}, nil
	})

	res, err := r.Run(context.Background(), false)
	if err == nil || !strings.Contains(err.Error(), "different app") || res.Outcome != OutcomeFailed {
		t.Fatalf("Run = %+v, %v; want rejected app mismatch", res, err)
	}
	if got := readFile(t, envPath(dir)); got != before {
		t.Fatal("an app mismatch overwrote the original credentials")
	}
	if _, err := os.Stat(configPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an app mismatch modified the allowlist")
	}
}

func TestPermissionUpgradeRequiresExistingAppAndRejectsReregister(t *testing.T) {
	for _, tc := range []struct {
		name       string
		reregister bool
	}{
		{name: "no configured app"},
		{name: "reregister", reregister: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, _, _ := newRun(t, nil, WithPermissionUpgrade(true))
			noRegister(t)
			if _, err := r.Run(context.Background(), tc.reregister); err == nil {
				t.Fatal("permission update accepted a request without an existing target")
			}
		})
	}
}

func TestPermissionUpgradeAmbiguityRequiresExplicitApp(t *testing.T) {
	r, _, dir := newRun(t, nil, WithPermissionUpgrade(true))
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")
	repoEnv(t, credentials{AppID: otherAppID, AppSecret: otherSecret}, "")
	noRegister(t)
	if _, err := r.Run(context.Background(), false); !errors.Is(err, ErrAmbiguousApps) {
		t.Fatalf("Run error = %v, want explicit app selection", err)
	}
}

func TestPermissionUpgradeExplicitAppWithoutLocalSecret(t *testing.T) {
	r, _, _ := newRun(t, nil, WithPermissionUpgrade(true), WithReuseAppID(testAppID))
	p, err := r.choose(context.Background(), nil, discovery{}, false)
	if err != nil || p.kind != planUpdate || p.app.AppID != testAppID {
		t.Fatalf("plan = %+v, error = %v; want pinned update", p, err)
	}
	if req := requestFor(p); req.appID != testAppID || req.createOnly {
		t.Fatalf("request = %+v; want existing app only", req)
	}
}
