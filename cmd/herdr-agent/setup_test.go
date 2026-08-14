package main

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/setup"
)

// setupSecret is what the real flow writes into .env and must never print. It
// is deliberately distinctive so that a four-character prefix of it cannot
// appear in the output by coincidence.
const setupSecret = "FAKEsecret_zq7x4Kt2Ln9Pw3Rv8Hb5Yc1M"

// fakeSetupRunner stands in for *setup.Runner.
//
// The real one registers an app in a Feishu tenant and no API was found that
// deletes one, so no test may ever reach it: this is what deps.NewSetup exists
// for.
type fakeSetupRunner struct {
	res setup.Result
	err error
	// emit replays the Progress calls a real run would make, so the terminal
	// renderer is exercised through the command rather than in isolation.
	emit func(p setup.Progress)

	mu         sync.Mutex
	reregister []bool
	dir        string
	// progress is what the CLI handed to the factory.
	progress setup.Progress
}

var _ SetupRunner = (*fakeSetupRunner)(nil)

func (f *fakeSetupRunner) Run(_ context.Context, reregister bool) (setup.Result, error) {
	f.mu.Lock()
	f.reregister = append(f.reregister, reregister)
	emit, p := f.emit, f.progress
	f.mu.Unlock()
	if emit != nil {
		emit(p)
	}
	return f.res, f.err
}

// verifiedResult is what a run that actually succeeded looks like: the outcome
// AND both observations behind it. Tests that only care about the flag they
// passed use it so they exercise the exit-0 path rather than the downgrade.
func verifiedResult() setup.Result {
	return setup.Result{Outcome: setup.OutcomeVerified, AppID: "cli_x", InboundOK: true, CardOK: true}
}

// withSetup points the harness at f and gives it a state directory. It returns
// the state directory, which is where .env and config.toml would be written.
func (h *harness) withSetup(t *testing.T, f *fakeSetupRunner) string {
	t.Helper()
	dir := t.TempDir()
	h.d.StateDir = dir
	h.d.NewSetup = func(stateDir string, p setup.Progress) (SetupRunner, error) {
		f.mu.Lock()
		f.dir, f.progress = stateDir, p
		f.mu.Unlock()
		return f, nil
	}
	return dir
}

func TestSetupIsInTheDispatchTableAndInHelp(t *testing.T) {
	var found *command
	for _, c := range commandTable() {
		if c.name == "setup" {
			cc := c
			found = &cc
		}
	}
	if found == nil {
		t.Fatal("commandTable has no setup command; dispatch and help both read that table")
	}
	if found.args != "[--reregister]" {
		t.Errorf("setup args = %q, want [--reregister]", found.args)
	}

	h := newHarness(t)
	if err := dispatch(context.Background(), h.d, []string{"help"}); err != nil {
		t.Fatalf("help: %v", err)
	}
	if !strings.Contains(h.stdout(), "setup [--reregister]") {
		t.Errorf("help does not list setup with its flag:\n%s", h.stdout())
	}
}

