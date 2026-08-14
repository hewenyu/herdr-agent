package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/setup"
)

// SetupRunner is the part of *setup.Runner this command drives.
//
// It is an interface for one reason: the real implementation registers an app
// in the user's Feishu tenant, and no API was found that deletes one. A test
// that accidentally ran it would leave permanent clutter behind, so the CLI
// never reaches for the concrete type — deps.NewSetup supplies it, and a deps
// that was never wired makes `setup` refuse rather than register.
type SetupRunner interface {
	Run(ctx context.Context, reregister bool) (setup.Result, error)
}

// cmdSetup registers a Feishu app and proves it works.
//
// The body is thin on purpose: internal/setup owns the flow, and everything
// this file adds is presentation — the link, the two waits, the checklist, and
// the exit code that says how far the round trip actually got.
func cmdSetup(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "setup", "[--reregister]")
	reregister := fs.Bool("reregister", false,
		"create a SECOND app even though credentials already exist (the first one stays: no API deletes it)")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return usagef("setup takes no arguments, got %q", fs.Arg(0))
	}
	if d.StateDir == "" {
		// Without it setup would have nowhere to put the credentials the bridge
		// reads, and the run would end with a working app nobody can find.
		return fmt.Errorf("setup: no state directory: pass -state-dir, or set HOME so that ~/%s can be found",
			config.StateDir)
	}
	if d.NewSetup == nil {
		return errors.New("setup: no setup runner was wired")
	}

	p := &termProgress{
		out:     d.Out,
		err:     d.Err,
		envPath: filepath.Join(d.StateDir, config.DotEnvFileName),
		cfgPath: filepath.Join(d.StateDir, config.ConfigFileName),
		open:    d.OpenURL,
	}
	r, err := d.NewSetup(d.StateDir, p)
	if err != nil {
		return err
	}

	res, err := r.Run(ctx, *reregister)
	// Written before the error is returned. A run can fail AFTER the app was
	// created — the one measured way is a .env that could not be written — and
	// the id of a permanent app the user now owns is the last thing to swallow.
	writeIdentities(d, res)
	if err != nil {
		return err
	}
	return writeOutcome(d, res)
}

// writeIdentities puts what the run produced on stdout, one `key<TAB>value` per
// line, and nothing else. The narration is on stderr, so `herdr-agent setup >
// ids.txt` still shows the human the link they have to open.
func writeIdentities(d *deps, res setup.Result) {
	for _, kv := range []struct{ key, value string }{
		{"app_id", res.AppID},
		{"open_id", res.OpenID},
		{"chat_id", res.ChatID},
	} {
		if kv.value != "" {
			fmt.Fprintf(d.Out, "%s\t%s\n", kv.key, kv.value)
		}
	}
}

