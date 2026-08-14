package setup

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

func TestNewRejectsAnEmptyStateDir(t *testing.T) {
	if _, err := New("  ", &fakeProgress{}); err == nil {
		t.Fatal("New accepted an empty state directory; it would write .env into the working directory")
	}
}

func TestNewRejectsANilProgress(t *testing.T) {
	if _, err := New(t.TempDir(), nil); err == nil {
		t.Fatal("New accepted a nil Progress; every manual step would be reported into the void")
	}
}

// TestExportedCredentialsRefuseToRun locks down the preflight.
//
// internal/config prefers the process environment over the .env file, so an
// export in a shell profile silently defeats everything setup writes: the
// bridge would then authenticate with credentials the user cannot see and
// cannot find.
func TestExportedCredentialsRefuseToRun(t *testing.T) {
	for _, key := range []string{config.EnvAppID, config.EnvAppSecret} {
		t.Run(key, func(t *testing.T) {
			r, p, _ := newRun(t, &fakeBot{})
			okRegister(t)
			t.Setenv(key, "whatever")

			_, err := r.Run(context.Background(), false)
			if !errors.Is(err, ErrEnvOverride) {
				t.Fatalf("Run err = %v, want ErrEnvOverride", err)
			}
			if strings.Contains(err.Error(), "whatever") {
				t.Error("the error echoed the exported value; naming the variable is enough")
			}
			if p.called("Verification") {
				t.Error("registration was started despite the override; the preflight must do no network I/O")
			}
		})
	}
}

// TestEmptyExportAlsoRefuses: config treats a present-but-empty variable as
// set, so this is the case that would otherwise fail latest and most obscurely.
func TestEmptyExportAlsoRefuses(t *testing.T) {
	r, _, _ := newRun(t, &fakeBot{})
	t.Setenv(config.EnvAppSecret, "")

	if _, err := r.Run(context.Background(), false); !errors.Is(err, ErrEnvOverride) {
		t.Fatalf("Run err = %v, want ErrEnvOverride", err)
	}
}

// TestRunningBridgeRefusesSetup. Long-connection delivery is cluster mode: a
// second client does not fail cleanly, it takes a random share of the user's
// real messages. The lock is correctness, not hygiene.
func TestRunningBridgeRefusesSetup(t *testing.T) {
	r, p, dir := newRun(t, &fakeBot{})
	okRegister(t)

	lock, err := bridge.AcquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("take the lock first: %v", err)
	}
	defer lock.Release()

	_, err = r.Run(context.Background(), false)
	if !errors.Is(err, ErrBridgeRunning) {
		t.Fatalf("Run err = %v, want ErrBridgeRunning", err)
	}
	if p.called("Verification") {
		t.Error("registration was started while the bridge held the lock")
	}
}

