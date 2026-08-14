package setup

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/larksuite/oapi-sdk-go/v3/scene/registration"
)

// claimsCreation reports whether a sentence ASSERTS that an app was created.
//
// The hedge on the registered path ("may have created it, or you may have picked
// an app you already had") is not such a claim — it is the whole point of that
// path, since the platform returns the same result either way. Anything else
// containing the word is an assertion the code cannot back.
func claimsCreation(s string) bool {
	return strings.Contains(s, "created") && !strings.Contains(s, "may have created")
}

// TestNarrationClaimsOnlyWhatTheOriginEstablishes.
//
// Every defect this wave fixes is the same defect: text asserting something the
// code does not know. This is that rule as a test.
func TestNarrationClaimsOnlyWhatTheOriginEstablishes(t *testing.T) {
	app := App{
		ID:      testAppID,
		Name:    testAppName,
		EnvPath: "/state/.env",
		From:    "/repo/.env",
		OpenID:  testOpenID,
	}
	cases := []struct {
		origin      Origin
		wantCreated bool
		// confirmable is false for the paths on which no confirmation page was
		// opened: nothing was confirmed, so nothing may be described as
		// confirmed.
		confirmable bool
	}{
		{OriginCreated, true, true},
		{OriginRegistered, false, true},
		{OriginUpdated, false, true},
		{OriginAdopted, false, false},
		{OriginReused, false, false},
	}

	for _, tc := range cases {
		t.Run(tc.origin.String(), func(t *testing.T) {
			a := app
			a.Origin = tc.origin
			whole := strings.Join(configuredNotes(a), "\n")

			if got := claimsCreation(whole); got != tc.wantCreated {
				t.Errorf("claims a creation = %v, want %v:\n%s", got, tc.wantCreated, whole)
			}
			if strings.Contains(whole, "just confirmed") {
				t.Errorf("%q reached the narration; it was reproduced on the reuse path, where nothing was "+
					"confirmed at all:\n%s", "just confirmed", whole)
			}
			if !tc.confirmable && strings.Contains(whole, "confirmed") {
				t.Errorf("the %s path describes something as confirmed, but no confirmation page was opened:\n%s",
					tc.origin, whole)
			}
			// Whatever else it says, it says WHICH app, by the name Feishu gave
			// and never by the one we asked the page to pre-fill.
			if !strings.Contains(whole, testAppID) || !strings.Contains(whole, testAppName) {
				t.Errorf("the narration does not identify the app:\n%s", whole)
			}
			if a.Origin == OriginAdopted && !strings.Contains(whole, a.From) {
				t.Errorf("the adopted path does not say where the credentials came from:\n%s", whole)
			}
		})
	}
}

// TestNarrationWithoutANameSaysSo: an app whose name could not be fetched is
// named by its id and an admission, never by a guess.
func TestNarrationWithoutANameSaysSo(t *testing.T) {
	for _, o := range []Origin{OriginCreated, OriginRegistered, OriginUpdated, OriginAdopted, OriginReused} {
		whole := strings.Join(configuredNotes(App{ID: testAppID, Origin: o, EnvPath: "/state/.env"}), "\n")
		if !strings.Contains(whole, testAppID) {
			t.Errorf("%s: the id is missing, leaving the user with no handle at all:\n%s", o, whole)
		}
		if !strings.Contains(whole, "did not tell us its name") {
			t.Errorf("%s: the missing name is not admitted:\n%s", o, whole)
		}
		if strings.Contains(whole, appName) {
			t.Errorf("%s: the pre-filled default name was printed as if it were the app's name:\n%s", o, whole)
		}
	}
}

// TestRegisteredFiresOnlyWhenSomethingWasCreated.
//
// Progress.Registered is the one callback a caller cannot render without
// asserting a creation — the only implementation that exists prints "App <id>
// created." — so it must not fire on a path where no creation is provable. This
// is the "✓ App cli_aaf4647d33f95be8 created." line, which was printed for an app
// that had existed since that morning.
func TestRegisteredFiresOnlyWhenSomethingWasCreated(t *testing.T) {
	cases := []struct {
		name       string
		reregister bool
		setup      func(t *testing.T, dir string)
		wantOrigin Origin
	}{
		{
			name:       "a fresh registration",
			wantOrigin: OriginRegistered,
			setup:      func(t *testing.T, _ string) { okRegister(t) },
		},
		{
			name:       "reusing what is already in the state directory",
			wantOrigin: OriginReused,
			setup: func(t *testing.T, dir string) {
				noRegister(t)
				writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")
			},
		},
		{
			name:       "adopting credentials from elsewhere",
			wantOrigin: OriginAdopted,
			setup: func(t *testing.T, _ string) {
				noRegister(t)
				repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
			},
		},
		{
			name:       "deliberately creating a second app",
			reregister: true,
			wantOrigin: OriginCreated,
			setup:      func(t *testing.T, _ string) { okRegister(t) },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
			r, p, dir := newRun(t, b)
			tc.setup(t, dir)

			res, err := r.Run(context.Background(), tc.reregister)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if res.Origin != tc.wantOrigin {
				t.Fatalf("Origin = %v, want %v", res.Origin, tc.wantOrigin)
			}
			wantRegistered := tc.wantOrigin == OriginCreated
			if got := p.called("Registered"); got != wantRegistered {
				t.Errorf("Progress.Registered called = %v, want %v (methods: %v)", got, wantRegistered, p.methods())
			}
			if !wantRegistered && claimsCreation(p.text()) {
				t.Errorf("the run claimed a creation on the %s path:\n%s", tc.wantOrigin, p.text())
			}
			if strings.Contains(p.text(), "just confirmed") {
				t.Errorf("the narration says something was just confirmed on the %s path:\n%s",
					tc.wantOrigin, p.text())
			}
			// The name reaches the Result on every path, because every path can
			// ask for it.
			if res.AppName != testAppName {
				t.Errorf("AppName = %q, want the name Feishu gave", res.AppName)
			}
		})
	}
}