// writeOutcome reports how far the round trip got and returns the error that
// decides the exit code.
//
// The three outcomes are three different states of the world, and collapsing
// any two of them would be a lie: verified means a real message and a real
// button press were observed; credentials-only means the user owns a permanent
// app and a checklist; failed means nothing usable exists.
func writeOutcome(d *deps, res setup.Result) error {
	// Exit 0 is the sentence that tells the user to stop testing, so it is
	// printed from the two observations rather than from the label summarising
	// them. A Result that says Verified while one of them is false is a
	// contradiction, and the CLI is the last place that can refuse to report a
	// success it cannot substantiate.
	outcome := res.Outcome
	if outcome == setup.OutcomeVerified && (!res.InboundOK || !res.CardOK) {
		outcome = setup.OutcomeCredentials
	}

	switch outcome {
	case setup.OutcomeVerified:
		fmt.Fprintln(d.Err)
		fmt.Fprintln(d.Err, "  ✓ Verified end to end: your message reached the bridge and the card button came back.")
		fmt.Fprintln(d.Err, "    Nothing is left to do in the Feishu console.")
		if len(res.Steps) > 0 {
			// Reachable while verified: the round trip proves the app, and a
			// config.toml this command could not rewrite safely is a separate
			// problem that still needs a pair of hands.
			fmt.Fprintln(d.Err, "    Something on this machine could not be written for you, though:")
			writeSteps(d.Err, res.Steps)
		}
		fmt.Fprintln(d.Err, "    Next: `herdr-agent serve`, or deploy/install.sh to run it under launchd.")
		return nil

	case setup.OutcomeCredentials:
		fmt.Fprintln(d.Err)
		fmt.Fprintf(d.Err, "  ! App %s exists and its credentials are on disk, but the round trip is not proven.\n",
			orDash(res.AppID))
		switch {
		case !res.InboundOK:
			fmt.Fprintln(d.Err, "    No message from you arrived, so nothing downstream of it is proven either.")
		case !res.CardOK:
			// A3 is ambiguous by measurement and must stay ambiguous here: the
			// probe could not tell an un-pressed button from a 交互卡片
			// capability that needs a manual toggle, and picking one would send
			// half of all readers to fix something that is not broken.
			fmt.Fprintln(d.Err, "    Your message arrived — credentials, bot, event subscription, delivery mode,")
			fmt.Fprintln(d.Err, "    publication, scopes and the allowlist are all confirmed by that one message.")
			fmt.Fprintln(d.Err, "    The card button did not come back. An un-pressed button and a disabled 交互卡片")
			if len(res.Steps) > 0 {
				fmt.Fprintln(d.Err, "    capability look identical from here, so the step below covers both.")
			} else {
				fmt.Fprintln(d.Err, "    capability look identical from here.")
			}
		}
		// A run can end here with nothing to do: a Ctrl-C during either wait
		// cancels the context, which produces no step at all. Promising a list
		// and then printing a blank line sends the reader looking for output
		// that was never written.
		if len(res.Steps) > 0 {
			fmt.Fprintln(d.Err, "    Do these, then run `herdr-agent setup` again: with credentials on disk it skips")
			fmt.Fprintln(d.Err, "    registration and re-runs the verification only.")
			writeSteps(d.Err, res.Steps)
		} else {
			fmt.Fprintln(d.Err, "    Run `herdr-agent setup` again: with credentials on disk it skips registration and")
			fmt.Fprintln(d.Err, "    re-runs the verification only.")
		}
		return fmt.Errorf("setup: %w", errUnverified)

	default:
		writeSteps(d.Err, res.Steps)
		return errors.New("setup: nothing usable was produced")
	}
}

// writeSteps prints the remaining manual actions as a numbered checklist.
//
// Each one names a page and carries its URL, because that is the whole promise
// of this command: the two or three things it cannot do for you are each one
// click away, rather than "configure the app".
func writeSteps(w io.Writer, steps []setup.Step) {
	for i, s := range steps {
		fmt.Fprintf(w, "\n   %d. %s\n", i+1, s.What)
		if s.Why != "" {
			fmt.Fprintf(w, "      why: %s\n", s.Why)
		}
		if s.URL != "" {
			fmt.Fprintf(w, "      url: %s\n", s.URL)
		}
	}
	if len(steps) > 0 {
		fmt.Fprintln(w)
	}
}

// termProgress renders setup.Progress for a person at a terminal.
//
// Everything it writes goes to stderr: the payload of this command is the app
// it produced, and a user who redirects stdout must still see the link they
// have to open within ten minutes.
//
// It holds no lock. The reporter inside internal/setup serialises every
// callback, which is the only reason that is safe.
type termProgress struct {
	out io.Writer
	err io.Writer

	// envPath is where the secret was written. The path and the mode are
	// printed; the contents never are, not even a prefix or a length.
	envPath string

	// cfgPath is the file whose allowed_open_ids decides who may drive the
	// agents. Named rather than described, because the one thing a reader may
	// have to edit by hand is the one thing they must be able to find.
	cfgPath string

	// open hands the confirmation link to the desktop browser. A field so no
	// test spawns a process, and nil-safe: a machine with no launcher simply
	// prints the link.
	open func(url string) error
}

var _ setup.Progress = (*termProgress)(nil)

// Verification hands over the confirmation link.
//
// It also states, BEFORE the irreversible click rather than after it, that this
// creates a real app: no API was found that deletes one, so a user who did not
// want a second app needs to know that here.
func (p *termProgress) Verification(url string, expiresIn int) {
	fmt.Fprintln(p.err)
	fmt.Fprintln(p.err, "  Open this link and press 确认:")
	fmt.Fprintln(p.err)
	fmt.Fprintln(p.err, "      "+url)
	fmt.Fprintln(p.err)
	if p.open != nil {
		if err := p.open(url); err == nil {
			fmt.Fprintln(p.err, "  (opened in your browser)")
		} else {
			fmt.Fprintf(p.err, "  (could not open a browser here: %v — copy the link above)\n", err)
		}
	}
	if expiresIn > 0 {
		fmt.Fprintf(p.err, "  The link expires in %ds.\n", expiresIn)
	}
	// One line, because it is read while a stranger's URL is on screen: what the
	// page asks for, and why there is nothing to do afterwards.
	fmt.Fprintf(p.err, "  It asks to create an app named herdr-agent and to grant %s, the event %s and the "+
		"callback %s — pressing 确认 GRANTS them and publishes a version, which is why no console visit follows.\n",
		strings.Join(setup.Scopes, ", "), strings.Join(setup.Events, ", "), strings.Join(setup.Callbacks, ", "))
	fmt.Fprintln(p.err, "  This creates a real app in your tenant. No API we could find deletes one, so treat it as permanent.")
}

