"""Connectivity state + the single outbound gate.

Every call that leaves the device (Qdrant Server, cloud LLM) must go through
`NetworkGate.egress()`. That gives us three guarantees in one place:

  1. When the device is offline (detected or forced) nothing leaves — the gate
     raises before any socket is opened.
  2. Every outbound payload is recorded in an egress ledger, including exactly
     which memory ids it carried.
  3. The ledger can be audited against local private records to prove that no
     private memory ever left (see /api/privacy/audit).

"Online" needs both the Qdrant Server and the internet. The Qdrant Server often runs on
localhost, so on its own it would keep a device "online" after the Wi-Fi drops. The internet
check is a bare TCP connect to well-known anycast IPs: no payload, no DNS. So it isn't egress,
and it fails fast when the adapter is down.
"""
import asyncio
import json
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path

import httpx

from .events import EventBus


class OfflineError(RuntimeError):
    pass


@dataclass
class Egress:
    ts: int
    dest: str
    purpose: str
    mem_ids: list[str] = field(default_factory=list)
    bytes: int = 0


class NetworkGate:
    def __init__(self, bus: EventBus, probe_url: str, api_key: str | None, ledger_path: Path,
                 internet_hosts: list[tuple[str, int]] | None = None):
        self.bus = bus
        self.ledger_path = ledger_path
        self.probe_url = probe_url.rstrip("/") + "/healthz"
        self.headers = {"api-key": api_key} if api_key else {}
        # "auto" = follow real connectivity; "offline" = forced off (demo switch / airplane mode).
        self.mode: str = "auto"
        self.reachable: bool = False
        self.internet_hosts = internet_hosts or []
        self.internet: bool = not self.internet_hosts  # no hosts configured → don't gate on internet
        self.ledger: deque[Egress] = deque(maxlen=5000)
        if ledger_path.exists():
            for line in ledger_path.read_text(encoding="utf-8").splitlines():
                try:
                    self.ledger.append(Egress(**json.loads(line)))
                except (json.JSONDecodeError, TypeError):
                    pass
        self.last_change = int(time.time() * 1000)
        self._listeners: list = []
        self._reported: bool | None = None

    @property
    def online(self) -> bool:
        return self.mode != "offline" and self.reachable and self.internet

    def on_reconnect(self, fn) -> None:
        self._listeners.append(fn)

    def state(self) -> dict:
        return {
            "online": self.online,
            "mode": self.mode,
            "cloud_reachable": self.reachable,
            "internet": self.internet,
            "since": self.last_change,
        }

    async def set_mode(self, mode: str) -> None:
        assert mode in ("auto", "offline")
        was = self.online
        self.mode = mode
        if mode == "auto":
            await self.probe()
        self._changed(was)

    async def probe(self) -> bool:
        self.reachable, self.internet = await asyncio.gather(self._probe_server(), self._probe_internet())
        return self.online

    async def recheck(self) -> None:
        """Probe right now (e.g. the browser just reported a network change) and announce any flip."""
        was = self.online
        await self.probe()
        self._changed(was)

    async def _probe_server(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=1.5) as c:
                r = await c.get(self.probe_url, headers=self.headers)
                return r.status_code < 500
        except Exception:
            return False

    async def _probe_internet(self) -> bool:
        if not self.internet_hosts:
            return True

        async def one(host: str, port: int) -> bool:
            try:
                _, w = await asyncio.wait_for(asyncio.open_connection(host, port), 1.5)
                w.close()
                return True
            except (OSError, asyncio.TimeoutError):
                return False

        return any(await asyncio.gather(*(one(h, p) for h, p in self.internet_hosts)))

    async def probe_loop(self, every: float = 2.0) -> None:
        while True:
            await self.recheck()
            await asyncio.sleep(every)

    def _changed(self, was: bool) -> None:
        # Compare against the last state we *reported*, not the caller's snapshot: the probe loop and a
        # manual toggle can interleave, and both would otherwise announce the same transition.
        was = self._reported if self._reported is not None else was
        self._reported = self.online
        if was == self.online:
            self.bus.emit("network", self.state())
            return
        self.last_change = int(time.time() * 1000)
        if self.online:
            self.bus.activity("network", "Connectivity restored — cloud reachable", state="online")
            for fn in self._listeners:
                asyncio.create_task(fn())
        else:
            why = ("forced offline" if self.mode == "offline" else
                   "no internet" if not self.internet else "cloud unreachable")
            self.bus.activity("network", f"Went offline ({why}) — running on local memory only", state="offline")
        self.bus.emit("network", self.state())

    def egress(self, dest: str, purpose: str, mem_ids: list[str] | None = None, size: int = 0) -> None:
        """Authorise + record an outbound call. Raises OfflineError when offline."""
        if not self.online:
            raise OfflineError(f"offline: blocked {purpose} -> {dest}")
        e = Egress(int(time.time() * 1000), dest, purpose, list(mem_ids or []), size)
        self.ledger.append(e)
        with self.ledger_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(e)) + "\n")

    def egressed_ids(self) -> set[str]:
        out: set[str] = set()
        for e in self.ledger:
            out.update(e.mem_ids)
        return out
