package assistant

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/hewenyu/herdr-agent/internal/bridge"
	localmemory "github.com/hewenyu/herdr-agent/internal/memory"
)

const clearedReply = "已开启新的主应用会话，请直接发送新需求。旧会话已归档；已创建的任务、各任务群的独立会话及 Codex/Claude 执行会话不受影响。"

// Called under the conversation lock, after authorization and receipt lookup.
// Keep old operation/delivery identities so a replay cannot repeat a task or
// reset a later conversation. Only the active model context starts over.
func (s *Service) clearConversation(path string, in bridge.AssistantMessage, state session) (string, error) {
	archive := filepath.Join(s.dir, "archive", digest(in.OwnerID+"\x00"+in.ChatID+"\x00"+in.TaskID))
	if err := os.MkdirAll(archive, 0700); err != nil {
		return "", err
	}
	if err := writeSession(filepath.Join(archive, "clear-"+digest(in.MessageID)+".json"), state); err != nil {
		return "", fmt.Errorf("assistant: archive conversation: %w", err)
	}
	state.Generation++
	state.ClearedAt = time.Now()
	state.Messages = []Message{}
	state.Memory = localmemory.Entry{}
	state.Pending = ""
	state.Receipts[in.MessageID] = turnReceipt{
		Generation: state.Generation, ContextReset: true,
		Reply: clearedReply, Finished: true, Delivery: deliveryPrepared,
	}
	// The checkpoint is authoritative. prepareMemory synchronizes its empty
	// summary to the provider on the next turn, never recalling the old one
	// into this generation. Reset itself needs neither a model nor a provider.
	if err := writeSession(path, state); err != nil {
		return "", err
	}
	return clearedReply, nil
}
