package main

import (
	"context"
	"errors"
	"runtime/debug"
	"strings"
	"testing"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// TestResolveBuildNeverInventsAVersion is the whole point of this file. A binary
// that reports a number it cannot know sends whoever reads a bug report looking
// at the wrong commit, so every unstamped fact has to come out as "dev" or
// "unknown" and never as a plausible value.
func TestResolveBuildNeverInventsAVersion(t *testing.T) {
	f := resolveBuild(devVersion, "", "", nil)

	if f.Version != devVersion {
		t.Errorf("Version = %q, want %q for a build nobody stamped", f.Version, devVersion)
	}
	if f.Commit != unknownValue {
		t.Errorf("Commit = %q, want %q: no commit is knowable here", f.Commit, unknownValue)
	}
	if f.Date != unknownValue {
		t.Errorf("Date = %q, want %q: no build date is knowable here", f.Date, unknownValue)
	}
	if f.Stamped {
		t.Error("Stamped is true for a build with no -ldflags")
	}
	out := f.String()
	if !strings.Contains(out, "is not a release") {
		t.Errorf("an unstamped build must say so in words:\n%s", out)
	}
	// A zero time formatted by accident is the classic fabricated fact.
	if strings.Contains(out, "1970") || strings.Contains(out, "0001-01-01") {
		t.Errorf("output carries a fabricated timestamp:\n%s", out)
	}
}

func TestResolveBuildUsesTheLinkTimeStamps(t *testing.T) {
	// What release.yml passes: the tag verbatim, the full commit, an RFC 3339
	// UTC instant.
	const (
		version = "v1.4.0"
		commit  = "1369e5d1c0ffee0000000000000000000000beef"
		date    = "2026-08-14T09:41:07Z"
	)
	// Build info from a checkout that also happened to be dirty. The stamps win
	// on the two facts they carry; vcs.modified is not one of them, and must
	// still be reported.
	bi := &debug.BuildInfo{
		Main: debug.Module{Version: "(devel)"},
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "0000000000000000000000000000000000000000"},
			{Key: "vcs.time", Value: "1999-12-31T23:59:59Z"},
			{Key: "vcs.modified", Value: "true"},
		},
	}

	f := resolveBuild(version, commit, date, bi)
	if f.Version != version {
		t.Errorf("Version = %q, want the stamped %q", f.Version, version)
	}
	if f.Commit != commit {
		t.Errorf("Commit = %q, want the stamped %q", f.Commit, commit)
	}
	if f.Date != date {
		t.Errorf("Date = %q, want the stamped %q", f.Date, date)
	}
	if !f.Stamped {
		t.Error("Stamped is false for a build that carries a tag")
	}

	out := f.String()
	for _, want := range []string{version, commit + "-dirty", date} {
		if !strings.Contains(out, want) {
			t.Errorf("output does not carry %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "is not a release") {
		t.Errorf("a stamped build must not disclaim itself:\n%s", out)
	}
}

// A locally built binary still knows its commit: `go build` records
// vcs.revision by itself. That is the difference between a useful bug report
// and "dev, unknown, unknown".
func TestResolveBuildFallsBackToTheToolchainVCSStamp(t *testing.T) {
	bi := &debug.BuildInfo{
		Main: debug.Module{Version: "(devel)"},
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "1369e5daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
			{Key: "vcs.time", Value: "2026-08-13T09:10:11Z"},
			{Key: "vcs.modified", Value: "false"},
		},
	}
	f := resolveBuild(devVersion, "", "", bi)

	if f.Version != devVersion {
		t.Errorf("Version = %q: a commit is not a version, and (devel) is not one either", f.Version)
	}
	if f.Commit != "1369e5daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("Commit = %q, want the toolchain's vcs.revision", f.Commit)
	}
	if f.Date != "2026-08-13T09:10:11Z" {
		t.Errorf("Date = %q, want the toolchain's vcs.time", f.Date)
	}
	if f.Dirty {
		t.Error("Dirty is true for vcs.modified=false")
	}
	if got := f.String(); strings.Contains(got, "-dirty") {
		t.Errorf("clean tree reported as dirty:\n%s", got)
	}
}

// `go install ...@v1.2.3` is a real release with no -ldflags anywhere near it.
// Reporting "dev" for it is the same lie in the other direction.
func TestResolveBuildAcceptsAModuleVersionFromGoInstall(t *testing.T) {
	bi := &debug.BuildInfo{Main: debug.Module{Version: "v1.2.3"}}
	f := resolveBuild(devVersion, "", "", bi)

	if f.Version != "v1.2.3" {
		t.Errorf("Version = %q, want the module version %q", f.Version, "v1.2.3")
	}
	if !f.Stamped {
		t.Error("Stamped is false for a version go install resolved from the module proxy")
	}
	if got := f.String(); strings.Contains(got, "is not a release") {
		t.Errorf("a released module version must not disclaim itself:\n%s", got)
	}
}

