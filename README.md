# myrix

[中文说明](README.zh-CN.md) · [npm](https://www.npmjs.com/package/@yuebanlaosiji/myrix) · [Releases](https://github.com/hewenyu/herdr-agent/releases)

A local orchestration tool built with **Node, TypeScript and pi**, distributed as **@yuebanlaosiji/myrix**. Start projects, arrange requirements discussions and development tasks, and follow progress in Feishu. The local Web interface provides project and model configuration and conversation history.

**pi manages this tool's projects, tasks, participants and sessions. herdr hosts Claude/Codex and their native sessions.** Claude/Codex handle your project's requirements, design, implementation, tests and reviews. You can bring both into one task group, run multiple instances, and create independent tasks for different projects.

With AI enabled, the model decides conversational replies, lifecycle notices and tool calls. The application provides tools, permission checks and durable operation receipts. Claims about completed business actions require real write evidence; lifecycle notices use the current task and participant snapshots with read-only tools. The exact `/clear` command rotates the main private pi session directly, without a model call.

The frontend, backend, Node runtime and native locking addon are bundled into one executable. The repository, standalone executable and state directory retain the names `herdr-agent` and `~/.herdr-agent` for compatibility.

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
npm install -g @yuebanlaosiji/myrix@0.3.11
npm install -g @yuebanlaosiji/myrix@latest
```

For an installation without Node, download and extract the matching archive from [Releases](https://github.com/hewenyu/herdr-agent/releases), verify it against the attached `SHA256SUMS`, then run the included executable:

```sh
./herdr-agent version --json
./herdr-agent setup
./herdr-agent serve
```

Read the setup section before starting task orchestration. Both installation methods require herdr, Git and the selected authenticated Claude/Codex CLI. Linux also requires compatible system libraries. macOS archives have an ad-hoc signature, without notarization; platform requirements and checksum commands are included in the release notes.

## Release and acceptance status

See [Releases](https://github.com/hewenyu/herdr-agent/releases/latest) for the latest stable build and use `myrix version --json` to inspect the version, source commit and build time of your installation. This README describes the current source; consult a release's notes for changes included in that version. The root `package.json` is a private source package, not the published npm entry package.

A pushed `v*` tag triggers three native builds and smoke tests, verifies the complete npm distribution with an offline global install, publishes the platform packages and then the entry package, and creates the GitHub Release. Publishing uses `TOKEN` from the GitHub environment `NPM`. No manual workflow download option is required. See [release operations](docs/releasing.md) for versioning and recovery.

Full live acceptance remains in progress. Automated checks and packaging smoke tests do not establish that every real Feishu, model and herdr scenario works. [Live validation](docs/live-validation.md) records passed, partial, untested and failed cases; [E24](docs/live-evidence-e24-retained-group.md) records retained-group cleanup and notification component checks, [E25](docs/live-evidence-e25-transport-legacy.md) records Feishu transport recovery and legacy-route validation, [E26](docs/live-evidence-e26-feishu-rest-lifecycle.md) records a real REST task/group lifecycle with its permission gap, [E27](docs/live-evidence-e27-service-ingress-prompt.md) records the current service bot's ingress prompt, [E28](docs/live-evidence-e28-real-model-tool-decision.md) records a real model first-tool decision probe, [E29](docs/live-evidence-e29-boundary-regressions.md) records local session/group boundary regressions, and [E30](docs/live-evidence-e30-long-message.md) records a real long-message split and cleanup. These records do not replace real user ingress through Feishu.

## Build and run

Building requires **Node >=24.13**, npm, Python and a C++/make toolchain for `fs-ext`. macOS needs Command Line Tools. Runtime prerequisites are herdr, the selected authenticated Claude/Codex CLI, Git and compatible system C++ libraries.

```sh
npm ci
npm run check
npm run build
npm run binary
npm run smoke
./dist/herdr-agent version --json
```

`check` runs the 1000-line-per-file limit, strict TypeScript, Biome formatting/lint and tests. `build` produces `dist/herdr-agent.cjs` with embedded Web assets. `binary` rebuilds the application and uses Node SEA to produce `dist/herdr-agent`, including the Node runtime and native flock extension. End users need neither Node nor `node_modules` or separate frontend files.

Build natively for each target: macOS arm64, Linux x64 and Linux arm64. A macOS executable is not a Linux executable. `smoke` copies only the binary to a fresh temporary directory and verifies help, version, native locking, SQLite, embedded Web resources, history browsing, protected configuration writes and rejection of Web business writes. Isolated Feishu adapter events are queued before startup; the copied SEA executes the bundled pi loop against local Responses and Anthropic protocol fixtures. Reading history never acknowledges delivery; without a Feishu connection, the reply remains undelivered. This is packaging coverage, with no real Feishu, herdr or model service. Current platform evidence is recorded in [acceptance](docs/acceptance.md); macOS ad-hoc signing is not notarization.

For source development: `npm run dev -- help`. Use the built program to verify embedded Web assets. The examples below use the npm command `myrix`; for a source build, substitute `./dist/herdr-agent`.

## Setup

Copy [config.example.toml](deploy/config.example.toml) to `~/.herdr-agent/config.toml`, mode 0600. Enable `tasks.enabled` before setup if you want task/group permissions, then run:

```sh
myrix setup
myrix serve --open
```

Setup reuses an existing app when possible, saves credentials and the verified owner, and requires both a private message and the matching card callback for complete verification. Stop serve before running setup. Use `setup --app cli_EXISTING_APP` to resolve an ambiguous app and `setup --update-permissions` to grant required scopes. Creating a replacement app requires `setup --reregister --yes`.

For existing apps with tasks enabled, configure event subscriptions in the Feishu developer console, add `task.task.update_user_access_v2`, and publish the app version so manual task completion reaches the service. Per-task API subscriptions do not replace this event configuration and publication. Setup's scope check does not verify developer-console event subscriptions.

The current CLI supports mainland Feishu apps; it refuses to save a Lark registration as a working configuration. Set `[ai]` provider/model/base_url/api_key and `enabled=true` to use pi; tasks must also be enabled. An explicit `base_url` is required when AI is enabled; an empty URL does not select a provider default. Supported model protocols are OpenAI Responses and Anthropic Messages. Model configuration changes require a restart.

Feishu credentials come from process environment, then state `.env`, then repository `.env`. Files use literal `KEY=VALUE`: quotes, hashes and embedded equals signs are literal, and shell `export` syntax is unsupported. Model and memory keys come from TOML. Keep credential files private.

The local page maintains machine configuration and shows conversation history; it is not a task-management fallback when Feishu is unavailable. Its URL is printed on startup; port 0 selects an available port. Only literal loopback IPs are accepted. Maintain projects (multiple ordered directories, with Git initialized in the first directory), default project, Bypass and model connection in the local Web page. Project directories are passed to Claude/Codex. The Web identity selector only selects authorized history and configuration scope; it does not change the Feishu sender. You can also use the documented configuration files and CLI; initiate business operations in Feishu. `myrix configure --listen 127.0.0.1:0 --open` remains available to start the local page without a Feishu connection. Its HTTP interface only exposes protected configuration writes; business writes remain unavailable. The command still opens and migrates local state and can process already queued work through the existing scheduler; the read-only guarantee applies to browsing, not to every effect of starting the service. This is a single-user, single-machine tool, not a remotely authenticated multi-tenant Web service.

For supervised operation, review the launchd/systemd user templates and installer in [deploy](deploy/). Use the correct account and paths. Stopping the bridge does not automatically destroy herdr-managed tasks.

## Workflow and commands

In Feishu, ask pi to start a requirements discussion with Claude and Codex, arrange implementation and review, or return to a previous orchestration session. One Feishu bot labels participant output; Claude and Codex are not separate Feishu accounts.

Multi-participant discussions default to at most four rounds and 30 minutes. Participant IDs distinguish multiple instances of the same model. Normal text never serves as a permission-menu approval. Unknown delivery or mutation outcomes are retained for inspection rather than automatically retried.

Task identity and creation locks are scoped to the selected pi session. Reusing a request or message ID in another session therefore creates an independent task and does not serialize unrelated project creation. A dissolved task group remains available for history, but late messages and card callbacks are rejected at ingress and before inbox execution; they cannot fall back to the main pi session or consume an approval.

At startup, pi automatically confirms only the native Claude/Codex directory-trust prompt when the directory matches the authorized task project. Other approval prompts remain in the task group for the user to choose explicitly. The project/task Bypass setting is preserved as an explicit option and is never enabled implicitly by this startup handling.

New tasks dissolve their group after confirmed completion by default; explicitly request `keepGroup: true` to retain it. `review` never triggers dissolution. Explicit retention remains effective. Legacy default or unproven retention is resolved to deletion when completion or closure begins; active historical tasks are not rewritten in bulk. `complete`, including manual Feishu completion, closes the corresponding execution resources through herdr and applies the group policy. Any group dissolution also closes the corresponding herdr-managed Claude/Codex sessions. Explicit `keepExecution: true` on completion is an exception and requires `keepGroup: true` for tasks with a group; `close` confirms completion before execution cleanup; `destroy` cleans up without accepting the task; `reopen` applies to completed tasks whose resources remain. If execution has already closed and a group was retained, explicitly request its dissolution; pi can use `destroy` with `keepGroup: false` (or `close` for an already accepted task). This keeps the original acceptance history and never restarts execution. Session archiving is independent. Shared project directories are the default. Explicit worktree mode isolates only the first directory; additional directories remain shared, and task closure does not delete code or worktrees.

The everyday CLI is `serve / setup / configure / doctor / version / help`; `configure` opens the local configuration and conversation-history page, while business controls remain in Feishu. Maintenance adds `migrate` and read-only `debug ls|screen|transcript`. Old top-level pane-writing commands such as `key` and `say`, and the old `watch/dialog/tail` interfaces, are removed; use participant controls and approval cards.

The main Feishu private conversation automatically compacts long pi context when its configured budget is reached; compaction preserves the original history and durable operation receipts. Send `/clear` there only when you want to manually archive the current pi session and select a new one. Only after that transaction succeeds does the program reply `CLEAR_NEW_SESSION_OK`. This works with AI disabled or unavailable, preserves history and tasks, and leaves herdr sessions intact. Groups reject the command. Matching uses only the actual message body, with surrounding whitespace removed; quoted text, `/CLEAR`, `/clear now` and mentions of `/clear` do not trigger it. Web has no chat box, `/clear` entry point or clear/reset button. Browsing another history record never changes the active Feishu session.

With AI enabled, other conversational text, including slash syntax, goes to the model. With AI disabled, task-mode compatibility commands remain available. With tasks disabled, the existing-agent bridge retains `/ls /card /say /stop /mirror /close`; its `/close` only clears selection and never destroys a task. See `help` for exact CLI options.

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

Tests cover the real pi loop with protocol fixtures, SQLite/flock/Git, Feishu SDK dispatch, migration, delivery receipts and standalone packaging. Business acceptance requires actual Feishu user ingress and group interactions, matched with model/tool receipts, herdr execution and independent readbacks. Direct Web/API actions and fixtures cannot substitute for this route. Read-only Web browsing is verified separately. Supported inputs are text and text inside rich posts; image understanding, speech transcription and artifact hosting are outside the first release.

- [Current business scenarios, command choices and gaps](docs/current-business-scenarios.md)
- [Current design and D01–D16 decisions](docs/node-pi-design.md)
- [B/N scenario mapping and acceptance evidence](docs/acceptance.md)
- [Active refactor goal](docs/refactor-goal.md)
- [Original Go requirements inventory](docs/node-pi-refactor-requirements.md)

Older architecture and audit documents are explicitly marked as Go history and use permanent source links. They are not the current Node runtime specification.

This project is MIT; see [LICENSE](LICENSE). Release archives also include `LICENSES/` with the bundled npm dependencies, native addon/header and complete Node notices. Retain these materials when redistributing. See [license generation](licenses/README.md).
