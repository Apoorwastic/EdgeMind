"""Local semantic memory on Qdrant Edge.

One EdgeShard per device, living in the device's data dir. Each memory is a
point with two vectors:

  dense  — 768-d cosine vector from the local embedding model
  bm25   — sparse BM25 vector (IDF-weighted), for keyword/hybrid search

Payload is the memory record itself (see README "Data model").
"""
import threading
import uuid
from pathlib import Path
from typing import Any

from qdrant_edge import (
    CountRequest,
    Distance,
    EdgeConfig,
    EdgeShard,
    EdgeSparseVectorParams,
    EdgeVectorParams,
    FieldCondition,
    Filter,
    Fusion,
    MatchValue,
    Modifier,
    PayloadSchemaType,
    Point,
    Prefetch,
    Query,
    QueryRequest,
    ScrollRequest,
    SparseVector,
    UpdateOperation,
)

NS = uuid.UUID("5b7e1f0e-8a1d-4c3a-9d55-2f6b1a0e9e11")


# qdrant-edge 0.8 can't filter on bool payloads, so sync status is mirrored into an
# indexed keyword `sync_state` (private | unassigned | queued | synced), derived here and only here.
# "unassigned" = shareable but no team picked yet — distinct from "queued" (has a team, just offline),
# because the fix for one is "pick a team" and the fix for the other is "wait for connectivity."
PENDING = Filter(must=[FieldCondition("sync_state", match=MatchValue("queued"))])
UNASSIGNED = Filter(must=[FieldCondition("sync_state", match=MatchValue("unassigned"))])


def sync_state(rec: dict) -> str:
    if rec.get("sensitivity") != "shareable":
        return "private"
    if rec.get("synced"):
        return "synced"
    return "unassigned" if rec.get("team_id") is None else "queued"


def pending_push_filter(team_id: str | None) -> Filter:
    must = [FieldCondition("sync_state", match=MatchValue("queued"))]
    if team_id is not None:
        must.append(FieldCondition("team_id", match=MatchValue(team_id)))
    return Filter(must=must)


def shared_for_team_filter(team_id: str) -> Filter:
    return Filter(must=[
        FieldCondition("sensitivity", match=MatchValue("shareable")),
        FieldCondition("team_id", match=MatchValue(team_id)),
    ])


def point_id(mem_id: str) -> str:
    """Stable UUID for a memory id — identical on every device and on the server."""
    return str(uuid.uuid5(NS, mem_id))


