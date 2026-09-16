package tasktools

import (
	"io"
	"os"
	"sort"
)

// Directory is a bounded, read-only observation of a configured task directory.
// Entry names are not file contents and do not prove this task produced them.
type Directory struct {
	Path      string   `json:"path"`
	Available bool     `json:"available"`
	Empty     bool     `json:"empty"`
	Entries   []string `json:"entries"`
	Truncated bool     `json:"truncated,omitempty"`
	Problem   string   `json:"problem,omitempty"`
}

func inspectDirectories(primary string, configured []string) []Directory {
	paths := append([]string(nil), configured...)
	if len(paths) == 0 && primary != "" {
		paths = []string{primary}
	}
	out := make([]Directory, 0, len(paths))
	for _, path := range paths {
		out = append(out, inspectDirectory(path))
	}
	return out
}

func inspectDirectory(path string) Directory {
	const maxEntries = 20
	out := Directory{Path: path, Entries: []string{}}
	f, err := os.Open(path)
	if err != nil {
		out.Problem = "目录不存在或当前无法读取"
		return out
	}
	defer f.Close()
	for {
		entries, err := f.ReadDir(maxEntries + 1)
		for _, entry := range entries {
			if entry.Name() == ".git" {
				continue
			}
			name := entry.Name()
			if entry.IsDir() {
				name += "/"
			}
			out.Entries = append(out.Entries, name)
			if len(out.Entries) > maxEntries {
				out.Entries = out.Entries[:maxEntries]
				out.Available, out.Truncated = true, true
				sort.Strings(out.Entries)
				return out
			}
		}
		if err == io.EOF {
			out.Available, out.Empty = true, len(out.Entries) == 0
			sort.Strings(out.Entries)
			return out
		}
		if err != nil {
			out.Problem = "目录当前无法完整读取"
			return out
		}
	}
}