// TestHappyPathVerifiesTheRoundTrip is the whole command in one test.
func TestHappyPathVerifiesTheRoundTrip(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	if res.Outcome != OutcomeVerified {
		t.Errorf("Outcome = %v, want verified (steps: %+v)", res.Outcome, res.Steps)
	}
	if !res.InboundOK || !res.CardOK {
		t.Errorf("InboundOK=%v CardOK=%v, want both true", res.InboundOK, res.CardOK)
	}
	if res.AppID != testAppID || res.OpenID != testOpenID || res.ChatID != testChatID {
		t.Errorf("Result ids = %q/%q/%q", res.AppID, res.OpenID, res.ChatID)
	}
	if res.Reused {
		t.Error("Reused is true after a fresh registration")
	}
	// The page ran without CreateOnly, so it may have created this app or handed
	// back one the tenant already had. The Result says exactly that, and the name
	// comes from Feishu rather than from the name we asked the page to pre-fill.
	if res.Origin != OriginRegistered {
		t.Errorf("Origin = %v, want registered", res.Origin)
	}
	if res.AppName != testAppName {
		t.Errorf("AppName = %q, want the name bot/v3/info reported", res.AppName)
	}
	if len(res.Steps) != 0 {
		t.Errorf("a fully verified run still produced steps: %+v", res.Steps)
	}

	// The credentials are on disk, in the file the bridge reads, at 0600.
	env := readFile(t, filepath.Join(dir, config.DotEnvFileName))
	if !strings.Contains(env, config.EnvAppID+"="+testAppID) || !strings.Contains(env, config.EnvAppSecret+"="+testSecret) {
		t.Errorf(".env does not carry both credentials:\n%s", strings.ReplaceAll(env, testSecret, "<secret>"))
	}
	if mode := statMode(t, filepath.Join(dir, config.DotEnvFileName)); mode != 0o600 {
		t.Errorf(".env mode = %o, want 600", mode)
	}

	// The configuration the bridge needs is complete without another edit.
	cfg := loadConfig(t, dir)
	if got := cfg.Feishu.AllowedOpenIDs; len(got) != 1 || got[0] != testOpenID {
		t.Errorf("allowed_open_ids = %v, want [%s]", got, testOpenID)
	}
	if cfg.Feishu.NotifyChatID != testChatID {
		t.Errorf("notify_chat_id = %q, want %q", cfg.Feishu.NotifyChatID, testChatID)
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("the configuration setup just wrote does not validate: %v", err)
	}

	// The human was told what to do, in order. Registered is deliberately absent:
	// see TestRegisteredFiresOnlyWhenSomethingWasCreated — a page opened without
	// CreateOnly cannot establish that anything was created. So is AwaitInbound:
	// see TestTheWaitRequestNeverGuessesTheBotName.
	for _, want := range []string{"Verification", "AwaitCard"} {
		if !p.called(want) {
			t.Errorf("Progress.%s was never called; methods: %v", want, p.methods())
		}
	}
	if waitRequests(p) != 1 {
		t.Errorf("the human was not asked, exactly once, for the message that proves the chain:\n%s", p.text())
	}

	// The card was disarmed even though it was pressed (G17).
	if len(b.updated()) != 1 {
		t.Errorf("the verification card was updated %d times, want 1", len(b.updated()))
	}
}

// TestReusePathSkipsRegistration is what makes setup the repair path: with
// working credentials on disk it must not burn a second app, because Feishu has
// no deletion API for these.
func TestReusePathSkipsRegistration(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("still there?")), pressCard: true}
	r, p, dir := newRun(t, b)
	noRegister(t)
	writeEnvFixture(t, dir, "OTHER=keep\n"+config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Reused {
		t.Error("Reused = false; the run did not report that it kept the existing app")
	}
	if res.Outcome != OutcomeVerified {
		t.Errorf("Outcome = %v, want verified", res.Outcome)
	}
	if res.AppID != testAppID {
		t.Errorf("AppID = %q, want the one already on disk", res.AppID)
	}
	if p.called("Verification") {
		t.Error("a confirmation URL was shown even though no registration was needed")
	}
	// The tenant brand is only learned during registration and is not persisted,
	// so every console URL printed on this path is a Feishu guess. A Lark
	// operator re-running setup would otherwise get a checklist of 404s.
	if !strings.Contains(p.text(), "larksuite.com") {
		t.Errorf("the repair path never says its console links assume a Feishu tenant:\n%s", p.text())
	}
	// The repair path still learns the chat and the owner.
	cfg := loadConfig(t, dir)
	if cfg.Feishu.NotifyChatID != testChatID {
		t.Errorf("notify_chat_id = %q; the repair path must still record it", cfg.Feishu.NotifyChatID)
	}
}

