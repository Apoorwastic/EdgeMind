"""Client for the central Qdrant Server (shared memory).

Privacy is enforced here, at the lowest layer that touches the network:
`push()` refuses any record whose sensitivity is not "shareable", and builds
the cloud payload from an explicit allow-list of fields rather than copying
the local record. Even if the UI or the sync manager were bypassed, a private
record cannot be serialised into a cloud request by this module.
"""
from qdrant_client import AsyncQdrantClient, models

from .events import EventBus
from .network import NetworkGate
from .store import point_id

CLOUD_FIELDS = ("mem_id", "text", "ts", "updated_ts", "rev", "updated_by", "supersedes", "superseded_by")


class PrivacyViolation(RuntimeError):
    pass


class NoTeam(RuntimeError):
    """Shared notes have nowhere to go until the device creates or joins a team."""


class CloudStore:
    def __init__(self, url: str, api_key: str | None, collection: str, dim: int, gate: NetworkGate, bus: EventBus):
        self.url = url
        self.client = AsyncQdrantClient(url=url, api_key=api_key, timeout=5)
        self.collection = collection
        self.dim = dim
        self.gate = gate
        self.bus = bus
        self._ready = False

    def revalidate(self) -> None:
        """Forget that the collection exists, so the next call re-checks (and recreates) it."""
        self._ready = False

    def set_collection(self, name: str | None) -> None:
        """Point at the current team's shared collection (None = not in a team: nothing to sync with)."""
        if name != self.collection:
            self.collection = name
            self._ready = False

    @property
    def active(self) -> bool:
        return self.collection is not None

    async def ensure(self) -> None:
        if self._ready:
            return
        if self.collection is None:
            raise NoTeam("this device is not in a team")
        self.gate.egress(self.url, "ensure-collection")
        if not await self.client.collection_exists(self.collection):
            try:
                await self._create()
            except Exception:
                # Another device may have created it a moment ago.
                if not await self.client.collection_exists(self.collection):
                    raise
        self._ready = True

    async def _create(self) -> None:
        await self.client.create_collection(
            self.collection,
            vectors_config={"dense": models.VectorParams(size=self.dim, distance=models.Distance.COSINE)},
            sparse_vectors_config={"bm25": models.SparseVectorParams(modifier=models.Modifier.IDF)},
        )
        for field, schema in (("mem_id", "keyword"), ("updated_ts", "float"), ("from", "keyword")):
            await self.client.create_payload_index(self.collection, field, field_schema=schema)

    @staticmethod
    def cloud_payload(rec: dict) -> dict:
        """The ONLY way a local record becomes a cloud payload."""
        if rec.get("sensitivity") != "shareable":
            raise PrivacyViolation(f"refusing to serialise {rec.get('sensitivity')} record {rec.get('mem_id')}")
        payload = {k: rec.get(k) for k in CLOUD_FIELDS}
        payload["from"] = rec.get("origin")
        return payload

    async def push(self, rec: dict, dense: list[float], sparse: models.SparseVector) -> None:
        try:
            payload = self.cloud_payload(rec)
        except PrivacyViolation as e:
            self.bus.activity("privacy", f"Blocked: {e}", mem_id=rec.get("mem_id"), level="alert")
            raise
        await self.ensure()
        self.gate.egress(self.url, "push", [rec["mem_id"]], len(rec.get("text", "")))
        await self.client.upsert(
            self.collection,
            points=[models.PointStruct(id=point_id(rec["mem_id"]), vector={"dense": dense, "bm25": sparse}, payload=payload)],
        )

    async def get(self, mem_id: str) -> dict | None:
        await self.ensure()
        self.gate.egress(self.url, "read")
        pts = await self.client.retrieve(self.collection, [point_id(mem_id)], with_payload=True)
        return dict(pts[0].payload) if pts else None

    async def retract(self, mem_id: str, by: str, ts: int) -> None:
        """Replace a shared record with a tombstone: id + bookkeeping only, text and vectors wiped.

        An explicit tombstone (rather than deleting the point) is what lets other devices tell
        "retracted on purpose" apart from "this server simply doesn't have it" (reset, new server).
        Sends only the id, never content.
        """
        await self.ensure()
        self.gate.egress(self.url, "retract")
        pid = point_id(mem_id)
        pts = await self.client.retrieve(self.collection, [pid], with_payload=["rev", "from"])
        if not pts:
            return
        old = pts[0].payload or {}
        await self.client.overwrite_payload(
            self.collection,
            payload={"mem_id": mem_id, "deleted": True, "rev": (old.get("rev") or 0) + 1,
                     "updated_ts": ts, "updated_by": by, "from": old.get("from")},
            points=[pid],
        )
        await self.client.delete_vectors(self.collection, vectors=["dense", "bm25"], points=[pid])

    async def index(self) -> dict[str, dict]:
        """mem_id -> {updated_ts, rev, from, deleted} for every shared record and tombstone (no text, no vectors)."""
        await self.ensure()
        self.gate.egress(self.url, "list-index")
        out, offset = {}, None
        while True:
            pts, offset = await self.client.scroll(
                self.collection,
                limit=512,
                offset=offset,
                with_payload=["mem_id", "updated_ts", "rev", "from", "updated_by", "deleted"],
                with_vectors=False,
            )
            for p in pts:
                out[p.payload["mem_id"]] = dict(p.payload)
            if offset is None:
                return out

    async def fetch(self, mem_ids: list[str]) -> list[tuple[dict, dict]]:
        """Full records + vectors, so pulled memories don't need re-embedding."""
        if not mem_ids:
            return []
        await self.ensure()
        self.gate.egress(self.url, "pull")
        pts = await self.client.retrieve(
            self.collection, [point_id(m) for m in mem_ids], with_payload=True, with_vectors=True
        )
        return [(dict(p.payload), p.vector) for p in pts if not (p.payload or {}).get("deleted")]

    async def snapshot(self, limit: int = 60) -> list[dict]:
        await self.ensure()
        self.gate.egress(self.url, "snapshot")
        pts, _ = await self.client.scroll(self.collection, limit=1000, with_payload=True, with_vectors=False)
        recs = sorted((dict(p.payload) for p in pts if not (p.payload or {}).get("deleted")), key=lambda r: r.get("updated_ts", 0), reverse=True)
        return recs[:limit]
