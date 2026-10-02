"""On-device embeddings.

Dense vectors come from bge-small-en-v1.5 running in this process through ONNX Runtime (fastembed):
~15 ms per question on a laptop CPU and ~100 MB of RAM, where calling Ollama's nomic-embed-text took
0.7-1.7 s locally (20 s on a memory-starved server). It is also the model the browser uses offline,
so online and offline search score notes the same way. EMBED_BACKEND=ollama keeps the old path.

Sparse BM25 vectors come from Qdrant Edge's built-in Bm25 model, so keyword search needs no model at all.

If the dense model can't run (not downloaded yet, Ollama down), we fall back to a deterministic hashed
bag-of-words vector so ingest never blocks. Records remember which embedder produced them, and are
re-embedded once the real model is back.
"""
import asyncio
import hashlib
import math
import os
import re
import threading
from collections import OrderedDict

import httpx
from qdrant_edge import Bm25, Bm25Config, SparseVector

TOKEN = re.compile(r"[a-z0-9]+")
# One loaded model per process, shared by every device in it (edge/host.py runs many devices in one
# process): the model is ~125 MB of RAM, which would otherwise be paid once per device.
_MODELS: dict[str, object] = {}
_MODELS_LOCK = threading.RLock()
BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


class Embedder:
    def __init__(self, ollama_url: str, model: str, dim: int, backend: str = "onnx", cache_dir: str | None = None):
        self.url = ollama_url
        self.model = model
        self.dim = dim
        self.backend = backend
        self.cache_dir = cache_dir
        self.bm25 = Bm25(Bm25Config(language="english"))
        self.available: bool | None = None
        self._onnx = None
        self._onnx_lock = threading.Lock()
        self._queries: OrderedDict[str, list[float]] = OrderedDict()  # recent question vectors

    @property
    def name(self) -> str:
        if not self.available:
            return "hash-fallback"
        return f"onnx/{self.model.split('/')[-1]}" if self.backend == "onnx" else f"ollama/{self.model}"

    # ---- ONNX (default) ---------------------------------------------------

    def _load_onnx(self):
        if self._onnx is None:
            with _MODELS_LOCK:
                if self.model not in _MODELS:
                    from fastembed import TextEmbedding  # imported lazily: ~0.4 s, and only for this backend
                    # One ONNX thread: a single short note takes ~15 ms either way, and every extra
                    # thread costs memory (ONNX_THREADS raises it on big machines).
                    _MODELS[self.model] = TextEmbedding(self.model, cache_dir=self.cache_dir,
                                                        threads=int(os.getenv("ONNX_THREADS", "1")))
                self._onnx = _MODELS[self.model]
        return self._onnx

    def _embed_onnx(self, text: str, kind: str) -> list[float]:
        prefix = BGE_QUERY_PREFIX if kind == "query" and "bge" in self.model.lower() else ""
        model = self._load_onnx()
        with _MODELS_LOCK:  # devices sharing the model take turns (~15 ms each)
            return [float(x) for x in next(iter(model.embed([prefix + text])))]

    # ---- shared -----------------------------------------------------------

    async def dense(self, text: str, kind: str = "document") -> tuple[list[float], str]:
        key = text.strip().lower()
        if kind == "query" and key in self._queries:  # asked again: no model call at all
            self._queries.move_to_end(key)
            return self._queries[key], self.name
        try:
            if self.backend == "onnx":
                vec = await asyncio.to_thread(self._embed_onnx, text, kind)
            else:
                # nomic-embed-text is trained with task prefixes.
                prefix = "search_query: " if kind == "query" else "search_document: "
                async with httpx.AsyncClient(timeout=20) as c:
                    r = await c.post(f"{self.url}/api/embed", json={"model": self.model, "input": [prefix + text]})
                    r.raise_for_status()
                    vec = r.json()["embeddings"][0]
            self.available = True
        except Exception:
            self.available = False
            return self._hash(text), "hash-fallback"
        if kind == "query":
            self._queries[key] = vec
            if len(self._queries) > 256:
                self._queries.popitem(last=False)
        return vec, self.name

    def _hash(self, text: str) -> list[float]:
        v = [0.0] * self.dim
        for tok in TOKEN.findall(text.lower()):
            h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
            v[h % self.dim] += 1.0 if (h >> 64) & 1 else -1.0
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        return [x / n for x in v]

    def sparse_doc(self, text: str) -> SparseVector:
        return self.bm25.embed_document(text)

    def sparse_query(self, text: str) -> SparseVector:
        return self.bm25.embed_query(text)

    async def check(self) -> bool:
        if self.backend == "onnx":
            try:
                await asyncio.to_thread(self._load_onnx)  # first run downloads the model (~67 MB) once
                self.available = True
            except Exception:
                self.available = False
            return self.available
        try:
            async with httpx.AsyncClient(timeout=2) as c:
                r = await c.get(f"{self.url}/api/tags")
                names = [m["name"].split(":")[0] for m in r.json().get("models", [])]
                self.available = self.model.split(":")[0] in names
        except Exception:
            self.available = False
        return self.available


def default_embedding() -> tuple[str, str, int]:
    """(backend, model, dim) from the environment; in-process bge-small unless told otherwise."""
    backend = os.getenv("EMBED_BACKEND", "onnx").lower()
    if backend == "ollama":
        return backend, os.getenv("EMBED_MODEL", "nomic-embed-text"), int(os.getenv("EMBED_DIM", "768"))
    # Separate variables: existing .env files set EMBED_MODEL=nomic-embed-text for the Ollama path.
    return "onnx", os.getenv("ONNX_EMBED_MODEL", "BAAI/bge-small-en-v1.5"), int(os.getenv("ONNX_EMBED_DIM", "384"))
