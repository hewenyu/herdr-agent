package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

// checkStatus is a doctor verdict.
//
// UNKNOWN exists because "I could not look" is not "it is fine". The server
// environment check in particular is unreadable for a process this user does
// not own, and reporting that as PASS would hide the one variable that empties
// the mirror (G7).
type checkStatus string

const (
	checkPass    checkStatus = "PASS"
	checkFail    checkStatus = "FAIL"
	checkWarn    checkStatus = "WARN"
	checkUnknown checkStatus = "UNKNOWN"
)

// check is one diagnosis plus a fix the operator can paste into a shell.
type check struct {
	name   string
	status checkStatus
	detail []string
	why    string
	fix    []string
}

// cleanServerStart is the copy-pasteable way to start herdr from an environment
// that carries nothing of the shell that typed it.
//
// env -i is the whole point (G7): a server started from inside a claude session
// hands CLAUDE_CODE_CHILD_SESSION to every pane it later creates, and claude
// answers that by switching transcript saving off.
const cleanServerStart = `env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" LANG="$LANG" nohup herdr server >/tmp/herdr-server.log 2>&1 &`

// cmdDoctor checks the things that break this bridge silently (S1 §3.6).
func cmdDoctor(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "doctor", "")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return usagef("doctor takes no arguments, got %q", fs.Arg(0))
	}

	checks, _ := d.runChecks(ctx)
	return writeChecks(d, checks)
}

// serverProbe is what the startup ping actually found, carried alongside the
// rendered check because the two callers disagree about what a failure means.
//
// `doctor` prints every verdict and exits non-zero on any FAIL. `serve` starts
// anyway — except for the two conditions that leave nothing to bridge: a herdr
// that never answered, and one whose protocol this build cannot decode (S1
// §3.1). Rendering those two out of prose in the check's detail lines would
// mean parsing them back; the probe says it in a form serve can branch on.
type serverProbe struct {
	// res is herdr's answer. It is populated even when err is
	// ErrProtocolTooOld, which is the whole point: the spec asks for the
	// version actually found to be printed.
	res herdrapi.PingResult
	err error

	// reachable is false ONLY when herdr never answered. A server that replies
	// with an old protocol is reachable and useless, which is a different
	// message to the operator.
	reachable bool
}

// runChecks performs every diagnosis once.
func (d *deps) runChecks(ctx context.Context) (checks []check, probe serverProbe) {
	serverCheck, probe := d.checkServer(ctx)
	return []check{
		serverCheck,
		d.checkServerEnv(ctx),
		d.checkClaudeHook(),
		d.checkCodexHook(),
		d.checkPaneWidth(ctx, probe.reachable),
		d.checkManifestPinned(),
	}, probe
}

func writeChecks(d *deps, checks []check) error {
	fmt.Fprintln(d.Out, "herdr-agent doctor")
	fmt.Fprintln(d.Out)

	counts := map[checkStatus]int{}
	for _, c := range checks {
		counts[c.status]++
		fmt.Fprintf(d.Out, "%-7s  %s\n", c.status, c.name)
		for _, line := range c.detail {
			fmt.Fprintf(d.Out, "         %s\n", line)
		}
		if c.status != checkPass {
			if c.why != "" {
				fmt.Fprintf(d.Out, "         why: %s\n", c.why)
			}
			for _, f := range c.fix {
				fmt.Fprintf(d.Out, "         fix: %s\n", f)
			}
		}
	}

	fmt.Fprintf(d.Out, "\n%d checks: %d PASS, %d WARN, %d UNKNOWN, %d FAIL\n",
		len(checks), counts[checkPass], counts[checkWarn], counts[checkUnknown], counts[checkFail])

	if counts[checkFail] > 0 {
		return fmt.Errorf("%w: %d failed", errChecksFailed, counts[checkFail])
	}
	return nil
}

