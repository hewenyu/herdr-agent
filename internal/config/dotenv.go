package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// applyCredentials fills the two credential fields from the process
// environment, falling back to .env files.
func applyCredentials(cfg *Config, dir string) error {
	dotenv, err := loadDotEnv(dir)
	if err != nil {
		return err
	}
	cfg.Feishu.AppID = lookupEnv(EnvAppID, dotenv)
	cfg.Feishu.AppSecret = lookupEnv(EnvAppSecret, dotenv)
	return nil
}

// lookupEnv prefers the real environment. A variable that is present but empty
// still counts as set: the process environment is the operator's most explicit
// statement of intent, and a .env silently winning over it would be worse than
// a missing credential, which Validate reports clearly.
func lookupEnv(key string, dotenv map[string]string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return dotenv[key]
}

// loadDotEnv merges the repository root .env (developer convenience) and
// <dir>/.env (the deployed state directory), the latter winning.
func loadDotEnv(dir string) (map[string]string, error) {
	var paths []string
	if wd, err := os.Getwd(); err == nil {
		if root, ok := findRepoRoot(wd); ok {
			paths = append(paths, filepath.Join(root, DotEnvFileName))
		}
	}
	if dir != "" {
		paths = append(paths, filepath.Join(dir, DotEnvFileName))
	}

	merged := make(map[string]string)
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", p, err)
		}
		for k, v := range parseDotEnv(string(data)) {
			merged[k] = v
		}
	}
	return merged, nil
}

// findRepoRoot walks up from start looking for a module or git checkout root.
func findRepoRoot(start string) (string, bool) {
	dir := filepath.Clean(start)
	for {
		for _, marker := range []string{"go.mod", ".git"} {
			if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
				return dir, true
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

// parseDotEnv reads the deliberately small format described in S2 §3.1:
// KEY=VALUE, whole-line # comments, no `export`, no quoting.
//
// Values are taken literally after the first '=', so a '#' inside a secret is
// part of the secret and a quote character stays in the value. Anything
// cleverer would risk silently mangling a credential, which fails much later
// and much less obviously than a wrong-looking .env.
func parseDotEnv(data string) map[string]string {
	out := make(map[string]string)
	data = strings.TrimPrefix(data, "\ufeff") // editor-written BOM

	for _, line := range strings.Split(data, "\n") {
		// A CRLF file would otherwise hide a \r at the end of every secret.
		line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		// Skips `export FOO=bar`: the format has no export keyword, and storing
		// it under the key "export FOO" would look like it had worked.
		if key == "" || strings.ContainsAny(key, " \t") {
			continue
		}
		out[key] = strings.TrimSpace(value)
	}
	return out
}
