package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
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
	// built counts factory calls, so a test can prove a refusal happened BEFORE
	// anything that could reach the network was constructed.
	built int
	// opts is what the flags turned into. They are opaque functions —
	// setup.Option closes over *setup.Runner's unexported fields — so a test
	// asserts the decision through setupPlanFor and only counts them here.
	opts int
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
	h.d.NewSetup = func(stateDir string, p setup.Progress, opts ...setup.Option) (SetupRunner, error) {
		f.mu.Lock()
		f.dir, f.progress = stateDir, p
		f.built++
		f.opts = len(opts)
		f.mu.Unlock()
		return f, nil
	}
	return dir
}

// ran reports how the runner was driven: how many times, and with what
// reregister argument each time.
func (f *fakeSetupRunner) ran() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.reregister)
}

func (f *fakeSetupRunner) builds() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.built
}

func (f *fakeSetupRunner) options() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.opts
}

// TestSetupIsInTheDispatchTableAndInHelp also pins the THREE modes into the help
// text. The defect that produced them was a user who already had an app being
// offered only two ways forward — move a file, or make a second permanent app —
// while reusing the app the command had just named was never mentioned.
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
	for _, want := range []string{"--app", "--reregister"} {
		if !strings.Contains(found.args, want) {
			t.Errorf("setup args = %q, want it to show %s", found.args, want)
		}
	}
	if !strings.Contains(found.summary, "reuse") {
		t.Errorf("setup summary = %q, want it to say reusing an app is possible", found.summary)
	}

	h := newHarness(t)
	if err := dispatch(context.Background(), h.d, []string{"help"}); err != nil {
		t.Fatalf("help: %v", err)
	}
	for _, want := range []string{
		"setup [--app <id>|--reregister]", // the row itself
		"(no flags)",                      // mode 1: confirm one page
		"pick an app you already have",    //   which is not only "create"
		"--app <app_id>",                  // mode 2
		"preferred",                       //   and why
		"--reregister",                    // mode 3
		"no API deletes it",               //   and what it costs
		"--yes",                           // and the switch for scripts
		"an expired wait is exit 3",       //   whose two questions end differently
	} {
		if !strings.Contains(h.stdout(), want) {
			t.Errorf("help does not mention %q:\n%s", want, h.stdout())
		}
	}
	// The row used to say "a question with no safe default is an error" of both
	// questions. Not waiting again IS the safe answer to the second one, and the
	// run takes it: exit 3 with the checklist, no error and no flag to pass.
	if lie := "a question with no safe default is an error"; strings.Contains(h.stdout(), lie) {
		t.Errorf("the --yes help row still says %q of both questions:\n%s", lie, h.stdout())
	}
}

