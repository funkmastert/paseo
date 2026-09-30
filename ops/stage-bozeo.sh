#!/bin/zsh
# Build the fork's desktop app from the dev checkout and stage it as /Applications/Bozeo.app.
# /Applications keeps exactly one Bozeo.app, and nothing else anywhere is an app named Bozeo that
# Spotlight/Launchpad would show: the build it replaces is kept once, hidden, in
# ~/bozeo-ops/previous-build.noindex/ (for rollback). The build output in the checkout is deleted
# once it is copied. Nothing is staged unless the build, the update-feed check and the app
# typecheck all pass. Tyler relaunches Bozeo himself; this never touches the running daemon.
# Usage: stage-bozeo.sh            (log: ~/bozeo-ops/stage-<mmdd-HHMM>.log)
set -euo pipefail
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
B=/Users/tylerthackray/paseo-worktrees/bozeo
HEAVY=~/bozeo-ops/cpu-policing/heavy.sh
PREV_DIR=~/bozeo-ops/previous-build.noindex
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
NEW="$B/packages/desktop/release/mac-arm64/Bozeo.app"

cd "$B"
echo "== branch $(git log --oneline -1)"
[ -z "$(git status --porcelain)" ] || { echo "ABORT: checkout has uncommitted changes"; exit 1; }

nice -n 10 "$HEAVY" npm run build:desktop
[ -d "$NEW" ] || { echo "ABORT: no built app at $NEW"; exit 1; }
grep -q "owner: funkmastert" "$NEW/Contents/Resources/app-update.yml" \
  || { echo "ABORT: update feed does not point at funkmastert"; exit 1; }
echo "== update feed funkmastert"

# Expo only regenerates .expo/types/router.d.ts under `expo start`, not `expo export`, so a new
# screen fails the app typecheck until it is regenerated. Do it directly, then typecheck.
(cd packages/app && EXPO_ROUTER_APP_ROOT="$PWD/src/app" node -e '
  require("expo-router/build/typed-routes").regenerateDeclarations(require("path").resolve(".expo/types"), {});
  setTimeout(() => process.exit(0), 4000);')
(cd packages/app && nice -n 10 "$HEAVY" npm run typecheck >/dev/null) || { echo "ABORT: app typecheck failed"; exit 1; }
echo "== app typecheck ok"

if [ -d /Applications/Bozeo.app ]; then
  # Keep one rollback copy where Spotlight, Launchpad and "Open With" can't see it, so Tyler
  # never gets two apps called "Bozeo" to choose from. Folders ending in .noindex are skipped by
  # Spotlight; lsregister -u drops it from LaunchServices.
  mkdir -p "$PREV_DIR"
  rm -rf "$PREV_DIR/Bozeo.app"
  mv /Applications/Bozeo.app "$PREV_DIR/Bozeo.app"
  "$LSR" -u "$PREV_DIR/Bozeo.app" 2>/dev/null || true
  echo "== previous build kept (hidden) at $PREV_DIR/Bozeo.app"
fi
ditto "$NEW" /Applications/Bozeo.app
rm -rf "$B/packages/desktop/release/mac-arm64" "$B"/packages/desktop/release/*.dmg(N) "$B"/packages/desktop/release/*.zip(N) "$B"/packages/desktop/release/*.blockmap(N)
echo "STAGED $(stat -f %Sm -t '%H:%M' /Applications/Bozeo.app/Contents/Resources/app.asar) from $(git log --oneline -1 | cut -c1-9)"

nice -n 10 "$HEAVY" npm run build:daemon-web-ui
~/bozeo-ops/public-web/publish.sh "$B/packages/server/dist/server/web-ui"
echo "PUBLISHED"
afplay /System/Library/Sounds/Glass.aiff || true
