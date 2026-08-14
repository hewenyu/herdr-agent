package cards

import (
	"encoding/json"
	"fmt"
	"math"
)

// maxSafeInt is the largest integer a JSON float64 represents exactly. A seq
// beyond it did not survive the wire, so comparing it against the agent's
// current state_change_seq would be comparing rounded numbers.
const maxSafeInt = 1 << 53

// maxSessionID bounds the free-form session field.
//
// The field is free-form because it is herdr's value, not ours: for claude and
// codex it is a 36-character UUID, but SessionRef.Kind can also be "path"
// (G8), so its shape is not ours to validate. Its LENGTH is: a card value is
// attacker-reachable only through the values we wrote, yet an unbounded string
// arriving here would be copied into the selection store and compared on every
// delivery, so it is capped at a size no real ref approaches.
const maxSessionID = 256

// str reads a string field. Missing is distinguished from present-but-wrong so
// the log says which one happened.
func str(v map[string]any, key string, required bool) (string, error) {
	raw, ok := v[key]
	if !ok || raw == nil {
		if required {
			return "", fmt.Errorf("cards: %q is missing: %w", key, ErrBadDecision)
		}
		return "", nil
	}
	s, ok := raw.(string)
	if !ok {
		return "", fmt.Errorf("cards: %q is %T, want string: %w", key, raw, ErrBadDecision)
	}
	if required && s == "" {
		return "", fmt.Errorf("cards: %q is empty: %w", key, ErrBadDecision)
	}
	return s, nil
}

// integer reads a whole, non-negative number.
//
// Feishu decodes card values with encoding/json into any, so every number
// arrives as float64 — including the two the Guard depends on. json.Number and
// the Go integer types are accepted as well, because a caller that builds the
// map itself (a test, a replay tool) must decode to the same Decision as the
// wire. Strings are NOT accepted: "42" is not a sequence number, it is a sign
// that something rewrote the value on the way here.
func integer(v map[string]any, key string, required bool) (uint64, error) {
	raw, ok := v[key]
	if !ok || raw == nil {
		if required {
			return 0, fmt.Errorf("cards: %q is missing: %w", key, ErrBadDecision)
		}
		return 0, nil
	}

	var f float64
	switch n := raw.(type) {
	case float64:
		f = n
	case json.Number:
		parsed, err := n.Float64()
		if err != nil {
			return 0, fmt.Errorf("cards: %q is %q, want a number: %w", key, n.String(), ErrBadDecision)
		}
		f = parsed
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	case uint64:
		if n >= maxSafeInt {
			return 0, fmt.Errorf("cards: %q is out of range: %w", key, ErrBadDecision)
		}
		f = float64(n)
	default:
		return 0, fmt.Errorf("cards: %q is %T, want a number: %w", key, raw, ErrBadDecision)
	}

	switch {
	case math.IsNaN(f), math.IsInf(f, 0):
		return 0, fmt.Errorf("cards: %q is not a finite number: %w", key, ErrBadDecision)
	case f < 0:
		return 0, fmt.Errorf("cards: %q is negative: %w", key, ErrBadDecision)
	case f != math.Trunc(f):
		return 0, fmt.Errorf("cards: %q is fractional: %w", key, ErrBadDecision)
	case f >= maxSafeInt:
		return 0, fmt.Errorf("cards: %q is out of range: %w", key, ErrBadDecision)
	}
	return uint64(f), nil
}
