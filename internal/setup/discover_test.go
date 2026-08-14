package setup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

// otherAppID is the second app on the machine. It differs from testAppID late in
// the string on purpose: the pair of ids this project actually hit
// (cli_aaf76546b438dbfc and cli_aaf4647d33f95be8) differ in the fourth
// character, which is exactly why the question has to carry names.
const (
	otherAppID   = "cli_a1b2c3d4e5f6zzzz"
	otherSecret  = "OtherSeCrEt-also-must-never-be-printed-98765"
	otherAppName = "herdr-agent"
)

// repoEnv puts a credential pair in a file outside the state directory and
// points the repository-root lookup at it, the way a checkout with a working
// .env looks to the bridge.
func repoEnv(t *testing.T, c credentials, extra string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), config.DotEnvFileName)
	body := extra
	if c.AppID != "" {
		body += config.EnvAppID + "=" + c.AppID + "\n"
	}
	if c.AppSecret != "" {
		body += config.EnvAppSecret + "=" + c.AppSecret + "\n"
	}
	write(t, path, body)
	stubRepoEnv(t, c, path)
	return path
}

// TestCredentialsOutsideTheStateDirAreAdoptedNotRefused.
//
// This is the run this wave exists for. A user with a working repository .env
// was told to move the file or create a second app, deleted the file instead,
// registered again, and ended up pointed at a different app than the one they
// had — while the obviously right answer, "reuse the app you just named", was
// not on the menu at all.
func TestCredentialsOutsideTheStateDirAreAdoptedNotRefused(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b)
	noRegister(t)
	repoPath := repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "# theirs\nOTHER=keep\n")
	// The state directory's .env already holds something unrelated, which the
	// adoption must not truncate: it is the operator's file, not ours.
	writeEnvFixture(t, dir, "# mine\nMINE=keep-me\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run returned an error for credentials it could simply adopt: %v", err)
	}
	if res.Origin != OriginAdopted {
		t.Errorf("Origin = %v, want adopted", res.Origin)
	}
	if !res.Reused || res.AppID != testAppID {
		t.Errorf("Reused=%v AppID=%q, want true and the app that was already configured", res.Reused, res.AppID)
	}
	if res.Outcome != OutcomeVerified {
		t.Errorf("Outcome = %v, want verified (steps: %+v)", res.Outcome, res.Steps)
	}
	if got := b.verifiedApp(); got != testAppID {
		t.Errorf("verification ran against %q, want the adopted app", got)
	}

	// The credentials are now in the file the bridge prefers, and the file's own
	// contents survived.
	state := readFile(t, filepath.Join(dir, config.DotEnvFileName))
	for _, want := range []string{
		config.EnvAppID + "=" + testAppID,
		config.EnvAppSecret + "=" + testSecret,
		"MINE=keep-me",
		"# mine",
	} {
		if !strings.Contains(state, want) {
			t.Errorf("%s missing from the state .env:\n%s", want, strings.ReplaceAll(state, testSecret, "<secret>"))
		}
	}

	// The file they came from is left exactly as it was: adopting is a copy, and
	// a command that edited a checkout's .env would be doing something nobody
	// asked for.
	repo := readFile(t, repoPath)
	if !strings.Contains(repo, "OTHER=keep") || !strings.Contains(repo, config.EnvAppID+"="+testAppID) {
		t.Errorf("the source file was modified:\n%s", strings.ReplaceAll(repo, testSecret, "<secret>"))
	}

	// And the human was told what happened, without being asked to do anything.
	text := p.text()
	if !strings.Contains(text, repoPath) || !strings.Contains(text, "Plan:") {
		t.Errorf("the run did not state its plan and where the credentials came from:\n%s", text)
	}
	for _, forbidden := range []string{"move it to", "--reregister to create a second app"} {
		if strings.Contains(text, forbidden) {
			t.Errorf("the run still lectures the user (%q):\n%s", forbidden, text)
		}
	}
}

