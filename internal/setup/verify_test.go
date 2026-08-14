package setup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/lark"
)

func TestOutcomeString(t *testing.T) {
	for outcome, want := range map[Outcome]string{
		OutcomeVerified:    "verified",
		OutcomeCredentials: "credentials-only",
		OutcomeFailed:      "failed",
		Outcome(42):        "failed",
	} {
		if got := outcome.String(); got != want {
			t.Errorf("Outcome(%d).String() = %q, want %q", outcome, got, want)
		}
	}
}

// TestCardSendFailureIsAScopeProblem, not an ambiguous one: nothing was
// delivered, so "you did not press it" is not among the explanations.
func TestCardSendFailureIsAScopeProblem(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), sendErr: errors.New("code 99991672: no permission")}
	r, _, _ := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.InboundOK || res.CardOK {
		t.Errorf("InboundOK=%v CardOK=%v", res.InboundOK, res.CardOK)
	}
	if !mentions(res.Steps, "im:message:send_as_bot") {
		t.Errorf("no step names the sending scope: %+v", res.Steps)
	}
	if mentions(res.Steps, "交互卡片") {
		t.Error("the ambiguous card step was emitted for a card that was never delivered")
	}
	if len(b.updated()) != 0 {
		t.Error("a card that was never sent was updated")
	}
}

// TestCardSendFailureOnADeadSocketIsNotAScopeProblem.
//
// lark.ErrNotConnected reaches this path when the socket drops between the
// inbound message and the card. That message already proved the scopes, so
// sending the reader to 权限管理 costs them a trip to a page where nothing is
// wrong — the mistake stepEmptyBody exists to avoid, in the other half of the
// verification.
func TestCardSendFailureOnADeadSocketIsNotAScopeProblem(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), sendErr: lark.ErrNotConnected}
	r, _, _ := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.InboundOK || res.CardOK {
		t.Errorf("InboundOK=%v CardOK=%v", res.InboundOK, res.CardOK)
	}
	if mentions(res.Steps, "im:message:send_as_bot") {
		t.Errorf("a dropped connection was reported as a missing scope: %+v", res.Steps)
	}
	if !mentions(res.Steps, lark.ErrNotConnected.Error()) {
		t.Errorf("no step names what actually failed: %+v", res.Steps)
	}
	if !mentions(res.Steps, "herdr-agent setup") {
		t.Errorf("no step names the next action: %+v", res.Steps)
	}
}

// TestLooksLikePermissionSeparatesRefusalFromTransport.
func TestLooksLikePermissionSeparatesRefusalFromTransport(t *testing.T) {
	cases := map[string]bool{
		"code 99991672: no permission":      true,
		"insufficient permission for scope": true,
		"code 99991679":                     true, // a refusal that never spells it out
		"lark bot not connected":            false,
		"dial tcp 1.2.3.4:443: i/o timeout": false,
		"context deadline exceeded":         false,
	}
	for reason, want := range cases {
		if got := looksLikePermission(reason); got != want {
			t.Errorf("looksLikePermission(%q) = %v, want %v", reason, got, want)
		}
	}
}

// TestVerificationCardCarriesACallbackButtonAndANonce.
func TestVerificationCardCarriesACallbackButtonAndANonce(t *testing.T) {
	nonce, err := newNonce()
	if err != nil {
		t.Fatalf("newNonce: %v", err)
	}
	if len(nonce) != 32 {
		t.Errorf("nonce = %q, want 16 hex-encoded bytes", nonce)
	}

	card, err := buildVerifyCard(nonce, fixedNow)
	if err != nil {
		t.Fatalf("buildVerifyCard: %v", err)
	}
	if got := nonceOf(card); got != nonce {
		t.Errorf("the button carries nonce %q, want %q", got, nonce)
	}

	var decoded map[string]any
	if err := json.Unmarshal([]byte(card), &decoded); err != nil {
		t.Fatalf("the card is not valid JSON: %v", err)
	}
	if decoded["schema"] != cardSchema {
		t.Errorf("schema = %v, want %s", decoded["schema"], cardSchema)
	}
	if !strings.Contains(card, behaviorCallback) {
		t.Error("the button has no callback behavior, so no press could ever come back")
	}
	// The action is deliberately not one the bridge acts on: this card outlives
	// the process that sent it (G17).
	if !strings.Contains(card, actVerify) {
		t.Errorf("the card does not carry %q", actVerify)
	}
	if strings.Contains(card, `"pane"`) {
		t.Error("the card carries a pane; a press must never be able to reach an agent")
	}

	if _, err := buildVerifyCard("", fixedNow); err == nil {
		t.Error("a card with no nonce was built; any press would verify it")
	}
}

func TestDisarmedCardHasNoButtons(t *testing.T) {
	card, err := buildDisarmedCard("done", fixedNow)
	if err != nil {
		t.Fatalf("buildDisarmedCard: %v", err)
	}
	if strings.Contains(card, tagButton) || strings.Contains(card, behaviorCallback) {
		t.Errorf("the replacement card is still pressable: %s", card)
	}
}

