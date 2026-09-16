package lark

import (
	"context"
	"testing"
)

func TestDeleteTaskChatTreatsAlreadyDissolvedAsSuccess(t *testing.T) {
	h := &taskHTTP{responses: map[string]string{"DELETE /open-apis/im/v1/chats/oc_task": `{"code":232009,"msg":"already dissolved"}`}}
	b, _ := newTestBot(t, WithHTTPClient(h))
	if err := b.DeleteTaskChat(context.Background(), "oc_task"); err != nil {
		t.Fatal(err)
	}
}
