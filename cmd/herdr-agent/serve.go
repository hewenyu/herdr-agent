package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"

	"github.com/hewenyu/herdr-agent/internal/agents"
	"github.com/hewenyu/herdr-agent/internal/assistant"
	"github.com/hewenyu/herdr-agent/internal/bridge"
	"github.com/hewenyu/herdr-agent/internal/config"
	"github.com/hewenyu/herdr-agent/internal/dedup"
	"github.com/hewenyu/herdr-agent/internal/herdrapi"
	"github.com/hewenyu/herdr-agent/internal/lark"
	"github.com/hewenyu/herdr-agent/internal/mirror"
	"github.com/hewenyu/herdr-agent/internal/projects"
	"github.com/hewenyu/herdr-agent/internal/projectweb"
	"github.com/hewenyu/herdr-agent/internal/routes"
	"github.com/hewenyu/herdr-agent/internal/selection"
	"github.com/hewenyu/herdr-agent/internal/tasks"
	"github.com/hewenyu/herdr-agent/internal/tasktools"
)

// State files serve owns, all inside the state directory alongside
// herdr-agent.pid. Both stores write mode 0600 into a 0700 directory (S2 §3.1):
// reaching either is reaching the herdr socket, which is shell access (G10).
const (
	dedupFileName  = "dedup.json"
	routesFileName = "routes.json"
	// selectionFileName holds which agent each chat is currently talking to. It
	// sits next to routes.json because it is the same kind of state — where a
	// message goes — and it must survive a restart for the same reason: the
	// bridge is killed and restarted routinely (S2 §3.1), and a user mid
	// conversation with one agent should not have to re-aim afterwards.
	selectionFileName = "selection.json"
)

// cmdServe runs the Feishu bridge until a signal arrives.
//
// The body is deliberately thin. Everything that can go wrong at startup
// happens in buildServe, which takes its collaborators through serveHooks so
// that the whole sequence — including the one ordering rule that matters, the
// single-instance lock before any network IO (G15) — is driven by a test
// without a unix socket, a Feishu app, or a signal.
func cmdServe(ctx context.Context, d *deps, args []string) error {
	fs := newFlags(d, "serve", "")
	configListen := fs.String("config-listen", configurationAddress(d.Cfg), "local project configuration address (overrides ui.config_listen; loopback IP only)")
	noConfigUI := fs.Bool("no-config-ui", false, "disable the local project configuration page")
	if err := parseFlags(fs, args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return usagef("serve takes no arguments, got %q", fs.Arg(0))
	}

	log := newServeLogger(d.Err)
	// bridge, mirror, notify and the Feishu SDK wrapper all read slog.Default()
	// when they are CONSTRUCTED, and none of them takes a logger through the
	// frozen contracts, so the swap has to happen before buildServe rather than
	// before run. Restoring afterwards keeps `serve` from redirecting the logs
	// of a process that also does something else — in practice a test.
	restore := setDefaultLogger(log)
	defer restore()

	hooks := defaultServeHooks()
	if !*noConfigUI {
		hooks.configListen = *configListen
	}
	s, err := buildServe(ctx, d, log, hooks)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer func() {
		if err := s.shutdown(); err != nil {
			// Reported, never returned: by the time this runs the exit code has
			// already been decided by run(), and a failed flush must not turn a
			// clean Ctrl-C into a non-zero exit that launchd reads as a crash.
			log.Error("serve: shutdown was not clean", "err", err)
		}
	}()
	return s.run(ctx)
}

// serveDeps is the running bridge: everything built, in the order it was built,
// with the closers needed to take it down again.
type serveDeps struct {
	log           *slog.Logger
	stateDir      string
	projects      *projects.Catalog
	configuration *serveConfiguration

	lock      instanceLock
	dedup     *dedup.FileStore
	routes    *routes.FileStore
	selection *selection.FileStore
	registry  agents.Registry
	watcher   mirror.Watcher
	bot       lark.Bot
	bridge    bridge.Bridge

	// transitions is a registry subscription used only to honour
	// mirror.default_on. It is nil when the knob is off, and nothing else may
	// read it: a second reader would steal half the transitions.
	transitions <-chan agents.Transition

	// closers are released last-in-first-out, so the stores are flushed while
	// the single-instance lock is still held.
	closers []serveCloser
}

