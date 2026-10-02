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
# "What is MY plumber's number?" with no matching note: general knowledge can only guess (it once invented
# a Pokémon called "Plumberry"). Personal facts are only in the user's notes, so say they weren't found.
SYSTEM_PERSONAL = (
    "You are EdgeMind, a personal memory assistant. The question is about the user's own life, and none of "
    "their notes on this device answers it. If it asks for a personal fact (a number, date, name, code, place, "
    "plan), say in one sentence that you couldn't find it in their notes, and do not guess or invent anything. "
    "If it is really a general question (how to do something, general advice), answer it briefly."
)

SYSTEM_GENERAL = (
    "You are EdgeMind, a helpful assistant. Nothing in the user's personal notes matched this question, "
    "so answer from your general knowledge. Do not claim the answer comes from their notes or memories. "
    "Be clear and concise (at most 6 sentences, or a short list). If you are not sure, say so."
)

# Keep the on-device model loaded between questions; reloading costs ~7 s on a CPU-only machine.
KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")

# Small local models sometimes keep writing past the answer ("### Instruction 2 ..."); cut them off.
STOP = ["\n###", "### ", "\nQuestion:", "\nMemories:", "\nUser:", "<|end|>", "<|user|>", "<|im_end|>"]


# The best matching note scored only weakly: it may be about something else ("How do I change a car tyre?"
# brushing past the car-insurance note). Let the model use it only if it actually answers the question.
SYSTEM_WEAK = (
    "You are EdgeMind, a helpful assistant with access to some of the user's notes that MAY be related to the "
    "question. If a note answers the question, answer from it, copying names, numbers and dates exactly, and "
    "cite it like [1]. If none of the notes answers it, ignore them and answer from general knowledge without "
    "mentioning the notes. Be concise (at most 6 sentences)."
)


def build_messages(question: str, hits: list[dict], history: list[dict], general: bool = False,
                   weak: bool = False, personal: bool = False) -> list[dict]:
    if general:
        msgs = [{"role": "system", "content": SYSTEM_PERSONAL if personal else SYSTEM_GENERAL}]
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
    system = SYSTEM
    if weak:
        # A personal question ("my licence plate") brushing past a loosely related note must not get a guess.
        system = SYSTEM_WEAK + (" If none of the notes answers it and it asks for a personal fact, say you couldn't "
                                "find it in their notes; never guess or invent it." if personal else "")
    msgs = [{"role": "system", "content": system}]
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
        # Set when the machine can't actually run the model (Ollama's runner was killed: out of memory).
        # Installed is not the same as runnable, so check() won't re-enable it until the pause is over.
        self.down_reason: str | None = None
        self.down_until = 0.0

    def mark_down(self, reason: str, seconds: float = 600) -> None:
        self.available = False
        self.down_reason = reason
        self.down_until = time.time() + seconds

    async def check(self) -> bool:
        """Use the first preferred model that Ollama actually has installed."""
        if time.time() < self.down_until:
            return False
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
                    err = f"Ollama {r.status_code}: {body[:200]}"
                    if any(k in body.lower() for k in ("killed", "out of memory", "terminated", "requires more system memory")):
                        # Retrying only gets it killed again (and slows every answer): pause it for a while.
                        self.mark_down(f"on-device model {self.model} can't run here — not enough memory")
                    raise OllamaError(err)
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
