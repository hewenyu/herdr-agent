package mirror

import (
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// codexParser reads ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl (G8).
//
// Nothing about it resembles the Claude format: records are wrapped in an
// envelope with an `ordinal`, the conversation lives under `response_item`, and
// every message is also re-emitted as an `event_msg` item_completed — which is
// exactly why event_msg must be skipped rather than parsed, or every turn would
// reach the phone twice.
type codexParser struct {
	log *slog.Logger
	// n counts records, and is used only as a fallback ordering for a record
	// that arrives without an ordinal.
	n uint64
}

func newCodexParser(log *slog.Logger) *codexParser {
	return &codexParser{log: logger(log)}
}

func (p *codexParser) Name() string { return "codex" }

// Parse never returns an error; see claudeParser.Parse.
func (p *codexParser) Parse(data []byte) ([]Turn, []byte, error) {
	lines, rest := splitLines(data)
	var turns []Turn
	for _, line := range lines {
		n := p.n
		p.n++
		if t, ok := p.record(line, n); ok {
			turns = append(turns, t)
		}
	}
	return turns, rest, nil
}

type codexRecord struct {
	// Timestamp and Ordinal stay raw so a change in their JSON type costs one
	// record's clock or ordering rather than the record itself.
	Timestamp json.RawMessage `json:"timestamp"`
	Ordinal   json.RawMessage `json:"ordinal"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexPayload struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   []codexBlock    `json:"content"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	Arguments json.RawMessage `json:"arguments"`
}

type codexBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func (p *codexParser) record(line []byte, n uint64) (Turn, bool) {
	var rec codexRecord
	if err, fatal := decodeRecord(line, &rec); err != nil {
		if fatal {
			p.log.Debug("mirror: skipping unreadable codex record", "n", n, "err", err)
			return Turn{}, false
		}
		p.log.Debug("mirror: codex record has an unexpected field type, using the rest", "n", n, "err", err)
	}
	seq := p.seqOf(rec.Ordinal, n)

	switch rec.Type {
	case "response_item":
		return p.responseItem(rec, seq)
	case "event_msg", "session_meta", "turn_context", "world_state", "compacted":
		// Lifecycle and environment. event_msg in particular duplicates the
		// response_item payloads it announces.
		return Turn{}, false
	default:
		p.log.Debug("mirror: skipping unknown codex record type", "type", rec.Type, "seq", seq)
		return Turn{}, false
	}
}

// seqOf reads the envelope ordinal, which is the file's own ordering and
// therefore what Turn.Seq must carry. Record position is only a fallback.
func (p *codexParser) seqOf(raw json.RawMessage, n uint64) uint64 {
	if len(raw) == 0 {
		return n
	}
	v, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		p.log.Debug("mirror: unreadable codex ordinal", "value", string(raw), "n", n, "err", err)
		return n
	}
	return v
}

func (p *codexParser) responseItem(rec codexRecord, seq uint64) (Turn, bool) {
	var pl codexPayload
	if err, fatal := decodeRecord(rec.Payload, &pl); err != nil {
		if fatal {
			p.log.Debug("mirror: skipping unreadable codex payload", "seq", seq, "err", err)
			return Turn{}, false
		}
		// One content block with a wrongly-typed field must not drop the message.
		p.log.Debug("mirror: codex payload has an unexpected field type, using the rest", "seq", seq, "err", err)
	}
	at := parseTime(rec.Timestamp, p.log, seq)

	switch pl.Type {
	case "message":
		return p.message(pl, at, seq)
	case "custom_tool_call", "function_call":
		// Codex logs the call as its own record, after the assistant message
		// that introduced it. A tailer cannot amend a turn it has already
		// published, so the call becomes an assistant turn carrying only the
		// summary.
		input := pl.Input
		if pl.Type == "function_call" {
			input = pl.Arguments
		}
		return Turn{
			Role:      roleAssistant,
			ToolCalls: p.toolCalls(pl.Name, input, seq),
			At:        at,
			Seq:       seq,
		}, true
	case "custom_tool_call_output", "function_call_output", "reasoning":
		// Output is the payload the phone is being spared; reasoning was never
		// shown to the user.
		return Turn{}, false
	default:
		p.log.Debug("mirror: skipping unknown codex payload type", "payload", pl.Type, "seq", seq)
		return Turn{}, false
	}
}

func (p *codexParser) message(pl codexPayload, at time.Time, seq uint64) (Turn, bool) {
	var role string
	switch pl.Role {
	case roleUser:
		role = roleUser
	case roleAssistant:
		role = roleAssistant
	default:
		// "developer" and friends: the system prompt, the skills catalogue, the
		// sandbox policy. Injected, not said.
		return Turn{}, false
	}

	var texts []string
	for _, b := range pl.Content {
		switch b.Type {
		case "input_text", "output_text", "text":
			t := sanitizeText(b.Text)
			// The first user message of a session is Codex's own context
			// injection — AGENTS.md and <environment_context> — filed under
			// role "user". The human did not type it. The rule is in inject.go,
			// because the claude parser needs the same one for slash commands.
			if t == "" || (role == roleUser && isInjectedContext(t)) {
				continue
			}
			texts = append(texts, t)
		default:
			p.log.Debug("mirror: skipping unknown codex content block", "block", b.Type, "seq", seq)
		}
	}
	if len(texts) == 0 {
		return Turn{}, false
	}
	return Turn{
		Role: role,
		Text: strings.Join(texts, "\n\n"),
		At:   at,
		Seq:  seq,
	}, true
}

// toolCalls shows identifying arguments, never the orchestration script or
// arbitrary freeform payload. Unsupported input still has a useful tool name.
func (p *codexParser) toolCalls(name string, raw json.RawMessage, seq uint64) []string {
	bare := []string{toolSummary(name, "")}
	if len(raw) == 0 {
		return bare
	}
	var script string
	if err := json.Unmarshal(raw, &script); err != nil {
		// Not a string: try it as the tool object itself.
		var obj map[string]any
		if err := json.Unmarshal(raw, &obj); err != nil {
			p.log.Debug("mirror: unreadable codex tool input", "seq", seq, "err", err)
			return bare
		}
		return []string{toolSummary(name, codexObjectArg(name, obj))}
	}
	if obj := decodeObject(script); obj != nil {
		return []string{toolSummary(name, codexObjectArg(name, obj))}
	}
	switch name {
	case "exec", "functions.exec":
		if calls := codexScriptCalls(script); len(calls) > 0 {
			return calls
		}
	case "apply_patch", "functions.apply_patch":
		return []string{toolSummary(name, patchFiles(script))}
	}
	return bare
}

func decodeObject(s string) map[string]any {
	var obj map[string]any
	if err := json.Unmarshal([]byte(s), &obj); err != nil {
		return nil
	}
	return obj
}

func skipSpace(s string, i int) int {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	return i
}