// TestSetupFlagHelpExplainsTheModes: `setup -h` is where someone who read the
// summary goes next, and it is the only place with room for the whole trade-off.
func TestSetupFlagHelpExplainsTheModes(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{res: verifiedResult()})

	err := dispatch(context.Background(), h.d, []string{"setup", "-h"})
	if !errors.Is(err, errUsageShown) {
		t.Fatalf("err = %v, want the usage-printed sentinel", err)
	}
	if report(&h.errb, err) != exitOK {
		t.Errorf("asking for help is not a failure")
	}
	for _, want := range []string{
		"-app",
		"no new app is made",
		"-reregister",
		"deletes one",
		"-yes",
		"never prompt",
		// --yes reaches two questions with two different consequences, and the
		// flag help is where a script author reads what to pass. Only the app
		// question has a flag; the wait has none, and saying otherwise sends them
		// hunting for it (see noQuestionsWhy).
		"the run stops with an error",
		"the wait is not extended",
		"exit 3",
	} {
		if !strings.Contains(h.stderr(), want) {
			t.Errorf("setup -h does not explain %q:\n%s", want, h.stderr())
		}
	}
	if lie := "turns them into errors"; strings.Contains(h.stderr(), lie) {
		t.Errorf("setup -h still says --yes %q for both questions; only the app question errors:\n%s",
			lie, h.stderr())
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

// TestSetupCardHedgeFollowsTheOrigin: an un-pressed button and a disabled 交互
// 卡片 capability used to be reported as indistinguishable on every path. That
// has since been measured false where it matters most — the E1 probe saw no
// callback in 120s, and a later run on THAT SAME APP completed the round trip —
// so an app the confirmation page configured has a working card path, and the
// hedge belongs on an app somebody built by hand.
func TestSetupCardHedgeFollowsTheOrigin(t *testing.T) {
	tests := []struct {
		name   string
		origin setup.Origin
		want   []string
		absent []string
	}{
		{
			name:   "page configured",
			origin: setup.OriginRegistered,
			want:   []string{"configured through the confirmation page", "likeliest cause"},
			absent: []string{"look identical from here"},
		},
		{
			name:   "created by this run",
			origin: setup.OriginCreated,
			want:   []string{"likeliest cause"},
			absent: []string{"look identical from here"},
		},
		{
			name:   "granted to an existing app by the page",
			origin: setup.OriginUpdated,
			want:   []string{"likeliest cause"},
			absent: []string{"look identical from here"},
		},
		{
			// Nothing granted this app anything during this run: it may well have
			// been built by hand in the console, where the toggle really can be off.
			name:   "credentials adopted from a file",
			origin: setup.OriginAdopted,
			want:   []string{"交互卡片", "un-pressed button", "look identical from here"},
			absent: []string{"likeliest cause"},
		},
		{
			name:   "credentials already in place",
			origin: setup.OriginReused,
			want:   []string{"交互卡片", "un-pressed button", "look identical from here"},
			absent: []string{"likeliest cause"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.withSetup(t, &fakeSetupRunner{res: setup.Result{
				Outcome:   setup.OutcomeCredentials,
				AppID:     "cli_c",
				Origin:    tc.origin,
				InboundOK: true,
				CardOK:    false,
				// The 200340 advice lives in the checklist step internal/setup
				// emits, on both branches, and this is where it reaches the reader.
				Steps: []setup.Step{{
					What: "Press the button, and if that fails check 应用能力 → 机器人 → 交互卡片.",
					URL:  "https://open.feishu.cn/app/cli_c/bot",
					Why:  "A card path that is genuinely off shows up as Feishu error 200340.",
				}},
			}})

			_ = dispatch(context.Background(), h.d, []string{"setup"})
			out := h.stderr()
			for _, want := range append(tc.want, "Your message arrived", "200340") {
				if !strings.Contains(out, want) {
					t.Errorf("origin %s: the card report never says %q:\n%s", tc.origin, want, out)
				}
			}
			for _, bad := range tc.absent {
				if strings.Contains(out, bad) {
					t.Errorf("origin %s: the card report says %q, which does not hold on that path:\n%s",
						tc.origin, bad, out)
				}
			}
		})
	}
}

// TestSetupCardHedgeAgreesWithThePackagePartition: the CLI's hedge and the
// checklist step internal/setup emits are printed in the same paragraph, so a
// disagreement between them reads as one paragraph contradicting itself — "a
// button nobody pressed is by far the likeliest cause" above "the two really are
// indistinguishable from here".
//
// The CLI used to hand-copy the switch. It now asks Origin.PageConfigured, which
// is the same method stepCardTimeout branches on, and this asserts the rendering
// follows it for every value — including OriginUnknown and a value no origin has
// yet, which is the case a duplicated switch classifies in only one of the two
// places.
func TestSetupCardHedgeAgreesWithThePackagePartition(t *testing.T) {
	// One past the last defined origin: a seventh Origin is exactly what used to
	// be able to diverge between the two copies of this partition.
	for i := 0; i <= int(setup.OriginUpdated)+1; i++ {
		o := setup.Origin(i)
		var b strings.Builder
		writeCardHedge(&b, setup.Result{Origin: o})
		got := b.String()

		want, absent := "look identical from here", "likeliest cause"
		if o.PageConfigured() {
			want, absent = absent, want
		}
		if !strings.Contains(got, want) {
			t.Errorf("origin %s (PageConfigured=%v): the hedge never says %q:\n%s",
				o, o.PageConfigured(), want, got)
		}
		if strings.Contains(got, absent) {
			t.Errorf("origin %s (PageConfigured=%v): the hedge says %q, which the other branch owns:\n%s",
				o, o.PageConfigured(), absent, got)
		}
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
	h.d.NewSetup = func(string, setup.Progress, ...setup.Option) (SetupRunner, error) { return nil, boom }

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
		n := p.(setup.Narrator)
		p.Verification("https://accounts.feishu.cn/oauth/v1/app/registration?code=xyz", 600)
		n.Configured(setup.App{
			ID:      "cli_a1b2c3",
			Name:    "herdr-agent-e1",
			Origin:  setup.OriginRegistered,
			EnvPath: filepath.Join(dir, config.DotEnvFileName),
			OpenID:  "ou_owner",
		})
		p.Note("Message received. Credentials, bot and delivery mode are confirmed.")
		n.AwaitMessage(setup.App{ID: "cli_a1b2c3", Name: "herdr-agent-e1"}, 150*time.Second)
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
// exactly these callbacks.
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
	app := setup.App{
		ID:      "cli_a1b2c3",
		Name:    "herdr-agent-e1",
		Origin:  setup.OriginRegistered,
		EnvPath: "/Users/x/.herdr-agent/.env",
		OpenID:  "ou_owner",
	}
	p.Verification(url, 600)
	p.Configured(app)
	p.AwaitMessage(app, 150*time.Second)
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
		"permanent",                         // a new app cannot be deleted afterwards
		"pick it on that page",              // and picking an existing one is the alternative
		"--app <app_id>",                    // named, because that is the third option nobody found
		"cli_a1b2c3",                        // the app id
		`"herdr-agent-e1"`,                  // and the name Feishu actually gave it
		"/Users/x/.herdr-agent/.env",        // where the secret went
		"0600",                              // at what mode
		"ou_owner",                          //
		"allowed_open_ids",                  // and the file that decides who may drive the agents
		"/Users/x/.herdr-agent/config.toml", // named, because it is the one file a reader may have to edit
		"Message the bot in Feishu now",     // wait 1: what to do
		"search Feishu for that name",       // and how to find the bot
		"DIRECT message",                    // which kind of message finishes it
		"Waiting 150s",                      // and for how long
		"Press the button on the card",      // wait 2
		"Waiting 120s",
		"poll more slowly", // notes reach the user
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the narration never says %q:\n%s", want, got)
		}
	}
	for _, lie := range []string{
		// This page was opened without CreateOnly, so it either created the app or
		// handed back one the tenant already had. A run printed "created" for an app
		// that had existed since that morning.
		"created",
		// The pre-filled name is a guess the human may override on that page and
		// did: the app was called herdr-agent-e1 while this sentence said otherwise.
		"unless you changed the name",
		"you just confirmed",
		// The allowlist write happened earlier and carries no success signal into
		// this callback, and on --reregister it APPENDS. So the id may be neither
		// authorized nor alone, and "only" must attach to the file rather than to
		// the id: an operator rotating a leaked credential reads that and decides
		// the old id is gone.
		"ou_owner is now the only", "is the only", "only open_id",
	} {
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

// TestSetupNarratesEachOriginDifferently is the fix for the sentence this whole
// wave exists to remove. Five paths arrive at an app and only ONE of them may say
// "created": the confirmation page returns the same {client_id, client_secret}
// whether it made an app or handed back one the tenant already had, so a run that
// did not ask for create-only cannot know which happened — and one printed
// "App cli_aaf4… created." for an app that had existed since that morning.
func TestSetupNarratesEachOriginDifferently(t *testing.T) {
	const env = "/Users/x/.herdr-agent/.env"
	tests := []struct {
		name    string
		app     setup.App
		want    []string
		absent  []string
		secrecy bool // the run wrote a secret it received, so the 0600 line belongs
	}{
		{
			name:    "created",
			app:     setup.App{ID: "cli_new", Name: "herdr-agent", Origin: setup.OriginCreated, EnvPath: env},
			want:    []string{"was created", "permanent"},
			secrecy: true,
		},
		{
			name:    "registered",
			app:     setup.App{ID: "cli_page", Name: "herdr-agent-e1", Origin: setup.OriginRegistered, EnvPath: env},
			want:    []string{"is now configured", "cannot tell you which happened"},
			secrecy: true,
		},
		{
			name:    "updated",
			app:     setup.App{ID: "cli_old", Name: "herdr-agent-e1", Origin: setup.OriginUpdated, EnvPath: env},
			want:    []string{"already existed", "No new app was made"},
			secrecy: true,
		},
		{
			name: "adopted from one file",
			app: setup.App{ID: "cli_ad", Origin: setup.OriginAdopted, EnvPath: env,
				From: "/repo/.env"},
			want: []string{"already set up on this machine", "its credentials were in /repo/.env",
				"made no new app"},
		},
		{
			// The split pair: the bridge merges the two .env files key by key, so an
			// id in one and a secret in the other are one working pair — and the
			// sentence this replaced named the file that held the id as the file
			// that held both.
			name: "adopted from two files",
			app: setup.App{ID: "cli_ad", Origin: setup.OriginAdopted, EnvPath: env,
				From: "/Users/x/.herdr-agent/.env", FromSecret: "/repo/.env"},
			want: []string{"/Users/x/.herdr-agent/.env named it", "/repo/.env held its secret"},
		},
		{
			name:   "reused",
			app:    setup.App{ID: "cli_re", Name: "herdr-agent-e1", Origin: setup.OriginReused, EnvPath: env},
			want:   []string{"is already configured in " + env, "wrote nothing"},
			absent: []string{"you just confirmed", "confirmed"},
		},
		{
			// A Result from a path nobody classified must not borrow another path's
			// story, above all not the one that announces a new app.
			name: "unknown",
			app:  setup.App{ID: "cli_u", Origin: setup.OriginUnknown, EnvPath: env},
			want: []string{"did not record how it got there"},
		},
	}

	seen := map[string]string{}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var errb strings.Builder
			p := &termProgress{out: &strings.Builder{}, err: &errb, envPath: env,
				cfgPath: "/Users/x/.herdr-agent/config.toml"}
			p.Configured(tc.app)

			got := errb.String()
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("origin %s never says %q:\n%s", tc.app.Origin, want, got)
				}
			}
			for _, bad := range tc.absent {
				if strings.Contains(got, bad) {
					t.Errorf("origin %s claims %q, which that path cannot know:\n%s", tc.app.Origin, bad, got)
				}
			}
			// The rule with teeth: the word appears on ONE path, and not even as a
			// negation elsewhere, so "does this run claim a creation?" stays a
			// question the reader can answer by looking.
			if creates := strings.Contains(strings.ToLower(got), "creat"); creates != (tc.app.Origin == setup.OriginCreated) {
				t.Errorf("origin %s mentions creating = %v, want %v:\n%s",
					tc.app.Origin, creates, tc.app.Origin == setup.OriginCreated, got)
			}
			// The 0600 line is about a secret this run received and wrote. On the
			// adopt path internal/setup has already said where the pair came from,
			// and on the reuse path nothing was written at all.
			if wrote := strings.Contains(got, "0600"); wrote != tc.secrecy {
				t.Errorf("origin %s prints the .env/0600 line = %v, want %v:\n%s",
					tc.app.Origin, wrote, tc.secrecy, got)
			}
			if prev, dup := seen[got]; dup {
				t.Errorf("origin %s renders identically to %s; the five paths are five different\n"+
					"sentences or the reader cannot tell which one they are on:\n%s", tc.app.Origin, prev, got)
			}
			seen[got] = tc.name
		})
	}
}

