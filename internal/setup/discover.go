package setup

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/hewenyu/herdr-agent/internal/config"
)

// appIDShape is the shape internal/config enforces on FEISHU_APP_ID
// (config/load.go appIDShape), duplicated for the same reason the .env parser
// is: the two must agree, and a value this package accepted but the bridge
// rejects is a setup that reports success and a bridge that will not start.
//
// It also guards the one place a caller hands us an id to put in a URL: an app
// secret pasted into --reuse-app-id must be refused before it can travel into a
// console link or a confirmation page.
var appIDShape = regexp.MustCompile(`^cli_[A-Za-z0-9]+$`)

// source is one file that names credentials, in the order the bridge loads it.
type source struct {
	Path  string
	Creds credentials
	// State marks <stateDir>/.env — the file the bridge prefers, and the only
	// one this package writes.
	State bool
}

// discovery is everything the run learned before deciding anything, and before
// printing anything or touching the network.
//
// Discovering first is what lets the run state its plan in one sentence. The
// alternative — the shape this command had — is a user who watches it get half
// way and then stop to complain about a file, having already been told a link
// was coming.
type discovery struct {
	// StateEnv is <stateDir>/.env, whether or not it exists.
	StateEnv string
	// Sources are the files that name a credential, in bridge load order
	// (repository root first, state directory last).
	Sources []source
	// Effective is what config.Load would resolve right now: the sources merged
	// KEY BY KEY, later winning. It is not necessarily any single file's pair —
	// a state directory naming an app id and a repository .env holding a secret
	// resolve to a mixed pair, which is exactly the shape that makes the bridge
	// fail authentication with a file the operator swears is right.
	Effective credentials
}

// candidate is one app this machine already names, with the best secret found
// for it anywhere.
type candidate struct {
	AppID  string
	Secret string
	// Path is the file this candidate's APP ID was last named in — where a human
	// would go looking for it.
	Path string
	// SecretPath is the file Secret came from, which is not always Path: the
	// bridge merges the .env files key by key, so an id in one file and a secret
	// in the other are a pair, and every sentence about "where the credentials
	// are" has to be able to name both halves. Empty when no secret was found.
	SecretPath string
	// State is true when that file is <stateDir>/.env.
	State bool
	// Name is filled in only when a candidate has to be presented to a human.
	Name string
	// NameErr is why the name could not be fetched. Non-empty means the
	// question must show the id and admit the name is unknown, never invent one.
	NameErr string
}

// complete reports whether this candidate can be used without the network.
func (c candidate) complete() bool { return c.AppID != "" && c.Secret != "" }

// creds is the pair to write and verify with.
func (c candidate) creds() credentials {
	return credentials{AppID: c.AppID, AppSecret: c.Secret}
}

// discover reads every location the bridge would load credentials from.
//
// It mirrors config.loadDotEnv: the repository-root .env first, then
// <stateDir>/.env, the latter winning per key. Detecting the way the BRIDGE
// resolves credentials rather than the way setup writes them is what stops a
// checkout with a working .env from being handed a second app it never asked
// for (see repoEnvCredentials).
func (r *Runner) discover() (discovery, error) {
	d := discovery{StateEnv: envPath(r.stateDir)}

	if repo, path := repoEnvCredentials(); path != "" && (repo.AppID != "" || repo.AppSecret != "") {
		d.Sources = append(d.Sources, source{Path: path, Creds: repo})
	}
	state, err := readCredentials(d.StateEnv)
	if err != nil {
		return discovery{}, err
	}
	if state.AppID != "" || state.AppSecret != "" {
		d.Sources = append(d.Sources, source{Path: d.StateEnv, Creds: state, State: true})
	}

	for _, s := range d.Sources {
		if s.Creds.AppID != "" {
			d.Effective.AppID = s.Creds.AppID
		}
		if s.Creds.AppSecret != "" {
			d.Effective.AppSecret = s.Creds.AppSecret
		}
	}
	return d, nil
}

