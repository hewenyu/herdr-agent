#!/bin/bash
#
# install.sh — install and (re)start the two LaunchAgents the bridge needs:
#
#   com.hewenyu.herdr-server   herdr itself, started from a scrubbed environment
#   com.hewenyu.herdr-agent    the Feishu bridge (`herdr-agent serve`)
#
# Idempotent. Run it again after rebuilding the binary, after editing a plist,
# or whenever you are not sure what state things are in: it rewrites both unit
# files from the templates next to it, boots the jobs out and back in, and
# prints what to do next.
#
# What it will not do: overwrite an existing config.toml, write your
# credentials, or kill a herdr server you started by hand — that would take
# every running agent down with it.
#
# Overrides:  HERDR_BIN=/path/to/herdr  HERDR_AGENT_BIN=/path/to/herdr-agent
# Flags:      --bridge-only  --server-only  --uninstall  --help

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

STATE_DIR="$HOME/.herdr-agent"
ENV_FILE="$STATE_DIR/.env"
CONFIG_FILE="$STATE_DIR/config.toml"
LOG_DIR="$STATE_DIR/log"
LA_DIR="$HOME/Library/LaunchAgents"
UID_NUM=$(id -u)
DOMAIN="gui/$UID_NUM"

LABEL_SERVER="com.hewenyu.herdr-server"
LABEL_BRIDGE="com.hewenyu.herdr-agent"

do_server=1
do_bridge=1
do_uninstall=0

# ---------------------------------------------------------------- output ----

info() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*" >&2; }
die()  { printf '\ninstall.sh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: deploy/install.sh [--bridge-only | --server-only] [--uninstall]

  --bridge-only   install only com.hewenyu.herdr-agent (you run herdr yourself)
  --server-only   install only com.hewenyu.herdr-server
  --uninstall     bootout and remove the plists; leaves ~/.herdr-agent alone.
                  Obeys the two flags above: --bridge-only --uninstall keeps the
                  herdr server, and therefore every pane, running.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --bridge-only) do_server=0 ;;
    --server-only) do_bridge=0 ;;
    --uninstall)   do_uninstall=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# -------------------------------------------------------------- platform ----

# Everything below renders plists and drives launchctl, so this script is macOS
# only. It refuses here, before anything else, for one specific reason: the
# --uninstall path runs ahead of pre-flight, and `launchctl bootout` failures are
# swallowed with `|| true` while `rm -f` on a file that was never there succeeds.
# On Linux that combination printed "removed" twice and exited 0, which is the
# one outcome worse than refusing — the user believes something was undone.
if [ "$(uname -s)" != "Darwin" ]; then
  if [ "$do_uninstall" -eq 1 ]; then
    cat >&2 <<EOF

install.sh: this machine is $(uname -s). launchd is macOS only, there is no
LaunchAgent here to remove, and this script has removed NOTHING.

The systemd counterpart, if that is what you installed:

  systemctl --user disable --now herdr-agent.service
  systemctl --user disable --now herdr-server.service   # this closes every pane,
                                                        # and every agent in one
  rm -f ~/.config/systemd/user/herdr-agent.service ~/.config/systemd/user/herdr-server.service
  systemctl --user daemon-reload
  loginctl disable-linger "\$USER"   # only if nothing else of yours needs linger

$STATE_DIR (config, credentials, dedup state, logs) is left alone by all of
that. Remove it yourself if you mean it:  rm -rf $STATE_DIR
EOF
    exit 1
  fi
  cat >&2 <<EOF

install.sh: this machine is $(uname -s). launchd is macOS only, so this script
cannot install anything here and has written NOTHING.

