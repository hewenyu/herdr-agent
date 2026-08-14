package main

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/herdrapi"
)

// Build stamps, overwritten at link time by .github/workflows/release.yml:
//
//	-ldflags "-X main.buildVersion=$TAG -X main.buildCommit=$SHA -X main.buildDate=$WHEN"
//
// The defaults are the honest answer for a binary nobody stamped. "dev" is not
// a release and does not pretend to be one: this repo had no tags when the
// workflow was written, the version comes from the tag that triggered the
// release and from nowhere else, and a plausible-looking number here would be a
// value the build cannot know. The other two are empty rather than invented,
// and resolveBuild fills them in from the VCS stamp the toolchain records by
// itself — so even `go build ./cmd/herdr-agent` can say which commit it is.
var (
	buildVersion = "dev"
	buildCommit  = ""
	buildDate    = ""
)

// devVersion is the version string that means "not a release". It is compared
// against, not just printed: it decides whether a module version found in the
// build info is allowed to win.
const devVersion = "dev"

// unknownValue is what a fact this binary does not carry is reported as. It is
// deliberately not an empty column and not a zero date: `version` output ends
// up pasted into bug reports, where a blank is read as "did not look" and a
// fabricated 1970 timestamp is read as fact.
const unknownValue = "unknown"

// buildFacts is everything `herdr-agent version` knows about itself.
type buildFacts struct {
	Version string
	Commit  string
	Date    string
	// Dirty reports that the working tree carried uncommitted changes when this
	// binary was linked, which makes Commit an approximation rather than an
	// identity. Worth printing: the difference between "the bug is in that
	// commit" and "the bug is in something never committed anywhere".
	Dirty bool
	Go    string
	// Stamped is false when no -ldflags were applied, i.e. this is a local
	// build rather than a downloaded release.
	Stamped bool
}

// resolveBuild folds the link-time stamps together with the build info the Go
// toolchain records on its own. bi is nil when the binary carries none.
//
// Precedence is stamps first, build info second, unknownValue last. Nothing
// here derives a version from a commit or a date: those are different facts.
//
// The three stamps are arguments rather than reads of the package variables so
// that a test can pin every combination without mutating a global that the rest
// of the suite is running against.
func resolveBuild(version, commit, date string, bi *debug.BuildInfo) buildFacts {
	f := buildFacts{
		Version: version,
		Commit:  commit,
		Date:    date,
		Go:      runtime.Version() + " " + runtime.GOOS + "/" + runtime.GOARCH,
		Stamped: version != devVersion,
	}
	if bi != nil {
		// `go install github.com/hewenyu/herdr-agent/cmd/herdr-agent@v1.2.3`
		// produces a genuinely released version with no -ldflags anywhere near
		// it. Reporting "dev" for that is the same kind of lie in the other
		// direction — but only a tag counts, see isReleaseVersion.
		if f.Version == devVersion && isReleaseVersion(bi.Main.Version) {
			f.Version = bi.Main.Version
			f.Stamped = true
		}
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				if f.Commit == "" {
					f.Commit = s.Value
				}
			case "vcs.time":
				if f.Date == "" {
					f.Date = s.Value
				}
			case "vcs.modified":
				f.Dirty = s.Value == "true"
			}
		}
	}
	if f.Commit == "" {
		f.Commit = unknownValue
	}
	if f.Date == "" {
		f.Date = unknownValue
	}
	return f
}

// isReleaseVersion reports whether v is a module version somebody actually
// tagged, as opposed to one the toolchain derived.
//
// Measured on this repo with Go 1.24 and later: a plain `go build` of a main
// package inside a git worktree fills BuildInfo.Main.Version in with a
// pseudo-version — `v0.0.0-20260814134108-96ef491e91e0+dirty`. It is derived
// from the commit and the tree state, not from a tag, and nothing was released
// under that name. Printing it as the version answers "what is this binary" with
// a number that looks like an answer, and suppresses the line saying this is a
// local build; "dev" plus the commit says the same thing without the disguise.
//
// So the test is: a leading v, no build metadata (`+dirty` is the local marker),
// and no 12-hex-digit final field. All three pseudo-version shapes end in the
// abbreviated commit hash —
//
//	v0.0.0-yyyymmddhhmmss-abcdefabcdef          (no earlier tag)
//	v1.2.4-0.yyyymmddhhmmss-abcdefabcdef        (after a release tag)
//	v1.2.4-rc.1.0.yyyymmddhhmmss-abcdefabcdef   (after a prerelease tag)
//
// — so that one field identifies all of them, while a real prerelease such as
// v1.2.3-rc.1 keeps a short final field. Anything unrecognised falls through to
// "dev", which is the safe direction to be wrong in.
func isReleaseVersion(v string) bool {
	if !strings.HasPrefix(v, "v") || strings.Contains(v, "+") {
		return false
	}
	parts := strings.Split(v, "-")
	if len(parts) < 2 {
		return true // vX.Y.Z
	}
	return !isLowerHex(parts[len(parts)-1], 12)
}

func isLowerHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9') && !(r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

// String renders the block `version` prints. One fact per line, label first, so
// it stays greppable and pastes into an issue unchanged.
func (f buildFacts) String() string {
	commit := f.Commit
	// "-dirty" is only meaningful next to a revision; on its own it would read
	// as a claim about a commit nobody identified.
	if f.Dirty && commit != unknownValue {
		commit += "-dirty"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "herdr-agent %s\n", f.Version)
	fmt.Fprintf(&b, "commit:  %s\n", commit)
	fmt.Fprintf(&b, "built:   %s\n", f.Date)
	fmt.Fprintf(&b, "go:      %s\n", f.Go)
	// The one compatibility fact a downloaded binary can state by itself. herdr
	// below this protocol is refused by serve rather than half-supported, and
	// the wire types were measured against 19 (G10), so the number belongs
	// where somebody comparing it to `herdr --version` will find it.
	fmt.Fprintf(&b, "herdr:   needs protocol %d or newer\n", herdrapi.MinProtocol)
	// Deliberately says nothing about the commit line: `go run` stamps no VCS
	// information at all, so "it carries the commit above" would be false there
	// exactly as often as it is true after `go build`.
	if !f.Stamped {
		fmt.Fprintf(&b, "\n%q is not a release: this binary was built from source rather than\n"+
			"downloaded, so it has no tag. Released binaries report theirs here.\n", f.Version)
	}
	return b.String()
}

// cmdVersion answers what this binary is. It is the one command whose answer
// must not depend on herdr, on Feishu, or on anything on disk.
func cmdVersion(_ context.Context, d *deps, args []string) error {
	fs := newFlags(d, "version", "")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return usagef("version takes no arguments, got %q", fs.Arg(0))
	}

	bi, _ := debug.ReadBuildInfo() // nil when the binary carries no build info
	fmt.Fprint(d.Out, resolveBuild(buildVersion, buildCommit, buildDate, bi).String())
	return nil
}
