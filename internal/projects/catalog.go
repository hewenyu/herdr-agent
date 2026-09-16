// Package projects stores locally configured, reusable project directories.
package projects

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/hewenyu/herdr-agent/internal/config"
)

const FileName = "projects.json"

var (
	ErrExists   = errors.New("project name or directory already exists")
	ErrNotFound = errors.New("project does not exist")
)

type diskCatalog struct {
	Version        int                       `json:"version"`
	Bypass         *bool                     `json:"bypass,omitempty"`
	DefaultProject string                    `json:"default_project"`
	Projects       map[string]config.Project `json:"projects"`
}

// Catalog serializes mutations and publishes them only after an atomic rename.
// Once projects.json exists, its complete project list supersedes the TOML seed.
// Enabled and PollInterval still come from TOML. Share one Catalog per process.
type Catalog struct {
	mu    sync.RWMutex
	path  string
	home  string
	root  string
	tasks config.Tasks
}

func Open(stateDir string, seed config.Tasks) (*Catalog, error) {
	if stateDir == "" {
		return nil, errors.New("projects: state directory is required")
	}
	userHome, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(userHome) {
		return nil, errors.New("projects: cannot resolve an absolute user home directory")
	}
	c := &Catalog{
		path: filepath.Join(stateDir, FileName),
		home: userHome,
		root: filepath.Join(userHome, "herder-agent-code"),
	}
	c.tasks = cloneTasks(seed)
	data, err := os.ReadFile(c.path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if c.tasks.Projects == nil {
			c.tasks.Projects = make(map[string]config.Project)
		}
	case err != nil:
		return nil, fmt.Errorf("projects: read catalog: %w", err)
	default:
		var disk diskCatalog
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&disk); err != nil {
			return nil, fmt.Errorf("projects: corrupt catalog: %w", err)
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return nil, errors.New("projects: trailing data in catalog")
		}
		if disk.Version != 1 || disk.Projects == nil {
			return nil, errors.New("projects: unsupported or incomplete catalog")
		}
		c.tasks.Projects = disk.Projects
		c.tasks.DefaultProject = disk.DefaultProject
		if disk.Bypass != nil {
			c.tasks.Bypass = *disk.Bypass
		}
	}
	for name, project := range c.tasks.Projects {
		if err := config.ValidateProjectName(name); err != nil {
			return nil, fmt.Errorf("projects: invalid name: %w", err)
		}
		if err := config.ValidateProject(project); err != nil {
			return nil, fmt.Errorf("projects: %s: %w", name, err)
		}
		// Missing paths are recoverable through the local configuration page.
		// Put and task launch still require every directory to exist.
		normalized, err := config.NormalizeProject(project)
		if err == nil {
			project = normalized
		} else {
			if len(project.Directories) == 0 {
				project.Directories = []string{project.Path}
			}
			project.Path = project.Directories[0]
			if project.Agent == "" {
				project.Agent = config.DefaultTaskAgent
			}
		}
		c.tasks.Projects[name] = project
	}
	if c.tasks.DefaultProject == "" {
		c.tasks.DefaultProject = firstName(c.tasks.Projects)
	} else if _, ok := c.tasks.Projects[c.tasks.DefaultProject]; !ok {
		return nil, fmt.Errorf("projects: %w", config.ErrTaskDefaultProject)
	}
	return c, nil
}

func (c *Catalog) Root() string { return c.root }

func (c *Catalog) Snapshot() config.Tasks {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return cloneTasks(c.tasks)
}

// SetBypass changes the global setting for subsequently started agents.
func (c *Catalog) SetBypass(enabled bool) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	next := cloneTasks(c.tasks)
	next.Bypass = enabled
	_, err := c.save(next)
	return err
}

// Put registers existing directories, or replaces an existing project's settings.
// It never creates project directories and never changes a running task's snapshot.
func (c *Catalog) Put(name string, project config.Project, makeDefault bool) error {
	if err := config.ValidateProjectName(name); err != nil {
		return err
	}
	project, err := config.NormalizeProject(project)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	next := cloneTasks(c.tasks)
	next.Projects[name] = project
	if makeDefault || next.DefaultProject == "" {
		next.DefaultProject = name
	}
	_, err = c.save(next)
	return err
}

