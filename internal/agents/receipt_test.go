package agents

import (
	"context"
	"strings"
	"testing"
)

func TestSayVerifiesFreshManagedReceiptAfterLongPromptScrollsAway(t *testing.T) {
	marker := "HERDR_RECEIPT_0123456789abcdef0123456789abcdef"
	text := strings.Repeat("完整需求和目录配置\n", 80) + marker
	for _, tc := range []struct {
		name, before, after, marker, text string
		queued, want                      bool
	}{
		{"fresh visible tail", "", "任务末尾\n" + marker, marker, text, false, true},
		{"old marker", marker, marker, marker, text, false, false},
		{"wrong echo", "", "HERDR_RECEIPT_11111111111111111111111111111111", marker, text, false, false},
		{"marker absent from submitted text", "", marker, marker, "other text", false, false},
		{"untrusted short marker", "", "ok", "ok", strings.Repeat("long", 100) + "ok", false, false},
		{"queued fresh marker", "", marker, marker, text, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &fakePane{status: StatusIdle, seq: 2, promptStatus: string(StatusWorking),
				screen: claudeScreen(tc.before, ""), screenAfterPrompt: claudeScreen(tc.after, "")}
			if tc.queued {
				p.status = StatusWorking
				p.screenAfterPrompt = claudeScreen("", tc.after)
			}
			h := newInputHarness(t, p)
			guard := h.guard()
			guard.ReceiptMarker = tc.marker
			d, err := h.ctrl.Say(context.Background(), guard, tc.text)
			if err != nil || !d.Acked || d.Verified != tc.want || p.promptCalls != 1 {
				t.Fatalf("delivery=%+v calls=%d err=%v, want verified=%v", d, p.promptCalls, err, tc.want)
			}
		})
	}
}

func TestReceiptCannotVerifyGhostUnreadableOrNonSuffix(t *testing.T) {
	marker := "HERDR_RECEIPT_0123456789abcdef0123456789abcdef"
	before := boxProbe{read: true, all: strings.Split(claudeScreen("", ""), "\n")}
	post := strings.Split(claudeScreen("", marker), "\n")
	if verifyReceiptEcho(post, true, "long body\n"+marker, marker, false, before) {
		t.Fatal("settled prompt verified from composer ghost")
	}
	post = strings.Split(claudeScreen(marker, ""), "\n")
	if verifyReceiptEcho(post, false, marker, marker, false, before) || verifyReceiptEcho(post, true, marker, marker, false, boxProbe{}) {
		t.Fatal("receipt verified without both screen reads")
	}
	if verifyReceiptEcho(post, true, marker+"\ntrailing body", marker, false, before) || verifyReceiptEcho(post, true, marker+"\n"+marker, marker, false, before) {
		t.Fatal("receipt must occur once at the end of the full submission")
	}
}