// TestSetupExitCodes is the contract with anyone scripting this: 0 only when a
// real message and a real button press were observed, 3 when a permanent app
// exists but nothing was proven, 1 when nothing usable came out.
func TestSetupExitCodes(t *testing.T) {
	tests := []struct {
		name     string
		res      setup.Result
		err      error
		wantCode int
		wantErr  string
		// wantAbsent is what this outcome must NOT say. Exit 3 is reached by
		// several routes and each of them has a sentence that would be a lie on
		// the others.
		wantAbsent []string
		// wantPresent is what it must say instead.
		wantPresent []string
	}{
		{
			name:     "verified",
			res:      setup.Result{Outcome: setup.OutcomeVerified, AppID: "cli_v", InboundOK: true, CardOK: true},
			wantCode: exitOK,
		},
		{
			name: "credentials only",
			res: setup.Result{
				Outcome:   setup.OutcomeCredentials,
				AppID:     "cli_c",
				InboundOK: true,
				Steps:     []setup.Step{{What: "press the button", URL: "https://open.feishu.cn/app/cli_c/bot"}},
			},
			wantCode: exitUnconfirmed,
			wantErr:  "NOT verified",
		},
		{
			// Ctrl-C during the card wait: the context is cancelled, which
			// produces no step at all. Announcing a checklist and then printing
			// nothing sends the reader looking for output that was never
			// written.
			name: "credentials with nothing left to do",
			res: setup.Result{
				Outcome:   setup.OutcomeCredentials,
				AppID:     "cli_c",
				InboundOK: true,
				Steps:     nil,
			},
			wantCode:    exitUnconfirmed,
			wantErr:     "NOT verified",
			wantAbsent:  []string{"Do these", "the step below", "covers both"},
			wantPresent: []string{"Run `herdr-agent setup` again"},
		},
		{
			// A Result that claims Verified while one of its two observations is
			// false contradicts itself, and exit 0 is the sentence that tells
			// the user to stop testing.
			name:       "verified without the evidence",
			res:        setup.Result{Outcome: setup.OutcomeVerified, AppID: "cli_v", InboundOK: false, CardOK: true},
			wantCode:   exitUnconfirmed,
			wantErr:    "NOT verified",
			wantAbsent: []string{"Verified end to end", "your message reached the bridge"},
		},
		{
			name:     "failed",
			res:      setup.Result{Outcome: setup.OutcomeFailed},
			wantCode: exitFail,
			wantErr:  "nothing usable",
		},
		{
			name:     "run returned an error",
			res:      setup.Result{Outcome: setup.OutcomeFailed},
			err:      errors.New("registration was refused"),
			wantCode: exitFail,
			wantErr:  "registration was refused",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.withSetup(t, &fakeSetupRunner{res: tc.res, err: tc.err})

			err := dispatch(context.Background(), h.d, []string{"setup"})
			if got := report(&h.errb, err); got != tc.wantCode {
				t.Fatalf("exit = %d, want %d (err = %v)", got, tc.wantCode, err)
			}
			if tc.wantErr != "" && !strings.Contains(h.stderr(), tc.wantErr) {
				t.Errorf("stderr does not explain the outcome (%q missing):\n%s", tc.wantErr, h.stderr())
			}
			for _, bad := range tc.wantAbsent {
				if strings.Contains(h.stderr(), bad) {
					t.Errorf("stderr claims %q, which this run did not observe:\n%s", bad, h.stderr())
				}
			}
			for _, want := range tc.wantPresent {
				if !strings.Contains(h.stderr(), want) {
					t.Errorf("stderr never says %q:\n%s", want, h.stderr())
				}
			}
		})
	}
}

// TestSetupPrintsIdentitiesOnStdout keeps the payload/narration split the rest
// of this CLI has: an app id is the one durable value a script wants, and the
// instructions must survive a redirect of stdout.
func TestSetupPrintsIdentitiesOnStdout(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome:   setup.OutcomeVerified,
		AppID:     "cli_a1b2c3",
		OpenID:    "ou_owner",
		ChatID:    "oc_chat",
		InboundOK: true,
		CardOK:    true,
	}})

	if err := dispatch(context.Background(), h.d, []string{"setup"}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	for _, want := range []string{"app_id\tcli_a1b2c3", "open_id\tou_owner", "chat_id\toc_chat"} {
		if !strings.Contains(h.stdout(), want) {
			t.Errorf("stdout is missing %q:\n%s", want, h.stdout())
		}
	}
	if !strings.Contains(h.stderr(), "Verified end to end") {
		t.Errorf("the outcome was not narrated on stderr:\n%s", h.stderr())
	}
}