// Two refusals used to live here, and both were wrong.
//
// "An app id with no secret" ended the run; it now re-confirms that same app
// through the update flow, which recovers a usable secret without leaving a
// second app in the tenant — see TestHalfACredentialReconfirmsTheSameApp.
//
// "A repository .env names an app" ended the run with an instruction to move the
// file; those credentials are now adopted and verified — see
// TestCredentialsOutsideTheStateDirAreAdoptedNotRefused. That refusal cost the
// user who hit it their working app: they deleted the file, registered again, and
// ended up pointed at a different app.
//
// The state-directory-wins rule those tests also covered is now decided by the
// human when the two files name different apps (TestTwoAppsAskTheHuman, where the
// state directory is the one labelled "the bridge uses this one") and by the
// bridge's own key-by-key merge otherwise
// (TestDiscoveryResolvesCredentialsTheWayTheBridgeDoes).

// TestReregisterIgnoresARepositoryEnv: the flag exists to say "yes, another
// app, on purpose", and it must not be blocked by the file it overrides.
func TestReregisterIgnoresARepositoryEnv(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hi")), pressCard: true}
	r, _, _ := newRun(t, b)
	okRegister(t)
	stubRepoEnv(t, credentials{AppID: "cli_from_the_repo", AppSecret: testSecret}, "/tmp/elsewhere/.env")

	res, err := r.Run(context.Background(), true)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.AppID != testAppID {
		t.Errorf("AppID = %q, want the newly registered app", res.AppID)
	}
}

// TestStateDirectoryCredentialsAreOfferedAsTheLiveOnes.
//
// config.loadDotEnv resolves <stateDir>/.env over the repository one, so when the
// two name different apps the state directory's is what the bridge is using right
// now. That fact is what makes the question answerable, so it has to be IN the
// question rather than acted on silently.
func TestStateDirectoryCredentialsAreOfferedAsTheLiveOnes(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	prompt := &fakePrompter{answers: []string{"2"}}
	r, _, dir := newRun(t, b, WithPrompter(prompt))
	noRegister(t)
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")
	stubRepoEnv(t, credentials{AppID: otherAppID, AppSecret: otherSecret}, "/tmp/elsewhere/.env")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.AppID != testAppID {
		t.Errorf("AppID = %q, want the state directory's app", res.AppID)
	}
	q := prompt.text()
	live := strings.Index(q, "the bridge uses this one")
	if live < 0 {
		t.Fatalf("the question does not say which app is live:\n%s", q)
	}
	if idx := strings.Index(q, testAppID); idx < 0 || idx > live {
		t.Errorf("the live marker is not on the state directory's app:\n%s", q)
	}
}

// TestRepoEnvCredentialsFindsTheFileTheBridgeWouldLoad drives the real lookup
// rather than the stub, because a discovery that disagrees with
// config.loadDotEnv would make the guard above silently useless.
func TestRepoEnvCredentialsFindsTheFileTheBridgeWouldLoad(t *testing.T) {
	// EvalSymlinks because os.Getwd resolves /var to /private/var on macOS, and
	// the lookup returns the path it walked to, not the one t.TempDir handed out.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temp dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module x\n"), 0o600); err != nil {
		t.Fatalf("write go.mod: %v", err)
	}
	write(t, filepath.Join(root, config.DotEnvFileName), config.EnvAppID+"=cli_root\n")
	sub := filepath.Join(root, "internal", "setup")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Chdir(sub)

	got, path := repoEnvCredentials()
	if got.AppID != "cli_root" {
		t.Errorf("AppID = %q, want the one in the repository root .env", got.AppID)
	}
	if path != filepath.Join(root, config.DotEnvFileName) {
		t.Errorf("path = %q", path)
	}

	// And the same walk finds nothing when the repository has no .env.
	if err := os.Remove(filepath.Join(root, config.DotEnvFileName)); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if got, _ := repoEnvCredentials(); got.AppID != "" {
		t.Errorf("AppID = %q with no repository .env at all", got.AppID)
	}
}

