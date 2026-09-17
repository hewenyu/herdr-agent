package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	anthropicapi "github.com/anthropics/anthropic-sdk-go"
	"github.com/cloudwego/eino-ext/components/model/agenticclaude"
	"github.com/cloudwego/eino-ext/components/model/agenticopenai"
	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
	"github.com/eino-contrib/jsonschema"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
	openaiapi "github.com/openai/openai-go/v3"
)

const maxToolCalls = 12

var (
	errModelConfig = errors.New("AI 配置无效，请检查协议、模型、API 地址和密钥")
	errModelAuth   = errors.New("AI 服务鉴权失败，请检查 API 密钥和模型访问权限")
	errModelLimit  = errors.New("AI 服务请求受限，请稍后重试或检查额度")
	errModelCall   = errors.New("AI 服务请求失败，请检查协议、模型和 API 地址")
	errToolLimit   = errors.New("本轮已达到 12 次工具调用上限，请发送新消息继续")
)

// Message is the persistent conversation format. Tool calls and results remain
// in Eino's per-turn context; credentials are never part of conversation state.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ToolCall func(context.Context, string, json.RawMessage) (any, error)

type Engine interface {
	Reply(context.Context, []Message, []tasktools.Tool, ToolCall) (string, error)
}

type einoEngine struct {
	model   model.BaseModel[*schema.AgenticMessage]
	apiKey  string
	timeout time.Duration
}

// NewEngine uses Eino's native tool loop and official Responses/Anthropic
// components. The configured base URL is the provider's /v1 API root. The
// client never follows redirects, preventing credentials from reaching a
// different endpoint even when the configured server returns a redirect.
func NewEngine(cfg config.AI) (Engine, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Scheme != "https" && u.Scheme != "http") || strings.TrimSpace(cfg.APIKey) == "" || strings.TrimSpace(cfg.Model) == "" || cfg.Timeout <= 0 {
		return nil, errModelConfig
	}
	if u.Scheme == "http" {
		ip := net.ParseIP(u.Hostname())
		if !strings.EqualFold(u.Hostname(), "localhost") && (ip == nil || !ip.IsLoopback()) {
			return nil, errModelConfig
		}
	}
	client := &http.Client{
		Timeout: cfg.Timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	var m model.BaseModel[*schema.AgenticMessage]
	switch cfg.Provider {
	case "openai-responses":
		zero, tokens, disabled := 0, 4096, false
		m, err = agenticopenai.NewResponsesModel(context.Background(), &agenticopenai.ResponsesConfig{
			APIKey: cfg.APIKey, Model: cfg.Model, BaseURL: strings.TrimRight(cfg.BaseURL, "/"),
			HTTPClient: client, Timeout: &cfg.Timeout, MaxRetries: &zero, MaxTokens: &tokens,
			Store: &disabled, ParallelToolCalls: &disabled,
		})
	case "anthropic-messages":
		// Anthropic's SDK appends v1/messages. Trim only the trailing version
		// segment, retaining any reverse-proxy path prefix in the API root.
		u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/v1")
		u.RawPath = ""
		m, err = agenticclaude.New(context.Background(), &agenticclaude.Config{
			APIKey: cfg.APIKey, Model: cfg.Model, BaseURL: u.String(), MaxTokens: 4096,
			HTTPClient: client, RequestTimeout: cfg.Timeout,
		})
	default:
		return nil, errModelConfig
	}
	if err != nil {
		return nil, errModelConfig
	}
	return &einoEngine{model: m, apiKey: cfg.APIKey, timeout: cfg.Timeout}, nil
}