// checkServer pings herdr and reports the protocol version it actually found.
func (d *deps) checkServer(ctx context.Context) (check, serverProbe) {
	c := check{name: "herdr server + protocol"}
	socket := herdrapi.SocketPathOf(d.Client)
	if socket == "" {
		socket = "(socket path unknown)"
	}

	res, err := herdrapi.CheckProtocol(ctx, d.Client)
	probe := serverProbe{res: res, err: err}

	switch {
	case errors.Is(err, herdrapi.ErrProtocolTooOld):
		probe.reachable = true
		c.status = checkFail
		c.detail = []string{
			fmt.Sprintf("herdr %s at %s speaks protocol %d", orDash(res.Version), socket, res.Protocol),
			fmt.Sprintf("this bridge needs protocol %d or newer", herdrapi.MinProtocol),
		}
		c.why = "the wire types this bridge decodes were measured against protocol " +
			fmt.Sprint(herdrapi.MinProtocol) + "; an older server answers with fields that are not there"
		c.fix = []string{"upgrade herdr, then: " + cleanServerStart}
		return c, probe

	case err != nil:
		c.status = checkFail
		c.detail = []string{fmt.Sprintf("cannot reach herdr at %s", socket), err.Error()}
		c.why = "the bridge never starts or stops herdr; it requires a server that is already running (S1 §2)"
		c.fix = []string{
			cleanServerStart,
			"start it from a CLEAN environment: the server's variables are inherited by every pane it creates (G7)",
		}
		return c, probe

	default:
		probe.reachable = true
		c.status = checkPass
		c.detail = []string{fmt.Sprintf("protocol %d (herdr %s) at %s", res.Protocol, orDash(res.Version), socket)}
		return c, probe
	}
}

// checkServerEnv looks for the variables that turn claude's transcript off.
func (d *deps) checkServerEnv(ctx context.Context) check {
	c := check{
		name: "herdr server environment is clean",
		why: "the server's environment is inherited by every pane it creates; claude that sees a " +
			"CLAUDE_CODE_CHILD_SESSION marker switches transcript saving OFF, which empties the mirror " +
			"with no error anywhere (G7)",
	}
	if d.ServerEnv == nil {
		c.status = checkUnknown
		c.detail = []string{"no way to read process environments on this platform"}
		return c
	}

	procs, err := d.ServerEnv(ctx)
	if err != nil && len(procs) == 0 {
		c.status = checkUnknown
		if errors.Is(err, ErrNoServerProcess) {
			c.detail = []string{fmt.Sprintf("pgrep found no %q process", serverProcessPattern)}
		} else {
			c.detail = []string{err.Error()}
		}
		c.fix = []string{`pgrep -f 'herdr server' | xargs -n1 ps eww | tr ' ' '\n' | grep -E '^(CLAUDECODE|CLAUDE_CODE)'`}
		return c
	}

	var dirty, unreadable int
	for _, p := range procs {
		if !p.Readable {
			unreadable++
			// macOS shows no environment for a process this user may not
			// inspect; ps succeeds and simply prints the command line.
			c.detail = append(c.detail, fmt.Sprintf("pid %d: environment not readable", p.PID))
			continue
		}
		if bad := claudeCodeVars(p.Vars); len(bad) > 0 {
			dirty++
			c.detail = append(c.detail, fmt.Sprintf("pid %d: %s", p.PID, strings.Join(bad, " ")))
			continue
		}
		c.detail = append(c.detail, fmt.Sprintf("pid %d: %d variables, none of them CLAUDE_CODE* or CLAUDECODE", p.PID, len(p.Vars)))
	}
	if err != nil {
		c.detail = append(c.detail, err.Error())
	}

	switch {
	case dirty > 0:
		c.status = checkFail
		c.fix = []string{"pkill -f 'herdr server'", cleanServerStart}
	case unreadable > 0 || err != nil:
		c.status = checkUnknown
		c.fix = []string{`ps eww <pid> | tr ' ' '\n' | grep -E '^(CLAUDECODE|CLAUDE_CODE)'`}
	default:
		c.status = checkPass
	}
	return c
}

func (d *deps) checkClaudeHook() check {
	c := check{
		name: "claude integration installed",
		why: "without the hook herdr never learns claude's session id, so no transcript file can be " +
			"located and the mirror has nothing to follow (G8)",
		fix: []string{"herdr integration install claude"},
	}
	if d.Home == "" {
		// Without a home directory the path below would be RELATIVE, and a
		// stray .claude in whatever directory doctor was run from would be
		// reported as an installed integration. PASS is the one verdict this
		// check must never reach by accident.
		c.status = checkUnknown
		c.detail = []string{"no home directory, so ~/.claude cannot be checked"}
		return c
	}
	path := filepath.Join(d.Home, ".claude", "hooks", "herdr-agent-state.sh")
	if fileExists(path) {
		c.status = checkPass
		c.detail = []string{path}
		return c
	}
	c.status = checkFail
	c.detail = []string{"missing " + path}
	return c
}

