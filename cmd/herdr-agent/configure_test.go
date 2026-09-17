package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
)

func TestConfigureDoesNotRequireFeishuOrConnectToHerdr(t *testing.T) {
	h := newHarness(t)
	h.d.StateDir = t.TempDir()
	h.d.Cfg = config.Default()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := cmdConfigure(ctx, h.d, []string{"--listen", "127.0.0.1:0"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("configure without Feishu/herdr: %v", err)
	}
	if len(h.rc.Calls()) != 0 {
		t.Fatal("configure contacted herdr")
	}
	if _, err := os.Stat(filepath.Join(h.d.StateDir, bridge.PidFileName)); !os.IsNotExist(err) {
		t.Fatalf("configuration instance lock left behind: %v", err)
	}
}

func TestConfigureCannotOverwriteLiveBridgeCatalog(t *testing.T) {
	h := newHarness(t)
	h.d.StateDir = t.TempDir()
	h.d.Cfg = config.Default()
	lock, err := bridge.AcquireInstanceLock(h.d.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if err := cmdConfigure(context.Background(), h.d, []string{"--listen", "127.0.0.1:0"}); !errors.Is(err, bridge.ErrAlreadyRunning) {
		t.Fatalf("second local catalog writer accepted: %v", err)
	}
	if len(h.rc.Calls()) != 0 {
		t.Fatal("configure contacted herdr")
	}
}
