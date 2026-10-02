# myrix

**Coordinate local Claude and Codex agents from Feishu.**

[简体中文](<README.zh-CN.md>) · [npm](https://www.npmjs.com/package/@yuebanlaosiji/myrix) · [Releases](https://github.com/hewenyu/herdr-agent/releases)

myrix turns a Feishu conversation into a workspace for discussing requirements, developing features, fixing bugs and reviewing results. It uses **pi to coordinate tasks** and **herdr to run native Claude/Codex sessions** on your machine. Your repositories and execution environment stay local; Feishu is where you give instructions and review delivery.

The repository is named `herdr-agent`; the current application and command are **myrix**.

## What you can do

- **Discuss before implementing.** Ask Claude and Codex to compare approaches, challenge each other and produce a conclusion. Explicitly request a document when you want the discussion written into the project.
- **Delegate development and bug fixes.** Bind a task to a registered project, assign implementation and independent review, and carry discussion context into a related task.
- **Stay in control from Feishu.** Ask for progress, revise requirements, pause scheduling, interrupt a participant or handle approval cards.
- **Receive a complete delivery.** Current workflows send a concise summary and a Markdown report attachment, rather than forwarding every intermediate agent message.
- **Keep durable history.** Task state, sessions and operation receipts are stored in SQLite. Restart recovery uses confirmed facts rather than blindly repeating external actions.

```text
Feishu private chat / task group
              ↓
     myrix · pi coordination
              ↓
    herdr · native Claude / Codex
              ↓
       local project directories

Local Web: configuration, conversation history and report downloads
```

The Web UI is **not another chat or task-control interface**. Business requests, approvals and acceptance happen in Feishu. The current workflow uses a persistent pi Leader per task; optional Jev assists private-message classification and native approval menus, not workflow scheduling.

> This README describes the current source. Installed releases may differ; check `myrix version --json` and the release notes. End-to-end live acceptance is still partial—see the [validation matrix](<docs/live-validation.md>).

## Install

### Prerequisites

- **macOS Apple Silicon**, **Linux x64** or **Linux arm64**. Linux requires **glibc**; Alpine/musl is not supported. Windows and Intel macOS binaries are not provided.
- A running **herdr server with protocol 19 or later**, **Git**, and the **Claude and/or Codex CLI** you intend to use, already authenticated on that machine. A two-agent discussion requires both CLIs.
- A **mainland Feishu** account and permission to register or authorize an app. The current setup flow does not support Lark apps.
- An API endpoint and model supporting **OpenAI Responses** or **Anthropic Messages**, with tool calling, for pi coordination. This is separate from native Claude/Codex authentication.

Install the herdr integration for each CLI you use:

```sh
herdr integration install claude
herdr integration install codex
```

Complete any native hook/trust confirmation, especially for Codex. Start herdr from a normal terminal or a reviewed service configuration, not from inside a coding-agent session: inherited agent environment variables can disable transcript recording. See the [host service configuration](<deploy/herdr-server.service>) for details.

### With npm

The launcher requires **Node.js 18 or later**; the application binary bundles its own Node runtime.

```sh
npm install -g @yuebanlaosiji/myrix
myrix version --json
myrix help
```

Keep npm optional dependencies enabled: the matching native binary is distributed as a platform package.

### Without Node.js

Download the matching archive from [Releases](https://github.com/hewenyu/herdr-agent/releases), verify it against the published `SHA256SUMS`, and extract it. Use `./myrix` in place of `myrix` below, or place the executable on your `PATH`.

The archive includes the runtime and Web assets, but not herdr, Git or the agent CLIs. Linux still needs compatible system libraries. macOS binaries are ad-hoc signed, not notarized; consult the release notes for platform requirements.

## First run

### 1. Configure the coordinator

A fresh installation uses `~/.myrix`. If `~/.herdr-agent` already exists, myrix reuses it instead. Use that existing directory when upgrading, or pass `--state-dir /absolute/path` consistently to select another one.

Create the state directory and save the following as its `config.toml`. Replace the three `YOUR_…` values with your provider's settings; `base_url` must be an explicit API version root, such as `https://api.openai.com/v1` for OpenAI.

```toml
[tasks]
enabled = true
bypass = false

[ai]
enabled = true
provider = "openai-responses"
base_url = "YOUR_API_BASE_URL"
model = "YOUR_MODEL_ID"
api_key = "YOUR_API_KEY"
```

For Anthropic-compatible services, use `provider = "anthropic-messages"` and the corresponding API version root. A Chat Completions-only endpoint is not sufficient. Protect the state directory and credential files, for example with directory mode `0700` and file mode `0600`.

**The sample deliberately disables Bypass. The application's actual default is `true`.** Bypass starts native agents with their permission/sandbox bypass flags; enable it only for a trusted execution environment. Task orchestration and AI are both disabled unless explicitly enabled.

The [configuration example](<deploy/config.example.toml>) lists additional settings. Project registration can wait until the Web UI is running; no Jev key is needed for the normal pi workflow.

### 2. Connect Feishu

With `tasks.enabled = true` already configured, run:

```sh
myrix setup
```

Follow the authorization instructions, then send a real private message to the bot and click its **“确认连接”** confirmation button. Setup saves the app credentials and adds the verified owner to the allowlist. An empty allowlist grants no Feishu access.

Setup normally reuses an existing app. To select an existing app explicitly or add missing task/group permissions:

```sh
myrix setup --app cli_YOUR_APP_ID
myrix setup --update-permissions
```

Stop any running myrix instance before setup. Do not register a replacement app just to repair permissions. Exit code `3` means credentials were saved but message/card verification is incomplete.

For existing task-enabled apps, ensure the Feishu developer console subscribes to `task.task.update_user_access_v2` and **publish the app version** so manual task completion reaches myrix. Setup's scope check does not verify console event subscriptions.

### 3. Start the service and register a project

```sh
myrix doctor
myrix serve --open
```

The local UI defaults to **http://127.0.0.1:18790**. Register an existing project, choose its directories and default agent, and check the Bypass setting before starting work. Saving a project initializes Git in its first directory if it is not already a repository.

The first directory is the primary working directory; additional directories are passed to the native agent separately. Once initialized, the project catalog and Bypass setting live in SQLite—edit them through the local UI, not by changing their original TOML seed. Restart after changing model or Jev connection settings.

`doctor` checks configuration, host integration and Feishu permissions. It does **not** make a model request or prove that a CLI is logged in; run a small real task to verify the complete chain.

### 4. Give the bot a task

These are natural-language examples, not special command syntax. Replace `demo` with your registered project:

| Goal | Example message in Feishu |
| --- | --- |
| Compare approaches | “Create a discussion for demo. Have Claude and Codex compare two caching strategies. Do not modify files.” |
| Deliver a design document | “Discuss the caching design and save the agreed proposal to docs/DESIGN.md. Do not implement application code.” |
| Implement | “Create a development task for demo: implement the agreed caching design, with Codex implementing and Claude reviewing.” |
| Fix a bug | “Create a bug-fix task for demo: reproduce the login timeout, fix it and review the change.” |
| Check progress | “What is the current progress? What is blocked, and what has actually been verified?” |
| Accept delivery | “I accept this task as complete. Keep the task group, but close its execution sessions.” |

Create new tasks in private chat, with **1–8 Claude/Codex participants** per task. A task group is bound to its task; use it for follow-up requirements and questions, not for creating another task. One Feishu bot represents the participants—it does not create separate Claude and Codex bot accounts. Current workflows keep intermediate discussion internal and send necessary start/blocking notices and final delivery; ask for progress when you need it.

**A queued task is not a started agent, a delivered report is not an accepted task, and an idle terminal is not proof of completion.** Review the report and explicitly confirm acceptance.

## Defaults and safety boundaries

| Area | Behavior to know |
| --- | --- |
| Completion | Confirmed completion normally closes the task's herdr execution sessions and dissolves its group. Request group retention explicitly, or configure `runtime.group_retention = "retain"` for new tasks. Keeping execution also requires keeping the group when one exists. |
| Pause vs. interrupt | Pause stops subsequent scheduling; it does not necessarily stop an agent already running. Ask to interrupt a specific participant when needed. |
| Working directories | Tasks use shared project directories by default. Explicit worktree mode isolates only the first directory; extra directories remain shared. Closing a task does not delete project code or worktrees. |
| Permissions | Bypass is not an OS sandbox, and disabling it does not make myrix a sandbox. Discussion/read-only instructions and workflow checks do not replace native filesystem permissions. |
| Verification | Only locally configured project `verify` commands are run by myrix's verifier. They execute with the service account's privileges in the task's working directory and may run scripts modified by agents. Enable them only for trusted workspaces. Reports distinguish command results, independent agent review, self-report and checks not run. |
| Recovery | State and receipts survive restarts. Unknown external outcomes are not blindly replayed; they require reconciliation and may need your decision. Stopping myrix itself does not destroy herdr sessions. |
| Local Web | Loopback-only, intended for a trusted local user—not a public or multi-user Web service. It has no business chat, participant controls or acceptance buttons. |

### Optional Jev integration

Jev is **not required** for task coordination. If you configure a Jev key:

- `jev.ingress_enabled` defaults to **false**. Enabling it sends eligible private-message text and registered project names to Jev for classification.
- `jev.approvals_enabled` defaults to **true** and takes effect when AI is enabled and a Jev key is present. It sends the visible terminal screen and task/user requirements to Jev for automatic native-menu handling, with restricted pi fallback. Set it to `false` and restart to keep ordinary approvals manual; the separate scoped startup-trust flow remains.
- Automatic menu handling does not accept a task on your behalf or resolve missing credentials and user business decisions.

Review these data flows before adding a key. See [native approval behavior](<docs/native-approval-recovery-2026-09-29.md>) for details. Configured AI providers also receive the conversation and task context needed for coordination; local execution does not mean all data stays offline.

## Daily operation

| Command | Purpose |
| --- | --- |
| `myrix serve --open` | Connect Feishu and open the local UI; `serve` is the default command. |
| `myrix serve --no-config-ui` | Run without the local Web listener. |
| `myrix serve --config-listen 127.0.0.1:18791` | Select a different loopback address/port. |
| `myrix configure --open` | Open configuration/history without connecting Feishu. Uses the same state lock; existing local task reconciliation can still run. |
| `myrix status` | Inspect the state lock/process and available stop/restart guidance. |
| `myrix doctor` | Run read-only configuration and host diagnostics. |
| `myrix version --json` | Show the installed command's version and build identity. |
| `myrix debug ls` | List native agents for diagnosis; `debug screen PANE` and `debug transcript PANE` are also read-only. |
| `myrix help` | Show all commands and options, including `--state-dir` and `--json`. |

In the bot's **main private conversation**, send exactly `/clear` to archive the current pi session and select a new one. It works without a model response and preserves task state, history and native sessions. Success is acknowledged with `CLEAR_NEW_SESSION_OK`. It is not supported in groups. Long pi contexts also compact automatically without deleting original history.

### Troubleshooting

- **Already running:** inspect `myrix status` and stop the actual foreground process or service before setup, migration or another instance. Do not delete a live lock to force a second process.
- **Bot cannot connect or task completion is missing:** check `doctor`, owner authorization, required scopes and published Feishu event subscriptions.
- **Agent starts but makes no progress:** check CLI authentication, herdr hooks, directory-trust prompts and the herdr server's environment. Ask for the task's actual blocking state rather than repeatedly submitting it.
- **Model settings are invalid:** stop the service, use `myrix configure --open` to repair supported configuration errors, then restart. A model failure does not silently forward your message to a terminal.
- **Need logs:** myrix prints its log location at startup. Service logs are under the selected state directory's `log/`; see the [logging guide](<docs/local-service-logs.md>). `status` holding a lock is not a health check, and the installed command's version may differ from a still-running process.

For background services, review the [macOS installer](<deploy/install.sh>) or the [Linux myrix unit](<deploy/myrix.service>) and [herdr unit](<deploy/herdr-server.service>). Check their executable paths, environment and state-directory settings before installation; these are not required for the foreground quick start.

### Upgrades and legacy migration

Stop the service and its automatic restart, back up the state directory, update the package or binary, then restart with the **same state directory**. Never run two event consumers for the same Feishu app.

For an old Go installation, preview the import before committing it:

```sh
myrix migrate --state-dir /absolute/state --dry-run
myrix migrate --state-dir /absolute/state
```

Migration backs up legacy JSON and imports it into SQLite; normal startup also performs the idempotent import. There is no automatic reverse migration. Restoring old JSON alone cannot undo external tasks, groups or sessions created since the upgrade. See the [migration design](<docs/node-pi-design.md>) and [release guide](<docs/releasing.md>).

## Development

Source builds require **Node.js ≥24.13.0**, npm, Python and a C++/make toolchain for the native `fs-ext` dependency; macOS needs Command Line Tools.

```sh
git clone https://github.com/hewenyu/herdr-agent.git
cd herdr-agent
npm ci
npm run check
npm run binary
npm run smoke
./dist/myrix version --json
```

- `npm run check`: source-size and module-boundary checks, TypeScript, Biome with zero warnings, and automated tests.
- `npm run build`: bundle the application and Web assets. `npm run binary` includes that build and produces the standalone executable for the current platform.
- `npm run smoke`: validate the standalone package with isolated fixtures. It does not prove a real Feishu/model/herdr deployment works.
- `npm run dev -- help`: run the CLI from source. Use a built application to test embedded Web assets.

Build natively for each supported target. Packaging also requires the complete license file from the Node distribution; if the build reports it missing, use an official Node distribution with that file intact. The root [package manifest](<package.json>) is private and is not the published npm launcher package.

## Further reading

Most detailed design and validation documents are in Chinese. Dated records describe their own implementation stage; they are not release-wide guarantees.

| Topic | Document |
| --- | --- |
| Configuration options | [Configuration example](<deploy/config.example.toml>) |
| Product behavior and boundaries | [Business scenarios](<docs/current-business-scenarios.md>) |
| Current task coordination | [Persistent task Leader](<docs/durable-task-leader-context.md>) |
| Workflows, reports and delivery | [Workflow v3](<docs/workflow-natural-collaboration-2026-09-28.md>) · [Later pi/recovery changes](<docs/pi-leader-iteration-2026-09-29.md>) |
| Native agent startup and recovery | [Agent lifecycle](<docs/agent-lifecycle-readiness.md>) |
| Automated vs. live evidence | [Acceptance mapping](<docs/acceptance.md>) · [Live validation matrix](<docs/live-validation.md>) |
| Contributing and releases | [Code-quality guide](<docs/code-quality.md>) · [Release operations](<docs/releasing.md>) |

Current message input supports text and text inside rich posts. Image understanding, speech transcription and general-purpose artifact hosting are outside the current scope. Report attachments and scoped local report downloads are supported.

## License

[MIT](<LICENSE>). Release archives also contain third-party license notices; retain them when redistributing. See the [license packaging guide](<licenses/README.md>).
