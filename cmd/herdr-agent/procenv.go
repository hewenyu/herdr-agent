package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// ProcEnv is one process's environment as ps reported it.
type ProcEnv struct {
	PID int
	// Vars are the KEY=VALUE tokens ps printed after the command line.
	Vars []string
	// Readable is false when ps answered but showed no environment, which is
	// what happens for a process this user may not inspect. That case must be
	// reported as UNKNOWN, never as "clean": a CLAUDE_CODE_CHILD_SESSION we
	// failed to see would still be inherited by every pane (G7). See
	// environReadable for what counts as evidence.
	Readable bool
}

// ErrNoServerProcess means pgrep found no `herdr server`.
var ErrNoServerProcess = errors.New("no herdr server process found")

// serverProcessPattern is what pgrep -f matches. herdr's TUI forks a standalone
// `herdr server` that reparents to PID 1 and survives the terminal (G6), so the
// process is found by its command line rather than by our own parentage.
const serverProcessPattern = "herdr server"

// procProbeTimeout bounds the two external commands. They are local and fast;
// a hang here would wedge doctor, which is the tool people run when things are
// already wedged.
const procProbeTimeout = 5 * time.Second

// lookupServerEnv reads the environment of every running herdr server.
//
// macOS has no /proc, so the environment of another process is only reachable
// through `ps eww <pid>`, which appends it to the command line. Both steps can
// fail for reasons that are not "the environment is clean", and every one of
// them is reported as an error so doctor can print UNKNOWN.
func lookupServerEnv(ctx context.Context) ([]ProcEnv, error) {
	ctx, cancel := context.WithTimeout(ctx, procProbeTimeout)
	defer cancel()

	pids, err := serverPIDs(ctx)
	if err != nil {
		return nil, err
	}
	if len(pids) == 0 {
		return nil, ErrNoServerProcess
	}
	out := make([]ProcEnv, 0, len(pids))
	for _, pid := range pids {
		vars, err := processEnviron(ctx, pid)
		if err != nil {
			return out, err
		}
		out = append(out, ProcEnv{PID: pid, Vars: vars, Readable: environReadable(vars)})
	}
	return out, nil
}

func serverPIDs(ctx context.Context) ([]int, error) {
	cmd := exec.CommandContext(ctx, "pgrep", "-f", serverProcessPattern)
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 {
			// pgrep says "no match" with status 1, which is an answer, not a
			// failure.
			return nil, nil
		}
		return nil, fmt.Errorf("pgrep -f %q: %w", serverProcessPattern, err)
	}
	return parsePIDs(string(out)), nil
}

func parsePIDs(out string) []int {
	var pids []int
	for _, field := range strings.Fields(out) {
		if pid, err := strconv.Atoi(field); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

func processEnviron(ctx context.Context, pid int) ([]string, error) {
	cmd := exec.CommandContext(ctx, "ps", "eww", strconv.Itoa(pid))
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ps eww %d: %w", pid, err)
	}
	return parsePsEnviron(string(out)), nil
}

// parsePsEnviron pulls KEY=VALUE tokens out of `ps eww` output.
//
// The format is a header line, then `PID TT STAT TIME COMMAND`, with the
// environment appended to the command line, space separated. A value that
// itself contains a space is therefore indistinguishable from the next token,
// which is fine for the only question asked here — is a variable with this NAME
// set — and is why the parse keeps names and not a map.
func parsePsEnviron(out string) []string {
	var vars []string
	for i, line := range strings.Split(out, "\n") {
		if i == 0 && strings.Contains(line, "COMMAND") {
			continue // column header
		}
		for _, tok := range strings.Fields(line) {
			if isEnvAssignment(tok) {
				vars = append(vars, tok)
			}
		}
	}
	return vars
}

// environReadable reports whether ps actually printed an environment block,
// rather than only the command line.
//
// A non-empty variable list is not evidence on its own: ps prints the command
// line whether or not it may show the environment, and a command line can carry
// assignments of its own — `env FOO=bar herdr server`, a login shell re-exec, a
// supervisor's wrapper. Harvesting one of those and calling the environment
// readable would let doctor answer PASS about an environment nobody saw, while
// the CLAUDE_CODE_CHILD_SESSION it did not see is still inherited by every pane
// herdr creates (G7).
//
// PATH and HOME are the discriminator: a real environment has at least one of
// them — including the env -i line doctor itself recommends, which sets both —
// and a stray assignment in argv almost never does.
func environReadable(vars []string) bool {
	return hasVar(vars, "PATH") || hasVar(vars, "HOME")
}

func hasVar(vars []string, name string) bool {
	for _, v := range vars {
		if n, _, ok := strings.Cut(v, "="); ok && n == name {
			return true
		}
	}
	return false
}

// isEnvAssignment reports whether tok looks like NAME=VALUE with a shell-legal
// NAME. It exists to keep command-line tokens such as `--flag=value` out of the
// environment list.
func isEnvAssignment(tok string) bool {
	name, _, ok := strings.Cut(tok, "=")
	if !ok || name == "" {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r == '_':
		case r >= '0' && r <= '9' && i > 0:
		default:
			return false
		}
	}
	return true
}

// claudeCodeVars returns the names of the variables that break transcript
// saving.
//
// Measured (G7): a herdr server started from inside a claude session passes
// CLAUDE_CODE_CHILD_SESSION to every pane it creates, and claude reacts by
// turning transcript saving OFF — `⚠ Transcript saving is off — inherited
// CLAUDE_CODE_CHILD_SESSION marker`. There is no transcript file after that, so
// the whole L2 mirror silently mirrors nothing.
func claudeCodeVars(vars []string) []string {
	var found []string
	for _, v := range vars {
		name, _, ok := strings.Cut(v, "=")
		if !ok {
			continue
		}
		if name == "CLAUDECODE" || strings.HasPrefix(name, "CLAUDE_CODE") {
			found = append(found, name)
		}
	}
	return found
}