// serveCloser is one shutdown step. The name is what an operator reads when it
// fails, so it names the thing, not the function.
type serveCloser struct {
	name  string
	close func() error
}

// instanceLock is the part of bridge.InstanceLock that serve uses. It is an
// interface so a test can prove the lock is taken before the bot connects
// without putting a real pid file in the way of the assertion.
type instanceLock interface {
	Path() string
	Release() error
}

// serveHooks are the seams of the startup sequence.
//
// Collaborators that touch a socket, a pid file or a Feishu app are behind
// hooks. Everything else — config, the stores, the
// registry, the doctor checks — runs for real in tests, because running it for
// real is the only way the wiring is actually tested.
type serveHooks struct {
	configListen string
	authorize    func(context.Context, string, config.Config, func(projectweb.AuthorizationStatus)) (config.Config, error)
	lock         func(dir string, log *slog.Logger) (instanceLock, error)
	newWatcher   func(r mirror.PathResolver, log *slog.Logger) (mirror.Watcher, error)
	newBot       func(cfg config.Config, log *slog.Logger) (lark.Bot, error)
	// newBridge takes the optional dependencies as well as Deps: bridge.Deps is
	// frozen by contract and the selection store arrived after it, so it travels
	// as an Option (bridge.NewWith).
	newBridge func(d bridge.Deps, opts ...bridge.Option) (bridge.Bridge, error)
}

func defaultServeHooks() serveHooks {
	return serveHooks{
		authorize: ensureServeAuthorization,
		lock: func(dir string, log *slog.Logger) (instanceLock, error) {
			l, err := bridge.AcquireInstanceLock(dir, bridge.WithLockLogger(log))
			if err != nil {
				// Returning l here would put a typed nil in the interface, and
				// the caller's `if lock != nil` would then be true.
				return nil, err
			}
			return l, nil
		},
		newWatcher: func(r mirror.PathResolver, log *slog.Logger) (mirror.Watcher, error) {
			return mirror.NewWatcher(r, mirror.WithLogger(log))
		},
		newBot: func(cfg config.Config, log *slog.Logger) (lark.Bot, error) {
			return lark.New(cfg.Feishu.AppID, cfg.Feishu.AppSecret, lark.WithLogger(log), lark.WithTaskChats(cfg.Tasks.Enabled))
		},
		newBridge: bridge.NewWith,
	}
}

