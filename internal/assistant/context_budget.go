package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"math"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
	"github.com/eino-contrib/jsonschema"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

const contextOutputReserve = 4096

// ErrContextBudget stops a turn before sending an oversized model request.
// Earlier tool operations may already have succeeded; callers must preserve
// their receipts and must not replay the turn to try to recover the answer.
var ErrContextBudget = errors.New("本轮对话或工具结果超过上下文预算，已停止继续调用模型；请缩短消息后继续，已执行的操作不会重放")

// ContextInputBudget returns the configured input compaction threshold. Output
// has a separate fixed 4096-token limit, so the selected model's window must
// accommodate both. Zero supports callers constructing AI config directly.
func ContextInputBudget(contextTokens int) int {
	if contextTokens == 0 {
		contextTokens = config.DefaultAIContextTokens
	}
	if contextTokens <= 0 {
		return 0
	}
	return contextTokens
}

// EstimateContextTokens returns a conservative input estimate, excluding output.
// Counting each UTF-8/JSON byte as a token deliberately overestimates ordinary
// text, including Chinese, instead of depending on a provider-specific tokenizer.
// It also includes message and tool envelopes. Invalid input exceeds any budget.
func EstimateContextTokens(history []Message, definitions []tasktools.Tool) int {
	messages, err := agenticHistory(history)
	if err != nil {
		return math.MaxInt
	}
	infos := make([]*schema.ToolInfo, 0, len(definitions))
	for _, definition := range definitions {
		info, err := toolInfo(definition)
		if err != nil {
			return math.MaxInt
		}
		infos = append(infos, info)
	}
	return estimateAgenticContext(messages, infos)
}

func estimateAgenticContext(messages []*schema.AgenticMessage, infos []*schema.ToolInfo) int {
	encoded, err := json.Marshal(struct {
		Messages []*schema.AgenticMessage `json:"messages"`
		Tools    []*schema.ToolInfo       `json:"tools"`
	}{messages, infos})
	if err != nil {
		return math.MaxInt
	}
	// Include provider framing, per-message role delimiters, and tool wrappers
	// beyond the serialized Eino representation. Tool results, reasoning blocks,
	// call arguments, and response extensions are already in the representation.
	return len(encoded) + 512 + 64*len(messages) + 128*len(infos)
}

type contextBudgetModel struct {
	base        model.BaseModel[*schema.AgenticMessage]
	inputBudget int
}

func (m *contextBudgetModel) check(input []*schema.AgenticMessage, opts []model.Option) error {
	options := model.GetCommonOptions(nil, opts...)
	infos := append(append([]*schema.ToolInfo{}, options.Tools...), options.DeferredTools...)
	if options.ToolSearchTool != nil {
		infos = append(infos, options.ToolSearchTool)
	}
	if estimateAgenticContext(input, infos) > m.inputBudget {
		return ErrContextBudget
	}
	return nil
}

func (m *contextBudgetModel) Generate(ctx context.Context, input []*schema.AgenticMessage, opts ...model.Option) (*schema.AgenticMessage, error) {
	if err := m.check(input, opts); err != nil {
		return nil, err
	}
	return m.base.Generate(ctx, input, opts...)
}

func (m *contextBudgetModel) Stream(ctx context.Context, input []*schema.AgenticMessage, opts ...model.Option) (*schema.StreamReader[*schema.AgenticMessage], error) {
	if err := m.check(input, opts); err != nil {
		return nil, err
	}
	return m.base.Stream(ctx, input, opts...)
}

func agenticHistory(history []Message) ([]*schema.AgenticMessage, error) {
	messages := make([]*schema.AgenticMessage, 0, len(history))
	for _, message := range history {
		switch message.Role {
		case "system":
			messages = append(messages, schema.SystemAgenticMessage(message.Content))
		case "user":
			messages = append(messages, schema.UserAgenticMessage(message.Content))
		case "assistant":
			messages = append(messages, &schema.AgenticMessage{Role: schema.AgenticRoleTypeAssistant, ContentBlocks: []*schema.ContentBlock{
				schema.NewContentBlock(&schema.AssistantGenText{Text: message.Content}),
			}})
		default:
			return nil, errModelConfig
		}
	}
	return messages, nil
}

func toolInfo(definition tasktools.Tool) (*schema.ToolInfo, error) {
	encoded, err := json.Marshal(definition.InputSchema)
	if err != nil {
		return nil, err
	}
	var params jsonschema.Schema
	if err := json.Unmarshal(encoded, &params); err != nil {
		return nil, err
	}
	return &schema.ToolInfo{Name: definition.Name, Desc: definition.Description, ParamsOneOf: schema.NewParamsOneOfByJSONSchema(&params)}, nil
}
