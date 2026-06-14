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

# Belt-and-suspenders: kill anything still listening on the engine/gateway ports
# (covers orphans whose pidfile was lost — we've been bitten by that before).
for port in "${PORT:-18802}" "${UNIFIED_PORT:-18804}"; do
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null || true
    echo "freed port $port (pids $pids)"
    stopped=1
  fi
done

[ "$stopped" = 1 ] || echo "nothing running (no pids in $RUN, ports clear)"
