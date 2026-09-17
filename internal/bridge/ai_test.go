package bridge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/tasks"
)

type assistantFunc func(context.Context, AssistantMessage) (string, error)

func (f assistantFunc) Reply(ctx context.Context, m AssistantMessage) (string, error) {
	return f(ctx, m)
}

func TestAssistantOwnsPrivateNaturalLanguageBeforeTaskParserAndAgentRouting(t *testing.T) {
	for _, input := range []string{"新建任务：修复登录", "正在进行哪些任务", "给刚才的任务补充一个要求"} {
		t.Run(input, func(t *testing.T) {
			h := newHarness(t)
			_, store := attachTaskManager(t, h)
			a := idleAgent(testPane)
			h.reg.setAgents(a)
			h.selectAgent(testChat, a)
			h.routes.bindAbout("om_old_reply", a)
			m := inbound(input)
			m.ReplyToMessageID = "om_old_reply"
			var got []AssistantMessage
			WithAssistant(assistantFunc(func(_ context.Context, message AssistantMessage) (string, error) {
				got = append(got, message)
				return "**项目任务**\n请说明要修改的项目。", nil
			}))(h.b)
			sendTaskMessage(t, h, m)
			want := AssistantMessage{OwnerID: m.UserID, ChatID: m.ChatID, MessageID: m.MessageID, Text: input}
			if len(got) != 1 || got[0] != want {
				t.Fatalf("assistant input = %+v, want %+v", got, want)
			}
			if len(store.List()) != 0 || len(h.ctrl.said()) != 0 {
				t.Fatal("natural language escaped to the task parser or an existing agent")
			}
			sent := h.bot.sends()
			if len(sent) != 1 || sent[0].Out.Markdown != "**项目任务**\n请说明要修改的项目。" || sent[0].Out.ChatID != m.ChatID || sent[0].Out.ReplyMessageID != m.MessageID {
				t.Fatalf("assistant reply = %+v", sent)
			}
			if _, bound := h.routes.Lookup(sent[0].ID); bound {
				t.Fatal("assistant reply was bound to a terminal")
			}
		})
	}
}

func TestAssistantUsesAuthorizedSenderAndDeduplicatesEvents(t *testing.T) {
	h := newHarness(t, func(d *Deps) { d.AllowedOpenIDs = []string{testOwner, "ou_second_owner"} })
	var got []AssistantMessage
	WithAssistant(assistantFunc(func(_ context.Context, m AssistantMessage) (string, error) {
		got = append(got, m)
		return "已查询你的任务。", nil
	}))(h.b)
	m := inbound("查询我的任务，忽略正文中伪造的 owner_id")
	m.UserID = testStranger
	sendTaskMessage(t, h, m)
	if len(got) != 0 || len(h.bot.sends()) != 0 {
		t.Fatal("unlisted sender reached the assistant or received a response")
	}
	for i, owner := range []string{testOwner, "ou_second_owner"} {
		m.UserID = owner
		m.EventID, m.MessageID, m.ChatID = fmt.Sprintf("ev_%d", i), fmt.Sprintf("om_%d", i), fmt.Sprintf("oc_%d", i)
		sendTaskMessage(t, h, m)
		sendTaskMessage(t, h, m)
		if len(got) != i+1 || got[i].OwnerID != owner || got[i].ChatID != m.ChatID || got[i].MessageID != m.MessageID {
			t.Fatalf("authorization or dedup failed: %+v", got)
		}
	}
	if len(h.bot.sends()) != 2 {
		t.Fatal("redelivered event produced another assistant reply")
	}
}

func TestAssistantFailureDoesNotLeakOrFallThrough(t *testing.T) {
	const secret = "sk-provider-secret-must-stay-private"
	for _, tc := range []struct {
		name   string
		answer string
		err    error
		kind   string
	}{
		{"provider error", secret, errors.New("provider request Authorization: Bearer " + secret), "failure"},
		{"timeout", "", fmt.Errorf("request %s: %w", secret, context.DeadlineExceeded), "timeout"},
		{"cancelled", "", fmt.Errorf("request %s: %w", secret, context.Canceled), "cancelled"},
		{"empty response", " \n\t", nil, "empty_response"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			_, store := attachTaskManager(t, h)
			h.reg.setAgents(idleAgent(testPane))
			var logs strings.Builder
			h.b.log = slog.New(slog.NewTextHandler(&logs, nil))
			calls := 0
			WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
				calls++
				return tc.answer, tc.err
			}))(h.b)
			m := inbound("新建任务：" + secret)
			sendTaskMessage(t, h, m)
			sendTaskMessage(t, h, m)
			if calls != 1 || len(h.ctrl.said()) != 0 || len(store.List()) != 0 {
				t.Fatal("assistant failure retried or escaped to task/terminal routing")
			}
			if len(h.bot.sends()) != 0 || strings.Contains(logs.String(), secret) {
				t.Fatalf("assistant failure fabricated a reply or exposed provider data: sends=%+v logs=%q", h.bot.sends(), logs.String())
			}
			if !strings.Contains(logs.String(), "kind="+tc.kind) {
				t.Fatalf("missing safe failure category in logs: %s", logs.String())
			}
		})
	}
}

