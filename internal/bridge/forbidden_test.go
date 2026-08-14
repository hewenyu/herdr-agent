package bridge

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// TestPackageNeverNamesAForbiddenHerdrMethod.
//
// This package cannot reach the herdr socket today — it only holds interfaces
// from internal/agents and internal/screen, and none of them exposes focus. The
// guard is against tomorrow: the moment someone reaches for herdrapi here to
// "mark a notification as read", agent.focus clears `done` back to `idle` and
// yanks the desktop user's UI to that tab (G10). `done` is the most reliable
// notification trigger there is (G11), so a read-receipt implemented that way
// destroys the signal it acknowledges. There is no read-receipt.
//
// The scan is over the AST rather than the raw bytes, so the prose above — and
// the comments in sink.go that explain the same rule — do not trip it.
func TestPackageNeverNamesAForbiddenHerdrMethod(t *testing.T) {
	files := packageSources(t)
	if len(files) == 0 {
		t.Fatal("no sources were scanned; this test would pass vacuously")
	}

	fset := token.NewFileSet()
	for _, path := range files {
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			switch node := n.(type) {
			case *ast.BasicLit:
				if node.Kind != token.STRING {
					return true
				}
				lit, err := strconv.Unquote(node.Value)
				if err != nil {
					return true
				}
				if slices.Contains(herdrapi.ForbiddenMethods, lit) {
					t.Errorf("%s names the forbidden herdr method %q", pos(fset, node.Pos()), lit)
				}
			case *ast.SelectorExpr:
				// Any x.Focus(...) — no interface the bridge holds has one, and
				// none should be added.
				if node.Sel != nil && node.Sel.Name == "Focus" {
					t.Errorf("%s calls a Focus method; focusing a pane clears `done` and steals the desktop UI (G10)",
						pos(fset, node.Pos()))
				}
			}
			return true
		})
	}
}

// TestForbiddenListIsNotEmpty guards the guard.
func TestForbiddenListIsNotEmpty(t *testing.T) {
	for _, want := range []string{"agent.focus", "pane.focus"} {
		if !slices.Contains(herdrapi.ForbiddenMethods, want) {
			t.Fatalf("%q is missing from herdrapi.ForbiddenMethods; the scan above proves nothing", want)
		}
	}
}

func packageSources(t *testing.T) []string {
	t.Helper()

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package directory: %v", err)
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		abs, err := filepath.Abs(name)
		if err != nil {
			t.Fatalf("resolve %s: %v", name, err)
		}
		out = append(out, abs)
	}
	return out
}

func pos(fset *token.FileSet, p token.Pos) string {
	at := fset.Position(p)
	return filepath.Base(at.Filename) + ":" + strconv.Itoa(at.Line)
}
