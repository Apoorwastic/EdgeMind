#!/usr/bin/env bash
# Runs the whole EdgeMind demo in one container:
#   Qdrant Server (shared store) · Ollama (on-device models) · Laptop + Mobile devices · Caddy gateway.
# If any of them dies, the container exits so the platform restarts it cleanly.
set -euo pipefail
cd /app

DATA="${EDGEMIND_DATA:-/data}"
mkdir -p "$DATA/qdrant"
log() { echo "[edgemind] $*"; }
wait_for() {
  for _ in $(seq 1 120); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  log "timed out waiting for $1"; return 1
}

log "starting Qdrant Server"
# Qdrant writes snapshots relative to its working dir, and /app isn't writable, so it runs from $DATA.
(cd "$DATA" && QDRANT__STORAGE__STORAGE_PATH="$DATA/qdrant" QDRANT__STORAGE__SNAPSHOTS_PATH="$DATA/qdrant_snapshots" \
  QDRANT__SERVICE__HOST=127.0.0.1 QDRANT__TELEMETRY_DISABLED=true QDRANT__LOG_LEVEL=WARN exec qdrant) &

log "starting Ollama"
OLLAMA_HOST=127.0.0.1:11434 ollama serve >"$DATA/ollama.log" 2>&1 &

wait_for http://127.0.0.1:6333/healthz
wait_for http://127.0.0.1:11434/api/tags

# Models are normally baked into the image; if not, pull them once into $OLLAMA_MODELS.
for m in "${EMBED_MODEL:-nomic-embed-text}" "${LOCAL_LLM:-qwen2.5:3b}"; do
  if ! ollama list | awk 'NR>1 {print $1}' | grep -qx -e "$m" -e "$m:latest"; then
    log "pulling $m (first start only)"
    ollama pull "$m" || log "could not pull $m, continuing in reduced mode"
  fi
done

start_device() {  # id name kind port
  log "starting $2 ($1) on :$4"
  DEVICE_ID="$1" DEVICE_NAME="$2" DEVICE_KIND="$3" PORT="$4" DATA_DIR="$DATA/$1" python -m edge &
}
start_device device_a Laptop laptop 8101
start_device device_b Mobile mobile 8102
wait_for http://127.0.0.1:8101/api/state
wait_for http://127.0.0.1:8102/api/state

# A fresh deployment gets demo notes so visitors don't land on an empty app.
if [ "${SEED_DEMO:-1}" = "1" ] && [ ! -f "$DATA/.seeded" ]; then
  log "seeding demo notes (scenario: ${SEED_SCENARIO:-home})"
  python scripts/seed_demo.py --scenario "${SEED_SCENARIO:-home}" && touch "$DATA/.seeded" || log "seeding failed"
fi

log "starting gateway on :${PORT:-7860}"
caddy run --config deploy/Caddyfile --adapter caddyfile &

log "EdgeMind is up: open / for the demo, /laptop/ or /mobile/ for one device"
wait -n
log "a process exited; stopping so the platform restarts the container"
exit 1
