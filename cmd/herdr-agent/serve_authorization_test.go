package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/projectweb"
	"github.com/hewenyu/herdr-agent/internal/setup"
)

func TestServeAuthorizationChecksEveryStartWithoutReauthorizingReadyApp(t *testing.T) {
	checks := 0
	flow := authorizationFlow{
		check: func(context.Context, config.Config) (setup.AuthorizationCheck, error) {
			checks++
			return setup.AuthorizationCheck{}, nil
		},
		refresh: func(context.Context, string, config.Config, func(string, time.Time)) (config.Config, error) {
			t.Fatal("a ready app was asked to log in again")
			return config.Config{}, nil
		},
		now: time.Now,
	}
	for range 2 {
		var states []string
		_, err := flow.run(context.Background(), t.TempDir(), validServeConfig(), func(s projectweb.AuthorizationStatus) { states = append(states, s.State) })
		if err != nil || !slices.Equal(states, []string{"checking", "ready"}) {
			t.Fatalf("startup = %v, %v", states, err)
		}
	}
	if checks != 2 {
		t.Fatal("permissions were not checked on each start")
	}
}

func TestServeAuthorizationRefreshesExpiredLinksAndRechecksNewCredentials(t *testing.T) {
	var statuses []projectweb.AuthorizationStatus
	refreshes, waits, checksAfterRefresh := 0, 0, 0
	flow := authorizationFlow{
		check: func(_ context.Context, cfg config.Config) (setup.AuthorizationCheck, error) {
			if cfg.Feishu.AppSecret == "updated-secret" {
				checksAfterRefresh++
				if checksAfterRefresh >= 2 {
					return setup.AuthorizationCheck{}, nil
				}
			}
			return setup.AuthorizationCheck{MissingScopes: []string{"task:task:read"}}, nil
		},
		refresh: func(_ context.Context, _ string, cfg config.Config, link func(string, time.Time)) (config.Config, error) {
			refreshes++
			link(fmt.Sprintf("https://accounts.feishu.cn/authorize?attempt=%d", refreshes), time.Now().Add(time.Minute))
			if refreshes == 1 {
				return cfg, errors.New("link expired")
			}
			cfg.Feishu.AppSecret = "updated-secret"
			return cfg, nil
		},
		wait: func(context.Context) error { waits++; return nil },
		now:  time.Now,
	}
	got, err := flow.run(context.Background(), t.TempDir(), validServeConfig(), func(s projectweb.AuthorizationStatus) { statuses = append(statuses, s) })
	if err != nil || got.Feishu.AppSecret != "updated-secret" || refreshes != 2 || checksAfterRefresh != 2 || waits != 2 {
		t.Fatalf("authorization did not renew and verify: err=%v refresh=%d checks=%d waits=%d", err, refreshes, checksAfterRefresh, waits)
	}
	var urls []string
	for _, s := range statuses {
		if s.URL != "" {
			urls = append(urls, s.URL)
			if s.State != "required" || len(s.MissingScopes) != 1 || s.ExpiresAt.IsZero() {
				t.Fatal("login link lost its authorization context")
			}
		}
	}
	if len(urls) != 2 || urls[0] == urls[1] || statuses[len(statuses)-1].State != "ready" || statuses[len(statuses)-1].URL != "" {
		t.Fatal("the expired login link remained active or success was not published")
	}
}

func TestServeAuthorizationDoesNotTreatNetworkFailureAsMissingPermission(t *testing.T) {
	checks := 0
	var statuses []projectweb.AuthorizationStatus
	flow := authorizationFlow{
		check: func(context.Context, config.Config) (setup.AuthorizationCheck, error) {
			checks++
			if checks == 1 {
				return setup.AuthorizationCheck{}, errors.New("connection failed with private request details")
			}
			return setup.AuthorizationCheck{}, nil
		},
		refresh: func(context.Context, string, config.Config, func(string, time.Time)) (config.Config, error) {
			t.Fatal("a network outage opened a new authorization flow")
			return config.Config{}, nil
		},
		wait: func(context.Context) error { return nil }, now: time.Now,
	}
	_, err := flow.run(context.Background(), t.TempDir(), validServeConfig(), func(s projectweb.AuthorizationStatus) { statuses = append(statuses, s) })
	if err != nil || checks != 2 || statuses[1].State != "error" || statuses[1].URL != "" {
		t.Fatalf("network recovery = %+v, %v", statuses, err)
	}
}