// candidates lists the apps this machine names, in bridge load order.
//
// One entry per app id, carrying the secret from whichever file has one for it.
// The last file to name an id owns the entry, because that is the one the bridge
// would resolve and therefore the one a human would be surprised to see ignored.
func (d discovery) candidates() []candidate {
	var out []candidate
	index := map[string]int{}

	for _, s := range d.Sources {
		id := s.Creds.AppID
		if id == "" {
			continue
		}
		i, seen := index[id]
		if !seen {
			out = append(out, candidate{AppID: id})
			i = len(out) - 1
			index[id] = i
		}
		out[i].Path, out[i].State = s.Path, s.State
		if s.Creds.AppSecret != "" {
			out[i].Secret, out[i].SecretPath = s.Creds.AppSecret, s.Path
		}
	}

	// The app the bridge would load gets the secret the bridge would pair with
	// it, which is not always the one sitting next to it: config.loadDotEnv
	// merges KEY BY KEY, so an id in one file and a secret in the other are a
	// pair, and a state directory holding only a secret overrides the repository
	// file's. Verifying anything other than that pair would prove something about
	// credentials the bridge is not going to use.
	for i := range out {
		if out[i].AppID == d.Effective.AppID && d.Effective.AppSecret != "" {
			// The provenance travels with the value. A secret adopted from one
			// file while the id came from another is the case where every
			// sentence this package writes about "the credentials in <file>" was
			// measured to name a file that never held one of the two halves.
			out[i].Secret, out[i].SecretPath = d.Effective.AppSecret, d.secretSource()
		}
	}
	return out
}

// secretSource is the file that supplied Effective.AppSecret — the last one to
// name a secret, because that is the one the bridge's merge keeps.
func (d discovery) secretSource() string {
	path := ""
	for _, s := range d.Sources {
		if s.Creds.AppSecret != "" {
			path = s.Path
		}
	}
	return path
}

// stateSource returns the <stateDir>/.env source, if it names anything.
func (d discovery) stateSource() (source, bool) {
	for _, s := range d.Sources {
		if s.State {
			return s, true
		}
	}
	return source{}, false
}

// planKind is what the run has decided to do.
type planKind int

const (
	// planRegister opens the confirmation page with no target app. The page
	// lists the tenant's existing apps as well as offering a new one, so this
	// covers "I have nothing" AND "I have an app but no secret for it on this
	// machine and would rather pick from a list".
	planRegister planKind = iota
	// planCreate opens the confirmation page with CreateOnly: a second app, on
	// purpose (--reregister).
	planCreate
	// planUpdate opens the confirmation page for ONE existing app — the SDK's
	// update flow — which re-grants our scopes, events and callbacks to it and
	// hands back its credentials.
	planUpdate
	// planAdopt copies credentials found elsewhere into <stateDir>/.env.
	planAdopt
	// planReuse uses <stateDir>/.env as it stands. No write, no network beyond
	// verification.
	planReuse
)

// plan is the decision, plus the one sentence that states it.
type plan struct {
	kind planKind
	app  candidate
	// replace allows the .env write to point at a different app than the file
	// currently names. Only ever true when a human said so, or when
	// --reregister did.
	replace bool
	// says is the single sentence printed before the plan is acted on.
	says string
}

// origin maps a plan to what the Result will claim about how the app was
// arrived at. Kept next to the plan so the claim cannot drift from the act.
func (p plan) origin() Origin {
	switch p.kind {
	case planCreate:
		return OriginCreated
	case planUpdate:
		return OriginUpdated
	case planAdopt:
		return OriginAdopted
	case planReuse:
		return OriginReused
	default:
		return OriginRegistered
	}
}

