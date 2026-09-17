package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/projectweb"
	"github.com/hewenyu/herdr-agent/internal/setup"
)

// A missing secret for a configured app can be recovered by its confirmation
// page. All other validation, especially the sender allowlist, still applies.
func validateServeConfiguration(cfg config.Config, canAuthorize bool) error {
	if canAuthorize && cfg.Feishu.AppSecret == "" {
		cfg.Feishu.AppSecret = "pending startup authorization"
	}
	return cfg.Validate()
}

type authorizationFlow struct {
	check   func(context.Context, config.Config) (setup.AuthorizationCheck, error)
	refresh func(context.Context, string, config.Config, func(string, time.Time)) (config.Config, error)
	wait    func(context.Context) error
	now     func() time.Time
}

func ensureServeAuthorization(ctx context.Context, dir string, cfg config.Config, report func(projectweb.AuthorizationStatus)) (config.Config, error) {
	return (authorizationFlow{
		check: setup.CheckAuthorization, refresh: setup.RefreshAuthorization, now: time.Now,
		wait: func(ctx context.Context) error {
			timer := time.NewTimer(10 * time.Second)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
				return nil
			}
		},
	}).run(ctx, dir, cfg, report)
}

func (f authorizationFlow) run(ctx context.Context, dir string, cfg config.Config, report func(projectweb.AuthorizationStatus)) (config.Config, error) {
	// A successful confirmation may take a short time to reach the scope API.
	// Recheck before asking the user to authorize again.
	propagationChecks := 0
	for {
		if err := ctx.Err(); err != nil {
			return cfg, err
		}
		report(projectweb.AuthorizationStatus{State: "checking", Message: "正在检查飞书应用凭据和权限…"})
		checked, err := f.check(ctx, cfg)
		if ctx.Err() != nil {
			return cfg, ctx.Err()
		}
		now := f.now()
		if err == nil && len(checked.MissingScopes) == 0 {
			report(projectweb.AuthorizationStatus{State: "ready", Message: "飞书权限已就绪", CheckedAt: now})
			return cfg, nil
		}
		if err != nil && !errors.Is(err, setup.ErrAuthorizationRequired) {
			report(projectweb.AuthorizationStatus{State: "error", Message: "暂时无法检查飞书权限，请检查网络或飞书服务状态；系统会自动重试。", CheckedAt: now})
			if err := f.wait(ctx); err != nil {
				return cfg, err
			}
			continue
		}
		if propagationChecks > 0 {
			propagationChecks--
			report(projectweb.AuthorizationStatus{State: "checking", Message: "授权已提交，正在等待飞书权限生效…", CheckedAt: now, MissingScopes: checked.MissingScopes})
			if err := f.wait(ctx); err != nil {
				return cfg, err
			}
			continue
		}
		status := projectweb.AuthorizationStatus{
			State: "required", Message: "飞书尚未授权或权限不足，正在生成登录链接…",
			CheckedAt: now, MissingScopes: checked.MissingScopes,
		}
		report(status)
		linkPublished := false
		updated, err := f.refresh(ctx, dir, cfg, func(url string, expires time.Time) {
			if url != "" {
				linkPublished = true
			}
			link := status
			link.Message = "请登录飞书并确认更新当前应用权限。完成后服务会自动继续启动。"
			link.URL, link.ExpiresAt = url, expires
			report(link)
		})
		if ctx.Err() != nil {
			return cfg, ctx.Err()
		}
		if err == nil {
			cfg = updated
			propagationChecks = 3
			continue
		}
		// Registration errors can contain sensitive request data. Keep the
		// local status actionable without exposing SDK bodies or credentials.
		message := "无法生成飞书授权链接，请检查网络或飞书服务状态；系统会自动重试。"
		if linkPublished {
			message = "授权尚未完成或链接已失效，系统会重新检查并自动生成新的登录链接。"
		}
		report(projectweb.AuthorizationStatus{State: "error", Message: message, CheckedAt: now, MissingScopes: checked.MissingScopes})
		if err := f.wait(ctx); err != nil {
			return cfg, err
		}
	}
}

type serveAuthorizationState struct {
	mu    sync.RWMutex
	value projectweb.AuthorizationStatus
}

func newServeAuthorizationState(enabled bool) *serveAuthorizationState {
	state := "disabled"
	if enabled {
		state = "checking"
	}
	return &serveAuthorizationState{value: projectweb.AuthorizationStatus{State: state}}
}

func (s *serveAuthorizationState) snapshot() projectweb.AuthorizationStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	value := s.value
	value.MissingScopes = append([]string(nil), value.MissingScopes...)
	return value
}

func (s *serveDeps) authorizationReporter(state *serveAuthorizationState, open func(string) error) func(projectweb.AuthorizationStatus) {
	opened := false
	return func(next projectweb.AuthorizationStatus) {
		state.mu.Lock()
		prev := state.value
		next.MissingScopes = append([]string(nil), next.MissingScopes...)
		state.value = next
		state.mu.Unlock()
		if next.State != prev.State || next.URL != prev.URL || next.Message != prev.Message {
			s.log.Info("serve: feishu authorization", "state", next.State, "message", next.Message, "missing_scopes", next.MissingScopes)
			if next.URL != "" {
				s.log.Info("serve: login to update Feishu permissions", "url", next.URL, "expires_at", next.ExpiresAt)
			}
		}
		if next.URL != "" && !opened && open != nil {
			opened = true
			target := next.URL
			if s.configuration != nil {
				target = s.configuration.url
			}
			if err := open(target); err != nil {
				s.log.Warn("serve: could not open authorization page; use the displayed login URL")
			}
		}
	}
}

// The local page is available while login is pending. It runs under the same
// instance lock and is supervised after the bridge has been built.
type serveConfiguration struct {
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	err    error // read only after done is closed
	url    string
}

func (s *serveDeps) startConfiguration(ctx context.Context, addr string, status func() projectweb.AuthorizationStatus) error {
	uiCtx, cancel := context.WithCancel(ctx)
	ui := &serveConfiguration{ctx: uiCtx, cancel: cancel, done: make(chan struct{})}
	ready := make(chan string, 1)
	go func() {
		defer cancel()
		defer close(ui.done)
		ui.err = projectweb.Serve(uiCtx, addr, s.projects, func(url string) { ready <- url }, projectweb.WithAuthorizationStatus(status))
	}()
	select {
	case ui.url = <-ready:
		s.configuration = ui
		s.push("local project configuration", ui.stop)
		s.log.Info("serve: project configuration ready", "url", ui.url)
		return nil
	case <-ui.done:
		if ui.err != nil {
			return ui.err
		}
		return uiCtx.Err()
	}
}

func (u *serveConfiguration) failure() error {
	select {
	case <-u.done:
		return u.err
	default:
		return nil
	}
}

func (u *serveConfiguration) stop() error {
	u.cancel()
	<-u.done
	return u.err
}

func (u *serveConfiguration) run(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return u.stop()
	case <-u.done:
		return u.err
	}
}
