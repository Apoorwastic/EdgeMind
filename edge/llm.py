"""Generation: on-device LLM (Ollama) and cloud LLM (OpenAI).

Both use the same grounded prompt shape, so the only thing that changes when
the device goes online is who does the writing, never what context is used.
"""
import json
import os
import time
from collections.abc import AsyncIterator

import httpx
from openai import APIStatusError, AsyncOpenAI, AuthenticationError, PermissionDeniedError

from .network import NetworkGate


class OllamaError(RuntimeError):
    """Ollama refused a request; the message is Ollama's own (e.g. not enough memory to load the model)."""

SYSTEM = (
    "You are EdgeMind, a personal memory assistant. Answer the user's question using ONLY the "
    "memories provided. Memories are listed newest first; if two memories conflict, prefer the newer one "
    "and say that an older note disagreed. If the memories do not contain the answer, say so plainly — "
    "do not invent facts. Be concise (1-4 sentences). Cite memories inline like [1], [2]."
)

# Used when no note matches: behave like a general assistant, but never pretend the answer came from notes.
SYSTEM_GENERAL = (
    "You are EdgeMind, a helpful assistant. Nothing in the user's personal notes matched this question, "
    "so answer from your general knowledge. Do not claim the answer comes from their notes or memories. "
    "Be clear and concise (at most 6 sentences, or a short list). If you are not sure, say so."
)

# Keep the on-device model loaded between questions; reloading costs ~7 s on a CPU-only machine.
KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")

# Small local models sometimes keep writing past the answer ("### Instruction 2 ..."); cut them off.
STOP = ["\n###", "### ", "\nQuestion:", "\nMemories:", "\nUser:", "<|end|>", "<|user|>", "<|im_end|>"]


def build_messages(question: str, hits: list[dict], history: list[dict], general: bool = False) -> list[dict]:
    if general:
        msgs = [{"role": "system", "content": SYSTEM_GENERAL}]
        for turn in history[-4:]:
            msgs.append({"role": turn["role"], "content": turn["text"]})
        msgs.append({"role": "user", "content": question})
        return msgs
    if hits:
        lines = []
        for i, h in enumerate(hits, 1):
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(h["ts"] / 1000))
            lines.append(f"[{i}] ({when}) {h['text']}")
        context = "\n".join(lines)
    else:
        context = "(no relevant memories found)"
    # Memory answers deliberately get no chat history: retrieval already ran on this question alone, and
    # small local models otherwise blend earlier turns into the answer (e.g. a previous note's date).
    msgs = [{"role": "system", "content": SYSTEM}]
    msgs.append({"role": "user", "content": f"Memories:\n{context}\n\nQuestion: {question}"})
    return msgs


def _installed(name: str, tags: list[str]) -> bool:
    """'phi3' matches 'phi3:latest'; 'qwen2.5:3b' must match its tag exactly."""
    return name in tags or (":" not in name and f"{name}:latest" in tags)


class LocalLLM:
    def __init__(self, ollama_url: str, model: str, fallbacks: list[str] | None = None):
        self.url = ollama_url
        self.preferred = [model, *(f for f in (fallbacks or []) if f and f != model)]
        self.model = model
        self.available: bool | None = None

    async def check(self) -> bool:
        """Use the first preferred model that Ollama actually has installed."""
        try:
            async with httpx.AsyncClient(timeout=2) as c:
                r = await c.get(f"{self.url}/api/tags")
                tags = [m["name"] for m in r.json().get("models", [])]
            found = next((m for m in self.preferred if _installed(m, tags)), None)
            self.available = found is not None
            if found:
                self.model = found
        except Exception:
            self.available = False
        return self.available

    async def warm_up(self) -> None:
        """Load the model into memory at boot so the first question isn't the slow one."""
        if not self.available:
            return
        try:
            async with httpx.AsyncClient(timeout=180) as c:
                await c.post(f"{self.url}/api/generate", json={"model": self.model, "prompt": "", "keep_alive": KEEP_ALIVE})
        except Exception:
            pass

    async def stream(self, messages: list[dict], max_tokens: int = 400) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=3)) as c:
            async with c.stream(
                "POST",
                f"{self.url}/api/chat",
                json={"model": self.model, "messages": messages, "stream": True, "keep_alive": KEEP_ALIVE,
                      "options": {"temperature": 0.2, "num_predict": max_tokens, "stop": STOP}},
            ) as r:
                if r.status_code >= 400:
                    body = (await r.aread()).decode(errors="replace")
                    try:
                        body = json.loads(body).get("error", body)
                    except (ValueError, AttributeError):
                        pass
                    raise OllamaError(f"Ollama {r.status_code}: {body[:200]}")
                async for line in r.aiter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    if t := chunk.get("message", {}).get("content"):
                        yield t
                    if chunk.get("done"):
                        break


class CloudLLM:
    def __init__(self, api_key: str | None, model: str, gate: NetworkGate,
                 provider: str = "OpenAI", base_url: str | None = None):
        self.model = model
        self.gate = gate
        self.provider = provider
        self.host = httpx.URL(base_url).host if base_url else "api.openai.com"
        self.client = AsyncOpenAI(api_key=api_key, base_url=base_url) if api_key else None
        self.rejected: str | None = None  # set once the provider refuses the key; .env is only read at boot

    @property
    def configured(self) -> bool:
        return self.client is not None and self.rejected is None

    async def stream(self, messages: list[dict], mem_ids: list[str]) -> AsyncIterator[str]:
        size = sum(len(m["content"]) for m in messages)
        self.gate.egress(self.host, "cloud-generate", mem_ids, size)
        try:
            resp = await self.client.chat.completions.create(
                model=self.model, messages=messages, stream=True, temperature=0.2, max_tokens=600
            )
        except APIStatusError as e:
            # A revoked or wrong key never starts working mid-run: stop paying a round trip per question.
            # Gemini reports a bad key as 400 "API key not valid" rather than 401.
            bad_key = isinstance(e, (AuthenticationError, PermissionDeniedError)) or (
                e.status_code == 400 and "api key" in str(e).lower())
            if bad_key:
                self.rejected = f"{self.provider} rejected the API key ({e.status_code})"
            raise
        async for chunk in resp:
            if chunk.choices and (t := chunk.choices[0].delta.content):
                yield t
