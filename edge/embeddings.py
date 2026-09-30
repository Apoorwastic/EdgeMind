"""On-device embeddings.

Dense vectors come from a local Ollama embedding model (nomic-embed-text).
Sparse BM25 vectors come from Qdrant Edge's built-in Bm25 model, so keyword
search needs no model server at all.

If Ollama is not running, we fall back to a deterministic hashed
bag-of-words vector so ingest never blocks. Records remember which embedder
produced them, and are re-embedded once the real model is back.
"""
import hashlib
import math
import re

import httpx
from qdrant_edge import Bm25, Bm25Config, SparseVector

TOKEN = re.compile(r"[a-z0-9]+")


class Embedder:
    def __init__(self, ollama_url: str, model: str, dim: int):
        self.url = ollama_url
        self.model = model
        self.dim = dim
        self.bm25 = Bm25(Bm25Config(language="english"))
        self.available: bool | None = None

    @property
    def name(self) -> str:
        return f"ollama/{self.model}" if self.available else "hash-fallback"

    async def dense(self, text: str, kind: str = "document") -> tuple[list[float], str]:
        # nomic-embed-text is trained with task prefixes.
        prefix = "search_query: " if kind == "query" else "search_document: "
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post(f"{self.url}/api/embed", json={"model": self.model, "input": [prefix + text]})
                r.raise_for_status()
                vec = r.json()["embeddings"][0]
            self.available = True
            return vec, f"ollama/{self.model}"
        except Exception:
            self.available = False
            return self._hash(text), "hash-fallback"

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
        try:
            async with httpx.AsyncClient(timeout=2) as c:
                r = await c.get(f"{self.url}/api/tags")
                names = [m["name"].split(":")[0] for m in r.json().get("models", [])]
                self.available = self.model.split(":")[0] in names
        except Exception:
            self.available = False
        return self.available