// TestSetupAwaitMessageNamesTheBotOrAdmitsItCannot: the countdown is the worst
// possible moment to be searching Feishu for a bot that does not exist under
// that name — which is what the sentence this replaced sent one user off to do,
// while bot/v3/info had already answered herdr-agent-e1 in the same log.
func TestSetupAwaitMessageNamesTheBotOrAdmitsItCannot(t *testing.T) {
	tests := []struct {
		name   string
		app    setup.App
		want   []string
		absent []string
	}{
		{
			name: "named",
			app:  setup.App{ID: "cli_x", Name: "herdr-agent-e1"},
			want: []string{`"herdr-agent-e1"`, "cli_x", "search Feishu for that name"},
		},
		{
			name:   "nameless",
			app:    setup.App{ID: "cli_x"},
			want:   []string{"would not say what this bot is called", "cli_x"},
			absent: []string{"herdr-agent"}, // never the name we asked the page to pre-fill
		},
		{
			// AwaitInbound carries no app at all, which is why internal/setup
			// stopped calling it. The renderer must name no bot rather than one it
			// made up.
			name:   "no app at all",
			app:    setup.App{},
			want:   []string{"Look for the bot belonging to the app named above"},
			absent: []string{"herdr-agent", `""`},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var errb strings.Builder
			p := &termProgress{out: &strings.Builder{}, err: &errb}
			p.AwaitMessage(tc.app, 150*time.Second)

			got := errb.String()
			for _, want := range append(tc.want, "Waiting 150s", "DIRECT message", "notify_chat_id") {
				if !strings.Contains(got, want) {
					t.Errorf("the wait request never says %q:\n%s", want, got)
				}
			}
			for _, bad := range tc.absent {
				if strings.Contains(got, bad) {
					t.Errorf("the wait request says %q, which it cannot know:\n%s", bad, got)
				}
			}
		})
	}
}