// TestEffectiveWaitHonoursTheCallersDeadline. Bounding the run bounds each wait
// inside it, so a caller is never stuck for 150 seconds it did not ask for.
func TestEffectiveWaitHonoursTheCallersDeadline(t *testing.T) {
	if got := effectiveWait(context.Background(), InboundTimeout); got != InboundTimeout {
		t.Errorf("without a deadline: %s, want %s", got, InboundTimeout)
	}

	near, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if got := effectiveWait(near, InboundTimeout); got > 50*time.Millisecond {
		t.Errorf("with a near deadline: %s, want at most 50ms", got)
	}

	far, cancelFar := context.WithTimeout(context.Background(), time.Hour)
	defer cancelFar()
	if got := effectiveWait(far, InboundTimeout); got != InboundTimeout {
		t.Errorf("with a far deadline: %s, want %s", got, InboundTimeout)
	}

	past, cancelPast := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelPast()
	if got := effectiveWait(past, InboundTimeout); got != 0 {
		t.Errorf("with an elapsed deadline: %s, want 0", got)
	}
}

func TestConnectionEndDescribesACleanClose(t *testing.T) {
	rep := &reporter{progress: &fakeProgress{}}
	if got := connectionEnd(rep, nil); got == "" {
		t.Error("a nil error produced an empty reason, which reads as a truncated log line")
	}
	if got := connectionEnd(rep, errors.New("boom")); got != "boom" {
		t.Errorf("got %q", got)
	}
}

// TestRepairPathWithoutAnAllowlistAdoptsTheFirstSender.
//
// It is the only way the repair path can complete on a config.toml that has no
// owner yet, and it is announced before the wait rather than discovered
// afterwards.
func TestRepairPathWithoutAnAllowlistAdoptsTheFirstSender(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, p, dir := newRun(t, b)
	noRegister(t)
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")
	write(t, configPath(dir), "[feishu]\nallowed_open_ids = []\nnotify_chat_id = \"\"\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != OutcomeVerified {
		t.Errorf("Outcome = %v", res.Outcome)
	}
	if !strings.Contains(p.text(), "first person to message") {
		t.Error("the adoption window was not announced")
	}
	cfg := loadConfig(t, dir)
	if len(cfg.Feishu.AllowedOpenIDs) != 1 || cfg.Feishu.AllowedOpenIDs[0] != testOpenID {
		t.Errorf("allowed_open_ids = %v", cfg.Feishu.AllowedOpenIDs)
	}
}

// TestRepairPathKeepsTheConfiguredOwner: with an allowlist in place, a message
// from anyone else proves nothing about the owner's round trip.
func TestRepairPathKeepsTheConfiguredOwner(t *testing.T) {
	stranger := p2p("hello")
	stranger.UserID = "ou_stranger"
	b := &fakeBot{deliver: msgs(stranger)}
	r, _, dir := newRun(t, b)
	noRegister(t)
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")
	write(t, configPath(dir), "[feishu]\nallowed_open_ids = [\""+testOpenID+"\"]\n")

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.InboundOK {
		t.Error("a stranger completed the owner's verification")
	}
	if cfg := loadConfig(t, dir); len(cfg.Feishu.AllowedOpenIDs) != 1 {
		t.Errorf("the allowlist changed: %v", cfg.Feishu.AllowedOpenIDs)
	}
}

// TestAnUnparsableConfigIsReportedRatherThanIgnored: it is the next thing that
// would go wrong, since the bridge refuses to start on it.
func TestAnUnparsableConfigIsReportedRatherThanIgnored(t *testing.T) {
	b := &fakeBot{}
	r, p, dir := newRun(t, b)
	noRegister(t)
	writeEnvFixture(t, dir, config.EnvAppID+"="+testAppID+"\n"+config.EnvAppSecret+"="+testSecret+"\n")
	write(t, configPath(dir), "[feishu]\nallowed_open_id = [\"typo\"]\n")

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	if _, err := r.Run(ctx, false); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(p.text(), "stop the bridge from starting") {
		t.Errorf("the parse failure was swallowed:\n%s", p.text())
	}
}

