#!/bin/bash
# Runs one heavy command (npm ci/install, npm run build:*, a workspace typecheck, a vitest run)
# while holding one of two machine-wide slots, so the CPU-policing agents never run more than
# two heavy steps at once. Waits for a free slot; frees a slot whose holder died.
#   ~/bozeo-ops/cpu-policing/heavy.sh npx vitest run src/foo.test.ts --bail=1 --maxWorkers=2
LOCKDIR="$HOME/bozeo-ops/cpu-policing/locks"
SLOTS=2
mkdir -p "$LOCKDIR"
announced=0
while true; do
  for i in $(seq 1 "$SLOTS"); do
    slot="$LOCKDIR/slot$i"
    if mkdir "$slot" 2>/dev/null; then
      echo "$$" > "$slot/pid"
      printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$PWD" "$*" > "$slot/cmd"
      trap 'rm -rf "$slot"' EXIT
      trap 'rm -rf "$slot"; exit 130' INT TERM
      "$@"
      rc=$?
      rm -rf "$slot"
      trap - EXIT INT TERM
      exit "$rc"
    fi
    pid=$(cat "$slot/pid" 2>/dev/null)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$slot"
    elif [ -z "$pid" ] && [ -n "$(find "$slot" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      rm -rf "$slot"
    fi
  done
  if [ "$announced" = 0 ]; then
    echo "heavy.sh: both slots busy, waiting:" >&2
    cat "$LOCKDIR"/slot*/cmd >&2 2>/dev/null
    announced=1
  fi
  sleep 5
done
