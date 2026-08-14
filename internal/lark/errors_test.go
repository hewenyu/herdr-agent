package lark

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
)

// TestFailureKindMapping covers every code the SDK can produce, without I/O.
//
// The end-to-end cases in TestFailuresStayClassifiable cannot include the
// retryable ones: the SDK's Retry sleeps for real (500ms, then 1.5s) before
// giving up on a rate limit. This table drives the same mapping directly, so
// no code can be added to the SDK's taxonomy and silently arrive at the caller
// as FailUnknown.
func TestFailureKindMapping(t *testing.T) {
	tests := []struct {
		code     types.FeishuChannelErrorCode
		wantKind FailKind
		wantIs   error
	}{
		{types.ErrCodeTargetRevoked, FailTargetRevoked, ErrTargetRevoked},
		{types.ErrCodePermissionDenied, FailPermissionDenied, ErrPermissionDenied},
		{types.ErrCodeFormatError, FailFormat, ErrFormat},
		{types.ErrCodeRateLimited, FailRateLimited, ErrRateLimited},
		{types.ErrCodeSSRFBlocked, FailSSRFBlocked, ErrSSRFBlocked},
		{types.ErrCodeSendTimeout, FailTimeout, ErrSendTimeout},
		{types.ErrCodeUnknown, FailUnknown, ErrUnknownFailure},
	}

	for _, tc := range tests {
		t.Run(string(tc.code), func(t *testing.T) {
			cause := errors.New("underlying")
			sdkErr := &types.FeishuChannelError{Code: tc.code, Message: "boom", Cause: cause}

			err := newFailure("send", "", sdkErr)
			if got := FailureKind(err); got != tc.wantKind {
				t.Fatalf("FailureKind = %q, want %q", got, tc.wantKind)
			}
			if !errors.Is(err, tc.wantIs) {
				t.Fatalf("errors.Is(err, %v) = false", tc.wantIs)
			}
			// The cause must stay reachable: it is what a log line needs.
			if !errors.Is(err, cause) {
				t.Fatalf("the underlying error was lost: %v", err)
			}
			// The op has to name the operation; "patch message om_x" is how a
			// caller finds the message a failure was about.
			if !strings.Contains(err.Error(), "send") {
				t.Fatalf("error does not name the op: %v", err)
			}
			// Every kind must have its own sentinel; a shared one would make
			// errors.Is useless for picking a fallback.
			for _, other := range tests {
				if other.wantIs == tc.wantIs {
					continue
				}
				if errors.Is(err, other.wantIs) {
					t.Fatalf("%q also matches the sentinel for %q", tc.code, other.code)
				}
			}
		})
	}
}

// FailureKind must see through arbitrary wrapping: callers add their own
// context ("notify w1:p1: %w") before anyone classifies.
func TestFailureKindThroughWrapping(t *testing.T) {
	err := newFailure("send", "", &types.FeishuChannelError{Code: types.ErrCodeRateLimited})
	wrapped := fmt.Errorf("notify w1:p1: %w", fmt.Errorf("outbound: %w", err))

	if got := FailureKind(wrapped); got != FailRateLimited {
		t.Fatalf("FailureKind = %q, want %q", got, FailRateLimited)
	}
	if !errors.Is(wrapped, ErrRateLimited) {
		t.Fatal("errors.Is through two wrappers = false")
	}
}

// A raw SDK error that never went through newFailure must still classify, so
// the taxonomy is a property of the error rather than of one code path.
func TestFailureKindClassifiesRawSDKErrors(t *testing.T) {
	raw := &types.FeishuChannelError{Code: types.ErrCodeTargetRevoked}
	if got := FailureKind(raw); got != FailTargetRevoked {
		t.Fatalf("FailureKind = %q, want %q", got, FailTargetRevoked)
	}
}

func TestNewFailureOnNil(t *testing.T) {
	if err := newFailure("send", "", nil); err != nil {
		t.Fatalf("newFailure(nil) = %v, want nil", err)
	}
}

