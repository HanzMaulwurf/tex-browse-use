#!/usr/bin/env bash
# Start the TEX browse-use engine locally (and optional Python tiers if a venv exists).
# Idempotent: re-running restarts cleanly. Logs to /tmp/tex-*.log, pids in .run/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/stack"
RUN="$ROOT/.run"
mkdir -p "$RUN"

# --- load env -------------------------------------------------------------
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
else
  echo "WARN: $ROOT/.env not found — copy .env.example to .env and set a provider key." >&2
fi

PORT="${PORT:-18802}"
export CUA_ROOT="${CUA_ROOT:-$STACK}"
export CU_AUDIT_DATABASE_URL="${CU_AUDIT_DATABASE_URL:-}"   # empty = audit disabled, engine still runs

# Runtime data dirs (gitignored — created on demand)
mkdir -p "$STACK"/data/{vault,sessions,skills,compiled,checkpoints}

# --- engine (:PORT) -------------------------------------------------------
if curl -s -m2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "engine already up on :$PORT — restarting"
  [ -f "$RUN/engine.pid" ] && kill "$(cat "$RUN/engine.pid")" 2>/dev/null || true
  sleep 1
fi

cd "$STACK"
nohup node --import tsx/esm src/server.ts > /tmp/tex-engine.log 2>&1 &
echo $! > "$RUN/engine.pid"

# --- wait for health ------------------------------------------------------
printf "starting engine on :%s " "$PORT"
for i in $(seq 1 20); do
  if curl -s -m2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo " up"
    curl -s "http://127.0.0.1:$PORT/health"; echo
    echo
    echo "TEX engine ready. browse_use will connect via TEX_ENGINE_URL=http://127.0.0.1:$PORT"
    echo "Logs: /tmp/tex-engine.log   Stop: scripts/tex-down.sh"
    exit 0
  fi
  printf "."; sleep 1
done

echo " FAILED — engine did not become healthy. Last log lines:" >&2
tail -20 /tmp/tex-engine.log >&2
exit 1