// The regression that motivated isReleaseVersion. Go 1.24 and later derive a
// pseudo-version for a plain `go build` inside a git worktree, so Main.Version
// is NOT evidence of a release — and printing it made a local build announce
// itself as "v0.0.0-20260814134108-96ef491e91e0+dirty" with no hint that nothing
// was ever released under that name.
func TestResolveBuildRejectsAPseudoVersion(t *testing.T) {
	bi := &debug.BuildInfo{
		Main: debug.Module{Version: "v0.0.0-20260814134108-96ef491e91e0+dirty"},
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "96ef491e91e08019208aa24451e40004330e391f"},
			{Key: "vcs.modified", Value: "true"},
		},
	}
	f := resolveBuild(devVersion, "", "", bi)

	if f.Version != devVersion {
		t.Errorf("Version = %q, want %q: a derived pseudo-version is not a release", f.Version, devVersion)
	}
	out := f.String()
	if !strings.Contains(out, "is not a release") {
		t.Errorf("a local build must still say it is not a release:\n%s", out)
	}
	// The commit is the fact worth keeping from that build info.
	if !strings.Contains(out, "96ef491e91e08019208aa24451e40004330e391f-dirty") {
		t.Errorf("output lost the commit it did know:\n%s", out)
	}
}

func TestIsReleaseVersion(t *testing.T) {
	for v, want := range map[string]bool{
		"v1.2.3":      true,
		"v0.1.0":      true,
		"v1.2.3-rc1":  true,
		"v1.2.3-rc.1": true,
		// Exactly as long as an abbreviated hash and not one: length alone must
		// not condemn a prerelease tag.
		"v1.2.3-notahexvalue":                true,
		"":                                   false,
		"(devel)":                            false,
		"dev":                                false,
		"1.2.3":                              false, // no leading v: not a module version
		"v0.0.0-20260814134108-96ef491e91e0": false, // pseudo-version
		"v0.0.0-20260814134108-96ef491e91e0+dirty": false, // pseudo-version, dirty tree
		"v1.2.4-0.20260814134108-96ef491e91e0":     false, // pseudo-version after a tag
		"v1.2.3+dirty":                             false, // build metadata means derived here
	} {
		if got := isReleaseVersion(v); got != want {
			t.Errorf("isReleaseVersion(%q) = %v, want %v", v, got, want)
		}
	}
}

// "-dirty" alongside an unknown commit would read as a claim about a revision
// nobody identified.
func TestResolveBuildDoesNotMarkAnUnknownCommitDirty(t *testing.T) {
	bi := &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.modified", Value: "true"}}}
	f := resolveBuild(devVersion, "", "", bi)

	if f.Commit != unknownValue {
		t.Fatalf("Commit = %q, want %q", f.Commit, unknownValue)
	}
	if got := f.String(); strings.Contains(got, "-dirty") {
		t.Errorf("unknown commit reported as dirty:\n%s", got)
	}
}

func TestVersionCommand(t *testing.T) {
	t.Run("prints the block on stdout", func(t *testing.T) {
		h := newHarness(t)
		if err := dispatch(context.Background(), h.d, []string{"version"}); err != nil {
			t.Fatalf("version: %v", err)
		}
		out := h.stdout()
		if !strings.HasPrefix(out, "herdr-agent ") {
			t.Errorf("stdout does not start with the program name:\n%s", out)
		}
		// The one compatibility fact the binary can state without herdr running.
		if !strings.Contains(out, "protocol 19") {
			t.Errorf("stdout does not name the herdr protocol floor %d:\n%s", herdrapi.MinProtocol, out)
		}
		if h.stderr() != "" {
			t.Errorf("version wrote to stderr, which carries diagnostics: %q", h.stderr())
		}
	})

	t.Run("takes no arguments", func(t *testing.T) {
		h := newHarness(t)
		err := dispatch(context.Background(), h.d, []string{"version", "please"})
		var ue *usageError
		if !errors.As(err, &ue) {
			t.Fatalf("err = %v, want a usage error", err)
		}
		if report(&h.errb, err) != exitUsage {
			t.Error("a rejected argument must exit with the usage code")
		}
	})

	t.Run("reachable from the command table", func(t *testing.T) {
		// dispatch and help both read that table, so a command missing from it
		// exists in neither.
		for _, c := range commandTable() {
			if c.name == "version" {
				return
			}
		}
		t.Fatal("commandTable has no version command")
	})
}
