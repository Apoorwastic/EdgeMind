"""Sync manager: the edge <-> cloud contract.

A device can belong to several teams; each one has its own collection on the Qdrant Server
(`TeamManager.collection(team_id)`), and a shareable record is scoped to exactly one team via its
`team_id` field. One sync run visits every joined team, one at a time, and for each does:

  1. RETRACT  that team's records that were shared but are now private or deleted
              (sends the id only — content never leaves again).
  2. PUSH     that team's records with sensitivity=shareable AND synced=false.
              Private records are never selected (query filter), and the cloud
              client independently refuses to serialise them (CloudStore.cloud_payload).
  3. PULL     new/updated records from other devices in that team, and drop local
              copies of records that were removed from that team's shared store.

Each team's pass is wrapped in `cloud.for_team(collection)`, which both points the shared
`CloudStore` at that team's collection and holds a lock for the duration — necessary because a
sync pass spans several awaited network calls, during which another request (the cloud snapshot
view, the privacy audit, a team action) could otherwise observe or mutate the wrong collection.

After the teams, the account's vault (edge/vault.py) gets the same three steps for Private notes,
sealed: retract, push ciphertext, pull + decrypt + embed locally. "This device only" notes are in
neither pass — nothing selects them.

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
import os
import random
import time
from pathlib import Path

from qdrant_client import models
from qdrant_edge import SparseVector

from .cloud import CloudStore
from .embeddings import Embedder
from .events import EventBus
from .network import NetworkGate, OfflineError
from .store import LocalMemory
from .vault import VAULT_TEAM, Vault


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
        self.data = {"last_sync": None, "retractions": [], "conflicts": [], "cloud_cache": {}}
        if path.exists():
            self.data.update(json.loads(path.read_text(encoding="utf-8")))
        # Pre-multi-team installs have a flat cloud_cache (one team's record list, plus a sibling
        # cloud_cache_ts key) rather than {team_id: {"records": [...], "ts": ...}}. It's just a
        # read-only fallback cache — safe to drop and let the next online sync repopulate it.
        if not isinstance(self.data.get("cloud_cache"), dict):
            self.data["cloud_cache"] = {}
        self.data.pop("cloud_cache_ts", None)
        # Pre-multi-team retractions have no team_id. There's no safe guess for which team they
        # belonged to from here; app.py's boot-time migration backfills this when there's exactly
        # one joined team (the only case where the answer is unambiguous).
        for r in self.data["retractions"]:
            r.setdefault("team_id", None)

    def save(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=1), encoding="utf-8")

    def __getitem__(self, k):
        return self.data[k]

    def __setitem__(self, k, v):
        self.data[k] = v
        self.save()


# Every SyncManager in this process (edge/host.py runs many devices in one). After one pushes a change,
# the others pull straight away instead of at their next periodic sync.
_PEERS: list["SyncManager"] = []


class SyncManager:
    def __init__(self, device_id: str, store: LocalMemory, cloud: CloudStore, embedder: Embedder,
                 gate: NetworkGate, bus: EventBus, state: SyncState, team=None, on_removed=None,
                 vault: Vault | None = None):
        self.device_id = device_id
        self.vault = vault  # the account's encrypted channel for Private notes (None/disabled = no account)
        self.team = team  # TeamManager: which teams' collections to sync with (None/[] = nothing to sync)
        self.on_removed = on_removed  # called with a team_id when the admin removed this device from it
        self.store = store
        self.cloud = cloud
        self.embedder = embedder
        self.gate = gate
        self.bus = bus
        self.state = state
        self.lock = asyncio.Lock()
        self.running = False
        self._soon: asyncio.Task | None = None
        _PEERS.append(self)
        self._teams_checked = 0.0  # last team heartbeat (monotonic)

    # ---- bookkeeping called by local edits --------------------------------

    def queue_retraction(self, mem_id: str, reason: str, team_id: str | None) -> None:
        r = [x for x in self.state["retractions"] if x["mem_id"] != mem_id]
        r.append({"mem_id": mem_id, "reason": reason, "ts": now_ms(), "team_id": team_id})
        self.state["retractions"] = r

    def status(self) -> dict:
        stats = self.store.stats()
        return {
            "running": self.running,
            "last_sync": self.state["last_sync"],
            "pending": stats["pending"],
            "unassigned": stats["unassigned"],
            "retractions": len(self.state["retractions"]),
            "private_held": stats["private"],
            "conflicts": len([c for c in self.state["conflicts"] if not c.get("resolved")]),
        }

    # ---- the sync run -----------------------------------------------------

    async def sync(self, reason: str = "manual") -> dict:
        if not self.gate.online:
            self.bus.activity("sync", "Sync skipped — offline. Changes stay queued on device.", level="muted")
            return {"ok": False, "reason": "offline"}
        has_vault = bool(self.vault and self.vault.enabled)
        if self.team is not None and not self.team.teams and not has_vault:
            if reason == "manual":
                self.bus.activity("sync", "Not in a team yet — shared notes wait on this device until you create or join one.",
                                  level="muted")
            return {"ok": False, "reason": "no-team"}
        async with self.lock:
            self.running = True
            self.bus.emit("sync", {"phase": "start", "reason": reason, **self.status()})
            summary = {"pushed": 0, "pulled": 0, "retracted": 0, "removed": 0, "requeued": 0, "conflicts": 0,
                       "sealed": 0, "unsealed": 0, "private_held": self.store.stats()["private"]}
            try:
                self.cloud.revalidate()  # the server may have been reset or replaced since the last run
                teams: list[dict] = []
                if self.team is not None:
                    # The heartbeat (last seen, renames, removals) writes to the shared server: once a
                    # minute is plenty, except when something just changed.
                    if reason in ("manual", "team", "reconnect", "unlock") or time.monotonic() - self._teams_checked > 60:
                        teams, removed_ids = await self.team.refresh_all()
                        self._teams_checked = time.monotonic()
                        for team_id in removed_ids:
                            if self.on_removed:
                                self.on_removed(team_id)
                    else:
                        teams = self.team.teams
                for team in teams:
                    team_id = team["id"]
                    async with self.cloud.for_team(self.team.collection(team_id)):
                        await self._retract(team_id, summary)
                        await self._push(team_id, summary)
                        await self._pull(team_id, summary)
                        snap = await self.cloud.snapshot()
                    self.state["cloud_cache"] = {**self.state["cloud_cache"], team_id: {"records": snap, "ts": now_ms()}}
                if has_vault:
                    if self.vault.unlocked:
                        async with self.cloud.for_team(self.vault.collection):
                            await self._vault(summary)
                    elif reason == "manual":
                        self.bus.activity("sync", "Private notes wait on this device until you sign in here (the vault key comes from your password).",
                                          level="muted")
                self.state["last_sync"] = now_ms()
                if reason != "peer" and any(summary[k] for k in ("pushed", "sealed", "retracted")):
                    for peer in _PEERS:
                        if peer is not self:
                            peer.soon(0.3, reason="peer")
                changed = any(summary[k] for k in ("pushed", "pulled", "retracted", "removed", "requeued", "conflicts", "sealed", "unsealed"))
                if changed or reason == "manual":
                    self.bus.activity(
                        "sync",
                        f"Sync complete — ↑{summary['pushed']} pushed · ↓{summary['pulled']} pulled · "
                        f"{summary['sealed']}↑ {summary['unsealed']}↓ private (encrypted) · "
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

    async def _retract(self, team_id: str, summary: dict) -> None:
        mine = [x for x in self.state["retractions"] if x["team_id"] == team_id]
        for r in mine:
            await self.cloud.retract(r["mem_id"], self.device_id, now_ms())
            self.state["retractions"] = [x for x in self.state["retractions"] if x["mem_id"] != r["mem_id"]]
            summary["retracted"] += 1
            self.bus.activity("sync", f"Retracted {r['mem_id']} from shared store ({r['reason']}) — id only, no content sent",
                              mem_id=r["mem_id"], direction="up")

    def _sanitize_links(self, rec: dict) -> dict:
        """Don't let a shareable record point at a private one, or at a different team's record,
        in the cloud. Either case is dropped silently, same as the privacy guard below it."""
        rec = dict(rec)
        for key in ("supersedes", "superseded_by"):
            ref = rec.get(key)
            if ref:
                target = self.store.get(ref)
                if (not target or target.get("sensitivity") != "shareable"
                        or target.get("team_id") != rec.get("team_id")):
                    rec[key] = None
        return rec

    async def _push(self, team_id: str, summary: dict) -> None:
        pending = self.store.pending_push(team_id)
        if pending:
            self.bus.emit("sync", {"phase": "push-plan", "ids": [r["mem_id"] for r in pending]})
        for rec in pending:
            mem_id = rec["mem_id"]
            full = self.store.get(mem_id, with_vector=True)
            if not full or full.get("sensitivity") != "shareable" or full.get("team_id") != team_id:
                continue  # re-tagged or reassigned between planning and pushing
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
                self._apply_remote(payload, rvec, team_id)
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

    def _apply_remote(self, payload: dict, vec: dict, team_id: str) -> None:
        local = self.store.get(payload["mem_id"])
        rec = {
            "mem_id": payload["mem_id"],
            "text": payload.get("text", ""),
            "role": "note",
            "sensitivity": "shareable",
            "team_id": team_id,
            "synced": True,
            "ts": payload.get("ts"),
            "updated_ts": payload.get("updated_ts"),
            "rev": payload.get("rev", 1),
            "base_rev": payload.get("rev", 1),
            "origin": payload.get("from"),
            "updated_by": payload.get("updated_by"),
            "embedder": payload.get("embedder") or (local or {}).get("embedder", "from-cloud"),
            "supersedes": payload.get("supersedes"),
            "superseded_by": payload.get("superseded_by"),
        }
        self.store.upsert(rec, list(vec["dense"]), to_edge_sparse(vec["bm25"]))

    async def _pull(self, team_id: str, summary: dict) -> None:
        index = await self.cloud.index()
        local_shared = {r["mem_id"]: r for r in self.store.shared_for_team(team_id)}

        wanted = [
            m for m, meta in index.items()
            if not meta.get("deleted") and (
                m not in local_shared
                or (local_shared[m].get("synced") and meta.get("rev", 0) > (local_shared[m].get("rev") or 0)))
        ]
        for payload, vec in await self.cloud.fetch(wanted):
            is_new = payload["mem_id"] not in local_shared
            self._apply_remote(payload, vec, team_id)
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

    # ---- the vault: Private notes between this account's own devices, encrypted --------------

    async def _vault(self, summary: dict) -> None:
        v = self.vault
        for r in [x for x in self.state["retractions"] if x["team_id"] == VAULT_TEAM]:
            await self.cloud.retract(r["mem_id"], self.device_id, now_ms())
            self.state["retractions"] = [x for x in self.state["retractions"] if x["mem_id"] != r["mem_id"]]
            summary["retracted"] += 1
            self.bus.activity("sync", f"Removed {r['mem_id']} from your vault ({r['reason']})", mem_id=r["mem_id"], direction="up")

        for rec in self.store.pending_vault():
            mem_id = rec["mem_id"]
            full = self.store.get(mem_id)
            if not full or full.get("sensitivity") != "private":
                continue
            base = full.get("base_rev", 0) or 0
            remote = await self.cloud.get(mem_id)
            theirs = (remote or {}).get("updated_ts", 0), (remote or {}).get("updated_by") or ""
            if remote and not remote.get("deleted") and remote.get("rev", 0) != base and \
                    theirs > (full.get("updated_ts", 0), self.device_id):
                # Your other device changed it later: keep that version (the pull below fetches it).
                self.store.set_fields(mem_id, {"vault_synced": True, "rev": base})
                continue
            new_rev = max(base, (remote or {}).get("rev", 0)) + 1
            await self.cloud.push_sealed(v.seal({**full, "rev": new_rev, "updated_by": full.get("updated_by") or self.device_id}))
            self.store.set_fields(mem_id, {"vault_synced": True, "rev": new_rev, "base_rev": new_rev})
            summary["sealed"] += 1
            self.bus.emit("sync-move", {"direction": "up", "mem_id": mem_id, "text": "encrypted"})
            self.bus.activity("sync", f"{mem_id} encrypted and sent to your vault (rev {new_rev}) — the server can't read it",
                              mem_id=mem_id, direction="up")

        index = await self.cloud.index()
        local = {r["mem_id"]: r for r in self.store.private_all()}
        wanted = [m for m, meta in index.items() if not meta.get("deleted") and (
            (m not in local and not self.store.get(m))  # not here at all (a re-tagged note keeps its own copy)
            or (m in local and local[m].get("vault_synced") and meta.get("rev", 0) > (local[m].get("rev") or 0)))]
        for payload, _ in await self.cloud.fetch(wanted):
            body = v.open(payload)
            if body is None:
                self.bus.activity("privacy", f"Couldn't decrypt {payload['mem_id']} — not sealed with this account's key", level="warn")
                continue
            dense, emb_name = await self.embedder.dense(body["text"])  # vectors never travel: made here
            rec = {
                "mem_id": payload["mem_id"], "text": body["text"], "role": "note", "sensitivity": "private",
                "team_id": None, "synced": False, "vault_synced": True, "ts": body.get("ts"),
                "updated_ts": payload.get("updated_ts"), "rev": payload.get("rev", 1), "base_rev": payload.get("rev", 1),
                "origin": payload.get("from"), "updated_by": payload.get("updated_by"), "embedder": emb_name,
                "supersedes": body.get("supersedes"), "superseded_by": body.get("superseded_by"),
            }
            self.store.upsert(rec, dense, self.embedder.sparse_doc(body["text"]))
            summary["unsealed"] += 1
            self.bus.emit("sync-move", {"direction": "down", "mem_id": rec["mem_id"], "text": body["text"][:60]})
            self.bus.activity("sync", f"{rec['mem_id']} from your {payload.get('from')} decrypted on this device",
                              mem_id=rec["mem_id"], direction="down")

        for m, rec in local.items():
            meta = index.get(m)
            if meta and meta.get("deleted") and rec.get("vault_synced") and meta.get("rev", 0) > (rec.get("rev") or 0):
                self.store.delete(m)  # deleted (or made device-only) on your other device
                summary["removed"] += 1
            elif meta is None and rec.get("vault_synced"):
                self.store.set_fields(m, {"vault_synced": False, "rev": 0, "base_rev": 0})  # the vault lost it: send again
                summary["requeued"] += 1

    def soon(self, delay: float = 1.5, reason: str = "change") -> None:
        """A note just changed: sync shortly (one run for a burst of changes), not at the next tick."""
        if self._soon and not self._soon.done():
            return

        async def later():
            await asyncio.sleep(delay)
            if self.gate.online:
                await self.sync(reason=reason)
        self._soon = asyncio.create_task(later())

    async def loop(self, every: float | None = None) -> None:
        """Background: sync whenever online, to pick up other devices' changes. SYNC_EVERY seconds apart
        (edge/host.py raises it when many devices share a process), each device at its own offset."""
        every = every or float(os.getenv("SYNC_EVERY", "8"))
        await asyncio.sleep(random.uniform(0, every))
        while True:
            if self.gate.online and not self.lock.locked():
                await self.sync(reason="periodic")
            await asyncio.sleep(every)
