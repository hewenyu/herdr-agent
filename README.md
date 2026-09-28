# myrix

[中文说明](README.zh-CN.md) · [npm](https://www.npmjs.com/package/@yuebanlaosiji/myrix) · [Releases](https://github.com/hewenyu/herdr-agent/releases)

A local orchestration tool built with **Node, TypeScript and pi**, distributed as **@yuebanlaosiji/myrix**. Start projects, arrange requirements discussions and development tasks, and follow progress in Feishu. The local Web interface provides project and model configuration and conversation history.

**pi manages this tool's projects, tasks, participants and sessions. herdr hosts Claude/Codex and their native sessions.** Claude/Codex handle your project's requirements, design, implementation, tests and reviews; myrix can also run explicitly configured local verification commands. You can bring both into one task group, run multiple instances, and create independent tasks for different projects.

With AI enabled, entry routing follows **rules → Jev → LLM**. Rules enforce identity, scope, duplicate receipts and the exact `/clear` command. Private-message Jev classification is independently opt-in and defaults off; ordinary text then follows the original pi conversation and tool path. When enabled, Jev only chooses intent and a registered project; a confident, complete request can create a task using unchanged original requirements and fixed template defaults. Other requests go to pi. Business completion claims still require actual operation evidence; a text-only acknowledgement cannot finish an explicit action request. Lifecycle notices use read-only task facts.

The frontend, backend, Node runtime and native locking addon are bundled into one executable. The executable, version output, runtime messages and service names use `myrix`. The GitHub repository keeps its existing URL. Fresh installations use `~/.myrix`; an existing `~/.herdr-agent` directory is reused in place so upgrades retain configuration and conversations.

With tasks and AI enabled and a Jev key configured, new tasks default to `orchestration.mode = "workflow"` unless a mode is explicitly selected. pi plans the work; rules and Jev select legal actions; failed or low-confidence Jev choices fall back to pi with only `orchestration_decide` over the same candidate set. Each decision retains its rule result, Jev distribution and adopted source. Existing `model`, `manual` and `round_robin` tasks keep their mode; without a key, creation keeps its previous defaults. Reports collect participant results and verification sources; delivery still awaits user acceptance. See the [current design](docs/myrix-jev-llm-orchestration-design.md) and [historical orchestration audit](docs/ai-orchestration-audit-2026-09-25.md).

## Install

The Node/pi rewrite starts at **v0.3.0**. Supported release targets are macOS arm64, Linux x64 and Linux arm64. npm users need Node >=18 for the launcher; the standalone executable embeds Node.

```sh
npm install -g @yuebanlaosiji/myrix
myrix version --json
myrix help
```

npm automatically selects the matching native dependency: `@yuebanlaosiji/myrix-darwin-arm64`, `@yuebanlaosiji/myrix-linux-x64` or `@yuebanlaosiji/myrix-linux-arm64`. Keep optional dependencies enabled. These platform packages supply the executable; **@yuebanlaosiji/myrix is the user-facing package**. Installation has no postinstall download or build. npm exposes both `myrix` and the compatible `herdr-agent` command.

List available versions, install a specific version, or upgrade to the stable release:

```sh
npm view @yuebanlaosiji/myrix versions --json
npm install -g @yuebanlaosiji/myrix@0.3.12
npm install -g @yuebanlaosiji/myrix@latest
```

For an installation without Node, download and extract the matching archive from [Releases](https://github.com/hewenyu/herdr-agent/releases), verify it against the attached `SHA256SUMS`, then run the included executable:

```sh
./myrix version --json
./myrix setup
./myrix serve
```

Read the setup section before starting task orchestration. Both installation methods require herdr, Git and the selected authenticated Claude/Codex CLI. Linux also requires compatible system libraries. macOS archives have an ad-hoc signature, without notarization; platform requirements and checksum commands are included in the release notes.

## Release and acceptance status

See [Releases](https://github.com/hewenyu/herdr-agent/releases/latest) for the latest stable build and use `myrix version --json` to inspect the version, source commit and build time of your installation. This README describes the current source; consult a release's notes for changes included in that version. The root `package.json` is a private source package, not the published npm entry package.

A pushed `v*` tag triggers three native builds and smoke tests, verifies the complete npm distribution with an offline global install, publishes the platform packages and then the entry package, and creates the GitHub Release. Publishing uses `TOKEN` from the GitHub environment `NPM`. Artifact downloads inside Actions are only an internal assembly step; users install `@yuebanlaosiji/myrix` from npm or download a release archive, without selecting a workflow download. See [release operations](docs/releasing.md) for versioning and recovery.

Full live acceptance remains **partial and in progress**. [The validation matrix](docs/live-validation.md) separates implementation, automated tests and real Feishu/herdr evidence. [E32](docs/live-evidence-e32-manual-discussion.md) covers manual Claude/Codex discussion and cleanup; [E34](docs/live-evidence-e34-runtime-recovery.md) covers user approval, participant output, cleanup and recovery from an explicitly failed task ID within the same turn. Historical failures remain recorded, including [E33](docs/live-evidence-e33-n02-codex.md). [E35](docs/live-evidence-e35-destroy-notices.md) verified both cleanup notices and resource deletion for an explicitly cancelled task, while its remote task stayed incomplete. [E36](docs/live-evidence-e36-completion-notices.md) also verified completion-path notices and cleanup. Its creation-reply rejection was subsequently fixed and passed the limited creation-to-cleanup recheck in [E37](docs/live-evidence-e37-create-delivery.md). These are limited checks; overall acceptance remains partial.

A locally accepted or queued task does not prove that the remote task or group exists, or that instructions reached a participant. Replies must follow confirmed tool receipts. Release versions and the local development binary can differ; use `myrix version --json` when comparing behavior.

## Build and run

Building requires **Node >=24.13**, npm, Python and a C++/make toolchain for `fs-ext`. macOS needs Command Line Tools. Runtime prerequisites are herdr, the selected authenticated Claude/Codex CLI, Git and compatible system C++ libraries.

```sh
npm ci
npm run check
npm run build
npm run binary
npm run smoke
./dist/myrix version --json
```

`check` runs the 1000-line-per-file limit, strict TypeScript, Biome formatting/lint and tests. `build` produces `dist/myrix.cjs` with embedded Web assets. `binary` rebuilds the application and uses Node SEA to produce `dist/myrix`, including the Node runtime and native flock extension. The standalone executable needs neither an external Node installation nor `node_modules` or separate frontend files; the npm launcher still requires Node >=18.

Build natively for each target: macOS arm64, Linux x64 and Linux arm64. A macOS executable is not a Linux executable. `smoke` copies only the binary to a fresh temporary directory and verifies help, version, native locking, SQLite, embedded Web resources, history browsing, protected configuration writes and rejection of Web business writes. Isolated Feishu adapter events are queued before startup; the copied SEA executes the bundled pi loop against local Responses and Anthropic protocol fixtures. Reading history never acknowledges delivery; without a Feishu connection, the reply remains undelivered. This is packaging coverage, with no real Feishu, herdr or model service. Current platform evidence is recorded in [acceptance](docs/acceptance.md); macOS ad-hoc signing is not notarization.

For source development: `npm run dev -- help`. Use the built program to verify embedded Web assets. The examples below use the npm command `myrix`; for a source build, substitute `./dist/myrix`.

## Setup

Copy [config.example.toml](deploy/config.example.toml) to the selected state directory as `config.toml`, mode 0600 (`~/.myrix` on a fresh installation; existing `~/.herdr-agent` takes precedence). Enable `tasks.enabled` before setup if you want task/group permissions, then run:

```sh
myrix setup
myrix serve --open
```

Setup reuses an existing app when possible, saves credentials and the verified owner, and requires both a private message and the matching card callback for complete verification. Stop serve before running setup. Use `setup --app cli_EXISTING_APP` to resolve an ambiguous app and `setup --update-permissions` to grant required scopes. Creating a replacement app requires `setup --reregister --yes`.

For existing apps with tasks enabled, configure event subscriptions in the Feishu developer console, add `task.task.update_user_access_v2`, and publish the app version so manual task completion reaches the service. Per-task API subscriptions do not replace this event configuration and publication. Setup's scope check does not verify developer-console event subscriptions.

The current CLI supports mainland Feishu apps; it refuses to save a Lark registration as a working configuration. Set `[ai]` provider/model/base_url/api_key and `enabled=true` to use pi; tasks must also be enabled. An explicit `base_url` is required when AI is enabled; an empty URL does not select a provider default. Supported model protocols are OpenAI Responses and Anthropic Messages. Model configuration changes require a restart.

Feishu credentials come from process environment, then state `.env`, then repository `.env`. Files use literal `KEY=VALUE`: quotes, hashes and embedded equals signs are literal, and shell `export` syntax is unsupported. Model, Jev and memory keys come from TOML. Keep credential files private.

The optional `[jev]` section accepts `api_key`, `base_url` (default `https://api.typesafe.ai`), `model` (`jev-1.13.0`), `timeout` (`10s`, up to `2m`), `confidence_threshold` (`0.8`), `ingress_enabled` (`false`), `approvals_enabled` (`true`) and `stall_rounds` (`3`). Restart after changing it. Enabling private ingress sends eligible private-message text and registered project names to third-party Jev; it does not send complete history, repository files or attachments. A key alone does not enable ingress. Uncertain projects, low confidence, failures, quoted context and complex requests retain the original pi route.

With AI enabled and a Jev key, `approvals_enabled = true` also enables automatic blocked-menu handling for existing and new managed tasks in every orchestration mode. Jev receives the complete visible terminal screen and task/user requirements, chooses one supported key, and the program validates the task, native identity and screen before executing it. Each key is followed by a fresh observation; no fixed approval wording is required. Failed or uncertain Jev choices fall back to pi with only `approval_decide` over the same candidates. Missing credentials, user business decisions, unreadable screens and uncertain writes remain for the user. This does not enable private ingress, change Bypass or accept task delivery. Set `approvals_enabled = false` to retain manual ordinary approvals and the existing restricted startup-trust flow. See [the fix and validation scope](docs/native-approvals-2026-09-28.md).

Project owners can set `verify = ["npm run check"]` and optional `verify_timeout = "2m"` in a project seed, or edit commands and timeout in the local Web project form once SQLite owns the catalog. Missing or empty `verify` runs no local commands. myrix runs only configured commands in the task's actual primary cwd, including a worktree, with a finite per-command timeout of up to 10 minutes. Commands use the service account's permissions: a fixed cwd is not an OS sandbox. Models cannot supply command strings or alternate cwd; changing a project with verification to new directories requires the local settings path. Timeout/cancellation stops its POSIX process group; unconfirmed exits keep directories blocked and are not automatically rerun. Evidence retains stdout/stderr, exit facts and configuration/code versions. Reports distinguish configured-command verification, independent **agent review**, participant self-report and not-run results. Without configured commands, an agent rerun is not labelled myrix verification. Clearing commands prevents new runs but does not cancel one already started. When the user explicitly prohibits tests, workflow records the original constraint, disables verification commands, retains independent read-only review and reports verification as not run.

The local page maintains machine configuration and shows conversation history; it is not a task-management fallback when Feishu is unavailable. Its URL is printed on startup; port 0 selects an available port. Only literal loopback IPs are accepted. The local Web page can add, edit or remove project registrations, choose a default project and participant, set Bypass for new tasks, and save the pi model connection. Enter existing directories in order: saving validates every directory and initializes Git in the first directory if needed; additional directories are passed to Claude/Codex in the same order. Removing a registration does not delete its code. Project directories and Bypass defaults apply to new tasks without changing existing execution sessions; verification settings are checked again before each new verification run; model connection changes require a service restart. The Web identity selector only selects authorized history and configuration scope; it does not change the Feishu sender. You can also use the documented configuration files and CLI; initiate business operations in Feishu. `myrix configure --listen 127.0.0.1:0 --open` remains available to start the local page without a Feishu connection. Its HTTP interface only exposes protected configuration writes; business writes remain unavailable. The command still opens and migrates local state and can process already queued work through the existing scheduler; the read-only guarantee applies to browsing, not to every effect of starting the service. This is a single-user, single-machine tool, not a remotely authenticated multi-tenant Web service.

For supervised operation, review the launchd/systemd user templates and installer in [deploy](deploy/). Use the correct account and paths. Stopping the bridge does not automatically destroy herdr-managed tasks.

### Upgrades and an existing instance

Running `myrix` without arguments means `myrix serve`. If another process holds the state lock, a second Feishu connection is refused. Inspect the existing instance first:

```sh
myrix status
myrix status --json
```

`status` checks the kernel lock and reports process and service-manager diagnostics without connecting to Feishu, opening SQLite or requiring valid configuration. A recorded PID is only a hint; a held lock does not prove the Feishu connection is healthy. Do not delete the PID file of a lock holder. Stop a foreground instance with Ctrl+C in its original terminal, then start the updated program. For a supervised instance, follow the service instructions verified by `status`.

An npm upgrade changes installed files, not an already-running process. `myrix version --json` reports the installation used by that command, not the version of a background instance. If launchd still points to an older standalone binary, run the corrected installer from a source checkout to bind the bridge to the current npm command:

```sh
MYRIX_BIN="$(command -v myrix)" bash deploy/install.sh --bridge-only
launchctl print "gui/$(id -u)/com.hewenyu.myrix"
```

This preserves configuration and the herdr service, retires the legacy bridge launchd label, and installs/restarts `com.hewenyu.myrix`. The npm package does not include `deploy/install.sh`. Once the service uses the same npm global directory, subsequent upgrades require `launchctl kickstart -k "gui/$(id -u)/com.hewenyu.myrix"`. Changing an nvm Node version or npm global prefix requires rerunning the installer to update the executable and Node PATH.

SQLite's `ExperimentalWarning` is a notice from the embedded Node runtime, not a lock failure. Help, version, status and a refused duplicate startup no longer load SQLite; warnings remain visible when the database is actually opened. Use `myrix --trace-warnings serve` for warning stacks. The `...` in Node's hint is a placeholder, not a literal argument.

## Workflow and commands

Use the main Feishu private conversation to create projects and tasks or switch pi sessions; use each task group to continue its discussion and handle approvals. Ask pi to start a requirements discussion with Claude and Codex or arrange implementation and review. Discussions may omit a project; development, review and test tasks use a configured project. One Feishu bot labels participant output; Claude and Codex are not separate Feishu accounts.

Task mode is frozen at creation. The application imposes no decision-count, discussion-round, total-duration or tool-call quota; AI budgets belong to the configured gateway. In workflow mode an unchanged open-issue set across `stall_rounds` settled batches asks the user to decide, without forcing synthesis or completion. Explicit `round_robin` discussions continue until paused or ended. Per-operation timeouts and model context management keep stalled calls and oversized requests recoverable. Participant IDs distinguish multiple instances of the same model. Normal text never serves as a permission-menu approval. Unknown delivery or mutation outcomes are retained for inspection rather than automatically retried.

Task identity and creation locks are scoped to the selected pi session. Reusing a request or message ID in another session therefore creates an independent task and does not serialize unrelated project creation. The application retains task and conversation history after a group is dissolved, but late messages and card callbacks are rejected at ingress and before inbox execution; they cannot fall back to the main pi session or consume an approval. When Feishu reconnects, the previous task scheduler is stopped before the replacement starts reconciling the same records, so an old connection cannot continue acting on the new connection's work.

With automatic approvals disabled or no Jev key, the existing startup pi flow confirms only the native Claude/Codex directory-trust prompt when the directory matches the authorized task project. For tasks without model orchestration, `manual` discussions only attempt the first participant automatically; later participants wait for the user or scheduler. If the current facts show a published task-group approval card, a `blocked` participant requires the user to handle that card; without a group or card publication fact, the notice reports only that the participant is blocked. `round_robin` may advance only after the previous participant has produced a verified output. When automatic approvals are disabled, other approval prompts remain in the task group for the user to choose explicitly. The project/task Bypass setting is preserved as an explicit option and is never enabled implicitly by this startup handling.

New tasks dissolve their group after confirmed completion by default; explicitly request `keepGroup: true` to retain it. `review` never triggers dissolution. Explicit retention remains effective. Legacy default or unproven retention is resolved to deletion when completion or closure begins; active historical tasks are not rewritten in bulk. `complete`, including manual Feishu completion, closes the corresponding execution resources through herdr and applies the group policy. Any group dissolution also closes the corresponding herdr-managed Claude/Codex sessions. Explicit `keepExecution: true` on completion is an exception and requires `keepGroup: true` for tasks with a group; `close` confirms completion before execution cleanup; `destroy` cleans up without accepting the task; `reopen` applies to completed tasks whose resources remain. If execution has already closed and a group was retained, explicitly request its dissolution; pi can use `destroy` with `keepGroup: false` (or `close` for an already accepted task). This keeps the original acceptance history and never restarts execution. Session archiving is independent. Shared project directories are the default. Explicit worktree mode isolates only the first directory; additional directories remain shared, and task closure does not delete code or worktrees.

The everyday CLI is `serve / setup / configure / doctor / status / version / help`; `configure` opens the local configuration and conversation-history page, while business controls remain in Feishu. Maintenance adds `migrate` and read-only `debug ls|screen|transcript`. Old top-level pane-writing commands such as `key` and `say`, and the old `watch/dialog/tail` interfaces, are removed; use participant controls and approval cards.

The main Feishu private conversation automatically compacts long pi context when its configured context capacity is reached; compaction preserves the original history and durable operation receipts. Send `/clear` there only when you want to manually archive the current pi session and select a new one. Only after that transaction succeeds does the program reply `CLEAR_NEW_SESSION_OK`. This works with AI disabled or unavailable, preserves history and tasks, and leaves herdr sessions intact. Groups reject the command. Matching uses only the actual message body, with surrounding whitespace removed; quoted text, `/CLEAR`, `／clear`, `/clear now` and mentions of `/clear` do not trigger it. Web has no chat box, `/clear` entry point or clear/reset button. Browsing another history record never changes the active Feishu session.

With AI enabled, other conversational text follows the opt-in classification rule above; slash syntax other than exact `/clear` goes to pi. With AI disabled, task-mode compatibility commands remain available. With tasks disabled, the existing-agent bridge retains `/ls /card /say /stop /mirror /close`; its `/close` only clears selection and never destroys a task. See `help` for exact CLI options.

The legacy `/ls` picker lists only managed Claude/Codex agents. Unmanaged herdr shell panes remain outside this bridge and are not offered as selectable targets.

Exit codes: 0 success; 1 failure; 2 usage error; 3 setup credentials saved but verification incomplete; 130 cancellation. The Go CLI's historical exit codes are not all preserved.

## Migration and rollback

Stop the Go service and its automatic restart before migration. Do not run two event consumers for the same Feishu app.

```sh
myrix migrate --state-dir /absolute/state --dry-run
myrix migrate --state-dir /absolute/state
myrix serve --state-dir /absolute/state
```

Migration validates old JSON, backs up original files under `backups/`, then imports tasks, native resource references, visible conversations and replay-prevention receipts into SQLite transactionally. Old files remain unchanged. The service startup performs the same idempotent migration; explicit maintenance uses `migrate`. Corrupt sources, conflicting new facts or changed previously imported sources refuse overwrite. Interrupted operations remain unresolved; old tools and historical replies are not replayed.

New state is stored in `state.sqlite` with WAL/SHM. TOML and legacy `projects.json` seed the catalog; subsequent project changes made through Feishu or Web configuration write SQLite. There is no automatic reverse migration. Before rollback, stop the new service, preserve the database and backups, and reconcile resources created or removed since migration. Restoring old JSON alone does not restore external state.

## Evidence and scope

Tests cover the real pi loop with protocol fixtures, SQLite/flock/Git, Feishu SDK dispatch, migration, delivery receipts and standalone packaging. Business acceptance requires actual Feishu user ingress and group interactions, matched with model/tool receipts, herdr execution and independent readbacks. Direct Web/API actions and fixtures cannot substitute for this route. Web configuration writes and history browsing are verified separately. Supported inputs are text and text inside rich posts; image understanding, speech transcription and artifact hosting are outside the first release.

- [Current business scenarios, command choices and gaps](docs/current-business-scenarios.md)
- [Current design and D01–D16 decisions](docs/node-pi-design.md)
- [Jev/LLM orchestration v1.1 and S3/S4 specs (merged in PR #54)](docs/myrix-jev-llm-orchestration-design.md)
- [B/N scenario mapping and acceptance evidence](docs/acceptance.md)
- [Active refactor goal](docs/refactor-goal.md)
- [Original Go requirements inventory](docs/node-pi-refactor-requirements.md)

The [live Jev Choice check](docs/jev-choice-live-evidence-2026-09-27.json) uses synthetic input and does not establish full Feishu/Claude/Codex workflow acceptance.

The owner has confirmed acceptance of PR #54. [Follow-up evidence and reproducible probes](docs/workflow-completion-2026-09-27.md) record successful isolated discussion, development and bugfix workflows with real Jev, pi, Claude and Codex, plus synthetic ingress failures and fallback paths. Run `node --import tsx scripts/live/jev-ingress-probe.ts` for classification only, or `node --import tsx scripts/live/workflow-acceptance.ts --template all` for local workflow checks. These manual probes use configured model credentials; they do not send Feishu messages or change service configuration.

Older architecture and audit documents are explicitly marked as Go history and use permanent source links. They are not the current Node runtime specification.

This project is MIT; see [LICENSE](LICENSE). Release archives also include `LICENSES/` with the bundled npm dependencies, native addon/header and complete Node notices. Retain these materials when redistributing. See [license generation](licenses/README.md).

See the [local implementation and review record](docs/workflow-implementation-2026-09-27.md) for code mappings, checks, live model evidence and outstanding platform acceptance.
