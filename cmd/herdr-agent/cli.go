package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
	"github.com/hewenyu/herdr-agent/internal/setup"
)

// Exit codes are part of this CLI's contract with the S1 acceptance script,
// which has to tell "the agent refused this input" (a pass, item 6) apart from
// "herdr is down" (a failure) without parsing prose.
const (
	exitOK    = 0
	exitFail  = 1
	exitUsage = 2
	// exitUnconfirmed: herdr accepted the text but we could not find it on the
	// agent's screen. agent.prompt's return value only says the bytes reached
	// the PTY queue (G3), so this is NOT success and must not exit 0.
	exitUnconfirmed = 3
	// exitRejected: a guard check refused the input. The keystroke was never
	// sent; the card the human tapped had gone stale (G17).
	exitRejected = 4
)

var (
	// errUnconfirmed is the honest outcome of Delivery{Acked: true, Verified: false}.
	errUnconfirmed = errors.New("prompt sent but NOT confirmed on screen")

	// errUnverified is the honest outcome of setup.OutcomeCredentials. It shares
	// exit code 3 with errUnconfirmed because it is the same kind of answer:
	// something real was produced — here a permanent Feishu app whose
	// credentials are on disk — and it was not proven to work.
	errUnverified = errors.New("app registered but NOT verified end to end")

	// errChecksFailed means doctor printed at least one FAIL.
	errChecksFailed = errors.New("doctor found problems")

	// errUsageShown reports that -h was handled: flag already wrote the usage
	// block, and asking for help is not a failure.
	errUsageShown = errors.New("usage printed")
)

// usageError is a caller mistake: exit 2. An empty msg means flag has already
// written the explanation, so report must not write it twice.
type usageError struct{ msg string }

func (e *usageError) Error() string {
	if e.msg == "" {
		return "invalid arguments"
	}
	return e.msg
}

func usagef(format string, a ...any) error {
	return &usageError{msg: fmt.Sprintf(format, a...)}
}

// ServerEnvFunc reports the environment of the running herdr server processes.
// It is a dependency so doctor can be tested without shelling out.
type ServerEnvFunc func(ctx context.Context) ([]ProcEnv, error)

// deps is everything a subcommand may use. Nothing here reaches for a package
// level singleton, so a test can drive any command with fakes and read its
// output back from a buffer.
type deps struct {
	Client     herdrapi.Client
	Extractor  screen.Extractor
	Controller agents.Controller
	Resolver   agents.TranscriptResolver

	// Cfg is the effective configuration: config.toml with the global flags
	// applied over it. It carries the Feishu credentials, so it is logged only
	// through Redacted() (S2 §3.1).
	Cfg config.Config

	// StateDir is the directory Cfg was read from, and the one serve locks and
	// keeps its stores in. Empty means neither -state-dir nor a home directory
	// was available; every command except serve runs on defaults anyway.
	StateDir string

	// NewRegistry builds the registry `watch` runs. It is a factory and not an
	// instance because Registry.Run may be called exactly once and closes every
	// subscriber channel when it returns.
	NewRegistry func(pollInterval time.Duration) (agents.Registry, error)

	// ServerEnv reads the herdr server's process environment (G7).
	ServerEnv ServerEnvFunc

	// NewSetup builds the onboarding flow. It is a factory because setup.New
	// takes the Progress the command constructs, and a dependency rather than a
	// direct call because the real implementation creates a Feishu app that no
	// API we could find can delete: a deps that nobody wired must refuse to
	// register, not register by default.
	//
	// The options carry the three things only the command line knows: which app
	// to reuse, whether a human may be asked anything, and where the answers come
	// from.
	NewSetup func(stateDir string, p setup.Progress, opts ...setup.Option) (SetupRunner, error)

	// OpenURL hands the confirmation link to the desktop browser. A nil one
	// means this machine has no launcher, and setup then only prints the link —
	// which is also what every test gets, so no test can pop a browser open.
	OpenURL func(url string) error

	// In is where an answer to a setup question is read from, and it is read
	// only when IsTTY agrees there is a human at the other end.
	In io.Reader

	// IsTTY reports whether In is a terminal, and so whether setup's two
	// questions are questions at all. A nil one means "no", which is what every
	// test gets: nothing in a suite is there to answer them.
	IsTTY func() bool

	// Home is the directory the agent integrations install into, and
	// HerdrConfigDir is where herdr keeps config.toml. Both are fields rather
	// than os lookups so doctor can be pointed at a fixture tree.
	Home           string
	HerdrConfigDir string

	PollInterval time.Duration
	TailLines    int

	Now func() time.Time

	// Out carries the payload — screen text, transitions, paths — so it stays
	// pipe-friendly. Err carries metadata, warnings and diagnostics.
	Out io.Writer
	Err io.Writer
}