// Registered fires once the credentials are on disk.
//
// It names the authorization boundary without claiming a state it cannot
// observe. This callback carries no signal about the allowlist write, which
// happened a moment earlier and can fail (an unwritable config.toml, or a
// multi-line allowed_open_ids that is refused rather than guessed at) — and on
// the --reregister path the write APPENDS, so the id it reports is not
// necessarily the only one listed. Both outcomes reach the user through the
// numbered checklist and the note above; this line only says where to look.
func (p *termProgress) Registered(appID, openID string) {
	fmt.Fprintln(p.err)
	fmt.Fprintf(p.err, "  ✓ App %s created.\n", appID)
	fmt.Fprintf(p.err, "    Its secret was written to %s, mode 0600, and is printed nowhere:\n", p.envPath)
	fmt.Fprintln(p.err, "    not here, not in a log, not as a prefix and not as a length.")
	if openID != "" {
		fmt.Fprintf(p.err, "    Your open_id is %s. Only ids listed in feishu.allowed_open_ids in %s may drive your\n"+
			"    agents; if a line above says that file could not be written, the numbered checklist at the\n"+
			"    end has the exact edit.\n", openID, p.cfgPath)
	}
}

// AwaitInbound asks for the message that proves the whole chain at once.
//
// "herdr-agent" is only the DEFAULT name: the confirmation page lets the human
// rename the app before pressing 确认, and on the repair path the app is
// whatever it was called when it was created. Someone searching Feishu for a
// bot that does not exist, against a countdown, has no way to recover.
func (p *termProgress) AwaitInbound(d time.Duration) {
	fmt.Fprintln(p.err)
	fmt.Fprintf(p.err, "  → Message the bot in Feishu now: open a DIRECT chat with the app you just confirmed\n"+
		"    (named herdr-agent unless you changed the name on that page) and send it any text.\n"+
		"    Waiting %ds. That one message proves the credentials, the bot, the event subscription,\n"+
		"    the delivery mode, the published version, the scopes and the allowlist.\n",
		seconds(d))
}

// AwaitCard asks for the button press.
func (p *termProgress) AwaitCard(d time.Duration) {
	fmt.Fprintln(p.err)
	fmt.Fprintf(p.err, "  → Press the button on the card the bot just sent you, in Feishu. Waiting %ds.\n", seconds(d))
}

// Note is an intermediate observation. Indented under the step it belongs to,
// so the two lines that ask the human for something stay findable.
func (p *termProgress) Note(msg string) {
	fmt.Fprintf(p.err, "    %s\n", msg)
}

// seconds renders a wait the way the human will count it. Rounding down would
// promise less time than there is; up is the honest direction for a deadline.
func seconds(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	return int((d + time.Second - 1) / time.Second)
}

// openTimeout bounds the launcher. open(1) returns immediately in practice; a
// hang here would freeze a command whose next act is to wait on a human.
const openTimeout = 5 * time.Second

// openInBrowser hands the confirmation link to the desktop browser.
//
// darwin only: open(1) is the launcher this product's supported platform has,
// and guessing at xdg-open elsewhere would print "(opened in your browser)" on
// a machine where nothing opened.
//
// The URL is checked rather than trusted. It arrives from the network, it is
// passed to a program as an argument, and a value starting with '-' would be
// read by open(1) as a flag; anything that is not plain https is refused and
// printed instead.
func openInBrowser(url string) error {
	if runtime.GOOS != "darwin" {
		return fmt.Errorf("no launcher for %s", runtime.GOOS)
	}
	if !strings.HasPrefix(url, "https://") {
		return errors.New("refusing to open a link that is not https")
	}
	ctx, cancel := context.WithTimeout(context.Background(), openTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "open", url).CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return fmt.Errorf("open: %w: %s", err, oneLine(msg))
		}
		return fmt.Errorf("open: %w", err)
	}
	return nil
}