// TestUnwritableConfigProducesAManualStep. Losing config.toml must not lose the
// credentials or the instructions.
func TestUnwritableConfigProducesAManualStep(t *testing.T) {
	b := &fakeBot{}
	r, _, dir := newRun(t, b)
	okRegister(t)
	// A directory where the file belongs: every read and write of it fails.
	if err := os.Mkdir(configPath(dir), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != OutcomeCredentials {
		t.Errorf("Outcome = %v", res.Outcome)
	}
	if !mentions(res.Steps, "by hand") {
		t.Errorf("no manual step was produced: %+v", res.Steps)
	}
	found := false
	for _, s := range res.Steps {
		if strings.HasPrefix(s.URL, "file://") && strings.Contains(s.URL, config.ConfigFileName) {
			found = true
		}
	}
	if !found {
		t.Errorf("the manual step has no path to act on: %+v", res.Steps)
	}
	if env := readFile(t, filepath.Join(dir, config.DotEnvFileName)); !strings.Contains(env, testSecret) {
		t.Error("the credentials were lost because config.toml could not be written")
	}
}

// TestMultilineAllowlistProducesAManualStepInsteadOfCorruptingIt.
func TestMultilineAllowlistProducesAManualStepInsteadOfCorruptingIt(t *testing.T) {
	b := &fakeBot{}
	r, _, dir := newRun(t, b)
	okRegister(t)
	original := "[feishu]\nallowed_open_ids = [\n  \"ou_someone\",\n]\n"
	write(t, configPath(dir), original)

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	res, err := r.Run(ctx, false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !mentions(res.Steps, keyAllowedOpenIDs) {
		t.Errorf("no step names the list that was left alone: %+v", res.Steps)
	}
	if got := readFile(t, configPath(dir)); !strings.Contains(got, original) {
		t.Errorf("the list was rewritten anyway:\n%s", got)
	}
}

func TestWriteFileAtomicReportsAMissingDirectory(t *testing.T) {
	err := writeFileAtomic(filepath.Join(t.TempDir(), "nope", "x"), []byte("data"), 0o600)
	if err == nil {
		t.Fatal("writing into a missing directory reported success")
	}
}

// TestConnectionLostWhileWaitingForTheButton is reported as a connection
// problem rather than as the ambiguous card step: nothing was waiting to be
// pressed once the socket went away.
func TestConnectionLostWhileWaitingForTheButton(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), endOnSend: make(chan struct{})}
	r, p, _ := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.InboundOK || res.CardOK {
		t.Errorf("InboundOK=%v CardOK=%v", res.InboundOK, res.CardOK)
	}
	if !mentions(res.Steps, "long connection") {
		t.Errorf("no step names the connection: %+v", res.Steps)
	}
	if !strings.Contains(p.text(), "connection ended") {
		t.Errorf("the user was not told the connection dropped:\n%s", p.text())
	}
}

// TestAFailedDisarmIsReportedNotSwallowed. The card is inert either way, but a
// user who later presses it and sees nothing happen deserves to have been told.
func TestAFailedDisarmIsReportedNotSwallowed(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true, updateErr: errors.New("permission denied")}
	r, p, _ := newRun(t, b)
	okRegister(t)

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != OutcomeVerified {
		t.Errorf("Outcome = %v; a failed disarm must not undo a verified round trip", res.Outcome)
	}
	if !strings.Contains(p.text(), "Could not replace") {
		t.Errorf("the failed update was swallowed:\n%s", p.text())
	}
}

// TestAClientThatCannotBeBuiltStillLeavesCredentials.
func TestAClientThatCannotBeBuiltStillLeavesCredentials(t *testing.T) {
	r, _, dir := newRun(t, nil)
	okRegister(t)
	prev := newBot
	newBot = func(string, string) (lark.Bot, error) { return nil, errors.New("app id is empty") }
	t.Cleanup(func() { newBot = prev })

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Outcome != OutcomeCredentials {
		t.Errorf("Outcome = %v", res.Outcome)
	}
	if len(res.Steps) == 0 {
		t.Error("no steps were produced")
	}
	if env := readFile(t, filepath.Join(dir, config.DotEnvFileName)); !strings.Contains(env, testAppID) {
		t.Error("the credentials were lost")
	}
}

// TestStepsAreNotRepeated: the same manual action is reachable from the
// allowlist write and from the chat write.
func TestStepsAreNotRepeated(t *testing.T) {
	steps := []Step{{What: "a", URL: "u"}, {What: "a", URL: "u"}, {What: "b", URL: "v"}}
	if got := dedupeSteps(steps); len(got) != 2 {
		t.Errorf("dedupeSteps kept %d of %d", len(got), len(steps))
	}
	if got := dedupeSteps(nil); got != nil {
		t.Errorf("dedupeSteps(nil) = %v", got)
	}
}

// TestAMultilineAllowlistIsReportedOnceEvenThoughTwoWritesHitIt.
//
// config.toml is written twice — once after registration, once when the first
// message names the chat — and both refuse the same multi-line array. The
// reader must be told once.
func TestAMultilineAllowlistIsReportedOnceEvenThoughTwoWritesHitIt(t *testing.T) {
	b := &fakeBot{deliver: msgs(p2p("hello")), pressCard: true}
	r, _, dir := newRun(t, b)
	okRegister(t)
	write(t, configPath(dir), "[feishu]\nallowed_open_ids = [\n  \"ou_someone\",\n]\nnotify_chat_id = \"\"\n")

	res, err := r.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	manual := 0
	for _, s := range res.Steps {
		if strings.Contains(s.What, keyAllowedOpenIDs) {
			manual++
		}
	}
	if manual != 1 {
		t.Errorf("the same manual step appears %d times: %+v", manual, res.Steps)
	}
	// The scalar next to it was still written: refusing one key must not
	// abandon the other.
	if cfg := loadConfig(t, dir); cfg.Feishu.NotifyChatID != testChatID {
		t.Errorf("notify_chat_id = %q", cfg.Feishu.NotifyChatID)
	}
}