// TestSetupProgressIsANarrator: internal/setup routes Configured and AwaitMessage
// only to a Progress that implements Narrator, and falls back to prose written
// without knowing the app — the prose this wave removed — for one that does not.
func TestSetupProgressIsANarrator(t *testing.T) {
	var p setup.Progress = &termProgress{out: &strings.Builder{}, err: &strings.Builder{}}
	if _, ok := p.(setup.Narrator); !ok {
		t.Fatal("termProgress is not a setup.Narrator, so the run cannot hand it the app it established")
	}
}

// TestSetupRetainedCallbacksDoNotLie: Registered and AwaitInbound survive only so
// this type still satisfies setup.Progress. Nothing calls them, and if anything
// ever does they must render what their arguments can actually support.
func TestSetupRetainedCallbacksDoNotLie(t *testing.T) {
	var errb strings.Builder
	p := &termProgress{out: &strings.Builder{}, err: &errb, envPath: "/Users/x/.herdr-agent/.env"}

	// Registered is reached only for a provable creation (CreateOnly was set), so
	// this is the one callback whose rendering may say "created".
	p.Registered("cli_made", "ou_owner")
	if !strings.Contains(errb.String(), "was created") {
		t.Errorf("Registered does not report the creation it is only ever sent for:\n%s", errb.String())
	}

	errb.Reset()
	p.AwaitInbound(150 * time.Second)
	if strings.Contains(errb.String(), "herdr-agent") {
		t.Errorf("AwaitInbound names a bot it was never told about:\n%s", errb.String())
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
		if got := f.ran(); len(got) != 1 || got[0] {
			t.Errorf("Run was called with reregister = %v, want [false]: a second app cannot be deleted", got)
		}
	})
}