// choose picks the plan, asking the human only about the one thing that is
// genuinely theirs to decide.
//
// Everything else is inferred from what is on disk. In particular: credentials
// found in ANY file the bridge loads are adopted, never reported as a conflict —
// the user who hits that is the one following the documented repair path from
// inside a checkout, and telling them to move a file (or offering them a second
// permanent app) is asking them to solve a problem this function can just solve.
func (r *Runner) choose(ctx context.Context, rep *reporter, d discovery, reregister bool) (plan, error) {
	if r.permissionUpgrade && reregister {
		return plan{}, fmt.Errorf("setup: permission updates require an existing app and cannot be combined with --reregister")
	}
	if r.reuseAppID != "" {
		// Validated FIRST, before any message can quote it and before any URL
		// can carry it: the console lists App ID directly above App Secret, so a
		// value pasted in here may be the secret, and the secret is the one
		// string in this program that must never be echoed.
		if !appIDShape.MatchString(r.reuseAppID) {
			return plan{}, fmt.Errorf("%w: check you did not paste the app secret or a whole console URL",
				ErrMalformedAppID)
		}
		if reregister {
			// "Use exactly this app" and "make me another one" are opposite
			// instructions, and silently honouring one of them is how a
			// permanent app appears in a tenant that did not ask for it.
			return plan{}, fmt.Errorf("setup: --reregister makes a new app while reusing %s means using the one "+
				"that already exists; pick one", r.reuseAppID)
		}
	}

	if r.permissionUpgrade {
		return r.choosePermissionUpgrade(d)
	}

	if reregister {
		// CreateOnly is what makes the flag mean what it says. Without it the
		// page also offers the tenant's existing apps, so a run asked for a
		// SECOND app could return the first one and then report "created".
		return plan{
			kind: planCreate,
			// The flag IS the permission to repoint .env at a different app.
			replace: true,
			says: "Plan: create a second app on purpose (--reregister). The app you already have stays; " +
				"no API we could find deletes one.",
		}, nil
	}

	if r.reuseAppID != "" {
		return r.chooseReuse(d)
	}

	cands := d.candidates()
	switch len(cands) {
	case 0:
		return plan{
			kind: planRegister,
			says: "Plan: no credentials on this machine yet, so open the confirmation page. On that page you " +
				"can create a new app, or pick one you already have — either works.",
		}, nil
	case 1:
		return r.planFor(cands[0], d, false), nil
	default:
		return r.ask(ctx, rep, d, cands)
	}
}

// choosePermissionUpgrade never reaches a registration page that can choose a
// new app. An explicit target resolves multiple configured apps; otherwise only
// an unambiguous existing app may be updated.
func (r *Runner) choosePermissionUpgrade(d discovery) (plan, error) {
	cands := d.candidates()
	var app candidate
	if r.reuseAppID != "" {
		app = candidate{AppID: r.reuseAppID}
		for _, c := range cands {
			if c.AppID == r.reuseAppID {
				app = c
				break
			}
		}
	} else {
		switch len(cands) {
		case 0:
			return plan{}, fmt.Errorf("setup: permission updates require an existing app; pass --app <app_id> or run setup first")
		case 1:
			app = cands[0]
		default:
			return plan{}, fmt.Errorf("%w: pass --app <app_id> to select the existing app whose task permissions should be updated", ErrAmbiguousApps)
		}
	}
	if !appIDShape.MatchString(app.AppID) {
		return plan{}, fmt.Errorf("%w: configured app ID is not valid for a permission update", ErrMalformedAppID)
	}
	return plan{
		kind:    planUpdate,
		app:     app,
		replace: r.reuseAppID != "",
		says: fmt.Sprintf("Plan: update task permissions on existing app %s through its confirmation page. "+
			"The saved secret does not skip this update, and no new app is requested.", app.AppID),
	}, nil
}

// chooseReuse handles WithReuseAppID: use THIS app, whatever is on disk.
//
// The id has already been checked against appIDShape by choose, which is the
// only place that check belongs — before anything can echo it.
func (r *Runner) chooseReuse(d discovery) (plan, error) {
	id := r.reuseAppID
	for _, c := range d.candidates() {
		if c.AppID == id && c.complete() {
			return r.planFor(c, d, true), nil
		}
	}
	return plan{
		kind: planUpdate,
		app:  candidate{AppID: id},
		// The id was asked for explicitly, so pointing .env at it is the request
		// itself rather than a surprise.
		replace: true,
		says: fmt.Sprintf("Plan: no secret for %s on this machine, so open the confirmation page for THAT app. "+
			"It re-grants the scopes, events and callbacks the bridge needs to it and hands back its credentials; "+
			"no new app is made.", id),
	}, nil
}

// planFor decides what to do with the single app this machine already names.
func (r *Runner) planFor(c candidate, d discovery, pinned bool) plan {
	if !c.complete() {
		// Half a credential. Feishu shows an app secret once, so the secret is
		// not recoverable from anywhere on this machine — but the app itself is
		// perfectly good, and the update flow gets a usable secret for it
		// without leaving a second app behind. That is strictly better than the
		// refusal this used to be.
		return plan{
			kind:    planUpdate,
			app:     c,
			replace: true,
			says: fmt.Sprintf("Plan: %s names app %s but holds no usable %s, and Feishu shows a secret only "+
				"once — so open the confirmation page for that same app to get one. No new app is made.",
				c.Path, c.AppID, config.EnvAppSecret),
		}
	}

	if state, ok := d.stateSource(); ok && state.Creds.complete() && state.Creds.AppID == c.AppID {
		return plan{
			kind: planReuse,
			app:  c,
			says: fmt.Sprintf("Plan: app %s is already configured in %s, so skip registration and verify it. "+
				"No app will be made and nothing will be written.", c.AppID, state.Path),
		}
	}

	return plan{
		kind:    planAdopt,
		app:     c,
		replace: pinned,
		says:    adoptSentence(c, d.StateEnv),
	}
}

