package bridge

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/lark"
)

func TestClearUsesCurrentPrivateChatAndPreservesTasks(t *testing.T) {
	h := newHarness(t)
	first := taskBinding("first", "oc_first", testPane)
	second := taskBinding("second", "oc_second", secondPane)
	_, store := attachTaskManager(t, h, first, second)
	before := store.List()
	a := taskAgent(first)
	h.reg.setAgents(a, taskAgent(second))
	h.selectAgent(testChat, a)
	h.routes.bindAbout("om_first_task_reply", a)
	selectionBefore, _ := h.selected(testChat)
	var got []AssistantMessage
	WithAssistant(assistantFunc(func(_ context.Context, m AssistantMessage) (string, error) {
		got = append(got, m)
		return "已开启新的助手会话。", nil
	}))(h.b)

	messages := []lark.Msg{
		inbound("/clear"),
		inbound("／CLEAR"),
		inbound(" / clear "),
	}
	for i, m := range messages {
		m.EventID, m.MessageID = fmt.Sprintf("ev_clear_%d", i), fmt.Sprintf("om_clear_%d", i)
		if i > 0 {
			m.ChatID = fmt.Sprintf("oc_private_%d", i)
		}
		// A quoted reply from another chat must not choose the reset scope.
		m.ReplyToMessageID = "om_first_task_reply"
		m.MentionedBot = false
		sendTaskMessage(t, h, m)
		sendTaskMessage(t, h, m)
		want := AssistantMessage{OwnerID: testOwner, ChatID: m.ChatID, MessageID: m.MessageID, Text: m.Text}
		if len(got) != i+1 || got[i] != want {
			t.Fatalf("clear scope or event dedup changed: got %+v, want %+v", got, want)
		}
		if sends := h.bot.sends(); len(sends) != i+1 || sends[i].Out.ChatID != m.ChatID || sends[i].Out.ReplyMessageID != m.MessageID {
			t.Fatalf("clear confirmation escaped source chat or was duplicated: %+v", sends)
		}
	}
	if after := store.List(); !reflect.DeepEqual(before, after) {
		t.Fatalf("clear modified task records: before=%+v after=%+v", before, after)
	}
	if selected, ok := h.selected(testChat); !ok || !reflect.DeepEqual(selected, selectionBefore) {
		t.Fatalf("clear changed the selected coding agent: %+v", selected)
	}
	assertNothingWasTyped(t, h, "clearing assistant history must not reset a coding agent")
}

func TestClearRejectsUnauthorizedSenders(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(fmt.Sprintf("bound=%t", bound), func(t *testing.T) {
			h := newHarness(t, func(d *Deps) {
				if bound {
					// An allowlisted user still cannot reset another owner's task.
					d.AllowedOpenIDs = []string{testOwner, testStranger}
				}
			})
			r := taskBinding("owned", "oc_owned", testPane)
			attachTaskManager(t, h, r)
			h.reg.setAgents(taskAgent(r))
			WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
				t.Fatal("unauthorized clear reached the assistant")
				return "", nil
			}))(h.b)
			m := inbound("/clear")
			if bound {
				m = taskInbound(r, "/clear")
			}
			m.UserID = testStranger
			sendTaskMessage(t, h, m)
			if len(h.bot.sends()) != 0 {
				t.Fatal("unauthorized clear received a response")
			}
			assertNothingWasTyped(t, h, "unauthorized clear")
		})
	}
}

func TestClearWithoutAIExplainsAvailability(t *testing.T) {
	h := newHarness(t)
	attachTaskManager(t, h)
	h.reg.setAgents(idleAgent(testPane))
	sendTaskMessage(t, h, inbound("/clear"))
	answer := lastText(t, h)
	if !strings.Contains(answer, "AI") || !strings.Contains(answer, "/clear") {
		t.Fatalf("missing availability explanation: %s", answer)
	}
	assertNothingWasTyped(t, h, "clear without AI")
}

func TestClearTaskGroupsCannotResetSessions(t *testing.T) {
	for _, chatType := range []string{lark.ChatGroup, lark.ChatP2P} {
		for _, ai := range []bool{false, true} {
			t.Run(fmt.Sprintf("chat=%s/ai=%t", chatType, ai), func(t *testing.T) {
				h := newHarness(t)
				r := taskBinding("owned", "oc_owned", testPane)
				_, store := attachTaskManager(t, h, r)
				before := store.List()
				h.reg.setAgents(taskAgent(r))
				if ai {
					WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
						t.Fatal("bound task group clear reached the assistant")
						return "", nil
					}))(h.b)
				}
				m := taskInbound(r, "/clear")
				m.ChatType = chatType
				sendTaskMessage(t, h, m)
				sendTaskMessage(t, h, m)
				answer := lastText(t, h)
				if !strings.Contains(answer, "主应用私聊") || !strings.Contains(answer, "/clear") {
					t.Fatalf("missing private-chat-only explanation: %s", answer)
				}
				if len(h.bot.sends()) != 1 {
					t.Fatal("duplicate group clear produced another reply")
				}
				if after := store.List(); !reflect.DeepEqual(before, after) {
					t.Fatalf("rejected group clear modified tasks: %+v", after)
				}
				assertNothingWasTyped(t, h, "group clear must preserve the task session")
			})
		}
	}
}

func TestClearArgumentsNeverReachAssistantOrAgent(t *testing.T) {
	for _, bound := range []bool{false, true} {
		for _, input := range []string{"/clear 创建新项目", "／CLEAR\n创建新项目"} {
			t.Run(fmt.Sprintf("bound=%t/%s", bound, input), func(t *testing.T) {
				h := newHarness(t)
				r := taskBinding("owned", "oc_owned", testPane)
				attachTaskManager(t, h, r)
				h.reg.setAgents(taskAgent(r))
				WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
					t.Fatal("clear with arguments reached the assistant")
					return "", nil
				}))(h.b)
				m := inbound(input)
				if bound {
					m = taskInbound(r, input)
				}
				sendTaskMessage(t, h, m)
				answer := lastText(t, h)
				if !strings.Contains(answer, "单独发送 /clear") || !strings.Contains(answer, "再发送新需求") {
					t.Fatalf("missing separate-request instruction: %s", answer)
				}
				assertNothingWasTyped(t, h, "clear with arguments")
			})
		}
	}
}

func TestClearFailureIsReportedWithoutLeakingOrAgentInput(t *testing.T) {
	const secret = "private-provider-detail"
	h := newHarness(t)
	r := taskBinding("owned", "oc_owned", testPane)
	attachTaskManager(t, h, r)
	h.reg.setAgents(taskAgent(r))
	WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
		return "", errors.New(secret)
	}))(h.b)
	sendTaskMessage(t, h, inbound("/clear"))
	answer := lastText(t, h)
	if !strings.Contains(answer, "失败") || strings.Contains(answer, secret) {
		t.Fatalf("clear failure was hidden or exposed implementation details: %s", answer)
	}
	assertNothingWasTyped(t, h, "failed clear")
}