func (d *deps) now() time.Time {
	if d.Now == nil {
		return time.Now()
	}
	return d.Now()
}

func (d *deps) tailLines() int {
	if d.TailLines <= 0 {
		return defaultTailLines
	}
	return d.TailLines
}

// defaultTailLines matches config.DefaultTailLines. It is duplicated rather
// than imported so that `tail` keeps working when no state directory exists.
const defaultTailLines = 18

// command is one subcommand. The table is the single source of truth for both
// dispatch and help, so a command cannot exist in one and be missing from the
// other.
type command struct {
	name    string
	args    string
	summary string
	run     func(ctx context.Context, d *deps, args []string) error
}

// commandTable is a function rather than a package var: a mutable global would
// let one test's edit leak into another's dispatch.
func commandTable() []command {
	return []command{
		{"doctor", "", "check this machine for the things that silently break the bridge", cmdDoctor},
		{"ls", "", "list every agent herdr can see, with its status", cmdLs},
		{"dialog", "<pane>", "print what the agent is asking (herdr's own detection buffer)", cmdDialog},
		{"tail", "<pane> [-n 18]", "print the last lines of the visible viewport", cmdTail},
		{"key", "<pane> <key>", "answer a menu through the full guard check", cmdKey},
		{"say", "<pane> <text...>", "send prose through the safe path (esc first if blocked)", cmdSay},
		{"transcript", "<pane>", "print the agent's native transcript file path", cmdTranscript},
		{"watch", "", "stream status transitions, one timestamped line each", cmdWatch},
		{"serve", "", "run the Feishu bridge until SIGINT or SIGTERM", cmdServe},
		// "or reuse one" is in the summary because the run that motivated these
		// flags had an app already and was offered only two ways forward: move a
		// file, or make a second permanent app. Reuse is the third, and it is the
		// one most people want.
		{"setup", "[--app <id>|--reregister]", "register a Feishu app, or reuse one you have, and prove it works", cmdSetup},
		{"help", "", "show this help", cmdHelp},
	}
}

func dispatch(ctx context.Context, d *deps, argv []string) error {
	if len(argv) == 0 {
		return usagef("no command given")
	}
	name := argv[0]
	if name == "-h" || name == "--help" {
		name = "help"
	}
	for _, c := range commandTable() {
		if c.name == name {
			return c.run(ctx, d, argv[1:])
		}
	}
	return usagef("unknown command %q", name)
}

func cmdHelp(_ context.Context, d *deps, _ []string) error {
	writeUsage(d.Out)
	return nil
}

func writeUsage(w io.Writer) {
	fmt.Fprint(w, `herdr-agent — safe control surface for herdr coding agents

usage: herdr-agent [global flags] <command> [flags] [args]

commands:
`)
	for _, c := range commandTable() {
		name := c.name
		if c.args != "" {
			name += " " + c.args
		}
		fmt.Fprintf(w, "  %-32s %s\n", name, c.summary)
	}
	// setup is the only command with modes rather than options, and it is the
	// first one anybody runs. Listing them here costs four lines and is the
	// difference between "reuse the app I already have" being discoverable and
	// being a flag nobody finds.
	fmt.Fprint(w, "\nsetup modes (all optional, and the first run needs none of them):\n")
	for _, m := range []struct{ flag, when string }{
		{"(no flags)", "confirm one page: create a new app there, or pick an app you already have"},
		{"--app <app_id>", "use THAT app — preferred, because every registration is permanent clutter"},
		{"--reregister", "create a SECOND app on purpose; the first one stays, no API deletes it"},
		{"--yes", "never prompt (scripts, launchd): two apps is an error, an expired wait is exit 3"},
	} {
		fmt.Fprintf(w, "  %-32s %s\n", m.flag, m.when)
	}
	fmt.Fprint(w, `
global flags (before the command):
  -socket <path>      herdr API socket (default: $HERDR_SOCKET_PATH, else ~/.config/herdr/herdr.sock)
  -timeout <dur>      per-call herdr deadline (default 10s; herdr has no server-side timeout)
  -max-cols <n>       crop screen output to n columns (default 56; lines are cropped, never wrapped)
  -state-dir <path>   bridge state directory holding config.toml (default ~/.herdr-agent)

exit codes:
  0 ok   1 failure   2 usage   4 input rejected by a guard
  3 something real happened but was NOT proven: prose that herdr accepted and the screen
    never showed (say), or an app that was registered and not verified end to end (setup)
`)
}

