package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

var (
	ErrTaskProjects       = errors.New("tasks requires at least one configured project")
	ErrTaskDefaultProject = errors.New("tasks.default_project must name a configured project")
	ErrTaskProjectName    = errors.New("project name must contain only letters, digits, hyphens or underscores")
	ErrTaskProjectPath    = errors.New("project directories must be existing absolute directories")
	ErrTaskProjectAgent   = errors.New("project agent must be codex or claude")
	ErrTaskPollInterval   = errors.New("tasks.poll_interval must be positive")
)

// A project name must survive as a single command token. Chinese names are
// supported; shell punctuation, separators and whitespace are not.
var taskProjectName = regexp.MustCompile(`^[\p{L}\p{N}_-]+$`)

// ValidateProjectName restricts names to a single safe directory / command token.
func ValidateProjectName(name string) error {
	if !taskProjectName.MatchString(name) {
		return ErrTaskProjectName
	}
	return nil
}

// ValidateProject checks configuration shape without touching the filesystem.
// A removed or temporarily unavailable directory must not prevent startup of the
// local configuration UI. NormalizeProject revalidates existence before use.
func ValidateProject(project Project) error {
	if project.Agent != "" && project.Agent != "codex" && project.Agent != "claude" {
		return ErrTaskProjectAgent
	}
	directories := project.Directories
	if len(directories) == 0 {
		directories = []string{project.Path}
	}
	for i, directory := range directories {
		if !filepath.IsAbs(expandTilde(directory)) {
			return fmt.Errorf("%w: directory %d: use an absolute path or ~/path", ErrTaskProjectPath, i+1)
		}
	}
	return nil
}

// NormalizeProject validates existing directories without creating any files.
// Directories is the full ordered list; Path is the backwards-compatible fallback.
// Symlinks are resolved so an alias of the primary directory cannot also be sent
// to an agent as an additional directory. The caller's slice is never mutated.
func NormalizeProject(project Project) (Project, error) {
	if project.Agent == "" {
		project.Agent = DefaultTaskAgent
	}
	if project.Agent != "codex" && project.Agent != "claude" {
		return Project{}, ErrTaskProjectAgent
	}
	directories := project.Directories
	if len(directories) == 0 {
		directories = []string{project.Path}
	}
	project.Directories = make([]string, 0, len(directories))
	seen := make(map[string]bool, len(directories))
	for i, directory := range directories {
		directory = expandTilde(directory)
		if err := validateProjectPath(directory); err != nil {
			return Project{}, fmt.Errorf("%w: directory %d: %v", ErrTaskProjectPath, i+1, err)
		}
		canonical, err := filepath.EvalSymlinks(filepath.Clean(directory))
		if err != nil {
			return Project{}, fmt.Errorf("%w: directory %d: %v", ErrTaskProjectPath, i+1, err)
		}
		if !seen[canonical] {
			project.Directories = append(project.Directories, canonical)
			seen[canonical] = true
		}
	}
	project.Path = project.Directories[0]
	return project, nil
}

func (c Config) validateTasks() error {
	if !c.Tasks.Enabled {
		return nil
	}
	var errs []error
	if c.Tasks.PollInterval <= 0 {
		errs = append(errs, ErrTaskPollInterval)
	}
	if _, ok := c.Tasks.Projects[c.Tasks.DefaultProject]; !ok && (len(c.Tasks.Projects) != 0 || c.Tasks.DefaultProject != "") {
		errs = append(errs, ErrTaskDefaultProject)
	}
	// Stable ordering makes startup diagnostics and doctor output predictable.
	names := make([]string, 0, len(c.Tasks.Projects))
	for name := range c.Tasks.Projects {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		project := c.Tasks.Projects[name]
		field := "tasks.projects." + c.scrub(name)
		if ValidateProjectName(name) != nil {
			errs = append(errs, fmt.Errorf("%s: %w", field, ErrTaskProjectName))
		}
		if err := ValidateProject(project); err != nil {
			errs = append(errs, &redactedError{cause: err, text: field + ": " + c.scrub(err.Error())})
		}
	}
	return errors.Join(errs...)
}

func validateProjectPath(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("use an absolute path or ~/path")
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("path is not a directory")
	}
	return nil
}