// TestSetupFlagsParseInEitherOrder: this CLI permutes flags around positionals
// (see permute), and a mode that only works when it is written first is a mode
// most people will conclude does not work.
func TestSetupFlagsParseInEitherOrder(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want setupFlags
	}{
		{"nothing", nil, setupFlags{}},
		{"app then yes", []string{"--app", "cli_aaf76546b438dbfc", "--yes"},
			setupFlags{appID: "cli_aaf76546b438dbfc", yes: true}},
		{"yes then app", []string{"--yes", "--app", "cli_aaf76546b438dbfc"},
			setupFlags{appID: "cli_aaf76546b438dbfc", yes: true}},
		{"inline value", []string{"--app=cli_aaf76546b438dbfc"}, setupFlags{appID: "cli_aaf76546b438dbfc"}},
		{"single dash", []string{"-app", "cli_x1", "-yes"}, setupFlags{appID: "cli_x1", yes: true}},
		{"reregister then yes", []string{"--reregister", "--yes"}, setupFlags{reregister: true, yes: true}},
		{"yes then reregister", []string{"--yes", "--reregister"}, setupFlags{reregister: true, yes: true}},
		// A pasted id often arrives with the newline or space still attached.
		{"surrounding space", []string{"--app", "  cli_x1  "}, setupFlags{appID: "cli_x1"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			got, err := parseSetupFlags(h.d, tc.args)
			if err != nil {
				t.Fatalf("parseSetupFlags(%q): %v", tc.args, err)
			}
			if got != tc.want {
				t.Errorf("parseSetupFlags(%q) = %+v, want %+v", tc.args, got, tc.want)
			}
		})
	}
}

// TestSetupRefusesABadAppID: a malformed --app is a caller mistake — exit 2, not
// exit 1 — and it has to be refused before anything is constructed, because the
// real runner takes the bridge's single-instance lock and dials Feishu.
func TestSetupRefusesABadAppID(t *testing.T) {
	bad := []struct {
		value string
		// echoed says whether "was this value printed back" is a meaningful
		// question. It is not for a fragment of "cli_...", which the refusal itself
		// has to contain to say what an app id looks like.
		echoed bool
	}{
		{value: "cli"},
		{value: "cli_"},
		{value: "clx_abc", echoed: true},
		{value: "cli_abc-def", echoed: true},
		{value: "https://open.feishu.cn/app/cli_abc/bot", echoed: true},
		// The case this check exists for: the console lists App Secret directly
		// below App ID, and the secret must not reach a terminal, a log or a URL.
		{value: setupSecret, echoed: true},
	}
	for _, tc := range bad {
		value := tc.value
		t.Run(value, func(t *testing.T) {
			h := newHarness(t)
			f := &fakeSetupRunner{res: verifiedResult()}
			h.withSetup(t, f)

			err := dispatch(context.Background(), h.d, []string{"setup", "--app", value})
			if got := report(&h.errb, err); got != exitUsage {
				t.Fatalf("exit = %d, want %d (err = %v)", got, exitUsage, err)
			}
			if f.builds() != 0 {
				t.Error("the runner was constructed anyway; the real one locks the state dir and dials Feishu")
			}
			if len(f.ran()) != 0 {
				t.Error("the flow ran with an id that cannot be an app id")
			}
			if tc.echoed && strings.Contains(h.stderr(), value) {
				t.Errorf("the rejected value was echoed back; it may be the app secret:\n%s", h.stderr())
			}
			if !strings.Contains(h.stderr(), "cli_") {
				t.Errorf("the message does not say what an app id looks like:\n%s", h.stderr())
			}
		})
	}
}