Use the systemd user units next to it instead. Each one carries the reasoning
for every setting at the top, and herdr-server.service explains why herdr has to
start from a scrubbed environment — an inherited CLAUDE_CODE_CHILD_SESSION turns
claude's transcript saving off and kills the mirror silently (G7). Read that file
before you start it:

  $SCRIPT_DIR/herdr-agent.service
  $SCRIPT_DIR/herdr-server.service

  mkdir -p "$STATE_DIR" ~/.local/bin ~/.config/systemd/user
  chmod 700 "$STATE_DIR"
  install -m 755 ./herdr-agent ~/.local/bin/herdr-agent   # what the unit expects

  # Credentials and the allowlist, before either unit is enabled. setup writes
  # the .env at mode 0600, creates config.toml from the same example that ships
  # in deploy/, fills in feishu.allowed_open_ids and feishu.notify_chat_id, and
  # then makes you send a real message and press a real button, because each of
  # those fails the same invisible way when it is wrong. With no browser here it
  # prints the confirmation link instead of claiming it opened one.
  ~/.local/bin/herdr-agent setup

  # By hand instead — the supported fallback, since the endpoint setup uses is
  # undocumented (G18). Two files, and a console change on this path only takes
  # effect once you create and publish a version (an app that came out of setup
  # already has one). feishu.allowed_open_ids must not stay empty: hard startup
  # error by design, default deny, because driving an agent is equivalent to
  # shell access on this machine. The credentials come from the Feishu open
  # platform console, 凭证与基础信息, and are read from the .env and nowhere
  # else — config.toml has no field for them on purpose.
  #   cp "$SCRIPT_DIR/config.example.toml" "$CONFIG_FILE"
  #   \$EDITOR "$CONFIG_FILE"
  #   printf 'FEISHU_APP_ID=cli_xxx\nFEISHU_APP_SECRET=xxx\n' > "$ENV_FILE"
  #   chmod 600 "$ENV_FILE"

  cp "$SCRIPT_DIR/herdr-agent.service" "$SCRIPT_DIR/herdr-server.service" ~/.config/systemd/user/

  # In herdr-server.service, check the herdr binary path and the PATH the panes
  # inherit from it: that PATH has to contain claude / codex or no pane will
  # find them.
  \$EDITOR ~/.config/systemd/user/herdr-server.service

  systemctl --user daemon-reload
  systemctl --user enable --now herdr-server.service herdr-agent.service

  # Without linger both units stop when you log out, and nothing starts at boot.
  loginctl enable-linger "\$USER"

Then check it and watch it:

  ~/.local/bin/herdr-agent doctor
  journalctl --user -u herdr-agent -f
EOF
  exit 1
fi

# --------------------------------------------------------------- helpers ----

# abspath normalises a path for launchd, which resolves nothing itself: no ~,
# no $HOME, no PATH lookup, and no "..".
abspath() {
  printf '%s\n' "$(cd -- "$(dirname -- "$1")" && pwd -P)/$(basename -- "$1")"
}

