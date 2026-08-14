package outbound

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
)

// Classify decides what to do about a failed send. See contract.go.
//
// The rule that matters: a timeout is PERMANENT, and so is anything we cannot
// identify. types.IsRetryable takes the opposite default — unknown codes and
// plain errors are retryable there, which is right for a generic client. It is
// wrong here. This bridge's messages carry actionable cards aimed at a live
// coding agent, and a request that timed out may already have reached Feishu;
// resending posts a second card with a second live button (compare G14, where
// a redelivered event re-injected a command into a running agent). One
// undelivered notification is the cheaper failure, and S2 §3.8 already
// requires us to tell the user about it rather than hide it.
//
// Classify(nil) is ClassPermanent. nil is not a failure; callers should not
// reach here with one, and "do nothing" is the safe reading if they do.
func Classify(err error) ErrorClass {
	if err == nil {
		return ClassPermanent
	}

	var fce *types.FeishuChannelError
	if errors.As(err, &fce) {
		switch fce.Code {
		case types.ErrCodeTargetRevoked:
			return ClassRevoked
		case types.ErrCodeFormatError:
			return ClassFormat
		case types.ErrCodeRateLimited:
			return ClassRateLimited
		case types.ErrCodePermissionDenied, types.ErrCodeSSRFBlocked:
			return ClassPermanent
		case types.ErrCodeSendTimeout:
			return ClassPermanent
		case types.ErrCodeUnknown:
			// The SDK could not tell either. Fall through and look at the
			// wrapped cause ourselves; FeishuChannelError.Unwrap exposes it.
		}
	}

	if isTimeout(err) {
		return ClassPermanent
	}
	if isConnectFailure(err) {
		return ClassRetryable
	}
	return ClassPermanent
}

// isTimeout covers every flavour of deadline: the transport's own, a context
// deadline propagated through it, and net.Error.Timeout().
func isTimeout(err error) bool {
	if errors.Is(err, os.ErrDeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// isConnectFailure reports errors that prove the request never left the
// machine, which is the only situation where resending cannot duplicate.
//
// Deliberately narrow. io.EOF and ECONNRESET are excluded: both can happen
// after the request bytes were written, so the server may have acted on them.
func isConnectFailure(err error) bool {
	if errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ENETUNREACH) ||
		errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETDOWN) {
		return true
	}

	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		// A name that does not exist is a configuration bug, not a blip.
		return !dnsErr.IsNotFound
	}

	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return opErr.Op == "dial"
	}
	return false
}

// String makes ErrorClass readable in logs. S2 §3.8 requires the rate-limit
// and revoked-target fallbacks to be recorded even though the SDK performs
// them itself.
func (c ErrorClass) String() string {
	switch c {
	case ClassRetryable:
		return "retryable"
	case ClassFormat:
		return "format"
	case ClassRateLimited:
		return "rate_limited"
	case ClassRevoked:
		return "revoked"
	case ClassPermanent:
		return "permanent"
	default:
		return "permanent"
	}
}
