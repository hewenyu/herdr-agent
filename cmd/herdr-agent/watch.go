package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
)

// watchTimeFormat is RFC3339 with milliseconds. S1 §4 item 2 budgets 1.5s
// between a Claude permission dialog appearing and this line being printed, so
// the acceptance script needs sub-second resolution to measure it at all.
const watchTimeFormat = "2006-01-02T15:04:05.000Z07:00"

// cmdWatch streams status transitions, one line each.
func cmdWatch(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "watch", "")
	interval := fs.Duration("interval", d.PollInterval, "how often to poll agent.list")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return usagef("watch takes no arguments, got %q", fs.Arg(0))
	}
	if *interval < 0 {
		return usagef("-interval must not be negative, got %s", *interval)
	}

	reg, err := d.NewRegistry(*interval)
	if err != nil {
		return fmt.Errorf("watch: build registry: %w", err)
	}

	// Subscribe before Run so that the very first poll — which reports every
	// agent that is already blocked as a transition out of unknown — is not
	// lost to a race with the goroutine below.
	ch := reg.Subscribe()
	runErr := make(chan error, 1)
	go func() { runErr <- reg.Run(ctx) }()

	fmt.Fprintf(d.Err, "watching herdr every %s · one line per transition · Ctrl-C to stop\n", pollEvery(*interval))
	return streamTransitions(ctx, d, reg, ch, runErr, pollEvery(*interval))
}

func pollEvery(d time.Duration) time.Duration {
	if d <= 0 {
		return agents.DefaultPollInterval
	}
	return d
}

// streamTransitions prints until the registry stops or ctx is cancelled.
func streamTransitions(ctx context.Context, d *deps, reg agents.Registry, ch <-chan agents.Transition, runErr <-chan error, tick time.Duration) error {
	// The degraded flag is polled rather than pushed: the Registry publishes
	// transitions only, and a watch that printed nothing while herdr was down
	// would look exactly like a machine where nothing is happening.
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	degraded := false

	var stopped error
	for {
		select {
		case t, ok := <-ch:
			if !ok {
				if runErr != nil {
					stopped = <-runErr
				}
				return watchExit(ctx, stopped)
			}
			writeTransition(d, t)

		case err := <-runErr:
			stopped = err
			runErr = nil // a nil channel blocks forever, so this case retires
			if err != nil && ctx.Err() == nil {
				// Run failed on its own account (it can only be called once);
				// nothing will close ch, so do not wait for it.
				return fmt.Errorf("watch: registry stopped: %w", err)
			}

		case <-ticker.C:
			if now := reg.Degraded(); now != degraded {
				degraded = now
				if degraded {
					fmt.Fprintf(d.Err, "%s  herdr is not answering — polling every %s until it does\n",
						d.now().Format(watchTimeFormat), agents.DegradedPollInterval)
				} else {
					fmt.Fprintf(d.Err, "%s  herdr is answering again; state reconciled in full\n",
						d.now().Format(watchTimeFormat))
				}
			}
		}
	}
}

func watchExit(ctx context.Context, err error) error {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		// Ctrl-C is how this command is meant to end.
		return nil
	}
	return fmt.Errorf("watch: %w", err)
}

// writeTransition prints one transition. The layout is fixed-field so the
// acceptance script can cut a timestamp out of it.
func writeTransition(d *deps, t agents.Transition) {
	at := t.At
	if at.IsZero() {
		at = d.now()
	}
	fmt.Fprintf(d.Out, "%s  %s %-8s %-10s %s -> %s  seq=%d  %s\n",
		at.Format(watchTimeFormat),
		statusEmoji(t.To),
		orDash(t.Agent.PaneID),
		orDash(t.Agent.Kind),
		orDash(string(t.From)),
		orDash(string(t.To)),
		t.Seq,
		orDash(t.Agent.Title),
	)
}
