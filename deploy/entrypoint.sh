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
# Small hosts (e.g. Railway's smaller plans) get the runner killed for lack of RAM. Keep its footprint
# down: one request at a time, a short context window, and the model unloaded when idle.
# Set LOCAL_LLM=none to not run an on-device model at all (answers then come from the cloud model, or
# from the visitor's own browser once they've downloaded the offline AI).
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}" OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-2}" OLLAMA_CONTEXT_LENGTH="${OLLAMA_CONTEXT_LENGTH:-2048}"   ollama serve >"$DATA/ollama.log" 2>&1 &

wait_for http://127.0.0.1:6333/healthz
wait_for http://127.0.0.1:11434/api/tags

# Models are normally baked into the image; if not, pull them once into $OLLAMA_MODELS.
# Embeddings run inside the device (bge-small via ONNX) unless EMBED_BACKEND=ollama.
EMBED_PULL=none; [ "${EMBED_BACKEND:-onnx}" = "ollama" ] && EMBED_PULL="${EMBED_MODEL:-nomic-embed-text}"
for m in "$EMBED_PULL" "${LOCAL_LLM:-qwen2.5:3b}"; do
  [ "$m" = "none" ] && continue
  if ! ollama list | awk 'NR>1 {print $1}' | grep -qx -e "$m" -e "$m:latest"; then
    log "pulling $m (first start only)"
    ollama pull "$m" || log "could not pull $m, continuing in reduced mode"
  fi
done

# Session cookies are signed with AUTH_SECRET. The code is public, so never run on its default: without
# one set in the platform's variables, make a random one and keep it with the data (sessions survive
# restarts when $DATA is a persistent volume; otherwise everyone just signs in again).
if [ -z "${AUTH_SECRET:-}" ]; then
  [ -s "$DATA/.auth_secret" ] || head -c 32 /dev/urandom | base64 > "$DATA/.auth_secret"
  AUTH_SECRET="$(cat "$DATA/.auth_secret")"
  export AUTH_SECRET
  log "AUTH_SECRET not set: using a generated one (set it in the platform's variables to keep sessions across redeploys)"
fi

# Every device in deploy/demo.json runs inside ONE process (edge/host.py): Laptop :8101, Mobile :8102,
# the demo accounts :8111-8118 and their sign-in address :8100. Python, the libraries and the search
# model load once (~470 MB for all ten devices, instead of ~270 MB per device).
# DEMO_ACCOUNTS=0 runs only Laptop and Mobile.
log "starting the devices"
EDGEMIND_DATA="$DATA" python -m edge.host &
for port in $(python -c "import json; d=json.load(open('deploy/demo.json'))['devices']; import os; acc=os.getenv('DEMO_ACCOUNTS','1')=='1'; print(' '.join(str(x['port']) for x in d if acc or not x.get('account')) + (' 8100' if acc else ''))"); do
  wait_for "http://127.0.0.1:$port/api/session"
done

# A fresh deployment gets demo notes so visitors don't land on an empty app.
if [ "${SEED_DEMO:-1}" = "1" ] && [ ! -f "$DATA/.seeded" ]; then
  log "seeding demo notes (scenario: ${SEED_SCENARIO:-home})"
  python scripts/seed_demo.py --scenario "${SEED_SCENARIO:-home}" && touch "$DATA/.seeded" || log "seeding failed"
fi

# The accounts and teams are (re)checked on every start: the script only adds what's missing, so a
# person or note added to deploy/demo.json or the script shows up after the next deploy.
if [ "${DEMO_ACCOUNTS:-1}" = "1" ] && [ "${SEED_DEMO:-1}" = "1" ]; then
  log "seeding the demo accounts and teams"
  python scripts/seed_accounts.py || log "seeding the accounts failed"
fi

log "starting gateway on :${PORT:-7860}"
caddy run --config deploy/Caddyfile --adapter caddyfile &

log "EdgeMind is up: open / for the demo, /laptop/ or /mobile/ for one device, /app/ to sign in to the team accounts"
wait -n
log "a process exited; stopping so the platform restarts the container"
exit 1
