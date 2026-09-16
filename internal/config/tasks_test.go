package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func taskRepository(t *testing.T, worktree bool) string {
	t.Helper()
	path := t.TempDir()
	if worktree {
		writeFile(t, filepath.Join(path, ".git"), "gitdir: /some/main/repo/.git/worktrees/task\n")
	} else if err := os.Mkdir(filepath.Join(path, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadTaskProjects(t *testing.T) {
	dir, _ := isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, "code", "项目")
	if err := os.MkdirAll(filepath.Join(path, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, ConfigFileName), `
[tasks]
enabled = true
default_project = "项目_1-test"
poll_interval = "45s"
[tasks.projects."项目_1-test"]
path = "~/code/项目"
[tasks.projects.another]
path = "~/code/项目"
agent = "claude"
`)
	t.Setenv(EnvAppID, "cli_tasktest")
	t.Setenv(EnvAppSecret, "task-test-secret")
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	c.Feishu.AllowedOpenIDs = []string{"ou_test"}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if !c.Tasks.Enabled || c.Tasks.DefaultProject != "项目_1-test" || c.Tasks.PollInterval != 45*time.Second {
		t.Fatalf("unexpected tasks settings: %+v", c.Tasks)
	}
	if got := c.Tasks.Projects["项目_1-test"]; got.Path != path || got.Agent != "codex" {
		t.Errorf("default project = %+v", got)
	}
	if got := c.Tasks.Projects["another"]; got.Agent != "claude" {
		t.Errorf("explicit agent = %q", got.Agent)
	}
}

func TestTaskDefaultsAndExplicitZero(t *testing.T) {
	defaults := Default()
	if defaults.Tasks.Enabled || !defaults.Tasks.Bypass || defaults.Tasks.DefaultProject != "" || len(defaults.Tasks.Projects) != 0 || defaults.Tasks.PollInterval != 30*time.Second {
		t.Fatalf("unexpected defaults: %+v", defaults.Tasks)
	}
	for _, body := range []string{"[tasks]\nenabled = true\n", "[tasks]\nenabled = true\npoll_interval = \"0s\"\n"} {
		dir, _ := isolate(t)
		writeFile(t, filepath.Join(dir, ConfigFileName), body)
		c, err := Load(dir)
		if err != nil {
			t.Fatal(err)
		}
		explicit := strings.Contains(body, "poll_interval")
		if errors.Is(c.Validate(), ErrTaskPollInterval) != explicit {
			t.Errorf("explicit zero = %v, validation = %v", explicit, c.Validate())
		}
	}
}

func TestLoadTaskBypassExplicitFalse(t *testing.T) {
	dir, _ := isolate(t)
	writeFile(t, filepath.Join(dir, ConfigFileName), "[tasks]\nbypass = false\n")
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.Tasks.Bypass {
		t.Fatal("explicit bypass=false was replaced with the default")
	}
}

func TestLoadRejectsUnknownTaskProjectSetting(t *testing.T) {
	dir, _ := isolate(t)
	writeFile(t, filepath.Join(dir, ConfigFileName), `
[tasks.projects.example]
path = "/some/repository"
agnet = "codex"
`)
	if _, err := Load(dir); err == nil || !strings.Contains(err.Error(), "tasks.projects.example.agnet") {
		t.Fatalf("Load() = %v, want unknown project setting", err)
	}
}

func TestValidateTaskProjects(t *testing.T) {
	repo := taskRepository(t, false)
	worktree := taskRepository(t, true)
	directory := t.TempDir()
	file := filepath.Join(t.TempDir(), "ordinary-file")
	writeFile(t, file, "x")
	subdir := filepath.Join(repo, "subdir")
	if err := os.Mkdir(subdir, 0o700); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		mutate func(*Tasks)
		want   error
	}{
		{"valid checkout", func(*Tasks) {}, nil},
		{"valid worktree", func(c *Tasks) { c.Projects["项目-1"] = Project{Path: worktree, Agent: "claude"} }, nil},
		{"disabled ignores incomplete settings", func(c *Tasks) { *c = Tasks{PollInterval: -time.Second} }, nil},
		{"empty catalog for first-run setup", func(c *Tasks) { c.Projects = nil; c.DefaultProject = "" }, nil},
		{"default without projects", func(c *Tasks) { c.Projects = nil }, ErrTaskDefaultProject},
		{"missing default", func(c *Tasks) { c.DefaultProject = "" }, ErrTaskDefaultProject},
		{"unknown default", func(c *Tasks) { c.DefaultProject = "another" }, ErrTaskDefaultProject},
		{"zero polling", func(c *Tasks) { c.PollInterval = 0 }, ErrTaskPollInterval},
		{"negative polling", func(c *Tasks) { c.PollInterval = -time.Second }, ErrTaskPollInterval},
		{"unsupported agent", func(c *Tasks) { c.Projects["项目-1"] = Project{Path: repo, Agent: "sh"} }, ErrTaskProjectAgent},
		{"relative path", func(c *Tasks) { c.Projects["项目-1"] = Project{Path: "code/repo", Agent: "codex"} }, ErrTaskProjectPath},
		{"unexpanded home", func(c *Tasks) { c.Projects["项目-1"] = Project{Path: "~other/repo", Agent: "codex"} }, ErrTaskProjectPath},
		{"missing directory repairable at startup", func(c *Tasks) {
			c.Projects["项目-1"] = Project{Path: filepath.Join(directory, "missing"), Agent: "codex"}
		}, nil},
		{"ordinary file repairable at startup", func(c *Tasks) { c.Projects["项目-1"] = Project{Path: file, Agent: "codex"} }, nil},
		{"directory outside git", func(c *Tasks) { c.Projects["项目-1"] = Project{Path: directory, Agent: "codex"} }, nil},
		{"repository subdirectory", func(c *Tasks) { c.Projects["项目-1"] = Project{Path: subdir, Agent: "codex"} }, nil},
		{"multiple existing directories", func(c *Tasks) {
			c.Projects["项目-1"] = Project{Directories: []string{repo, directory}, Agent: "codex"}
		}, nil},
		{"unavailable additional directory repairable at startup", func(c *Tasks) { c.Projects["项目-1"] = Project{Directories: []string{repo, file}, Agent: "codex"} }, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := validConfig()
			c.Tasks.Enabled = true
			c.Tasks.DefaultProject = "项目-1"
			c.Tasks.Projects = map[string]Project{"项目-1": {Path: repo, Agent: "codex"}}
			tt.mutate(&c.Tasks)
			err := c.Validate()
			if !errors.Is(err, tt.want) {
				t.Fatalf("Validate() = %v, want %v", err, tt.want)
			}
		})
	}
	for _, name := range []string{"", "two words", "repo/name", "repo\\name", "repo;pwd", "repo\nname", "repo.name"} {
		t.Run(fmt.Sprintf("unsafe name %q", name), func(t *testing.T) {
			c := validConfig()
			c.Tasks.Enabled = true
			c.Tasks.DefaultProject = name
			c.Tasks.Projects = map[string]Project{name: {Path: repo, Agent: "codex"}}
			if err := c.Validate(); !errors.Is(err, ErrTaskProjectName) {
				t.Fatalf("Validate() = %v", err)
			}
		})
	}
}