// TestReregisterReplacesADifferentApp: the caller has been warned, so the write
// goes through and the other variables in the file survive it.
func TestReregisterReplacesADifferentApp(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hi")), pressCard: true}
	r, _, dir := newRun(t, b)
	okRegister(t)
	writeEnvFixture(t, dir, "# mine\nOTHER=keep\n"+config.EnvAppID+"=cli_old\n"+config.EnvAppSecret+"=old-secret\n")

	res, err := r.Run(context.Background(), true)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.AppID != testAppID {
		t.Errorf("AppID = %q, want the new app", res.AppID)
	}
	env := readFile(t, filepath.Join(dir, config.DotEnvFileName))
	if strings.Contains(env, "cli_old") || strings.Contains(env, "old-secret") {
		t.Error(".env still carries the previous app")
	}
	if !strings.Contains(env, "OTHER=keep") || !strings.Contains(env, "# mine") {
		t.Errorf("the merge dropped unrelated content:\n%s", strings.ReplaceAll(env, testSecret, "<secret>"))
	}
}

// TestInboundTimeoutStillLeavesAWorkingConfiguration.
func TestInboundTimeoutStillLeavesAWorkingConfiguration(t *testing.T) {
	b := &fakeBot{} // nothing ever arrives
	r, p, dir := newRun(t, b)
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run returned an error for a timeout; a checklist is not a failure: %v", err)
	}
	if res.Outcome != OutcomeCredentials {
		t.Errorf("Outcome = %v, want credentials-only", res.Outcome)
	}
	if res.InboundOK || res.CardOK {
		t.Error("nothing arrived, yet the round trip reported success")
	}
	if len(res.Steps) == 0 {
		t.Fatal("no steps were produced; the user is left with a bare failure")
	}
	for _, s := range res.Steps {
		if s.URL == "" {
			t.Errorf("step %q has no URL", s.What)
		}
		if !strings.Contains(s.URL, testAppID) {
			t.Errorf("step URL %q does not name the app", s.URL)
		}
	}
	if !mentions(res.Steps, "长连接") {
		t.Error("no step mentions the delivery mode, which is the setting a new app is most likely missing")
	}
	// Credentials survived the failed verification, which is the entire point
	// of persisting before verifying.
	env := readFile(t, filepath.Join(dir, config.DotEnvFileName))
	if !strings.Contains(env, testSecret) {
		t.Error(".env lost the secret when verification failed")
	}
	if waitRequests(p) == 0 {
		t.Errorf("the user was never asked to send a message:\n%s", p.text())
	}
}

// TestCardTimeoutNamesBothCauses. The measured probe could not tell a disabled
// 交互卡片 capability from a button nobody pressed, so the checklist must not
// pretend otherwise.
func TestCardTimeoutNamesBothCauses(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: false}
	r, _, _ := newRun(t, b)
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != OutcomeCredentials {
		t.Errorf("Outcome = %v, want credentials-only", res.Outcome)
	}
	if !res.InboundOK || res.CardOK {
		t.Errorf("InboundOK=%v CardOK=%v, want true/false", res.InboundOK, res.CardOK)
	}
	if !mentions(res.Steps, "交互卡片") {
		t.Error("no step mentions the capability toggle")
	}
	if !mentions(res.Steps, "press") {
		t.Error("no step mentions that the button may simply not have been pressed")
	}
	// The card is left inert rather than pressable by a process that has exited.
	if len(b.updated()) != 1 {
		t.Errorf("the card was updated %d times after the timeout, want 1", len(b.updated()))
	}
}

