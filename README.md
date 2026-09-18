# herdr-agent

[中文说明](README.zh-CN.md)

A personal orchestration tool built with **Node, TypeScript and pi**. Use Feishu private messages and task groups for projects, tasks, participants and pi sessions. The local Web interface reads conversation history and maintains local project, model connection and Bypass configuration. **herdr continues to host Claude/Codex and their native sessions.**

pi handles this tool's business: arranging work, routing messages, querying state and managing lifecycles. Claude/Codex handle your project's requirements, design, implementation, tests and reviews. With AI enabled, the model decides ordinary conversational responses and tool calls. The exact `/clear` session command runs directly without a model. The application enforces identity, scope, human approval and durable receipts.

**Scope correction, 2026-09-18:** Web is a local configuration and history surface. It can maintain project definitions (multiple ordered directories; saving ensures Git is initialized in the first directory), default project, Bypass, model connection and local identity. It cannot send messages, create tasks, manage participants, approve, clean up resources or operate pi sessions. Feishu remains the business entry point; configuration writes are protected by loopback, Origin, Host and CSRF checks.

## Release and acceptance status

The latest published release is [v0.3.5](https://github.com/hewenyu/herdr-agent/releases/tag/v0.3.5). Install that exact release with `npm install -g @yuebanlaosiji/myrix@0.3.5`, or use `@latest` for the current stable version. The npm launcher and the release archives expose the same `myrix` command and the `herdr-agent` compatibility alias.

Automated checks and native packaging are run by the release workflow. End-to-end acceptance is still tracked per scenario: a green build does not prove that a real Feishu message, model tool call, herdr resource, group message, or cleanup readback happened. Check [live validation](docs/live-validation.md) for the current `U`, `R-部分`/`R-partial`, and `R-P` evidence, including retained historical unknown results. Treat a scenario as accepted only when its corresponding Feishu, pi, model, herdr, and external readbacks are present.

The current source validation also includes the inbox scheduling race fix: `npm run check` passes 422 tests, and `npm run build`, `npm run binary` and `npm run smoke` pass on macOS arm64. A fresh local binary was restarted and exercised through a real Feishu discussion: it created a task and group, started a Codex participant, delivered `LIVE_RACE_R2_OK`, accepted manual completion, closed the herdr executor and dissolved the group. This is a limited discussion and cleanup result; the remaining scenario gaps stay listed in [live validation](docs/live-validation.md).

## Install

The Node/pi rewrite starts at **v0.3.0**. Release tags publish native executables and the scoped npm package **@yuebanlaosiji/myrix** for macOS arm64, Linux x64 and Linux arm64.

```sh
npm install -g @yuebanlaosiji/myrix
myrix version --json
myrix setup
myrix serve
```

npm installation needs Node >=18 for its small launcher and selects the matching bundled executable. Keep optional dependencies enabled; no install script downloads code. `herdr-agent` remains a command alias, and the existing state directory stays `~/.herdr-agent`. To run without Node, download the matching binary archive from [Releases](https://github.com/hewenyu/herdr-agent/releases).

The release workflow uses the `TOKEN` secret in GitHub environment `NPM` only for publishing. It assembles and verifies the complete npm distribution with an offline global install before publishing the GitHub Release. npm may take a few minutes to expose a newly published version through its public registry. See [release operations](docs/releasing.md) for recovery.

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

`check` runs the 1000-line-per-file limit, strict TypeScript, Biome formatting/lint and tests. `build` produces `dist/herdr-agent.cjs` with embedded Web assets. `binary` uses Node SEA to produce `dist/herdr-agent`, including the Node runtime and native flock extension. End users need neither Node nor `node_modules` or separate frontend files.

Build natively for each target: macOS arm64, Linux x64 and Linux arm64. A macOS executable is not a Linux executable. `smoke` copies only the binary to a fresh temporary directory and verifies help, version, native locking, SQLite, embedded Web resources, read-only history and rejection of Web writes. Isolated Feishu adapter events are queued before startup; the copied SEA executes the bundled pi loop against local Responses and Anthropic protocol fixtures. Reading history never acknowledges delivery; without a Feishu connection, the reply remains undelivered. This is packaging coverage, with no real Feishu, herdr or model service. Current platform evidence is recorded in [acceptance](docs/acceptance.md); macOS ad-hoc signing is not notarization.

For source development: `npm run dev -- help`. Use the built program to verify embedded Web assets. The examples below assume the executable is on PATH; otherwise replace `herdr-agent` with `./dist/herdr-agent`.

## Setup

Copy [config.example.toml](deploy/config.example.toml) to `~/.herdr-agent/config.toml`, mode 0600. Enable `tasks.enabled` before setup if you want task/group permissions, then run:

```sh
herdr-agent setup
herdr-agent serve --open
```

Setup reuses an existing app when possible, saves credentials and the verified owner, and requires both a private message and the matching card callback for complete verification. Stop serve before running setup. Use `setup --app cli_EXISTING_APP` to resolve an ambiguous app and `setup --update-permissions` to grant required scopes. Creating a replacement app requires `setup --reregister --yes`.

For existing apps with tasks enabled, configure event subscriptions in the Feishu developer console, add `task.task.update_user_access_v2`, and publish the app version so manual task completion reaches the service. Per-task API subscriptions do not replace this event configuration and publication. Setup's scope check does not verify developer-console event subscriptions.

The current CLI supports mainland Feishu apps; it refuses to save a Lark registration as a working configuration. Set `[ai]` provider/model/base_url/api_key and `enabled=true` to use pi; tasks must also be enabled. An explicit `base_url` is required when AI is enabled; an empty URL does not select a provider default. Supported model protocols are OpenAI Responses and Anthropic Messages. Model configuration changes require a restart.

Feishu credentials come from process environment, then state `.env`, then repository `.env`. Files use literal `KEY=VALUE`: quotes, hashes and embedded equals signs are literal, and shell `export` syntax is unsupported. Model and memory keys come from TOML. Keep credential files private.

The local page maintains machine configuration and shows conversation history; it is not a task-management fallback when Feishu is unavailable. Its URL is printed on startup; port 0 selects an available port. Only literal loopback IPs are accepted. Maintain project and model settings in the local Web page or the documented configuration files and CLI; initiate business operations in Feishu. `configure --listen 127.0.0.1:0 --open` remains available to start the local page without a Feishu connection. Its HTTP interface only exposes protected configuration writes; business writes remain unavailable. The command still opens and migrates local state and can process already queued work through the existing scheduler; the read-only guarantee applies to browsing, not to every effect of starting the service. This is a single-user, single-machine tool, not a remotely authenticated multi-tenant Web service.

For supervised operation, review the launchd/systemd user templates and installer in [deploy](deploy/). Use the correct account and paths. Stopping the bridge does not automatically destroy herdr-managed tasks.

## Workflow and commands

In Feishu, ask pi to start a requirements discussion with Claude and Codex, arrange implementation and review, or return to a previous orchestration session. One Feishu bot labels participant output; Claude and Codex are not separate Feishu accounts.

Multi-participant discussions default to at most four rounds and 30 minutes. Participant IDs distinguish multiple instances of the same model. Normal text never serves as a permission-menu approval. Unknown delivery or mutation outcomes are retained for inspection rather than automatically retried.

New tasks dissolve their group after confirmed completion by default; explicitly request `keepGroup: true` to retain it. `review` never triggers dissolution. Explicit retention remains effective. Legacy default or unproven retention is resolved to deletion when completion or closure begins; active historical tasks are not rewritten in bulk. `complete`, including manual Feishu completion, closes the corresponding execution resources through herdr and applies the group policy. Any group dissolution also closes its managed executors. Explicit `keepExecution: true` on completion is an exception and requires `keepGroup: true` for tasks with a group; `close` confirms completion before execution cleanup; `destroy` cleans up without accepting the task; `reopen` applies to completed tasks whose resources remain. Session archiving is independent. Shared project directories are the default. Explicit worktree mode isolates only the first directory; additional directories remain shared, and task closure does not delete code or worktrees.

The everyday CLI is `serve / setup / configure / doctor / version / help`; `configure` opens the local configuration and conversation-history page, while business controls remain in Feishu. Maintenance adds `migrate` and read-only `debug ls|screen|transcript`. Old top-level pane-writing commands such as `key` and `say`, and the old `watch/dialog/tail` interfaces, are removed; use participant controls and approval cards.

Send `/clear` in the main Feishu private conversation to archive the current pi session and select a new one. Only after the transaction succeeds does the program reply `CLEAR_NEW_SESSION_OK`. This works with AI disabled or unavailable, preserves history and tasks, and leaves herdr sessions intact. Groups reject the command. Matching uses only the actual message body, with surrounding whitespace removed; quoted text, `/CLEAR`, `/clear now` and mentions of `/clear` do not trigger it. Web has no chat box, `/clear` entry point or clear/reset button. Browsing another history record never changes the active Feishu session.

With AI enabled, other conversational text, including slash syntax, goes to the model. With AI disabled, task-mode compatibility commands remain available. With tasks disabled, the existing-agent bridge retains `/ls /card /say /stop /mirror /close`; its `/close` only clears selection and never destroys a task. See `help` for exact CLI options.

Exit codes: 0 success; 1 failure; 2 usage error; 3 setup credentials saved but verification incomplete; 130 cancellation. The Go CLI's historical exit codes are not all preserved.

## Migration and rollback

Stop the Go service and its automatic restart before migration. Do not run two event consumers for the same Feishu app.

```sh
herdr-agent migrate --state-dir /absolute/state --dry-run
herdr-agent migrate --state-dir /absolute/state
herdr-agent serve --state-dir /absolute/state
```

Migration validates old JSON, backs up original files under `backups/`, then imports tasks, native resource references, visible conversations and replay-prevention receipts into SQLite transactionally. Old files remain unchanged. The service startup performs the same idempotent migration; explicit maintenance uses `migrate`. Corrupt sources, conflicting new facts or changed previously imported sources refuse overwrite. Interrupted operations remain unresolved; old tools and historical replies are not replayed.

New state is stored in `state.sqlite` with WAL/SHM. TOML and legacy `projects.json` seed the catalog; subsequent project changes initiated in Feishu write SQLite. There is no automatic reverse migration. Before rollback, stop the new service, preserve the database and backups, and reconcile resources created or removed since migration. Restoring old JSON alone does not restore external state.

## Evidence and scope

Tests cover the real pi loop with protocol fixtures, SQLite/flock/Git, Feishu SDK dispatch, migration, delivery receipts and standalone packaging. Business acceptance requires actual Feishu user ingress and group interactions, matched with model/tool receipts, herdr execution and independent readbacks. Direct Web/API actions and fixtures cannot substitute for this route. Read-only Web browsing is verified separately. Supported inputs are text and text inside rich posts; image understanding, speech transcription and artifact hosting are outside the first release.

- [Current business scenarios, command choices and gaps](docs/current-business-scenarios.md)
- [Current design and D01–D16 decisions](docs/node-pi-design.md)
- [B/N scenario mapping and acceptance evidence](docs/acceptance.md)
- [Active refactor goal](docs/refactor-goal.md)
- [Original Go requirements inventory](docs/node-pi-refactor-requirements.md)

Older architecture and audit documents are explicitly marked as Go history and use permanent source links. They are not the current Node runtime specification.

This project is MIT; see [LICENSE](LICENSE). Release archives also include `LICENSES/` with the bundled npm dependencies, native addon/header and complete Node notices. Retain these materials when redistributing. See [license generation](licenses/README.md).