func (d *deps) checkCodexHook() check {
	// The trust step cannot be verified from here, so it is stated on PASS too:
	// measured (G8), codex reports no agent_session at all until the hook has
	// been trusted by hand, and it never says so.
	const trustNote = "after installing, press t inside codex once to trust the hook — until you do, " +
		"agent_session stays empty forever and no transcript can be resolved (G8)"
	c := check{
		name: "codex integration installed",
		why:  "without the hook herdr never learns codex's session id (G8)",
	}
	if d.Home == "" {
		// See checkClaudeHook: a relative path would answer a question about
		// the current working directory, not about the integration.
		c.status = checkUnknown
		c.detail = []string{"no home directory, so ~/.codex cannot be checked"}
		c.fix = []string{trustNote}
		return c
	}
	path := filepath.Join(d.Home, ".codex", "hooks.json")
	if fileExists(path) {
		c.status = checkPass
		c.detail = []string{path, "note: " + trustNote}
		return c
	}
	c.status = checkFail
	c.detail = []string{"missing " + path}
	c.fix = []string{"herdr integration install codex", trustNote}
	return c
}

// checkPaneWidth names every agent pane that no terminal client ever attached.
func (d *deps) checkPaneWidth(ctx context.Context, reachable bool) check {
	c := check{
		name: fmt.Sprintf("every agent pane wider than %d columns", screen.NarrowCols),
		why: fmt.Sprintf("a pane no client ever attached is 53x23; Claude's TUI wraps below %d columns, "+
			"herdr's blocked-detection strings then stop matching, and blocked detection fails silently — "+
			"herdr reports idle, with no error anywhere (G5, G11)", screen.NarrowCols),
		fix: []string{
			"open the herdr desktop UI once with a wide window and visit the pane; herdr remembers the last attached geometry even after the client detaches (G5)",
		},
	}
	if !reachable {
		c.status = checkUnknown
		c.detail = []string{"herdr is not answering, so no pane could be measured"}
		return c
	}

	list, err := d.Client.AgentList(ctx)
	if err != nil {
		c.status = checkUnknown
		c.detail = []string{"agent.list: " + err.Error()}
		return c
	}
	if len(list) == 0 {
		c.status = checkPass
		c.detail = []string{"no agents running, nothing to measure"}
		return c
	}
	sort.Slice(list, func(i, j int) bool { return list[i].PaneID < list[j].PaneID })

	var narrow, unread int
	for _, in := range list {
		if in.PaneID == "" {
			continue
		}
		s, err := d.Extractor.Tail(in.PaneID, 0)
		if err != nil {
			unread++
			c.detail = append(c.detail, fmt.Sprintf("%s: could not read the pane: %v", in.PaneID, err))
			continue
		}
		if len(s.Lines) == 0 {
			// Cols is the widest CONTENT line, and screen reports Narrow for
			// Cols == 0 as well. A pane whose visible buffer comes back empty —
			// an agent still launching, a cleared screen, one whose agent just
			// exited — was therefore never measured, and "I could not look" is
			// not a 53-column pane. FAILing here would make doctor exit 1 on a
			// machine that is fine, against S1 §4 item 1.
			unread++
			c.detail = append(c.detail, fmt.Sprintf("%s: pane read returned nothing, width not measurable", in.PaneID))
			continue
		}
		// Screen.Cols is the widest line seen before cropping, which is the only
		// width herdr exposes over the socket; a pane whose content happens to
		// be short reads narrow, so the number is printed rather than just the
		// verdict.
		line := fmt.Sprintf("%s %s: widest visible line %d cols", in.PaneID, orDash(derefStr(in.Agent)), s.Cols)
		if s.Narrow && s.Cols > 0 {
			narrow++
			line += "  <- never attached?"
		}
		c.detail = append(c.detail, line)
	}

	switch {
	case narrow > 0:
		c.status = checkFail
	case unread > 0:
		c.status = checkUnknown
	default:
		c.status = checkPass
	}
	return c
}

