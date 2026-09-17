package lark

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/tasks"
	larkim "github.com/larksuite/oapi-sdk-go/v3/service/im/v1"
	larktask "github.com/larksuite/oapi-sdk-go/v3/service/task/v2"
)

var _ tasks.Platform = (*bot)(nil)
var _ tasks.EventSource = (*bot)(nil)

// CreateTask assigns both the human and this application. OR completion lets
// the human complete it in their task panel, while the application assignment
// places it in the application identity's task-event subscription.
func (b *bot) CreateTask(ctx context.Context, spec tasks.TaskSpec) (tasks.RemoteTask, error) {
	if strings.TrimSpace(spec.Title) == "" || spec.OwnerID == "" || spec.Key == "" {
		return tasks.RemoteTask{}, errors.New("lark: task title, owner and idempotency key are required")
	}
	input := larktask.NewInputTaskBuilder().Summary(spec.Title).Description(spec.Description).
		ClientToken(spec.Key).Mode(2).
		Members([]*larktask.Member{
			larktask.NewMemberBuilder().Id(spec.OwnerID).Type("user").Role("assignee").Build(),
			larktask.NewMemberBuilder().Id(b.appID).Type("app").Role("assignee").Build(),
		}).Origin(larktask.NewOriginBuilder().PlatformI18nName(
		larktask.NewI18nTextBuilder().ZhCn("herdr").EnUs("herdr").Build(),
	).Build()).Build()
	resp, err := b.api.Task.V2.Task.Create(ctx, larktask.NewCreateTaskReqBuilder().
		UserIdType("open_id").InputTask(input).Build())
	if err != nil {
		return tasks.RemoteTask{}, newFailure("create task", b.appID, err)
	}
	if !resp.Success() {
		return tasks.RemoteTask{}, newFailure("create task", b.appID, &resp.CodeError)
	}
	if resp.Data == nil {
		return tasks.RemoteTask{}, errors.New("lark: create task returned no data")
	}
	return remoteTask(resp.Data.Task)
}

func (b *bot) GetTask(ctx context.Context, guid string) (tasks.RemoteTask, error) {
	if guid == "" {
		return tasks.RemoteTask{}, errors.New("lark: task guid is required")
	}
	resp, err := b.api.Task.V2.Task.Get(ctx, larktask.NewGetTaskReqBuilder().
		UserIdType("open_id").TaskGuid(guid).Build())
	if err != nil {
		return tasks.RemoteTask{}, newFailure("get task", b.appID, err)
	}
	if !resp.Success() {
		return tasks.RemoteTask{}, newFailure("get task", b.appID, &resp.CodeError)
	}
	if resp.Data == nil {
		return tasks.RemoteTask{}, errors.New("lark: get task returned no data")
	}
	return remoteTask(resp.Data.Task)
}

// UpdateTask changes only the bridge's description and, when requested, the
// completion state. Feishu rejects duplicate completion operations, so read
// the current state first and omit completed_at when it already matches.
func (b *bot) UpdateTask(ctx context.Context, guid, description string, completedAt *string) error {
	if guid == "" {
		return errors.New("lark: task guid is required")
	}
	input := larktask.NewInputTaskBuilder().Description(description)
	fields := []string{"description"}
	if completedAt != nil {
		current, err := b.GetTask(ctx, guid)
		if err != nil {
			return err
		}
		if taskCompleted(current.CompletedAt) != taskCompleted(*completedAt) {
			input.CompletedAt(*completedAt)
			fields = append(fields, "completed_at")
		}
	}
	resp, err := b.api.Task.V2.Task.Patch(ctx, larktask.NewPatchTaskReqBuilder().
		UserIdType("open_id").TaskGuid(guid).
		Body(larktask.NewPatchTaskReqBodyBuilder().Task(input.Build()).UpdateFields(fields).Build()).Build())
	if err != nil {
		return newFailure("update task", b.appID, err)
	}
	if !resp.Success() {
		return newFailure("update task", b.appID, &resp.CodeError)
	}
	return nil
}

