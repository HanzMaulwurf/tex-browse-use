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

# --- wait for engine health -----------------------------------------------
printf "starting engine on :%s " "$PORT"
engine_up=false
for i in $(seq 1 20); do
  if curl -s -m2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    engine_up=true; echo " up"; break
  fi
  printf "."; sleep 1
done
if [ "$engine_up" != true ]; then
  echo " FAILED — engine did not become healthy. Last log lines:" >&2
  tail -20 /tmp/tex-engine.log >&2
  exit 1
fi

# --- DOM tier: browser-use gateway (:18804) -------------------------------
# Auto-provisioned and optional. First start creates a Python venv and installs
# browser-use (slow, one-time); afterwards it's cached. Entirely best-effort:
# if it can't be set up (no network/python), the engine still runs fine on the
# screenshot tier. Disable explicitly with TEX_DOM_TIER=off.
VENV_PY="$STACK/.venv/bin/python"
GW_PORT="${UNIFIED_PORT:-18804}"

dom_deps_ok() { [ -x "$VENV_PY" ] && "$VENV_PY" -c "import browser_use, botocore" >/dev/null 2>&1; }
kill_port() { local p; p="$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"; [ -n "$p" ] && kill -9 $p 2>/dev/null || true; }

start_gateway() {
  dom_deps_ok || return 1
  [ -f "$RUN/gateway.pid" ] && kill "$(cat "$RUN/gateway.pid")" 2>/dev/null || true
  kill_port "$GW_PORT"
  nohup "$VENV_PY" "$STACK/src/browser/unified.py" > /tmp/tex-gateway.log 2>&1 &
  echo $! > "$RUN/gateway.pid"
  for i in $(seq 1 10); do
    curl -s -m2 "http://127.0.0.1:$GW_PORT/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

if [ "${TEX_DOM_TIER:-auto}" != "off" ]; then
  if ! dom_deps_ok; then
    if [ -f "$ROOT/requirements.txt" ] && command -v python3 >/dev/null 2>&1; then
      echo "DOM tier: provisioning Python venv (first run — can take a few minutes)…"
      python3 -m venv "$STACK/.venv" >/dev/null 2>&1 || true
      "$VENV_PY" -m pip install -q --upgrade pip >/dev/null 2>&1 || true
      "$VENV_PY" -m pip install -q -r "$ROOT/requirements.txt" \
        || echo "WARN: DOM tier deps failed to install — continuing with screenshot tier only." >&2
    fi
  fi
  if start_gateway; then
    echo "DOM tier ready on :$GW_PORT (browser-use DOM/CDP). Logs: /tmp/tex-gateway.log"
  else
    echo "DOM tier not active — screenshot tier still works. See /tmp/tex-gateway.log" >&2
  fi
fi

echo
echo "TEX engine ready. browse_use will connect via TEX_ENGINE_URL=http://127.0.0.1:$PORT"
echo "Logs: /tmp/tex-engine.log + /tmp/tex-gateway.log   Stop: scripts/tex-down.sh"
exit 0