# A plist is XML. A path containing & or < would produce a file that either
# fails to parse or, worse, parses into something else.
#
# | and \ are rejected for a second reason: render_plist substitutes these same
# values with `sed -e "s|__X__|$value|g"`, where | closes the pattern and \ is
# the escape character. A | makes sed fail with its own syntax error instead of
# the diagnostic below; a \ is silently consumed, and the plist then passes
# plutil -lint holding a subtly wrong absolute path — a job that fails to spawn
# later, with a message nobody is watching for.
assert_xml_safe() {
  case "$2" in
    *[\&\<\>\"\'\|\\]*) die "$1 contains a character that cannot go into a plist or through sed unescaped: $2" ;;
  esac
}

job_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

unload_job() {
  local i
  launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1 || true
  # bootout returns before the job is gone; bootstrapping into a domain that is
  # still tearing the label down fails with "Operation already in progress".
  i=0
  while job_loaded "$1"; do
    i=$((i + 1))
    if [ "$i" -gt 50 ]; then
      warn "$1 is still loaded 5s after bootout; continuing anyway"
      return 0
    fi
    sleep 0.1
  done
}

load_job() {
  local label=$1
  local plist=$2
  unload_job "$label"
  # A job disabled earlier (launchctl disable, or a bootout -w from the old
  # syntax) stays disabled across bootstrap, silently and permanently.
  launchctl enable "$DOMAIN/$label" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "$DOMAIN" "$plist"; then
    die "launchctl bootstrap $DOMAIN $plist failed"
  fi
  ok "$label bootstrapped"
}

remove_job() {
  local label=$1
  unload_job "$label"
  rm -f "$LA_DIR/$label.plist"
  ok "$label removed"
}

# ------------------------------------------------------------- uninstall ----

if [ "$do_uninstall" -eq 1 ]; then
  step "uninstalling"
  if [ "$do_bridge" -eq 1 ]; then remove_job "$LABEL_BRIDGE"; fi
  # --uninstall honours --bridge-only / --server-only for the same reason the
  # install path refuses to restart a hand-started server: booting this label
  # out SIGTERMs herdr, and herdr owns every pane, so every agent in one dies
  # mid-task. "I run herdr myself" must not be a way to lose your work.
  if [ "$do_server" -eq 1 ]; then
    if job_loaded "$LABEL_SERVER"; then
      warn "booting out $LABEL_SERVER closes every pane, and every agent running in one."
      warn "Keep it: deploy/install.sh --bridge-only --uninstall"
    fi
    remove_job "$LABEL_SERVER"
  fi
  info ""
  info "Left in place on purpose: $STATE_DIR (config, credentials, dedup state, logs)."
  info "Remove it yourself if you mean it:  rm -rf $STATE_DIR"
  exit 0
fi

# ------------------------------------------------------------ pre-flight ----

step "pre-flight"

# The platform gate above already refused anything that is not Darwin, with the
# systemd instructions; this only reports which macOS.
ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?')"

# The refusal the deployment story hangs on: without credentials the bridge
# boots, fails to authenticate, exits, and gets restarted by launchd every 30
# seconds forever. Better to stop here, where there is a human reading.
if [ ! -f "$ENV_FILE" ]; then
  cat >&2 <<EOF

install.sh: $ENV_FILE is missing.

The bridge reads its Feishu credentials from that file and from nowhere else —
config.toml has no field for them, on purpose. Create it first:

mkdir -p $STATE_DIR && chmod 700 $STATE_DIR
cat > $ENV_FILE <<'ENV'
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ENV
chmod 600 $ENV_FILE

Both values come from the Feishu open platform console, 凭证与基础信息.
EOF
  exit 1
fi
ok "$ENV_FILE exists"

env_mode=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || echo "?")
if [ "$env_mode" != "600" ]; then
  warn "$ENV_FILE is mode $env_mode; it holds an app secret — chmod 600 $ENV_FILE"
fi
for key in FEISHU_APP_ID FEISHU_APP_SECRET; do
  if ! grep -Eq "^[[:space:]]*$key[[:space:]]*=[[:space:]]*[^[:space:]]" "$ENV_FILE"; then
    warn "$ENV_FILE has no non-empty $key; Feishu connection will wait for setup"
  fi
done

# Binaries: launchd has no PATH worth speaking of, so both are baked in as
# absolute paths and both have to exist now rather than at first launch.
if [ "$do_bridge" -eq 1 ]; then
  bridge_bin="${HERDR_AGENT_BIN:-}"
  # npm upgrades replace the executable behind this launcher. Prefer that
  # installation over an older standalone copy left in the state directory.
  if [ -z "$bridge_bin" ]; then
    bridge_bin=$(command -v myrix || true)
  fi
  if [ -z "$bridge_bin" ]; then
    for candidate in "$STATE_DIR/bin/herdr-agent" "$SCRIPT_DIR/../dist/herdr-agent" "$SCRIPT_DIR/../herdr-agent"; do
      if [ -x "$candidate" ]; then bridge_bin="$candidate"; break; fi
    done
  fi
  if [ -z "$bridge_bin" ]; then
    bridge_bin=$(command -v herdr-agent || true)
  fi
  if [ -z "$bridge_bin" ] || [ ! -x "$bridge_bin" ]; then
    die "cannot find the herdr-agent binary.
     build it:     (cd $(dirname "$SCRIPT_DIR") && npm ci && npm run binary)
     or point at it: HERDR_AGENT_BIN=/path/to/herdr-agent $0"
  fi
  bridge_bin=$(abspath "$bridge_bin")
  assert_xml_safe "herdr-agent path" "$bridge_bin"
  if LC_ALL=C head -c 64 "$bridge_bin" | LC_ALL=C grep -q '^#!/usr/bin/env node'; then
    if ! command -v node >/dev/null 2>&1; then
      die "the npm launcher $bridge_bin requires Node.js on PATH; select your Node installation and run this installer again"
    fi
  fi
  ok "bridge binary $bridge_bin"
