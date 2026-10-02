#!/usr/bin/env bash
# Runs the whole EdgeMind demo in one container:
#   Qdrant Server (shared store) · Ollama (optional on-device model) · every EdgeMind device in ONE
#   process (edge/host.py) · Caddy on $PORT.
# The main link opens the sign-in page (/app/). The devices are supervised: if the process dies (e.g. the
# host runs out of memory) it's started again; if Qdrant or Caddy dies, the container exits and the
# platform restarts it.
set -euo pipefail
cd /app

DATA="${EDGEMIND_DATA:-/data}"
mkdir -p "$DATA/qdrant"
log() { echo "[edgemind] $*"; }
wait_for() {
  for _ in $(seq 1 180); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  log "timed out waiting for $1"; return 1
}

# Linux gives every thread its own malloc arena (up to 8 per CPU, 64 MB each); with ten devices
# embedding on worker threads that alone can cost hundreds of MB. Two arenas are plenty here.
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

log "starting Qdrant Server"
# Qdrant writes snapshots relative to its working dir, and /app isn't writable, so it runs from $DATA.
(cd "$DATA" && QDRANT__STORAGE__STORAGE_PATH="$DATA/qdrant" QDRANT__STORAGE__SNAPSHOTS_PATH="$DATA/qdrant_snapshots" \
  QDRANT__SERVICE__HOST=127.0.0.1 QDRANT__TELEMETRY_DISABLED=true QDRANT__LOG_LEVEL=WARN exec qdrant) &

# Ollama is only needed for an on-device answer model. LOCAL_LLM=none (recommended on small hosts such as
# Railway) skips it: answers come from the cloud model, or from the visitor's browser offline AI.
if [ "${LOCAL_LLM:-qwen2.5:3b}" != "none" ] || [ "${EMBED_BACKEND:-onnx}" = "ollama" ]; then
  log "starting Ollama"
  OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}" OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-2}" \
    OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-2048}" ollama serve >"$DATA/ollama.log" 2>&1 &
  wait_for http://127.0.0.1:11434/api/tags
  EMBED_PULL=none; [ "${EMBED_BACKEND:-onnx}" = "ollama" ] && EMBED_PULL="${EMBED_MODEL:-nomic-embed-text}"
  for m in "$EMBED_PULL" "${LOCAL_LLM:-qwen2.5:3b}"; do
    [ "$m" = "none" ] && continue
    if ! ollama list | awk 'NR>1 {print $1}' | grep -qx -e "$m" -e "$m:latest"; then
      log "pulling $m (first start only)"
      ollama pull "$m" || log "could not pull $m, continuing in reduced mode"
    fi
  done
else
  log "LOCAL_LLM=none: not starting Ollama"
fi
wait_for http://127.0.0.1:6333/healthz

# Session cookies are signed with AUTH_SECRET. The code is public, so never run on its default: without
# one set in the platform's variables, make a random one and keep it with the data (sessions survive
# restarts when $DATA is a persistent volume; otherwise everyone just signs in again).
if [ -z "${AUTH_SECRET:-}" ]; then
  [ -s "$DATA/.auth_secret" ] || head -c 32 /dev/urandom | base64 > "$DATA/.auth_secret"
  AUTH_SECRET="$(cat "$DATA/.auth_secret")"
  export AUTH_SECRET
  log "AUTH_SECRET not set: using a generated one (set it in the platform's variables to keep sessions across redeploys)"
fi

# Which devices run (deploy/demo.json): by default only the accounts behind the sign-in page.
# DEMO_OPEN_DEVICES=1 also runs the open Laptop and Mobile devices (the side-by-side page at /demo/).
export DEMO_OPEN_DEVICES="${DEMO_OPEN_DEVICES:-0}"
export EDGEMIND_DATA="$DATA"
PORTS="$(python -m edge.host --ports)"

# Every device runs inside ONE process (edge/host.py): Python, the libraries and the search model load
# once. Supervised: if it's killed, it starts again, and the next seed run fills in anything missing.
(
  while true; do
    python -m edge.host || log "the devices stopped (exit $?): starting them again in 3 s"
    sleep 3
  done
) &

log "starting Caddy on :${PORT:-7860}"
caddy run --config deploy/Caddyfile --adapter caddyfile &

for port in $PORTS; do wait_for "http://127.0.0.1:$port/api/session"; done

# A fresh deployment gets demo notes so visitors don't land on an empty app. The accounts and teams are
# (re)checked on every start: the script only adds what's missing.
if [ "${SEED_DEMO:-1}" = "1" ]; then
  if [ "$DEMO_OPEN_DEVICES" = "1" ] && [ ! -f "$DATA/.seeded" ]; then
    log "seeding the Laptop and Mobile demo notes (scenario: ${SEED_SCENARIO:-home})"
    python scripts/seed_demo.py --scenario "${SEED_SCENARIO:-home}" && touch "$DATA/.seeded" || log "seeding failed"
  fi
  if [ "${DEMO_ACCOUNTS:-1}" = "1" ]; then
    log "seeding the demo accounts and teams"
    for attempt in 1 2 3; do
      python scripts/seed_accounts.py && break
      log "seeding the accounts failed (try $attempt of 3)"; sleep 10
      for port in $PORTS; do wait_for "http://127.0.0.1:$port/api/session"; done
    done
  fi
fi

log "EdgeMind is up: open / to sign in (/app/)"
wait -n
log "Qdrant or Caddy exited; stopping so the platform restarts the container"
exit 1