// TestTheWaitPromptNamesTheRealBot.
//
// The measured failure: "open a DIRECT chat with the app you just confirmed
// (named herdr-agent unless you changed the name on that page)" — while
// bot/v3/info had already answered herdr-agent-e1 for that very app. Two
// falsehoods in one sentence, and the reuse path printed both while confirming
// nothing.
func TestTheWaitPromptNamesTheRealBot(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, dir string)
	}{
		{
			name:  "after a confirmation page",
			setup: func(t *testing.T, _ string) { okRegister(t) },
		},
		{
			name: "on the reuse path, which confirms nothing",
			setup: func(t *testing.T, dir string) {
				noRegister(t)
				writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
			r, p, dir := newRun(t, b)
			tc.setup(t, dir)

			if _, err := r.Run(context.Background(), false); err != nil {
				t.Fatalf("Run: %v", err)
			}
			text := p.text()
			if !strings.Contains(text, testAppName) {
				t.Errorf("the wait never names the bot Feishu reported:\n%s", text)
			}
			if !strings.Contains(text, "DIRECT") || !strings.Contains(text, "group chat cannot finish this") {
				t.Errorf("the wait does not say plainly that a direct message is required:\n%s", text)
			}
			if p.called("AwaitInbound") {
				// It carries no app, so the only sentence it can be rendered as
				// names the bot from somewhere other than bot/v3/info — which is
				// how "named herdr-agent unless you changed the name on that page"
				// came to print one line above the real name, on the page-configured
				// path as much as on this one.
				t.Errorf("AwaitInbound fired; it cannot be rendered without guessing at the bot's name "+
					"(methods: %v)", p.methods())
			}
			if waitRequests(p) != 1 {
				t.Errorf("the request for a message, with its countdown, was not made exactly once:\n%s", text)
			}
		})
	}
}

// TestTheWaitRequestNeverGuessesTheBotName.
//
// The measured blocker: on the DEFAULT run — no flags, fresh machine — the
// package fired Progress.AwaitInbound, whose one implementation prints "(named
// herdr-agent unless you changed the name on that page)", one line above this
// package's own Note giving the name bot/v3/info had already returned. appName is
// a wish and testAppName contains it as a substring, so the fixture name here
// shares nothing with it: "did the preset leak" then has an unambiguous answer.
func TestTheWaitRequestNeverGuessesTheBotName(t *testing.T) {
	const realName = "acme-ops-bot"

	t.Run("when Feishu answers", func(t *testing.T) {
		b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
		r, p, _ := newRun(t, b)
		okRegister(t)
		namesApps(t, map[string]string{testAppID: realName})

		if _, err := r.Run(context.Background(), false); err != nil {
			t.Fatalf("Run: %v", err)
		}
		text := p.text()
		if strings.Contains(text, appName) {
			t.Errorf("the name we asked the confirmation page to pre-fill reached the user, and the page lets "+
				"the human change it:\n%s", text)
		}
		if !strings.Contains(text, realName) {
			t.Errorf("the name Feishu actually returned never reached the user:\n%s", text)
		}
	})

	t.Run("when Feishu does not answer", func(t *testing.T) {
		b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
		r, p, _ := newRun(t, b)
		okRegister(t)
		stubAppName(t, func(context.Context, string, string) (string, error) {
			return "", errors.New("connection refused")
		})

		if _, err := r.Run(context.Background(), false); err != nil {
			t.Fatalf("Run: %v", err)
		}
		text := p.text()
		if strings.Contains(text, appName) {
			t.Errorf("with no name available the run fell back to the pre-filled one:\n%s", text)
		}
		if !strings.Contains(text, testAppID) || !strings.Contains(text, "did not tell us") {
			t.Errorf("the run neither named the app by id nor admitted the name is unknown:\n%s", text)
		}
	})
}

