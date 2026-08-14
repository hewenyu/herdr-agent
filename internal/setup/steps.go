package setup

import (
	"fmt"
	"strings"
	"time"
)

// console builds the developer-console URLs for one app.
//
// Every Step this package emits names a page, never a category: "configure the
// app" is a sentence the reader cannot act on, and the whole point of setup is
// that the two or three things it cannot do for you are each one click away.
type console struct {
	appID string
	// lark switches to the international console. The registration flow tells
	// us which it is: the SDK reports StatusDomainSwitched when the confirming
	// user's tenant brand is "lark" and re-points the device flow at
	// accounts.larksuite.com.
	lark bool
}

func (c console) host() string {
	if c.lark {
		return "https://open.larksuite.com"
	}
	return "https://open.feishu.cn"
}

func (c console) page(name string) string {
	return fmt.Sprintf("%s/app/%s/%s", c.host(), c.appID, name)
}

// event is 事件与回调 — the event list AND the delivery mode.
func (c console) event() string { return c.page("event") }

// auth is 权限管理 — the scope list.
func (c console) auth() string { return c.page("auth") }

// bot is 应用能力 → 机器人, where the 交互卡片 toggle lives.
func (c console) bot() string { return c.page("bot") }

// stepNoInbound is emitted when no message arrived within the wait.
//
// Inbound arrival is the single observation that proves credentials, bot
// capability, event subscription, delivery mode, publication, scopes and the
// allowlist all at once, so its absence cannot be attributed to one of them.
// The two pages below are where the causes that are not automatic live, in the
// order they are worth checking.
func stepNoInbound(c console, waited time.Duration) []Step {
	return []Step{
		{
			What: fmt.Sprintf("Open %s and confirm 事件配置 → 订阅方式 is 「使用长连接接收事件」, "+
				"and that im.message.receive_v1 is in the list. Then message the bot again.", c.event()),
			URL: c.event(),
			Why: fmt.Sprintf("No message reached the bridge in %s. That one observation covers credentials, "+
				"the bot capability, the event subscription, the delivery mode, publication, scopes and the "+
				"allowlist together, so it cannot say which of them is missing — but delivery mode and the "+
				"event list are the two that a freshly registered app can plausibly be missing.", waited),
		},
		{
			What: fmt.Sprintf("Open %s and confirm im:message and im:message.p2p_msg:readonly are granted.", c.auth()),
			URL:  c.auth(),
			Why: "The confirmation page grants the scopes it lists, so these should already be there; " +
				"if one is missing, the app was created from a different page than the link setup opened.",
		},
	}
}

// inboundFailureSteps picks the checklist for a verification that never got a
// usable message. The two cases are EXCLUSIVE, and that is the whole point.
//
// An empty body proves an event arrived, which is how we know the body was
// empty — so credentials, publication, delivery mode, the event subscription
// and the allowlist are already confirmed. Printing stepNoInbound as well would
// open the checklist with "No message reached the bridge", which is false, and
// send the reader to a console page where nothing is wrong before they reach the
// one accurate line.
func inboundFailureSteps(c console, waited time.Duration, sawEmpty bool) []Step {
	if sawEmpty {
		return []Step{stepEmptyBody(c)}
	}
	return stepNoInbound(c, waited)
}

// stepEmptyBody is emitted when a message arrived with no text at all.
//
// The event reached us, so delivery works; what did not arrive is the content.
// The scope is the likely cause and the one worth naming, but a sticker or an
// image produces exactly the same observation, so the step says both rather
// than sending the reader to a page where nothing is wrong.
func stepEmptyBody(c console) Step {
	return Step{
		What: fmt.Sprintf("Send the bot a plain text message. If it still arrives empty, open %s and "+
			"grant im:message.p2p_msg:readonly.", c.auth()),
		URL: c.auth(),
		Why: "A message event arrived with an empty body. Either it was not a text message — a sticker or " +
			"an image reads exactly like this — or im:message.p2p_msg:readonly is not granted, in which case " +
			"the bridge would later fail to parse commands and blame the command parser.",
	}
}

// pageConfigured reports whether this app's scopes, events and callbacks were
// granted by the confirmation page — during this run, on this app.
//
// It decides how the card checklist hedges, and the answer was measured. The E1
// probe saw no card.action.trigger in 120s and could not tell a missing 交互卡片
// toggle from a human who did not press in time; a later run on THAT SAME APP
// completed the round trip. So an app that came through the confirmation page
// has a working card path, and the remaining hedge belongs on an app somebody
// built by hand in the console.
func (o Origin) pageConfigured() bool {
	switch o {
	case OriginRegistered, OriginCreated, OriginUpdated:
		return true
	default:
		return false
	}
}

