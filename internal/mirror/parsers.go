package mirror

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	roleUser      = "user"
	roleAssistant = "assistant"
)

// ParserFor returns the parser for a herdr agent kind ("claude", "codex").
//
// Each call returns a FRESH parser: a parser carries the record counter for one
// transcript file, so two panes — or the same pane after /resume swapped the
// session id under it — must never share one. For the same reason a parser is
// not safe for concurrent use; one tail loop owns it.
func ParserFor(kind string) (Parser, bool) {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "claude":
		return newClaudeParser(nil), true
	case "codex":
		return newCodexParser(nil), true
	default:
		return nil, false
	}
}

// logger resolves an optional injected logger. Tests pass their own to assert
// that unknown record types are reported rather than swallowed.
func logger(l *slog.Logger) *slog.Logger {
	if l != nil {
		return l
	}
	return slog.Default()
}

// splitLines splits data into whole JSONL records, returning any trailing
// partial line separately.
//
// The caller is a tailer reading a file another process is still appending to,
// so the last line of a read is routinely half-written. Blank lines are not
// records and are dropped here; \r is tolerated so a transcript that ever
// travelled through a CRLF tool still parses.
//
// rest is a copy, not a sub-slice of data: the caller prepends it to the next
// chunk (append(rest, next...)), and appending to a slice that still aliases
// the previous buffer would scribble over bytes the caller owns.
func splitLines(data []byte) (lines [][]byte, rest []byte) {
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return nil, cloneBytes(data)
	}
	for _, line := range bytes.Split(data[:end+1], []byte("\n")) {
		line = bytes.TrimRight(line, "\r")
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		lines = append(lines, line)
	}
	return lines, cloneBytes(data[end+1:])
}

func cloneBytes(b []byte) []byte {
	if len(b) == 0 {
		return nil
	}
	out := make([]byte, len(b))
	copy(out, b)
	return out
}

// decodeRecord unmarshals one transcript record, tolerating fields whose JSON
// type is not the one we expect.
//
// encoding/json reports the FIRST type mismatch it hits but still populates
// every other field, so discarding the value on err != nil throws away a record
// that was decoded perfectly well apart from one field. That is how "the vendor
// changed a field's shape" turns into "the mirror is silent while still
// reporting itself enabled" — the S2 §8 failure the Parser contract's "must be
// resilient" is aimed at. A syntax error is different: nothing was decoded, so
// the caller has to skip the record.
func decodeRecord(data []byte, v any) (err error, fatal bool) {
	err = json.Unmarshal(data, v)
	if err == nil {
		return nil, false
	}
	var mismatch *json.UnmarshalTypeError
	return err, !errors.As(err, &mismatch)
}

// parseTime reads a transcript timestamp. Both vendors write RFC3339 with
// milliseconds and a Z suffix.
//
// It takes the raw JSON rather than a string so that the record's least
// valuable field cannot cost its text: decoding a number into a string field
// would fail the whole record for a clock. A timestamp we cannot read is logged
// and becomes the zero time, and the turn goes out regardless.
func parseTime(raw json.RawMessage, log *slog.Logger, seq uint64) time.Time {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return time.Time{}
	}
	if s[0] == '"' {
		var v string
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			log.Debug("mirror: unreadable transcript timestamp", "value", s, "seq", seq, "err", err)
			return time.Time{}
		}
		if v == "" {
			return time.Time{}
		}
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			log.Debug("mirror: unreadable transcript timestamp", "value", v, "seq", seq, "err", err)
			return time.Time{}
		}
		return t
	}
	// Integers are parsed as integers: a float64 mantissa cannot hold a
	// nanosecond epoch, and rounding a clock to the nearest 64ns to save a line
	// of code is not a trade worth making.
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return epochTime(n)
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		log.Debug("mirror: unreadable transcript timestamp", "value", s, "seq", seq, "err", err)
		return time.Time{}
	}
	if math.Abs(f) < epochSecondsMax { // fractional seconds
		sec, frac := math.Modf(f)
		return time.Unix(int64(sec), int64(math.Round(frac*float64(time.Second)))).UTC()
	}
	return epochTime(int64(f))
}

// Upper bounds on a numeric timestamp's magnitude, by unit. They are far enough
// apart that reading the unit off the magnitude is safe for any date a
// transcript can carry: a seconds epoch does not reach 1e11 until the year
// 5138, and a milliseconds epoch passed 1e11 back in 1973.
const (
	epochSecondsMax = 1e11
	epochMillisMax  = 1e14
	epochMicrosMax  = 1e17
)

// epochTime reads a numeric timestamp, taking its unit from its magnitude.
// Neither vendor writes one today; this exists so that one starting to would
// cost the clock rather than the record.
func epochTime(n int64) time.Time {
	switch an := math.Abs(float64(n)); {
	case n == 0:
		return time.Time{}
	case an < epochSecondsMax:
		return time.Unix(n, 0).UTC()
	case an < epochMillisMax:
		return time.UnixMilli(n).UTC()
	case an < epochMicrosMax:
		return time.UnixMicro(n).UTC()
	default:
		return time.Unix(0, n).UTC()
	}
}
