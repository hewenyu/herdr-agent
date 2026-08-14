package lark

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
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

			err := newFailure("send", sdkErr)
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
	err := newFailure("send", &types.FeishuChannelError{Code: types.ErrCodeRateLimited})
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
	if err := newFailure("send", nil); err != nil {
		t.Fatalf("newFailure(nil) = %v, want nil", err)
	}
}
