package lark

import (
	"errors"
	"fmt"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// FailKind classifies a Feishu write failure without naming an SDK type.
//
// This package exists so that nothing else imports the Feishu SDK
// (see the package doc in contract.go), and that is only achievable if the
// reason a send failed can cross the boundary in our own vocabulary. S2 §3.8
// requires the caller to tell format_error, rate_limited and target_revoked
// apart — the spec spells those out in the SDK's own words, so the values here
// mirror types.FeishuChannelErrorCode one for one and are deliberately not
// "improved".
type FailKind string

const (
	// FailNone means "not a Feishu write failure": nil, ErrNotConnected,
	// ErrInvalidOut, a context cancellation. Distinct from FailUnknown, which
	// means Feishu did reject the write and neither we nor the SDK could say
	// why.
	FailNone FailKind = ""

	FailTargetRevoked    FailKind = "target_revoked"
	FailPermissionDenied FailKind = "permission_denied"
	FailFormat           FailKind = "format_error"
	FailRateLimited      FailKind = "rate_limited"
	FailSSRFBlocked      FailKind = "ssrf_blocked"
	FailTimeout          FailKind = "send_timeout"
	FailUnknown          FailKind = "unknown"
)

// Sentinels for callers that prefer errors.Is over a switch on FailureKind.
// Both work on the same error; pick one.
var (
	ErrTargetRevoked    = errors.New("lark: the target message or chat is gone")
	ErrPermissionDenied = errors.New("lark: feishu refused the write")
	ErrFormat           = errors.New("lark: feishu could not render the message")
	ErrRateLimited      = errors.New("lark: rate limited by feishu")
	ErrSSRFBlocked      = errors.New("lark: blocked by the SDK's SSRF guard")
	ErrSendTimeout      = errors.New("lark: the write to feishu timed out")
	ErrUnknownFailure   = errors.New("lark: feishu rejected the write for an unrecognised reason")
)

var sentinelByKind = map[FailKind]error{
	FailTargetRevoked:    ErrTargetRevoked,
	FailPermissionDenied: ErrPermissionDenied,
	FailFormat:           ErrFormat,
	FailRateLimited:      ErrRateLimited,
	FailSSRFBlocked:      ErrSSRFBlocked,
	FailTimeout:          ErrSendTimeout,
	FailUnknown:          ErrUnknownFailure,
}

// Failure is what Send, UpdateCard and the stream operations return when
// Feishu refused a write. Kind is the whole point: it lets a caller decide
// between "downgrade to plain text", "back off" and "give up" (S2 §3.8)
// without importing the SDK.
//
// Unwrap still exposes the SDK's *types.FeishuChannelError underneath. That is
// a deliberate, temporary compatibility shim, not an oversight:
// internal/outbound.Classify currently unwraps that type directly, and
// silently degrading every classified failure to "permanent" while another
// agent owns that file would be a worse bug than the layering violation.
// Once internal/outbound switches to FailureKind/the sentinels above and drops
// its "channel/types" import, this Unwrap should return f.cause's own cause
// instead, and the SDK type stops escaping entirely.
type Failure struct {
	// Op is the operation that failed, e.g. "send" or "patch message om_1".
	Op   string
	Kind FailKind

	cause error
}

func (f *Failure) Error() string {
	if f.Op == "" {
		return fmt.Sprintf("lark: %s: %v", f.Kind, f.cause)
	}
	return fmt.Sprintf("lark: %s: %s: %v", f.Op, f.Kind, f.cause)
}

func (f *Failure) Unwrap() error { return f.cause }

// Is makes errors.Is(err, ErrRateLimited) and friends work. It matches only
// the sentinel for this failure's kind, so an unrelated sentinel such as
// ErrNotConnected never matches by accident.
func (f *Failure) Is(target error) bool {
	s, ok := sentinelByKind[f.Kind]
	return ok && s == target
}

// FailureKind reports how a failed write should be handled. It returns
// FailNone for nil and for errors that are not Feishu write failures.
func FailureKind(err error) FailKind {
	if err == nil {
		return FailNone
	}
	var f *Failure
	if errors.As(err, &f) {
		return f.Kind
	}
	// An error that came from the SDK without passing through newFailure (for
	// instance one a test constructed) should still classify.
	var fce *types.FeishuChannelError
	if errors.As(err, &fce) {
		return kindOfCode(fce.Code)
	}
	return FailNone
}

// newFailure classifies a raw SDK error and hides it behind our taxonomy.
// It returns nil for a nil error so callers can write `return newFailure(...)`.
func newFailure(op string, err error) error {
	if err == nil {
		return nil
	}
	// ClassifyError returns the existing *FeishuChannelError unchanged when
	// there already is one in the chain, so this neither double-wraps nor
	// loses the SDK's own classification.
	fce := types.ClassifyError(err)
	return &Failure{Op: op, Kind: kindOfCode(fce.Code), cause: fce}
}

func kindOfCode(c types.FeishuChannelErrorCode) FailKind {
	switch c {
	case types.ErrCodeTargetRevoked:
		return FailTargetRevoked
	case types.ErrCodePermissionDenied:
		return FailPermissionDenied
	case types.ErrCodeFormatError:
		return FailFormat
	case types.ErrCodeRateLimited:
		return FailRateLimited
	case types.ErrCodeSSRFBlocked:
		return FailSSRFBlocked
	case types.ErrCodeSendTimeout:
		return FailTimeout
	default:
		return FailUnknown
	}
}