func TestTasksScrubSecretsWithoutMutatingProjects(t *testing.T) {
	for _, secret := range []string{testSecret, "test-secret-with-\"quote-and-\\slash"} {
		c := validConfig()
		c.Feishu.AppSecret = secret
		c.Tasks.Enabled = true
		c.Tasks.DefaultProject = secret
		project := Project{Path: "/does-not-exist/" + secret, Directories: []string{"/does-not-exist/" + secret}, Agent: secret}
		c.Tasks.Projects = map[string]Project{secret: project}
		blob, err := json.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		var decoded any
		if err := json.Unmarshal(blob, &decoded); err != nil {
			t.Fatal(err)
		}
		for kind, result := range map[string]string{
			"text": c.Redacted(), "json": fmt.Sprint(decoded), "validation": c.Validate().Error(),
		} {
			if strings.Contains(result, secret) {
				t.Errorf("%s leaks secret: %s", kind, result)
			}
		}
		if !reflect.DeepEqual(c.Tasks.Projects, map[string]Project{secret: project}) || c.Tasks.DefaultProject != secret {
			t.Fatal("redaction changed project configuration")
		}
	}
}

func TestNormalizeProjectDirectories(t *testing.T) {
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	for _, name := range []string{"frontend", "backend"} {
		if err := os.Mkdir(filepath.Join(userHome, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(userHome, "frontend"), filepath.Join(userHome, "alias")); err != nil {
		t.Fatal(err)
	}
	input := Project{Path: "/ignored-legacy-path", Directories: []string{"~/frontend", "~/backend", "~/alias", "~/frontend/."}}
	got, err := NormalizeProject(input)
	if err != nil {
		t.Fatal(err)
	}
	front, err := filepath.EvalSymlinks(filepath.Join(userHome, "frontend"))
	if err != nil {
		t.Fatal(err)
	}
	back, err := filepath.EvalSymlinks(filepath.Join(userHome, "backend"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Directories, []string{front, back}) || got.Path != front || got.Agent != "codex" {
		t.Fatalf("NormalizeProject = %+v", got)
	}
	if input.Directories[0] != "~/frontend" {
		t.Fatal("NormalizeProject mutated its input")
	}
}

func TestLoadMultipleProjectDirectories(t *testing.T) {
	dir, _ := isolate(t)
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	writeFile(t, filepath.Join(dir, ConfigFileName), `
[tasks.projects.app]
path = "/ignored"
directories = ["~/frontend", "~/backend"]
`)
	c, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := c.Tasks.Projects["app"]
	want := []string{filepath.Join(userHome, "frontend"), filepath.Join(userHome, "backend")}
	if !reflect.DeepEqual(got.Directories, want) || got.Path != want[0] || got.Agent != "codex" {
		t.Fatalf("project = %+v", got)
	}
}

func TestNormalizeProjectRejectsMissingAndFileDirectories(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "file")
	writeFile(t, file, "x")
	for _, path := range []string{"", "relative", filepath.Join(directory, "missing"), file} {
		for _, project := range []Project{{Path: path}, {Directories: []string{directory, path}}} {
			if _, err := NormalizeProject(project); !errors.Is(err, ErrTaskProjectPath) {
				t.Errorf("NormalizeProject(%+v) = %v", project, err)
			}
		}
	}
}
