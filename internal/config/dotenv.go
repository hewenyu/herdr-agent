package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/hewenyu/herdr-agent/internal/envfile"
)

// applyCredentials fills Feishu credential fields from the process
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

// findRepoRoot and parseDotEnv share setup's credential discovery rules.
func findRepoRoot(start string) (string, bool) { return envfile.RepoRoot(start) }

func parseDotEnv(data string) map[string]string { return envfile.Parse(data) }