// TestEmptyBodyIsDetected. An empty body means im:message.p2p_msg:readonly did
// not land; undetected it surfaces much later as a command-parser error
// blaming the wrong layer.
func TestEmptyBodyIsDetected(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("   "))}
	r, p, dir := newRun(t, b)
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.InboundOK {
		t.Error("an empty message counted as a successful round trip")
	}
	if !mentions(res.Steps, "im:message.p2p_msg:readonly") {
		t.Errorf("no step names the scope; steps: %+v", res.Steps)
	}
	if !mentions(res.Steps, "sticker") {
		t.Error("the step does not admit the other cause: a non-text message looks identical")
	}
	// A message demonstrably DID reach the bridge — that is how we know its body
	// was empty — so delivery mode, publication, credentials, the subscription
	// and the allowlist are already proven. Claiming otherwise in the first line
	// of the checklist sends the reader to a page where nothing is wrong.
	if mentions(res.Steps, "No message reached the bridge") {
		t.Errorf("the checklist claims nothing arrived, but an event did — only its body was empty: %+v",
			res.Steps)
	}
	if mentions(res.Steps, "长连接") {
		t.Errorf("the delivery mode was already proven by the arrival, yet a step questions it: %+v", res.Steps)
	}
	if !strings.Contains(p.text(), "empty") {
		t.Error("the user was never told the message arrived empty")
	}
	// contract.go: ChatID is "empty when inbound verification did not complete".
	// A CLI that prints "notifications will go to <ChatID>" off that promise must
	// not be handed a chat learned from a sticker.
	if res.ChatID != "" {
		t.Errorf("Result.ChatID = %q after a failed verification; the contract says it is empty", res.ChatID)
	}
	// The chat id was still learned and written: it is true and useful even
	// though the body was not.
	if cfg := loadConfig(t, dir); cfg.Feishu.NotifyChatID != testChatID {
		t.Errorf("notify_chat_id = %q, want it recorded anyway", cfg.Feishu.NotifyChatID)
	}
}

// TestMessagesFromOtherPeopleAreIgnored.
func TestMessagesFromOtherPeopleAreIgnored(t *testing.T) {
	stranger := p2p("let me in")
	stranger.UserID = "ou_stranger"
	b := &fakeBot{deliver: msgs(stranger)}
	r, _, dir := newRun(t, b)
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.InboundOK {
		t.Error("a stranger's message completed the verification")
	}
	if cfg := loadConfig(t, dir); len(cfg.Feishu.AllowedOpenIDs) != 1 || cfg.Feishu.AllowedOpenIDs[0] != testOpenID {
		t.Errorf("allowed_open_ids = %v; a stranger must never be added", cfg.Feishu.AllowedOpenIDs)
	}
}

// TestGroupMessagesDoNotBecomeTheNotifyChat. notify_chat_id is where agent
// screens are pushed, including the command an agent is about to run.
func TestGroupMessagesDoNotBecomeTheNotifyChat(t *testing.T) {
	group := p2p("hello from a group")
	group.ChatType = lark.ChatGroup
	b := &fakeBot{deliver: msgs(group)}
	r, p, dir := newRun(t, b)
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.InboundOK {
		t.Error("a group message completed the verification")
	}
	if cfg := loadConfig(t, dir); cfg.Feishu.NotifyChatID != "" {
		t.Errorf("notify_chat_id = %q; a group chat must not become the push target", cfg.Feishu.NotifyChatID)
	}
	if !strings.Contains(p.text(), "DIRECT") {
		t.Error("the user was not told to send a direct message instead")
	}
}

// TestStaleCardPressIsIgnored: a press carrying a nonce from an earlier run
// proves nothing about this app.
func TestStaleCardPressIsIgnored(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hi")), pressCard: true, pressWith: "nonce-from-a-previous-run"}
	r, _, _ := newRun(t, b)
	okRegister(t)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.CardOK {
		t.Error("a press with the wrong nonce was accepted as verification")
	}
}

// TestConnectionFailureIsReportedWithoutLosingCredentials.
func TestConnectionFailureIsReportedWithoutLosingCredentials(t *testing.T) {
	b := &fakeBot{startErr: errors.New("dial tcp: connection refused")}
	r, _, dir := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != OutcomeCredentials {
		t.Errorf("Outcome = %v, want credentials-only", res.Outcome)
	}
	if !mentions(res.Steps, "长连接") {
		t.Errorf("no step points at the delivery mode; steps: %+v", res.Steps)
	}
	if env := readFile(t, filepath.Join(dir, config.DotEnvFileName)); !strings.Contains(env, testSecret) {
		t.Error("the secret was lost when the connection failed")
	}
}

