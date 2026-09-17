package setup

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/statefile"
)

// joinPath is filepath.Join, named so that the state-directory layout reads in
// one place.
func joinPath(dir, name string) string { return filepath.Join(dir, name) }

// splitLines splits a file into lines without inventing a trailing empty one,
// so that read → modify → write is byte-stable when nothing changed.
func splitLines(data string) []string {
	if data == "" {
		return nil
	}
	lines := strings.Split(data, "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	return lines
}

// joinLines is splitLines' inverse: every line is terminated, including the
// last, because a file whose final line has no newline confuses every tool
// that appends to it.
func joinLines(lines []string) []byte {
	if len(lines) == 0 {
		return nil
	}
	return []byte(strings.Join(lines, "\n") + "\n")
}

// writeFileAtomic retains setup's best-effort directory sync policy.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	committed, err := statefile.Write(path, data, mode)
	if committed {
		return nil
	}
	return err
}
