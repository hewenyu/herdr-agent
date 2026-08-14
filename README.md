# herdr-agent

Your coding agent stops mid-task and asks for permission, and you are not at the keyboard.
herdr-agent pushes that question to Feishu (飞书) — the real dialog text, with its real options as
buttons — and your tap, or a line you type, goes back into the terminal so the agent carries on.
It drives `claude` and `codex` through [herdr](https://herdr.dev), and it is single-user by design:
one machine, one Feishu app, one `open_id` on the allowlist.

There is no public URL, no tunnel and no webhook. The bridge dials out over Feishu's WebSocket, so a
laptop behind NAT works.

## Requirements

- [herdr](https://herdr.dev) 0.8.0 or newer. Protocol 19 is the minimum the wire types were measured
  against.
- `claude` and/or `codex`, plus `herdr integration install claude` / `herdr integration install
  codex`. For codex you must also press `t` inside codex once to trust the hook, or herdr never
  learns the session id and transcript mirroring has nothing to follow (G8).
- A Feishu account. `herdr-agent setup` prepares the app for you — a new one, or one you already
  have. The [manual console checklist](#feishu-console-checklist--the-manual-fallback) is the
  supported fallback.
- macOS is what all of this was measured on, and the ready-made service units are launchd. The Go
  code is portable and Linux binaries ship; `serve` is an ordinary foreground process anywhere.

## Install

Download from the [Releases page](https://github.com/hewenyu/herdr-agent/releases/latest). Three
assets, plus one `SHA256SUMS` covering all of them:

| asset | for |
|---|---|
| `herdr-agent_<version>_darwin_arm64.tar.gz` | macOS, Apple Silicon |
| `herdr-agent_<version>_linux_arm64.tar.gz` | Linux, arm64 |
| `herdr-agent_<version>_linux_amd64.tar.gz` | Linux, x86_64 |

Copy the release tag and the exact asset name off that page, then:

```sh
TAG=…                     # the release tag, e.g. the one at the top of the page
ASSET=…                   # the asset file name you copied
BASE=https://github.com/hewenyu/herdr-agent/releases/download/$TAG

curl -fLO "$BASE/$ASSET"
curl -fLO "$BASE/SHA256SUMS"

shasum -a 256 --ignore-missing -c SHA256SUMS   # Linux: sha256sum --ignore-missing -c SHA256SUMS
tar xzf "$ASSET"                               # binary, plus README.md and LICENSE
mkdir -p ~/.local/bin && mv herdr-agent ~/.local/bin/   # anywhere on PATH

herdr-agent version                            # which build this actually is
```

`--ignore-missing` is what lets one `SHA256SUMS` verify the one archive you downloaded instead of
failing on the two you did not. Verify before you run it, not after.

**On macOS, clear the quarantine flag.** These binaries are not signed and not notarised, so
Gatekeeper refuses to run a downloaded one and says the developer cannot be verified. That looks
exactly like a broken project, and it is not:

```sh
xattr -d com.apple.quarantine ~/.local/bin/herdr-agent
```

(`No such xattr` means it was never quarantined. Fine.) The same applies to a `herdr` binary you
downloaded rather than installed with a package manager.

Building it yourself is equally supported and needs Go 1.24 or newer:

```sh
go install github.com/hewenyu/herdr-agent/cmd/herdr-agent@latest
# or, from a clone:
go build -o ~/.local/bin/herdr-agent ./cmd/herdr-agent
```

## Quick start

Six steps. The reason under each one is a failure that is silent if you skip it.

**1. Start herdr from a clean environment.**

```sh
env -i HOME="$HOME" PATH="$PATH" SHELL="$SHELL" TERM="$TERM" LANG="$LANG" nohup herdr server >/tmp/herdr-server.log 2>&1 &
```

herdr hands its own environment to every pane it spawns, so a server started from inside a claude
session gives every agent a `CLAUDE_CODE_CHILD_SESSION` marker, and claude answers that by switching
transcript saving off with no error anywhere (G7). Make sure that `PATH` contains `claude` / `codex`:
it is the `PATH` every pane will start with. `SHELL` is on that list for the same reason — without it
every pane falls back to `/bin/sh`.

**2. Attach a wide terminal once.** Open the herdr desktop UI with a wide window, open the pane you
are going to work in from there, and close the window afterwards if you like — herdr remembers the
last attached geometry even after the client detaches (G5).

Skip it and the pane is 53 columns wide, where herdr silently reports a blocked agent as `idle`
(G5, G11) — the one setup mistake that makes the whole product look like it does nothing.
`herdr-agent doctor` FAILs on such a pane; [Troubleshooting](#troubleshooting) has the mechanism.

**3. Start your agent in that pane** — `claude` or `codex`, in the directory you want it working in.
The bridge never starts agents; that stays yours.

**4. Prepare the Feishu app.**

```sh
herdr-agent setup
```

One confirmation page, then two taps on your phone: it grants the scopes, subscribes the events,
writes `~/.herdr-agent/.env` at mode 0600, fills in the allowlist and `notify_chat_id`, and then makes
you send a real message and press a real button, because each of those settings fails the same
invisible way when it is wrong. [More about setup](#more-about-setup).

**5. Check the machine.**

```sh
herdr-agent doctor
```

It looks for the things that break the bridge silently. A healthy install still has a couple of
non-PASS results, so read them rather than counting them — [Troubleshooting](#troubleshooting) says
which ones are expected and what to do about the rest.

**6. Run the bridge.**

```sh
herdr-agent serve
```

Then message the bot `/ls` from your phone.

### Keep it running

`serve` is a foreground process; put it under whatever supervisor you already use, or use the units
in `deploy/`. Those live in the git repository and not in the release archive, which holds the binary,
`README.md` and `LICENSE` and nothing else — so clone it:

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
for a secret, so one cannot end up there by accident. The two settings you will actually want are
`feishu.allowed_open_ids` (mandatory) and `feishu.notify_chat_id` (empty means no proactive pushes —
you can still drive agents, you just will not be told when one needs you).

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
  step of ours. **So there is nothing for you to publish after `setup` runs** — which is the opposite
  of what the console flow teaches, and worth stating plainly, because sending you to look for a
  publish button you will not need ends with you concluding you configured something wrong.

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

## Using it from your phone

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
one tap on a card you already have rather than another `/ls`. `▶` marks the current row. A selection
lasts 12 hours; after that the card comes back and you pick again.

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

If you type to an agent that is busy, your line is queued (five deep) and delivered when it goes
idle. If it comes back *blocked* instead, the queued line is **not** sent: it was written for a
situation that no longer exists. You get a card and decide again.

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
messages, card actions, mirrors — and the push target is read from config, never from an incoming
message, so nobody who can talk to the bot can redirect your agents' screens to themselves.

**Every reply names the agent it went to.** Not "sent", but "Delivered to claude · herdr-agent ·
w1:p1. It is now idle." — kind, directory, pane. A pane id is a seat and not an identity: an agent
can exit and another take the same seat, so a remembered destination — a selection, a reply binding —
is re-checked against whoever is in that pane now before anything is delivered, and if it changed you
are told instead of being quietly retargeted.

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

**权限管理** — add all four, or messages arrive without content, or replies fail:

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`

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
measured (G18) — so there is nothing to publish after it runs.

Then run `herdr-agent setup` once anyway — stopping whatever you left connected above first, since
they share the lock. With credentials already in a file the bridge reads, it opens no page and makes
no app: it adopts them and proves every invisible setting above with the same two round trips — a
great deal cheaper than finding out from silence.

## Notes before you start

**Reusing an app beats registering another one.** `setup` creates a real Feishu app in your tenant,
and no API we could find deletes one (G18), so every registration is permanent clutter. That is why
`--reregister` is an explicit flag rather than a fallback, and why picking an existing app on the
confirmation page — or naming it with `--app cli_…` — is worth the extra second.

**Where state lives.** Everything the bridge owns is under `~/.herdr-agent/` (mode 0700):
`config.toml`, `.env`, `dedup.json`, `routes.json`, `selection.json`, `herdr-agent.pid` and `log/`.
Mirror on/off is deliberately not among them: it is in-memory only, so a restart drops back to
`mirror.default_on` rather than resuming a stream you have forgotten about. The app secret exists only in `.env` (mode 0600) or the process
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
one-click app arrives already published. The full record — the specs, the design decisions and the
manual acceptance scripts — is kept alongside the checkout rather than published, because it quotes
absolute paths and one operator's Feishu app setup.

## License

MIT. See [LICENSE](LICENSE).
