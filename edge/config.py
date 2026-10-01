"""Runtime settings for one EdgeMind device process.

Each device is the same code started with a different DEVICE_ID / PORT, so a
two-device demo is just two processes with two separate data directories.
"""
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    device_id: str
    device_name: str
    device_kind: str  # "laptop" or "mobile" — picks which UI the device serves
    port: int
    data_dir: Path

    qdrant_url: str
    qdrant_api_key: str | None
    collection: str
    internet_hosts: list[tuple[str, int]]

    ollama_url: str
    embed_model: str
    embed_dim: int
    local_llm: str
    local_llm_fallback: str

    # Cloud model for online answers: Gemini when GEMINI_API_KEY is set, else OpenAI. Both are called
    # through the OpenAI SDK (Gemini serves an OpenAI-compatible endpoint).
    cloud_provider: str
    cloud_api_key: str | None
    cloud_model: str
    cloud_base_url: str | None

    web_dist: Path


def _hosts(spec: str) -> list[tuple[str, int]]:
    """'1.1.1.1:443,8.8.8.8:443' → [('1.1.1.1', 443), ...]; empty disables the internet check."""
    out = []
    for item in filter(None, (x.strip() for x in spec.split(","))):
        host, _, port = item.rpartition(":")
        out.append((host, int(port)))
    return out


GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"


def _cloud_settings() -> dict:
    if key := os.getenv("GEMINI_API_KEY"):
        return dict(cloud_provider="Gemini", cloud_api_key=key,
                    cloud_model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"), cloud_base_url=GEMINI_BASE_URL)
    return dict(cloud_provider="OpenAI", cloud_api_key=os.getenv("OPENAI_API_KEY") or None,
                cloud_model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"), cloud_base_url=None)


def load_settings() -> Settings:
    device_id = os.getenv("DEVICE_ID", "device_a")
    return Settings(
        device_id=device_id,
        device_name=os.getenv("DEVICE_NAME", device_id.replace("_", " ").title()),
        device_kind=os.getenv("DEVICE_KIND", "laptop"),
        port=int(os.getenv("PORT", "8101")),
        data_dir=Path(os.getenv("DATA_DIR", ROOT / "data" / device_id)),
        qdrant_url=os.getenv("QDRANT_URL", "http://127.0.0.1:6333"),
        qdrant_api_key=os.getenv("QDRANT_API_KEY") or None,
        collection=os.getenv("QDRANT_COLLECTION", "edgemind_shared"),
        internet_hosts=_hosts(os.getenv("INTERNET_CHECK", "1.1.1.1:443,8.8.8.8:443")),
        ollama_url=os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/"),
        embed_model=os.getenv("EMBED_MODEL", "nomic-embed-text"),
        embed_dim=int(os.getenv("EMBED_DIM", "768")),
        local_llm=os.getenv("LOCAL_LLM", "qwen2.5:3b"),
        local_llm_fallback=os.getenv("LOCAL_LLM_FALLBACK", "phi3"),
        **_cloud_settings(),
        web_dist=ROOT / "web" / "dist",
    )


settings = load_settings()
