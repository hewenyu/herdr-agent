package main

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// cmdLs prints one line per agent herdr can see.
func cmdLs(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "ls", "")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return usagef("ls takes no arguments, got %q", fs.Arg(0))
	}

	list, err := d.Client.AgentList(ctx)
	if err != nil {
		return fmt.Errorf("agent.list: %w", err)
	}
	if len(list) == 0 {
		fmt.Fprintln(d.Err, "no agents: herdr sees no pane running a coding agent")
		return nil
	}

	// pane_id is the sort key and the display key. terminal_id is never shown:
	// it is not stable across a herdr restart, so a human who copied it would
	// address the wrong terminal after the server comes back (G10).
	sort.Slice(list, func(i, j int) bool { return list[i].PaneID < list[j].PaneID })

	rows := make([]lsRow, 0, len(list))
	for _, in := range list {
		rows = append(rows, d.lsRow(in))
	}
	writeLsTable(d, rows)
	return nil
}

type lsRow struct {
	pane   string
	status string
	emoji  string
	kind   string
	seq    string
	cwd    string
	title  string
}

func (d *deps) lsRow(in herdrapi.AgentInfo) lsRow {
	st := statusOf(in.AgentStatus)
	title := firstNonEmpty(derefStr(in.TerminalTitleStripped), derefStr(in.Title), derefStr(in.Name))
	cwd := firstNonEmpty(derefStr(in.Cwd), derefStr(in.ForegroundCwd))
	return lsRow{
		pane:   orDash(in.PaneID),
		status: string(st),
		emoji:  statusEmoji(st),
		kind:   orDash(derefStr(in.Agent)),
		seq:    fmt.Sprint(in.StateChangeSeq),
		cwd:    orDash(d.shortenHome(cwd)),
		title:  orDash(title),
	}
}

func writeLsTable(d *deps, rows []lsRow) {
	w := map[string]int{"pane": len("PANE"), "status": len("STATUS"), "kind": len("KIND"), "seq": len("SEQ"), "cwd": len("CWD")}
	for _, r := range rows {
		w["pane"] = max(w["pane"], len(r.pane))
		w["status"] = max(w["status"], len(r.status))
		w["kind"] = max(w["kind"], len(r.kind))
		w["seq"] = max(w["seq"], len(r.seq))
		w["cwd"] = max(w["cwd"], len([]rune(r.cwd)))
	}
	// The header goes to stderr so that stdout stays one record per agent and
	// can be piped into awk without being told to skip a line.
	fmt.Fprintf(d.Err, "   %-*s  %-*s  %-*s  %*s  %-*s  %s\n",
		w["pane"], "PANE", w["status"], "STATUS", w["kind"], "KIND", w["seq"], "SEQ", w["cwd"], "CWD", "TITLE")
	for _, r := range rows {
		fmt.Fprintf(d.Out, "%s %-*s  %-*s  %-*s  %*s  %-*s  %s\n",
			r.emoji, w["pane"], r.pane, w["status"], r.status, w["kind"], r.kind,
			w["seq"], r.seq, w["cwd"], r.cwd, r.title)
	}
}

// shortenHome makes a cwd readable in a narrow terminal without losing which
// project it is.
func (d *deps) shortenHome(path string) string {
	if d.Home == "" || path == "" {
		return path
	}
	if path == d.Home {
		return "~"
	}
	if rest, ok := strings.CutPrefix(path, d.Home+string(filepath.Separator)); ok {
		return "~" + string(filepath.Separator) + rest
	}
	return path
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}