// TestKnownCodesAreExplained is the point of the diagnosis table.
//
// Both codes are ones this project met on a real tenant and could not decode
// from the bridge: the number came back, the bridge printed it, and the fix
// took an hour of guessing. A test that only asserted "some advice exists"
// would pass with a sentence that names no console page, so every fragment
// below is a step the user has to actually perform.
func TestKnownCodesAreExplained(t *testing.T) {
	const appID = "cli_probe"

	tests := []struct {
		name string
		code int
		want []string
	}{
		{
			name: "scope not in effect",
			code: CodeScopeNotInEffect,
			want: []string{
				"99991672",
				// The fix, not the symptom: a granted scope does nothing until
				// a version is published.
				"版本管理与发布",
				"https://open.feishu.cn/app/" + appID + "/auth",
				// And the counter-fact, so a setup-created app is not sent
				// chasing a publish step its confirmation page already did.
				"herdr-agent setup",
			},
		},
		{
			name: "card callback failed",
			code: CodeCardCallbackFailed,
			want: []string{
				"200340",
				// BOTH causes. The measurement behind this code sent a card
				// successfully and saw no callback within 120s, which cannot
				// separate a 交互卡片 capability that is off from a human who
				// did not press in time — and an unsubscribed callback looks
				// identical. Dropping either fragment turns a measurement into
				// a guess.
				"card.action.trigger",
				"交互卡片",
				"https://open.feishu.cn/app/" + appID + "/event",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := newFailure("send", appID, &larkcore.CodeError{Code: tc.code, Msg: "no permission"})

			adv := Explain(err)
			if adv == "" {
				t.Fatalf("code %d has no explanation; the user sees only the number", tc.code)
			}
			for _, frag := range tc.want {
				if !strings.Contains(adv, frag) {
					t.Fatalf("explanation of %d does not mention %q:\n%s", tc.code, frag, adv)
				}
			}
			// The wiring that matters: whoever formats the error — a log line,
			// a card, a doctor report — gets the explanation without asking
			// for it.
			if !strings.Contains(err.Error(), adv) {
				t.Fatalf("Error() drops the explanation:\n%s", err.Error())
			}
		})
	}
}

// An error we have nothing useful to say about must say nothing. Advice
// attached to every failure would be noise, and noise is how the two sentences
// above stop being read.
func TestUnknownCodesGetNoAdvice(t *testing.T) {
	err := newFailure("send", "cli_probe", &larkcore.CodeError{Code: 230011, Msg: "message recalled"})

	if adv := Explain(err); adv != "" {
		t.Fatalf("code 230011 got an explanation it has no basis for: %s", adv)
	}
	if strings.Contains(err.Error(), "open.feishu.cn") {
		t.Fatalf("unexplained failure points at the console anyway: %v", err)
	}
}

// Explain must work on an error that never passed through newFailure, and fall
// back to the URL pattern when no app id is available: an incomplete URL still
// names the console page, which is the half that is hard to find.
func TestExplainWithoutAnAppID(t *testing.T) {
	adv := Explain(&larkcore.CodeError{Code: CodeScopeNotInEffect})
	if !strings.Contains(adv, "https://open.feishu.cn/app/<app_id>/auth") {
		t.Fatalf("explanation without an app id lost the URL pattern:\n%s", adv)
	}
}

func TestAPICodeDigsThroughTheChain(t *testing.T) {
	// The shape a real send failure has: our Failure over the SDK's
	// classification over Feishu's own code, then a caller's context on top.
	inner := newFailure("send", "", &larkcore.CodeError{Code: CodeScopeNotInEffect})
	wrapped := fmt.Errorf("notify w1:p1: %w", inner)
	if code, ok := APICode(wrapped); !ok || code != CodeScopeNotInEffect {
		t.Fatalf("APICode = (%d, %v), want (%d, true)", code, ok, CodeScopeNotInEffect)
	}
	if !strings.Contains(Explain(wrapped), "版本管理与发布") {
		t.Fatalf("wrapping hid the explanation: %v", Explain(wrapped))
	}

	// CodeError.Error has a value receiver, so a value can legally sit in a
	// chain and errors.As on the pointer type would miss it.
	if code, ok := APICode(larkcore.CodeError{Code: CodeCardCallbackFailed}); !ok || code != CodeCardCallbackFailed {
		t.Fatalf("APICode on a value CodeError = (%d, %v)", code, ok)
	}

	// A dial failure or a cancellation carries no Feishu code, and must not be
	// reported as code 0.
	for _, err := range []error{errors.New("dial tcp: connection refused"), context.Canceled} {
		if code, ok := APICode(err); ok {
			t.Fatalf("APICode(%v) = (%d, true), want ok=false", err, code)
		}
	}
}

// The diagnosis must not disturb the taxonomy the rest of the bridge switches
// on. Both codes are permanent failures and FailUnknown already routes to
// outbound.ClassPermanent, so reclassifying them would change behaviour for no
// gain — this pins that they only change what is said.
func TestAdviceDoesNotChangeTheFailKind(t *testing.T) {
	for _, code := range []int{CodeScopeNotInEffect, CodeCardCallbackFailed} {
		err := newFailure("send", "cli_probe", &larkcore.CodeError{Code: code})
		if got := FailureKind(err); got != FailUnknown {
			t.Fatalf("code %d classified as %q; the SDK maps it to unknown and callers rely on that", code, got)
		}
	}
}

// End to end through a real Bot: the app id in the URL is THIS app's, so the
// link can be clicked rather than edited. And the secret that built the same
// client never appears — the bar internal/config sets for its own .env test.
func TestUpdateCardFailureExplainsItselfWithoutLeakingTheSecret(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)
	http.patchCode = CodeScopeNotInEffect

	err := b.UpdateCard(context.Background(), "om_card_1", `{"schema":"2.0"}`)
	if err == nil {
		t.Fatal("want an error when Feishu refuses the patch")
	}
	if !strings.Contains(err.Error(), "https://open.feishu.cn/app/cli_test/auth") {
		t.Fatalf("the console URL does not point at this app:\n%s", err.Error())
	}
	if strings.Contains(err.Error(), "secret_test") {
		t.Fatalf("the app secret reached an error string:\n%s", err.Error())
	}
}

