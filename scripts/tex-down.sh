#!/usr/bin/env bash
# Stop the TEX engine (and any optional tiers) started by tex-up.sh.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/.run"

stopped=0
for f in "$RUN"/*.pid; do
  [ -e "$f" ] || continue
  pid="$(cat "$f")"
  if kill "$pid" 2>/dev/null; then
    echo "stopped $(basename "$f" .pid) (pid $pid)"
    stopped=1
  fi
  rm -f "$f"
done
[ "$stopped" = 1 ] || echo "nothing running (no pids in $RUN)"
