// Package outbound turns bridge output into something Feishu will actually
// render, and turns send failures into a decision about what to do next.
//
// It is pure. No SDK client, no network, no clock, no I/O. Everything here is
// a function of its arguments so that the parts that are easy to get wrong —
// where to cut a 10k-rune answer, whether a retry is safe — are testable
// without a Feishu app.
//
// Three measured facts shape this package:
//
//   - A Feishu message caps out at 8000 characters, so long agent output has
//     to be cut into several messages (S2 §3.8).
//   - A GitHub-style markdown table makes the Feishu `post` renderer emit a
//     BLANK bubble — the message is delivered and the user sees nothing. Any
//     text containing one must be downgraded to plain text before sending.
//   - Retrying a send that timed out double-posts. In this product a
//     duplicate is not cosmetic: the bridge's messages carry instructions and
//     card actions aimed at a live coding agent (G14, G17).
//
// CONTRACT FILE. Signatures here are fixed; implementations must match them.
package outbound

// MaxMessageRunes is Feishu's hard per-message limit. Nothing this package
// produces may exceed it.
const MaxMessageRunes = 8000

// SplitTarget is the practical split point. It leaves headroom under
// MaxMessageRunes for the reply quote, the card wrapper and the multibyte
// expansion of CJK text, none of which are visible from here.
const SplitTarget = 4000

// Chunk is one outgoing message. Index is 1-based; Total is the number of
// chunks the source text became.
//
// Text is ready to send as-is: any code fence left open by the cut has been
// closed at the end of this chunk and reopened at the start of the next, and
// the "(i/n)" indicator is already appended when Total > 1.
type Chunk struct {
	Text  string
	Index int
	Total int
}

// ErrorClass is what the caller should DO about a failed send, not what went
// wrong. Several distinct Feishu codes collapse onto the same action.
type ErrorClass int

// The zero value is ClassPermanent on purpose. An ErrorClass nobody assigned
// must not read as "safe to retry": the cost of a wrong retry is a duplicate
// command injected into a live agent, while the cost of a missed retry is one
// undelivered notification, which S2 §3.8 already requires us to report
// honestly to the user.
const (
	// ClassPermanent: give up. Do NOT resend. Covers permission_denied,
	// ssrf_blocked, send_timeout and every unrecognised error — including any
	// read/write timeout, because the request may already have reached
	// Feishu and a retry would post the message twice.
	ClassPermanent ErrorClass = iota

	// ClassRetryable: the connection never got established, so nothing was
	// delivered and resending is safe. This is deliberately narrow — dial and
	// DNS failures only.
	ClassRetryable

	// ClassFormat: Feishu rejected the payload. Downgrade with ToPlainText
	// and send once more.
	ClassFormat

	// ClassRateLimited: back off, then resend. The SDK already retries this
	// internally; the caller's job is to log it, not to reimplement it.
	ClassRateLimited

	// ClassRevoked: the reply target is gone. Drop ReplyMessageID and resend
	// as a fresh message. The SDK already does this fallback internally; the
	// caller's job is to log it.
	ClassRevoked
)

// Implementations must also provide, exactly:
//
//	split.go:
//		func Split(s string, target int) []Chunk
//
//	  Cuts s into messages of at most `target` runes each — runes, not bytes,
//	  because agent output is routinely CJK and a byte budget would cut
//	  mid-character. target <= 0 means SplitTarget; target above
//	  MaxMessageRunes is clamped down to it, and a target too small to hold
//	  the "(i/n)" indicator plus a reopened fence is clamped up. Text short
//	  enough to fit is returned unchanged as a single chunk with no indicator.
//
//	  Cut points are chosen in order of preference: a newline, then a space,
//	  then a hard cut. A cut may never land inside an inline code span (an odd
//	  number of unescaped backticks so far on the line) — the two halves would
//	  render as literal backticks on the phone.
//
//	  A cut MAY land inside a triple-backtick fence, and then the fence must be
//	  closed at the end of the chunk and reopened with the SAME language tag at
//	  the start of the next. Without that, everything after the cut renders as
//	  garbage.
//
//	table.go:
//		func HasMarkdownTable(s string) bool
//
//	  Reports whether s contains a GitHub-style table: a row containing `|`
//	  followed by a `|---|---|` delimiter row. Callers downgrade such text to
//	  plain text, because the Feishu post renderer turns a table into a blank
//	  bubble.
//
//	plaintext.go:
//		func ToPlainText(s string) string
//
//	  Strips markdown emphasis, code fences, inline code and links, keeping
//	  the content. The result is safe to resend after a format_error. Code
//	  block CONTENT survives — for this product it is usually the command the
//	  user is being asked to approve.
//
//	classify.go:
//		func Classify(err error) ErrorClass
//
//	  Maps *types.FeishuChannelError codes and bare net errors onto the action
//	  the caller should take. Anything it cannot positively identify as safe
//	  is ClassPermanent.