// buildServe assembles the bridge. The order below is the specification.
//
//  1. state directory and configuration — a bridge with no allowlist is a
//     bridge that hands shell access to whoever finds the bot (G10);
//  2. the single-instance lock, BEFORE anything reaches a network. Feishu's long
//     connection is a cluster — up to 50 connections per app, each event dealt
//     to a randomly chosen one (G15) — so a second instance neither errors nor
//     disconnects anybody: the two split the user's events, invisibly from both
//     ends, and the user calls it "Feishu is flaky". It has to die before it
//     connects, because afterwards nothing reveals it;
//  3. the local page and Feishu permission check; any required login finishes
//     before constructing the bot with the current credentials;
//  4. the herdr startup checks, then state, agent plumbing, the bot and bridge.
//     A machine with no herdr never opens the Feishu WebSocket.
//
// Every failure after step 2 unwinds what has already been built, so a bridge
// that refuses to start does not leave its pid file behind for the next one to
// take over.
func buildServe(ctx context.Context, d *deps, log *slog.Logger, h serveHooks) (*serveDeps, error) {
	if d.StateDir == "" {
		return nil, &startupError{step: "state directory", err: errors.New(
			"no state directory: pass -state-dir, or set HOME so that ~/" + config.StateDir + " can be found")}
	}
	cfg := d.Cfg
	s := &serveDeps{log: log, stateDir: d.StateDir}
	catalog, err := projects.Open(d.StateDir, cfg.Tasks)
	if err != nil {
		return nil, &startupError{step: "project configuration", err: err}
	}
	s.projects = catalog
	cfg.Tasks = catalog.Snapshot()

	// Logged BEFORE Validate, so that a configuration which is about to be
	// rejected is still visible in the log next to the reason. Redacted() is
	// the only rendering that may be logged: the app secret must never appear,
	// not as a prefix and not as a length (S2 §3.1).
	log.Info("serve: starting", "state_dir", d.StateDir, "config", cfg.Redacted())

	if err := validateServeConfiguration(cfg, h.authorize != nil); err != nil {
		return nil, &startupError{step: "configuration", err: err}
	}
	if d.Resolver == nil {
		// bridge.New rejects a nil Resolver, and the only way to get one here is
		// a machine with no home directory, which is worth saying plainly.
		return nil, &startupError{step: "transcript resolver", err: errors.New(
			"no home directory, so no agent transcript can be located")}
	}

	lock, err := h.lock(d.StateDir, log)
	if err != nil {
		return nil, &startupError{step: "single-instance lock", err: err}
	}
	s.lock = lock
	s.push("single-instance lock", lock.Release)
	log.Info("serve: single-instance lock held", "path", lock.Path())
	// A standalone configure process may have saved and exited between the
	// initial validation and our lock acquisition. Take the authoritative
	// snapshot under the lock before wiring shared runtime dependencies.
	catalog, err = projects.Open(d.StateDir, cfg.Tasks)
	if err != nil {
		return nil, s.abort(&startupError{step: "project configuration", err: err})
	}
	s.projects = catalog
	cfg.Tasks = catalog.Snapshot()
	if err := validateServeConfiguration(cfg, h.authorize != nil); err != nil {
		return nil, s.abort(&startupError{step: "configuration", err: err})
	}

	status := newServeAuthorizationState(h.authorize != nil)
	startupCtx := ctx
	if h.configListen != "" {
		if err := s.startConfiguration(ctx, h.configListen, status.snapshot); err != nil {
			return nil, s.abort(&startupError{step: "local project configuration", err: fmt.Errorf(
				"%w; change [ui].config_listen in %s to a free loopback port and restart, or use serve --config-listen / --no-config-ui",
				err, filepath.Join(d.StateDir, config.ConfigFileName))})
		}
		startupCtx = s.configuration.ctx
	}
	if h.authorize != nil {
		cfg, err = h.authorize(startupCtx, d.StateDir, cfg, s.authorizationReporter(status, d.OpenURL))
		if err != nil {
			if s.configuration != nil && s.configuration.failure() != nil {
				err = s.configuration.failure()
			}
			return nil, s.abort(&startupError{step: "feishu authorization", err: err})
		}
		// Configuration can be edited while the user follows the login link.
		cfg.Tasks = catalog.Snapshot()
		if err := cfg.Validate(); err != nil {
			return nil, s.abort(&startupError{step: "configuration", err: err})
		}
	}

	if err := checkStartup(ctx, d, log); err != nil {
		return nil, s.abort(err)
	}

	if s.dedup, err = dedup.Open(filepath.Join(d.StateDir, dedupFileName)); err != nil {
		return nil, s.abort(&startupError{step: "dedup store", err: err})
	}
	s.push("dedup store", s.dedup.Close)
	warnStoreLoad(log, dedupFileName, s.dedup.LoadWarning(),
		"a redelivered Feishu event would be acted on a second time (G14)")

	rts, err := routes.OpenWith(filepath.Join(d.StateDir, routesFileName))
	if err != nil {
		return nil, s.abort(&startupError{step: "routes store", err: err})
	}
	s.routes = rts
	s.push("routes store", rts.Close)
	warnStoreLoad(log, routesFileName, rts.LoadWarning(),
		"replying to an older message will no longer route to its agent")

	sel, err := selection.OpenWith(filepath.Join(d.StateDir, selectionFileName))
	if err != nil {
		return nil, s.abort(&startupError{step: "selection store", err: err})
	}
	s.selection = sel
	s.push("selection store", sel.Close)
	warnStoreLoad(log, selectionFileName, sel.LoadWarning(),
		"the next plain message in each chat lands on the picker card instead of the agent it was aimed at")

	if d.NewRegistry == nil {
		// Every other dependency is an interface that bridge.New reports as a
		// missing dep; this one is a func, and calling it would panic instead.
		return nil, s.abort(&startupError{step: "agent registry", err: errors.New("no registry factory was wired")})
	}
	if s.registry, err = d.NewRegistry(d.PollInterval); err != nil {
		return nil, s.abort(&startupError{step: "agent registry", err: err})
	}
	if cfg.Mirror.DefaultOn {
		// Own this subscription before launching mirror workers. Subscribe
		// also replays the current snapshot if the registry is already live.
		s.transitions = s.registry.Subscribe()
	}

	paths, err := bridge.NewPathResolver(s.registry, d.Resolver)
	if err != nil {
		return nil, s.abort(&startupError{step: "transcript path resolver", err: err})
	}
	if s.watcher, err = h.newWatcher(paths, log); err != nil {
		return nil, s.abort(&startupError{step: "transcript mirror", err: err})
	}

	// Permission checks and any credential refresh have finished under the
	// instance lock. The one WebSocket connection starts later in bridge.Run.
	if s.bot, err = h.newBot(cfg, log); err != nil {
		return nil, s.abort(&startupError{step: "feishu bot", err: err})
	}

	bridgeOpts := []bridge.Option{bridge.WithSelection(sel), bridge.WithNotifyCooldown(cfg.UI.NotifyCooldown)}
	if cfg.Tasks.Enabled {
		platform, ok := s.bot.(tasks.Platform)
		if !ok {
			return nil, s.abort(&startupError{step: "tasks", err: errors.New("bot does not support task management")})
		}
		lifecycle, ok := d.Client.(herdrapi.LifecycleClient)
		if !ok {
			return nil, s.abort(&startupError{step: "tasks", err: errors.New("herdr client does not support managed task sessions")})
		}
		store, err := tasks.Open(filepath.Join(d.StateDir, "tasks.json"))
		if err != nil {
			return nil, s.abort(&startupError{step: "task state", err: err})
		}
		manager, err := tasks.New(store, tasks.Options{
			Config: cfg.Tasks, Projects: catalog, Platform: platform, Client: d.Client, Lifecycle: lifecycle,
			PrepareProject: projects.EnsureRepository,
			AllowedOwner: func(owner string) bool {
				for _, allowed := range cfg.Feishu.AllowedOpenIDs {
					if strings.TrimSpace(allowed) == owner {
						return true
					}
				}
				return false
			},
			Report: func(ctx context.Context, r tasks.Record) error {
				chat := taskNotificationChat(r)
				if chat == "" {
					return nil
				}
				_, err := s.bot.Send(ctx, lark.Out{ChatID: chat, Text: tasks.Notice(r)})
				return err
			},
			BeforeClose: func(ctx context.Context, r tasks.Record) error {
				if r.ChatID == "" || r.ChatDeleted {
					return nil
				}
				_, err := s.bot.Send(ctx, lark.Out{ChatID: r.ChatID, Text: taskClosingMessage(r)})
				return err
			},
			Controller: d.Controller, Registry: s.registry,
			Follow: func(pane string) error {
				if s.watcher.Enabled(pane) {
					return nil
				}
				return s.watcher.Enable(pane)
			},
			Announce: func(ctx context.Context, r tasks.Record) error {
				return announceTaskGroup(ctx, s.bot, log, r)
			},
		})
		if err != nil {
			return nil, s.abort(&startupError{step: "task manager", err: err})
		}
		bridgeOpts = append(bridgeOpts, bridge.WithTasks(manager))
		if cfg.AI.Enabled {
			engine, err := assistant.NewEngine(cfg.AI)
			if err != nil {
				return nil, s.abort(&startupError{step: "AI model", err: err})
			}
			toolBackend, err := tasktools.New(tasktools.Options{
				OwnerID:   strings.TrimSpace(cfg.Feishu.AllowedOpenIDs[0]),
				StatePath: filepath.Join(d.StateDir, "assistant-operations.json"),
				Config:    cfg.Tasks, Projects: catalog, Manager: manager, Registry: s.registry, Controller: d.Controller,
			})
			if err != nil {
				return nil, s.abort(&startupError{step: "AI task tools", err: err})
			}
			ai, err := assistant.New(engine, toolBackend, filepath.Join(d.StateDir, "conversations"), cfg.AI.Timeout)
			if err != nil {
				return nil, s.abort(&startupError{step: "AI conversations", err: err})
			}
			bridgeOpts = append(bridgeOpts, bridge.WithAssistant(ai))
		}
	}
	s.bridge, err = h.newBridge(bridge.Deps{
		Bot:            s.bot,
		Registry:       s.registry,
		Controller:     d.Controller,
		Extractor:      d.Extractor,
		Resolver:       d.Resolver,
		Dedup:          s.dedup,
		Routes:         rts,
		Watcher:        s.watcher,
		AllowedOpenIDs: cfg.Feishu.AllowedOpenIDs,
		NotifyChatID:   cfg.Feishu.NotifyChatID,
		MaxCols:        cfg.UI.MaxCols,
		TailLines:      cfg.UI.TailLines,
		QueueLimit:     cfg.UI.QueueLimit,
		Now:            d.now,
	},
		// Without this the bridge still routes — reply-to, then the single agent
		// — but plain typing stops reaching an agent, which is the whole
		// card-first interaction: typing is the cheapest thing a phone can do.
		bridgeOpts...)
	if err != nil {
		return nil, s.abort(&startupError{step: "bridge", err: err})
	}

	return s, nil
}

