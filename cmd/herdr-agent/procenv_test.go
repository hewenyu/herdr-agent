package main

import (
	"reflect"
	"slices"
	"testing"
)

// psSample is real output, captured from `ps eww 19111` on the measurement
// machine (macOS 26.3, herdr 0.8.0). macOS has no /proc, so this appended-to-
// the-command-line format is the only way to see another process's environment.
const psSample = `  PID   TT  STAT      TIME COMMAND
19111   ??  SN     0:14.69 herdr server TERM_SESSION_ID=w1t0p0:04B2436E LC_TERMINAL_VERSION=3.6.11 COLORFGBG=15;0 XPC_FLAGS=0x0 LANG=zh_CN.UTF-8 PWD=/tmp SHELL=/bin/zsh __CFBundleIdentifier=com.googlecode.iterm2 PATH=/usr/bin:/bin
`

func TestParsePsEnviron(t *testing.T) {
	tests := []struct {
		name   string
		out    string
		want   []string
		absent []string
		// readable is what doctor keys PASS-vs-UNKNOWN off: did ps actually
		// print an environment block, or only the command line (G7)?
		readable bool
	}{
		{
			name: "real ps output",
			out:  psSample,
			want: []string{"LANG=zh_CN.UTF-8", "PATH=/usr/bin:/bin", "__CFBundleIdentifier=com.googlecode.iterm2"},
			// The command itself is not an assignment and must not be reported
			// as a variable.
			absent:   []string{"herdr", "server", "19111"},
			readable: true,
		},
		{
			// A process this user may not inspect: ps succeeds and prints only
			// the command line.
			name: "environment withheld",
			out:  "  PID   TT  STAT      TIME COMMAND\n19111   ??  SN     0:14.69 herdr server\n",
			want: nil,
		},
		{
			// The case that makes a count of variables useless as evidence: ps
			// withheld the environment, but the command line carries an
			// assignment of its own. One bogus "variable" must not be enough to
			// call the environment readable, or doctor answers PASS about an
			// environment nobody saw while CLAUDE_CODE_CHILD_SESSION is still
			// inherited by every pane (G7).
			name: "assignment in argv is not an environment",
			out:  "  PID   TT  STAT      TIME COMMAND\n19111   ??  SN     0:14.69 env FOO=bar herdr server\n",
			want: []string{"FOO=bar"},
		},
		{
			// Flags look like assignments to a naive split; the name must be a
			// shell-legal identifier.
			name: "flags are not variables",
			out:  "  PID   TT  STAT      TIME COMMAND\n5 ?? S 0:01 herdr server --socket=/tmp/x.sock 2=3 FOO=bar\n",
			want: []string{"FOO=bar"},
		},
		{
			// The clean start doctor itself recommends: four variables, so a
			// count-based rule would call it unreadable.
			name:     "env -i server",
			out:      "  PID   TT  STAT      TIME COMMAND\n7 ?? S 0:01 herdr server HOME=/Users/x PATH=/usr/bin TERM=xterm LANG=C\n",
			want:     []string{"HOME=/Users/x", "PATH=/usr/bin"},
			readable: true,
		},
		{name: "empty"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parsePsEnviron(tc.out)
			for _, want := range tc.want {
				if !slices.Contains(got, want) {
					t.Errorf("parsed %v, missing %q", got, want)
				}
			}
			for _, bad := range tc.absent {
				if slices.Contains(got, bad) {
					t.Errorf("parsed %v, must not contain %q", got, bad)
				}
			}
			if tc.want == nil && len(got) != 0 {
				t.Errorf("parsed %v, want nothing", got)
			}
			if r := environReadable(got); r != tc.readable {
				t.Errorf("environReadable(%v) = %t, want %t", got, r, tc.readable)
			}
		})
	}
}

func TestClaudeCodeVars(t *testing.T) {
	// G7: any of these in the server's environment is inherited by every pane,
	// and claude answers CLAUDE_CODE_CHILD_SESSION by turning transcript saving
	// off — which empties the mirror with no error anywhere.
	tests := []struct {
		name string
		vars []string
		want []string
	}{
		{"clean", []string{"PATH=/bin", "LANG=C", "CLAUDIA=1", "MY_CLAUDE_CODE=1"}, nil},
		{"child session marker", []string{"PATH=/bin", "CLAUDE_CODE_CHILD_SESSION=1"}, []string{"CLAUDE_CODE_CHILD_SESSION"}},
		{"bare claudecode", []string{"CLAUDECODE=1"}, []string{"CLAUDECODE"}},
		{"entitlement family", []string{"CLAUDE_CODE_ENTRYPOINT=cli", "CLAUDE_CODE=1"}, []string{"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE"}},
		{"not an assignment", []string{"CLAUDE_CODE_CHILD_SESSION"}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := claudeCodeVars(tc.vars); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("claudeCodeVars(%v) = %v, want %v", tc.vars, got, tc.want)
			}
		})
	}
}

func TestParsePIDs(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want []int
	}{
		{"one", "19111\n", []int{19111}},
		{"several", "19111\n20222\n", []int{19111, 20222}},
		{"no match", "", nil},
		{"garbage is ignored", "not-a-pid\n7\n0\n-3\n", []int{7}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := parsePIDs(tc.out); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parsePIDs(%q) = %v, want %v", tc.out, got, tc.want)
			}
		})
	}
}

func TestIsEnvAssignment(t *testing.T) {
	tests := map[string]bool{
		"PATH=/bin":    true,
		"_x1=2":        true,
		"LANG=":        true,
		"--socket=/x":  false,
		"2=3":          false,
		"herdr":        false,
		"=value":       false,
		"WITH SPACE=1": false,
	}
	for tok, want := range tests {
		if got := isEnvAssignment(tok); got != want {
			t.Errorf("isEnvAssignment(%q) = %t, want %t", tok, got, want)
		}
	}
}
