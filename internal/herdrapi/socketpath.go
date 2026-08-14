package herdrapi

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Environment variables herdr itself reads when it decides where to bind.
const (
	envSocketPath = "HERDR_SOCKET_PATH"
	envSession    = "HERDR_SESSION"
	envConfigHome = "XDG_CONFIG_HOME"
)

// defaultSessionName is the name herdr treats as "no named session": it maps
// back to the base config directory, not to sessions/default/.
const defaultSessionName = "default"

// maxSessionNameLen mirrors herdr's own limit. A name that fails validation is
// ignored by herdr rather than rejected, so we ignore it too — the goal is to
// arrive at the same path the server bound, not to police the environment.
const maxSessionNameLen = 64

// ErrNoConfigDir means neither XDG_CONFIG_HOME nor HOME is set, so there is no
// way to guess where herdr put its socket.
var ErrNoConfigDir = errors.New("cannot locate herdr config dir: neither XDG_CONFIG_HOME nor HOME is set")

// ResolveSocketPath returns the path of the herdr API socket, using the same
// precedence herdr uses when it binds:
//
//  1. HERDR_SOCKET_PATH, verbatim.
//  2. HERDR_SESSION=<name> => <config>/sessions/<name>/herdr.sock.
//  3. <config>/herdr.sock.
//
// <config> is $XDG_CONFIG_HOME/herdr when that variable is set, else
// $HOME/.config/herdr.
//
// HERDR_SESSION=default, an empty name, or a name herdr would reject all fall
// through to case 3, because that is what herdr does with them.
func ResolveSocketPath() (string, error) {
	if p := os.Getenv(envSocketPath); p != "" {
		return p, nil
	}
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	if name, ok := sessionName(os.Getenv(envSession)); ok {
		return filepath.Join(dir, "sessions", name, "herdr.sock"), nil
	}
	return filepath.Join(dir, "herdr.sock"), nil
}

func configDir() (string, error) {
	if d := os.Getenv(envConfigHome); d != "" {
		return filepath.Join(d, "herdr"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", fmt.Errorf("%w: %v", ErrNoConfigDir, err)
	}
	return filepath.Join(home, ".config", "herdr"), nil
}

// sessionName reports whether raw names a real session directory.
func sessionName(raw string) (string, bool) {
	if raw == "" || raw == defaultSessionName || raw == "." || raw == ".." {
		return "", false
	}
	if len(raw) > maxSessionNameLen {
		return "", false
	}
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.' || c == '_' || c == '-':
		default:
			return "", false
		}
	}
	return raw, true
}
