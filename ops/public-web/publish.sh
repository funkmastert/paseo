#!/bin/sh
# Publish a web UI build to what https://bozeo.ngrok.app serves. Build first with
# `npm run build:daemon-web-ui` in the Bozeo checkout. The swap is two renames, so a visitor
# never sees a half-copied tree; the previous build stays at public-web-ui.prev.
# It says which commit it publishes and records it in public-web-ui.commit (outside the served
# tree). It refuses when it can't vouch for that commit: the source checkout has uncommitted
# changes, or its HEAD moved after the build was made.
set -eu
SRC="${1:-$HOME/paseo-worktrees/bozeo/packages/server/dist/server/web-ui}"
DEST="$HOME/.paseo/public-web-ui"
[ -f "$SRC/index.html" ] || { echo "no build at $SRC (run npm run build:daemon-web-ui)" >&2; exit 1; }
TOP=$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null) || {
  echo "refusing: $SRC is not inside a git checkout, so there is no commit to name" >&2
  exit 1
}
COMMIT=$(git -C "$TOP" rev-parse HEAD)
DIRTY=$(git -C "$TOP" status --porcelain)
if [ -n "$DIRTY" ]; then
  echo "refusing: $TOP has uncommitted changes, so the build is not $COMMIT:" >&2
  printf '%s\n' "$DIRTY" | head -20 >&2
  exit 1
fi
# The newest HEAD reflog entry is when HEAD last moved. A build older than that is from another commit.
MOVED=$(git -C "$TOP" reflog -1 --date=unix --format=%gd HEAD 2>/dev/null | sed -n -E 's/.*@\{([0-9]+)\}$/\1/p')
BUILT=$(stat -f %m "$SRC/index.html")
if [ -n "$MOVED" ] && [ "$BUILT" -lt "$MOVED" ]; then
  echo "refusing: the build at $SRC predates the last HEAD move in $TOP (now $COMMIT); rebuild first" >&2
  exit 1
fi
echo "publishing $COMMIT from $TOP"
rm -rf "$DEST.next"
cp -R "$SRC" "$DEST.next"
rm -rf "$DEST.prev"
[ -d "$DEST" ] && mv "$DEST" "$DEST.prev"
mv "$DEST.next" "$DEST"
echo "$COMMIT" > "$DEST.commit"
echo "published $(du -sh "$DEST" | cut -f1) of $COMMIT from $SRC"
