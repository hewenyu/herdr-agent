package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"regexp"
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

// appIDShape is the shape internal/config enforces on FEISHU_APP_ID, and which
// internal/setup re-checks before an id can reach a URL.
//
// Checked a third time here for two reasons that only apply at the command line:
// a malformed --app is a CALLER mistake, which is exit 2 rather than exit 1, and
// this is the earliest point at which a secret pasted into the wrong field can be
// refused — the console lists App ID directly above App Secret, and the run that
// motivated this feature was a human copying values between the two.
var appIDShape = regexp.MustCompile(`^cli_[A-Za-z0-9]+$`)

// cmdSetup registers a Feishu app, or reuses one, and proves it works.
//
// The body is thin on purpose: internal/setup owns the flow, and everything
// this file adds is presentation — the link, the two waits, the questions, the
// checklist, and the exit code that says how far the round trip actually got.
func cmdSetup(ctx context.Context, d *deps, args []string) error {
	f, err := parseSetupFlags(d, args)
	if err != nil {
		return err
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
	plan := setupPlanFor(d, f)
	if plan.why != "" {
		// Said BEFORE the flow starts. A reader who was not told that nothing will
		// be asked reads the resulting error as a bug rather than as the flag they
		// need.
		fmt.Fprintln(d.Err, plan.why)
	}
	r, err := d.NewSetup(d.StateDir, p, plan.options()...)
	if err != nil {
		return err
	}

	res, err := r.Run(ctx, f.reregister)
	// Written before the error is returned. A run can fail AFTER the app was
	// created — the one measured way is a .env that could not be written — and
	// the id of a permanent app the user now owns is the last thing to swallow.
	writeIdentities(d, res)
	if err != nil {
		return err
	}
	return writeOutcome(d, res)
}

// setupFlags is what the command line asked for: the three modes, plus the
// switch that says nobody is watching.
type setupFlags struct {
	// appID pins the app to use. Empty means "work it out", which on a machine
	// with no credentials means the confirmation page.
	appID string
	// reregister asks for a second app on purpose.
	reregister bool
	// yes suppresses every question rather than answering it.
	yes bool
}

// parseSetupFlags reads the command line and refuses what cannot mean anything.
//
// Split out from cmdSetup because this CLI permutes flags after positionals (see
// permute), which makes "does --app still reach the flow when it comes last" a
// property worth asserting directly rather than through a whole run.
func parseSetupFlags(d *deps, args []string) (setupFlags, error) {
	fs := newFlags(d, "setup", "[--app <app_id> | --reregister] [--yes]")
	appID := fs.String("app", "",
		"reuse THIS app (cli_...) instead of registering one.\n"+
			"When a file the bridge reads already holds its secret, nothing is opened at all.\n"+
			"When it does not — Feishu shows a secret once, so that is the normal case for an app\n"+
			"made by hand — the confirmation page is opened FOR THAT APP and re-grants it what the\n"+
			"bridge needs. Either way no new app is made, which is why this is the preferred mode:\n"+
			"every registration is permanent clutter in your tenant.")
	reregister := fs.Bool("reregister", false,
		"create a SECOND app on purpose, even though credentials already exist.\n"+
			"The app you already have stays exactly as it is: no API we could find deletes one,\n"+
			"which is why this is a flag and not a fallback. Prefer --app, or pick the app you\n"+
			"already have on the confirmation page.")
	yes := fs.Bool("yes", false,
		"never prompt; for scripts and launchd.\n"+
			"It does not answer the two questions this flow can reach, and they do not end the same way.\n"+
			"Which of two configured apps to use: the run stops with an error naming both files, because a\n"+
			"wrong guess points the bridge at a bot you never messaged and the symptom is silence — pass\n"+
			"--app <app_id> to answer it up front.\n"+
			"Whether to keep waiting for your message or your button press: the wait is not extended, and no\n"+
			"flag extends it. The numbered checklist prints and the run ends at exit 3 with the app and its\n"+
			"credentials already on disk, which is the safe default here rather than a refusal.")
	if err := parseFlags(fs, args); err != nil {
		return setupFlags{}, err
	}
	if fs.NArg() > 0 {
		return setupFlags{}, usagef("setup takes no arguments, got %q", fs.Arg(0))
	}
	f := setupFlags{appID: strings.TrimSpace(*appID), reregister: *reregister, yes: *yes}
	// Caller mistakes are answered before anything is built, locked or dialled.
	if err := checkSetupFlags(f); err != nil {
		return setupFlags{}, err
	}
	return f, nil
}

// checkSetupFlags refuses the two flag combinations that cannot mean anything.
func checkSetupFlags(f setupFlags) error {
	if f.appID == "" {
		return nil
	}
	if !appIDShape.MatchString(f.appID) {
		// The value is NOT echoed. An app id and an app secret sit one above the
		// other in 凭证与基础信息, so the wrong paste here is plausibly the secret,
		// and the secret is the one string in this program that must never reach a
		// terminal, a log or a URL.
		return usagef("setup: --app does not look like a Feishu app id (expected cli_ followed by letters and " +
			"digits, as shown in 凭证与基础信息). What you passed is not printed back here, in case it was the " +
			"app secret — the console lists that directly below the id.")
	}
	if f.reregister {
		return usagef("setup: --app %s means use the app that already exists, and --reregister means make a new "+
			"one; pick one. Reuse is the cheaper mistake: no API we could find deletes an app.", f.appID)
	}
	return nil
}

// setupPlan is what the flags and this terminal add up to, as data rather than
// as a list of opaque options: which app to pin, who can be asked a question,
// and the sentence that has to be printed when the answer is nobody.
type setupPlan struct {
	// reuseAppID pins the app. Empty means the flow works it out.
	reuseAppID string
	// prompter is nil when there is nobody to ask, which is a decision and not an
	// omission — see newTermPrompter.
	prompter setup.Prompter
	// why explains, before the flow starts, that no question will be asked and
	// what happens instead. Empty when there is a human at the terminal.
	why string
}

// setupPlanFor decides whether the two questions this flow can reach are
// questions at all.
//
// They are "which of two configured apps did you mean" and "shall I keep
// waiting". Only the first has no safe default — guessing an app points the
// bridge at a bot the user never messaged, and the symptom is silence — so only
// the first becomes an error. Not waiting again IS the safe answer to the second,
// and the run takes it.
func setupPlanFor(d *deps, f setupFlags) setupPlan {
	p := setupPlan{reuseAppID: f.appID}
	if !f.yes {
		p.prompter = newTermPrompter(d)
	}
	switch {
	case f.yes:
		p.why = noQuestionsWhy("--yes: nothing will be asked.")
	case p.prompter == nil:
		p.why = noQuestionsWhy("stdin is not a terminal, so nothing will be asked.")
	}
	return p
}

// noQuestionsWhy states what becomes of each unaskable question, one clause each,
// because their consequences are NOT the same.
//
// One sentence used to cover both — "each stops the run naming the flag to pass" —
// and it was measured false for the wait. Sequence: `setup` on a pipe, credentials
// fine, one app, the human does not message within InboundTimeout; offerAnotherWait
// returns false without asking, the checklist is appended, Outcome is
// OutcomeCredentials with a nil error, and the run exits 3. No error is produced,
// and no flag exists that would have made it wait longer — stopping is the safe
// default and the code takes it. Sending a script author looking for that flag is
// the same defect as telling a human an app was "created": prose asserting
// something the code does not do.
func noQuestionsWhy(cause string) string {
	return strings.Join([]string{
		"  " + cause,
		"  Two questions can come up, and they do not end the same way:",
		"    - Which of two configured apps to use: the run STOPS with an error naming both files and the app",
		"      each one holds, and telling you to re-run in a terminal or to pass --reregister. Pass",
		"      --app <app_id> to answer it up front and the question never comes up at all.",
		"    - Whether to keep waiting for your message or your button press: the wait is NOT extended, and no",
		"      flag extends it. The numbered checklist prints and the run ends at exit 3 with the app and its",
		"      credentials already on disk — the safe default here, not a refusal. Re-running `herdr-agent",
		"      setup` skips registration and re-runs the verification only.",
	}, "\n")
}

// options is the plan as internal/setup takes it.
func (p setupPlan) options() []setup.Option {
	// WithAssumeYes is not "yes to everything": there is nothing here to say yes
	// to. It means "never ask", which is the only honest reading when nobody is
	// there.
	//
	// It is passed UNCONDITIONALLY, and that is load-bearing rather than tidy.
	// setup.Run falls back to its own os.Stdin prompter when it is given neither a
	// Prompter nor assume-yes, and that fallback's terminal test accepts any
	// character device — /dev/null included, which is what launchd and `go test`
	// hand a process. Passing this option on every path is what keeps that
	// fallback unreachable, so a run with nobody watching stops with the flag to
	// pass instead of reading EOF off /dev/null and calling it an answer.
	// TestSetupHandsThePlanToTheFactory's option counts are the guard.
	opts := []setup.Option{setup.WithAssumeYes(p.prompter == nil)}
	if p.prompter != nil {
		opts = append(opts, setup.WithPrompter(p.prompter))
	}
	if p.reuseAppID != "" {
		opts = append(opts, setup.WithReuseAppID(p.reuseAppID))
	}
	return opts
}

// writeIdentities puts what the run produced on stdout, one `key<TAB>value` per
// line, and nothing else. The narration is on stderr, so `herdr-agent setup >
// ids.txt` still shows the human the link they have to open.
func writeIdentities(d *deps, res setup.Result) {
	for _, kv := range []struct{ key, value string }{
		{"app_id", res.AppID},
		{"app_name", res.AppName},
		// How the run arrived at that app, because it decides what a script may
		// conclude: "created" means the tenant has one more app than it did.
		{"origin", originValue(res.Origin)},
		{"open_id", res.OpenID},
		{"chat_id", res.ChatID},
	} {
		if kv.value != "" {
			fmt.Fprintf(d.Out, "%s\t%s\n", kv.key, oneField(kv.value))
		}
	}
}

// oneField keeps a value inside its `key<TAB>value` line.
//
// An app name is whatever a human typed on the confirmation page, so it can hold
// a tab or a newline, and either would split one record into two in the output a
// script parses — silently, and only for the person whose app has an odd name.
func oneField(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\n', '\r':
			return ' '
		}
		return r
	}, s)
}