func TestServeAuthorizationRecoversMissingSecretAndHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := validServeConfig()
	cfg.Feishu.AppSecret = ""
	refreshed := false
	flow := authorizationFlow{
		check: func(context.Context, config.Config) (setup.AuthorizationCheck, error) {
			return setup.AuthorizationCheck{}, setup.ErrAuthorizationRequired
		},
		refresh: func(_ context.Context, _ string, cfg config.Config, link func(string, time.Time)) (config.Config, error) {
			refreshed = true
			cancel()
			return cfg, context.Canceled
		}, now: time.Now,
	}
	_, err := flow.run(ctx, t.TempDir(), cfg, func(projectweb.AuthorizationStatus) {})
	if !refreshed || !errors.Is(err, context.Canceled) {
		t.Fatalf("missing credential recovery/cancellation = %v", err)
	}
}

func TestServeExposesLocalLoginBeforeConnectingAndUsesRefreshedSecret(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	h.d.Cfg.Feishu.AppSecret = ""
	hooks.configListen = "127.0.0.1:0"
	opened := make(chan string, 1)
	h.d.OpenURL = func(url string) error { opened <- url; return nil }
	confirmed := make(chan struct{})
	hooks.authorize = func(ctx context.Context, _ string, cfg config.Config, report func(projectweb.AuthorizationStatus)) (config.Config, error) {
		if !p.lock.held() {
			return cfg, errors.New("authorization started before the instance lock")
		}
		report(projectweb.AuthorizationStatus{State: "required", URL: "https://accounts.feishu.cn/authorize", ExpiresAt: time.Now().Add(time.Minute)})
		select {
		case <-ctx.Done():
			return cfg, ctx.Err()
		case <-confirmed:
		}
		cfg.Feishu.AppSecret = "refreshed-secret"
		report(projectweb.AuthorizationStatus{State: "ready"})
		return cfg, nil
	}
	newBot := hooks.newBot
	hooks.newBot = func(cfg config.Config, log *slog.Logger) (lark.Bot, error) {
		if cfg.Feishu.AppSecret != "refreshed-secret" {
			return nil, errors.New("bot received credentials from before login")
		}
		return newBot(cfg, log)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type result struct {
		service *serveDeps
		err     error
	}
	built := make(chan result, 1)
	go func() { s, err := buildServe(ctx, h.d, newServeLogger(&h.errb), hooks); built <- result{s, err} }()
	var localURL string
	select {
	case localURL = <-opened:
	case <-time.After(waitFor):
		t.Fatal("startup never exposed the login page")
	}
	if got := p.order.events(); !slices.Equal(got, []string{"lock"}) {
		t.Fatalf("bot was built before authorization: %v", got)
	}
	client := &http.Client{Timeout: waitFor}
	resp, err := client.Get(localURL + "/api/feishu/authorization")
	if err != nil {
		t.Fatal(err)
	}
	var status projectweb.AuthorizationStatus
	err = json.NewDecoder(resp.Body).Decode(&status)
	resp.Body.Close()
	if err != nil || resp.StatusCode != 200 || status.State != "required" || status.URL == "" {
		t.Fatalf("pending authorization was not visible: %+v, %v", status, err)
	}
	close(confirmed)
	got := <-built
	if got.err != nil {
		t.Fatal(got.err)
	}
	if err := got.service.shutdown(); err != nil {
		t.Fatal(err)
	}
	if p.lock.held() {
		t.Fatal("shutdown retained the instance lock")
	}
	if _, err := client.Get(localURL); err == nil {
		t.Fatal("configuration server survived shutdown")
	}
}

func TestServeAuthorizationFailureUnwindsLocalServerAndLock(t *testing.T) {
	h, hooks, p := newServeHarness(t)
	hooks.configListen = "127.0.0.1:0"
	hooks.authorize = func(context.Context, string, config.Config, func(projectweb.AuthorizationStatus)) (config.Config, error) {
		return config.Config{}, context.Canceled
	}
	_, err := buildServe(context.Background(), h.d, newServeLogger(&h.errb), hooks)
	if !errors.Is(err, context.Canceled) || p.lock.held() || p.bot.startCount() != 0 {
		t.Fatalf("failed authorization leaked startup: %v", err)
	}
}

func TestServeAuthorizationNeverBypassesAllowlistOrInstanceLock(t *testing.T) {
	for _, missingAllowlist := range []bool{true, false} {
		h, hooks, _ := newServeHarness(t)
		hooks.authorize = func(context.Context, string, config.Config, func(projectweb.AuthorizationStatus)) (config.Config, error) {
			t.Fatal("refused startup reached authorization")
			return config.Config{}, nil
		}
		if missingAllowlist {
			h.d.Cfg.Feishu.AppSecret = ""
			h.d.Cfg.Feishu.AllowedOpenIDs = nil
		} else {
			hooks.lock = func(string, *slog.Logger) (instanceLock, error) { return nil, bridge.ErrAlreadyRunning }
		}
		if _, err := buildServe(context.Background(), h.d, newServeLogger(&h.errb), hooks); err == nil {
			t.Fatal("unauthorized or duplicate startup was allowed")
		}
	}
}