// TestSetupPrintsTheAppIDEvenWhenTheRunFailed: registration can succeed and the
// run still fail afterwards — the measured case is a .env that cannot be
// written — and the id of a permanent app the user now owns is the last thing
// to swallow.
func TestSetupPrintsTheAppIDEvenWhenTheRunFailed(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{
		res: setup.Result{Outcome: setup.OutcomeFailed, AppID: "cli_orphan"},
		err: errors.New("credentials could not be stored"),
	})

	err := dispatch(context.Background(), h.d, []string{"setup"})
	if err == nil {
		t.Fatal("want the failure to be reported")
	}
	if !strings.Contains(h.stdout(), "cli_orphan") {
		t.Errorf("the id of the app that was created is not on stdout:\n%s", h.stdout())
	}
}

// TestSetupChecklistIsNumberedAndCarriesURLs: the promise of this command is
// that whatever it could not do for you is one click away, which requires the
// link to be on the screen next to the instruction.
func TestSetupChecklistIsNumberedAndCarriesURLs(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome:   setup.OutcomeCredentials,
		AppID:     "cli_c",
		InboundOK: true,
		Steps: []setup.Step{
			{What: "press the button on the card", URL: "https://open.feishu.cn/app/cli_c/bot", Why: "it was never pressed"},
			{What: "add ou_x to allowed_open_ids", URL: "file:///tmp/config.toml", Why: "writing it failed"},
		},
	}})

	err := dispatch(context.Background(), h.d, []string{"setup"})
	if report(&h.errb, err) != exitUnconfirmed {
		t.Fatalf("exit code = %d, want %d", report(&h.errb, err), exitUnconfirmed)
	}
	out := h.stderr()
	for _, want := range []string{
		"1. press the button on the card",
		"url: https://open.feishu.cn/app/cli_c/bot",
		"why: it was never pressed",
		"2. add ou_x to allowed_open_ids",
		"url: file:///tmp/config.toml",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("checklist is missing %q:\n%s", want, out)
		}
	}
}

// TestSetupKeepsTheCardOutcomeAmbiguous: a card that did not come back is
// EITHER an un-pressed button OR a 交互卡片 capability that needs a manual
// toggle. The measured probe could not tell them apart, so neither may the
// prose: resolving it either way sends half the readers to fix something that
// is not broken.
func TestSetupKeepsTheCardOutcomeAmbiguous(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome:   setup.OutcomeCredentials,
		AppID:     "cli_c",
		InboundOK: true,
		CardOK:    false,
	}})

	_ = dispatch(context.Background(), h.d, []string{"setup"})
	out := h.stderr()
	if !strings.Contains(out, "交互卡片") || !strings.Contains(out, "un-pressed button") {
		t.Errorf("the two indistinguishable causes are not both named:\n%s", out)
	}
	if !strings.Contains(out, "Your message arrived") {
		t.Errorf("the half that DID work is not reported:\n%s", out)
	}
}

// TestSetupSaysWhichHalfIsUnproven: the two ways to end up at exit 3 need
// different things from the reader, and "not verified" alone tells them which
// of the two to go and check — neither.
func TestSetupSaysWhichHalfIsUnproven(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome:   setup.OutcomeCredentials,
		AppID:     "cli_c",
		InboundOK: false,
	}})

	_ = dispatch(context.Background(), h.d, []string{"setup"})
	if !strings.Contains(h.stderr(), "No message from you arrived") {
		t.Errorf("a run that never saw a message does not say so:\n%s", h.stderr())
	}
	if strings.Contains(h.stderr(), "Your message arrived") {
		t.Errorf("a run that never saw a message claims one arrived:\n%s", h.stderr())
	}
}

