# EdgeMind: all-in-one demo image.
#
# One container runs the Qdrant Server (shared store), Ollama (on-device models), both devices
# (Laptop = desktop UI, Mobile = phone UI) and a Caddy gateway on $PORT (7860, the Hugging Face default).
#
#   docker build -t edgemind .                        # models baked in (~2.2 GB extra, no download at boot)
#   docker build -t edgemind --build-arg BAKE_MODELS=0 .   # smaller image, models pulled on first start
#   docker run -p 7860:7860 -e OPENAI_API_KEY=sk-... edgemind

ARG OLLAMA_VERSION=0.34.4
ARG QDRANT_VERSION=v1.19.1

# ---- web UI --------------------------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- Ollama, CPU-only ----------------------------------------------------------------------------
FROM ollama/ollama:${OLLAMA_VERSION} AS ollama
# Cloud CPU hosts have no GPU: drop the CUDA/ROCm runtimes, which are most of the image.
RUN rm -rf /usr/lib/ollama/cuda_* /usr/lib/ollama/mlx_* /usr/lib/ollama/rocm* /usr/lib/ollama/vulkan* 2>/dev/null || true

# ---- models (optional bake) ----------------------------------------------------------------------
FROM ollama AS models
ARG BAKE_MODELS=1
ARG EMBED_MODEL=nomic-embed-text
ARG LOCAL_LLM=qwen2.5:3b
ENV OLLAMA_MODELS=/models
RUN mkdir -p /models && if [ "$BAKE_MODELS" = "1" ]; then \
      (ollama serve >/tmp/ollama.log 2>&1 &) && sleep 5 && \
      ollama pull "$EMBED_MODEL" && ollama pull "$LOCAL_LLM"; \
    fi

FROM qdrant/qdrant:${QDRANT_VERSION} AS qdrant
FROM caddy:2 AS caddy

# ---- runtime -------------------------------------------------------------------------------------
# Debian 13: Ollama 0.34 is built on Ubuntu 24.04 and needs glibc >= 2.38.
FROM python:3.12-slim-trixie
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 libunwind8 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 user
# Hugging Face Spaces runs containers as uid 1000, so everything writable belongs to "user".

COPY --from=qdrant /qdrant/qdrant /usr/local/bin/qdrant
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
# Ollama finds its llama-server engine relative to its own binary, so keep the upstream layout.
COPY --from=ollama /usr/bin/ollama /usr/bin/ollama
COPY --from=ollama /usr/lib/ollama /usr/lib/ollama
COPY --from=models --chown=user /models /models

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=user edge ./edge
COPY --chown=user scripts ./scripts
COPY --chown=user deploy ./deploy
COPY --from=web --chown=user /web/dist ./web/dist
RUN chmod +x deploy/entrypoint.sh && mkdir -p /data && chown user /data

ENV HOME=/home/user \
    EDGEMIND_DATA=/data \
    OLLAMA_MODELS=/models \
    QDRANT_URL=http://127.0.0.1:6333 \
    OLLAMA_URL=http://127.0.0.1:11434 \
    PORT=7860 \
    ASK_RATE_LIMIT=20 \
    PYTHONUNBUFFERED=1 \
    INTERNET_CHECK=""
# INTERNET_CHECK is empty because a server is always online, and some hosts (e.g. Railway) block the raw
# TCP probe to 1.1.1.1/8.8.8.8, which left every device stuck on "no internet". Visitors demo offline
# mode with the switch; the probe only measures the server's link, never the visitor's Wi-Fi.

USER user
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["deploy/entrypoint.sh"]