// Delete removes only configuration; it never removes directories or running tasks.
// If the default is removed, the alphabetically first remaining project replaces it.
func (c *Catalog) Delete(name string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.tasks.Projects[name]; !ok {
		return ErrNotFound
	}
	next := cloneTasks(c.tasks)
	delete(next.Projects, name)
	if next.DefaultProject == name {
		next.DefaultProject = firstName(next.Projects)
	}
	_, err := c.save(next)
	return err
}

// Create is the explicit new-project operation. It creates exactly one directory
// under the local user's ~/herder-agent-code and registers it. Existing paths are
// rejected rather than adopted, and registration failure removes only the new,
// still-empty directory. Root and project symlinks cannot escape the user's home.
func (c *Catalog) Create(ctx context.Context, name, agent string, makeDefault bool) (config.Project, error) {
	if err := ctx.Err(); err != nil {
		return config.Project{}, err
	}
	if err := config.ValidateProjectName(name); err != nil {
		return config.Project{}, err
	}
	if agent == "" {
		agent = config.DefaultTaskAgent
	}
	if agent != "codex" && agent != "claude" {
		return config.Project{}, config.ErrTaskProjectAgent
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.tasks.Projects[name]; ok {
		return config.Project{}, ErrExists
	}
	if err := ctx.Err(); err != nil {
		return config.Project{}, err
	}
	homeRoot, err := os.OpenRoot(c.home)
	if err != nil {
		return config.Project{}, fmt.Errorf("projects: open user home: %w", err)
	}
	defer homeRoot.Close()
	const rootName = "herder-agent-code"
	if err := homeRoot.Mkdir(rootName, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return config.Project{}, fmt.Errorf("projects: create project root: %w", err)
	}
	info, err := homeRoot.Lstat(rootName)
	if err != nil {
		return config.Project{}, fmt.Errorf("projects: inspect project root: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return config.Project{}, fmt.Errorf("%w: project root must be a directory, not a symlink", config.ErrTaskProjectPath)
	}
	projectRoot, err := homeRoot.OpenRoot(rootName)
	if err != nil {
		return config.Project{}, fmt.Errorf("projects: open project root: %w", err)
	}
	defer projectRoot.Close()
	if err := projectRoot.Mkdir(name, 0700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return config.Project{}, ErrExists
		}
		return config.Project{}, fmt.Errorf("projects: create directory: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			// Remove, never RemoveAll: concurrent contents must be preserved.
			_ = projectRoot.Remove(name)
		}
	}()
	project, err := config.NormalizeProject(config.Project{Path: filepath.Join(c.root, name), Agent: agent})
	if err != nil {
		return config.Project{}, err
	}
	if err := ctx.Err(); err != nil {
		return config.Project{}, err
	}
	next := cloneTasks(c.tasks)
	next.Projects[name] = project
	if makeDefault || next.DefaultProject == "" {
		next.DefaultProject = name
	}
	committed, err = c.save(next)
	if err != nil {
		return config.Project{}, err
	}
	return cloneProject(project), nil
}

// save is called with the write lock held. After rename, memory must reflect the
// committed bytes even if directory fsync reports an uncertain durability result.
func (c *Catalog) save(next config.Tasks) (committed bool, err error) {
	data, err := json.MarshalIndent(diskCatalog{Version: 1, Bypass: &next.Bypass, DefaultProject: next.DefaultProject, Projects: next.Projects}, "", "  ")
	if err != nil {
		return false, err
	}
	dir := filepath.Dir(c.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return false, err
	}
	f, err := os.CreateTemp(dir, ".projects-*")
	if err != nil {
		return false, err
	}
	temporary := f.Name()
	defer os.Remove(temporary)
	if _, err = f.Write(append(data, '\n')); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return false, err
	}
	if err := os.Rename(temporary, c.path); err != nil {
		return false, err
	}
	c.tasks = next
	d, err := os.Open(dir)
	if err != nil {
		return true, err
	}
	defer d.Close()
	return true, d.Sync()
}

func cloneProject(project config.Project) config.Project {
	project.Directories = append([]string(nil), project.Directories...)
	return project
}

func cloneTasks(tasks config.Tasks) config.Tasks {
	projects := make(map[string]config.Project, len(tasks.Projects))
	for name, project := range tasks.Projects {
		projects[name] = cloneProject(project)
	}
	tasks.Projects = projects
	return tasks
}

func firstName(projects map[string]config.Project) string {
	names := make([]string, 0, len(projects))
	for name := range projects {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return ""
	}
	return names[0]
}