func (e *einoEngine) Reply(ctx context.Context, history []Message, definitions []tasktools.Tool, call ToolCall) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()
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
			return "", errModelConfig
		}
	}
	if len(messages) == 0 || (len(definitions) > 0 && call == nil) {
		return "", errModelConfig
	}
	var calls atomic.Int32
	var limited atomic.Bool
	boundTools := make([]tool.BaseTool, 0, len(definitions))
	names := make(map[string]bool)
	for _, definition := range definitions {
		if definition.Name == "" || names[definition.Name] || definition.InputSchema["type"] != "object" {
			return "", errModelConfig
		}
		names[definition.Name] = true
		encoded, err := json.Marshal(definition.InputSchema)
		if err != nil {
			return "", errModelConfig
		}
		var params jsonschema.Schema
		if err := json.Unmarshal(encoded, &params); err != nil {
			return "", errModelConfig
		}
		boundTools = append(boundTools, &taskTool{
			info: &schema.ToolInfo{Name: definition.Name, Desc: definition.Description, ParamsOneOf: schema.NewParamsOneOfByJSONSchema(&params)},
			call: call, calls: &calls, limited: &limited, apiKey: e.apiKey,
		})
	}
	agent, err := adk.NewTypedChatModelAgent(ctx, &adk.TypedChatModelAgentConfig[*schema.AgenticMessage]{
		Name: "herdr_assistant", Description: "Manage the current user's herdr tasks", Model: e.model,
		ToolsConfig: adk.ToolsConfig{ToolsNodeConfig: compose.ToolsNodeConfig{
			Tools: boundTools, ExecuteSequentially: true,
		}},
		MaxIterations: 24,
	})
	if err != nil {
		return "", safeModelError(ctx, err)
	}
	runner := adk.NewTypedRunner(adk.TypedRunnerConfig[*schema.AgenticMessage]{Agent: agent})
	iter := runner.Run(ctx, messages)
	var answer string
	for {
		event, ok := iter.Next()
		if !ok {
			break
		}
		if event.Err != nil {
			if limited.Load() {
				return "", errToolLimit
			}
			return "", safeModelError(ctx, event.Err)
		}
		if event.Output == nil || event.Output.MessageOutput == nil {
			continue
		}
		message := event.Output.MessageOutput.Message
		if message == nil || message.Role != schema.AgenticRoleTypeAssistant {
			continue
		}
		var text []string
		for _, block := range message.ContentBlocks {
			if block.AssistantGenText != nil {
				text = append(text, block.AssistantGenText.Text)
			}
		}
		answer = strings.Join(text, "\n")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if strings.TrimSpace(answer) == "" {
		return "", errModelCall
	}
	return strings.ReplaceAll(answer, e.apiKey, "[redacted]"), nil
}

type taskTool struct {
	info    *schema.ToolInfo
	call    ToolCall
	calls   *atomic.Int32
	limited *atomic.Bool
	apiKey  string
}

func (t *taskTool) Info(context.Context) (*schema.ToolInfo, error) { return t.info, nil }

func (t *taskTool) InvokableRun(ctx context.Context, arguments string, _ ...tool.Option) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if t.calls.Add(1) > maxToolCalls {
		t.limited.Store(true)
		return "", errToolLimit
	}
	result, err := t.call(ctx, t.info.Name, json.RawMessage(arguments))
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil {
		// Business failures are useful model context (e.g. unknown project),
		// so the framework can explain them or correct the next tool call.
		result = map[string]any{"ok": false, "error": strings.ReplaceAll(err.Error(), t.apiKey, "[redacted]")}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return `{"ok":false,"error":"无法编码工具返回结果"}`, nil
	}
	return strings.ReplaceAll(string(encoded), t.apiKey, "[redacted]"), nil
}

// Discard SDK error bodies: compatible endpoints may echo request headers or
// other secrets in them. Only status categories and context errors escape.
func safeModelError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	status := 0
	var openaiError *openaiapi.Error
	var anthropicError *anthropicapi.Error
	if errors.As(err, &openaiError) {
		status = openaiError.StatusCode
	} else if errors.As(err, &anthropicError) {
		status = anthropicError.StatusCode
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return errModelAuth
	case http.StatusTooManyRequests:
		return errModelLimit
	default:
		return errModelCall
	}
}
