"""Activity log + live event bus.

Everything the device does that a user might want to audit (writes, searches,
sync movements, privacy decisions, conflicts) is appended here. The log is
persisted as JSONL so it survives restarts, and fanned out to connected UIs
over Server-Sent Events.
"""
import asyncio
import json
import time
from collections import deque
from pathlib import Path
from typing import Any


class EventBus:
    def __init__(self, log_path: Path, keep: int = 400):
        self.log_path = log_path
        self.log: deque[dict] = deque(maxlen=keep)
        self.subscribers: set[asyncio.Queue] = set()
        self._seq = 0
        if log_path.exists():
            for line in log_path.read_text(encoding="utf-8").splitlines()[-keep:]:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self.log.append(entry)
                self._seq = max(self._seq, entry.get("seq", 0))

    def activity(self, kind: str, message: str, **data: Any) -> dict:
        """Record a user-visible activity entry and broadcast it."""
        self._seq += 1
        entry = {"seq": self._seq, "ts": int(time.time() * 1000), "kind": kind, "message": message, **data}
        self.log.append(entry)
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        self.emit("activity", entry)
        return entry

    def emit(self, event: str, data: Any = None) -> None:
        """Broadcast a transient event (not persisted), e.g. animation cues."""
        for q in list(self.subscribers):
            try:
                q.put_nowait({"event": event, "data": data})
            except asyncio.QueueFull:
                pass

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def recent(self, n: int = 120) -> list[dict]:
        return list(self.log)[-n:]