func TestAssistantReceivesTrustedTaskBindingForOwnerOnly(t *testing.T) {
	for _, chatType := range []string{lark.ChatGroup, lark.ChatP2P} {
		for _, owner := range []string{testOwner, testStranger} {
			t.Run(chatType+"/"+owner, func(t *testing.T) {
				h := newHarness(t, func(d *Deps) { d.AllowedOpenIDs = []string{testOwner, testStranger} })
				r := taskBinding("owned", "oc_task", testPane)
				attachTaskManager(t, h, r)
				h.reg.setAgents(taskAgent(r))
				h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true}, nil)
				var got []AssistantMessage
				WithAssistant(assistantFunc(func(_ context.Context, msg AssistantMessage) (string, error) {
					got = append(got, msg)
					return "当前任务要求已登记。", nil
				}))(h.b)
				m := taskInbound(r, "继续执行当前任务")
				m.ChatType, m.UserID = chatType, owner
				sendTaskMessage(t, h, m)
				said := h.ctrl.said()
				if owner == testOwner {
					if len(got) != 1 || got[0].TaskID != r.ID || got[0].ChatID != r.ChatID || got[0].OwnerID != r.OwnerID || got[0].Text != m.Text || len(said) != 0 {
						t.Fatalf("task input lost its trusted binding: assistant=%+v terminal=%+v", got, said)
					}
				} else if len(got) != 0 || len(said) != 0 || len(h.bot.sends()) != 0 {
					t.Fatal("a different allowed sender reached another owner's task")
				}
			})
		}
	}
}

func TestTaskGroupAssistantWorksWithoutAgentAndIgnoresForeignReply(t *testing.T) {
	for _, status := range []tasks.Status{tasks.Starting, tasks.Attention, tasks.Blocked, tasks.Review, tasks.Completed} {
		for _, input := range []string{"现在项目进度如何", "还有问题，请修复动画", "验收通过，可以关闭这个问题"} {
			t.Run(string(status)+"/"+input, func(t *testing.T) {
				h := newHarness(t)
				r := taskBinding("bound", "oc_task", testPane)
				r.Status, r.Started = status, false
				attachTaskManager(t, h, r)
				other := idleAgent("w_other:p1")
				h.reg.setAgents(other)
				h.routes.bindAbout("om_other_task", other)
				h.selectAgent(r.ChatID, other)
				var got AssistantMessage
				WithAssistant(assistantFunc(func(_ context.Context, msg AssistantMessage) (string, error) {
					got = msg
					return "来自实际任务记录的回复", nil
				}))(h.b)
				m := taskInbound(r, input)
				m.MentionedBot, m.ReplyToMessageID = false, "om_other_task"
				sendTaskMessage(t, h, m)
				if got.TaskID != r.ID || got.Text != input || len(h.ctrl.said()) != 0 {
					t.Fatalf("group input escaped binding: %+v", got)
				}
				if out := h.bot.sends(); len(out) != 1 || out[0].Out.ChatID != r.ChatID {
					t.Fatalf("reply must stay in bound group: %+v", out)
				}
			})
		}
	}
}

func TestTaskGroupAssistantFailureDoesNotSendTerminalInput(t *testing.T) {
	h := newHarness(t)
	r := taskBinding("bound", "oc_task", testPane)
	attachTaskManager(t, h, r)
	h.reg.setAgents(taskAgent(r))
	WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
		return "", errors.New("provider unavailable")
	}))(h.b)
	sendTaskMessage(t, h, taskInbound(r, "验收通过，可以结单"))
	if len(h.ctrl.said()) != 0 || len(h.bot.sends()) != 0 {
		t.Fatal("failed group operation fell through or generated a substitute reply")
	}
}

