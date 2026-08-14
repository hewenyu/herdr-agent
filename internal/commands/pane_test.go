package commands

import "testing"

func TestNormalizePane(t *testing.T) {
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		// canonical, the id herdr keeps stable across restarts (G10)
		{"w1:p1", "w1:p1", true},
		{"w12:p345", "w12:p345", true},
		{"W1:P1", "w1:p1", true},
		{"w0:p0", "w0:p0", true},

		// legacy forms herdr tolerates
		{"w1-1", "w1-1", true},
		{"W2-10", "w2-10", true},
		{"p_1_1", "p_1_1", true},
		{"p_w1_1", "p_w1_1", true},
		{"1", "1", true},
		{"42", "42", true},

		// not panes
		{"", "", false},
		{" ", "", false},
		{"w1", "", false},
		{"p1", "", false},
		{"w1:p", "", false},
		{"w:p", "", false},
		{"w1:p1:p1", "", false},
		{"w1;p1", "", false},
		{"w1.p1", "", false},
		{"w-1:p1", "", false},
		{"w1:p-1", "", false},
		{"+1", "", false},
		{"1.0", "", false},
		{"one", "", false},
		{"hello", "", false},
		{"/tmp", "", false},
		{"w1:p1 ", "w1:p1", true}, // callers may hand us a token with padding
		{"1234567", "", false},    // seven digits is a typo, not a pane
		{"w1234567:p1", "", false},
		{"w1:p1\n", "w1:p1", true},
		{"ｗ1:ｐ1", "", false}, // fullwidth letters are not the ascii id herdr wants
	}

	for _, tc := range tests {
		got, ok := normalizePane(tc.in)
		if ok != tc.ok {
			t.Errorf("normalizePane(%q) ok = %v, want %v", tc.in, ok, tc.ok)
			continue
		}
		if got != tc.want {
			t.Errorf("normalizePane(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// normalizePane must not invent a canonical form for the legacy shapes. herdr
// resolves them itself, and the w<N>:p<M> mapping for a bare index was never
// measured (G10) — guessing it would aim a keystroke at the wrong pane.
func TestNormalizePaneDoesNotRewriteLegacyForms(t *testing.T) {
	for _, in := range []string{"w1-1", "p_1_1", "p_w1_1", "3"} {
		got, ok := normalizePane(in)
		if !ok {
			t.Fatalf("normalizePane(%q) rejected a form herdr accepts", in)
		}
		if got != in {
			t.Errorf("normalizePane(%q) = %q, want it handed through unchanged", in, got)
		}
	}
}