// TestSetupVerifiedStillPrintsWhatItCouldNotWrite: the round trip proves the
// Feishu app, and a config.toml this command would not rewrite safely is a
// separate problem that still needs a pair of hands.
func TestSetupVerifiedStillPrintsWhatItCouldNotWrite(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome:   setup.OutcomeVerified,
		AppID:     "cli_v",
		InboundOK: true,
		CardOK:    true,
		Steps: []setup.Step{{
			What: "Add \"ou_x\" to feishu.allowed_open_ids by hand.",
			URL:  "file:///Users/x/.herdr-agent/config.toml",
			Why:  "that key is spread over several lines",
		}},
	}})

	if err := dispatch(context.Background(), h.d, []string{"setup"}); err != nil {
		t.Fatalf("a verified run must still exit 0: %v", err)
	}
	for _, want := range []string{"could not be written for you", "1. Add \"ou_x\"", "file:///Users/x/.herdr-agent/config.toml"} {
		if !strings.Contains(h.stderr(), want) {
			t.Errorf("the leftover manual step is missing %q:\n%s", want, h.stderr())
		}
	}
}

// TestSetupReportsAFactoryFailure: setup.New refuses a state directory it
// cannot use, and that refusal is the one the user has to see.
func TestSetupReportsAFactoryFailure(t *testing.T) {
	h := newHarness(t)
	h.d.StateDir = t.TempDir()
	boom := errors.New("setup: a Progress implementation is required")
	h.d.NewSetup = func(string, setup.Progress) (SetupRunner, error) { return nil, boom }

	err := dispatch(context.Background(), h.d, []string{"setup"})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the factory's own error", err)
	}
}

// TestSetupNeverPrintsTheSecret is the same bar internal/config holds itself to:
// not the whole secret, not a prefix, not a suffix, not its length. The state
// directory holds a real .env throughout, so a helpful "here are your
// credentials" line anywhere in this command would fail this test.
func TestSetupNeverPrintsTheSecret(t *testing.T) {
	h := newHarness(t)
	f := &fakeSetupRunner{
		res: setup.Result{
			Outcome:   setup.OutcomeCredentials,
			AppID:     "cli_a1b2c3",
			OpenID:    "ou_owner",
			ChatID:    "oc_chat",
			InboundOK: true,
			Steps:     []setup.Step{{What: "press the button", URL: "https://open.feishu.cn/app/cli_a1b2c3/bot"}},
		},
	}
	dir := h.withSetup(t, f)
	// Written the way the real run writes it, before any narration happens.
	writeFile(t, filepath.Join(dir, config.DotEnvFileName),
		config.EnvAppID+"=cli_a1b2c3\n"+config.EnvAppSecret+"="+setupSecret+"\n")
	f.emit = func(p setup.Progress) {
		p.Verification("https://accounts.feishu.cn/oauth/v1/app/registration?code=xyz", 600)
		p.Registered("cli_a1b2c3", "ou_owner")
		p.Note("Message received. Credentials, bot and delivery mode are confirmed.")
		p.AwaitInbound(150 * time.Second)
		p.AwaitCard(120 * time.Second)
	}

	_ = dispatch(context.Background(), h.d, []string{"setup"})

	for name, raw := range map[string]string{"stdout": h.stdout(), "stderr": h.stderr()} {
		// The state directory is printed on purpose and its name is random, so a
		// digit of the temp path could stand in for the length check below. It is
		// data we chose to print and is not derived from the secret, so it is
		// masked out rather than allowed to make this test flaky.
		out := strings.ReplaceAll(raw, dir, "<state-dir>")
		if strings.Contains(out, setupSecret) {
			t.Fatalf("%s leaks the whole app secret:\n%s", name, out)
		}
		for n := 4; n <= len(setupSecret); n++ {
			if strings.Contains(out, setupSecret[:n]) {
				t.Errorf("%s leaks a %d-character prefix of the app secret", name, n)
				break
			}
		}
		for n := 4; n <= len(setupSecret); n++ {
			if strings.Contains(out, setupSecret[len(setupSecret)-n:]) {
				t.Errorf("%s leaks a %d-character suffix of the app secret", name, n)
				break
			}
		}
		// A log file outlives the secret it describes, so its LENGTH must not
		// survive either — internal/config holds itself to the same line.
		if strings.Contains(out, strconv.Itoa(len(setupSecret))+" ") {
			t.Errorf("%s prints something that looks like the secret's length:\n%s", name, out)
		}
	}
	// Not vacuous: the file and its mode ARE named, which is the whole point of
	// the line the assertions above are guarding.
	if !strings.Contains(h.stderr(), filepath.Join(dir, config.DotEnvFileName)) {
		t.Errorf("the .env path was not printed:\n%s", h.stderr())
	}
	if !strings.Contains(h.stderr(), "0600") {
		t.Errorf("the .env mode was not printed:\n%s", h.stderr())
	}
}

