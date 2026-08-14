package herdrapi

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestResolveSocketPath(t *testing.T) {
	tests := []struct {
		name       string
		socketPath string
		session    string
		configHome string
		home       string
		want       string
		wantErr    error
	}{
		{
			name:       "HERDR_SOCKET_PATH wins over everything",
			socketPath: "/tmp/explicit/herdr.sock",
			session:    "work",
			configHome: "/cfg",
			home:       "/home/u",
			want:       "/tmp/explicit/herdr.sock",
		},
		{
			name:       "HERDR_SOCKET_PATH is used verbatim",
			socketPath: "/var/run/custom-api",
			home:       "/home/u",
			want:       "/var/run/custom-api",
		},
		{
			name:       "session name under XDG_CONFIG_HOME",
			session:    "work",
			configHome: "/cfg",
			home:       "/home/u",
			want:       "/cfg/herdr/sessions/work/herdr.sock",
		},
		{
			name:    "session name under HOME",
			session: "work",
			home:    "/home/u",
			want:    "/home/u/.config/herdr/sessions/work/herdr.sock",
		},
		{
			name: "default under HOME",
			home: "/home/u",
			want: "/home/u/.config/herdr/herdr.sock",
		},
		{
			name:       "default under XDG_CONFIG_HOME",
			configHome: "/cfg",
			home:       "/home/u",
			want:       "/cfg/herdr/herdr.sock",
		},
		{
			// herdr maps the name "default" back to the base config dir.
			name:    "session named default is not a session dir",
			session: "default",
			home:    "/home/u",
			want:    "/home/u/.config/herdr/herdr.sock",
		},
		{
			// herdr ignores names it would reject rather than failing, and so
			// must we: the point is to find the socket herdr actually bound.
			name:    "session name with a path separator is ignored",
			session: "../../etc",
			home:    "/home/u",
			want:    "/home/u/.config/herdr/herdr.sock",
		},
		{
			name:    "empty session is ignored",
			session: "",
			home:    "/home/u",
			want:    "/home/u/.config/herdr/herdr.sock",
		},
		{
			name:    "dotted session names are legal",
			session: "a.b_c-1",
			home:    "/home/u",
			want:    "/home/u/.config/herdr/sessions/a.b_c-1/herdr.sock",
		},
		{
			name:    "no config dir at all",
			wantErr: ErrNoConfigDir,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(envSocketPath, tt.socketPath)
			t.Setenv(envSession, tt.session)
			t.Setenv(envConfigHome, tt.configHome)
			t.Setenv("HOME", tt.home)

			got, err := ResolveSocketPath()
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveSocketPath: %v", err)
			}
			if got != filepath.Clean(tt.want) {
				t.Errorf("path = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNewResolvesPathWhenOptionIsEmpty(t *testing.T) {
	t.Setenv(envSocketPath, "/tmp/from-env/herdr.sock")
	t.Setenv(envSession, "")

	c, err := New(Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := c.(*socketClient).SocketPath(); got != "/tmp/from-env/herdr.sock" {
		t.Errorf("socket path = %q", got)
	}
}

func TestSessionNameValidation(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{in: "work", want: true},
		{in: "WORK-2.old_1", want: true},
		{in: "default"},
		{in: ""},
		{in: "."},
		{in: ".."},
		{in: "with/slash"},
		{in: "with space"},
		{in: "with\x00nul"},
		{in: "ünïcode"},
		{in: string(make([]byte, maxSessionNameLen+1))},
	}

	for _, tt := range tests {
		name, ok := sessionName(tt.in)
		if ok != tt.want {
			t.Errorf("sessionName(%q) ok = %v, want %v", tt.in, ok, tt.want)
		}
		if ok && name != tt.in {
			t.Errorf("sessionName(%q) = %q", tt.in, name)
		}
	}
}
