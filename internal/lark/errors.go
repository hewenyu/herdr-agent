package lark

import (
	"errors"
	"fmt"
	"strings"

	"github.com/larksuite/oapi-sdk-go/v3/channel/types"
	larkcore "github.com/larksuite/oapi-sdk-go/v3/core"
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

	// appID is carried only so Advice can print a console URL that lands on
	// THIS app's page. It is the app id, never the secret (S2 §3.1).
	appID string
}

func (f *Failure) Error() string {
	msg := fmt.Sprintf("lark: %s: %v", f.Kind, f.cause)
	if f.Op != "" {
		msg = fmt.Sprintf("lark: %s: %s: %v", f.Op, f.Kind, f.cause)
	}
	// The advice is appended to Error rather than left for callers to fetch,
	// because the place a user actually meets one of these codes is a log line
	// that formats the error and nothing else.
	if a := f.Advice(); a != "" {
		msg += " — " + a
	}
	return msg
}

// Advice returns the actionable sentence for this failure's Feishu API code,
// or "" when the code carries no known diagnosis. See Explain.
func (f *Failure) Advice() string {
	code, ok := APICode(f.cause)
	if !ok {
		return ""
	}
	return adviseCode(code, f.appID)
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
//
// appID is only used to build a console URL for the codes Explain knows about;
// "" is fine and yields the URL pattern instead of a link.
func newFailure(op, appID string, err error) error {
	if err == nil {
		return nil
	}
	// ClassifyError returns the existing *FeishuChannelError unchanged when
	// there already is one in the chain, so this neither double-wraps nor
	// loses the SDK's own classification.
	fce := types.ClassifyError(err)
	return &Failure{Op: op, Kind: kindOfCode(fce.Code), cause: fce, appID: appID}
}

// Feishu API codes whose number tells a user nothing and whose cause is always
// the same piece of app configuration.
//
// 99991672 cost this project an hour of staring at a bridge that looked
// healthy; 200340 is the one the README warns about and nothing in the code
// could explain. So the diagnosis lives here rather than in a README nobody
// reads while debugging.
//
// They deliberately do NOT change kindOfCode. Both are permanent failures, and
// FailUnknown already routes to outbound.ClassPermanent (see
// internal/outbound.Classify), so reclassifying them would alter nothing about
// what the bridge DOES — only about what it SAYS, which is what these are for.
const (
	// CodeScopeNotInEffect (99991672) is Feishu's "this app does not hold the
	// scope this call needs".
	//
	// Successful setup proves only the scopes requested at that time. Optional
	// features such as task management can require additional scopes even when
	// credentials, messaging and the published application already work. This
	// code alone cannot distinguish a missing grant from a pending approval or
	// publication, so advice must point to the scopes named in the API error.
	CodeScopeNotInEffect = 99991672

	// CodeCardCallbackFailed (200340) is Feishu refusing an interactive-card
	// operation. It reaches this package from two different places — a card
	// Send and UpdateCard's PATCH — so the advice must not narrate one of them.
	// Two causes produce it and the code cannot distinguish them; see
	// adviseCode.
	CodeCardCallbackFailed = 200340
)

// APICode digs Feishu's numeric API code out of an error chain. ok is false
// when the chain holds no API error at all — a dial failure, a timeout, a
// context cancellation.
//
// Both the pointer and the value form of larkcore.CodeError are checked:
// CodeError.Error has a value receiver, so either can legally sit in a chain,
// and errors.As matches only the exact type it is given.
func APICode(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	var pe *larkcore.CodeError
	if errors.As(err, &pe) && pe != nil {
		return pe.Code, true
	}
	var ve larkcore.CodeError
	if errors.As(err, &ve) {
		return ve.Code, true
	}
	return 0, false
}

// Explain returns a sentence naming the fix for the Feishu API code inside
// err, or "" when there is nothing useful to say. Callers that render an error
// somewhere other than a log line — a card, a doctor report — can use this to
// show the diagnosis on its own.
//
// A *Failure knows its app id and gets a clickable console URL; anything else
// gets the URL pattern.
func Explain(err error) string {
	if err == nil {
		return ""
	}
	var f *Failure
	if errors.As(err, &f) {
		return f.Advice()
	}
	code, ok := APICode(err)
	if !ok {
		return ""
	}
	return adviseCode(code, "")
}

func adviseCode(code int, appID string) string {
	appID = appIDForURL(appID)
	switch code {
	case CodeScopeNotInEffect:
		return "a required scope is not in effect (99991672). " +
			"`herdr-agent setup` grants the scopes requested during setup; optional features such as task management " +
			"may need additional scopes on the same application. Restart `herdr-agent serve` to check permissions " +
			"and automatically generate a login URL on the local configuration page when needed. " +
			"For manual maintenance, stop the bridge and run `herdr-agent setup --update-permissions` " +
			"to open a new confirmation URL for the existing app. " +
			"Check the required scopes listed in the API error " +
			"at https://open.feishu.cn/app/" + appID + "/auth and enable the appropriate application permissions. " +
			"Complete approval and publish the updated version under 版本管理与发布 (创建版本 → 申请发布) " +
			"if required for the changes to take effect, then retry."
	case CodeCardCallbackFailed:
		// E1 sent a card successfully and saw no callback within 120s. That
		// observation cannot separate a 交互卡片 capability that is off from a
		// human who did not press in time, and an unsubscribed callback
		// produces the same silence. Naming one cause here would be a guess
		// presented as fact.
		//
		// The sentence leads with the code's meaning rather than with a story,
		// because UpdateCard reaches it too: on that path nothing was
		// accepted — the PATCH was refused — and Op says "patch message om_…"
		// two clauses earlier.
		return "Feishu refused this card operation with 200340 — the interactive-card path is not working. " +
			"Two causes produce it and the code cannot tell them apart: the card.action.trigger callback is not " +
			"subscribed, or the 交互卡片 capability is off. Check both — the subscription at " +
			"https://open.feishu.cn/app/" + appID + "/event, and 应用能力 → 机器人 → 交互卡片. " +
			"If you change either BY HAND in the console, publish a new version afterwards or the change never " +
			"takes effect; an app registered by `herdr-agent setup` had its callback subscribed and a version " +
			"published by that same confirmation page, so there is no publish step to hunt for on that path."
	default:
		return ""
	}
}

// appIDForURL returns appID when it has the shape of a Feishu app id, and the
// "<app_id>" placeholder otherwise. The placeholder is still useful: the user
// can paste their own id in, and the path after it is the half that is hard to
// find in the console.
//
// The shape check is a leak guard, not cosmetics. The console lists App ID
// directly above App Secret, so transposing the two on the way into .env is an
// ordinary mistake, and config.Validate only checks that both are non-empty —
// the bridge starts, the first write fails auth, and this advice is what gets
// formatted into log/herdr-agent.err.log. Interpolating whatever sits in the
// app-id slot would write the secret there, and S2 §3.1 says the secret never
// enters a log, not even a prefix. A secret carries no "cli_" prefix, so it
// degrades to the placeholder here; so does any junk that would produce a
// broken URL (trailing whitespace, a value the shell left quoted).
//
// The root fix belongs in config.Validate, which should reject an app id that
// does not match this shape instead of loading it.
func appIDForURL(appID string) string {
	const prefix = "cli_"
	if !strings.HasPrefix(appID, prefix) || len(appID) == len(prefix) {
		return "<app_id>"
	}
	for _, r := range appID[len(prefix):] {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
		default:
			return "<app_id>"
		}
	}
	return appID
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

// DefinitiveFailure distinguishes an explicit validation/permission/rate refusal
// from a lost response. Task provisioning may be retried only in the former case.
func (f *Failure) DefinitiveFailure() bool {
	// The SDK currently classifies this explicit permission refusal as unknown.
	// Preserve its public Kind while allowing task creation to retry after the
	// missing scope is granted. Other unknown API errors remain ambiguous.
	if code, ok := APICode(f.cause); ok && code == CodeScopeNotInEffect {
		return true
	}
	switch f.Kind {
	case FailPermissionDenied, FailFormat, FailRateLimited, FailSSRFBlocked:
		return true
	}
	return false
}
