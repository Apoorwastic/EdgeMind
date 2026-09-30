"""Sync manager: the edge <-> cloud contract.

Run order on every sync (reconnect, periodic tick, or "Sync now"):

  1. RETRACT  records that were shared but are now private or deleted
              (sends the id only — content never leaves again).
  2. PUSH     every record with sensitivity=shareable AND synced=false.
              Private records are never selected (query filter), and the cloud
              client independently refuses to serialise them (CloudStore.cloud_payload).
  3. PULL     new/updated shared records from other devices, and drop local
              copies of records that were removed from the shared store.

Conflict policy — last-write-wins, with nothing silently lost:
  Each shared record carries a revision number `rev`. A device remembers the
  cloud rev its local copy was based on (`base_rev`). On push, if the cloud rev
  is still `base_rev`, it's a clean fast-forward. If the cloud rev moved on,
  another device edited the same record concurrently: the version with the later
  `updated_ts` wins (ties broken by device id). The losing text is kept in the
  conflict log with who wrote it and when, and can be restored in one click.
"""
import asyncio
import json
import time
from pathlib import Path

from qdrant_client import models
from qdrant_edge import SparseVector

from .cloud import CloudStore
from .embeddings import Embedder
from .events import EventBus
from .network import NetworkGate, OfflineError
from .store import LocalMemory


def now_ms() -> int:
    return int(time.time() * 1000)


def to_edge_sparse(v) -> SparseVector:
    return SparseVector(list(v.indices), list(v.values))


def to_cloud_sparse(v) -> models.SparseVector:
    return models.SparseVector(indices=list(v.indices), values=list(v.values))


class SyncState:
    """Small JSON sidecar for sync bookkeeping (not memory content)."""

    def __init__(self, path: Path):
        self.path = path
        self.data = {"last_sync": None, "retractions": [], "conflicts": [], "cloud_cache": [], "cloud_cache_ts": None}
        if path.exists():
            self.data.update(json.loads(path.read_text(encoding="utf-8")))

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=1), encoding="utf-8")

    def __getitem__(self, k):
        return self.data[k]

    def __setitem__(self, k, v):
        self.data[k] = v
        self.save()


