package agents

import "github.com/hewenyu/herdr-agent/internal/herdrapi"

// fromWire converts herdr's AgentInfo into the bridge's Agent.
//
// SeenAt is deliberately left zero: this function has no clock. The registry
// stamps it from its own time source when it stores the agent.
//
// AgentInfo.TerminalID is dropped on the floor here, and Agent has no field to
// put it in. It is not stable across a herdr restart, so anything keyed on it
// would silently address the wrong terminal after the server comes back; only
// pane_id survives (G10).
func fromWire(in herdrapi.AgentInfo) Agent {
	a := Agent{
		PaneID:      in.PaneID,
		WorkspaceID: in.WorkspaceID,
		TabID:       in.TabID,
		Kind:        deref(in.Agent),
		Status:      statusFromWire(in.AgentStatus),
		// cwd is the pane's tracked directory; foreground_cwd is where the
		// running process actually sits. Either one identifies the project for
		// a card, so take whichever herdr managed to resolve.
		Cwd: firstNonEmpty(deref(in.Cwd), deref(in.ForegroundCwd)),
		// terminal_title_stripped is the agent's own task summary and reads
		// well as a card title; the others are progressively less informative
		// fallbacks (G8). Raw terminal_title is not used: it still carries the
		// TUI's activity markers, which are noise on a phone.
		Title:       firstNonEmpty(deref(in.TerminalTitleStripped), deref(in.Title), deref(in.Name)),
		StateSeq:    in.StateChangeSeq,
		Interactive: in.InteractiveReady,
		LaunchPend:  in.LaunchPending,
	}
	if in.AgentSession != nil {
		// Copy rather than alias: the Agent outlives this AgentInfo and is
		// handed to subscribers on other goroutines.
		ref := *in.AgentSession
		a.SessionRef = &ref
	}
	return a
}

// statusFromWire maps herdr's agent_status onto Status.
//
// An unrecognised value becomes StatusUnknown, never StatusIdle. herdr already
// reports `idle` when its blocked-detection regexes fail to match, which is a
// silent false negative (G11); a bridge that also guessed `idle` for a status
// string it did not understand would compound that into "the agent is waiting
// for you and nobody will ever say so".
//
// StatusGone is absent on purpose: it is synthesised by the registry when an
// agent stops appearing in agent.list, and herdr has no such status.
func statusFromWire(s string) Status {
	switch Status(s) {
	case StatusIdle:
		return StatusIdle
	case StatusWorking:
		return StatusWorking
	case StatusBlocked:
		return StatusBlocked
	case StatusDone:
		return StatusDone
	default:
		return StatusUnknown
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// clone returns a copy that shares no mutable state with a, so a consumer
// holding a Transition cannot reach into the registry's stored agent.
func (a Agent) clone() Agent {
	if a.SessionRef != nil {
		ref := *a.SessionRef
		a.SessionRef = &ref
	}
	return a
}
