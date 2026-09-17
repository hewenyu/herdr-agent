package assistant

// This marker records a failed turn for the next model call; it is never sent
// as a substitute reply. An unseen partial answer cannot become a proposal.
const failedDialogueContext = "（本轮助手回复失败，没有给出可供确认的新项目名或方案，也未调用任务工具。不能将这一轮当作已经提出建议；若后续短答没有明确指代，请先澄清。）"

// The raw generated reply stays in the local checkpoint and receipt. Until
// every chunk is acknowledged, neither history nor summarization can present
// that text as a proposal the user has actually seen.
const pendingDeliveryContext = "（本轮助手答复尚未确认完整送达，可能未发送、只收到部分内容或发送确认丢失。不能将未确认的答复当作用户已看到的名称或方案；需要结合用户当前明确说明判断。已经执行的工具操作仍可能存在，必要时查询工具核对。）"

func modelHistory(messages []Message) []Message {
	out := append([]Message(nil), messages...)
	for i := range out {
		if out[i].Role != "assistant" {
			continue
		}
		switch out[i].Kind {
		case "failure":
			out[i].Content = failedDialogueContext
		case "delivery_pending":
			out[i].Content = pendingDeliveryContext
		}
	}
	return out
}