// The advice must survive the send path, which is where a user actually meets
// 99991672: the first outbound message from an app whose version was never
// published.
//
// This is a different stack from the UpdateCard test above. There, bot.go
// builds the *larkcore.CodeError itself, so APICode is looking at an error this
// package constructed. Here the error comes back through
// channelImpl.rawSendWithRetry → outbound.Retry → types.ClassifyError, which
// keeps Feishu's CodeError only as FeishuChannelError.Cause. An SDK bump that
// stopped setting Cause, or wrapped with %v instead of %w, would silently
// delete the diagnosis on the one path that matters most, and every other test
// in this file would still pass.
//
// It costs ~2s: the SDK classifies 99991672 as unknown and retries three times
// with real sleeps before giving up. Going through the real stack is the entire
// point of the test, so the sleeps are not avoidable here.
func TestSendFailureExplainsItselfThroughTheSDKsOwnWrapping(t *testing.T) {
	b, http := newTestBot(t)
	b.setState(stateRunning)
	http.sendResp = `{"code":99991672,"msg":"no permission"}`

	_, err := b.Send(context.Background(), Out{ChatID: "oc_1", Text: "hi"})
	if err == nil {
		t.Fatal("want an error when Feishu refuses the send")
	}
	for _, frag := range []string{"版本管理与发布", "https://open.feishu.cn/app/cli_test/auth"} {
		if !strings.Contains(err.Error(), frag) {
			t.Fatalf("the send path lost the explanation of 99991672 (missing %q):\n%s", frag, err.Error())
		}
	}
	if strings.Contains(err.Error(), "secret_test") {
		t.Fatalf("the app secret reached an error string:\n%s", err.Error())
	}
}

// The app id is interpolated into a URL that gets logged, so anything that is
// not an app id must not reach that string.
//
// The case this exists for: the console lists App ID above App Secret, a
// copy-paste transposes them, config.Validate accepts both because both are
// non-empty, and the first failed write formats this advice into
// log/herdr-agent.err.log. Printing the app-id slot unchecked would put the
// secret there (S2 §3.1). Degrading to the documented pattern costs a clickable
// link and nothing else.
func TestAdviceNeverInterpolatesAValueThatIsNotAnAppID(t *testing.T) {
	// A real Feishu app secret is 32 alphanumerics and carries no "cli_"
	// prefix, which is what makes the shape check sufficient.
	const transposedSecret = "K3nQ7xR2mB8vT5wY1zL4pJ6hN0sD9fG2"

	bad := []struct {
		name  string
		appID string
	}{
		{"the secret, transposed into the app id slot", transposedSecret},
		{"empty", ""},
		{"prefix only", "cli_"},
		{"trailing newline from a hand-edited .env", "cli_test\n"},
		{"value the shell left quoted", `"cli_test"`},
		{"path traversal into another app's page", "cli_test/../../evil"},
		{"query string", "cli_test?x=1"},
		{"embedded space", "cli_test abc"},
	}

	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			err := newFailure("send", tc.appID, &larkcore.CodeError{Code: CodeScopeNotInEffect})
			got := err.Error()

			if !strings.Contains(got, "https://open.feishu.cn/app/<app_id>/auth") {
				t.Fatalf("a non-app-id was interpolated instead of degrading to the pattern:\n%s", got)
			}
			if tc.appID != "" && strings.Contains(got, tc.appID) {
				t.Fatalf("the value in the app id slot reached the error string:\n%s", got)
			}
		})
	}

	// And the gate must not eat real app ids, or every explanation loses its
	// clickable link.
	for _, good := range []string{"cli_test", "cli_probe", "cli_a97a042adcb8dbd5"} {
		err := newFailure("send", good, &larkcore.CodeError{Code: CodeScopeNotInEffect})
		if !strings.Contains(err.Error(), "https://open.feishu.cn/app/"+good+"/auth") {
			t.Fatalf("app id %q was rejected by the shape check:\n%s", good, err.Error())
		}
	}
}

// A stream failure gets the same treatment: the mirror is where a 200340 shows
// up if the card capability is off, and it is also the path most likely to be
// read only in a log.
func TestStreamFailureIsExplained(t *testing.T) {
	fc := newFakeChannel()
	fc.stream = &fakeStream{appendErr: &larkcore.CodeError{Code: CodeCardCallbackFailed, Msg: "callback failed"}}
	b := newFakeBot(fc, "")
	b.appID = "cli_probe"
	b.setState(stateRunning)
	ctx := context.Background()

	s, err := b.Stream(ctx, Out{ChatID: "oc_1", Markdown: "start"})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	err = s.Append(ctx, "hello")
	if err == nil {
		t.Fatal("want an error from Append")
	}
	if !strings.Contains(err.Error(), "https://open.feishu.cn/app/cli_probe/event") {
		t.Fatalf("stream failure carries no explanation:\n%s", err.Error())
	}
}
