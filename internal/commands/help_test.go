package commands

import (
	"strings"
	"testing"
)

// sampleInvocations is one working invocation per command. The test below
// asserts it covers the table exactly, so adding a command to the table
// without teaching the parser and /help about it fails here.
var sampleInvocations = map[string]string{
	"ls":     "/ls",
	"card":   "/card w1:p1",
	"say":    "/say w1:p1 hello",
	"stop":   "/stop w1:p1",
	"mirror": "/mirror w1:p1 on",
	"doctor": "/doctor",
	"help":   "/help",
}

// TestHelpListsEveryParseableCommand is the anti-drift lock: Parse and Help
// read the same table, and a command the user cannot find in /help is a
// command they will type as prose instead — which, aimed at a blocked agent,
// is an approval (G1).
func TestHelpListsEveryParseableCommand(t *testing.T) {
	h := Help()

	for _, sp := range table {
		if !strings.Contains(h, sp.usage()) {
			t.Errorf("Help() does not contain the usage line %q", sp.usage())
		}
		if !strings.Contains(h, sp.summary) {
			t.Errorf("Help() does not describe /%s", sp.name)
		}

		sample, ok := sampleInvocations[sp.name]
		if !ok {
			t.Errorf("table has /%s but no sample invocation is exercised", sp.name)
			continue
		}
		if got := Parse(sample); got.Kind != sp.kind {
			t.Errorf("Parse(%q) = %v, want %v (table says /%s is %v)", sample, got.Kind, sp.kind, sp.name, sp.kind)
		}
	}

	for name := range sampleInvocations {
		if _, ok := lookup(name); !ok {
			t.Errorf("sample invocation for /%s but no such command in the table", name)
		}
	}
}

// Every action Kind the contract declares must be reachable: a Kind with no
// table row is a command the parser can never produce and /help can never show.
func TestEveryContractKindHasATableRow(t *testing.T) {
	inTable := map[Kind]bool{}
	for _, sp := range table {
		inTable[sp.kind] = true
	}
	for _, k := range []Kind{KindLs, KindCard, KindSay, KindStop, KindMirror, KindDoctor, KindHelp} {
		if !inTable[k] {
			t.Errorf("%v is declared in the contract but no table row produces it", k)
		}
	}
}

// ...and the other half: nothing outside the table may parse as an action. A
// slash name the table does not list must be refused, never guessed into a
// neighbouring command and never handed to an agent as text (G1).
func TestSlashNamesOutsideTheTableAreRefused(t *testing.T) {
	action := map[Kind]bool{
		KindLs: true, KindCard: true, KindSay: true, KindStop: true,
		KindMirror: true, KindDoctor: true, KindHelp: true,
	}
	for _, in := range []string{
		"/kill w1:p1",
		"/status",
		"/agents",
		"/exit",
		"/use w1:p1",
		"/start claude",
		"/restart w1:p1",
		"/attach 1",
		"/prompt w1:p1 hello",
		"/send w1:p1 hello",
		"/keys w1:p1 1",
		"/list",
		"/screen w1:p1",
	} {
		got := Parse(in)
		if action[got.Kind] {
			t.Errorf("Parse(%q) = %v; only the table may produce an action", in, got.Kind)
		}
		if got.Kind == KindProse {
			t.Errorf("Parse(%q) = KindProse; a slash line must never reach an agent as text (G1)", in)
		}
		if got.Kind != KindUnknown && got.Kind != KindBadArgs {
			t.Errorf("Parse(%q) = %v, want unknown or bad-args", in, got.Kind)
		}
	}
}

// Feishu's post renderer turns a GitHub-style markdown table into a BLANK
// bubble (S2 §3.8). Rendering /help as one would deliver an empty message.
func TestHelpIsNotAMarkdownTable(t *testing.T) {
	for _, line := range strings.Split(Help(), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "|") {
			t.Errorf("Help() has a table-ish line %q; Feishu renders those blank", line)
		}
	}
}

func TestHelpMentionsThePaneForms(t *testing.T) {
	h := Help()
	for _, form := range []string{"w1:p1", "w1-1", "p_1_1"} {
		if !strings.Contains(h, form) {
			t.Errorf("Help() does not mention the %q pane form", form)
		}
	}
}

// /help must fit in one Feishu message (8000 chars) without splitting; a
// truncated command list is a command list with a missing command.
func TestHelpFitsOneMessage(t *testing.T) {
	if n := len([]rune(Help())); n > 4000 {
		t.Errorf("Help() is %d runes; it would be split across messages", n)
	}
}