// TestSecretNeverLeaves .env — the bar internal/config sets for the config
// path, applied to this one.
func TestSecretNeverLeavesTheEnvFile(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	if strings.Contains(p.text(), testSecret) {
		t.Error("the app secret reached a Progress callback")
	}
	for _, s := range res.Steps {
		if strings.Contains(s.What+s.URL+s.Why, testSecret) {
			t.Error("the app secret reached a Step")
		}
	}
	for _, o := range b.sent() {
		if strings.Contains(o.Card+o.Text+o.Markdown, testSecret) {
			t.Error("the app secret reached a Feishu message")
		}
	}

	// Every file in the state directory except .env.
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if filepath.Base(path) == config.DotEnvFileName {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), testSecret) {
			t.Errorf("%s contains the app secret", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
}

// TestSecretIsScrubbedFromReportedErrors: the scrubber is armed the instant
// registration returns, so even an SDK error that echoed the secret could not
// reach the human through Progress.
func TestSecretIsScrubbedFromReportedErrors(t *testing.T) {
	b := &fakeBot{startErr: errors.New("bad credentials: " + testSecret)}
	r, p, _ := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(p.text(), testSecret) {
		t.Fatal("an error carrying the secret was reported verbatim")
	}
	if !strings.Contains(p.text(), redacted) {
		t.Error("the secret was not replaced by the redaction marker")
	}
	for _, s := range res.Steps {
		if strings.Contains(s.Why, testSecret) {
			t.Error("a Step carried the secret")
		}
	}
}

// --- helpers ---------------------------------------------------------------

func msgs(m ...lark.Msg) []lark.Msg { return m }

func mentions(steps []Step, substr string) bool {
	for _, s := range steps {
		if strings.Contains(s.What, substr) || strings.Contains(s.Why, substr) {
			return true
		}
	}
	return false
}

func statMode(t *testing.T, path string) fs.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.Mode().Perm()
}

func writeEnvFixture(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, config.DotEnvFileName), []byte(content), 0o600); err != nil {
		t.Fatalf("write .env fixture: %v", err)
	}
}

func loadConfig(t *testing.T, dir string) config.Config {
	t.Helper()
	cfg, err := config.Load(dir)
	if err != nil {
		t.Fatalf("config.Load(%s): %v", dir, err)
	}
	return cfg
}

// The summary block prints Origin.String() as a machine-readable field, right
// under prose admitting the run cannot tell whether an app was created. A label
// that reads like a claim about creation would undo that sentence, so pin the
// invariant rather than the wording: only OriginCreated — the one path that sets
// CreateOnly, where creation is the only possible outcome — may say so.
func TestOnlyOriginCreatedMayClaimCreation(t *testing.T) {
	all := []Origin{
		OriginUnknown, OriginRegistered, OriginCreated,
		OriginAdopted, OriginReused, OriginUpdated,
	}
	for _, o := range all {
		label := o.String()
		if label == "" {
			t.Fatalf("Origin(%d) has an empty label", int(o))
		}
		claims := strings.Contains(strings.ToLower(label), "creat")
		if claims != (o == OriginCreated) {
			t.Errorf("Origin(%d).String() = %q: claims creation = %v, want %v",
				int(o), label, claims, o == OriginCreated)
		}
	}

	// And the labels must be distinct, or the field cannot be acted on.
	seen := map[string]Origin{}
	for _, o := range all {
		if prev, dup := seen[o.String()]; dup {
			t.Errorf("Origin(%d) and Origin(%d) share the label %q", int(prev), int(o), o.String())
		}
		seen[o.String()] = o
	}
}