fi

if [ "$do_server" -eq 1 ]; then
  server_bin="${HERDR_BIN:-$(command -v herdr || true)}"
  if [ -z "$server_bin" ] || [ ! -x "$server_bin" ]; then
    die "cannot find the herdr binary. Install herdr, or: HERDR_BIN=/path/to/herdr $0"
  fi
  server_bin=$(abspath "$server_bin")
  assert_xml_safe "herdr path" "$server_bin"
  ok "herdr binary   $server_bin"
fi

assert_xml_safe "home directory" "$HOME"

# Both the bridge and the scrubbed herdr server use this PATH. npm launchers
# need the selected Node installation even when it comes from nvm/fnm rather
# than a system directory; launchd does not read interactive shell startup.
# Every pane also inherits the server PATH, so include the installed agents.
clean_path=""
path_add() {
  if [ ! -d "$1" ]; then return 0; fi
  case ":$clean_path:" in *":$1:"*) return 0 ;; esac
  if [ -z "$clean_path" ]; then clean_path="$1"; else clean_path="$clean_path:$1"; fi
}
selected_tool_path=""
for tool in node herdr claude codex; do
  tool_path=$(command -v "$tool" || true)
  if [ -n "$tool_path" ]; then
    selected_tool_path="$selected_tool_path:$(dirname "$(abspath "$tool_path")")"
  fi
done
# Preserve their relative PATH order: a Node directory can also contain an old
# claude/codex installation and must not shadow the user's selected executors.
remaining_path="${PATH:-}"
while :; do
  path_entry="${remaining_path%%:*}"
  if [ -d "${path_entry:-.}" ]; then
    path_directory=$(cd -- "${path_entry:-.}" && pwd -P)
    case "$selected_tool_path:" in
      *":$path_directory:"*) path_add "$path_directory" ;;
    esac
  fi
  case "$remaining_path" in
    *:*) remaining_path="${remaining_path#*:}" ;;
    *) break ;;
  esac
done
path_add "$HOME/.local/bin"
path_add "$HOME/.cargo/bin"
path_add "/opt/homebrew/bin"
path_add "/usr/local/bin"
path_add "/usr/bin"
path_add "/bin"
path_add "/usr/sbin"
path_add "/sbin"
assert_xml_safe "PATH for panes" "$clean_path"
ok "pane PATH      $clean_path"

for tool in claude codex; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    warn "$tool is not on your PATH, so panes started by herdr will not find it either"
  fi
done

# What herdr opens in a new pane. Without SHELL a scrubbed environment falls
# back to /bin/sh, which reads none of your login files.
login_shell=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk '{print $2}' || true)
if [ -z "${login_shell:-}" ] || [ ! -x "$login_shell" ]; then login_shell="${SHELL:-/bin/zsh}"; fi
if [ ! -x "$login_shell" ]; then login_shell="/bin/sh"; fi
assert_xml_safe "login shell" "$login_shell"
ok "pane shell     $login_shell"

# ------------------------------------------------------------ state dirs ----

step "state directory"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$LA_DIR"
chmod 700 "$STATE_DIR"
# launchd will not create the directory behind StandardOutPath; it just fails
# to open it and the job's output vanishes.
ok "$LOG_DIR"

if [ -f "$CONFIG_FILE" ]; then
  ok "$CONFIG_FILE (left untouched)"
else
  cp "$SCRIPT_DIR/config.example.toml" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
  ok "$CONFIG_FILE created from config.example.toml"
fi