// adoptSentence states the adoption plan without naming a file that does not
// hold what the sentence says it holds.
//
// A split pair is not exotic — it is what a repository .env plus a state
// directory .env produce as soon as one of the two loses a key, and it is a
// working configuration, because the bridge merges them key by key. The sentence
// this replaced took the id's file for the pair's file and told one user it was
// copying <stateDir>/.env into <stateDir>/.env while the secret it was about to
// write sat in the repository file, unmentioned.
func adoptSentence(c candidate, stateEnv string) string {
	const why = "The bridge prefers the state directory, so leaving them where they are would mean every later " +
		"run finds the same fork in the road."
	switch {
	case c.SecretPath != "" && c.SecretPath != c.Path:
		return fmt.Sprintf("Plan: app %s is configured across two files — %s names it, %s holds its secret — so "+
			"complete the pair in %s and verify that app. %s", c.AppID, c.Path, c.SecretPath, stateEnv, why)
	case c.Path == stateEnv:
		// Not reachable through planFor today (a complete pair in the state file
		// is a reuse), and written out rather than left to the branch below,
		// which would claim to copy that file into itself.
		return fmt.Sprintf("Plan: %s already names app %s, so write the pair it needs into that same file and "+
			"verify that app.", stateEnv, c.AppID)
	default:
		return fmt.Sprintf("Plan: app %s already has credentials in %s, so copy them into %s and verify that "+
			"app. %s", c.AppID, c.Path, stateEnv, why)
	}
}

