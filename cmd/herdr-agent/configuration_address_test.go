package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
)

func occupiedConfigurationAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener.Addr().String()
}

// Both commands must honor TOML and flags before any Feishu connection. An
// occupied socket gives a deterministic startup failure without contacting it.
func TestConfigurationAddressPrecedenceAndPortConflict(t *testing.T) {
	for _, command := range []struct {
		name, flag string
		run        func(context.Context, *deps, []string) error
	}{
		{"serve", "--config-listen", cmdServe},
		{"configure", "--listen", cmdConfigure},
	} {
		for _, override := range []bool{false, true} {
			name := command.name + "/TOML"
			if override {
				name = command.name + "/flag"
			}
			t.Run(name, func(t *testing.T) {
				h := newHarness(t)
				h.d.StateDir = t.TempDir()
				configured := occupiedConfigurationAddress(t)
				if err := os.WriteFile(filepath.Join(h.d.StateDir, config.ConfigFileName), []byte("[ui]\nconfig_listen = '"+configured+"'\n"), 0o600); err != nil {
					t.Fatal(err)
				}
				loaded, err := config.Load(h.d.StateDir)
				if err != nil {
					t.Fatal(err)
				}
				h.d.Cfg = validServeConfig()
				h.d.Cfg.UI = loaded.UI
				wantAddress := configured
				var args []string
				if override {
					wantAddress = occupiedConfigurationAddress(t)
					args = []string{command.flag, wantAddress}
				}
				err = command.run(context.Background(), h.d, args)
				if err == nil || !strings.Contains(err.Error(), wantAddress) || !strings.Contains(err.Error(), "config_listen") {
					t.Fatalf("port conflict must identify selected address and configuration remedy: %v", err)
				}
				if _, err := os.Stat(filepath.Join(h.d.StateDir, bridge.PidFileName)); !os.IsNotExist(err) {
					t.Fatalf("failed listener retained instance lock: %v", err)
				}
				if len(h.rc.Calls()) != 0 {
					t.Fatal("listener failure contacted herdr")
				}
			})
		}
	}
}

func TestConfigureRecoversAfterChangingConfiguredPort(t *testing.T) {
	h := newHarness(t)
	h.d.StateDir = t.TempDir()
	h.d.Cfg = config.Default()
	h.d.Cfg.UI.ConfigListen = occupiedConfigurationAddress(t)
	if err := cmdConfigure(context.Background(), h.d, nil); err == nil {
		t.Fatal("occupied configured port unexpectedly started")
	}
	// Choosing :0 is also supported in TOML; onReady must report the port
	// actually serving the embedded page, not the old default or literal :0.
	h.d.Cfg.UI.ConfigListen = "127.0.0.1:0"
	ctx, cancel := context.WithTimeout(context.Background(), 2*waitFor)
	defer cancel()
	opened := false
	// Use a request goroutine in the callback so the HTTP accept loop can start.
	pageResult := make(chan error, 1)
	h.d.OpenURL = func(url string) error {
		opened = true
		if !strings.HasPrefix(url, "http://127.0.0.1:") || strings.HasSuffix(url, ":0") {
			t.Errorf("browser destination = %q", url)
		}
		go func() {
			defer cancel()
			client := &http.Client{Timeout: waitFor}
			resp, err := client.Get(url)
			if err == nil {
				var body []byte
				body, err = io.ReadAll(resp.Body)
				resp.Body.Close()
				if err == nil && (resp.StatusCode != http.StatusOK || !strings.Contains(string(body), "<html")) {
					err = errors.New("configured address did not serve the embedded page")
				}
			}
			pageResult <- err
		}()
		return nil
	}
	if err := cmdConfigure(ctx, h.d, []string{"--open"}); err != nil {
		t.Fatal(err)
	}
	if !opened {
		t.Fatal("new configured port never became ready")
	}
	if err := <-pageResult; err != nil {
		t.Fatal(err)
	}
}