// TestThePlanIsStatedBeforeAnythingElseHappens.
//
// A user should never watch this command discover a problem halfway through and
// abandon them at a prompt. Discovery is complete before the first line of
// output, so the first line of output can be the plan.
func TestThePlanIsStatedBeforeAnythingElseHappens(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, _ := newRun(t, b)
	okRegister(t)

	if _, err := r.Run(context.Background(), false); err != nil {
		t.Fatalf("Run: %v", err)
	}
	calls := p.snapshot()
	if len(calls) == 0 {
		t.Fatal("the run said nothing at all")
	}
	first, ok := calls[0].Args[0].(string)
	if calls[0].Method != "Note" || !ok || !strings.HasPrefix(first, "Plan:") {
		t.Fatalf("the first thing printed was %s(%v), want the plan", calls[0].Method, calls[0].Args)
	}
	if !strings.Contains(first, "create a new app, or pick one you already have") {
		t.Errorf("the plan does not say the confirmation page offers both, so the user still thinks they "+
			"have to have decided in advance: %q", first)
	}
}

// TestTwoAppsAskTheHuman: the one genuine ambiguity in the whole flow.
//
// Both answers point the bridge at a different bot, and one of them may be a bot
// the user has never messaged — so this is neither guessable nor refusable when
// there is somebody there to ask.
func TestTwoAppsAskTheHuman(t *testing.T) {
	cases := []struct {
		name       string
		answer     string
		wantApp    string
		wantOrigin Origin
		register   bool
	}{
		{"the repository one", "1", testAppID, OriginAdopted, false},
		{"the state directory one", "2", otherAppID, OriginReused, false},
		{"neither, register a new one", "n", testAppID, OriginRegistered, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
			prompt := &fakePrompter{answers: []string{tc.answer}}
			r, p, dir := newRun(t, b, WithPrompter(prompt))
			namesApps(t, map[string]string{testAppID: otherAppName, otherAppID: testAppName})
			if tc.register {
				okRegister(t)
			} else {
				noRegister(t)
			}
			repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
			writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

			res, err := r.Run(context.Background(), false)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if res.AppID != tc.wantApp {
				t.Errorf("AppID = %q, want %q", res.AppID, tc.wantApp)
			}
			if res.Origin != tc.wantOrigin {
				t.Errorf("Origin = %v, want %v", res.Origin, tc.wantOrigin)
			}
			if got := b.verifiedApp(); got != tc.wantApp {
				t.Errorf("verification ran against %q, want %q", got, tc.wantApp)
			}
			if got := len(prompt.questions()); got != 1 {
				t.Fatalf("%d questions were asked, want exactly the one about which app:\n%s", got, prompt.text())
			}

			// The question is answerable: names, ids, files, and which one is
			// live today.
			q := prompt.text()
			for _, want := range []string{otherAppName, testAppName, testAppID, otherAppID,
				"the bridge uses this one", "or n to register a new app"} {
				if !strings.Contains(q, want) {
					t.Errorf("the question does not mention %q:\n%s", want, q)
				}
			}
			if strings.Contains(q, testSecret) || strings.Contains(q, otherSecret) {
				t.Fatal("a question carried an app secret")
			}
			if strings.Contains(p.text(), testSecret) || strings.Contains(p.text(), otherSecret) {
				t.Fatal("the narration carried an app secret while two were armed")
			}

			// Whatever was chosen is what the bridge will load next time.
			state, err := readCredentials(filepath.Join(dir, config.DotEnvFileName))
			if err != nil {
				t.Fatalf("read the state .env: %v", err)
			}
			if state.AppID != tc.wantApp {
				t.Errorf("the state .env still names %q, so the next run faces the same fork", state.AppID)
			}
		})
	}
}

// TestATypoCostsOneKeypressNotTheRun.
//
// There is no safe default for this question, so a bare enter cannot be taken as
// an answer — but ending the run over it would send the user back to the start of
// a command that has already done everything else right.
func TestATypoCostsOneKeypressNotTheRun(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	prompt := &fakePrompter{answers: []string{"", "2"}}
	r, _, dir := newRun(t, b, WithPrompter(prompt))
	noRegister(t)
	repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run gave up after one unusable answer: %v", err)
	}
	if res.AppID != otherAppID {
		t.Errorf("AppID = %q, want the app named by the second answer", res.AppID)
	}
	qs := prompt.questions()
	if len(qs) != 2 {
		t.Fatalf("%d questions, want the original plus one re-ask:\n%s", len(qs), prompt.text())
	}
	if !strings.Contains(qs[1], "Answer 1-2") {
		t.Errorf("the re-ask does not say what a valid answer looks like: %q", qs[1])
	}

	// And a second unusable answer stops rather than looping forever.
	prompt2 := &fakePrompter{answers: []string{"", "maybe"}}
	r2, _, dir2 := newRun(t, &fakeBot{}, WithPrompter(prompt2))
	noRegister(t)
	repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	writeEnvFixture(t, dir2, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

	if _, err := r2.Run(context.Background(), false); err == nil {
		t.Error("Run accepted two unusable answers")
	}
	if len(prompt2.questions()) != 2 {
		t.Errorf("%d questions for two unusable answers, want 2", len(prompt2.questions()))
	}
}