// newFlags builds a subcommand flag set that reports to stderr and never calls
// os.Exit, so the whole CLI stays testable in-process.
func newFlags(d *deps, name, args string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(d.Err)
	fs.Usage = func() {
		usage := "usage: herdr-agent " + name
		if args != "" {
			usage += " " + args
		}
		fmt.Fprintln(d.Err, usage)
		fs.PrintDefaults()
	}
	return fs
}

// permute moves flags ahead of positional arguments.
//
// The stdlib flag package stops parsing at the first non-flag argument, so
// "tail w1:p1 -n 20" leaves "-n 20" as positionals and the command rejects its
// own documented usage ("tail <pane> [-n 18]"). Every subcommand here takes its
// target first, so accepting trailing flags is the only reading that matches
// what the help text promises.
//
// A "--" terminator is honoured: everything after it stays positional, which is
// what lets `say <pane> -- -n is not a flag` work.
func permute(fs *flag.FlagSet, args []string) []string {
	var flags, rest []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			// Everything after "--" is positional, and so is everything already
			// collected in rest — dropping it here would silently retarget the
			// command at the first word after the terminator.
			rest = append(rest, args[i+1:]...)
			i = len(args)
		case len(a) > 1 && a[0] == '-':
			flags = append(flags, a)
			name := strings.TrimLeft(a, "-")
			if strings.Contains(name, "=") {
				continue // -n=20 carries its own value
			}
			f := fs.Lookup(name)
			if f == nil {
				continue // unknown: let Parse produce the real diagnostic
			}
			if b, ok := f.Value.(interface{ IsBoolFlag() bool }); ok && b.IsBoolFlag() {
				continue
			}
			if i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
		default:
			rest = append(rest, a)
		}
	}
	if len(rest) == 0 {
		return flags
	}
	// "--" keeps a positional that begins with '-' from being re-read as a flag.
	return append(flags, append([]string{"--"}, rest...)...)
}

// parseFlags translates flag's own outcomes into CLI outcomes: -h is a
// successful request for usage, anything else is a usage error whose message
// flag has already printed.
func parseFlags(fs *flag.FlagSet, args []string) error {
	err := fs.Parse(permute(fs, args))
	switch {
	case err == nil:
		return nil
	case errors.Is(err, flag.ErrHelp):
		return errUsageShown
	default:
		return &usageError{}
	}
}

// report writes err and maps it to an exit code.
func report(w io.Writer, err error) int {
	if err == nil || errors.Is(err, errUsageShown) {
		return exitOK
	}
	var ue *usageError
	if errors.As(err, &ue) {
		if ue.msg != "" {
			fmt.Fprintf(w, "herdr-agent: %s\n", ue.msg)
			fmt.Fprintln(w, `run "herdr-agent help" for usage`)
		}
		return exitUsage
	}
	fmt.Fprintf(w, "herdr-agent: %v\n", err)
	switch {
	case errors.Is(err, errUnconfirmed), errors.Is(err, errUnverified):
		return exitUnconfirmed
	case isGuardRejection(err):
		return exitRejected
	default:
		return exitFail
	}
}

// isGuardRejection reports whether err is the input protocol refusing to act.
// These are not faults: they are the protocol doing its job, and the caller
// needs to distinguish them from a broken herdr (S1 §4 item 6).
func isGuardRejection(err error) bool {
	for _, target := range []error{
		agents.ErrPaneGone,
		agents.ErrAgentReplaced,
		agents.ErrGuardStale,
		agents.ErrNoLongerBlocked,
		agents.ErrAgentBusy,
		agents.ErrCannotUnblock,
		agents.ErrKeyNotAllowed,
	} {
		if errors.Is(err, target) {
			return true
		}
	}
	return false
}

// statusOf maps herdr's agent_status string onto a Status.
//
// An unrecognised value becomes unknown and never idle: herdr already reports
// idle when its blocked-detection regexes fail to match, which is a silent
// false negative (G11), and guessing idle here would compound it.
func statusOf(raw string) agents.Status {
	switch s := agents.Status(raw); s {
	case agents.StatusIdle, agents.StatusWorking, agents.StatusBlocked, agents.StatusDone:
		return s
	default:
		return agents.StatusUnknown
	}
}

// statusEmoji is the ls/watch glyph for a status. All of them are two cells
// wide so the column after them lines up.
func statusEmoji(s agents.Status) string {
	switch s {
	case agents.StatusBlocked:
		return "🛑"
	case agents.StatusWorking:
		return "⚙️"
	case agents.StatusDone:
		return "✅"
	case agents.StatusIdle:
		return "💤"
	case agents.StatusGone:
		return "👻"
	default:
		return "❓"
	}
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