class SyncManager:
    def __init__(self, device_id: str, store: LocalMemory, cloud: CloudStore, embedder: Embedder,
                 gate: NetworkGate, bus: EventBus, state: SyncState, team=None, on_removed=None):
        self.device_id = device_id
        self.team = team  # TeamManager: which team's collection to sync with (None team = nothing to sync)
        self.on_removed = on_removed  # called when the admin removed this device from its team
        self.store = store
        self.cloud = cloud
        self.embedder = embedder
        self.gate = gate
        self.bus = bus
        self.state = state
        self.lock = asyncio.Lock()
        self.running = False

    # ---- bookkeeping called by local edits --------------------------------

    def queue_retraction(self, mem_id: str, reason: str) -> None:
        r = [x for x in self.state["retractions"] if x["mem_id"] != mem_id]
        r.append({"mem_id": mem_id, "reason": reason, "ts": now_ms()})
        self.state["retractions"] = r

    def status(self) -> dict:
        stats = self.store.stats()
        return {
            "running": self.running,
            "last_sync": self.state["last_sync"],
            "pending": stats["pending"],
            "retractions": len(self.state["retractions"]),
            "private_held": stats["private"],
            "conflicts": len([c for c in self.state["conflicts"] if not c.get("resolved")]),
        }

    # ---- the sync run -----------------------------------------------------

    async def sync(self, reason: str = "manual") -> dict:
        if not self.gate.online:
            self.bus.activity("sync", "Sync skipped — offline. Changes stay queued on device.", level="muted")
            return {"ok": False, "reason": "offline"}
        if self.team is not None and not self.team.current:
            if reason == "manual":
                self.bus.activity("sync", "Not in a team yet — shared notes wait on this device until you create or join one.",
                                  level="muted")
            return {"ok": False, "reason": "no-team"}
        async with self.lock:
            self.running = True
            self.bus.emit("sync", {"phase": "start", "reason": reason, **self.status()})
            summary = {"pushed": 0, "pulled": 0, "retracted": 0, "removed": 0, "requeued": 0, "conflicts": 0,
                       "private_held": self.store.stats()["private"]}
            try:
                self.cloud.revalidate()  # the server may have been reset or replaced since the last run
                if self.team is not None:
                    if await self.team.refresh() is None:  # removed by the admin, or the team is gone
                        if self.on_removed:
                            self.on_removed()
                        return {"ok": False, "reason": "removed-from-team"}
                    self.cloud.set_collection(self.team.collection())
                await self._retract(summary)
                await self._push(summary)
                await self._pull(summary)
                self.state["cloud_cache"] = await self.cloud.snapshot()
                self.state["cloud_cache_ts"] = now_ms()
                self.state["last_sync"] = now_ms()
                changed = any(summary[k] for k in ("pushed", "pulled", "retracted", "removed", "requeued", "conflicts"))
                if changed or reason == "manual":
                    self.bus.activity(
                        "sync",
                        f"Sync complete — ↑{summary['pushed']} pushed · ↓{summary['pulled']} pulled · "
                        f"{summary['conflicts']} conflict(s) · {summary['private_held']} private held on device",
                        summary=summary, reason=reason,
                    )
                return {"ok": True, **summary}
            except OfflineError:
                self.bus.activity("sync", "Connection lost mid-sync — remaining changes stay queued.", level="warn")
                return {"ok": False, "reason": "offline", **summary}
            except Exception as e:  # server down, schema problems, ...
                self.bus.activity("sync", f"Sync failed: {type(e).__name__}: {e}", level="warn")
                return {"ok": False, "reason": str(e), **summary}
            finally:
                self.running = False
                self.bus.emit("sync", {"phase": "end", **self.status()})
                self.bus.emit("memory", None)

    async def _retract(self, summary: dict) -> None:
        for r in list(self.state["retractions"]):
            await self.cloud.retract(r["mem_id"], self.device_id, now_ms())
            self.state["retractions"] = [x for x in self.state["retractions"] if x["mem_id"] != r["mem_id"]]
            summary["retracted"] += 1
            self.bus.activity("sync", f"Retracted {r['mem_id']} from shared store ({r['reason']}) — id only, no content sent",
                              mem_id=r["mem_id"], direction="up")

    def _sanitize_links(self, rec: dict) -> dict:
        """Don't let a shareable record point at a private one in the cloud."""
        rec = dict(rec)
        for key in ("supersedes", "superseded_by"):
            ref = rec.get(key)
            if ref:
                target = self.store.get(ref)
                if not target or target.get("sensitivity") != "shareable":
                    rec[key] = None
        return rec

    async def _push(self, summary: dict) -> None:
        pending = self.store.pending_push()
        if pending:
            self.bus.emit("sync", {"phase": "push-plan", "ids": [r["mem_id"] for r in pending]})
        for rec in pending:
            mem_id = rec["mem_id"]
            full = self.store.get(mem_id, with_vector=True)
            if not full or full.get("sensitivity") != "shareable":
                continue  # re-tagged between planning and pushing
            vec = full.pop("_vector")
            base = full.get("base_rev", 0) or 0
            remote = await self.cloud.get(mem_id)

            if remote is None or remote.get("rev", 0) == base:
                new_rev = (remote or {}).get("rev", base) + 1
                await self._push_one(full, vec, new_rev)
                summary["pushed"] += 1
                continue

            if remote.get("text") == full["text"] and remote.get("updated_ts") == full.get("updated_ts"):
                # Server already has exactly this version (e.g. we crashed after pushing). Adopt its rev.
                self.store.set_fields(mem_id, {"synced": True, "rev": remote["rev"], "base_rev": remote["rev"]})
                continue

            # Concurrent edit: someone else pushed rev > base since we last synced.
            summary["conflicts"] += 1
            local_key = (full.get("updated_ts", 0), self.device_id)
            remote_key = (remote.get("updated_ts", 0), remote.get("updated_by") or "")
            conflict = {
                "id": f"c_{now_ms()}_{mem_id[-4:]}",
                "mem_id": mem_id,
                "ts": now_ms(),
                "policy": "last-write-wins",
                "local": {"text": full["text"], "by": self.device_id, "updated_ts": full.get("updated_ts")},
                "remote": {"text": "(retracted from shared store)" if remote.get("deleted") else remote.get("text"),
                           "by": remote.get("updated_by"), "updated_ts": remote.get("updated_ts")},
            }
            if local_key > remote_key:
                conflict["winner"] = "local"
                await self._push_one(full, vec, remote["rev"] + 1)
                summary["pushed"] += 1
            elif remote.get("deleted"):
                conflict["winner"] = "remote"
                self.store.delete(mem_id)
                summary["removed"] += 1
            else:
                conflict["winner"] = "remote"
                [(payload, rvec)] = await self.cloud.fetch([mem_id])
                self._apply_remote(payload, rvec)
                summary["pulled"] += 1
            self.state["conflicts"] = [conflict] + self.state["conflicts"][:49]
            w = conflict[conflict["winner"]]
            lost = conflict["remote" if conflict["winner"] == "local" else "local"]
            self.bus.activity(
                "conflict",
                f"Conflict on {mem_id}: edited on {conflict['local']['by']} and {conflict['remote']['by']}. "
                f"Last write wins → kept {w['by']}'s version ({time.strftime('%H:%M:%S', time.localtime(w['updated_ts'] / 1000))}); "
                f"{lost['by']}'s version preserved in conflict log.",
                conflict=conflict, mem_id=mem_id, level="warn",
            )
            self.bus.emit("conflict", conflict)

    async def _push_one(self, rec: dict, vec: dict, new_rev: int) -> None:
        rec = self._sanitize_links(rec)
        rec["rev"] = new_rev
        rec.setdefault("updated_by", self.device_id)
        await self.cloud.push(rec, vec["dense"], to_cloud_sparse(vec["bm25"]))
        self.store.set_fields(rec["mem_id"], {"synced": True, "rev": new_rev, "base_rev": new_rev})
        self.bus.emit("sync-move", {"direction": "up", "mem_id": rec["mem_id"], "text": rec["text"][:80]})
        self.bus.activity("sync", f"↑ pushed {rec['mem_id']} (rev {new_rev})", mem_id=rec["mem_id"], direction="up")
        await asyncio.sleep(0.12)  # pace the stream so the UI can show each record moving

    def _apply_remote(self, payload: dict, vec: dict) -> None:
        local = self.store.get(payload["mem_id"])
        rec = {
            "mem_id": payload["mem_id"],
            "text": payload.get("text", ""),
            "role": "note",
            "sensitivity": "shareable",
            "synced": True,
            "ts": payload.get("ts"),
            "updated_ts": payload.get("updated_ts"),
            "rev": payload.get("rev", 1),
            "base_rev": payload.get("rev", 1),
            "origin": payload.get("from"),
            "updated_by": payload.get("updated_by"),
            "embedder": (local or {}).get("embedder", "from-cloud"),
            "supersedes": payload.get("supersedes"),
            "superseded_by": payload.get("superseded_by"),
        }
        self.store.upsert(rec, list(vec["dense"]), to_edge_sparse(vec["bm25"]))

    async def _pull(self, summary: dict) -> None:
        index = await self.cloud.index()
        local_shared = {r["mem_id"]: r for r in self.store.all() if r.get("sensitivity") == "shareable"}

        wanted = [
            m for m, meta in index.items()
            if not meta.get("deleted") and (
                m not in local_shared
                or (local_shared[m].get("synced") and meta.get("rev", 0) > (local_shared[m].get("rev") or 0)))
        ]
        for payload, vec in await self.cloud.fetch(wanted):
            is_new = payload["mem_id"] not in local_shared
            self._apply_remote(payload, vec)
            summary["pulled"] += 1
            verb = "new" if is_new else f"updated → rev {payload.get('rev')}"
            self.bus.emit("sync-move", {"direction": "down", "mem_id": payload["mem_id"], "text": payload.get("text", "")[:80]})
            self.bus.activity("sync", f"↓ pulled {payload['mem_id']} from {payload.get('updated_by') or payload.get('from')} ({verb})",
                              mem_id=payload["mem_id"], direction="down")
            await asyncio.sleep(0.12)

        for m, rec in local_shared.items():
            meta = index.get(m)
            clean = rec.get("synced") and (rec.get("base_rev") or 0) > 0
            if meta and meta.get("deleted"):
                # Explicit tombstone: another device retracted it. Only drop clean copies —
                # a local edit made after the retraction is pushed (and wins or loses) via _push.
                if clean and meta.get("rev", 0) > (rec.get("rev") or 0):
                    self.store.delete(m)
                    summary["removed"] += 1
                    self.bus.activity("sync", f"Removed {m}: retracted from the shared store by {meta.get('updated_by')}",
                                      mem_id=m, direction="down")
            elif meta is None and clean:
                # No record and no tombstone: the server lost it (reset, or a different server).
                # Absence is not a deletion — re-upload our copy instead of dropping it.
                self.store.set_fields(m, {"synced": False, "rev": 0, "base_rev": 0})
                summary["requeued"] += 1
                self.bus.activity("sync", f"Shared store has no copy of {m} — re-queued for upload (server reset or replaced?)",
                                  mem_id=m, level="warn")

    async def loop(self, every: float = 8.0) -> None:
        """Background: sync whenever online. Keeps two devices converging without clicks."""
        while True:
            await asyncio.sleep(every)
            if self.gate.online and not self.lock.locked():
                await self.sync(reason="periodic")