// Keep task activity in its group. The entry chat only receives pre-group
// failures; successful group creation has its own one-time entry receipt.
func taskNotificationChat(r tasks.Record) string {
	return tasks.NotificationChat(r)
}

func announceTaskGroup(ctx context.Context, bot lark.Bot, log *slog.Logger, r tasks.Record) error {
	if r.ChatID != "" && !r.ChatDeleted {
		if _, err := bot.Send(ctx, lark.Out{ChatID: r.ChatID, Text: taskWelcomeMessage(r)}); err != nil {
			return err
		}
	}
	if r.EntryChatID != "" && r.EntryChatID != r.ChatID {
		_, err := bot.Send(ctx, lark.Out{ChatID: r.EntryChatID, Text: fmt.Sprintf("任务群已建立：%s\n进入任务群：%s\n后续需求、进度和验收请直接在群内沟通。", r.Project, tasks.ChatURL(r.ChatID))})
		if err != nil {
			// The group already received its welcome. An entry-chat receipt
			// must not stall launch or repeat the welcome on every poll.
			log.Warn("tasks: entry chat announcement failed; continuing in task group", "task", r.ID)
		}
	}
	return nil
}

func taskWelcomeMessage(r tasks.Record) string {
	return fmt.Sprintf("本群对应任务：%s\n项目：%s · %s\n飞书任务：%s\n\n请直接在本群补充要求、反馈问题或问“现在进度如何”，无需 @ 机器人。执行进展会发到本群。\n\n%s\n验收通过并确认关闭后，会同步任务完成、保存结果，再关闭执行会话并解散本群；代码和飞书任务保留。若只想标记完成，请说明“保留群”。", r.Title, r.Project, r.Agent, r.URL, tasks.GroupCloseHint)
}