// TestSetupProgressTellsTheHumanExactlyWhatToDo drives the renderer directly,
// because every un-automatable step of this feature reaches the user through
// exactly these five callbacks.
func TestSetupProgressTellsTheHumanExactlyWhatToDo(t *testing.T) {
	var out, errb strings.Builder
	var opened []string
	p := &termProgress{
		out:     &out,
		err:     &errb,
		envPath: "/Users/x/.herdr-agent/.env",
		cfgPath: "/Users/x/.herdr-agent/config.toml",
		open: func(url string) error {
			opened = append(opened, url)
			return nil
		},
	}

	const url = "https://accounts.feishu.cn/oauth/v1/app/registration?code=xyz"
	p.Verification(url, 600)
	p.Registered("cli_a1b2c3", "ou_owner")
	p.AwaitInbound(150 * time.Second)
	p.AwaitCard(120 * time.Second)
	p.Note("Feishu asked us to poll more slowly.")

	got := errb.String()
	for _, want := range []string{
		url,                                 // the link, in full
		"opened in your browser",            // and the fact that we opened it
		"expires in 600s",                   //
		"im:message",                        // what the page will ask for
		"im.message.receive_v1",             //
		"card.action.trigger",               //
		"GRANTS",                            // and why nothing follows in the console
		"permanent",                         // it cannot be deleted afterwards
		"cli_a1b2c3",                        // the app id
		"/Users/x/.herdr-agent/.env",        // where the secret went
		"0600",                              // at what mode
		"ou_owner",                          //
		"allowed_open_ids",                  // and the file that decides who may drive the agents
		"/Users/x/.herdr-agent/config.toml", // named, because it is the one file a reader may have to edit
		"Message the bot in Feishu now",     // wait 1: what to do
		"unless you changed the name",       // the app name is only the default
		"Waiting 150s",                      // and for how long
		"Press the button on the card",      // wait 2
		"Waiting 120s",
		"poll more slowly", // notes reach the user
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the narration never says %q:\n%s", want, got)
		}
	}
	// The allowlist write happened before this callback and carries no success
	// signal into it, and on --reregister it APPENDS to whatever was there. So
	// the id may be neither authorized nor alone, and "only" must attach to the
	// file rather than to the id: an operator rotating a leaked credential reads
	// that sentence and decides the old id is gone.
	for _, lie := range []string{"ou_owner is now the only", "is the only", "only open_id"} {
		if strings.Contains(got, lie) {
			t.Errorf("the narration claims %q, which this run never observed:\n%s", lie, got)
		}
	}
	if len(opened) != 1 || opened[0] != url {
		t.Errorf("the verification URL was not handed to the browser: %v", opened)
	}
	if out.String() != "" {
		t.Errorf("progress wrote to stdout, which belongs to the payload: %q", out.String())
	}
}

// TestSetupProgressSurvivesAMachineWithNoLauncher: on anything that is not
// darwin there is no open(1), and claiming a browser opened would be a lie the
// user acts on by waiting for a window.
func TestSetupProgressSurvivesAMachineWithNoLauncher(t *testing.T) {
	tests := map[string]func(string) error{
		"no launcher wired": nil,
		"launcher failed":   func(string) error { return errors.New("open: no application knows how") },
	}
	for name, open := range tests {
		t.Run(name, func(t *testing.T) {
			var errb strings.Builder
			p := &termProgress{out: &strings.Builder{}, err: &errb, open: open}
			p.Verification("https://accounts.feishu.cn/x", 0)

			if !strings.Contains(errb.String(), "https://accounts.feishu.cn/x") {
				t.Fatalf("the link itself was not printed:\n%s", errb.String())
			}
			if strings.Contains(errb.String(), "opened in your browser") {
				t.Errorf("claimed a browser opened when none did:\n%s", errb.String())
			}
		})
	}
}

