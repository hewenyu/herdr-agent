package main

import (
	"context"
	"fmt"

	"github.com/hewenyu/herdr-agent/internal/screen"
)

// cmdDialog prints what the agent is currently asking.
//
// It reads herdr's detection buffer — the same snapshot herdr's own detector
// looked at — so that what this prints and what herdr called `blocked` cannot
// disagree (S1 §3.3).
// The Extractor carries its own context, wired at construction, so the herdr
// deadline still applies (G10).
func cmdDialog(_ context.Context, d *deps, args []string) error {
	fs := newFlags(d, "dialog", "<pane>")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	pane, err := onePane(fs.Args(), "dialog")
	if err != nil {
		return err
	}
	s, err := d.Extractor.Dialog(pane)
	if err != nil {
		return err
	}
	writeScreen(d, pane, "detection", s)
	return nil
}

// cmdTail prints the last lines of the visible viewport.
func cmdTail(_ context.Context, d *deps, args []string) error {
	fs := newFlags(d, "tail", "<pane> [-n 18]")
	n := fs.Int("n", d.tailLines(), "how many non-blank lines to keep (0 = all)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	pane, err := onePane(fs.Args(), "tail")
	if err != nil {
		return err
	}
	if *n < 0 {
		return usagef("-n must not be negative, got %d", *n)
	}
	s, err := d.Extractor.Tail(pane, *n)
	if err != nil {
		return err
	}
	writeScreen(d, pane, "visible", s)
	return nil
}

// writeScreen prints the screen text on stdout and everything else on stderr.
//
// The split is deliberate: S1's acceptance script checks that every line of
// `dialog` fits the phone budget, so a metadata banner on stdout would fail a
// check about the payload it is describing.
func writeScreen(d *deps, pane, source string, s screen.Screen) {
	fmt.Fprintf(d.Err, "pane %s · %s buffer · %d lines · widest line %d cols · viewport %d rows%s\n",
		pane, source, len(s.Lines), s.Cols, s.Rows, croppedNote(s))
	if s.Narrow {
		// G5: a pane no terminal client ever attached to is 53x23. G11: at that
		// width Claude's TUI wraps, herdr's blocked-detection strings stop
		// matching, and it reports idle instead — a silent false negative.
		fmt.Fprintf(d.Err,
			"warning: %s looks never-attached (%d cols). Claude's TUI wraps below %d columns and herdr's blocked detection then degrades silently to idle (G5, G11)\n",
			pane, s.Cols, screen.NarrowCols)
	}
	for _, line := range s.Lines {
		fmt.Fprintln(d.Out, line)
	}
}

func croppedNote(s screen.Screen) string {
	if !s.Cropped {
		return ""
	}
	// Cropped, never wrapped: re-wrapping a 173-column pane would destroy the
	// column alignment a TUI is made of (S1 §3.3).
	return " · cropped"
}

func onePane(args []string, cmd string) (string, error) {
	switch len(args) {
	case 0:
		return "", usagef("%s needs a pane, e.g. herdr-agent %s w1:p1", cmd, cmd)
	case 1:
		if args[0] == "" {
			return "", usagef("%s: empty pane", cmd)
		}
		return args[0], nil
	default:
		return "", usagef("%s takes exactly one pane, got %d arguments", cmd, len(args))
	}
}