func taskCompleted(at string) bool { return at != "" && at != "0" }

func remoteTask(t *larktask.Task) (tasks.RemoteTask, error) {
	if t == nil || t.Guid == nil || *t.Guid == "" {
		return tasks.RemoteTask{}, errors.New("lark: task response has no guid")
	}
	var result tasks.RemoteTask
	result.GUID = *t.Guid
	if t.Url != nil {
		result.URL = *t.Url
	}
	if t.Description != nil {
		result.Description = *t.Description
	}
	if t.CompletedAt != nil {
		result.CompletedAt = *t.CompletedAt
	}
	return result, nil
}

// CreateTaskChat leaves owner_id absent: the creating bot owns the private
// group, which is necessary for DeleteTaskChat to dissolve it later.
func (b *bot) CreateTaskChat(ctx context.Context, spec tasks.ChatSpec) (string, error) {
	if strings.TrimSpace(spec.Name) == "" || spec.OwnerID == "" || spec.Key == "" {
		return "", errors.New("lark: task chat name, owner and idempotency key are required")
	}
	body := larkim.NewCreateChatReqBodyBuilder().Name(spec.Name).
		UserIdList([]string{spec.OwnerID}).ChatMode("group").ChatType("private").
		GroupMessageType("chat").Build()
	external := false
	body.External = &external
	resp, err := b.api.Im.V1.Chat.Create(ctx, larkim.NewCreateChatReqBuilder().
		UserIdType("open_id").Uuid(spec.Key).Body(body).Build())
	if err != nil {
		return "", newFailure("create task chat", b.appID, err)
	}
	if !resp.Success() {
		return "", newFailure("create task chat", b.appID, &resp.CodeError)
	}
	if resp.Data == nil || resp.Data.ChatId == nil || *resp.Data.ChatId == "" {
		return "", errors.New("lark: create task chat returned no chat id")
	}
	return *resp.Data.ChatId, nil
}

func (b *bot) DeleteTaskChat(ctx context.Context, chatID string) error {
	if chatID == "" {
		return errors.New("lark: task chat id is required")
	}
	resp, err := b.api.Im.V1.Chat.Delete(ctx, larkim.NewDeleteChatReqBuilder().ChatId(chatID).Build())
	if err != nil {
		return newFailure("delete task chat", b.appID, err)
	}
	if !resp.Success() && resp.Code != 232009 {
		return newFailure("delete task chat", b.appID, &resp.CodeError)
	}
	return nil
}

func (b *bot) SubscribeTasks(ctx context.Context) error {
	resp, err := b.api.Task.V2.TaskV2.TaskSubscription(ctx,
		larktask.NewTaskSubscriptionTaskV2ReqBuilder().UserIdType("open_id").Build())
	if err != nil {
		return newFailure("subscribe to tasks", b.appID, err)
	}
	if !resp.Success() {
		return newFailure("subscribe to tasks", b.appID, &resp.CodeError)
	}
	return nil
}

func (b *bot) OnTaskEvent(h func(context.Context, tasks.TaskEvent) error) {
	b.mu.Lock()
	b.onTask = h
	b.mu.Unlock()
}

func (b *bot) handleTaskEvent(ctx context.Context, event *larktask.P2TaskUpdateUserAccessV2) error {
	if event == nil || event.Event == nil || event.Event.TaskGuid == nil || *event.Event.TaskGuid == "" {
		return nil
	}
	b.mu.RLock()
	h := b.onTask
	b.mu.RUnlock()
	if h == nil {
		return nil
	}
	if err := h(ctx, tasks.TaskEvent{GUID: *event.Event.TaskGuid}); err != nil {
		return fmt.Errorf("lark: task event handler: %w", err)
	}
	return nil
}