func taskClosingMessage(r tasks.Record) string {
	status := "已保存当前结果，正在关闭执行会话。"
	if r.CloseRequested {
		status = "已确认飞书任务完成并保存结果，正在结单。"
	}
	return fmt.Sprintf("%s\n任务：%s\n飞书任务及结果：%s\n代码保留在项目目录。本群将在数秒后解散，群聊天记录不会保留。", status, r.Title, r.URL)
}

// checkStartup runs the doctor checks and refuses to continue for exactly two
// of them: herdr not answering, and herdr answering with a protocol this build
// cannot decode.
//
// Everything else is a warning on purpose. A missing codex hook, an unpinned
// detection manifest or a 53-column pane all degrade the product without
// stopping it, and a bridge that refuses to start is a phone that cannot reach
// any agent — strictly worse than a bridge that starts and says what is wrong.
//
// The two fatal ones are different in kind:
//
//   - a dead herdr leaves nothing to bridge. The bridge never starts herdr
//     itself (S1 §2), and connecting to Feishu anyway would put a connection into
//     this app's pool that gets dealt a random share of the user's messages (G15)
//     with no agent to route any of them to. Staying off the socket at least
//     leaves Feishu holding them for redelivery (G14).
//   - a server below protocol 19 is worse than a dead one, because it looks
//     alive. S1 §3.1 requires the ping at startup and a refusal below 19,
//     printing the version actually found: the wire types here were measured
//     against protocol 19, an older server answers with fields that are not
//     there, and herdr's own failure mode for an unmatched agent is to report
//     idle rather than unknown (G11). The bridge would run, show every agent as
//     idle, and simply stop pushing the cards that say a human is needed — with
//     no error anywhere. That is precisely the fail-silent mode the spec wanted
//     gated at startup, so it is gated here rather than discovered in an empty
//     chat.
func checkStartup(ctx context.Context, d *deps, log *slog.Logger) error {
	checks, probe := d.runChecks(ctx)
	socket := orDash(herdrapi.SocketPathOf(d.Client))
	switch {
	case !probe.reachable:
		return &startupError{step: "herdr", err: fmt.Errorf(
			"%w at %s: start it from a CLEAN environment first, because its variables are inherited by "+
				"every pane it creates (G7): %s",
			herdrapi.ErrServerUnavailable, socket, cleanServerStart)}

	case errors.Is(probe.err, herdrapi.ErrProtocolTooOld):
		return &startupError{step: "herdr", err: fmt.Errorf(
			"%w: herdr %s at %s speaks protocol %d, this bridge needs %d or newer (S1 §3.1). "+
				"An older server does not fail loudly: it answers with fields these decoders do not find, "+
				"every agent degrades to idle (G11), and the cards that say an agent is waiting for you "+
				"simply stop arriving. Upgrade herdr, then: %s",
			herdrapi.ErrProtocolTooOld, orDash(probe.res.Version), socket,
			probe.res.Protocol, herdrapi.MinProtocol, cleanServerStart)}
	}

	counts := map[checkStatus]int{}
	for _, c := range checks {
		counts[c.status]++
		if c.status == checkPass {
			continue
		}
		args := []any{"check", c.name, "status", string(c.status), "detail", strings.Join(c.detail, "; ")}
		if len(c.fix) > 0 {
			args = append(args, "fix", strings.Join(c.fix, "; "))
		}
		// FAIL is a warning here and an exit code in `doctor`: the two commands
		// answer different questions. doctor is asked "is this machine right?";
		// serve is asked "keep my phone connected to whatever is left".
		if c.status == checkUnknown {
			log.Info("serve: startup check could not be evaluated", args...)
			continue
		}
		log.Warn("serve: startup check did not pass; the bridge starts anyway", args...)
	}
	log.Info("serve: startup checks complete",
		"pass", counts[checkPass], "warn", counts[checkWarn],
		"unknown", counts[checkUnknown], "fail", counts[checkFail],
		"detail", "run `herdr-agent doctor` for the full report")
	return nil
}