// TestOneAppInTwoPlacesIsNotAQuestion: same id in both files is not ambiguous,
// it is just the state directory winning, exactly as config.loadDotEnv resolves
// it.
func TestOneAppInTwoPlacesIsNotAQuestion(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	prompt := &fakePrompter{answers: []string{"1"}}
	r, _, dir := newRun(t, b, WithPrompter(prompt))
	noRegister(t)
	repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(prompt.questions()) != 0 {
		t.Errorf("a question was asked about one single app:\n%s", prompt.text())
	}
	if res.Origin != OriginReused {
		t.Errorf("Origin = %v, want reused", res.Origin)
	}
}

// TestNonInteractiveRunsNeverPrompt. Guessing which app a script meant is worse
// than stopping: the wrong guess points the bridge at a bot nobody has messaged,
// and the symptom is silence.
func TestNonInteractiveRunsNeverPrompt(t *testing.T) {
	cases := []struct {
		name string
		opts []Option
	}{
		{"no terminal", nil},
		{"--yes", []Option{WithAssumeYes(true)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBot{}
			prompt := &fakePrompter{answers: []string{"1"}}
			opts := tc.opts
			if tc.name == "--yes" {
				// A prompter IS available here; --yes must still not use it.
				opts = append(opts, WithPrompter(prompt))
			}
			r, _, dir := newRun(t, b, opts...)
			noRegister(t)
			repoPath := repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
			writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

			_, err := r.Run(context.Background(), false)
			if !errors.Is(err, ErrAmbiguousApps) {
				t.Fatalf("Run err = %v, want ErrAmbiguousApps", err)
			}
			if len(prompt.questions()) != 0 {
				t.Errorf("a question was asked without a terminal:\n%s", prompt.text())
			}
			// The error is actionable without being a lecture: both files, both
			// apps, and the two ways forward.
			for _, want := range []string{repoPath, testAppID, otherAppID, "in a terminal", "--reregister"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("the error does not mention %q: %v", want, err)
				}
			}
			if b.verifiedApp() != "" {
				t.Error("a client was built for an app nobody chose")
			}
		})
	}
}

// TestAFailedNameLookupDoesNotInventAName.
//
// The name is fetched, never assumed. appName ("herdr-agent") is only what we
// asked the confirmation page to pre-fill, and the human is free to change it on
// that page — which is how a run came to tell its user to look for a bot that did
// not exist.
func TestAFailedNameLookupDoesNotInventAName(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, _ := newRun(t, b)
	okRegister(t)
	stubAppName(t, func(context.Context, string, string) (string, error) {
		return "", errors.New("code 99991672: no permission")
	})

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.AppName != "" {
		t.Errorf("AppName = %q after a failed lookup; a name must be observed or absent", res.AppName)
	}
	text := p.text()
	if strings.Contains(text, `is called "`) {
		t.Errorf("the run quoted a bot name it never fetched:\n%s", text)
	}
	if !strings.Contains(text, "would not say what app") {
		t.Errorf("the run did not say the name could not be fetched:\n%s", text)
	}
	if !strings.Contains(text, res.AppID) {
		t.Errorf("with no name available, the id is the only handle the user has, and it is missing:\n%s", text)
	}
}

