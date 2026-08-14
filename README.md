# herdr-agent

A bridge between Feishu (飞书) and [herdr](https://herdr.dev), so you can take over a
blocked coding agent from your phone.

You leave a `claude` or `codex` running in a herdr pane on your Mac. It stops and waits
for a human — a permission dialog, a question, or it simply finished. Your phone gets a
card with what the agent is actually asking, and buttons that answer it. You can also
just reply in prose, and, if you turn mirroring on, read the agent's own transcript as a
conversation rather than as a terminal screenshot.

It is a single-user tool: one Mac, one Feishu app, one `open_id` on the allowlist. There
is no public URL and no tunnel — the bridge dials out over Feishu's WebSocket, so a
laptop behind NAT works fine.

## Requirements

- macOS (the deployment is launchd; the Go code is portable, the plists are not)
- herdr 0.8.0 or newer — protocol 19 is the minimum the wire types were measured against
- `claude` and/or `codex`, with `herdr integration install claude` / `codex` done.
  For codex you must also press `t` inside codex once to trust the hook, or herdr never
  learns the session id and the mirror has nothing to follow.
- A Feishu account. `herdr-agent setup` creates the app for you; the manual console
  checklist further down is the documented fallback for when it cannot.

## Setup

```sh
git clone https://github.com/hewenyu/herdr-agent && cd herdr-agent
go build -o ~/.herdr-agent/bin/herdr-agent ./cmd/herdr-agent

~/.herdr-agent/bin/herdr-agent setup   # one page to confirm, then two taps on your phone

deploy/install.sh                              # installs two LaunchAgents
~/.herdr-agent/bin/herdr-agent doctor          # no FAIL for the agents you use
```

`setup` prints a confirmation link, opens it, and waits. Pressing 确认 on that page
creates the app, **grants** the four scopes, subscribes `im.message.receive_v1`,
selects long-connection delivery — and publishes a version. That last one is measured,
not assumed: the new app's `online_version_id` was already non-empty before any publish
step of ours, and a real direct message from a phone arrived with zero console
interactions. It is also the reason this command exists. Every one of those settings is
invisible when it is wrong, and they all have the same symptom: the bridge connects,
says so, and then nothing ever arrives.

The page also **requests** the `card.action.trigger` callback. Whether interactive cards
then work is the one thing setup cannot confirm for you in advance: in the measurement a
card was sent successfully and no callback came back, and that observation cannot tell a
交互卡片 capability that needs a manual toggle from a human who did not tap in time. That
is what the card half of the verification is for (see exit 3), and why the checklist it
prints covers both.

The command then writes `~/.herdr-agent/.env` at mode 0600 — the only place the app
secret is allowed to exist, and it is printed nowhere, not even as a prefix or a
length — puts your `open_id` in `allowed_open_ids`, asks you to message the bot, and
asks you to press the button on the card it sends back. Nothing less than both of
those round trips is treated as success:

| exit | meaning |
|---|---|
| 0 | verified end to end: your message arrived and your button press came back |
| 3 | the app exists and its credentials are on disk, but a round trip was not proven. A numbered checklist with one URL per item says what is left; re-running `setup` skips registration and re-verifies |
| 1 | nothing usable was produced |

Three things to know before you run it:

- **It creates a real app in your Feishu tenant, and no API we could find deletes one.**
  Re-running `setup` is safe and is the intended repair path — with credentials on disk
  it skips registration entirely. `--reregister` is the one that creates a second
  permanent app, which is why it is a flag and not a fallback.
- **Stop the bridge first.** Feishu's long connection is cluster mode — up to 50
  connections per app, events split randomly between them — so a second client does not
  fail cleanly, it silently takes a random share of your real messages. `setup` takes
  the same single-instance lock `serve` does and refuses rather than sharing. Once
  `install.sh` has run, the bridge is that second client. Stop it with
  `launchctl bootout gui/$(id -u)/com.hewenyu.herdr-agent`, run setup, then bring it back
  with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hewenyu.herdr-agent.plist`.
- The device-authorization endpoint it uses is **undocumented**. It appears nowhere on
  open.feishu.cn; its only description is in two SDK READMEs. It can change or vanish
  without notice, which is why the manual checklist below is a supported path rather
  than a footnote.

Then message the bot `/ls` from your phone.

Two of `doctor`'s results are expected to be non-PASS on a healthy install, so read
them rather than counting them: `claude integration installed` and `codex integration
installed` are separate checks and the one for the agent you do not run FAILs (doctor
exits 1 for it), and `herdr detection manifests pinned` stays WARN until you set
`[update] manifest_check = false` in **herdr's own** `config.toml` — doctor prints the
command. Everything else should pass.

`install.sh` is idempotent: it rewrites both unit files, boots the jobs out and back in,
and leaves an existing `config.toml` alone. It installs

| job | what it runs |
|---|---|
| `com.hewenyu.herdr-server` | `herdr server`, from a **scrubbed** environment |
| `com.hewenyu.herdr-agent` | `herdr-agent serve`, the bridge |

The scrub is not decoration. herdr passes its own environment to every pane it spawns,
so a server started from inside a claude session gives every pane a
`CLAUDE_CODE_CHILD_SESSION` marker, and claude answers that by turning transcript saving
off — no error, no log line, and the mirror silently mirrors nothing. The plist starts
herdr under `env -i` and adds back only `HOME`, `PATH`, `SHELL`, `TERM` and `LANG`. If
you prefer to run herdr yourself, use `deploy/install.sh --bridge-only` and start it with
something equivalent.

Every knob lives in `~/.herdr-agent/config.toml`; `deploy/config.example.toml` documents
each one with its default and the trade-off it makes. Credentials are not among them —
`config.toml` has no field for a secret, so one cannot end up there by accident.

## Feishu app checklist — the manual fallback

Use this when `setup` cannot run: the undocumented endpoint it depends on changed or
went away, your tenant refuses it, or you already have an app you would rather reuse.
It is the same result reached by hand, and it is why the bridge only ever needs
`FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `~/.herdr-agent/.env` (mode 0600, in a 0700
directory) plus your own `open_id` in `allowed_open_ids`.

In the open platform console, for your 自建应用:

**权限管理** — add all four, or messages arrive without content, or replies fail:

- `im:message`
- `im:message.p2p_msg:readonly`
- `im:message:send_as_bot`
- `im:resource`

**事件订阅** — subscription mode 长连接 (WebSocket). No request URL, no encryption key,
no verification token; the bridge connects outward.

- `im.message.receive_v1`
- `card.action.trigger`

**应用能力 → 机器人** — enable the bot, and turn the 交互卡片 (interactive card) toggle
**on**. Cards still send perfectly when something here is wrong; only the button press
fails, with `200340`, which reads like a bug in the bridge and is not one. Note that the
same code appears when `card.action.trigger` is not subscribed — the two are
indistinguishable from the outside, so check both before concluding.

**版本管理与发布 — create a version and publish it.** This is measured, not folklore:
a permission, event or toggle you changed in the console does not take effect on the
live app until a version is published. Every time you change anything above, publish
again. If the bot behaves exactly as it did before your change, this is why.

That step belongs to **this** path only. An app created through `herdr-agent setup`
arrives with a version already published — also measured, and the opposite of what the
console flow teaches you to expect — so there is nothing to publish after it runs.

Then put the credentials where the bridge reads them — `config.toml` has no field for a
secret, on purpose, so this file is the only place one can live:

```sh
mkdir -p ~/.herdr-agent && chmod 700 ~/.herdr-agent
cat > ~/.herdr-agent/.env <<'ENV'
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ENV
chmod 600 ~/.herdr-agent/.env
$EDITOR ~/.herdr-agent/config.toml   # allowed_open_ids = ["ou_..."]  <- required
```

Both values are in 凭证与基础信息. Your own `open_id` is not: read it from the
open-platform API explorer, or message the bot before configuring the allowlist and look
for the rejected-sender WARN in `~/.herdr-agent/log/herdr-agent.err.log`. Without an
allowlist entry the bridge refuses to start.

One more constraint: Feishu allows **one WebSocket per `app_id`**. Two processes using
the same app steal the connection from each other and the symptom is "Feishu is flaky".
The bridge takes an flock'd pid file before any network IO so a second copy of itself
exits, but nothing stops you from pointing another tool at the same app.

## Commands

From your phone, in the p2p chat with the bot:

| command | what it does |
|---|---|
| `/ls` | every agent herdr can see: status, pane, kind, cwd, title |
| `/card <pane>` | push that pane's current screen as an actionable card |
| `/say <pane> <text>` | send prose through the safe path |
| `/stop <pane>` | send `esc` — the safe way out of a dialog |
| `/mirror <pane> on\|off` | follow that agent's transcript in chat (default off) |
| `/doctor` | the same checks as `herdr-agent doctor` |
| `/help` | this table |

Three ways your input finds an agent, highest priority first: a card button carries its
own pane id, so it needs no server state; replying to a message about an agent routes to
that agent, which is how you drive several at once; bare text goes to the only agent if
there is exactly one, and otherwise gets you `/ls` back. A slash command that does not
parse is answered with an error and is never demoted to free text — `/stpo w1:p1`
delivered as prose to a blocked agent would be an approval.

If an agent is busy, your message is queued (five deep) and delivered when it goes idle.
If it comes back *blocked* instead, the queued line is not sent: it was written for a
situation that no longer exists. You get a card and decide again.

On the Mac, the same capabilities are a CLI, and it is the acceptance surface for the
control layer:

```
herdr-agent setup [--reregister]    register a Feishu app and prove it works
herdr-agent doctor                  check the things that break the bridge silently
herdr-agent ls                      list agents
herdr-agent dialog <pane>           what the agent is asking
herdr-agent tail <pane> [-n 18]     the last lines of its viewport
herdr-agent key <pane> <key>        answer a menu, through the full guard check
herdr-agent say <pane> <text...>    prose, through the safe path
herdr-agent transcript <pane>       the agent's native transcript file
herdr-agent watch                   stream status transitions
herdr-agent serve                   run the bridge (what launchd runs)
```

## Safety model

**Prose never reaches a blocked agent.** herdr's `agent.prompt` pastes your text and then
presses Enter, and a permission dialog is a menu rather than a text box, so the paste is
discarded and the Enter selects the highlighted `1. Yes` — sending "absolutely not, do
NOT run this command" to a blocked claude approves the command, measured; the bridge
therefore sends `esc` first, waits for the agent to settle, and only then delivers your
words, reporting honestly when it could not confirm they landed.

**Old cards are disarmed.** Feishu messages never expire and a button tapped three days
later still presses a key into whatever that pane is running today, so every button
carries the pane, agent kind and state sequence it was minted for, is single-use through
a nonce, and the card is rewritten into a static "handled" one the instant it is used —
a stale press sends no keystroke at all and says why.

**The allowlist is mandatory.** The herdr socket has no authentication of any kind and is
protected only by its file mode, which makes reaching it equivalent to a shell on this
Mac, so an empty `allowed_open_ids` is a startup error rather than a quiet default-allow,
and every entry point checks it — messages, card actions, and the notification target,
which is read from config and never from an incoming message.

## Why the code is shaped like this

The comments cite facts by number — `(G1)`, `(G17)` and so on. Those are 17 things that
were **measured** on this exact stack rather than read in a document, and every constraint
in the code traces to one of them. A few, so the citations are not opaque:

- **G1** — prose sent to a blocked Claude *approves* the pending dialog. `agent.prompt`
  pastes text the menu discards and then presses Enter on the highlighted default. An
  explicit written refusal created the file it was refusing.
- **G3** — `agent.prompt` reports success once the bytes reach the PTY queue, so a prompt
  sent just after a state change is swallowed with no error at all.
- **G8** — a transcript has no pending-permission record, so "it is asking something" can
  only come from the screen, while "what it said" can only come from the transcript.
- **G13** — the Feishu SDK's own `channel` example omits `WithEventHandler`, and every
  inbound event then panics on a nil dispatcher while registration silently no-ops.
- **G14** — Feishu redelivers events whose handler failed, measured at ~5 minutes later
  and byte-identical. Here that means re-injecting a command into a live coding agent.
- **G17** — Feishu messages never expire, so a three-day-old card still delivers its
  keystroke to whatever now occupies that pane.

If something in here looks paranoid, that is where it came from. The full record — the
specs, the design decisions and the manual acceptance scripts — is kept alongside the
checkout rather than published, because it quotes absolute paths and one operator's
Feishu app setup.

## Files and troubleshooting

Everything the bridge owns is in `~/.herdr-agent/` (mode 0700): `config.toml`, `.env`,
`dedup.json`, `routes.json`, `mirrors.json`, `herdr-agent.pid`, and `log/`. Nothing
rotates the logs.

| symptom | cause |
|---|---|
| bridge restarts every 30s | it exits at startup; the reason is in `log/herdr-agent.err.log`, usually an empty `allowed_open_ids` or a credential that did not load |
| `serve: not implemented yet` | the binary predates the bridge — rebuild and re-run `install.sh` |
| nothing arrives on the phone | the log says `feishu long connection up` and never `first feishu event delivered`: the credentials are fine and something about the app's events is not. If you configured it by hand, you probably did not publish a version after your last change. Run `herdr-agent setup` against the existing credentials — it skips registration and tells you which round trip is broken |
| a card button fails with `200340` | either the 交互卡片 toggle is off or `card.action.trigger` is not subscribed — the code cannot tell them apart, so check both, then publish a version |
| mirroring shows nothing | the herdr server has `CLAUDE_CODE_*` in its environment; `herdr-agent doctor` says so, `install.sh` fixes it |
| an agent is reported `idle` while it is clearly waiting | herdr detects claude's dialog with English string matching, and reports `idle` when it fails to match — a pane narrower than 60 columns wraps those strings and breaks it. `doctor` warns about narrow panes; attach a terminal to the pane once to widen it |
| bridge is up but sees no agents | it is talking to a different socket than your `herdr` CLI — check `XDG_CONFIG_HOME` and `HERDR_SESSION` |

## License

MIT. See [LICENSE](LICENSE).