// serveTask is one supervised goroutine.
type serveTask struct {
	name string
	run  func(context.Context) error
}

// errStoppedEarly is what a supervised task returning nil before shutdown
// means: it had no reason to stop and stopped anyway.
var errStoppedEarly = errors.New("stopped on its own")

// run supervises the two long-lived loops that ARE the product under one
// context, and returns when the first of them ends.
//
// They are peers, not a hierarchy: the registry feeds the notifier that the
// bridge owns, and the bridge answers the phone. Either one stopping leaves a
// product that looks alive and is not — a bridge with no registry pushes
// nothing and reports nothing — so the first to leave takes the other with it
// and the process exits non-zero for launchd to restart.
//
// The transcript mirror runs alongside them and is deliberately NOT supervised:
// see startMirror.
//
// A cancelled parent context is the ONE clean ending: SIGINT and SIGTERM arrive
// that way (see cli), every task unwinds, and run returns nil so the exit code
// is 0.
func (s *serveDeps) run(ctx context.Context) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Goroutine scheduling does not establish consumer/producer ordering.
	// Registry.Subscribe atomically replays its current snapshot, so a
	// notifier starting after the first poll still sees existing blocked agents.
	tasks := []serveTask{
		{"feishu bridge", s.bridge.Run},
		{"agent registry", s.registry.Run},
	}
	if s.configuration != nil {
		tasks = append(tasks, serveTask{"local project configuration", s.configuration.run})
	}

	// Buffered for every task, so a goroutine reporting its exit never blocks
	// on a receiver that has already gone.
	failed := make(chan error, len(tasks))
	var wg sync.WaitGroup

	for _, t := range tasks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Whoever leaves first ends the rest.
			defer cancel()

			err := t.run(runCtx)
			if ctx.Err() != nil {
				// A signal. Every task is expected to return now, and their
				// context errors say nothing an operator needs.
				return
			}
			if err == nil {
				failed <- fmt.Errorf("%s %w", t.name, errStoppedEarly)
				return
			}
			failed <- fmt.Errorf("%s: %w", t.name, err)
		}()
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		s.startMirror(runCtx)
	}()

	if s.transitions != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Not supervised, for the same reason as startMirror: mirroring is
			// the cosmetic half of the product and must never take the half that
			// answers permission dialogs down with it (S2 §8).
			s.enableMirrorsByDefault(runCtx)
		}()
	}

	s.log.Info("serve: running", "pid_file", s.lock.Path())
	wg.Wait()
	close(failed)

	// The first value is from the first task to end abnormally, which is the
	// cause; anything after it is that task's cancellation reaching the others.
	// A closed empty channel yields nil, which is the clean shutdown.
	if err := <-failed; err != nil {
		return fmt.Errorf("serve: %w", err)
	}
	s.log.Info("serve: shutting down")
	return nil
}