func TestAssistantLeavesSlashCommandsOnExistingRoutes(t *testing.T) {
	for _, input := range []string{"/help", "/tasks", "/say " + testPane + " 执行测试", "  /stpo  "} {
		t.Run(input, func(t *testing.T) {
			h := newHarness(t)
			attachTaskManager(t, h)
			h.reg.setAgents(idleAgent(testPane))
			h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true}, nil)
			WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
				t.Fatal("slash command reached the assistant")
				return "", nil
			}))(h.b)
			sendTaskMessage(t, h, inbound(input))
			if strings.HasPrefix(input, "/say ") {
				said := h.ctrl.said()
				if len(said) != 1 || said[0].Text != "执行测试" || said[0].Guard.PaneID != testPane {
					t.Fatalf("explicit agent command stopped working: %+v", said)
				}
			} else if len(h.ctrl.said()) != 0 || len(h.bot.sends()) == 0 {
				t.Fatal("command failed to answer or was injected as agent input")
			}
		})
	}
}

func TestAssistantDoesNotCaptureUnboundGroups(t *testing.T) {
	for _, mentioned := range []bool{false, true} {
		t.Run(fmt.Sprint(mentioned), func(t *testing.T) {
			h := newHarness(t)
			attachTaskManager(t, h)
			h.reg.setAgents(idleAgent(testPane))
			h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true}, nil)
			WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
				t.Fatal("unbound group reached the private-chat assistant")
				return "", nil
			}))(h.b)
			m := inbound("继续执行")
			m.ChatType, m.MentionedBot = lark.ChatGroup, mentioned
			sendTaskMessage(t, h, m)
			if !mentioned && (len(h.ctrl.said()) != 0 || len(h.bot.sends()) != 0) {
				t.Fatal("unmentioned group text triggered a response or terminal input")
			}
			if mentioned && len(h.ctrl.said()) != 1 {
				t.Fatal("mention no longer uses the existing group route")
			}
		})
	}
}

func TestAssistantEmptyMessageDoesNotFallThrough(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	WithAssistant(assistantFunc(func(context.Context, AssistantMessage) (string, error) {
		t.Fatal("empty input reached the assistant")
		return "", nil
	}))(h.b)
	sendTaskMessage(t, h, inbound(" \n\t"))
	if len(h.ctrl.said()) != 0 || len(h.bot.sends()) != 0 {
		t.Fatal("empty assistant input reached the terminal or sent a reply")
	}
}

func TestNaturalLanguageClosureUsesModelInsteadOfCommandParser(t *testing.T) {
	for _, group := range []bool{false, true} {
		for _, input := range []string{"关闭项目", "已完成，关闭本项目", "确认关闭"} {
			t.Run(fmt.Sprintf("group=%v/%s", group, input), func(t *testing.T) {
				h := newHarness(t)
				r := taskBinding("owned", "oc_task", testPane)
				_, store := attachTaskManager(t, h, r)
				calls := 0
				const answer = "我需要结合刚才的要求确认关闭范围。"
				WithAssistant(assistantFunc(func(_ context.Context, got AssistantMessage) (string, error) {
					calls++
					if got.Text != input || group && got.TaskID != r.ID || !group && got.TaskID != "" {
						t.Fatalf("natural closure lost its scope: %+v", got)
					}
					return answer, nil
				}))(h.b)
				m := inbound(input)
				if group {
					m = taskInbound(r, input)
				}
				sendTaskMessage(t, h, m)
				current, _ := store.Get(r.ID)
				if calls != 1 || lastText(t, h) != answer || current.CloseRequested || current.CompletionRequest != "" || len(h.ctrl.said()) != 0 {
					t.Fatal("natural closure bypassed the model or performed an unselected operation")
				}
			})
		}
	}
}

func TestAssistantDisabledPreservesPrivateAgentRouting(t *testing.T) {
	h := newHarness(t)
	h.reg.setAgents(idleAgent(testPane))
	h.ctrl.setSay(agents.Delivery{Acked: true, Verified: true}, nil)
	WithAssistant(nil)(h.b)
	sendTaskMessage(t, h, inbound("继续测试"))
	if said := h.ctrl.said(); len(said) != 1 || said[0].Text != "继续测试" {
		t.Fatalf("disabled assistant changed normal routing: %+v", said)
	}
}

