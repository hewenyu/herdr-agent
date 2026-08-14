// Command herdr-agent is the control surface for herdr coding agents, and the
// independent acceptance surface for S1.
//
// Everything the bridge will later do from Feishu is reachable here first:
// list agents, read what one is asking, answer a menu, send prose, follow the
// state transitions. Input always travels through internal/agents, never
// straight to the socket, because prose delivered to a blocked agent is an
// approval (G1) and a keystroke delivered against a stale decision is a command
// execution (G17).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/screen"
)

func main() { os.Exit(cli()) }

// cli is main with a return value, so the deferred signal cleanup actually runs.
func cli() int {
	// SIGINT is the documented way to end `watch`, so it cancels the context
	// rather than killing the process: an in-flight agent.prompt gets to fail
	// and be reported instead of vanishing.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return run(ctx, os.Args[1:], os.Stdout, os.Stderr)
}

// wireOptions are the global flags, all of them overrides for config.toml.
type wireOptions struct {
	socket   string
	timeout  time.Duration
	maxCols  int
	stateDir string
}

func run(ctx context.Context, argv []string, out, errw io.Writer) int {
	gf := flag.NewFlagSet("herdr-agent", flag.ContinueOnError)
	gf.SetOutput(errw)
	gf.Usage = func() { writeUsage(errw) }

	var o wireOptions
	gf.StringVar(&o.socket, "socket", "", "herdr API socket path (overrides config.toml and $HERDR_SOCKET_PATH)")
	gf.DurationVar(&o.timeout, "timeout", 0, "per-call herdr deadline (herdr has none of its own)")
	gf.IntVar(&o.maxCols, "max-cols", 0, "crop screen output to this many columns")
	gf.StringVar(&o.stateDir, "state-dir", "", "bridge state directory holding config.toml")

	if err := gf.Parse(argv); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return exitOK
		}
		return exitUsage
	}
	args := gf.Args()
	if len(args) == 0 {
		writeUsage(errw)
		return exitUsage
	}
	// help is answered before anything is wired: a machine with no home
	// directory, no config and no herdr must still be able to read it.
	if args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		writeUsage(out)
		return exitOK
	}

	d, closeDeps, err := wire(ctx, o, out, errw)
	if err != nil {
		fmt.Fprintf(errw, "herdr-agent: %v\n", err)
		return exitFail
	}
	defer closeDeps()

	return report(errw, dispatch(ctx, d, args))
}

// wire builds the real implementations. It performs no IO against herdr: the
// server may legitimately start after us, and every call dials on its own.
func wire(ctx context.Context, o wireOptions, out, errw io.Writer) (*deps, func(), error) {
	stateDir := resolveStateDir(o.stateDir)
	cfg, err := loadConfig(stateDir)
	if err != nil {
		return nil, nil, err
	}
	// The global flags are folded into the configuration rather than carried
	// alongside it, so that everything downstream — including serve, which
	// re-reads the whole Config — sees one effective value per knob.
	cfg.Herdr.SocketPath = firstNonEmpty(o.socket, cfg.Herdr.SocketPath)
	if o.timeout > 0 {
		cfg.Herdr.CallTimeout = o.timeout
	}
	if o.maxCols > 0 {
		cfg.UI.MaxCols = o.maxCols
	}

	client, err := herdrapi.New(herdrapi.Options{
		SocketPath: cfg.Herdr.SocketPath,
		Timeout:    cfg.Herdr.CallTimeout,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("herdr client: %w", err)
	}
	closeDeps := func() { _ = client.Close() }

	extractor, err := screen.NewExtractor(client, screen.WithMaxCols(cfg.UI.MaxCols), screen.WithContext(ctx))
	if err != nil {
		closeDeps()
		return nil, nil, fmt.Errorf("screen extractor: %w", err)
	}
	controller, err := agents.NewController(client)
	if err != nil {
		closeDeps()
		return nil, nil, fmt.Errorf("agent controller: %w", err)
	}

	// A missing home directory disables exactly two things — transcript
	// resolution and the hook checks — so it is not allowed to stop `ls` or
	// `key` from working.
	home, _ := os.UserHomeDir()
	resolver, err := agents.NewTranscriptResolver()
	if err != nil {
		resolver = nil
	}

	d := &deps{
		Client:     client,
		Extractor:  extractor,
		Controller: controller,
		Resolver:   resolver,
		Cfg:        cfg,
		StateDir:   stateDir,
		NewRegistry: func(pollInterval time.Duration) (agents.Registry, error) {
			return agents.NewRegistry(client, agents.WithPollInterval(pollInterval))
		},
		ServerEnv:      lookupServerEnv,
		Home:           home,
		HerdrConfigDir: herdrConfigDir(),
		PollInterval:   cfg.Herdr.PollInterval,
		TailLines:      cfg.UI.TailLines,
		Now:            time.Now,
		Out:            out,
		Err:            errw,
	}
	return d, closeDeps, nil
}

// resolveStateDir is the directory holding config.toml, .env and everything
// serve locks and persists. An empty result means there is no home directory
// and none was given; only serve treats that as fatal.
func resolveStateDir(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	dir, err := config.DefaultDir()
	if err != nil {
		return ""
	}
	return dir
}

// loadConfig reads the bridge's own config.toml for the herdr and UI knobs.
//
// Validate is deliberately not called here: it insists on Feishu credentials
// and a non-empty open_id allowlist, and everything except serve runs without
// either. Requiring them would make `doctor` — the tool you reach for when the
// bridge will not start — refuse to run for the same reason the bridge did not.
// serve calls Validate itself.
func loadConfig(dir string) (config.Config, error) {
	if dir == "" {
		// No home directory and no -state-dir: defaults plus the global flags
		// are enough for every command that does not persist anything.
		return config.Default(), nil
	}
	cfg, err := config.Load(dir)
	if err != nil {
		return config.Config{}, fmt.Errorf("load %s: %w", filepath.Join(dir, config.ConfigFileName), err)
	}
	return cfg, nil
}

// herdrConfigDir mirrors how herdr itself picks its config directory, so
// doctor inspects the file the server actually read.
func herdrConfigDir() string {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "herdr")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "herdr")
}
