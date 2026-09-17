package setup

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/envfile"
)

// credentials are the two values that live in the .env file and nowhere else.
type credentials struct {
	AppID     string
	AppSecret string
}

// complete reports whether these credentials are usable as they stand.
func (c credentials) complete() bool { return c.AppID != "" && c.AppSecret != "" }

// envPath is <stateDir>/.env — the file setup writes credentials to.
//
// Only this one is WRITTEN. internal/config also merges a repository-root .env
// for developer convenience, and the state directory wins over it, so what
// setup writes here is what the bridge will use afterwards. Detection is a
// different question and must not use this path alone: see repoEnvCredentials.
func envPath(stateDir string) string {
	return joinPath(stateDir, config.DotEnvFileName)
}

// repoEnvCredentials reports the credentials in the repository-root .env, which
// internal/config merges into every load (config/dotenv.go loadDotEnv).
//
// Setup must detect credentials the way the BRIDGE resolves them, not the way
// setup writes them. A checkout whose only .env is the repository one runs a
// perfectly good bridge; if setup looked at <stateDir>/.env alone it would see
// nothing, register a second app — which Feishu offers no way to delete — and
// then shadow the working one, because the state directory wins.
//
// Behind a variable so tests can control it: this package's own tests run with
// their working directory inside this repository, which has such a file.
var repoEnvCredentials = func() (credentials, string) {
	wd, err := os.Getwd()
	if err != nil {
		return credentials{}, ""
	}
	root, ok := findRepoRoot(wd)
	if !ok {
		return credentials{}, ""
	}
	path := joinPath(root, config.DotEnvFileName)
	c, err := readCredentials(path)
	if err != nil {
		// A file we cannot read is one config.loadDotEnv cannot read either, so
		// it names no app that is currently in force — the bridge refuses to
		// start on it rather than authenticating with it.
		return credentials{}, ""
	}
	return c, path
}

// findRepoRoot shares the bridge's credential discovery rules.
func findRepoRoot(start string) (string, bool) { return envfile.RepoRoot(start) }

// readCredentials returns the credentials currently in path. A missing file is
// not an error: it is the first run.
func readCredentials(path string) (credentials, error) {
	lines, _, err := readEnvLines(path)
	if err != nil {
		return credentials{}, err
	}
	vals := envValues(lines)
	return credentials{AppID: vals[config.EnvAppID], AppSecret: vals[config.EnvAppSecret]}, nil
}

// readEnvLines reads path split into lines. exists distinguishes an absent file
// from an empty one, which decides whether the header comment is written.
func readEnvLines(path string) (lines []string, exists bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("setup: read %s: %w", path, err)
	}
	return splitLines(envfile.WithoutBOM(string(data))), true, nil
}

// writeCredentials merges the two credentials into path, preserving everything
// else in the file, and writes it back at mode 0600.
//
// MERGED, never rewritten from scratch: this file is the operator's, not ours.
// It may already carry unrelated variables, and truncating it to the two keys
// we happen to know about would delete configuration whose absence surfaces
// somewhere else entirely, long after setup has reported success.
//
// replaceAppID must be true to overwrite a DIFFERENT app id. Feishu exposes no
// deletion API for apps created this way, so every registration is permanent
// tenant clutter, and silently pointing the .env at a new app would strand the
// old one with no way to find it again.
func writeCredentials(path string, c credentials, now time.Time, replaceAppID bool) error {
	if !c.complete() {
		// Half a credential is worse than none: the bridge would start, fail
		// authentication, and report something that looks like a Feishu outage.
		return fmt.Errorf("setup: refusing to write incomplete credentials to %s", path)
	}

	lines, exists, err := readEnvLines(path)
	if err != nil {
		return err
	}
	if prev := envValues(lines)[config.EnvAppID]; prev != "" && prev != c.AppID && !replaceAppID {
		return fmt.Errorf("%w: %s already points at app %s", ErrCredentialsExist, path, prev)
	}

	if !exists {
		lines = append(lines,
			"# Written by `herdr-agent setup` on "+now.Format(time.RFC3339)+".",
			"# Mode 0600, and the only place the app secret is allowed to exist.",
			"# Feishu shows an app secret once; if you lose this file you must",
			"# reset the secret in the console (or register a new app).",
		)
	}

	lines = mergeEnvLines(lines, map[string]string{
		config.EnvAppID:     c.AppID,
		config.EnvAppSecret: c.AppSecret,
	})

	// 0600 is not decoration: this is the file that owns the secret, and the
	// state directory is the security boundary of the whole product (S2 §3.1).
	if err := writeFileAtomic(path, joinLines(lines), 0o600); err != nil {
		return err
	}
	return nil
}

// mergeEnvLines rewrites the assignments named in updates and leaves every
// other line — comments, blank lines, unrelated variables — exactly as it
// found them.
func mergeEnvLines(lines []string, updates map[string]string) []string {
	written := make(map[string]bool, len(updates))
	out := make([]string, 0, len(lines)+len(updates))

	for _, line := range lines {
		key, _, ok := parseEnvLine(line)
		if !ok {
			out = append(out, line)
			continue
		}
		value, wanted := updates[key]
		if !wanted {
			out = append(out, line)
			continue
		}
		if written[key] {
			// A duplicate assignment is dropped rather than kept: in the parser
			// internal/config uses, the LAST line wins, so leaving an older
			// duplicate below our write would silently undo it.
			continue
		}
		written[key] = true
		out = append(out, key+"="+value)
	}

	// Sorted so that a file written twice is byte-identical twice.
	keys := make([]string, 0, len(updates))
	for key := range updates {
		if !written[key] {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		out = append(out, key+"="+updates[key])
	}
	return out
}

// envValues collapses lines to their effective values, last assignment winning,
// exactly as internal/config's parser does.
func envValues(lines []string) map[string]string {
	out := make(map[string]string)
	for _, line := range lines {
		if key, value, ok := parseEnvLine(line); ok {
			out[key] = value
		}
	}
	return out
}

// parseEnvLine uses the same literal credential parser as config.Load.
func parseEnvLine(line string) (key, value string, ok bool) {
	return envfile.ParseLine(line)
}