if grep -Eq '^[[:space:]]*allowed_open_ids[[:space:]]*=[[:space:]]*\[[[:space:]]*\]' "$CONFIG_FILE"; then
  warn "feishu.allowed_open_ids is empty in $CONFIG_FILE."
  warn "Feishu connection will wait for setup. Add your own open_id; local Web stays available."
fi

# --------------------------------------------------------------- plists -----

render_plist() {
  local src="$SCRIPT_DIR/$1"
  local dst="$LA_DIR/$1"
  local tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/herdr-plist.XXXXXX")

  sed -e "s|__HOME__|$HOME|g" \
      -e "s|__HERDR_AGENT_BIN__|${bridge_bin:-}|g" \
      -e "s|__HERDR_BIN__|${server_bin:-}|g" \
      -e "s|__CLEAN_PATH__|$clean_path|g" \
      -e "s|__LOGIN_SHELL__|$login_shell|g" \
      "$src" >"$tmp"

  # A placeholder that survived would reach launchd as a literal path and the
  # job would fail to spawn with a message nobody reads.
  if grep -q '__[A-Z_][A-Z_]*__' "$tmp"; then
    rm -f "$tmp"
    die "$1 still contains an unsubstituted __PLACEHOLDER__ after rendering"
  fi
  if ! plutil -lint "$tmp" >/dev/null; then
    rm -f "$tmp"
    die "$1 did not render into a valid plist"
  fi

  if [ -f "$dst" ] && cmp -s "$tmp" "$dst"; then
    ok "$dst (unchanged)"
  else
    install -m 644 "$tmp" "$dst"
    ok "$dst written"
  fi
  rm -f "$tmp"
}

step "unit files"
if [ "$do_server" -eq 1 ]; then render_plist "$LABEL_SERVER.plist"; fi
if [ "$do_bridge" -eq 1 ]; then render_plist "$LABEL_BRIDGE.plist"; fi

# ------------------------------------------------------------ (re)launch ----

step "launchctl"

if [ "$do_server" -eq 1 ]; then
  # Never kill a running server automatically: it owns every pane, and every
  # pane owns an agent that may be halfway through something.
  if pgrep -f 'herdr server' >/dev/null 2>&1 && ! job_loaded "$LABEL_SERVER"; then
    warn "a 'herdr server' is already running and was not started by launchd."
    warn "It keeps the socket, so this job will fail and retry every 30s until it stops."
    warn "It probably also has a dirty environment (G7). When no agent is mid-task:"
    warn "    pkill -f 'herdr server'   # this closes every pane"
  fi
  load_job "$LABEL_SERVER" "$LA_DIR/$LABEL_SERVER.plist"
fi

if [ "$do_bridge" -eq 1 ]; then
  load_job "$LABEL_BRIDGE" "$LA_DIR/$LABEL_BRIDGE.plist"
fi

# ----------------------------------------------------------- next steps -----

cat <<EOF

next steps

  1. ${bridge_bin:-herdr-agent} doctor
     Check configuration, herdr, installed executors and Feishu permissions.
     Fix failures for the executors you actually use.

  2. tail -f $LOG_DIR/herdr-agent.err.log
     Open http://127.0.0.1:18790/ for local management and authorization status.

  3. From your phone, message the bot: /help
     With pi configured, describe a discussion, development or review task.

worth knowing

  * LaunchAgents start at GUI login, not at boot. If the Mac reboots to the
    login window, nothing here runs until somebody logs in.
  * After changing ANY permission, event or the interactive-card toggle in the
    Feishu console, you must create and publish a version. Nothing takes effect
    otherwise, and the failure looks like a bug in the bridge. That is about
    later hand edits only: an app registered by herdr-agent setup arrived with
    its scopes granted and a version already published, so there is nothing to
    publish after it runs.
  * stop:     launchctl bootout   $DOMAIN/$LABEL_BRIDGE
  * restart:  launchctl kickstart -k $DOMAIN/$LABEL_BRIDGE
  * status:   launchctl print     $DOMAIN/$LABEL_BRIDGE
  * Nothing rotates $LOG_DIR. Truncate it when it bothers you.
EOF
