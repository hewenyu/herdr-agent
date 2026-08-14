package main

import (
	"context"
	"flag"
	"fmt"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// cmdKey answers a menu.
//
// Everything goes through agents.Controller, never through the herdr client
// directly, so the four guard checks of S1 §3.4.1 run on every keystroke. A key
// that reaches a pane which has moved on is a command execution (G16, G17).
func cmdKey(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "key", "<pane> <key>")
	age := guardFlags(fs)
	// -seq belongs to `key` alone: SendKey is the only entry point that
	// compares it (Controller.SendKey validates with requireBlocked, Say does
	// not), so offering it on `say` would be a safety-flavoured flag that pins
	// nothing.
	seq := fs.Uint64("seq", 0, "state_change_seq the decision was made against (default: the agent's current seq)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return usagef("key needs a pane and a key, e.g. herdr-agent key w1:p1 1 (allowed: %s)",
			strings.Join(agents.AllowedKeys, " "))
	}
	target, key := fs.Arg(0), fs.Arg(1)

	g, before, err := d.resolveGuard(ctx, target, fs, seq, *age)
	if err != nil {
		return err
	}

	after, err := d.Controller.SendKey(ctx, g, key)
	if err != nil {
		// The fresh state is worth printing even on refusal: it is the answer to
		// "why not", and for a stale card it is what the agent is doing instead.
		fmt.Fprintf(d.Err, "agent now: %s status=%s seq=%d\n", after.PaneID, after.Status, after.StateSeq)
		return err
	}
	// The observed seq is printed, not the guard's: with -seq they differ, and
	// the interesting number is what the agent actually moved from.
	fmt.Fprintf(d.Out, "%s %s: key %q delivered · status %s -> %s · seq %d -> %d\n",
		g.PaneID, orDash(g.Kind), key, statusOf(before.AgentStatus), after.Status,
		before.StateChangeSeq, after.StateSeq)
	return nil
}

// cmdSay sends prose down the safe path.
//
// The controller escapes a blocked agent first and re-checks that it left the
// dialog before any text is submitted. Sending prose to a blocked agent without
// that is an approval, whatever the words say: agent.prompt pastes the text,
// which a menu discards, and then presses Enter on the highlighted default (G1).
func cmdSay(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "say", "<pane> <text...>")
	age := guardFlags(fs)
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() < 2 {
		return usagef("say needs a pane and some text, e.g. herdr-agent say w1:p1 run the tests")
	}
	target := fs.Arg(0)
	text := strings.Join(fs.Args()[1:], " ")
	if strings.TrimSpace(text) == "" {
		return usagef("say: refusing to send an empty message")
	}

	g, _, err := d.resolveGuard(ctx, target, fs, nil, *age)
	if err != nil {
		return err
	}

	del, sayErr := d.Controller.Say(ctx, g, text)
	writeDelivery(d, g.PaneID, del, sayErr)
	if sayErr != nil {
		return sayErr
	}
	if del.Acked && !del.Verified {
		// G3: agent.prompt's success only means the bytes reached the PTY queue.
		// G4: and the read-back cannot trust the input box either, because
		// Claude renders ghost completions there that were never sent. Reporting
		// this as success would lose the user's message silently.
		return errUnconfirmed
	}
	if !del.Acked {
		return fmt.Errorf("say %s: herdr never acknowledged the prompt after %d attempts", g.PaneID, del.Attempts)
	}
	return nil
}

// writeDelivery prints the Delivery verdict, always, error or not.
func writeDelivery(d *deps, pane string, del agents.Delivery, err error) {
	verdict := "NOT delivered"
	switch {
	case del.Acked && del.Verified:
		verdict = "delivered and confirmed on screen"
	case del.Acked:
		verdict = "sent but NOT confirmed"
	}
	if del.Escaped {
		// The user typed prose and also, without asking for it, dismissed a
		// dialog the agent was waiting on. Reporting only the delivery would
		// hide a side effect they are accountable for (G1, G2).
		fmt.Fprintf(d.Out,
			"%s was blocked: esc was sent first, cancelling the pending question instead of answering it.\n",
			pane)
	}
	fmt.Fprintf(d.Out, "%s: %s (acked=%t verified=%t attempts=%d final=%s)\n",
		pane, verdict, del.Acked, del.Verified, del.Attempts, orDash(string(del.FinalStatus)))
	if del.Acked && !del.Verified && err == nil {
		// Name the region that was actually searched. Verification is asymmetric:
		// a settled agent has consumed its input box, so a match there is a ghost
		// completion and only text OUTSIDE counts (G4); a working agent has not
		// consumed it yet, so the pending text INSIDE is the only evidence there
		// is (G19). Printing the settled wording for a queued delivery sends the
		// reader to look in the wrong half of the screen.
		region := "outside the input box"
		if del.Queued {
			region = "in its input box, where a queued message waits"
		}
		fmt.Fprintf(d.Err,
			"herdr accepted the text but it could not be found on %s %s, so delivery is unproven (G3, G4). Look at the pane before sending it again — a resend says the same thing twice.\n",
			pane, region)
	}
	if del.MayHaveAnsweredADialog {
		// The one thing worse than an unconfirmed send: a send that may have
		// answered a question the user never saw (G1).
		fmt.Fprintf(d.Err,
			"%s is now BLOCKED. Your text went in while it was working, and herdr's trailing Enter may have answered a permission dialog that came up in between — check the pane before assuming your message was read as text.\n",
			pane)
	}
}

// guardFlags registers the knob every guarded command shares: -age backdates
// the decision, which is how the acceptance script reaches MaxGuardAge without
// waiting ten minutes.
//
// -seq is NOT here. It is registered by `key` alone, because only SendKey
// compares StateSeq (S1 §3.4.1 check 4, the stale-card guard from G17); Say
// validates with requireBlocked false and never looks at it, so a -seq on `say`
// would read as "pinned to the state I saw" while pinning nothing.
func guardFlags(fs *flag.FlagSet) (age *time.Duration) {
	return fs.Duration("age", 0, "pretend the decision was made this long ago, to test guard expiry")
}

// resolveGuard pins a guard to the agent as it is right now.
//
// The guard carries the canonical pane_id from agent.list/agent.get, never the
// token the user typed: herdr resolves "1", "w1-1" and an agent NAME to the same
// pane, but the controller compares the pane it read back against the pane in
// the guard, and a mismatch is treated as the pane being gone.
//
// seq is nil for callers that do not offer -seq; the guard then always carries
// the agent's current state_change_seq.
func (d *deps) resolveGuard(ctx context.Context, target string, fs *flag.FlagSet, seq *uint64, age time.Duration) (agents.Guard, herdrapi.AgentInfo, error) {
	info, err := d.Client.AgentGet(ctx, target)
	if err != nil {
		return agents.Guard{}, info, fmt.Errorf("agent.get %s: %w", target, err)
	}
	if info.PaneID == "" {
		return agents.Guard{}, info, fmt.Errorf("%w: herdr returned no pane id for %q", agents.ErrPaneGone, target)
	}
	g := agents.Guard{
		PaneID:   info.PaneID,
		Kind:     derefStr(info.Agent),
		StateSeq: info.StateChangeSeq,
		IssuedAt: d.now().Add(-age),
	}
	// A seq of 0 is legitimate — herdr's counter is server-global and restarts
	// at 0 — so an explicit -seq 0 must override, and an absent flag must not.
	if seq != nil && flagSet(fs, "seq") {
		g.StateSeq = *seq
	}
	return g, info, nil
}

func flagSet(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}
