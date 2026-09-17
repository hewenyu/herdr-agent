// Package envfile defines the literal .env format shared by config and setup.
package envfile

import (
	"os"
	"path/filepath"
	"strings"
)

// WithoutBOM removes only an editor's leading UTF-8 byte order mark.
func WithoutBOM(data string) string { return strings.TrimPrefix(data, "\ufeff") }

// Parse accepts KEY=VALUE, whole-line comments and CRLF. Values are literal:
// quotes, embedded equals signs and hashes are not shell syntax. The last
// assignment wins; export and keys containing whitespace are unsupported.
func Parse(data string) map[string]string {
	values := make(map[string]string)
	for _, line := range strings.Split(WithoutBOM(data), "\n") {
		if key, value, ok := ParseLine(line); ok {
			values[key] = value
		}
	}
	return values
}

// ParseLine parses one assignment after the file's leading BOM is removed.
// It is also used when setup preserves unrelated lines during a credential edit.
func ParseLine(line string) (key, value string, ok bool) {
	line = strings.TrimSpace(strings.TrimSuffix(line, "\r"))
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false
	}
	key, value, ok = strings.Cut(line, "=")
	if !ok {
		return "", "", false
	}
	key = strings.TrimSpace(key)
	if key == "" || strings.ContainsAny(key, " \t") {
		return "", "", false
	}
	return key, strings.TrimSpace(value), true
}

// RepoRoot finds the nearest module or Git checkout containing a developer .env.
// Config and setup must agree so setup cannot overlook the app config loads.
func RepoRoot(start string) (string, bool) {
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