// fakeNarrator is a Progress that also implements Narrator, i.e. the CLI once it
// renders what this package learns instead of what it assumed.
type fakeNarrator struct {
	fakeProgress
	mu    sync.Mutex
	apps  []App
	waits []App
}

func (n *fakeNarrator) Configured(a App) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.apps = append(n.apps, a)
}

func (n *fakeNarrator) AwaitMessage(a App, d time.Duration) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.waits = append(n.waits, a)
	n.record("AwaitMessage", a.ID, a.Name, d)
}

func (n *fakeNarrator) configured() []App {
	n.mu.Lock()
	defer n.mu.Unlock()
	return append([]App(nil), n.apps...)
}

var _ Narrator = (*fakeNarrator)(nil)

// TestANarratorGetsTheFactsInsteadOfProse.
func TestANarratorGetsTheFactsInsteadOfProse(t *testing.T) {
	clearCredEnv(t)
	noCapture(t)
	noTTY(t)
	stubRepoEnv(t, credentials{}, "")
	namesApps(t, map[string]string{testAppID: testAppName})
	noRegister(t)

	dir := t.TempDir()
	repoPath := repoEnv(t, credentials{AppID: testAppID, AppSecret: testSecret}, "")
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	stubBot(t, b)

	n := &fakeNarrator{}
	r, err := New(dir, n)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := r.Run(context.Background(), false); err != nil {
		t.Fatalf("Run: %v", err)
	}

	apps := n.configured()
	if len(apps) != 1 {
		t.Fatalf("Configured was called %d times, want exactly once", len(apps))
	}
	got := apps[0]
	if got.ID != testAppID || got.Name != testAppName || got.Origin != OriginAdopted {
		t.Errorf("Configured(%+v), want the adopted app with its real name", got)
	}
	if got.From != repoPath {
		t.Errorf("App.From = %q, want %q", got.From, repoPath)
	}
	if got.EnvPath != filepath.Join(dir, config.DotEnvFileName) {
		t.Errorf("App.EnvPath = %q", got.EnvPath)
	}
	if n.called("Registered") {
		t.Error("Registered fired for a Narrator, which would render the same fact twice — once wrongly")
	}
	if n.called("AwaitInbound") {
		t.Error("AwaitInbound fired for a Narrator; AwaitMessage replaces it, and only one of them may print")
	}
	if !n.called("AwaitMessage") {
		t.Errorf("AwaitMessage never fired: %v", n.methods())
	}
	if len(n.waits) != 1 || n.waits[0].Name != testAppName {
		t.Errorf("the wait was not given the bot's name: %+v", n.waits)
	}
	if strings.Contains(n.text(), testSecret) {
		t.Error("the app secret reached a Narrator callback")
	}
}

// TestASplitPairTellsTheNarratorWhichFileHeldTheSecret.
//
// App.From alone cannot describe a pair assembled out of two files, and the run
// that motivated this reported the file that named the app as the source of
// credentials it never held. A Narrator is handed both halves or it can only
// repeat the same mistake in prettier type.
func TestASplitPairTellsTheNarratorWhichFileHeldTheSecret(t *testing.T) {
	clearCredEnv(t)
	noCapture(t)
	noTTY(t)
	namesApps(t, map[string]string{testAppID: testAppName})
	noRegister(t)

	dir := t.TempDir()
	stateEnv := filepath.Join(dir, config.DotEnvFileName)
	write(t, stateEnv, config.EnvAppID+"="+testAppID+"\n")
	// The secret is in the repository .env and nowhere else, which is a working
	// pair: config.loadDotEnv merges the two files key by key.
	repoPath := repoEnv(t, credentials{AppSecret: testSecret}, "")
	stubBot(t, &fakeBot{deliver: msgs(p2p("hello")), pressCard: true})

	n := &fakeNarrator{}
	r, err := New(dir, n)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := r.Run(context.Background(), false); err != nil {
		t.Fatalf("Run: %v", err)
	}

	apps := n.configured()
	if len(apps) != 1 {
		t.Fatalf("Configured was called %d times, want exactly once", len(apps))
	}
	got := apps[0]
	if got.From != stateEnv {
		t.Errorf("App.From = %q, want the file that named the app (%s)", got.From, stateEnv)
	}
	if got.FromSecret != repoPath {
		t.Errorf("App.FromSecret = %q, want the file that actually held the secret (%s)", got.FromSecret, repoPath)
	}
	if strings.Contains(n.text(), testSecret) {
		t.Error("the app secret reached a Narrator callback")
	}
}