// TestAFailedNameLookupStillLetsTheHumanChoose: the two-app question degrades to
// ids and a reason, and still offers every answer.
func TestAFailedNameLookupStillLetsTheHumanChoose(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	prompt := &fakePrompter{answers: []string{"1"}}
	r, _, dir := newRun(t, b, WithPrompter(prompt))
	noRegister(t)
	stubAppName(t, func(_ context.Context, appID, _ string) (string, error) {
		if appID == testAppID {
			return "", errors.New("connection refused")
		}
		return testAppName, nil
	})
	repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

	if _, err := r.Run(context.Background(), false); err != nil {
		t.Fatalf("Run: %v", err)
	}
	q := prompt.text()
	if !strings.Contains(q, "name unavailable") || !strings.Contains(q, "connection refused") {
		t.Errorf("the question does not admit which name is missing or why:\n%s", q)
	}
	if !strings.Contains(q, testAppID) || !strings.Contains(q, testAppName) {
		t.Errorf("the question lost either the unnamed app's id or the named app's name:\n%s", q)
	}
	if strings.Contains(q, appName+"  ") {
		t.Errorf("the pre-filled default name was used as a stand-in for the missing one:\n%s", q)
	}
}

// TestHalfACredentialReconfirmsTheSameApp.
//
// An app id with no secret used to be a refusal. Feishu shows a secret once, so
// the secret is genuinely gone — but the app is not, and the update flow gets a
// working secret for THAT app instead of leaving a second one in the tenant.
func TestHalfACredentialReconfirmsTheSameApp(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b)
	var opts *registration.Options
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		opts = o
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run refused a recoverable half credential: %v", err)
	}
	if opts == nil {
		t.Fatal("no confirmation page was opened at all")
	}
	if opts.AppID != testAppID {
		t.Errorf("Options.AppID = %q, want the app already named on disk: without it the page creates a "+
			"second app that no API deletes", opts.AppID)
	}
	if opts.CreateOnly {
		t.Error("CreateOnly was set on an update flow; the platform gives the create flow precedence, so " +
			"this would have made a new app instead of configuring the named one")
	}
	if res.Origin != OriginUpdated {
		t.Errorf("Origin = %v, want updated", res.Origin)
	}
	if !strings.Contains(p.text(), "No new app was made") {
		t.Errorf("the run did not say that no second app was made:\n%s", p.text())
	}
}

// TestReuseAppIDWithTheSecretOnDiskOpensNoPage: nothing to confirm, so nobody is
// asked to confirm anything.
func TestReuseAppIDWithTheSecretOnDiskOpensNoPage(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	prompt := &fakePrompter{answers: []string{"1"}}
	r, _, dir := newRun(t, b, WithPrompter(prompt), WithReuseAppID(otherAppID))
	noRegister(t) // fails the test if the confirmation page is opened
	namesApps(t, map[string]string{testAppID: otherAppName, otherAppID: testAppName})
	repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.AppID != otherAppID || res.Origin != OriginReused {
		t.Errorf("AppID=%q Origin=%v, want the pinned app, reused", res.AppID, res.Origin)
	}
	if len(prompt.questions()) != 0 {
		t.Errorf("the run asked which app to use after being told which app to use:\n%s", prompt.text())
	}
	if got := b.verifiedApp(); got != otherAppID {
		t.Errorf("verification ran against %q, want the pinned app", got)
	}
}

// TestReuseAppIDWithoutASecretRunsTheUpdateFlow.
func TestReuseAppIDWithoutASecretRunsTheUpdateFlow(t *testing.T) {
	const handMade = "cli_madeInTheConsole99"
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b, WithReuseAppID(handMade))
	var opts *registration.Options
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		opts = o
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return &registration.RegisterAppResult{
			ClientID: handMade, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})
	namesApps(t, map[string]string{handMade: testAppName})

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if opts == nil {
		t.Fatal("no confirmation page was opened, so nothing granted this app anything")
	}
	if opts.AppID != handMade {
		t.Errorf("Options.AppID = %q, want %q", opts.AppID, handMade)
	}
	if opts.CreateOnly {
		t.Error("CreateOnly was set, which the platform lets win over AppID: this run would have created a " +
			"new app rather than configuring the requested one")
	}
	if res.Origin != OriginUpdated {
		t.Errorf("Origin = %v, want updated", res.Origin)
	}
	if got := readFile(t, filepath.Join(dir, config.DotEnvFileName)); !strings.Contains(got, handMade) {
		t.Errorf("the pinned app was not written to the state .env:\n%s", strings.ReplaceAll(got, testSecret, "<secret>"))
	}
	if !strings.Contains(p.text(), handMade) {
		t.Errorf("the plan never named the app it was opening the page for:\n%s", p.text())
	}
}

