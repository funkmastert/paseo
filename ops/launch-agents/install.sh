#!/bin/sh
# Renders a templated plist (placeholder __HOME__) into ~/Library/LaunchAgents and bootstraps it.
# The plists here can't use $HOME themselves -- launchd doesn't expand it -- so this substitutes
# the real home directory at install time instead.
#
# Usage:
#   ops/launch-agents/install.sh <name>.plist            install (and bootstrap) a live agent
#   ops/launch-agents/install.sh --retired <name>.plist   render into ~/Library/LaunchAgents.disabled, no bootstrap
#   ops/launch-agents/install.sh --dry-run <name>.plist   print the rendered plist, write nothing
set -eu

RETIRED=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --retired) RETIRED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) break ;;
  esac
done

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: install.sh [--retired] [--dry-run] <name>.plist" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$RETIRED" = "1" ]; then
  SRC="$SCRIPT_DIR/retired/$NAME"
  DEST_DIR="$HOME/Library/LaunchAgents.disabled"
else
  SRC="$SCRIPT_DIR/$NAME"
  DEST_DIR="$HOME/Library/LaunchAgents"
fi

if [ ! -f "$SRC" ]; then
  echo "install.sh: no such plist: $SRC" >&2
  exit 1
fi

# Escape the sed replacement's special characters (\, & and the # delimiter) in the home path.
HOME_ESCAPED=$(printf '%s' "$HOME" | sed 's/[\\&#]/\\&/g')
RENDERED=$(sed "s#__HOME__#$HOME_ESCAPED#g" "$SRC")

if [ "$DRY_RUN" = "1" ]; then
  printf '%s\n' "$RENDERED"
  exit 0
fi

mkdir -p "$DEST_DIR"
printf '%s\n' "$RENDERED" > "$DEST_DIR/$NAME"
echo "installed $DEST_DIR/$NAME"

if [ "$RETIRED" = "0" ]; then
  # Re-installing a loaded agent: unload the old definition first, or bootstrap keeps it.
  launchctl bootout "gui/$(id -u)" "$DEST_DIR/$NAME" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$DEST_DIR/$NAME" \
    || echo "note: launchctl bootstrap failed; check 'launchctl list | grep bozeo'"
fi
