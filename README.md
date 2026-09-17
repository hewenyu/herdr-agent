# herdr-agent

[中文说明](README.zh-CN.md)

A personal orchestration tool built with **Node, TypeScript and pi**. Use Feishu or the local Web interface to manage projects, tasks, participants and multiple pi sessions. **herdr continues to host Claude/Codex and their native sessions.**

pi handles this tool's business: arranging work, routing messages, querying state and managing lifecycles. Claude/Codex handle your project's requirements, design, implementation, tests and reviews. With AI enabled, the model decides conversational responses and tool calls; keyword handlers and fixed business replies must not replace that decision. The application enforces identity, scope, human approval and durable receipts.

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

Build natively for each target: macOS arm64, Linux x64 and Linux arm64. A macOS executable is not a Linux executable. `smoke` copies only the binary to a fresh temporary directory and verifies help, version, native locking, SQLite, embedded Web resources, state API and CSRF. It also exercises the embedded pi loop against local Responses/Anthropic fixtures and verifies Web delivery acknowledgement. It uses temporary state and does not connect to real Feishu or herdr. Current platform evidence is recorded in [acceptance](docs/acceptance.md); macOS ad-hoc signing is not notarization.

For source development: `npm run dev -- help`. Use the built program to verify embedded Web assets. The examples below assume the executable is on PATH; otherwise replace `herdr-agent` with `./dist/herdr-agent`.

## Setup

Copy [config.example.toml](deploy/config.example.toml) to `~/.herdr-agent/config.toml`, mode 0600. Enable `tasks.enabled` before setup if you want task/group permissions, then run:

```sh
herdr-agent setup
herdr-agent configure --listen 127.0.0.1:0 --open
herdr-agent serve --open
```

Run configure and serve separately: they share the state lock. Setup reuses an existing app when possible, saves credentials and the verified owner, and requires both a private message and the matching card callback for complete verification. Stop serve before running setup. Use `setup --app cli_EXISTING_APP` to resolve an ambiguous app and `setup --update-permissions` to grant required scopes. Creating a replacement app requires `setup --reregister --yes`.

The current CLI supports mainland Feishu apps; it refuses to save a Lark registration as a working configuration. Set `[ai]` provider/model/base_url/api_key and `enabled=true` to use pi; tasks must also be enabled. Supported model protocols are OpenAI Responses and Anthropic Messages. Model configuration changes require a restart.

Feishu credentials come from process environment, then state `.env`, then repository `.env`. Files use literal `KEY=VALUE`: quotes, hashes and embedded equals signs are literal, and shell `export` syntax is unsupported. Model and memory keys come from TOML. Keep credential files private.

When authorization is missing, serve keeps the local Web interface available. Its URL is printed on startup; port 0 selects an available port. Only literal loopback IPs are accepted. `configure` runs local management without a Feishu connection. For an explicitly local task, turn off both cloud-group and cloud-task creation; unavailable connectivity never silently removes requested cloud resources. This is a single-user, single-machine tool, not a remotely authenticated multi-tenant Web service.

For supervised operation, review the launchd/systemd user templates and installer in [deploy](deploy/). Use the correct account and paths. Stopping the bridge does not automatically destroy herdr-managed tasks.

## Workflow and commands

Ask pi to start a requirements discussion with Claude and Codex, arrange implementation and review, or return to a previous orchestration session. One Feishu bot labels participant output; Claude and Codex are not separate Feishu accounts.

Multi-participant discussions default to at most four rounds and 30 minutes. Participant IDs distinguish multiple instances of the same model. Normal text never serves as a permission-menu approval. Unknown delivery or mutation outcomes are retained for inspection rather than automatically retried.

New tasks retain group history by default. `complete` preserves execution resources; `close` confirms completion before cleanup; `destroy` cleans up without accepting the task; `reopen` applies to completed tasks whose resources remain. Session archiving is independent. Shared project directories are the default. Explicit worktree mode isolates only the first directory; additional directories remain shared, and task closure does not delete code or worktrees.

The everyday CLI is `serve / setup / configure / doctor / version / help`. Maintenance adds `migrate` and read-only `debug ls|screen|transcript`. Old top-level pane-writing commands such as `key` and `say`, and the old `watch/dialog/tail` interfaces, are removed; use participant controls and approval cards.

With AI enabled, all conversational text, including slash syntax, goes to the model. With AI disabled, task-mode compatibility commands remain available. With tasks disabled, the existing-agent bridge retains `/ls /card /say /stop /mirror /close`; its `/close` only clears selection and never destroys a task. See `help` for exact CLI options.

Exit codes: 0 success; 1 failure; 2 usage error; 3 setup credentials saved but verification incomplete; 130 cancellation. The Go CLI's historical exit codes are not all preserved.

## Migration and rollback

Stop the Go service and its automatic restart before migration. Do not run two event consumers for the same Feishu app.

```sh
herdr-agent migrate --state-dir /absolute/state --dry-run
herdr-agent migrate --state-dir /absolute/state
herdr-agent serve --state-dir /absolute/state
```

Migration validates old JSON, backs up original files under `backups/`, then imports tasks, native resource references, visible conversations and replay-prevention receipts into SQLite transactionally. Old files remain unchanged. `serve` and `configure` run the same idempotent migration automatically. Corrupt sources, conflicting new facts or changed previously imported sources refuse overwrite. Interrupted operations remain unresolved; old tools and historical replies are not replayed.

New state is stored in `state.sqlite` with WAL/SHM. TOML and legacy `projects.json` seed the catalog; subsequent Web project edits write SQLite. There is no automatic reverse migration. Before rollback, stop the new service, preserve the database and backups, and reconcile resources created or removed since migration. Restoring old JSON alone does not restore external state.

## Evidence and scope

Tests cover the real pi loop with protocol fixtures, SQLite/flock/Git, Feishu SDK dispatch, migration, delivery receipts and standalone packaging. They do not prove a live end-to-end flow through a production Feishu tenant, real model and real herdr. Supported inputs are text and text inside rich posts; image understanding, speech transcription and artifact hosting are outside the first release.

- [Current design and D01–D16 decisions](docs/node-pi-design.md)
- [B/N scenario mapping and acceptance evidence](docs/acceptance.md)
- [Active refactor goal](docs/refactor-goal.md)
- [Original Go requirements inventory](docs/node-pi-refactor-requirements.md)

Older architecture and audit documents are explicitly marked as Go history and use permanent source links. They are not the current Node runtime specification.

This project is MIT; see [LICENSE](LICENSE). Release archives also include `LICENSES/` with the bundled npm dependencies, native addon/header and complete Node notices. Retain these materials when redistributing. See [license generation](licenses/README.md).