// TestSetupRefusesAppAndReregisterTogether: "use exactly this app" and "make me
// another one" are opposite instructions, and honouring either silently is how a
// permanent app appears in a tenant that did not ask for one.
func TestSetupRefusesAppAndReregisterTogether(t *testing.T) {
	h := newHarness(t)
	f := &fakeSetupRunner{res: verifiedResult()}
	h.withSetup(t, f)

	err := dispatch(context.Background(), h.d, []string{"setup", "--app", "cli_x1", "--reregister"})
	if got := report(&h.errb, err); got != exitUsage {
		t.Fatalf("exit = %d, want %d (err = %v)", got, exitUsage, err)
	}
	if len(f.ran()) != 0 {
		t.Error("the flow ran on contradictory flags")
	}
	if !strings.Contains(h.stderr(), "pick one") {
		t.Errorf("the message does not say what to do about it:\n%s", h.stderr())
	}
}

// TestSetupPlanForDecidesWhoCanBeAsked. internal/setup asks two questions —
// which of two configured apps to use, and whether to keep waiting — and neither
// has a safe default: a guess points the bridge at a bot the user never messaged,
// and the symptom is silence. So the answer to "is there anybody there" decides
// whether they are questions at all, and the run says so up front.
func TestSetupPlanForDecidesWhoCanBeAsked(t *testing.T) {
	t.Run("a terminal is asked", func(t *testing.T) {
		h := newHarness(t)
		h.withTerminal("1\n")
		p := setupPlanFor(h.d, setupFlags{})
		if p.prompter == nil {
			t.Fatal("no prompter for a terminal: the two-app question would fail instead of being asked")
		}
		if p.why != "" {
			t.Errorf("explained away a question it can actually ask: %q", p.why)
		}
	})

	t.Run("a pipe is not", func(t *testing.T) {
		h := newHarness(t) // IsTTY is nil, In fails the test if read
		p := setupPlanFor(h.d, setupFlags{})
		if p.prompter != nil {
			t.Fatal("built a prompter for a pipe: reading it turns 'stop and say why' into an I/O error")
		}
		for _, want := range []string{"not a terminal", "--app <app_id>", "--reregister"} {
			if !strings.Contains(p.why, want) {
				t.Errorf("the non-interactive warning never mentions %q: %q", want, p.why)
			}
		}
	})

	t.Run("--yes is not, even at a terminal", func(t *testing.T) {
		h := newHarness(t)
		h.withTerminal("1\n")
		p := setupPlanFor(h.d, setupFlags{yes: true})
		if p.prompter != nil {
			t.Fatal("--yes built a prompter; it means never ask, for scripts and launchd")
		}
		if !strings.Contains(p.why, "--yes") {
			t.Errorf("the warning does not name the flag that caused it: %q", p.why)
		}
	})

	t.Run("--app is carried through", func(t *testing.T) {
		h := newHarness(t)
		p := setupPlanFor(h.d, setupFlags{appID: "cli_x1"})
		if p.reuseAppID != "cli_x1" {
			t.Errorf("reuseAppID = %q, want cli_x1", p.reuseAppID)
		}
		// One option per decision: never-ask, plus the pinned app. A prompter would
		// add a third, and this machine has no terminal.
		if got := len(p.options()); got != 2 {
			t.Errorf("options() = %d, want 2 (assume-yes and the reuse id)", got)
		}
	})
}

