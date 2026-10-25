#!/bin/sh
# Native Claude Code OAuth login for the APIxStar Grow MCP server, runnable by
# an agent whose shell has no terminal. Run it in the background with output
# redirected to a log, then poll the log:
#
#   sh "<installPath>/scripts/login.sh" > /tmp/growthpilot-login.log 2>&1 &
#
# `claude mcp login` needs a TTY, so it is started inside a pseudo-terminal.
# The log ends with one of these lines:
#   GROWTHPILOT_LOGIN_EXIT 0       login finished; confirm the Authenticated line
#   GROWTHPILOT_LOGIN_EXIT <status> login failed with that exit status
#   GROWTHPILOT_LOGIN_ERROR <reason> [detail]   nothing was attempted

server="${1:-plugin:growthpilot:growthpilot}"
lock="${TMPDIR:-/tmp}/growthpilot-login.lock.d"

fail() {
  echo "GROWTHPILOT_LOGIN_ERROR $*"
  exit 2
}

claude="${CLAUDE_BIN:-}"
if [ -z "$claude" ]; then
  claude="$(command -v claude 2>/dev/null)"
  [ -z "$claude" ] && [ -x "$HOME/.local/bin/claude" ] && claude="$HOME/.local/bin/claude"
fi
[ -n "$claude" ] && [ -x "$claude" ] || fail claude_not_found "Install or upgrade Claude Code, then rerun this script."
"$claude" mcp login --help >/dev/null 2>&1 || fail login_unsupported "Run 'claude update', then rerun this script."

# Keep exactly one login attempt active; mkdir is atomic.
if ! mkdir "$lock" 2>/dev/null; then
  owner="$(cat "$lock/pid" 2>/dev/null)"
  if [ -z "$owner" ] || kill -0 "$owner" 2>/dev/null; then
    fail already_running "Another login${owner:+ (pid $owner)} is still running; poll its log instead."
  fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || fail already_running "Another login just started; poll its log instead."
fi
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT
trap 'exit 130' INT TERM

echo "GROWTHPILOT_LOGIN_START $server"
if command -v python3 >/dev/null 2>&1; then
  # pty.spawn in Python 3.9 on macOS never returns after the child exits, so
  # copy the pseudo-terminal output ourselves until it closes.
  python3 -c '
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    os.write(1, data)
status = os.waitpid(pid, 0)[1]
sys.exit(status >> 8 if status & 127 == 0 else 128 + (status & 127))
' "$claude" mcp login "$server" < /dev/null
  status=$?
elif command -v script >/dev/null 2>&1; then
  if [ "$(uname)" = Linux ]; then
    script -qec "\"$claude\" mcp login \"$server\"" /dev/null < /dev/null
  else
    script -q /dev/null "$claude" mcp login "$server" < /dev/null
  fi
  status=$?
else
  fail no_pty "Neither python3 nor script is available; ask the user to run /mcp and choose Authenticate."
fi
echo "GROWTHPILOT_LOGIN_EXIT $status"
exit "$status"
