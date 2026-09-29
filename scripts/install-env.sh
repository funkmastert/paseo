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
# back to ~/.paseo or 127.0.0.1:6767. The path checks live in install-instance.mjs, which
# compares canonical paths: `<home>/`, `<home>/.` and a case variant are the same home.

unset -f bozeo_cli bozeo_guard bozeo_restart_instance _bozeo_check_args 2>/dev/null
unset BOZEO_CLI BOZEO_HOST BOZEO_CLEARED

_bozeo_env_ok=0
# The env file sets BOZEO_* without `export`, so check-env gets them explicitly.
# shellcheck disable=SC2097,SC2098
if ! command -v node >/dev/null 2>&1; then
  echo "STOP: node is not on PATH" >&2
elif [ -z "${BOZEO_SRC-}" ] || [ ! -f "$BOZEO_SRC/scripts/install-instance.mjs" ]; then
  echo "STOP: BOZEO_SRC is not this checkout; source the env file /install wrote" >&2
elif _bozeo_paths="$(BOZEO_SRC="$BOZEO_SRC" BOZEO_REPO="${BOZEO_REPO-}" BOZEO_HOME="${BOZEO_HOME-}" \
  BOZEO_PORT="${BOZEO_PORT-}" BOZEO_PROTECT="${BOZEO_PROTECT-}" \
  node "$BOZEO_SRC/scripts/install-instance.mjs" check-env)"; then
  # One canonical path per line: SRC, REPO, HOME. From here on every command uses these.
  BOZEO_SRC="$(printf '%s\n' "$_bozeo_paths" | sed -n 1p)"
  BOZEO_REPO="$(printf '%s\n' "$_bozeo_paths" | sed -n 2p)"
  BOZEO_HOME="$(printf '%s\n' "$_bozeo_paths" | sed -n 3p)"
  [ -n "$BOZEO_SRC" ] && [ -n "$BOZEO_REPO" ] && [ -n "$BOZEO_HOME" ] && _bozeo_env_ok=1
fi

if [ "$_bozeo_env_ok" = 1 ]; then
  BOZEO_CLI="$BOZEO_REPO/packages/cli/bin/paseo"
  BOZEO_HOST="127.0.0.1:$BOZEO_PORT"

  # Drop what this call inherited, so neither the CLI nor the daemon it starts sees it:
  # - PASEO_* and PORT, from the user's profile or a parent Paseo agent (PASEO_AGENT_ID, ...).
  # - The installing agent's Claude Code session: CLAUDECODE, CLAUDE_CODE_SESSION_ID,
  #   GIT_EDITOR, and the auth it runs on. The daemon strips only a few CLAUDE_CODE_* names at
  #   provider launch, so ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN or
  #   CLAUDE_CONFIG_DIR would otherwise reach every pooled session and bill the installer's
  #   key instead of the pool's accounts.
  # Names only; BOZEO_CLEARED lists what went. Unsetting a name that is not set is harmless.
  BOZEO_CLEARED=""
  for _bozeo_var in $(env | sed -n \
    -e 's/^\(PASEO_[A-Za-z0-9_]*\)=.*/\1/p' \
    -e 's/^\(CLAUDE[A-Za-z0-9_]*\)=.*/\1/p' \
    -e 's/^\(ANTHROPIC_[A-Za-z0-9_]*\)=.*/\1/p' \
    -e 's/^\(GIT_EDITOR\)=.*/\1/p' \
    -e 's/^\(PORT\)=.*/\1/p'); do
    unset "$_bozeo_var"
    BOZEO_CLEARED="${BOZEO_CLEARED:+$BOZEO_CLEARED }$_bozeo_var"
  done
  export PASEO_HOME="$BOZEO_HOME" PASEO_HOST="$BOZEO_HOST"

  # Succeeds only when this home's daemon is running and listening on BOZEO_HOST.
  bozeo_guard() {
    if [ ! -f "$BOZEO_REPO/packages/cli/dist/index.js" ]; then
      echo "STOP: $BOZEO_CLI is not built yet" >&2
      return 1
    fi
    node "$BOZEO_SRC/scripts/install-instance.mjs" config-listen "$BOZEO_HOME" "$BOZEO_HOST" || return 1
    "$BOZEO_CLI" daemon status --home "$BOZEO_HOME" --json 2>/dev/null |
      node "$BOZEO_SRC/scripts/install-instance.mjs" guard "$BOZEO_HOME" "$BOZEO_HOST"
  }

  # Refuses anything /install does not run. Commander accepts options anywhere, so every
  # argument is looked at: `bozeo_cli --json daemon stop` and `bozeo_cli daemon stop --home
  # <other>` are both refused.
  _bozeo_check_args() {
    case "${1-} ${2-}" in
      "daemon start" | "daemon status" | "reload "* | "plugin ls" | "plugin install" | \
        "plugin logs" | "doctor "* | "ls "* | "--version " | "--help ") ;;
      *)
        echo "STOP: /install never runs 'paseo $*'. Put options after the command; ask the user for anything else." >&2
        return 1
        ;;
    esac
    _bozeo_prev=""
    for _bozeo_arg in "$@"; do
      _bozeo_value=""
      case "$_bozeo_prev" in --home | --host | --port) _bozeo_value="$_bozeo_arg" ;; esac
      case "$_bozeo_arg" in
        stop | restart | kill | --listen | --listen=*)
          echo "STOP: /install never runs 'paseo $*'. Ask the user." >&2
          return 1
          ;;
        --home=* | --host=* | --port=*)
          _bozeo_prev="${_bozeo_arg%%=*}"
          _bozeo_value="${_bozeo_arg#*=}"
          ;;
      esac
      case "$_bozeo_prev" in
        --home)
          if ! node "$BOZEO_SRC/scripts/install-instance.mjs" same-path "$_bozeo_value" "$BOZEO_HOME"; then
            echo "STOP: --home $_bozeo_value is not this instance's home $BOZEO_HOME" >&2
            return 1
          fi
          ;;
        --host)
          if [ "$_bozeo_value" != "$BOZEO_HOST" ]; then
            echo "STOP: --host $_bozeo_value is not this instance's host $BOZEO_HOST" >&2
            return 1
          fi
          ;;
        --port)
          if [ "$_bozeo_value" != "$BOZEO_PORT" ]; then
            echo "STOP: --port $_bozeo_value is not this instance's port $BOZEO_PORT" >&2
            return 1
          fi
          ;;
      esac
      _bozeo_prev="$_bozeo_arg"
    done
    return 0
  }

  # This checkout's CLI, pinned to this instance. `daemon start` and `daemon status` need the
  # home's config.json to say BOZEO_HOST (Step 7 writes it); every other command needs that
  # daemon running first.
  bozeo_cli() {
    _bozeo_check_args "$@" || return 1
    case "${1-} ${2-}" in
      "daemon start" | "daemon status")
        node "$BOZEO_SRC/scripts/install-instance.mjs" config-listen "$BOZEO_HOME" "$BOZEO_HOST" || return 1
        ;;
      "--version " | "--help ") ;;
      *) bozeo_guard || return 1 ;;
    esac
    "$BOZEO_CLI" "$@"
  }

  # The only restart /install may run, and only when the user asks: this instance's own daemon,
  # after the guard has confirmed it is the one running on BOZEO_HOST.
  bozeo_restart_instance() {
    bozeo_guard || return 1
    "$BOZEO_CLI" daemon restart --home "$BOZEO_HOME" --port "$BOZEO_PORT"
  }
fi

unset _bozeo_env_ok _bozeo_var _bozeo_paths _bozeo_prev _bozeo_arg _bozeo_value