// TestSetupNonInteractiveWarningGivesEachQuestionItsOwnConsequence: the two
// questions do NOT end the same way, and the one sentence that used to cover both
// was false for the wait.
//
// Measured sequence: `setup` with stdin on a pipe, credentials fine, exactly one
// app configured, and the human does not message the bot within the inbound wait.
// offerAnotherWait returns false at !r.interactive() without asking anybody, the
// checklist is appended, Outcome is OutcomeCredentials with a NIL error, and the
// run exits 3. No error is produced, and no flag exists that would have made it
// wait longer — while the warning printed before all of that promised "the run
// stops and names the flag to pass". A script author who went looking for that
// flag was sent after something the code does not have.
func TestSetupNonInteractiveWarningGivesEachQuestionItsOwnConsequence(t *testing.T) {
	tests := []struct {
		name     string
		flags    setupFlags
		terminal bool
		lead     string
	}{
		{name: "a pipe", lead: "not a terminal"},
		{name: "--yes at a terminal", flags: setupFlags{yes: true}, terminal: true, lead: "--yes"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			if tc.terminal {
				h.withTerminal("")
			}
			why := setupPlanFor(h.d, tc.flags).why
			// Line breaks are layout, not meaning: the warning is hard-wrapped to
			// the terminal, and asserting phrases against the wrapped form would
			// make re-wrapping one clause look like deleting it.
			flat := strings.Join(strings.Fields(why), " ")
			for _, want := range []string{
				tc.lead,
				// The app question: an error, plus both ways out of it. The error
				// itself (internal/setup ErrAmbiguousApps) names the terminal and
				// --reregister, so those are what this may promise it names.
				"STOPS with an error",
				"re-run in a terminal",
				"--reregister",
				// --app is offered as this command's own advice — it makes the
				// question unreachable rather than answerable — not as a claim
				// about what the error text says.
				"--app <app_id>",
				// The wait: no error, no flag, and the exit it really reaches.
				"the wait is NOT extended, and no flag extends it",
				"exit 3",
			} {
				if !strings.Contains(flat, want) {
					t.Errorf("the warning never says %q:\n%s", want, why)
				}
			}
			// The retired promise, in both of its old spellings. Either one sends
			// the reader after a flag that would extend a wait; there is none.
			for _, lie := range []string{
				"each stops the run naming the flag",
				"or a wait runs out, the run stops and names the flag",
			} {
				if strings.Contains(flat, lie) {
					t.Errorf("the warning still promises %q, which holds for one question only:\n%s", lie, why)
				}
			}
		})
	}
}

// TestSetupHandsThePlanToTheFactory is the wiring assertion the two tests above
// cannot make: setupPlanFor is exercised on its own, and parseSetupFlags is
// exercised on its own, so without this one, dropping `plan.options()...` from
// the setup.New call would break every mode and no test would notice.
//
// It counts options rather than reading them because a setup.Option is a closure
// over *setup.Runner's unexported fields: from here they are opaque, and the
// count is the only thing this side of the boundary can observe.
func TestSetupHandsThePlanToTheFactory(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		terminal bool
		// want counts the decisions: never-ask always, plus a prompter when there
		// is a terminal, plus the pinned app when --app was given.
		want int
	}{
		{name: "bare run on a pipe", args: []string{"setup"}, want: 1},
		{name: "bare run at a terminal", args: []string{"setup"}, terminal: true, want: 2},
		{name: "--app on a pipe", args: []string{"setup", "--app", "cli_x1"}, want: 2},
		{name: "--app at a terminal", args: []string{"setup", "--app", "cli_x1"}, terminal: true, want: 3},
		{name: "--yes at a terminal", args: []string{"setup", "--yes"}, terminal: true, want: 1},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			f := &fakeSetupRunner{res: verifiedResult()}
			h.withSetup(t, f)
			if tc.terminal {
				h.withTerminal("")
			}
			if err := dispatch(context.Background(), h.d, tc.args); err != nil {
				t.Fatalf("setup: %v", err)
			}
			if got := f.options(); got != tc.want {
				t.Errorf("the factory got %d options, want %d: the flags did not reach setup.New", got, tc.want)
			}
		})
	}
}

// TestSetupSaysNothingWillBeAskedBeforeItMatters: the warning has to be on screen
// BEFORE the flow reaches a question it cannot ask, or the resulting error reads
// like a bug rather than like the flag the reader needs.
func TestSetupSaysNothingWillBeAskedBeforeItMatters(t *testing.T) {
	h := newHarness(t)
	f := &fakeSetupRunner{res: verifiedResult()}
	h.withSetup(t, f)
	f.emit = func(setup.Progress) {
		if !strings.Contains(h.stderr(), "not a terminal") {
			t.Errorf("the run started before saying nothing can be asked:\n%s", h.stderr())
		}
	}

	if err := dispatch(context.Background(), h.d, []string{"setup"}); err != nil {
		t.Fatalf("setup: %v", err)
	}
}

