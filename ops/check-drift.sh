#!/bin/sh
# Exits non-zero when this directory and the live ops tooling disagree:
#   - a vendored file differs from, or is missing in, ~/bozeo-ops (every file here except
#     README.md and this script is a copy of ~/bozeo-ops/<same path>);
#   - a plist in launch-agents/ differs from ~/Library/LaunchAgents, or one in
#     launch-agents/retired/ from ~/Library/LaunchAgents.disabled;
#   - a sh.bozeo.* LaunchAgent is installed but not vendored, or runs a ~/bozeo-ops file that
#     isn't vendored.
#   ops/check-drift.sh
set -u
OPS=$(cd "$(dirname "$0")" && pwd)
LIVE="$HOME/bozeo-ops"
drift=0
say() {
  echo "$1"
  drift=1
}

for f in $(cd "$OPS" && find . -type f ! -name README.md ! -name check-drift.sh ! -name .DS_Store | sed 's#^\./##' | sort); do
  case "$f" in
    launch-agents/retired/*) live="$HOME/Library/LaunchAgents.disabled/${f#launch-agents/retired/}" ;;
    launch-agents/*) live="$HOME/Library/LaunchAgents/${f#launch-agents/}" ;;
    *) live="$LIVE/$f" ;;
  esac
  if [ ! -f "$live" ]; then
    say "missing live copy: $f (expected $live)"
  elif ! cmp -s "$OPS/$f" "$live"; then
    say "differs: $f <-> $live"
  fi
done

for plist in "$HOME"/Library/LaunchAgents/sh.bozeo.*.plist; do
  [ -f "$plist" ] || continue
  name=$(basename "$plist")
  [ -f "$OPS/launch-agents/$name" ] || say "unvendored LaunchAgent: $plist"
  for script in $(grep -o "$LIVE/[^<]*" "$plist"); do
    [ -f "$OPS/${script#"$LIVE"/}" ] || say "unvendored script run by $name: $script"
  done
done

[ "$drift" = 0 ] && echo "no drift"
exit "$drift"