// startMirror runs the transcript watcher for as long as the bridge lives,
// outside the supervised set.
//
// This is the one asymmetry in run(), and it is the point rather than an
// oversight. The mirror is the cosmetic half of the product: it turns an
// agent's own transcript into a readable conversation. The other half answers
// permission dialogs, and a dialog left unanswered is a machine sitting idle
// waiting for a human who was never told (G1, G11). S2 §8 states the rule
// outright — a broken mirror must not affect taking over an agent — so a
// watcher that stops takes nothing with it: no cancel, and the process keeps
// its exit code.
//
// Today mirror.Watcher.Run only ends with its context or on a second Run, so
// this cannot fire; it is here so that a future failure inside the watcher
// cannot quietly become a bridge outage.
func (s *serveDeps) startMirror(ctx context.Context) {
	err := s.watcher.Run(ctx)
	if err == nil || ctx.Err() != nil {
		return
	}
	s.log.Error("serve: the transcript mirror stopped; agent transcripts are no longer mirrored. "+
		"The bridge keeps running: cards, commands and replies are unaffected (S2 §8)", "err", err)
}

// enableMirrorsByDefault honours mirror.default_on.
//
// It lives here rather than in the bridge because serve owns the Watcher and
// the bridge only ever reacts to an explicit /mirror command. Only the FIRST
// sighting of a pane enables it: re-enabling on every transition would undo a
// /mirror <pane> off a second after the user asked for it.
func (s *serveDeps) enableMirrorsByDefault(ctx context.Context) {
	seen := map[string]bool{}
	for {
		select {
		case <-ctx.Done():
			return
		case t, ok := <-s.transitions:
			if !ok {
				// The registry stopped and closed its subscriptions; run() is
				// already unwinding for the same reason.
				return
			}
			pane := t.Agent.PaneID
			if pane == "" {
				continue
			}
			if t.To == agents.StatusGone {
				// A pane that comes back is a different conversation, so forget
				// it and let the next sighting enable mirroring afresh.
				delete(seen, pane)
				s.watcher.Disable(pane)
				continue
			}
			if seen[pane] {
				continue
			}
			seen[pane] = true
			if err := s.watcher.Enable(pane); err != nil {
				s.log.Warn("serve: mirror.default_on could not follow this agent",
					"pane", pane, "err", err)
			}
		}
	}
}