// herdrFileConfig is the sliver of herdr's own config.toml this bridge reads.
//
// Both levels are pointers because the advice depends on the difference. A nil
// Update means the file has no [update] table at all, and one can safely be
// appended; a non-nil Update means appending a second table would be a TOML
// error. A nil ManifestCheck inside an existing table distinguishes "not
// written" from "written as true".
type herdrFileConfig struct {
	Update *herdrUpdateConfig `toml:"update"`
}

type herdrUpdateConfig struct {
	ManifestCheck *bool `toml:"manifest_check"`
}

// appendManifestFix creates config.toml, or adds the missing table to one that
// has no [update] at all.
//
// It is offered ONLY in those two cases. TOML forbids a duplicate table:
// appending this to a file that already declares [update] produces
// `Key 'update' has already been defined` from the parser in this repo, and
// herdr's Rust toml crate rejects it identically — so the paste would turn an
// unpinned config into one herdr cannot read at all, which is a worse outcome
// than the warning it was meant to clear (G10).
func appendManifestFix(dir, path string) string {
	return fmt.Sprintf(`mkdir -p %s && printf '[update]\nmanifest_check = false\n' >> %s`,
		shellQuote(dir), shellQuote(path))
}

// editManifestFix is the advice when an [update] table already exists. There is
// no one-liner for it: the value has to go inside the table that is there.
func editManifestFix(path string) string {
	return fmt.Sprintf("edit %s: set manifest_check = false inside the [update] table it already has — "+
		"appending a second [update] table is a TOML error and herdr would then refuse the whole file", shellQuote(path))
}

// checkManifestPinned warns unless herdr's detection manifests are pinned.
func (d *deps) checkManifestPinned() check {
	c := check{
		name: "herdr detection manifests pinned",
		why: "herdr fetches agent-detection manifests from herdr.dev at startup; the strings that decide " +
			"whether an agent is blocked can therefore change with no local change at all, and a missed " +
			"blocked is silent (G10, G11)",
	}
	if d.HerdrConfigDir == "" {
		// A relative "config.toml" would describe whatever directory doctor was
		// started from, which is not the file herdr read.
		c.status = checkUnknown
		c.detail = []string{"neither $XDG_CONFIG_HOME nor a home directory is set, so herdr's config.toml cannot be located"}
		return c
	}
	path := filepath.Join(d.HerdrConfigDir, "config.toml")

	var cfg herdrFileConfig
	_, err := toml.DecodeFile(path, &cfg)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		c.status = checkWarn
		c.detail = []string{"no " + path}
		c.fix = []string{appendManifestFix(d.HerdrConfigDir, path)}
		return c
	case err != nil:
		// No edit is proposed for a file that does not parse: every version of
		// it would be a guess about what the operator meant, and a wrong guess
		// here is a config herdr refuses at startup.
		c.status = checkWarn
		c.detail = []string{fmt.Sprintf("cannot read %s: %v", path, err)}
		c.fix = []string{fmt.Sprintf("repair the TOML syntax of %s first, then set manifest_check = false under [update]",
			shellQuote(path))}
		return c
	case cfg.Update == nil:
		c.status = checkWarn
		c.detail = []string{path + " has no [update] manifest_check"}
		c.fix = []string{appendManifestFix(d.HerdrConfigDir, path)}
		return c
	case cfg.Update.ManifestCheck == nil:
		c.status = checkWarn
		c.detail = []string{path + " has an [update] table but no manifest_check"}
		c.fix = []string{editManifestFix(path)}
		return c
	case *cfg.Update.ManifestCheck:
		c.status = checkWarn
		c.detail = []string{path + " sets [update] manifest_check = true"}
		c.fix = []string{editManifestFix(path)}
		return c
	default:
		c.status = checkPass
		c.detail = []string{path + " sets [update] manifest_check = false"}
		return c
	}
}

// shellQuote makes s safe to paste into a shell. A config directory under a
// path with a space in it is otherwise two arguments, and doctor's fixes exist
// to be copy-pasted.
func shellQuote(s string) string {
	if s != "" && !strings.ContainsFunc(s, shellUnsafe) {
		return s
	}
	// Single quotes, so that a $ or a backslash in the path stays a literal.
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func shellUnsafe(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return false
	}
	return !strings.ContainsRune("_-./:=@%+,", r)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
