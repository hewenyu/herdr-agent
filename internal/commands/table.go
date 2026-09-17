package commands

// spec is one row of the command table.
//
// The table is the SINGLE source of truth for the command surface: Parse
// dispatches through it and Help renders it. A command therefore cannot exist
// in one and be missing from the other, which matters more than it looks —
// a user who cannot find the name of a command in /help types the text they
// meant instead, and free text aimed at a blocked agent is an approval (G1).
type spec struct {
	name    string // without the leading slash, lowercase
	kind    Kind
	args    string // argument syntax as rendered in help; "" when there are none
	summary string
	parse   func(sp spec, rest, raw string) Command
}

// usage is the line shown in /help and quoted back in every error.
func (sp spec) usage() string {
	if sp.args == "" {
		return "/" + sp.name
	}
	return "/" + sp.name + " " + sp.args
}

// table is the command surface of S2 §3.5. Order is display order; it also
// breaks ties between equally-close spelling suggestions, so it must stay
// deterministic.
var table = []spec{
	{
		name:    "ls",
		kind:    KindLs,
		summary: "list every agent: status, pane, kind, cwd, title",
		parse:   parseNoArgs,
	},
	{
		name:    "card",
		kind:    KindCard,
		args:    "<pane>",
		summary: "push that pane's screen as an actionable card",
		parse:   parsePane,
	},
	{
		name:    "say",
		kind:    KindSay,
		args:    "<pane> <text>",
		summary: "send text to the agent through the safe path",
		parse:   parseSay,
	},
	{
		name:    "stop",
		kind:    KindStop,
		args:    "<pane>",
		summary: "send esc, the safe way out of a prompt",
		parse:   parsePane,
	},
	{
		name:    "mirror",
		kind:    KindMirror,
		args:    "<pane> on|off",
		summary: "turn transcript mirroring for that agent on or off",
		parse:   parseMirror,
	},
	{
		name: "close",
		kind: KindClose,
		// Phrased as what it costs, not as what it does. A user reading the
		// table has to be able to tell that this is the ONLY command that
		// un-aims a chat — everything else leaves the conversation where it is,
		// which is the property the picker now guarantees.
		summary: "stop talking to the selected agent; nothing is aimed until you pick one again",
		parse:   parseNoArgs,
	},
	{
		name:    "clear",
		kind:    KindClear,
		summary: "start a fresh AI assistant session in the main app's private chat only; keep task sessions",
		parse:   parseClear,
	},
	{
		name:    "doctor",
		kind:    KindDoctor,
		summary: "check the herdr environment and report what is wrong",
		parse:   parseNoArgs,
	},
	{
		name:    "help",
		kind:    KindHelp,
		summary: "this list",
		parse:   parseNoArgs,
	},
}

// lookup finds a command by its already-lowercased name.
func lookup(name string) (spec, bool) {
	for _, sp := range table {
		if sp.name == name {
			return sp, true
		}
	}
	return spec{}, false
}
