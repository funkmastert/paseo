#!/bin/sh
# Publish a web UI build to what https://bozeo.ngrok.app serves. Build first with
# `npm run build:daemon-web-ui` in the Bozeo checkout. The swap is two renames, so a visitor
# never sees a half-copied tree; the previous build stays at public-web-ui.prev.
set -eu
SRC="${1:-$HOME/paseo-worktrees/bozeo/packages/server/dist/server/web-ui}"
DEST="$HOME/.paseo/public-web-ui"
[ -f "$SRC/index.html" ] || { echo "no build at $SRC (run npm run build:daemon-web-ui)" >&2; exit 1; }
rm -rf "$DEST.next"
cp -R "$SRC" "$DEST.next"
rm -rf "$DEST.prev"
[ -d "$DEST" ] && mv "$DEST" "$DEST.prev"
mv "$DEST.next" "$DEST"
echo "published $(du -sh "$DEST" | cut -f1) from $SRC"