// TestAMalformedReuseAppIDIsRefusedBeforeAnyCall.
//
// The console lists App ID directly above App Secret, so pasting them transposed
// is a normal mistake — and this value would otherwise travel into a
// confirmation URL and every console link built from it.
func TestAMalformedReuseAppIDIsRefusedBeforeAnyCall(t *testing.T) {
	for _, bad := range []string{testSecret, "https://open.feishu.cn/app/cli_x", "cli_has spaces", "cli_"} {
		t.Run(bad, func(t *testing.T) {
			b := &fakeBot{}
			r, _, _ := newRun(t, b, WithReuseAppID(bad))
			noRegister(t)
			stubAppName(t, func(context.Context, string, string) (string, error) {
				t.Error("Feishu was asked about an id that cannot be an app id")
				return "", errors.New("must not be called")
			})

			_, err := r.Run(context.Background(), false)
			if !errors.Is(err, ErrMalformedAppID) {
				t.Fatalf("Run err = %v, want ErrMalformedAppID", err)
			}
			// "cli_" is excluded from the echo check because the sentinel names
			// the expected shape ("expected cli_..."), not the value: every
			// other case here would be a real leak.
			if bad != "cli_" && strings.Contains(err.Error(), bad) {
				t.Error("the error echoed the value, which may be an app secret")
			}
			if b.verifiedApp() != "" {
				t.Error("a client was built for a malformed id")
			}
		})
	}
}

// TestAnEmptyReuseAppIDIsNoPinAtAll: whitespace is not a request, so the run
// falls through to its ordinary plan rather than refusing.
func TestAnEmptyReuseAppIDIsNoPinAtAll(t *testing.T) {
	r, _, _ := newRun(t, nil, WithReuseAppID("   "))
	if r.reuseAppID != "" {
		t.Errorf("reuseAppID = %q, want it trimmed away", r.reuseAppID)
	}
}

// TestReregisterCreatesAndSaysSo. --reregister is the one path that may print
// "created", and CreateOnly is what makes that true: without it the page can hand
// back an app the tenant already has, which is precisely how a run came to
// announce the creation of a two-hour-old app.
func TestReregisterCreatesAndSaysSo(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b)
	var opts *registration.Options
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		opts = o
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})
	writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

	res, err := r.Run(context.Background(), true)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if opts == nil || !opts.CreateOnly {
		t.Fatalf("CreateOnly was not set for --reregister, so the page could have returned an existing app "+
			"and this run would still have reported a creation: %+v", opts)
	}
	if opts.AppID != "" {
		t.Errorf("Options.AppID = %q on a create-only flow", opts.AppID)
	}
	if res.Origin != OriginCreated {
		t.Errorf("Origin = %v, want created", res.Origin)
	}
	if !p.called("Registered") {
		t.Error("Progress.Registered was not called on the one path where a creation is a fact")
	}
	if !strings.Contains(p.text(), "no API we could find deletes one") {
		t.Errorf("the run did not repeat that the previous app stays:\n%s", p.text())
	}
}

// TestAnUnwritableStateDirectoryStopsTheRunBeforeItCreatesAnApp.
//
// Feishu shows an app secret exactly once. Discovering that .env cannot be
// written AFTER the confirmation page means a permanent app whose only secret is
// already lost.
func TestAnUnwritableStateDirectoryStopsTheRunBeforeItCreatesAnApp(t *testing.T) {
	b := &fakeBot{}
	r, p, dir := newRun(t, b)
	noRegister(t)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	_, err := r.Run(context.Background(), false)
	if err == nil {
		t.Fatal("Run proceeded with a state directory it cannot write")
	}
	if !strings.Contains(err.Error(), "not writable") {
		t.Errorf("the error does not say what is wrong: %v", err)
	}
	if p.called("Verification") {
		t.Error("a confirmation link was shown before checking the secret would have somewhere to go")
	}
}

