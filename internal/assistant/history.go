package assistant

// This marker records a failed turn for the next model call; it is never sent
// as a substitute reply. An unseen partial answer cannot become a proposal.
const failedDialogueContext = "（本轮助手回复失败，没有给出可供确认的新项目名或方案，也未调用任务工具。不能将这一轮当作已经提出建议；若后续短答没有明确指代，请先澄清。）"

func modelHistory(messages []Message) []Message {
	out := append([]Message(nil), messages...)
	for i := range out {
		if out[i].Role == "assistant" && out[i].Kind == "failure" {
			out[i].Content = failedDialogueContext
		}
	}
	return out
}