// originValue is the machine-readable origin, empty when the run established no
// app: a line saying `origin unknown` invites a script to treat it as a value.
func originValue(o setup.Origin) string {
	if o == setup.OriginUnknown {
		return ""
	}
	return o.String()
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
			appLabel(res.AppID, res.AppName))
		switch {
		case !res.InboundOK:
			fmt.Fprintln(d.Err, "    No message from you arrived, so nothing downstream of it is proven either.")
		case !res.CardOK:
			fmt.Fprintln(d.Err, "    Your message arrived — credentials, bot, event subscription, delivery mode,")
			fmt.Fprintln(d.Err, "    publication, scopes and the allowlist are all confirmed by that one message.")
			writeCardHedge(d.Err, res)
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

// writeCardHedge says what an un-pressed button means, and hedges only as far as
// this app's history justifies.
//
// It used to hedge unconditionally: "an un-pressed button and a disabled 交互卡片
// capability look identical from here". That has since been measured false for an
// app the confirmation page configured — the E1 probe saw no callback in 120s and
// a later run on THAT SAME APP completed the round trip — so the page produces a
// working card path and the hedge belongs on an app somebody built by hand. The
// 200340 fact survives on both branches, in the checklist step: an unsubscribed
// card.action.trigger produces it too, and a hand-made app can have the toggle off.
func writeCardHedge(w io.Writer, res setup.Result) {
	fmt.Fprintln(w, "    The card button did not come back.")
	if res.Origin.PageConfigured() {
		fmt.Fprintln(w, "    This app was configured through the confirmation page, and such an app was measured to")
		fmt.Fprintln(w, "    arrive with the card path working — the same app that once showed no callback later")
		fmt.Fprintln(w, "    completed the round trip. A button nobody pressed in time is by far the likeliest cause.")
		return
	}
	fmt.Fprintln(w, "    This app's capabilities were not granted by a confirmation page during this run, so an")
	fmt.Fprintln(w, "    un-pressed button and a 交互卡片 capability that is switched off look identical from here.")
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

// termProgress renders setup.Narrator for a person at a terminal.
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

	// envPath is where the secret was written, used when the run does not say.
	// The path and the mode are printed; the contents never are, not even a
	// prefix or a length.
	envPath string

	// cfgPath is the file whose allowed_open_ids decides who may drive the
	// agents. Named rather than described, because the one thing a reader may
	// have to edit by hand is the one thing they must be able to find.
	cfgPath string

	// open hands the confirmation link to the desktop browser. A field so no
	// test spawns a process, and nil-safe: a machine with no launcher simply
	// prints the link. An errNoLauncher result is silence, not a complaint —
	// see Verification.
	open func(url string) error
}

// Narrator, not merely Progress: the two sentences this command used to get
// wrong — which app is in use and what the bot is called — are only knowable at
// run time, and Narrator is how the run hands them over instead of leaving the
// CLI to write prose in advance and hope.
var _ setup.Narrator = (*termProgress)(nil)

// Verification hands over the confirmation link.
//
// It also states, BEFORE the irreversible click rather than after it, that
// creating an app is permanent — and that creating one is not the only thing
// that page offers. A user who already had an app was told exactly twice what
// this page does, both times wrongly: "it asks to create an app" (the page also
// lists the apps the tenant already has, and picking one is the right answer far
// more often), and afterwards "App cli_… created" for an app that had existed
// since that morning.
func (p *termProgress) Verification(url string, expiresIn int) {
	fmt.Fprintln(p.err)
	fmt.Fprintln(p.err, "  Open this link and press 确认:")
	fmt.Fprintln(p.err)
	fmt.Fprintln(p.err, "      "+url)
	fmt.Fprintln(p.err)
	// Three outcomes, three different things to say, and only the first one may
	// claim a browser opened:
	//
	//   - a launcher ran and succeeded → say so;
	//   - there is no launcher on this machine (a headless server, an unsupported
	//     GOOS) → say NOTHING about opening. Nothing was attempted, so there is
	//     nothing to report, and the link is already printed above;
	//   - a launcher ran and failed → that IS news, because the user is entitled
	//     to know why the window they expected did not appear.
	if p.open != nil {
		switch err := p.open(url); {
		case err == nil:
			fmt.Fprintln(p.err, "  (opened in your browser)")
		case errors.Is(err, errNoLauncher):
		default:
			fmt.Fprintf(p.err, "  (could not open a browser here: %v — copy the link above)\n", err)
		}
	}
	if expiresIn > 0 {
		fmt.Fprintf(p.err, "  The link expires in %ds.\n", expiresIn)
	}
	// Read while a stranger's URL is on screen: what the page asks for, why
	// there is nothing to do afterwards, and what it will cost if you take the
	// wrong option on it.
	fmt.Fprintf(p.err, "  It asks to grant %s, the event %s and the callback %s — pressing 确认 GRANTS them and "+
		"publishes a version, which is why no console visit follows.\n",
		strings.Join(setup.Scopes, ", "), strings.Join(setup.Events, ", "), strings.Join(setup.Callbacks, ", "))
	// The preset name is interpolated from the package that sends it, not spelled
	// out here. It is the one string on this screen describing what the page will
	// pre-fill, and a hand-copied copy of it is precisely the shape of claim this
	// wave exists to remove: a sentence that keeps its wording after the value it
	// describes has changed.
	fmt.Fprintf(p.err, "  Which app it grants them to is the plan named above: a new one (pre-filled with the name\n"+
		"  %s, which you may change there), an app your tenant already has — the page lists\n"+
		"  them, and picking one is fine — or the one specific app this run opened the page for.\n",
		setup.AppPresetName)
	fmt.Fprintln(p.err, "  A NEW app is permanent: no API we could find deletes one. If you already have an app you")
	fmt.Fprintln(p.err, "  would rather use, pick it on that page, or stop and re-run with --app <app_id>.")
}

// Configured reports the app the run settled on, on every path, once.
//
// One sentence per Origin, and the word "created" appears in exactly one of them
// — the path where the platform could not have done anything else. The rest of
// this file's honesty depends on that: the same run that announced the creation
// of a months-old app also told its user the bot was called herdr-agent while
// bot/v3/info had already said herdr-agent-e1.
func (p *termProgress) Configured(app setup.App) {
	fmt.Fprintln(p.err)
	fmt.Fprintf(p.err, "  ✓ %s\n", p.appSentence(app))
	if app.Origin.PageConfigured() {
		fmt.Fprintf(p.err, "    Its secret was written to %s, mode 0600, and is printed nowhere:\n", p.envFile(app))
		fmt.Fprintln(p.err, "    not here, not in a log, not as a prefix and not as a length.")
	}
	if app.OpenID != "" {
		fmt.Fprintf(p.err, "    Your open_id is %s. Only ids listed in feishu.allowed_open_ids in %s may drive your\n"+
			"    agents; if a line above says that file could not be written, the numbered checklist at the\n"+
			"    end has the exact edit.\n", app.OpenID, p.cfgPath)
	}
}

// envFile is where this run says the credentials live, falling back to where
// this command would have put them. The run is the authority: it is the thing
// that wrote the file.
func (p *termProgress) envFile(app setup.App) string {
	if app.EnvPath != "" {
		return app.EnvPath
	}
	return p.envPath
}

// appSentence states what is known about the app and nothing more.
//
// Each branch is written to survive being read next to the truth, and the word
// "create" appears in exactly one of them — not even as a negation, so that
// "does this run claim a creation?" stays a question a reader (or a test) can
// answer by looking. Nor does anything say "you just confirmed" on the two paths
// that open no confirmation page at all; that sentence was measured on the reuse
// path, where nothing was confirmed by anybody.
func (p *termProgress) appSentence(a setup.App) string {
	switch a.Origin {
	case setup.OriginCreated:
		// The only branch licensed to say it: the page was opened create-only, so
		// it could not have handed back an app the tenant already had.
		return fmt.Sprintf("App %s was created. It is permanent: no API we could find deletes one.",
			appLabel(a.ID, a.Name))
	case setup.OriginUpdated:
		return fmt.Sprintf("App %s already existed, and the confirmation page has now granted THAT app the "+
			"scopes, events and callbacks the bridge needs. No new app was made.", appLabel(a.ID, a.Name))
	case setup.OriginRegistered:
		return fmt.Sprintf("App %s is now configured. That page can make a new app or hand back one your tenant "+
			"already had, and what it returns is identical either way — so this run cannot tell you which "+
			"happened, and does not guess.", appLabel(a.ID, a.Name))
	case setup.OriginAdopted:
		return fmt.Sprintf("App %s was already set up on this machine%s, so this run made no new app and opened "+
			"no confirmation page.", appLabel(a.ID, a.Name), foundIn(a))
	case setup.OriginReused:
		return fmt.Sprintf("App %s is already configured in %s, so this run made no new app, opened no "+
			"confirmation page and wrote nothing.", appLabel(a.ID, a.Name), p.envFile(a))
	default:
		// OriginUnknown, and anything a later origin forgets to render here: an
		// app exists and how the run reached it was not recorded, which is
		// exactly what this says rather than picking the likeliest story.
		return fmt.Sprintf("App %s is configured. This run did not record how it got there, so nothing here "+
			"claims an app was made.", appLabel(a.ID, a.Name))
	}
}

// foundIn says where an adopted app's credentials were, naming BOTH files when
// they were in two.
//
// A split pair is not exotic: a repository .env and a state-directory .env are
// merged key by key by the bridge, so an id in one and a secret in the other are
// one working pair — and the sentence this replaced named the file that held the
// id as the file that held both.
func foundIn(a setup.App) string {
	switch {
	case a.From == "":
		return ""
	case a.FromSecret == "" || a.FromSecret == a.From:
		return " — its credentials were in " + a.From
	default:
		return fmt.Sprintf(" — %s named it and %s held its secret", a.From, a.FromSecret)
	}
}

// appLabel names an app the way a human recognises one, and never with a name
// this run did not observe.
//
// The id alone cannot be searched for in Feishu, which is what made the original
// failure expensive: the user was told to look for a bot called herdr-agent, the
// bot was called herdr-agent-e1, and they were doing it against a countdown.
func appLabel(id, name string) string {
	switch {
	case name != "" && id != "":
		return fmt.Sprintf("%q (%s)", name, id)
	case name != "":
		return fmt.Sprintf("%q", name)
	case id != "":
		return id
	default:
		return "-"
	}
}

// AwaitMessage asks for the message that proves the whole chain at once, naming
// the bot from what Feishu said it is called.
func (p *termProgress) AwaitMessage(app setup.App, d time.Duration) {
	fmt.Fprintln(p.err)
	fmt.Fprintf(p.err, "  → Message the bot in Feishu now. Waiting %ds.\n", seconds(d))
	fmt.Fprintf(p.err, "    %s\n", whichBot(app))
	fmt.Fprintln(p.err, "    Send it a DIRECT message from your own account: a group chat cannot finish this,")
	fmt.Fprintln(p.err, "    because the chat it arrives in becomes notify_chat_id and agent screens get pushed there.")
	fmt.Fprintln(p.err, "    That one message proves the credentials, the bot, the event subscription, the delivery")
	fmt.Fprintln(p.err, "    mode, the published version, the scopes and the allowlist.")
}

// whichBot names the bot to look for, or admits Feishu would not say.
//
// It never falls back to the name setup asks the confirmation page to pre-fill:
// the human may rename the app on that page and did, and an id that has to be
// searched for is still better than a name that finds the wrong bot or none.
func whichBot(a setup.App) string {
	switch {
	case a.Name != "":
		return fmt.Sprintf("The bot is called %q (app %s) — search Feishu for that name.", a.Name, a.ID)
	case a.ID != "":
		return fmt.Sprintf("Feishu would not say what this bot is called, so look for the app with id %s.", a.ID)
	default:
		return "Look for the bot belonging to the app named above; this wait was reported without one."
	}
}

// Registered is what a plain setup.Progress gets when an app was demonstrably
// created. This type is a Narrator, so the package routes Configured instead and
// this is never called — it is retained so termProgress still satisfies
// Progress, and it renders the one thing its argument list can support.
func (p *termProgress) Registered(appID, openID string) {
	p.Configured(setup.App{ID: appID, Origin: setup.OriginCreated, EnvPath: p.envPath, OpenID: openID})
}

// AwaitInbound is retained for the same reason, and this rendering is why the
// package stopped calling it: its arguments carry no app, so a renderer here can
// only name the bot from something it made up. This one names no bot at all.
func (p *termProgress) AwaitInbound(d time.Duration) {
	p.AwaitMessage(setup.App{}, d)
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
//
// It bounds the LAUNCHER, not the browser — which is only true because
// runLauncher gives the child no pipes to hold open. See the trade-off there.
const openTimeout = 5 * time.Second

// errNoLauncher means this machine has nothing that opens a URL, which is not a
// failure: a headless Linux server is a normal place to run `setup`, and so is
// any GOOS this launcher does not know. Callers must say NOTHING about opening
// in that case — the link is already on screen — rather than report an error the
// user cannot act on. See termProgress.Verification.
var errNoLauncher = errors.New("no browser launcher on this machine")

// browserOpener is the platform seam. It exists so the one claim this code is
// allowed to make — "(opened in your browser)" — can be tested on every GOOS
// without spawning anything: that line may only be printed when run actually ran
// a launcher and it actually succeeded.
type browserOpener struct {
	goos string
	// look resolves a launcher on PATH; exec.LookPath in production.
	look func(file string) (string, error)
	// run executes it and reports whether IT exited 0, plus whatever it printed
	// where that could be captured without waiting on it (see runLauncher).
	run func(ctx context.Context, name string, args ...string) ([]byte, error)
}

func defaultOpener() browserOpener {
	return browserOpener{
		goos: runtime.GOOS,
		look: exec.LookPath,
		run:  runLauncher,
	}
}

// runLauncher runs the launcher and waits for IT to exit — not for whatever it
// spawns.
//
// This used to be CombinedOutput(), which waits for the child's output pipes to
// reach EOF as well as for the child to exit. That is the wrong fact: xdg-open's
// generic fallback runs the browser in the FOREGROUND, and a browser started
// that way inherits these descriptors and holds them for as long as the window
// lives. So on a Linux desktop with no browser already running, a successful
// launch read as a 5s stall followed by "(could not open a browser here: signal:
// killed)" — a failure reported for a window that was in fact opening. Worse,
// killing the process at openTimeout does not end that wait: with no WaitDelay
// set, os/exec keeps draining the pipe until every write end closes, so a
// descendant outliving the launcher would block here indefinitely, which is
// exactly what openTimeout is supposed to prevent.
//
// Leaving Stdout and Stderr nil hands the child /dev/null instead of a pipe, so
// there is nothing to drain and Wait returns when the launcher does. The
// measured fact behind "(opened in your browser)" becomes precisely "the
// launcher exited 0". The price is the launcher's own words: an xdg-open that
// fails now reports its exit status without its message. The invariant is
// unchanged — a launcher that never returns is still killed at openTimeout and
// still reported as a failure, never as success. darwin is unaffected either
// way: open(1) detaches and returns at once.
func runLauncher(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	// Stdout and Stderr stay nil deliberately. Do not "improve" this by handing
	// them a buffer; read the comment above first.
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return nil, cmd.Wait()
}

// openInBrowser hands the confirmation link to the desktop browser.
func openInBrowser(url string) error { return defaultOpener().open(url) }

// open launches url, or reports why it did not.
//
// The URL is checked FIRST, on every platform, and rather than trusted. It
// arrives from the network, it is passed to a program as an argument, and a
// value starting with '-' would be read by open(1) or xdg-open as a flag;
// anything that is not plain https is refused and printed instead. Checking it
// before the launcher is resolved also keeps that refusal identical everywhere,
// including on a machine that has no launcher at all.
func (o browserOpener) open(url string) error {
	if !strings.HasPrefix(url, "https://") {
		return errors.New("refusing to open a link that is not https")
	}
	name, err := o.launcher()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), openTimeout)
	defer cancel()
	out, err := o.run(ctx, name, url)
	if err != nil {
		// Output is optional by contract: runLauncher gives the child no pipes, so
		// in production this is the bare exit status. Kept because a seam that can
		// capture output must not be able to smuggle a multi-line blob to screen.
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return fmt.Errorf("%s: %w: %s", name, err, oneLine(msg))
		}
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// launcher names the program to run, or wraps errNoLauncher.
//
// darwin runs open(1) unresolved, exactly as it always has: it is part of the
// OS, and a LookPath in front of it would only invent a new way for a working
// Mac to stop opening links.
//
// linux runs xdg-open ONLY when it is on PATH. This wave ships Linux binaries,
// so the old flat refusal is no longer honest — but neither is assuming a
// desktop: a server with no xdg-open is a normal deployment, and running it
// blind there would print "(opened in your browser)" for a window nobody has.
// Absence is therefore errNoLauncher, not a failure.
func (o browserOpener) launcher() (string, error) {
	switch o.goos {
	case "darwin":
		return "open", nil
	case "linux":
		path, err := o.look("xdg-open")
		if err != nil {
			return "", fmt.Errorf("%w: xdg-open is not on PATH", errNoLauncher)
		}
		return path, nil
	default:
		return "", fmt.Errorf("%w: none is known for %s", errNoLauncher, o.goos)
	}
}