// TestDiscoveryResolvesCredentialsTheWayTheBridgeDoes.
//
// config.loadDotEnv merges the two files KEY BY KEY, state directory winning, so
// the pair the bridge authenticates with is not always a pair that appears in any
// one file. Verifying anything other than that pair would prove something about
// credentials the bridge is never going to use — the exact failure mode this
// command exists to eliminate.
func TestDiscoveryResolvesCredentialsTheWayTheBridgeDoes(t *testing.T) {
	cases := []struct {
		name       string
		repo       credentials
		state      string
		wantSecret string
	}{
		{
			name:       "the id is in one file and the secret in the other",
			repo:       credentials{AppSecret: testSecret},
			state:      config.EnvAppID + "=" + testAppID + "\n",
			wantSecret: testSecret,
		},
		{
			name:       "the state directory overrides a stale secret next to the id",
			repo:       credentials{AppID: testAppID, AppSecret: otherSecret},
			state:      config.EnvAppSecret + "=" + testSecret + "\n",
			wantSecret: testSecret,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
			r, _, dir := newRun(t, b)
			noRegister(t)
			repoEnv(t, tc.repo, "")
			writeEnvFixture(t, dir, tc.state)

			res, err := r.Run(context.Background(), false)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if res.AppID != testAppID {
				t.Errorf("AppID = %q", res.AppID)
			}
			if b.builtSecret != tc.wantSecret {
				t.Error("the run verified a pair the bridge would not have loaded")
			}
			// Both halves now live in the file the bridge prefers.
			got, err := readCredentials(filepath.Join(dir, config.DotEnvFileName))
			if err != nil {
				t.Fatalf("read the state .env: %v", err)
			}
			if !got.complete() || got.AppSecret != tc.wantSecret {
				t.Errorf("the state .env does not hold the resolved pair (complete=%v)", got.complete())
			}
		})
	}
}

// TestASplitPairIsNarratedPerKey.
//
// Reproduced from the fixture above: the repository .env holds only
// FEISHU_APP_SECRET and <stateDir>/.env only FEISHU_APP_ID. That is one working
// pair as far as the bridge is concerned, and the run described it as
// "credentials in <stateDir>/.env … so copy them into <stateDir>/.env" — naming
// the file that never held the secret, and telling the user it was copying a file
// into itself, while the file that did hold it went unmentioned. The bytes were
// right; only the prose lied.
func TestASplitPairIsNarratedPerKey(t *testing.T) {
	cases := []struct {
		name  string
		repo  credentials
		state string
		// idInState is where each half is, and therefore what every sentence
		// about this app has to attribute to which file.
		idInState bool
	}{
		{
			name:      "the id is in the state file, the secret in the repository",
			repo:      credentials{AppSecret: testSecret},
			state:     config.EnvAppID + "=" + testAppID + "\n",
			idInState: true,
		},
		{
			name:      "the id is in the repository, the secret in the state file",
			repo:      credentials{AppID: testAppID, AppSecret: otherSecret},
			state:     config.EnvAppSecret + "=" + testSecret + "\n",
			idInState: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
			r, p, dir := newRun(t, b)
			noRegister(t)
			repoPath := repoEnv(t, tc.repo, "")
			writeEnvFixture(t, dir, tc.state)
			stateEnv := filepath.Join(dir, config.DotEnvFileName)

			idFile, secretFile := repoPath, stateEnv
			if tc.idInState {
				idFile, secretFile = stateEnv, repoPath
			}

			res, err := r.Run(context.Background(), false)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if res.Origin != OriginAdopted {
				t.Fatalf("Origin = %v, want adopted", res.Origin)
			}

			// Every sentence about this app names both files, and none of them
			// claims a copy out of the destination into itself.
			checked := 0
			for _, c := range p.snapshot() {
				if c.Method != "Note" {
					continue
				}
				msg, _ := c.Args[0].(string)
				if !strings.Contains(msg, "Plan:") && !strings.Contains(msg, "mode 0600") &&
					!strings.Contains(msg, "already set up on this machine") {
					continue
				}
				checked++
				for _, want := range []string{idFile, secretFile} {
					if !strings.Contains(msg, want) {
						t.Errorf("%q does not name %s, and the pair is split across the two", msg, want)
					}
				}
				if strings.Contains(msg, "copy them into") || strings.Contains(msg, "from "+stateEnv+" into "+stateEnv) {
					t.Errorf("the run claims to copy a file into itself: %q", msg)
				}
				if strings.Contains(msg, "credentials were in "+secretFile) ||
					strings.Contains(msg, "credentials were in "+idFile) {
					t.Errorf("one file is credited with a pair that was split across two: %q", msg)
				}
			}
			// The plan, the write and the summary all describe this app; a filter
			// that matched fewer would make the loop above pass by not running.
			if checked < 3 {
				t.Errorf("only %d of the sentences about this app were checked:\n%s", checked, p.text())
			}
		})
	}
}

