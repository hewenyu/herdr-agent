package mirror

import (
	"encoding/json"
	"log/slog"
	"strings"
)

// claudeParser reads ~/.claude/projects/<cwd>/<session-id>.jsonl (G8).
//
// The file is a flat log of heterogeneous records — the fixture alone holds
// user, assistant, ai-title, last-prompt, system, file-history-snapshot, mode,
// permission-mode and attachment — of which exactly two are conversation.
type claudeParser struct {
	log *slog.Logger
	// seq is the count of records consumed so far. Claude records carry no
	// ordinal, so "record order within the file" is the only ordering there is,
	// which makes the parser stateful and single-file by construction.
	seq uint64
}

func newClaudeParser(log *slog.Logger) *claudeParser {
	return &claudeParser{log: logger(log)}
}

func (p *claudeParser) Name() string { return "claude" }

// Parse never returns an error. A transcript is an append-only log written by
// somebody else's program: a record type we have never seen, or a line that is
// not JSON at all, means the vendor shipped a release, not that mirroring
// should stop (S2 §3.9, §8).
func (p *claudeParser) Parse(data []byte) ([]Turn, []byte, error) {
	lines, rest := splitLines(data)
	var turns []Turn
	for _, line := range lines {
		seq := p.seq
		p.seq++
		if t, ok := p.record(line, seq); ok {
			turns = append(turns, t)
		}
	}
	return turns, rest, nil
}

type claudeRecord struct {
	Type string `json:"type"`
	// Timestamp stays raw: see parseTime. A clock must never cost the text.
	Timestamp   json.RawMessage `json:"timestamp"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	Message     *claudeMessage  `json:"message"`
}

type claudeMessage struct {
	Role string `json:"role"`
	// Content is a bare string for a typed prompt and an array of blocks for
	// everything else.
	Content json.RawMessage `json:"content"`
}

type claudeBlock struct {
	Type  string         `json:"type"`
	Text  string         `json:"text"`
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`
}

func (p *claudeParser) record(line []byte, seq uint64) (Turn, bool) {
	var rec claudeRecord
	if err, fatal := decodeRecord(line, &rec); err != nil {
		if fatal {
			p.log.Debug("mirror: skipping unreadable claude record", "seq", seq, "err", err)
			return Turn{}, false
		}
		p.log.Debug("mirror: claude record has an unexpected field type, using the rest", "seq", seq, "err", err)
	}
	// A sidechain is a sub-agent's own conversation. It belongs to the Task
	// tool call the main thread already shows, and pushing it to a phone would
	// interleave two conversations into one chat.
	if rec.IsSidechain {
		return Turn{}, false
	}
	switch rec.Type {
	case roleUser:
		return p.userTurn(rec, seq)
	case roleAssistant:
		return p.assistantTurn(rec, seq)
	case "ai-title", "last-prompt", "system", "file-history-snapshot",
		"mode", "permission-mode", "attachment":
		// Known, and none of it is conversation: session metadata, editor
		// snapshots, injected listings. Silent so the debug log stays a signal
		// that the format moved.
		return Turn{}, false
	default:
		p.log.Debug("mirror: skipping unknown claude record type", "type", rec.Type, "seq", seq)
		return Turn{}, false
	}
}

func (p *claudeParser) userTurn(rec claudeRecord, seq uint64) (Turn, bool) {
	if rec.Message == nil || rec.IsMeta {
		return Turn{}, false
	}
	// dropInjected: a slash command and its output are filed under role "user"
	// exactly like typed prose (see testdata/claude-commands.jsonl). isMeta does
	// not mark them, so the wrappers are the only way to tell them apart.
	text, _ := p.content(rec.Message.Content, seq, true)
	// Empty means the record carried no human text — the overwhelmingly common
	// case being a tool_result, which content() drops. Claude files the result
	// of an assistant's own tool call under role "user"; mirroring that as a
	// user turn would show the human saying "(Bash completed with no output)".
	if text == "" {
		return Turn{}, false
	}
	// Deliberately no ToolCalls: tools are the assistant's, never the human's.
	return Turn{
		Role: roleUser,
		Text: text,
		At:   parseTime(rec.Timestamp, p.log, seq),
		Seq:  seq,
	}, true
}

func (p *claudeParser) assistantTurn(rec claudeRecord, seq uint64) (Turn, bool) {
	if rec.Message == nil {
		return Turn{}, false
	}
	text, tools := p.content(rec.Message.Content, seq, false)
	if text == "" && len(tools) == 0 {
		return Turn{}, false
	}
	return Turn{
		Role:      roleAssistant,
		Text:      text,
		ToolCalls: tools,
		At:        parseTime(rec.Timestamp, p.log, seq),
		Seq:       seq,
	}, true
}

// content flattens a message body into plain text plus tool summaries.
//
// dropInjected removes text that is entirely one of Claude's own wrappers; it
// is set for user records, where such a block is the client talking to the
// model rather than the human typing.
func (p *claudeParser) content(raw json.RawMessage, seq uint64, dropInjected bool) (string, []string) {
	if len(raw) == 0 {
		return "", nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		t := sanitizeText(s)
		if dropInjected && isInjectedClaudeText(t) {
			return "", nil
		}
		return t, nil
	}

	var blocks []claudeBlock
	if err, fatal := decodeRecord(raw, &blocks); err != nil {
		if fatal {
			p.log.Debug("mirror: skipping unreadable claude content", "seq", seq, "err", err)
			return "", nil
		}
		// One block with a field of the wrong type must not blank its siblings.
		p.log.Debug("mirror: claude content has an unexpected field type, using the rest", "seq", seq, "err", err)
	}

	var texts, tools []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			t := sanitizeText(b.Text)
			if t == "" || (dropInjected && isInjectedClaudeText(t)) {
				continue
			}
			texts = append(texts, t)
		case "tool_use":
			tools = append(tools, toolSummary(b.Name, pickToolArg(b.Input)))
		case "tool_result":
			// Never text: see userTurn. The payload is for the model.
		default:
			// Covers thinking/image blocks too — neither is something a phone
			// should be shown as if the agent had said it.
			p.log.Debug("mirror: skipping unknown claude content block", "block", b.Type, "seq", seq)
		}
	}
	// Separate blocks were separate chunks on screen; a blank line keeps them
	// from reading as one run-on paragraph.
	return strings.Join(texts, "\n\n"), tools
}