// stepCardTimeout says what an un-pressed button means, and how much of the
// ambiguity survives.
//
// Not much, for an app the confirmation page configured: that page was measured
// to produce a working card path, on the same app whose earlier probe saw
// nothing. For an app configured by hand the two causes really are
// indistinguishable from here, and both are listed. Neither branch drops the
// 200340 fact: an unsubscribed card.action.trigger produces it, and that is what
// the bridge will report later if this is left broken.
func stepCardTimeout(c console, o Origin, waited time.Duration) Step {
	if o.pageConfigured() {
		return Step{
			What: fmt.Sprintf("Press the button on the card the bot sent you, while setup is waiting. If it is "+
				"already pressed and nothing happened, re-run `herdr-agent setup` and press it again — and if "+
				"THAT fails too, open %s and check 应用能力 → 机器人 → 交互卡片 and the card.action.trigger "+
				"subscription.", c.bot()),
			URL: c.bot(),
			Why: fmt.Sprintf("The card was delivered but no card.action.trigger arrived within %s. This app was "+
				"configured through the confirmation page, which was measured to arrive with the card path "+
				"working — the same app that once showed no callback later completed the round trip — so a "+
				"button nobody pressed in time is by far the likeliest cause. A card path that is genuinely "+
				"off shows up later as Feishu error 200340: either the 交互卡片 capability or the "+
				"card.action.trigger subscription.", waited),
		}
	}
	return Step{
		What: fmt.Sprintf("Either press the button on the card the bot just sent you, or open %s and turn on "+
			"应用能力 → 机器人 → 交互卡片 (and subscribe card.action.trigger, then publish a version). Do the "+
			"first one first: it costs one tap and rules the second one out.", c.bot()),
		URL: c.bot(),
		Why: fmt.Sprintf("The card was delivered but no card.action.trigger arrived within %s. That is what an "+
			"un-pressed button looks like AND what a disabled 交互卡片 capability looks like; this app's "+
			"capabilities were not granted by a confirmation page during this run, so the two really are "+
			"indistinguishable from here and both are listed. The second cause shows up as Feishu error "+
			"200340 once the bridge tries to answer a press.", waited),
	}
}

// stepCardSendFailed is emitted when the card could not even be sent.
//
// The cause decides the advice. A missing scope is the one a console visit
// fixes; a socket that dropped between the inbound message and the card
// (lark.ErrNotConnected) is not, and the inbound message has already proved the
// scopes were granted. Naming 权限管理 for that costs the reader a trip to a
// page where nothing is wrong — the same mistake stepEmptyBody exists to avoid.
func stepCardSendFailed(c console, reason string) Step {
	if looksLikePermission(reason) {
		return Step{
			What: fmt.Sprintf("Open %s and confirm im:message:send_as_bot is granted, then run setup again.", c.auth()),
			URL:  c.auth(),
			Why:  "Sending the verification card failed with what reads as a permission error: " + reason,
		}
	}
	return Step{
		What: fmt.Sprintf("The card could not be sent: %s. Re-run `herdr-agent setup` once the connection is back.", reason),
		URL:  c.event(),
		Why: "The message that arrived a moment earlier already proved the credentials, the scopes and " +
			"the delivery mode, so nothing in the console is known to be wrong: the send itself never " +
			"reached Feishu.",
	}
}

// looksLikePermission reports whether reason reads like Feishu refusing on
// authority rather than the transport failing.
//
// Feishu's refusals carry a 999xx code and usually the word "permission"; a
// transport failure carries neither. Matching on the reason is a heuristic, and
// it is deliberately biased towards the console: being sent to 权限管理 for a
// network blip wastes one click, while being told "re-run it later" for a
// missing scope wastes the whole run.
func looksLikePermission(reason string) bool {
	lower := strings.ToLower(reason)
	return strings.Contains(lower, "permission") || strings.Contains(lower, "9999")
}

// stepConnect is emitted when the long connection never came up.
func stepConnect(c console, reason string) Step {
	return Step{
		What: fmt.Sprintf("Check this machine's network, then open %s and confirm 订阅方式 is "+
			"「使用长连接接收事件」.", c.event()),
		URL: c.event(),
		Why: "The Feishu long connection could not be established: " + reason +
			". Nothing was verified, but the credentials are on disk, so re-running setup resumes from here.",
	}
}

// stepManualFile is the one kind of step whose action is on this machine rather
// than in the console, so its URL is a file:// path — still one click in most
// terminals, and still concrete.
func stepManualFile(path, what, why string) Step {
	return Step{What: what, URL: "file://" + path, Why: why}
}