func TestSetupUsage(t *testing.T) {
	t.Run("takes no arguments", func(t *testing.T) {
		h := newHarness(t)
		h.withSetup(t, &fakeSetupRunner{})
		err := dispatch(context.Background(), h.d, []string{"setup", "please"})
		var ue *usageError
		if !errors.As(err, &ue) {
			t.Fatalf("err = %v, want a usage error", err)
		}
	})

	t.Run("reregister reaches the runner", func(t *testing.T) {
		h := newHarness(t)
		// A coherent verified result: the CLI prints exit 0 from the two
		// observations, not from the label, so a Result missing them is exit 3.
		f := &fakeSetupRunner{res: verifiedResult()}
		h.withSetup(t, f)
		if err := dispatch(context.Background(), h.d, []string{"setup", "--reregister"}); err != nil {
			t.Fatalf("setup: %v", err)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.reregister) != 1 || !f.reregister[0] {
			t.Errorf("Run was called with reregister = %v, want [true]", f.reregister)
		}
	})

	t.Run("defaults to not reregistering", func(t *testing.T) {
		h := newHarness(t)
		f := &fakeSetupRunner{res: verifiedResult()}
		h.withSetup(t, f)
		if err := dispatch(context.Background(), h.d, []string{"setup"}); err != nil {
			t.Fatalf("setup: %v", err)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.reregister) != 1 || f.reregister[0] {
			t.Errorf("Run was called with reregister = %v, want [false]: a second app cannot be deleted", f.reregister)
		}
	})
}

// TestSetupRefusesWithoutSomewhereToWrite: the credentials have to land where
// the bridge reads them, or the run ends with a working app nobody can find.
func TestSetupRefusesWithoutSomewhereToWrite(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{})
	h.d.StateDir = ""

	err := dispatch(context.Background(), h.d, []string{"setup"})
	if err == nil {
		t.Fatal("setup ran without a state directory")
	}
	if !strings.Contains(err.Error(), "state directory") {
		t.Errorf("err = %v, want it to name the missing state directory", err)
	}
}

// TestSetupRefusesWhenNoRunnerIsWired: an un-wired deps must not fall back to
// the real flow, which creates an app that cannot be deleted.
func TestSetupRefusesWhenNoRunnerIsWired(t *testing.T) {
	h := newHarness(t)
	h.d.StateDir = t.TempDir()

	err := dispatch(context.Background(), h.d, []string{"setup"})
	if err == nil {
		t.Fatal("setup ran with no runner wired")
	}
	if report(&h.errb, err) != exitFail {
		t.Errorf("exit code = %d, want %d", report(&h.errb, err), exitFail)
	}
}

func TestSecondsRoundsUp(t *testing.T) {
	tests := []struct {
		in   time.Duration
		want int
	}{
		{0, 0},
		{-time.Second, 0},
		{150 * time.Second, 150},
		// Rounding down would promise less time than the human has.
		{1500 * time.Millisecond, 2},
	}
	for _, tc := range tests {
		if got := seconds(tc.in); got != tc.want {
			t.Errorf("seconds(%s) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// TestOpenInBrowserRefusesANonHTTPSLink: the URL comes off the network and is
// handed to a program as an argument, where a value starting with '-' would be
// read as a flag.
func TestOpenInBrowserRefusesANonHTTPSLink(t *testing.T) {
	for _, url := range []string{"-h", "file:///etc/passwd", "http://accounts.feishu.cn/x", ""} {
		if err := openInBrowser(url); err == nil {
			t.Errorf("openInBrowser(%q) opened it", url)
		}
	}
}