// TestBothSecretsAreScrubbedOnceTwoAreArmed.
//
// Resolving the two-app question means holding a secret for EACH app, and the
// scrubber used to hold one. Forgetting the first while the second is armed
// would be a hole in the one guarantee this package cannot compromise.
func TestBothSecretsAreScrubbedOnceTwoAreArmed(t *testing.T) {
	rep := &reporter{progress: &fakeProgress{}}
	rep.useSecret(testSecret)
	rep.useSecret(otherSecret)
	// A short value is deliberately ignored: replacing it inside a line would
	// corrupt the line without protecting anything.
	rep.useSecret("abc")

	got := rep.clean("first=" + testSecret + " second=" + otherSecret + " short=abc")
	if strings.Contains(got, testSecret) || strings.Contains(got, otherSecret) {
		t.Fatalf("a secret survived scrubbing: %q", got)
	}
	if strings.Count(got, redacted) != 2 {
		t.Errorf("clean(...) = %q, want both secrets replaced", got)
	}
	if !strings.Contains(got, "short=abc") {
		t.Errorf("a value too short to be worth scrubbing was replaced anyway: %q", got)
	}
}

// TestAPageThatReturnsADifferentAppSaysSo.
//
// The update flow targets one app; if the page comes back with another one,
// "updated that app" is no longer true. What replaces it is the only thing a page
// without CreateOnly can ever establish.
func TestAPageThatReturnsADifferentAppSaysSo(t *testing.T) {
	const asked = "cli_theOneWeAskedFor1"
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, _ := newRun(t, b, WithReuseAppID(asked))
	stubRegister(t, func(_ context.Context, o *registration.Options) (*registration.RegisterAppResult, error) {
		o.OnQRCode(&registration.QRCodeInfo{URL: "https://example.invalid/link", ExpireIn: 600})
		// The human picked something else on that page.
		return &registration.RegisterAppResult{
			ClientID: testAppID, ClientSecret: testSecret,
			UserInfo: &registration.UserInfo{OpenID: testOpenID},
		}, nil
	})

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.AppID != testAppID {
		t.Errorf("AppID = %q, want the app the page actually returned", res.AppID)
	}
	if res.Origin != OriginRegistered {
		t.Errorf("Origin = %v, want registered: the run cannot claim it updated an app it did not get", res.Origin)
	}
	if !strings.Contains(p.text(), asked) || !strings.Contains(p.text(), "not the") {
		t.Errorf("the substitution was not reported:\n%s", p.text())
	}
}

// TestReuseAndReregisterContradictEachOther: honouring either one silently is how
// an app nobody asked for ends up permanent in a tenant.
func TestReuseAndReregisterContradictEachOther(t *testing.T) {
	r, _, _ := newRun(t, &fakeBot{}, WithReuseAppID(testAppID))
	noRegister(t)

	_, err := r.Run(context.Background(), true)
	if err == nil {
		t.Fatal("Run accepted --reregister together with a pinned app")
	}
	if !strings.Contains(err.Error(), "pick one") {
		t.Errorf("the error does not say what to do: %v", err)
	}
}

// TestCardTimeoutHedgesOnlyForAHandMadeApp.
//
// Measured twice on the same app: the E1 probe saw no callback in 120s, and a
// later run saw the press arrive and the round trip complete. So a page-configured
// app has a working card path and the checklist must not send its owner to a
// toggle that is already on — while an app somebody built by hand in the console
// really can have it off, and the 200340 fact belongs in both.
func TestCardTimeoutHedgesOnlyForAHandMadeApp(t *testing.T) {
	c := console{appID: testAppID}

	page := stepCardTimeout(c, OriginRegistered, 120*time.Second)
	if !strings.Contains(page.What, "Press the button") {
		t.Errorf("the page-configured step does not lead with the press: %q", page.What)
	}
	if !strings.Contains(page.Why, "likeliest cause") {
		t.Errorf("the page-configured step does not say which cause is likeliest: %q", page.Why)
	}
	if !strings.Contains(page.Why, "200340") {
		t.Errorf("the 200340 advice was dropped: %q", page.Why)
	}
	if strings.Contains(page.Why, "indistinguishable") {
		t.Errorf("the page-configured step still claims the two causes cannot be told apart, which the second "+
			"measurement contradicts: %q", page.Why)
	}

	hand := stepCardTimeout(c, OriginAdopted, 120*time.Second)
	if !strings.Contains(hand.Why, "indistinguishable") {
		t.Errorf("a hand-made app's step lost the ambiguity that really is there: %q", hand.Why)
	}
	for _, want := range []string{"交互卡片", "200340"} {
		if !strings.Contains(hand.What+hand.Why, want) {
			t.Errorf("a hand-made app's step does not mention %s: %+v", want, hand)
		}
	}
	if hand.URL != c.bot() {
		t.Errorf("URL = %q, want the 机器人 page where the toggle lives", hand.URL)
	}
}
