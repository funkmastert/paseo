# Sourced, never executed, by the /install command (.claude/commands/install.md) at the top of
# every shell call. An agent's shell does not keep variables between tool calls, so the target
# daemon is pinned again on every call from the values in the env file /install writes:
#
#   BOZEO_SRC   checkout /install runs from (holds this file)
#   BOZEO_REPO  checkout that is built and runs the daemon (BOZEO_SRC, or a separate clone)
#   BOZEO_HOME  absolute Paseo home of the instance /install creates
#   BOZEO_PORT  its TCP port
#   BOZEO_PROTECT  existing installs that must not be touched, as `|<home>|<port>|...|`
#
# Works in bash and zsh (macOS runs agent shells in zsh). If anything is wrong it defines no
# functions, so every later `bozeo_cli` call fails with "command not found" instead of falling
# back to ~/.paseo or 127.0.0.1:6767.

unset -f bozeo_cli bozeo_guard 2>/dev/null

_bozeo_env_ok=1
for _bozeo_var in BOZEO_SRC BOZEO_REPO BOZEO_HOME BOZEO_PORT; do
  eval "_bozeo_val=\${$_bozeo_var-}"
  case "$_bozeo_val" in
    "")
      echo "STOP: $_bozeo_var is not set; source the env file /install wrote" >&2
      _bozeo_env_ok=0
      ;;
    *"~"*)
      echo "STOP: $_bozeo_var contains '~'; use an absolute path" >&2
      _bozeo_env_ok=0
      ;;
  esac
done
case "${BOZEO_PORT-}" in
  "" | *[!0-9]*) _bozeo_env_ok=0 ;;
esac
for _bozeo_var in BOZEO_SRC BOZEO_REPO BOZEO_HOME; do
  eval "_bozeo_val=\${$_bozeo_var-}"
  case "$_bozeo_val" in
    /* | [A-Za-z]:/*) ;;
    *)
      echo "STOP: $_bozeo_var is not an absolute path: $_bozeo_val" >&2
      _bozeo_env_ok=0
      ;;
  esac
done
# `|`-delimited so a home with a space in it still matches, in bash and in zsh alike.
case "${BOZEO_PROTECT-}" in
  *"|${BOZEO_HOME-}|"* | *"|${BOZEO_PORT-}|"*)
    echo "STOP: BOZEO_HOME or BOZEO_PORT belongs to an existing install: ${BOZEO_PROTECT}" >&2
    _bozeo_env_ok=0
    ;;
esac

if [ "$_bozeo_env_ok" = 1 ]; then
  BOZEO_CLI="$BOZEO_REPO/packages/cli/bin/paseo"
  BOZEO_HOST="127.0.0.1:$BOZEO_PORT"

  # Drop daemon settings inherited from the user's profile or from a parent Paseo agent
  # (PASEO_AGENT_ID, PASEO_LISTEN, PORT, ...), then pin this instance for the rest of the call.
  for _bozeo_var in $(env | sed -n 's/^\(PASEO_[A-Za-z0-9_]*\)=.*/\1/p'); do
    unset "$_bozeo_var"
  done
  unset PORT
  export PASEO_HOME="$BOZEO_HOME" PASEO_HOST="$BOZEO_HOST"

  # Succeeds only when this home's daemon is running and listening on BOZEO_HOST.
  bozeo_guard() {
    if [ ! -f "$BOZEO_REPO/packages/cli/dist/index.js" ]; then
      echo "STOP: $BOZEO_CLI is not built yet" >&2
      return 1
    fi
    "$BOZEO_CLI" daemon status --home "$BOZEO_HOME" --json 2>/dev/null |
      node -e '
        const [home, host] = process.argv.slice(1);
        let raw = "";
        process.stdin.on("data", (chunk) => (raw += chunk));
        process.stdin.on("end", () => {
          let status = {};
          try { status = JSON.parse(raw) ?? {}; } catch {}
          const { localDaemon, listen } = status;
          if (localDaemon === "running" && listen === host && status.home === home) process.exit(0);
          console.error(`STOP: expected a running daemon for ${home} on ${host}; daemon status says ${localDaemon ?? "unknown"} on ${listen ?? "unknown"} for ${status.home ?? "unknown"}`);
          process.exit(1);
        });
      ' "$BOZEO_HOME" "$BOZEO_HOST"
  }

  # This checkout's CLI, pinned to this instance. Refuses daemon stop/restart: /install never
  # restarts a daemon, and `paseo reload` asks for a restart it does not need (see install.md).
  bozeo_cli() {
    case "${1-} ${2-}" in
      "restart "* | "daemon restart" | "daemon stop")
        echo "STOP: /install never runs '$1 ${2-}'. Ask the user." >&2
        return 1
        ;;
      "daemon start" | "daemon status" | "--version "* | "--help "*) ;;
      *) bozeo_guard || return 1 ;;
    esac
    "$BOZEO_CLI" "$@"
  }
fi

unset _bozeo_env_ok _bozeo_var _bozeo_val