// shutdown releases everything serve built, newest first, and is idempotent.
//
// The order is what makes it correct: the stores are flushed while the
// single-instance lock is still held, so a bridge starting the instant this one
// exits cannot read a half-written dedup file — and a lost dedup entry is a
// Feishu redelivery re-injected into a live agent (G14).
func (s *serveDeps) shutdown() error {
	if len(s.closers) == 0 {
		return nil
	}
	closers := s.closers
	s.closers = nil

	var errs []error
	for i := len(closers) - 1; i >= 0; i-- {
		if err := closers[i].close(); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", closers[i].name, err))
		}
	}
	return errors.Join(errs...)
}

func (s *serveDeps) push(name string, release func() error) {
	s.closers = append(s.closers, serveCloser{name: name, close: release})
}

// abort unwinds a partially built bridge and returns the failure that caused
// it. The unwind error is logged rather than joined: the operator needs the one
// line that says why the bridge would not start, not a second one about tidying
// up afterwards.
func (s *serveDeps) abort(cause error) error {
	if err := s.shutdown(); err != nil {
		s.log.Error("serve: could not unwind after a failed start", "err", err)
	}
	return cause
}

// warnStoreLoad reports a state file that was discarded at open.
//
// Both stores treat a corrupt file as empty rather than refusing to boot, which
// is the right trade — but a store that silently reset is a promise the bridge
// has stopped keeping, so it has to be said out loud.
func warnStoreLoad(log *slog.Logger, file string, err error, consequence string) {
	if err == nil {
		return
	}
	log.Warn("serve: state file was discarded and starts empty",
		"file", file, "err", err, "consequence", consequence)
}

// startupError is a startup failure rendered as exactly ONE line.
//
// config.Validate reports every problem at once through errors.Join, which is
// newline-separated; printed straight to stderr under launchd that becomes a
// paragraph in a log nobody reads. The wrapped error is preserved, so errors.Is
// still works.
type startupError struct {
	step string
	err  error
}

func (e *startupError) Error() string {
	return "serve: " + e.step + ": " + oneLine(e.err.Error())
}

func (e *startupError) Unwrap() error { return e.err }

func oneLine(s string) string {
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '\n' || r == '\r' })
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, "; ")
}

// newServeLogger writes structured lines to w, which is stderr in production
// and the file launchd redirects it into.
func newServeLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo}))
}

// setDefaultLogger installs l as the process logger and returns the undo.
func setDefaultLogger(l *slog.Logger) func() {
	prev := slog.Default()
	slog.SetDefault(l)
	return func() { slog.SetDefault(prev) }
}
