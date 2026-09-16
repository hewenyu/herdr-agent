// Package tasks owns durable bindings between Feishu tasks and local agents.
package tasks

import "context"

// RemoteTask is the subset of the public Task v2 resource used by the bridge.
type RemoteTask struct {
	GUID        string
	URL         string
	Description string
	CompletedAt string
}

type TaskSpec struct {
	Title       string
	Description string
	OwnerID     string
	Key         string
}

type ChatSpec struct {
	Name    string
	OwnerID string // human to invite; the application remains the group owner
	Key     string
}

// Platform runs as the application. New tasks have the human and application
// as assignees, with OR completion, so both the task panel and task events work.
type Platform interface {
	CreateTask(context.Context, TaskSpec) (RemoteTask, error)
	GetTask(context.Context, string) (RemoteTask, error)
	UpdateTask(ctx context.Context, guid, description string, completedAt *string) error
	CreateTaskChat(context.Context, ChatSpec) (string, error)
	DeleteTaskChat(context.Context, string) error
	SubscribeTasks(context.Context) error
}

type TaskEvent struct {
	GUID string
}

// EventSource is optional; polling reconciles state after reconnects and when
// the tenant does not enable task event delivery.
type EventSource interface {
	OnTaskEvent(func(context.Context, TaskEvent) error)
}