// TestAdoptionNeverClaimsToCopyAFileIntoItself pins the four shapes a split pair
// can take, including the one planFor cannot currently produce: a sentence that
// is only true by accident of the caller is the shape this wave is removing.
func TestAdoptionNeverClaimsToCopyAFileIntoItself(t *testing.T) {
	const stateEnv, repo = "/state/.env", "/repo/.env"
	cases := []struct {
		name  string
		c     candidate
		names []string
	}{
		{"the id at the destination, the secret elsewhere",
			candidate{AppID: testAppID, Path: stateEnv, SecretPath: repo}, []string{stateEnv, repo}},
		{"the secret at the destination, the id elsewhere",
			candidate{AppID: testAppID, Path: repo, SecretPath: stateEnv}, []string{stateEnv, repo}},
		{"both halves in one other file",
			candidate{AppID: testAppID, Path: repo, SecretPath: repo}, []string{stateEnv, repo}},
		{"both halves already at the destination",
			candidate{AppID: testAppID, Path: stateEnv, SecretPath: stateEnv}, []string{stateEnv}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, got := range []string{adoptSentence(tc.c, stateEnv), adoptedNote(tc.c, stateEnv)} {
				for _, want := range tc.names {
					if !strings.Contains(got, want) {
						t.Errorf("%q does not name %s", got, want)
					}
				}
				if strings.Contains(got, "from "+stateEnv+" into "+stateEnv) ||
					strings.Contains(got, "in "+stateEnv+", so copy them into "+stateEnv) {
					t.Errorf("the sentence claims to copy a file into itself: %q", got)
				}
			}
		})
	}
}

// TestTheTwoAppQuestionIsAnnouncedBeforeTheLookups.
//
// Resolving both names costs up to 2 × nameTimeout and they are the first network
// calls of the whole run. Without a line before them, the opening act of the one
// command whose thesis is "state the plan before acting" is twenty seconds of
// silence that a stalled network makes indistinguishable from a hang.
func TestTheTwoAppQuestionIsAnnouncedBeforeTheLookups(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	prompt := &fakePrompter{answers: []string{"1"}}
	r, p, dir := newRun(t, b, WithPrompter(prompt))
	noRegister(t)

	said := -1
	names := map[string]string{testAppID: otherAppName, otherAppID: testAppName}
	stubAppName(t, func(_ context.Context, appID, _ string) (string, error) {
		if said < 0 {
			said = len(p.snapshot())
		}
		return names[appID], nil
	})
	repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

	if _, err := r.Run(context.Background(), false); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if said <= 0 {
		t.Fatal("the first identity lookup ran before anything was printed, so the wait is unaccounted for")
	}
	first, _ := p.snapshot()[0].Args[0].(string)
	if !strings.Contains(first, "asking Feishu what they are called") || !strings.Contains(first, "2 apps") {
		t.Errorf("the line before the lookups does not say what is being waited for: %q", first)
	}
}

// TestAnInvalidChoiceIsNeverEchoed.
//
// An app id is a valid answer to that question, the console lists App ID directly
// above App Secret, and choose() already refuses to echo --reuse-app-id for
// exactly that reason. The same paste mistake lands here.
func TestAnInvalidChoiceIsNeverEchoed(t *testing.T) {
	prompt := &fakePrompter{answers: []string{"", testSecret}}
	r, p, dir := newRun(t, &fakeBot{}, WithPrompter(prompt))
	noRegister(t)
	repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	writeEnvFixture(t, dir, config.EnvAppID+"="+otherAppID+"\n"+config.EnvAppSecret+"="+otherSecret+"\n")

	_, err := r.Run(context.Background(), false)
	if err == nil {
		t.Fatal("Run accepted an answer that is not one of the choices")
	}
	if strings.Contains(err.Error(), testSecret) {
		t.Errorf("the error echoed the answer, which may be a secret pasted from the console: %v", err)
	}
	if !strings.Contains(err.Error(), "answer 1-2") {
		t.Errorf("the error does not say what a valid answer looks like: %v", err)
	}
	if strings.Contains(p.text(), testSecret) {
		t.Error("the narration carried the pasted value")
	}
}

