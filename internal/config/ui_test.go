package config

import (
	"path/filepath"
	"testing"
)

func TestLoadConfigurationListenAddress(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
	}{
		{"omitted", "[ui]\ntail_lines = 3\n", "127.0.0.1:18790"},
		{"empty retains default", "[ui]\nconfig_listen = ''\n", "127.0.0.1:18790"},
		{"custom port", "[ui]\nconfig_listen = '127.0.0.1:18791'\n", "127.0.0.1:18791"},
		{"IPv6", "[ui]\nconfig_listen = '[::1]:18791'\n", "[::1]:18791"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, _ := isolate(t)
			writeFile(t, filepath.Join(dir, ConfigFileName), tc.body)
			cfg, err := Load(dir)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.UI.ConfigListen != tc.want {
				t.Fatalf("config_listen = %q, want %q", cfg.UI.ConfigListen, tc.want)
			}
		})
	}
}