// TestSetupWritesTheOriginToStdout: a script that reads this payload has one
// question that matters — did my tenant just gain an app? — and "created" is the
// only value that answers it yes.
func TestSetupWritesTheOriginToStdout(t *testing.T) {
	h := newHarness(t)
	h.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome:   setup.OutcomeVerified,
		AppID:     "cli_a1b2c3",
		AppName:   "herdr-agent-e1",
		Origin:    setup.OriginReused,
		InboundOK: true,
		CardOK:    true,
	}})

	if err := dispatch(context.Background(), h.d, []string{"setup"}); err != nil {
		t.Fatalf("setup: %v", err)
	}
	for _, want := range []string{"app_id\tcli_a1b2c3", "app_name\therdr-agent-e1", "origin\treused"} {
		if !strings.Contains(h.stdout(), want) {
			t.Errorf("stdout is missing %q:\n%s", want, h.stdout())
		}
	}

	// A run that established no app must not emit an origin at all: `origin
	// unknown` invites a script to treat it as a value.
	h2 := newHarness(t)
	h2.withSetup(t, &fakeSetupRunner{res: setup.Result{Outcome: setup.OutcomeFailed}})
	_ = dispatch(context.Background(), h2.d, []string{"setup"})
	if strings.Contains(h2.stdout(), "origin") {
		t.Errorf("a failed run reported an origin:\n%s", h2.stdout())
	}

	// An app name is whatever the human typed on the confirmation page. A tab in
	// it would split one record into two, in the output a script parses.
	h3 := newHarness(t)
	h3.withSetup(t, &fakeSetupRunner{res: setup.Result{
		Outcome: setup.OutcomeVerified, AppID: "cli_x", AppName: "herdr\tagent\nbot",
		Origin: setup.OriginReused, InboundOK: true, CardOK: true,
	}})
	_ = dispatch(context.Background(), h3.d, []string{"setup"})
	if lines := strings.Count(strings.TrimSpace(h3.stdout()), "\n") + 1; lines != 3 {
		t.Errorf("stdout has %d records, want 3 (app_id, app_name, origin):\n%q", lines, h3.stdout())
	}
	if strings.Contains(h3.stdout(), "herdr\tagent") {
		t.Errorf("a tab inside the app name reached the payload:\n%q", h3.stdout())
	}
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

// TestSetupProseIsInterpolatedNotHandCopied reads this package's own source,
// because no runtime assertion can distinguish the two things it is here to
// distinguish.
//
// Two facts about the flow are stated in the CLI's prose and OWNED by
// internal/setup: the name the confirmation page is asked to pre-fill, and which
// origins had their capabilities granted by that page. Both were hand-copied
// duplicates of unexported values — a "herdr-agent" literal duplicating
// register.go's appName, and a switch duplicating Origin.pageConfigured. A
// duplicate agrees with its original right up until one of them is edited, and
// then it prints a sentence that is exactly as fluent as before and no longer
// true. Since the copies agree TODAY, output comparison cannot tell a sourced
// fact from a copied one; the reference is the only observable difference.
func TestSetupProseIsInterpolatedNotHandCopied(t *testing.T) {
	src, err := os.ReadFile("setup.go")
	if err != nil {
		t.Fatalf("read this package's source: %v", err)
	}
	for _, want := range []string{
		// The preset name, from the constant the package actually sends.
		"setup.AppPresetName",
		// The card-hedge partition, from the method internal/setup's own checklist
		// step branches on.
		".PageConfigured()",
	} {
		if !strings.Contains(string(src), want) {
			t.Errorf("setup.go no longer sources %s from internal/setup; a copy of it drifts silently", want)
		}
	}

	// And the sourced preset name really does reach the screen the human reads
	// while a stranger's URL is on it.
	var out, errb strings.Builder
	p := &termProgress{out: &out, err: &errb, envPath: "/x/.env", cfgPath: "/x/config.toml"}
	p.Verification("https://accounts.feishu.cn/oauth/v1/app/registration?code=xyz", 600)
	if !strings.Contains(errb.String(), setup.AppPresetName) {
		t.Errorf("the confirmation screen never says what the page will pre-fill (%q):\n%s",
			setup.AppPresetName, errb.String())
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