// TestRetryOffersOneMoreWaitPerAcceptance.
//
// Everything before this point is done and correct; the only thing that failed
// is that a human was not looking at their phone. Re-running the whole command
// for that is how a working setup gets abandoned.
func TestRetryOffersOneMoreWaitPerAcceptance(t *testing.T) {
	shortWaits(t, 40*time.Millisecond)
	b := &fakeBot{} // nothing ever arrives
	prompt := &fakePrompter{answers: []string{"", "q"}}
	r, p, _ := newRun(t, b, WithPrompter(prompt))
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := len(prompt.questions()); got != 2 {
		t.Fatalf("%d retry questions, want 2 (one accepted, one declined):\n%s", got, prompt.text())
	}
	for _, q := range prompt.questions() {
		if !strings.Contains(q, "press enter to wait again") || !strings.Contains(q, "q to stop") {
			t.Errorf("the retry question does not offer both answers: %q", q)
		}
	}
	// One wait per acceptance, and no more: two requests for a message, the
	// original plus the one retry.
	if waits := waitRequests(p); waits != 2 {
		t.Errorf("%d waits for one accepted retry, want 2:\n%s", waits, p.text())
	}
	if res.Outcome != OutcomeCredentials || res.InboundOK {
		t.Errorf("Outcome=%v InboundOK=%v after the human gave up", res.Outcome, res.InboundOK)
	}
	if len(res.Steps) == 0 {
		t.Error("the checklist promised by the question was never produced")
	}
}

// TestRetryIsSkippedWithoutATerminal: a script cannot press enter, and a
// question nobody can answer is a hang.
func TestRetryIsSkippedWithoutATerminal(t *testing.T) {
	shortWaits(t, 40*time.Millisecond)
	b := &fakeBot{}
	r, p, _ := newRun(t, b) // no prompter: stdin is not a terminal
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if waits := waitRequests(p); waits != 1 {
		t.Errorf("%d waits without a terminal, want exactly 1:\n%s", waits, p.text())
	}
	if len(res.Steps) == 0 {
		t.Error("no checklist was produced")
	}
}

// TestCardRetryAlsoOffersOneMoreWait: the card is still live and still in the
// chat, so another wait costs nothing but the wait.
func TestCardRetryAlsoOffersOneMoreWait(t *testing.T) {
	shortWaits(t, 40*time.Millisecond)
	b := &fakeBot{deliver: msgs(p2p("hello"))} // message arrives, button never pressed
	prompt := &fakePrompter{answers: []string{"", "q"}}
	r, p, _ := newRun(t, b, WithPrompter(prompt))
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.InboundOK || res.CardOK {
		t.Fatalf("InboundOK=%v CardOK=%v, want true/false", res.InboundOK, res.CardOK)
	}
	if got := len(prompt.questions()); got != 2 {
		t.Fatalf("%d questions, want 2:\n%s", got, prompt.text())
	}
	cards := 0
	for _, c := range p.snapshot() {
		if c.Method == "AwaitCard" {
			cards++
		}
	}
	if cards != 2 {
		t.Errorf("%d card waits for one accepted retry, want 2", cards)
	}
	// The card was sent once and disarmed once, no matter how many waits.
	if len(b.sent()) != 1 {
		t.Errorf("%d cards were sent; a retry must not post another one", len(b.sent()))
	}
	if len(b.updated()) != 1 {
		t.Errorf("the card was updated %d times, want 1", len(b.updated()))
	}
}

// shortWaits shrinks the two human waits for a test.
//
// The context deadline cannot do this: the first wait always consumes whatever is
// left of it (effectiveWait), so a test that shortened the context would only
// ever see one wait and could not reach the retry at all.
func shortWaits(t *testing.T, d time.Duration) {
	t.Helper()
	prevIn, prevCard := inboundTimeout, cardTimeout
	inboundTimeout, cardTimeout = d, d
	t.Cleanup(func() { inboundTimeout, cardTimeout = prevIn, prevCard })
}