// ask resolves the one real ambiguity: two files, two different apps.
//
// The names are fetched first, because the question is unanswerable without
// them. "cli_aaf76546b438dbfc or cli_aaf4647d33f95be8?" differs in the fourth
// character; "herdr-agent or herdr-agent-e1?" is a question a human can answer
// in a second.
func (r *Runner) ask(ctx context.Context, rep *reporter, d discovery, cands []candidate) (plan, error) {
	if !r.interactive() {
		named := make([]string, 0, len(cands))
		for _, c := range cands {
			named = append(named, describe(c))
		}
		return plan{}, fmt.Errorf("%w: %s — re-run `herdr-agent setup` in a terminal to choose between them, "+
			"or pass --reregister to make a new app on purpose",
			ErrAmbiguousApps, strings.Join(named, "; "))
	}

	// Said BEFORE the lookups, which are up to nameTimeout each and are the first
	// network calls of the run. Without this the command's first act is up to
	// twenty seconds of silence, which on a stalled network is indistinguishable
	// from a hang — in the one command whose whole thesis is that it says what it
	// is about to do before it does it.
	rep.note("%d apps are configured on this machine; asking Feishu what they are called (up to %ds each) so "+
		"the question can name them…", len(cands), waitSeconds(nameTimeout))
	for i := range cands {
		cands[i].Name, cands[i].NameErr = r.appName(ctx, rep, cands[i])
	}

	var b strings.Builder
	if len(cands) == 2 {
		b.WriteString("Two apps are configured on this machine:\n")
	} else {
		fmt.Fprintf(&b, "%d apps are configured on this machine:\n", len(cands))
	}
	for i, c := range cands {
		fmt.Fprintf(&b, "  %d) %s  %s  from %s", i+1, c.label(), c.AppID, c.Path)
		if c.State {
			// The one fact that decides it for most people: this is the app the
			// bridge is using today.
			b.WriteString("  (the bridge uses this one)")
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "Which should the bridge use? [1-%d, or n to register a new app]", len(cands))

	// Asked twice at most. There is no safe default — a bare enter cannot pick
	// an app, because the wrong one points the bridge at a bot the user may never
	// have messaged — but a typo should cost one keypress rather than the run.
	question := b.String()
	for attempt := 0; ; attempt++ {
		answer, err := r.prompt.Ask(ctx, question)
		if err != nil {
			return plan{}, fmt.Errorf("setup: could not ask which app to use: %w", err)
		}
		answer = strings.TrimSpace(answer)

		switch strings.ToLower(answer) {
		case "n", "new", "no":
			return plan{
				kind: planRegister,
				// The human has just been shown the app the state file names and
				// asked for something else, so repointing that file is the
				// answer rather than a surprise.
				replace: true,
				says: "Plan: register a new app. On the confirmation page you can create one, or pick any app " +
					"you already have — either works. The apps above stay as they are; no API we could find " +
					"deletes one.",
			}, nil
		}

		for i, c := range cands {
			if answer == fmt.Sprint(i+1) || answer == c.AppID {
				p := r.planFor(c, d, true)
				// The human just answered the only question there was, so the
				// write may repoint .env at their answer.
				p.replace = true
				return p, nil
			}
		}

		if attempt > 0 {
			// The answer is NOT echoed. An app id is a valid answer here, the
			// console lists App ID directly above App Secret, and a human who
			// pasted the wrong one of the two must not have it printed back at
			// them — the same rule choose() applies to --reuse-app-id.
			return plan{}, fmt.Errorf("setup: that is not one of the choices; run `herdr-agent setup` again and "+
				"answer 1-%d, or n for a new app", len(cands))
		}
		question = fmt.Sprintf("Answer 1-%d to pick one of the apps above, or n to register a new one:", len(cands))
	}
}

// label is how a candidate is named to a human: the app's real name, or an
// honest admission that we could not fetch it.
func (c candidate) label() string {
	switch {
	case c.Name != "":
		return c.Name
	case c.NameErr != "":
		return "(name unavailable: " + c.NameErr + ")"
	default:
		return "(name unknown)"
	}
}

// describe names a candidate in an error, where no lookup has been done.
func describe(c candidate) string {
	return fmt.Sprintf("%s names %s", c.Path, c.AppID)
}

// interactive reports whether there is a human to ask.
//
// assumeYes does not mean "answer yes": the questions this package asks have no
// safe default, so it means "do not ask, fail with the explicit error".
func (r *Runner) interactive() bool { return r.prompt != nil && !r.assumeYes }

// adopt copies credentials into <stateDir>/.env, merging key by key.
//
// Merged rather than written fresh because that file is the operator's: it may
// carry unrelated variables, and truncating it to the two keys we know about
// would delete configuration whose absence surfaces somewhere else entirely,
// long after setup reported success.
func (r *Runner) adopt(rep *reporter, p plan) error {
	dest := envPath(r.stateDir)
	if err := writeCredentials(dest, p.app.creds(), r.now(), p.replace); err != nil {
		return err
	}
	rep.note("%s The secret itself was not printed, logged, or written anywhere else.",
		adoptedNote(p.app, dest))
	return nil
}

// adoptedNote says what was written and where each half came from.
//
// Per key, because the two halves are not always in the same file: the sentence
// this replaced reported a copy "from <stateDir>/.env into <stateDir>/.env"
// while the secret it had just written came from the repository .env.
func adoptedNote(c candidate, dest string) string {
	switch {
	case c.SecretPath != "" && c.SecretPath != c.Path:
		return fmt.Sprintf("Wrote the complete pair for app %s into %s (mode 0600): the app id as named in %s, "+
			"and the secret from %s.", c.AppID, dest, c.Path, c.SecretPath)
	case c.Path == dest:
		// Same guard as adoptSentence, for the same reason: the branch below
		// would report a copy out of the destination and into itself.
		return fmt.Sprintf("Wrote the pair for app %s into %s (mode 0600), the file that already named it.",
			c.AppID, dest)
	default:
		return fmt.Sprintf("Copied the credentials for app %s from %s into %s (mode 0600).", c.AppID, c.Path, dest)
	}
}

// ensureStateDir makes sure the state directory exists and can be written
// BEFORE anything creates an app.
//
// Feishu shows an app secret exactly once and offers no deletion API for apps
// created this way, so discovering an unwritable directory after registration
// means a permanent app whose only secret has already been lost. The probe is
// worth the syscalls.
func ensureStateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("setup: create the state directory %s: %w", dir, err)
	}
	f, err := os.CreateTemp(dir, ".setup-writable-*")
	if err != nil {
		return fmt.Errorf("setup: %s is not writable, and an app secret Feishu shows only once would have "+
			"nowhere to go: %w", dir, err)
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return nil
}
