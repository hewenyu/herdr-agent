package mirror

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"slices"
)

// ErrUnknownKind reports an agent kind no parser understands.
//
// It is an error rather than an empty result because the two mean opposite
// things to the caller: "this transcript has nothing to show" is an ordinary
// state of a live session, whereas "I have no parser for kind %q" is a wiring
// mistake that will never fix itself, and a notifier that silently fell back to
// the screen forever would never say so.
var ErrUnknownKind = errors.New("mirror: no transcript parser for agent kind")

// LastTurns returns the final turns of the transcript at path, newest last.
// See the Sampler contract for what it is for and when it must not be used.
//
// An empty result with a nil error means "nothing to show" — no file yet, or a
// file whose tail holds no conversation. A non-nil error means "I could not
// look". The caller falls back to the screen either way, but only the second is
// worth reporting.
//
// Turn.Seq orders turns within the sampled window, not within the file: the
// window starts wherever TailBytes lands, and the claude parser numbers the
// records it is given (the codex ordinal is the file's own, so it survives).
// Use the slice order, not Seq, to lay turns out.
func LastTurns(path, kind string, n int) ([]Turn, error) {
	p, ok := ParserFor(kind)
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownKind, kind)
	}
	return lastTurns(p, path, n, TailBytes)
}

// lastTurns is LastTurns with the parser and the window size injected, so that
// tests can drive a cut at every byte offset of a real fixture without a 256 KiB
// one, and can exercise a parser that fails — which the two shipped ones, by
// contract, never do.
func lastTurns(p Parser, path string, n int, tailBytes int64) ([]Turn, error) {
	if n <= 0 || tailBytes <= 0 {
		return []Turn{}, nil
	}

	data, err := readTail(path, tailBytes)
	if err != nil {
		return nil, err
	}

	// The trailing partial line is dropped, not carried: unlike the watcher there
	// is no next read to complete it. Half a record is not a turn.
	turns, _, err := p.Parse(data)
	if err != nil {
		// A parser that raises is already outside its contract ("an unrecognised
		// record is skipped, never an error"). Whatever it did hand back is still
		// the newest thing the phone can be shown, so it wins over reporting a
		// failure; only a parse that produced nothing at all leaves the caller with
		// a choice to make.
		if len(turns) == 0 {
			return nil, fmt.Errorf("mirror: parse %s transcript %q: %w", p.Name(), path, err)
		}
		slog.Default().Warn("mirror: parser error while sampling a transcript",
			"parser", p.Name(), "path", path, "err", err)
	}
	if len(turns) == 0 {
		return []Turn{}, nil
	}
	if len(turns) > n {
		// Copied rather than resliced: the discarded turns hold the text of the
		// whole window, and the result outlives this call inside a notification.
		return slices.Clone(turns[len(turns)-n:]), nil
	}
	return turns, nil
}

// readTail returns the last tailBytes of path with the leading partial record
// removed, or nil if there is nothing readable there.
//
// Only the end of the file is read because a transcript grows without bound
// while the answer the phone wants is always the last few records; sampling the
// tail keeps a day-old session as cheap as a fresh one.
//
// A file that does not exist is not a failure: an agent that has been detected
// but has not yet written a transcript is a state every claude session passes
// through (G8), and it is indistinguishable here from a session that simply has
// nothing to say. Everything else — a permission we do not have, a path that is
// a directory, a read that fails halfway — is reported, because those do not fix
// themselves and the caller has to be able to tell them apart.
func readTail(path string, tailBytes int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("mirror: open transcript %q: %w", path, err)
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("mirror: stat transcript %q: %w", path, err)
	}

	var off int64
	if fi.Size() > tailBytes {
		off = fi.Size() - tailBytes
		if _, err := f.Seek(off, io.SeekStart); err != nil {
			return nil, fmt.Errorf("mirror: seek transcript %q: %w", path, err)
		}
	}
	// Bounded by the same window even though the agent is appending as we read:
	// the point is a cheap sample, and anything written since the stat is by
	// definition newer than the turn we were asked for.
	data, err := io.ReadAll(io.LimitReader(f, tailBytes))
	if err != nil {
		return nil, fmt.Errorf("mirror: read transcript %q: %w", path, err)
	}
	if off == 0 {
		// The whole file: its first line is a whole record.
		return data, nil
	}

	// The window opened in the middle of a record — one byte in a million lands
	// on a boundary — so the bytes before the first newline are the tail of a
	// record whose head was never read. Feeding that to a parser produces one
	// skipped line and a debug log, but it would also mean a JSON fragment
	// deciding what the phone shows if it ever happened to unmarshal.
	var rest []byte
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		rest = data[i+1:]
	}

	// No newline left after the cut record means no TERMINATED record in the
	// window: a single record is longer than tailBytes, and everything sampled
	// is fragment — the head of one, or the head of one plus a record still
	// being written, which the parser drops for the same reason (see the note on
	// the trailing partial line above). Either way the caller gets "nothing to
	// show" and falls back to the terminal, which is the very thing sampling the
	// transcript exists to avoid, so it is logged rather than left looking like
	// an idle session. At warn, not debug: a bridge running at info would
	// otherwise still have no way to tell the two apart, and silence is the
	// whole defect. It is bounded — one line per sample, and only for a record
	// upwards of a quarter of a megabyte.
	//
	// Widening the read was the alternative and is deliberately not done: the
	// contract says LastTurns "reads only the last TailBytes", a wider window
	// only moves the cliff rather than removing it (a 3 MiB record defeats a
	// 2 MiB window exactly as well), and in this one case the screen fallback is
	// not the pathology the transcript replaced — a terminal that just printed a
	// quarter-megabyte answer is showing the end of that answer, not the
	// scrollback furniture around a one-line one.
	if bytes.IndexByte(rest, '\n') < 0 {
		slog.Default().Warn("mirror: no complete record in the sampled tail of a transcript; the caller will fall back to the screen",
			"path", path, "window", tailBytes, "size", fi.Size())
		return nil, nil
	}
	return rest, nil
}
