package outbound

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"syscall"
	"testing"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// timeoutError is what every transport in the stack eventually reduces to: an
// error that says Timeout() == true.
type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func feishuErr(code types.FeishuChannelErrorCode, cause error) error {
	return &types.FeishuChannelError{Code: code, Message: string(code), Cause: cause}
}

func TestClassify(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want ErrorClass
	}{
		// Every code the SDK can produce.
		{"target_revoked", feishuErr(types.ErrCodeTargetRevoked, nil), ClassRevoked},
		{"permission_denied", feishuErr(types.ErrCodePermissionDenied, nil), ClassPermanent},
		{"format_error", feishuErr(types.ErrCodeFormatError, nil), ClassFormat},
		{"rate_limited", feishuErr(types.ErrCodeRateLimited, nil), ClassRateLimited},
		{"ssrf_blocked", feishuErr(types.ErrCodeSSRFBlocked, nil), ClassPermanent},
		{"send_timeout", feishuErr(types.ErrCodeSendTimeout, nil), ClassPermanent},
		{"unknown with no cause", feishuErr(types.ErrCodeUnknown, nil), ClassPermanent},

		// unknown means "the SDK could not tell"; look at the cause ourselves.
		{
			name: "unknown wrapping a refused dial",
			err:  feishuErr(types.ErrCodeUnknown, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}),
			want: ClassRetryable,
		},
		{
			name: "unknown wrapping a read timeout",
			err:  feishuErr(types.ErrCodeUnknown, &net.OpError{Op: "read", Net: "tcp", Err: timeoutError{}}),
			want: ClassPermanent,
		},

		// The channel error may arrive wrapped by our own call stack.
		{
			name: "wrapped channel error",
			err:  fmt.Errorf("send card: %w", feishuErr(types.ErrCodeRateLimited, nil)),
			want: ClassRateLimited,
		},

		// Bare transport errors, no SDK wrapper.
		{
			name: "dial refused",
			err:  &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED},
			want: ClassRetryable,
		},
		{
			name: "network unreachable",
			err:  &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ENETUNREACH},
			want: ClassRetryable,
		},
		{
			name: "dns temporary failure",
			err:  &net.DNSError{Err: "server misbehaving", Name: "open.feishu.cn", IsTemporary: true},
			want: ClassRetryable,
		},
		{
			name: "dns name does not exist",
			err:  &net.DNSError{Err: "no such host", Name: "open.feishu.cn", IsNotFound: true},
			want: ClassPermanent,
		},
		{
			name: "read timeout",
			err:  &net.OpError{Op: "read", Net: "tcp", Err: timeoutError{}},
			want: ClassPermanent,
		},
		{
			name: "write timeout",
			err:  &net.OpError{Op: "write", Net: "tcp", Err: timeoutError{}},
			want: ClassPermanent,
		},
		{
			name: "dial timeout is not retried either",
			err:  &net.OpError{Op: "dial", Net: "tcp", Err: timeoutError{}},
			want: ClassPermanent,
		},
		{"deadline exceeded", context.DeadlineExceeded, ClassPermanent},
		{"os deadline exceeded", os.ErrDeadlineExceeded, ClassPermanent},
		{"context canceled", context.Canceled, ClassPermanent},
		{"connection reset mid-request", syscall.ECONNRESET, ClassPermanent},
		{"eof while reading the response", fmt.Errorf("read body: %w", net.ErrClosed), ClassPermanent},
		{"unrecognised error", errors.New("boom"), ClassPermanent},
		{"nil", nil, ClassPermanent},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Classify(tc.err); got != tc.want {
				t.Errorf("Classify(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// A timeout must never be retried: the request may already have reached
// Feishu, and resending posts a second actionable card to the phone. This is
// the one classification the SDK itself disagrees with, so pin both halves.
func TestClassifyTimeoutIsNotRetryable(t *testing.T) {
	raw := &url.Error{
		Op:  "Post",
		URL: "https://open.feishu.cn/open-apis/im/v1/messages",
		Err: timeoutError{},
	}

	sdkErr := types.ClassifyError(raw)
	if sdkErr.Code != types.ErrCodeSendTimeout {
		t.Fatalf("SDK classified a timeout as %q, want %q", sdkErr.Code, types.ErrCodeSendTimeout)
	}
	if got := Classify(sdkErr); got != ClassPermanent {
		t.Errorf("Classify(send_timeout) = %v, want %v", got, ClassPermanent)
	}
	if got := Classify(raw); got != ClassPermanent {
		t.Errorf("Classify(bare timeout) = %v, want %v", got, ClassPermanent)
	}
}

// Where we deliberately diverge from the SDK: it retries anything it cannot
// classify, we do not. Pin it so the divergence is a decision, not a drift.
func TestClassifyIsStricterThanSDKDefault(t *testing.T) {
	for _, err := range []error{
		errors.New("boom"),
		feishuErr(types.ErrCodeUnknown, errors.New("502 bad gateway")),
	} {
		if !types.IsRetryable(err) {
			t.Fatalf("SDK no longer treats %v as retryable; revisit Classify", err)
		}
		if got := Classify(err); got != ClassPermanent {
			t.Errorf("Classify(%v) = %v, want %v", err, got, ClassPermanent)
		}
	}
}

// The zero value must be the safe one: an ErrorClass nobody assigned must not
// read as "resend it".
func TestErrorClassZeroValueIsPermanent(t *testing.T) {
	var zero ErrorClass
	if zero != ClassPermanent {
		t.Fatalf("zero ErrorClass = %v, want ClassPermanent", zero)
	}
}

func TestErrorClassString(t *testing.T) {
	for _, tc := range []struct {
		class ErrorClass
		want  string
	}{
		{ClassPermanent, "permanent"},
		{ClassRetryable, "retryable"},
		{ClassFormat, "format"},
		{ClassRateLimited, "rate_limited"},
		{ClassRevoked, "revoked"},
	} {
		if got := tc.class.String(); got != tc.want {
			t.Errorf("ErrorClass(%d).String() = %q, want %q", int(tc.class), got, tc.want)
		}
	}
}