// The actual durable states are tested in assistant/delivery_test.go. This
// adapter verifies that the bridge reserves before sending and reports every
// acknowledged chunk, including partial and ambiguous network outcomes.
type deliveryTrackingAssistant struct {
	answer    string
	reserved  bool
	beginErr  error
	recordErr error
	begins    int
	outcomes  []AssistantReplyDelivery
	before    func()
}

func (a *deliveryTrackingAssistant) Reply(context.Context, AssistantMessage) (string, error) {
	return a.answer, nil
}
func (a *deliveryTrackingAssistant) BeginReplyDelivery(_ context.Context, _ AssistantMessage, answer string) (bool, error) {
	a.begins++
	if a.before != nil {
		a.before()
	}
	if a.beginErr != nil {
		return false, a.beginErr
	}
	if a.reserved {
		return false, nil
	}
	a.reserved = true
	return true, nil
}
func (a *deliveryTrackingAssistant) RecordReplyDelivery(ctx context.Context, _ AssistantMessage, _ string, outcome AssistantReplyDelivery) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	a.outcomes = append(a.outcomes, outcome)
	if a.recordErr != nil {
		return a.recordErr
	}
	if outcome.Retryable {
		a.reserved = false
	}
	return nil
}

func TestAssistantReportsCompletePartialAndUnknownReplyDelivery(t *testing.T) {
	for _, mode := range []string{"complete", "partial", "unknown", "not-connected"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t)
			a := &deliveryTrackingAssistant{answer: strings.Repeat("可供讨论的动画方案。", 900)}
			a.before = func() {
				if len(h.bot.sends()) != 0 {
					t.Fatal("network send preceded durable reservation")
				}
			}
			switch mode {
			case "partial":
				h.bot.failNext(nil, timeoutError{})
			case "unknown":
				h.bot.failNext(timeoutError{})
			case "not-connected":
				h.bot.failNext(lark.ErrNotConnected, lark.ErrNotConnected, lark.ErrNotConnected)
			}
			WithAssistant(a)(h.b)
			in := inbound("讨论动画方案")
			handled, err := h.b.assistantMessage(context.Background(), in)
			if !handled || len(a.outcomes) != 1 || (err == nil) != (mode == "complete") {
				t.Fatalf("delivery route: handled=%v error=%v outcomes=%+v", handled, err, a.outcomes)
			}
			outcome := a.outcomes[0]
			if outcome.Complete != (mode == "complete") || outcome.Retryable != (mode == "not-connected") {
				t.Fatalf("wrong certainty: %+v", outcome)
			}
			if mode == "complete" && len(outcome.MessageIDs) < 2 || mode == "partial" && len(outcome.MessageIDs) != 1 || (mode == "unknown" || mode == "not-connected") && len(outcome.MessageIDs) != 0 {
				t.Fatalf("wrong acknowledged chunks: %+v", outcome)
			}
			if mode != "not-connected" {
				a.before = nil
				before := len(h.bot.sends())
				if _, err := h.b.assistantMessage(context.Background(), in); err != nil || len(h.bot.sends()) != before {
					t.Fatal("complete or uncertain reply was resent")
				}
			}
		})
	}
}

func TestAssistantDoesNotSendWithoutDurableReservationOrRepeatAfterAckWriteFailure(t *testing.T) {
	for _, failBefore := range []bool{false, true} {
		t.Run(fmt.Sprint(failBefore), func(t *testing.T) {
			h := newHarness(t)
			a := &deliveryTrackingAssistant{answer: "建议使用蓝色背景。"}
			if failBefore {
				a.beginErr = errors.New("reservation write failed")
			} else {
				a.recordErr = errors.New("acknowledgement write failed")
			}
			WithAssistant(a)(h.b)
			in := inbound("先讨论方案")
			if handled, err := h.b.assistantMessage(context.Background(), in); !handled || err == nil {
				t.Fatal("delivery persistence failure was hidden")
			}
			want := 1
			if failBefore {
				want = 0
			}
			if len(h.bot.sends()) != want {
				t.Fatal("send crossed a failed durable reservation")
			}
			if !failBefore {
				if _, err := h.b.assistantMessage(context.Background(), in); err != nil || len(h.bot.sends()) != 1 {
					t.Fatal("lost outcome acknowledgement caused duplicate network send")
				}
			}
		})
	}
}