class LocalMemory:
    def __init__(self, path: Path, dim: int):
        self.path = path
        self.lock = threading.RLock()
        path.mkdir(parents=True, exist_ok=True)
        config = EdgeConfig(
            vectors={"dense": EdgeVectorParams(size=dim, distance=Distance.Cosine)},
            sparse_vectors={"bm25": EdgeSparseVectorParams(modifier=Modifier.Idf)},
        )
        has_data = any(path.iterdir())
        self.shard = EdgeShard.load(str(path), config) if has_data else EdgeShard.create(str(path), config)
        if not has_data:
            for field, schema in (
                ("mem_id", PayloadSchemaType.Keyword),
                ("sensitivity", PayloadSchemaType.Keyword),
                ("sync_state", PayloadSchemaType.Keyword),
                ("updated_ts", PayloadSchemaType.Float),
            ):
                self.shard.update(UpdateOperation.create_field_index(field, schema))
        # team_id is newer than the rest of the schema: an existing shard from before multi-team
        # support won't have this index, so (re)try it unconditionally — harmless if it already exists.
        try:
            self.shard.update(UpdateOperation.create_field_index("team_id", PayloadSchemaType.Keyword))
        except Exception:
            pass

    # ---- writes -----------------------------------------------------------

    def upsert(self, rec: dict, dense: list[float], sparse: SparseVector) -> None:
        rec = {**rec, "sync_state": sync_state(rec)}
        with self.lock:
            self.shard.update(
                UpdateOperation.upsert_points([Point(point_id(rec["mem_id"]), {"dense": dense, "bm25": sparse}, rec)])
            )
            self.shard.flush()

    def set_fields(self, mem_id: str, fields: dict[str, Any]) -> None:
        with self.lock:
            if "synced" in fields or "sensitivity" in fields or "team_id" in fields:
                fields = {**fields, "sync_state": sync_state({**(self.get(mem_id) or {}), **fields})}
            self.shard.update(UpdateOperation.set_payload([point_id(mem_id)], fields))
            self.shard.flush()

    def delete(self, mem_id: str) -> None:
        with self.lock:
            self.shard.update(UpdateOperation.delete_points([point_id(mem_id)]))
            self.shard.flush()

    # ---- reads ------------------------------------------------------------

    def get(self, mem_id: str, with_vector: bool = False) -> dict | None:
        with self.lock:
            recs = self.shard.retrieve([point_id(mem_id)], True, with_vector)
        if not recs:
            return None
        rec = dict(recs[0].payload or {})
        if with_vector:
            rec["_vector"] = recs[0].vector
        return rec

    def all(self, flt: Filter | None = None) -> list[dict]:
        out, offset = [], None
        with self.lock:
            while True:
                recs, offset = self.shard.scroll(ScrollRequest(offset=offset, limit=256, filter=flt, with_payload=True))
                out.extend(dict(r.payload or {}) for r in recs)
                if offset is None:
                    break
        out.sort(key=lambda r: r.get("updated_ts", 0), reverse=True)
        return out

    def pending_push(self, team_id: str | None = None) -> list[dict]:
        """Queued shareable records, scoped to one team (or every team if team_id is omitted)."""
        return self.all(pending_push_filter(team_id))

    def shared_for_team(self, team_id: str) -> list[dict]:
        """This device's and others' shareable records belonging to one specific team.

        The one place "this team's shared notes" is computed, so the scoping can't drift
        between the call sites that need it (reset-on-leave, pull reconciliation).
        """
        return self.all(shared_for_team_filter(team_id))

    def count(self, flt: Filter | None = None) -> int:
        with self.lock:
            return self.shard.count(CountRequest(exact=True, filter=flt))

    def stats(self) -> dict:
        def c(v):
            return self.count(Filter(must=[FieldCondition("sensitivity", match=MatchValue(v))]))

        return {
            "total": self.count(),
            "private": c("private"),
            "shareable": c("shareable"),
            "pending": self.count(PENDING),
            "unassigned": self.count(UNASSIGNED),
        }

    def search(self, dense: list[float], sparse: SparseVector, limit: int = 6) -> list[dict]:
        """Hybrid search: dense + BM25 prefetch, fused with Reciprocal Rank Fusion.

        Also runs the two legs separately so the UI can show *why* a hit
        matched (semantic similarity vs keyword overlap).
        """
        with self.lock:
            fused = self.shard.query(
                QueryRequest(
                    limit=limit,
                    prefetches=[
                        Prefetch(limit=limit * 3, query=Query.Nearest(dense, using="dense")),
                        Prefetch(limit=limit * 3, query=Query.Nearest(sparse, using="bm25")),
                    ],
                    query=Fusion.Rrf(k=60),
                    with_payload=True,
                )
            )
            dense_hits = self.shard.query(
                QueryRequest(limit=limit * 3, query=Query.Nearest(dense, using="dense"), with_payload=False)
            )
            sparse_hits = (
                self.shard.query(
                    QueryRequest(limit=limit * 3, query=Query.Nearest(sparse, using="bm25"), with_payload=False)
                )
                if sparse.indices
                else []
            )
        dense_score = {str(p.id): p.score for p in dense_hits}
        sparse_score = {str(p.id): p.score for p in sparse_hits}
        out = []
        for p in fused:
            pid = str(p.id)
            out.append(
                {
                    **dict(p.payload or {}),
                    "score": round(p.score, 4),
                    "semantic": round(dense_score.get(pid, 0.0), 4),
                    "keyword": round(sparse_score.get(pid, 0.0), 4),
                }
            )
        return out

    def close(self) -> None:
        with self.lock:
            self.shard.flush()
            self.shard.close()
