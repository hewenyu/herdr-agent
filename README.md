# herdr-agent

**English** · [简体中文](README.zh-CN.md)

Your coding agent stops mid-task and asks for permission, and you are not at the keyboard.
herdr-agent pushes that question to Feishu (飞书) — the real dialog text, with its real options as
buttons — and your tap, or a line you type, goes back into the terminal so the agent carries on.
It drives `claude` and `codex` through [herdr](https://herdr.dev), and it is single-user by design:
one machine, one Feishu app, one `open_id` on the allowlist.

With optional task management enabled, a message to the bot can create a Feishu task, start a new
agent in a dedicated herdr workspace, and open a private group for that task. Local configuration
connects each project to one or more local directories and selects `codex` or `claude`.
Enable the [AI task entry point](#control-tasks-with-natural-language) to create tasks, check progress
and add instructions by talking naturally to this project's bot.

The bridge dials out over Feishu's WebSocket, so a laptop behind NAT works without a public callback
or tunnel. The AI entry point calls the model API address you configure, using your own API key.

## Before you start: herdr

**[herdr](https://herdr.dev) is the prerequisite.** It is the terminal that runs your agents; this
bridge only talks to it. Install and start it by its own instructions — that is not this project's
job and this README does not repeat it:

```sh
brew install herdr                          # or: curl -fsSL https://herdr.dev/install.sh | sh
```

Then follow [herdr's quick start](https://herdr.dev/docs/quick-start/) until you have `herdr server`
running. To control an existing agent, also start `claude` or `codex` in a pane. The optional task
workflow below starts its own agents, but still requires a running herdr server and the relevant
agent CLI installed and authenticated on this machine.

Two more things on the herdr side, because both are load-bearing here:

- `herdr integration install claude` / `herdr integration install codex`. For codex, press `t` inside
  it once to trust the hook, or herdr never learns the session id and transcript mirroring has
  nothing to follow (G8).
- herdr **0.8.0 or newer**. Protocol 19 is the minimum these wire types were measured against.

You also need a Feishu account. `herdr-agent setup` prepares the app for you — a new one, or one you
already have — and the [manual console checklist](#feishu-console-checklist--the-manual-fallback) is
the supported fallback.

The existing chat bridge was measured on macOS, and the ready-made service units are launchd. The Go code
is portable and Linux binaries ship; `serve` is an ordinary foreground process anywhere.

A couple of things on the herdr side fail silently rather than loudly — they are herdr's to
configure, not this bridge's, so `herdr-agent doctor` names each one and prints the fix instead of
this README teaching you how to run herdr. [Troubleshooting](#troubleshooting) has the mechanisms.

## Install

Two ways, both supported.

**Download a release.** Grab the asset for your machine from the
[Releases page](https://github.com/hewenyu/herdr-agent/releases/latest) — `darwin_arm64` for Apple
Silicon, `linux_arm64` or `linux_amd64` for Linux — unpack it, and put `herdr-agent` anywhere on your
`PATH`. Each release also carries `SHA256SUMS` if you want to verify, and the release notes have the
exact commands.

On macOS these binaries are unsigned, so Gatekeeper refuses a downloaded one and says the developer
cannot be verified. That looks like a broken project and is not:
`xattr -d com.apple.quarantine ~/.local/bin/herdr-agent`.

**Or build it**, with Go 1.24 or newer:

```sh
go install github.com/hewenyu/herdr-agent/cmd/herdr-agent@latest
```

Either way, `herdr-agent version` tells you which build you actually have.

## Quick start

herdr is running and an agent is alive in one of its panes. Three commands:

```sh
herdr-agent setup     # prepare the Feishu app: one confirmation page, two taps on your phone
herdr-agent doctor    # check the machine before you trust it
herdr-agent serve     # run the bridge
```

Then message the bot `/ls` from your phone, tap **Select**, and type.

`setup` needs no flags. It grants the scopes, subscribes the events, writes `~/.herdr-agent/.env` at
mode 0600, fills in the allowlist and `notify_chat_id` — and then makes you send a real message and
press a real button, because every one of those settings fails the same invisible way when it is
wrong. [More about setup](#more-about-setup).

`doctor` looks for what breaks this silently, on both sides. A healthy install still has a couple of
non-PASS results, so read them rather than counting them; [Troubleshooting](#troubleshooting) says
which are expected.

With task management disabled, the bridge only carries conversations with agents you started.
Enable the [task workflow](#feishu-tasks-and-project-repositories) to create an agent from a message;
select a configured project, or explicitly ask to create a new project.

### Keep it running

`serve` is a foreground process; put it under whatever supervisor you already use, or use the units
in `deploy/`. Those live in the git repository and not in the release archive, which holds the binary,
the two READMEs and `LICENSE` and nothing else — so clone it:

```sh
git clone https://github.com/hewenyu/herdr-agent && cd herdr-agent
deploy/install.sh          # macOS: installs two LaunchAgents and boots them
herdr-agent doctor         # verify after install
```

No build is needed for this. `install.sh` bakes absolute paths into the units because launchd has no
useful `PATH`, and it finds the binary you already installed with `command -v herdr-agent`; pass
`HERDR_AGENT_BIN=/path/to/herdr-agent` if it should use a different one.

| job | what it runs |
|---|---|
| `com.hewenyu.herdr-server` | `herdr server`, from a **scrubbed** environment (`env -i` plus `HOME`, `PATH`, `SHELL`, `TERM`, `LANG`) |
| `com.hewenyu.herdr-agent` | `herdr-agent serve`, the bridge |

`install.sh` is idempotent: it rewrites both unit files, boots the jobs out and back in, and leaves
an existing `config.toml` alone. `--bridge-only` skips the herdr server if you would rather start it
yourself. On Linux the same pair ships as systemd **user** units, `deploy/herdr-agent.service` and
`deploy/herdr-server.service`. `install.sh` drives launchctl, so on Linux it writes nothing and prints
the copy-and-enable sequence instead — including `loginctl enable-linger "$USER"`, without which both
units stop when you log out and nothing starts at boot. The environment scrub is carried across there
too, because it is load-bearing (G7), not decoration.

The scrub has two consequences worth knowing before an agent surprises you with them: no pane gets
`SSH_AUTH_SOCK`, so `git push` over SSH inside an agent stops on a passphrase prompt; and no pane
gets `XDG_CONFIG_HOME`, so if you set that in your shell, your terminal's `herdr` CLI and this
server will use two different sockets. Both are commented, with fixes, at the top of
`deploy/com.hewenyu.herdr-server.plist`.

Every knob lives in `~/.herdr-agent/config.toml`, and `deploy/config.example.toml` documents each one
with its default and the trade-off it makes. Credentials are not among them: that file has no field
for a secret, so one cannot end up there by accident. The two basic chat settings are
`feishu.allowed_open_ids` (mandatory) and `feishu.notify_chat_id` (empty means no proactive pushes
for agents outside the task workflow). Managed tasks send their notifications to their own groups.

### More about setup

`setup` needs no flags. It prints a confirmation link, opens it when this machine has a browser, and
waits. On that page you have two equally good options: create a new app — the name arrives pre-filled
with `herdr-agent` — or **pick an app you already have**, because the page lists your tenant's apps
too. Pressing 确认 **grants** the four scopes to whichever one you chose, subscribes
`im.message.receive_v1` and requests the `card.action.trigger` callback. That is the whole protocol:
the registration blob carries a preset, scopes, events and callbacks, and has no field for anything
else (G18).

Two things it therefore cannot set, and that the app nevertheless arrives with, are worth naming
separately — both are measured outcomes rather than steps anybody performed (G18):

- **Events already being delivered over the long connection.** A real direct message from a phone
  reached the bridge with zero console interactions. Nothing in the protocol selects the delivery
  mode, so this is something `setup` observes rather than something it configures: that is exactly
  why it ends in a real round trip instead of a claim, and why the
  [manual checklist](#feishu-console-checklist--the-manual-fallback) still names 订阅方式 → 长连接 as
  a setting you confirm by hand.
- **A published version.** The app's `online_version_id` was already non-empty before any publish
  step of ours. **So basic setup needs no additional publish step** — which is the opposite
  of what the console flow teaches, and worth stating plainly, because sending you to look for a
  publish button you will not need ends with you concluding you configured something wrong. Later
  additions such as task permissions still require their own approval and publication.

Nothing less than both round trips is treated as success:

| exit | meaning |
|---|---|
| 0 | verified end to end: your message arrived and your button press came back |
| 3 | the app exists and its credentials are on disk, but a round trip was not proven. A numbered checklist with one URL per item says what is left; re-running `setup` skips registration and re-verifies |
| 1 | nothing usable was produced |

Re-running `setup` is the intended repair path rather than a second install: credentials already
anywhere the bridge reads them are adopted and verified, so the re-run opens no page, makes no app,
and tells you which of the two round trips is broken. Three flags exist for what it cannot infer,
and none is needed on a first run:

| flag | when |
|---|---|
| `--app cli_…` | use **that** app. If a file the bridge reads already holds its secret, no page is opened at all. If not — Feishu shows an app secret once, so that is the normal case for an app you made by hand — the confirmation page opens *for that app*, re-grants what the bridge needs, and hands back a usable secret. No new app is made either way |
| `--update-permissions` | open a fresh confirmation URL to add task and task-chat permissions to the existing app, including when its credentials are already saved; optionally pin it with `--app cli_…` |
| `--reregister` | create a **second** app on purpose. The one you have stays exactly as it is, and afterwards `~/.herdr-agent/.env` points at the new one |
| `--yes` | never prompt: for scripts and launchd. Two configured apps and no `--app` is an error naming both files, because a wrong guess points the bridge at a bot you never messaged and the symptom is silence. Waiting for your message or your button press is not extended by any flag; the checklist prints and the run ends at exit 3 with the app and its credentials on disk |

**Stop the bridge before running setup.** Feishu's long connection is cluster mode — up to 50
connections per app, events distributed randomly between them — so a second client on the same
`app_id` does not fail cleanly, it silently takes a random share of your real messages (G15). `setup`
takes the same single-instance lock `serve` does and refuses rather than sharing. Once `install.sh`
has run, the bridge is that second client:

```sh
launchctl bootout gui/$(id -u)/com.hewenyu.herdr-agent
herdr-agent setup
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hewenyu.herdr-agent.plist
```

One caveat on the mechanism: the device-authorization endpoint `setup` uses is **undocumented**. It
appears nowhere on open.feishu.cn. It can change or vanish without notice, which is why the manual
checklist below is a supported path and not a footnote.

## Feishu tasks and project repositories

Task management is optional and defaults to off. Keep your existing Feishu app, credentials and
allowlist. Enable `[tasks]` in `~/.herdr-agent/config.toml`, grant the permissions below, then start
`herdr-agent serve`. Its local configuration page is available at **http://127.0.0.1:18790/**.

The page lets you add or edit projects, choose a default project and agent, and add multiple folders
in order. The first folder is the working directory; the remaining folders are passed to Codex or
Claude with `--add-dir`. The primary directory is initialized as a Git repository when saved or
started; existing repositories and worktrees are preserved. Additional directories need no Git
repository. Git must be installed locally. Saving project
settings takes effect for new tasks immediately; running tasks retain their original directories
and agent mode.

Before starting the bridge, you can open the same page with:

```sh
herdr-agent configure --open
```

This standalone command holds the same instance lock as `serve`. If the bridge is already running,
open its configuration URL instead. `serve --config-listen 127.0.0.1:18791` changes the local address;
`serve --no-config-ui` disables the page. The frontend and its API are served by the Go binary.
Go's `embed` packages the HTML, CSS and JavaScript into the executable at build time, so the
downloaded binary provides the page without Node.js or a separate assets directory. CI checks
the page, styles, scripts and project API with only the binary in an empty directory; the release
workflow repeats this check using the packaged Linux amd64 binary before publishing.

The global **Bypass** checkbox defaults to on. It starts new Codex agents with
`--dangerously-bypass-approvals-and-sandbox` and new Claude agents with
`--dangerously-skip-permissions`, skipping their normal execution approvals. Unchecking it starts
new agents with normal permission handling. `tasks.bypass = false` selects the initial off setting
before the local catalog is saved; subsequent checkbox changes persist in the catalog.

You can also seed projects in TOML:

```toml
[tasks]
enabled = true
bypass = true
default_project = "herdr-agent"
poll_interval = "30s"

[tasks.projects.herdr-agent]
directories = ["~/code/github/herdr-agent", "~/code/github/herdr"]
agent = "codex"

[tasks.projects.website]
path = "~/code/website" # legacy single-folder form remains supported
agent = "claude"
```

The first local save writes `~/.herdr-agent/projects.json` (mode 0600), containing the complete
project catalog, default project and Bypass setting. This file then takes precedence over the TOML
project seed; `[tasks].enabled` and `poll_interval` still come from TOML. Use the local page for later
project changes. An empty catalog is allowed during setup. With projects configured,
`default_project` must name one of them; the page selects the first project automatically.

Project names accept letters, including Chinese, digits, `_` and `-`, with no spaces or slashes.
`~/` expands to the local OS account's home. An omitted `agent` defaults to `codex`; only `codex` and
`claude` are supported. `directories`, when set, is the full ordered list and supersedes legacy
`path`. Polling defaults to `30s` and must be positive. A missing folder can be repaired through the
page after startup; starting a new task requires all its configured folders to exist.

Creating a task normally reuses a configured project and creates no directory. Only an explicit
**new project** request, from the page or the AI entry point, creates
`~/herder-agent-code/<project-name>/` and registers it. This is the home of the OS account running
the bridge, not a separate home for each Feishu user. New projects automatically run `git init` in
the primary directory; no commit or worktree is created automatically. Existing directories are never silently adopted
by the new-project operation. Deleting project configuration preserves its files and running tasks.

Each task gets its own **herdr workspace and pane**, but uses the configured directories directly.
Two tasks using the same folder share its working files. Configure separate existing Git worktrees
when concurrent edits need isolation. Chat messages choose project names and cannot supply arbitrary
local paths. Model API credentials are still configured through TOML/environment as described below;
the local page manages projects and Bypass.

In the app console, grant the following **in addition to** the basic chat permissions from setup:

| permission | purpose |
|---|---|
| `task:task:write` | create, read and update tasks as the application |
| `task:task:read` | subscribe to real-time task updates; the subscription API requires read separately from write |
| `im:chat:create` | create a private group containing you and the bot |
| `im:chat:delete` | dissolve that group when you destroy the session |
| `im:message.group_msg` | receive your task-group messages without an @ mention |

For an existing app, stop the bridge and run `herdr-agent setup --update-permissions`. It opens a
fresh confirmation URL with the task permissions, even when credentials already exist. Use
`--app cli_…` to pin the app if needed. After confirmation, credentials are saved immediately and
the usual message/button verification follows; a different returned app ID is rejected. Restart
`herdr-agent serve` afterwards. You can also apply the changes through your tenant's approval and
app publication process. Editing `config.toml` does not grant scopes, and the basic `setup`
message/button checks do not verify this task workflow.
The bot owns the groups it creates. Each task assigns both you and the application, with completion
mode `2` (any assignee can complete), so it appears in your task panel and falls within the app's
subscription scope. The bridge requests Task v2 subscriptions and receives
`task.task.update_user_access_v2` through its existing WebSocket. Polling reconciles task status
when events are unavailable, a subscription fails, or the connection was interrupted.

A typical task goes through these steps:

1. In the bot's entry chat, send `新建任务：修复登录问题` for the default project, or
   `/new herdr-agent claude Fix the login failure` to select a project and override its default agent.
2. The bot creates the Feishu task and private group, creates a herdr workspace, and starts the agent.
   Follow the group link to continue the conversation; each group stays bound to its own task.
3. The initial request is sent once the agent is ready. Answer startup or permission prompts using
   the existing screen cards. Subsequent messages, agent replies and progress stay in the task group.
4. With AI enabled, ask for progress or send implementation feedback directly in the group, without
   an @ mention. Startup, execution, blockers and review notices are also sent there.
5. In the task group, send `/关闭项目`, then reply `确认关闭` after reading the notice. The bridge confirms
   Feishu completion, saves the result, announces closure, then closes the owned pane and group.
   **Feishu does not retain that group's chat history.** Repository files and the task are retained.
   To retain the group, say so explicitly or use `/task complete`; reopen before further work.

`/task close` combines accepted completion and session cleanup. Completion and destruction also
remain available separately. Completing a task does not stop the process or delete the
group, and destroying a session does not mark unfinished work complete. A destroyed session cannot
be reopened; create another task to continue. The ordinary `/close` command only clears the selected
agent in the entry chat and does not destroy a task session.

| message | result |
|---|---|
| `/projects` | list configured project names, directories and default agents |
| `/new <project> [codex\|claude] <request>` | create a task, optionally overriding the project's agent |
| `新建任务：<request>` | create a task using the default project and agent |
| `/tasks` or `现在有哪些任务在进行？` | list your tracked active tasks, progress and links |
| `/tasks all` | include completed and destroyed task records |
| `/task complete [id]` / `/task reopen [id]` | synchronize completion or reopening with Feishu |
| Task group `/关闭项目` → `确认关闭` | show a notice, then complete the task, close its agent and automatically dissolve its group |
| `/task close [id]` | accept the result, confirm task completion and close its session/group |
| `/task destroy [id]` | close the task pane and dissolve its group |
| `/task retry [id]` | retry a recoverable failure after fixing its cause |
| `/screen` / `/stop` in a task group | inspect that task's screen or interrupt its agent |

The task ID is shown in `/tasks`; omit it inside that task's group. An interrupted operation whose
outcome is unknown is reported for inspection, rather than automatically creating another resource
or sending the initial request again. `/task retry` does not replay such an ambiguous operation.

Feishu's task completion state is `todo` or `done`. Execution states such as running, waiting for
input and awaiting review are written into the **ordinary task description**, together with the
project, agent, progress, latest reply, update time and group link. An agent's `idle` or `done`
status only means its current turn ended; it does not automatically complete the Feishu task.
The description is a field of the Task API resource, accessible under normal task permissions.
A Feishu AI assistant with access to that resource can use it for summaries, but this does not
ensure that every Feishu client or AI tool exposes task access. With the AI entry point below, this
project's bot can query task state directly without waiting for task descriptions to be indexed. The bot's `/tasks` query works independently of client AI integration.

The new task workflow still needs end-to-end verification with your real app and agent setup.
In particular, a pane created entirely in the background may need a terminal attached once to give
it sufficient width for herdr to recognize startup/trust dialogs. Inspect `/screen` and handle the
actual prompt before relying on unattended starts. The Bypass setting controls agent execution
approvals; it does not replace initial agent setup or start the herdr server for you.

## Control tasks with natural language

The Go AI entry point uses [Eino](docs/ai-framework.md) to interpret messages to your existing Feishu bot and call controlled task
management tools. Configure your own model API, model name and key. It uses the existing Feishu app,
project-to-directory mappings, and Codex/Claude environment described above.

Enable `[tasks]` and configure your projects, then add to `~/.herdr-agent/config.toml`:

```toml
[ai]
enabled = true
provider = "openai-responses"
model = "your-provider-model-id"
base_url = "https://your-model-service.example/v1"
timeout = "2m"
```

`provider` supports only `openai-responses` (default) or `anthropic-messages`. Supply
your service's model ID and version-root base URL: `https://api.openai.com/v1` for Responses requests
to `/responses`, or `https://api.anthropic.com/v1` for Anthropic requests to `/messages`. The model
must support tool calling. The base URL must not contain credentials, query parameters or fragments.
Use HTTPS; HTTP is accepted only for loopback hosts such as `http://127.0.0.1:8080/v1`.
The timeout must be positive and no longer than `10m`; its default is `2m`.

Put your model API key in `~/.herdr-agent/.env`, then restart `herdr-agent serve`:

```dotenv
HERDR_AGENT_AI_API_KEY=your-model-service-api-key
```

The key is read only from the environment or `.env`, never from `config.toml`. The process environment
takes precedence, including when explicitly empty. This key belongs to your chosen model service;
the Feishu app still uses its existing `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. The entry point runs
inside the Go service without an additional JavaScript runtime.

In the bot's **entry private chat**, ask naturally:

- “List the available projects and tell me which tasks are in progress.”
- “Create a task in herdr-agent to investigate login failures and verify the fix.”
- “Create a new project named demo-api and build a health-check endpoint.”
- “How are my tasks going?”

Continue implementation feedback, progress queries and acceptance in the corresponding task group.

The bridge checks the actual message sender against the allowlist and verifies task ownership.
The model can use controlled tools to select configured projects, query tasks, create sessions, add
instructions, complete, reopen, retry or destroy a session. `herdr_create` uses `new_project=true`
only when the user explicitly requests a new project; a new task alone reuses an existing project.
Tool arguments cannot choose another
operator or an arbitrary local path. Conversation content, required task summaries and tool results
are sent to the configured model service; the entry point does not upload the whole code repository
to interpret a request.

Each new task has a Feishu task record and a private task group. The group assistant is restricted
to that task: progress reads its current record, feedback goes to its Codex/Claude agent, and explicit
acceptance with closure completes the task and closes its session. Negations and future conditions
are not acceptance. Startup confirmations and permission cards also stay in the group.

Progress and operation acknowledgments are rendered from actual records and tool receipts. Old AI
replies are not evidence of execution. Replies distinguish agent claims from verified facts and show
the configured output directory and its current top-level entries. An agent turn ending does not
mean user acceptance; an empty directory or unsent initial prompt cannot prove generated output.

First ask the bot to list projects and ongoing tasks to check model tool calls. Then create a test
task that changes no files and replies only `FEISHU_AI_OK`. Check the real task, task group, local
execution pane and reply before testing completion, reopening and explicit destruction. Local tests
do not replace full verification with your model API, Feishu app and agent environment.

## Using it from your phone

The private-chat selection flow below applies when `[ai]` is disabled. With AI enabled, plain
private messages go to the task assistant; use the corresponding task group to talk directly to a coding agent.

In the p2p chat with the bot, send `/ls`. You get a **picker card**: one row per agent, blocked ones
first, each row showing kind, directory, pane id, status and what the agent says it is doing.

```
🔴 claude · herdr-agent           [ Select ]      [ Screen ]
   w1:p1 · blocked · Create hello.txt with touch
▶ ⏳ codex · api                  [ ✓ Selected ]  [ Screen ]
   w1:p2 · working · refactor the router
```

Tap **Select**, and then just type. Plain text goes to the selected agent — no pane id, no
long-press, no command. The card is re-rendered in place on every selection, so switching agents is
one tap on a card you already have rather than another `/ls`. `▶` marks the current row.

**The selection lasts until you send `/close`.** Not twelve hours, not until the bridge restarts, not
until the agent does something: one deliberate tap opens the channel and one deliberate command
closes it, and there is exactly one answer to "why am I being asked to pick again?" — because you
asked to be. In particular it survives all of these, which used to end it:

- `/clear` or a compaction inside the agent. It is the same agent in the same directory, so your
  typing still goes there; you are told once that it no longer remembers what you discussed.
- the agent exiting and being started again in the same pane on the same job. While it is away you
  get "nothing was sent, this chat is still aimed at claude · herdr-agent · w1:p1" instead of a
  chooser, and typing resumes the moment it is back.
- the bridge being killed and restarted, which happens routinely.
- a night, a weekend, a holiday. After twelve quiet hours the next message is still delivered, with
  one line saying how long ago you picked — said once, so a chat in daily use never sees it.

**What you anchor is the window.** herdr never recycles a pane id — the public pane number only goes
up, is not released when a pane closes, and the counter is persisted across restarts — so `w2:p2`
names one window for the life of the install. That is why nothing else needs to be checked, and why
checking anything else was a mistake: on a real machine two agents can share a directory
(`w2:p1 codex` and `w2:p2 claude`, both in `~/code/yuebanhome`), and two claudes in one project match
on kind as well. The pane is the only thing that tells them apart, and it always will.

The one thing that still refuses to deliver is a **different program in that window** — you quit
claude in `w1:p1` and started codex there. The window outlived the agent. Nothing is sent, you are
told what changed, and the aim stays where you put it until you move it.

If you restart an agent in the same window on a *different* project, the message is delivered — it is
still your window — and one line tells you it moved: "claude in w1:p1 is now working in ~/other, you
aimed at it while it was in ~/project". Reported, not refused: the directory herdr reports also
follows a Bash tool call into a subdirectory, so refusing on it would drop messages in the middle of
a task.

**Reply to a message to override the selection for that one message.** That is how you drive several
agents from one chat while still having a default: the reply routes to the agent that message was
about, and does not change what plain typing is aimed at. (Mirrored agent turns are streamed, and
Feishu gives a streamed message no id the bridge can register, so replies to those cannot be routed —
you are told so rather than left guessing.)

Slash commands stay available underneath as an escape hatch:

| command | what it does |
|---|---|
| `/ls` | the picker card: every agent, status, pane, kind, cwd, title |
| `/card <pane>` | push that pane's current screen as an actionable card |
| `/say <pane> <text>` | send text to that agent through the safe path |
| `/stop <pane>` | send `esc` — the safe way out of a dialog |
| `/mirror <pane> on\|off` | follow that agent's transcript in the chat (default off) |
| `/close` | clear the selected agent; does not stop it or close its pane |
| `/doctor` | the same checks as `herdr-agent doctor` |
| `/help` | this table |

A slash command that does not parse is answered with an error and is **never** demoted to free text:
`/stpo w1:p1` delivered as prose to a blocked agent would be an approval (G1).

### The blocked card

When an agent stops and waits, you get a red card carrying its kind, directory and task title, the
dialog text itself in a code block, and one button per option the dialog actually offers — read off
the screen, not hardcoded, because the count varies by agent and version. Every numbered button is
styled neutrally, including `1. Yes`: the loudest thing on a card should not be the approval. Below
them, styled as the dangerous-looking one, is `Esc · back out` — which is the safe key, and looks
alarming on purpose because backing out of a dialog is the choice you can always take back.

Press one and the card is immediately rewritten into a grey, buttonless version stating who pressed
what, when, and what happened. When an agent finishes, you get a green card showing **what the agent
said** — from its own transcript, not a screenshot of the terminal — with the full screen one tap
behind `Screen`.

If you type to an agent that is busy, it goes straight through. A working agent has an input queue of
its own — the words land in its composer and are submitted when the turn ends — so the bridge holds
nothing back, and a run of sentences arrives in the order you sent them rather than one at a time.

### On the machine

The same capabilities are a CLI, which is also the acceptance surface for the control layer:

```
herdr-agent setup                   register a Feishu app, or reuse one, and prove it works
herdr-agent doctor                  check the things that break the bridge silently
herdr-agent ls                      list every agent herdr can see, with its status
herdr-agent dialog <pane>           print what the agent is asking
herdr-agent tail <pane> [-n 18]     print the last lines of the visible viewport
herdr-agent key <pane> <key>        answer a menu, through the full guard check
herdr-agent say <pane> <text...>    send prose through the safe path
herdr-agent transcript <pane>       print the agent's native transcript file path
herdr-agent watch                   stream status transitions, one timestamped line each
herdr-agent serve                   run the bridge until SIGINT or SIGTERM
herdr-agent version                 print the version, commit and build date stamped into this binary
```

## The safety model

You are about to let a chat app press keys in your terminal. Four rules make that defensible.

**Prose never reaches a blocked agent.** herdr's `agent.prompt` pastes your text and then presses
Enter, and a permission dialog is a menu rather than a text box — so the paste is discarded and the
Enter selects the highlighted default, which is usually `1. Yes`. Measured (G1): sending "absolutely
not, do NOT run this command" to a blocked claude *created the file it was refusing*. The bridge
therefore sends `esc` first, waits for the agent to settle, and only then delivers your words. It
also never claims more than it knows: `agent.prompt` returns success once bytes reach the PTY queue,
so a message it could not find on screen afterwards is reported as sent-but-not-confirmed (G3), not
as delivered.

**Old cards are disarmed.** Feishu messages never expire, and a button tapped three days later still
presses a key into whatever that pane is running today — measured (G17). Every button therefore
carries the pane, the agent kind, its native session id and the state sequence it was minted for, is
single-use through a nonce, and the card is rewritten into a static "handled" one the instant it is
used. A stale press sends no keystroke at all and tells you why. Buttons that cannot reach a keyboard
— `Select`, `Screen` — skip all of that, because there is nothing to disarm.

**The allowlist is mandatory and default-deny.** The herdr socket has no authentication of any kind
and is protected only by its file mode, which makes reaching it equivalent to a shell on this machine
(G10). Anyone on `allowed_open_ids` can approve any command any agent here is asking to run. So an
empty list is a hard startup error rather than a quiet allow-all, every entry point checks it —
messages, card actions, mirrors. Ordinary agents use the configured push destination; managed tasks
use the private group recorded when that authorized user created the task. Task-group input is
checked against its owner and cannot select a different pane or redirect another task's output.

**Every reply names the agent it went to.** Not "sent", but "Delivered to claude · herdr-agent ·
w1:p1. It is now idle." — kind, directory, pane. A pane id is a seat and not an identity: an agent
can exit and another start in the same window, so a remembered destination — a selection, a reply
binding — is re-checked against whoever is in that pane now before anything is delivered, and if it
changed you are told instead of being quietly retargeted. The check is the **pane and the kind**: the
pane because herdr never reuses one, the kind because a window outlives the agent in it. The session
id and the working directory are recorded and reported but never compared — the first changes on
every `/clear`, the second is equal across two different agents and moves with a Bash tool call, and
comparing either ended conversations that had not ended.

## Troubleshooting

| symptom | cause |
|---|---|
| macOS refuses to run the binary: "cannot be opened because the developer cannot be verified" | it is a downloaded, unsigned binary and Gatekeeper quarantined it: `xattr -d com.apple.quarantine <path>`. Nothing is wrong with the install |
| messages **sometimes** arrive and sometimes do not | two processes are using the same `app_id`. Feishu's long connection is cluster mode — up to 50 connections per app — and it distributes events **randomly** across whichever are open, so nothing errors and nothing disconnects: each process just receives about half of your messages (G15). That is why one instance is enforced rather than merely encouraged, and why a diagnostic probe run next to a live bridge silently steals half your real traffic. Check for a stray `herdr-agent serve`, and for any other tool pointed at the same app |
| bridge restarts every 30s | it exits at startup; the reason is in `log/herdr-agent.err.log`, usually an empty `allowed_open_ids` or a credential that did not load |
| `serve: not implemented yet` | the binary predates the bridge — rebuild, or download a current release |
| nothing arrives on the phone at all | the log says `feishu long connection up` and never `first feishu event delivered`: the credentials are fine and something about the app's events is not. **If you configured the app by hand in the console, you probably did not publish a version after your last change** — that is required on the manual path only; an app from `herdr-agent setup` arrives with a version already published (G18). Either way, run `herdr-agent setup` against the existing credentials: it adopts them, opens no page, and tells you which round trip is broken |
| a card button fails with `200340` | the card path is genuinely off, which is a different thing from a card whose button nobody pressed. On a hand-made app check both causes — the 交互卡片 toggle and the `card.action.trigger` subscription — because the code cannot tell them apart, then publish a version. On an app configured through `setup`'s confirmation page the card path arrives working (measured), so look at the subscription |
| an agent is reported `idle` while it is clearly waiting | herdr detects claude's dialog by matching English strings on screen, and reports `idle` when the match fails — a pane narrower than 60 columns wraps those strings and breaks it (G5, G11). `doctor` FAILs on a pane no client ever attached, and exits 1; attach a terminal to the pane once to widen it |
| `doctor` FAILs and exits 1 on an install you believe is healthy | one FAIL is expected: `claude integration installed` and `codex integration installed` are separate checks, and the one for the agent you do not run FAILs. The other FAIL that is easy to hit is real — a pane no client ever attached (G5), fixed by widening it once |
| `herdr detection manifests pinned` stays WARN | set `[update] manifest_check = false` in **herdr's own** `config.toml`; doctor prints the exact command. Without that pin, the strings that decide whether an agent is blocked are fetched from herdr.dev at every server start and can change with no local change at all |
| mirroring shows nothing | the herdr server has `CLAUDE_CODE_*` in its environment, so claude turned transcript saving off (G7); `herdr-agent doctor` says so, `install.sh` fixes it |
| bridge is up but sees no agents | it is talking to a different socket than your `herdr` CLI — check `XDG_CONFIG_HOME` and `HERDR_SESSION` |

## Feishu console checklist — the manual fallback

**Try `herdr-agent setup` first**, including for an app you already have, which is what `--app cli_…`
is for. This section exists because the device-authorization endpoint that command depends on is
undocumented and can vanish without notice, and because a tenant can refuse it. When that happens you
need the whole thing written down, not a suggestion to try again later — which is why this is kept as
a first-class path.

In the open platform console, for your 自建应用:

**权限管理** — add all four basic chat permissions, or messages arrive without content, or replies fail:

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`

For task management, also grant the five permissions in
[Feishu tasks and project repositories](#feishu-tasks-and-project-repositories). Basic setup alone
does not grant or verify them.

**凭证与基础信息 — put the credentials on this machine now, before the next step.** Both values are on
that page:

```sh
mkdir -p ~/.herdr-agent && chmod 700 ~/.herdr-agent
cat > ~/.herdr-agent/.env <<'ENV'
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ENV
chmod 600 ~/.herdr-agent/.env
$EDITOR ~/.herdr-agent/config.toml   # allowed_open_ids = ["ou_..."]  <- required
```

Your own `open_id` is not on that page. Read it from the open-platform API explorer, or put any
`ou_…` placeholder in the allowlist for now and message the bot once events are flowing: the
rejected-sender WARN in `~/.herdr-agent/log/herdr-agent.err.log` names the real one. `serve` refuses
to start on an empty allowlist; `setup` needs no entry at all, because it writes yours itself.

**事件订阅** — subscription mode 长连接 (WebSocket). No request URL, no encryption key, no
verification token; the bridge connects outward.

- `im.message.receive_v1`
- `card.action.trigger`

**Have a long connection open before you save 订阅方式 = 长连接.** Feishu wants a live long connection
to already exist for the app at the moment you save that setting (G15), which inverts the obvious
order: the connection needs the credentials, so those go on disk first — which is why the step above
comes before this one. Start `herdr-agent serve` in another terminal and leave it up while you save;
a placeholder allowlist entry is enough to let it start, and it stays connected until you stop it.
`herdr-agent setup` holds a connection too, but only for the 150 s it spends waiting for your
message — and both take the same single-instance lock, so run one, not both.

**应用能力 → 机器人** — enable the bot, and turn the 交互卡片 (interactive card) toggle **on**.
Forgetting it is invisible until a button is pressed: cards still send perfectly, and only the press
fails, with `200340`, which reads like a bug in the bridge and is not one. The same code appears when
`card.action.trigger` is not subscribed, and the two are indistinguishable from outside, so check
both before concluding.

**版本管理与发布 — create a version and publish it.** On this path it is required, and it is
measured, not folklore: a permission, event or toggle changed in the console does not take effect on
the live app until a version is published. Publish again after *every* change here. If the bot
behaves exactly as it did before your change, this is why.

That step belongs to **this** path only. An app configured through `herdr-agent setup`'s confirmation
page arrives with a version already published, its scopes granted and its bot capability on — also
measured (G18) — so basic setup needs no additional publish step. Adding task permissions later
is a separate app change and must follow the console publication process.

Then run `herdr-agent setup` once anyway — stopping whatever you left connected above first, since
they share the lock. With credentials already in a file the bridge reads, it opens no page and makes
no app: it adopts them and proves every invisible setting above with the same two round trips — a
great deal cheaper than finding out from silence.

## Notes

**Reusing an app beats registering another one.** `setup` creates a real Feishu app in your tenant,
and no API we could find deletes one (G18), so every registration is permanent clutter. That is why
`--reregister` is an explicit flag rather than a fallback, and why picking an existing app on the
confirmation page — or naming it with `--app cli_…` — is worth the extra second.

**Where state lives.** Bridge configuration and runtime state live under `~/.herdr-agent/` (mode 0700):
`config.toml`, `.env`, `projects.json`, `dedup.json`, `routes.json`, `selection.json`, `tasks.json`, `herdr-agent.pid` and `log/`.
`projects.json` stores the locally edited project catalog and global Bypass setting. Explicitly created
project directories live separately under `~/herder-agent-code/`.
`tasks.json` persists task/group/workspace/pane bindings and lifecycle progress for restart recovery.
With AI enabled, `assistant-operations.json` persists tool receipts and `conversations/` holds
conversation and message receipts isolated by user and chat, with mode 0600. The model receives
the latest 20 complete conversation turns and queries task tools for current progress.
Ordinary mirror switches remain in memory and reset to `mirror.default_on`; managed task sessions
restore their own transcript following from the stored bindings. The app secret exists only in `.env` (mode 0600) or the process
environment, is never logged, and `config.toml` has no field that could hold it. Nothing rotates the
logs.

**Where the `(G1)` / `(G17)` citations in the code point.** They are facts that were *measured* on
this exact stack rather than read in a document, and every constraint in the code traces to one of
them. The load-bearing ones are all quoted in this README: G1 prose approves a blocked dialog, G3
`agent.prompt` reports success before the TUI has it, G5/G11 a narrow pane degrades blocked to a
silent `idle`, G7 the server's environment reaches every pane, G8 a transcript has no
pending-permission record so the screen and the transcript are two different sources, G10 the herdr
socket is an unauthenticated shell, G14 Feishu redelivers events whose handler failed (~5 minutes
later, byte-identical, which here means re-injecting a command into a live agent), G15 two
connections silently split your events, G17 messages never expire so an old card is loaded, G18 the
one-click app arrives already published, G20 herdr never recycles a pane id so the window is the
identity. The full record — the specs, the design decisions and the
manual acceptance scripts — is kept alongside the checkout rather than published, because it quotes
absolute paths and one operator's Feishu app setup.

## License

MIT. See [LICENSE](LICENSE).
