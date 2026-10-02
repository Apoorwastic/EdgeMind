"""EdgeMind device service.

    DEVICE_ID=device_a PORT=8101 python -m edge

Serves the API and the built web UI. All state lives in DATA_DIR.
"""
import asyncio
from collections import deque
import json
import os
import random
import re
import shutil
import string
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth
from .cloud import CloudStore
from .config import settings
from .embeddings import Embedder
from .events import EventBus
from .llm import CloudLLM, LocalLLM, OllamaError, build_messages, describe_cloud_error
from .network import NetworkGate, OfflineError
from .search import Vocabulary, followup_kind, is_personal
from .store import LocalMemory
from .sync import SyncManager, SyncState
from .team import TeamError, TeamManager
from .vault import VAULT_TEAM, Vault

# nomic-embed-text puts unrelated notes around 0.40-0.55 cosine, so a hit counts as relevant
# only above an absolute floor AND within a band of the best hit. Irrelevant hits never reach a model.
# Relevance cut-offs depend on the embedding model's score scale (calibrated on the demo notes:
# 18 exact, 18 misspelled, 14 reworded and 24 general questions).
if settings.embed_backend == "onnx":   # bge-small-en-v1.5: right notes 0.55-0.85, general questions' best note <= 0.50
    MIN_SEMANTIC, BAND, RELATED_SEMANTIC = 0.50, 0.08, 0.85  # weak matches need a shared word (STRONG)
    STRONG = 0.58                       # below this a note must also share a word with the question
    CLEAR_MIN, CLEAR_GAP = 0.47, 0.06   # a clear winner may sit a little below MIN_SEMANTIC
else:                           # nomic-embed-text
    MIN_SEMANTIC, BAND, RELATED_SEMANTIC = 0.60, 0.15, 0.80
    STRONG = 0.60
    CLEAR_MIN, CLEAR_GAP = 0.53, 0.08
vocab = Vocabulary()  # words in this device's notes: typo correction + keyword checks (edge/search.py)

S = settings
S.data_dir.mkdir(parents=True, exist_ok=True)
bus = EventBus(S.data_dir / "activity.jsonl")
gate = NetworkGate(bus, S.qdrant_url, S.qdrant_api_key, S.data_dir / "egress.jsonl", S.internet_hosts)
embedder = Embedder(S.ollama_url, S.embed_model, S.embed_dim, backend=S.embed_backend,
                    cache_dir=os.getenv("FASTEMBED_CACHE_PATH") or str(S.data_dir.parent / "models"))


def open_store() -> LocalMemory:
    """The device's shard for the current vector size. Switching embedding model (768-d nomic → 384-d bge)
    needs a new shard, since a shard's vector size is fixed: notes are copied over with placeholder vectors
    and re-embedded in the background (reembed_fallbacks). The old shard is left untouched, for rollback."""
    path = S.data_dir / ("shard" if S.embed_dim == 768 else f"shard{S.embed_dim}")
    fresh = not path.exists() or not any(path.iterdir())
    new = LocalMemory(path, S.embed_dim)
    old_path = S.data_dir / "shard"
    if fresh and path != old_path and old_path.exists() and any(old_path.iterdir()):
        try:
            # Read from a scratch copy: opening a shard writes to it (WAL, segment metadata), and the original
            # must stay byte-for-byte as it was so switching back to the old model loses nothing.
            scratch = Path(tempfile.mkdtemp(prefix="edgemind_migrate_")) / "shard"
            shutil.copytree(old_path, scratch)
            old = LocalMemory(scratch, 768)
            recs = old.all()
            old.close()
            shutil.rmtree(scratch.parent, ignore_errors=True)
            for rec in recs:
                new.upsert({**rec, "embedder": "migrating"}, embedder._hash(rec["text"]), embedder.sparse_doc(rec["text"]))
            print(f"[edgemind] moved {len(recs)} notes to the {S.embed_dim}-d shard; re-embedding in the background")
        except Exception as e:  # never block boot on a migration; the old shard is still there
            print(f"[edgemind] could not migrate notes from {old_path}: {e}")
    return new


store = open_store()
cloud = CloudStore(S.qdrant_url, S.qdrant_api_key, S.collection, S.embed_dim, gate, bus)
# Shared collections hold one vector size: 384-d notes go to "<team collection>_d384", apart from 768-d ones.
COLLECTION_SUFFIX = "" if S.embed_dim == 768 else f"_d{S.embed_dim}"
team = TeamManager(cloud.client, S.qdrant_url, S.collection, S.device_id, S.device_name, gate, bus,
                   S.data_dir / "team.json", suffix=COLLECTION_SUFFIX)
# Each team shares through its own collection; cloud.for_team(...) points at one per operation,
# so no ambient "current" collection needs setting here.
state = SyncState(S.data_dir / "sync_state.json")


def reset_shared_state(team_id: str, resolution: str = "private") -> None:
    """Leaving a team, or being removed from one, changes who that team's shared notes belong with.

    Notes pulled from other devices in that team are always dropped (they belong to the team
    you just left, not to you). This device's OWN notes for that team follow `resolution`:
    "private" re-tags them private (kept, never synced again, no longer stuck pointing at a
    team you can't reach) or "discard" deletes them outright. "private" is the only option when
    this fires automatically (the admin removed this device, or the team vanished) — there's no
    user present mid-sync to ask; it's also the safe default for an explicit Leave with no choice
    made. Other teams, and already-private notes, are never touched.
    """
    for rec in store.shared_for_team(team_id):
        if rec.get("origin") and rec["origin"] != S.device_id:
            store.delete(rec["mem_id"])
        elif resolution == "discard":
            store.delete(rec["mem_id"])
        else:
            store.set_fields(rec["mem_id"], {
                "sensitivity": "private", "team_id": None, "synced": False, "rev": 0, "base_rev": 0,
                "private_since": now_ms(),
            })
    state["retractions"] = [r for r in state["retractions"] if r.get("team_id") != team_id]
    state["cloud_cache"] = {k: v for k, v in state["cloud_cache"].items() if k != team_id}
    bus.emit("memory", None)
    bus.emit("team", team.view_all())


def _migrate_team_id() -> None:
    """Pre-multi-team devices have shareable records (and queued retractions) with no team_id.

    If this device happens to belong to exactly one team, that's the unambiguous owner — backfill
    it so an existing single-team install behaves identically after this upgrade. With zero or
    several teams there's no safe guess, so those stay unassigned (surfaced in the UI as "needs a
    team").
    """
    joined = team.teams
    if len(joined) != 1:
        return
    only = joined[0]["id"]
    for rec in store.all():
        if rec.get("sensitivity") == "shareable" and rec.get("team_id") is None:
            store.set_fields(rec["mem_id"], {"team_id": only})
    retractions = state["retractions"]
    if any(r.get("team_id") is None for r in retractions):
        for r in retractions:
            r.setdefault("team_id", None)
            if r["team_id"] is None:
                r["team_id"] = only
        state["retractions"] = retractions


_migrate_team_id()

def _migrate_sync_state() -> None:
    """Private notes now sync (encrypted) to the account's other devices: recompute each record's
    stored sync_state so the vault pass can find them. Harmless when nothing changed."""
    from .store import sync_state
    for rec in store.all():
        if rec.get("sync_state") != sync_state(rec):
            store.set_fields(rec["mem_id"], {"sensitivity": rec.get("sensitivity", "private")})


_migrate_sync_state()
vault = Vault(S.account, S.data_dir, S.collection, COLLECTION_SUFFIX)
syncer = SyncManager(S.device_id, store, cloud, embedder, gate, bus, state, team=team, on_removed=reset_shared_state,
                     vault=vault)
local_llm = LocalLLM(S.ollama_url, S.local_llm, [S.local_llm_fallback])
cloud_llm = CloudLLM(S.cloud_api_key, S.cloud_model, gate, S.cloud_provider, S.cloud_base_url)
prefs = {"private_route": "local"}  # "local" = private context never goes to cloud LLM; "redact" = send only shareable context
chat_path = S.data_dir / "chat.jsonl"


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return f"m_{now_ms()}_{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"


async def reembed_fallbacks() -> None:
    """Give every note a vector from the current embedding model.

    Notes saved while Ollama was down get a placeholder ("hash-fallback"); notes pulled from the shared
    store carry whatever the other device used ("from-cloud"). Their meaning scores are useless against
    this model's query vectors, so re-embed them — not just at boot, but whenever Ollama is back.
    """
    while True:
        if await embedder.check():
            for rec in store.all():
                if rec.get("embedder") != embedder.name:
                    dense, name = await embedder.dense(rec["text"])
                    if name == "hash-fallback":
                        break  # Ollama went away mid-way; try again next round
                    store.upsert({**rec, "embedder": name}, dense, embedder.sparse_doc(rec["text"]))
                    bus.activity("memory", f"Re-embedded {rec['mem_id']} with {name}", mem_id=rec["mem_id"])
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.gather(embedder.check(), local_llm.check(), gate.probe())
    gate.on_reconnect(lambda: syncer.sync(reason="reconnect"))
    tasks = [asyncio.create_task(gate.probe_loop()), asyncio.create_task(syncer.loop()),
             asyncio.create_task(reembed_fallbacks()), asyncio.create_task(local_llm.warm_up())]
    bus.activity("system", f"{S.device_name} booted — {store.count()} memories on device · "
                           f"embedder {embedder.name} · local LLM {'ready' if local_llm.available else 'unavailable'}")
    yield
    for t in tasks:
        t.cancel()
    store.close()


app = FastAPI(title="EdgeMind device", lifespan=lifespan)


# ---------------------------------------------------------------- sign-in (demo accounts, edge/auth.py)

OPEN_PATHS = {"/api/session", "/api/login", "/api/logout"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """An account's device answers its API only to a browser signed in as that account."""
    path = request.url.path
    if S.account and path.startswith("/api/") and path not in OPEN_PATHS:
        if (auth.verify(request.cookies.get(auth.COOKIE)) or {}).get("account") != S.account:
            return JSONResponse({"detail": "Sign in first."}, status_code=401)
    return await call_next(request)


def _signed_in(request: Request) -> bool:
    return bool(S.account) and (auth.verify(request.cookies.get(auth.COOKIE)) or {}).get("account") == S.account


def _set_session(resp, account_id: str) -> None:
    resp.set_cookie(auth.COOKIE, auth.sign(account_id, S.device_id, auth.SESSION_TTL),
                    max_age=auth.SESSION_TTL, httponly=True, samesite="lax", path="/")


@app.get("/api/session")
async def session(request: Request):
    acc = auth.get(S.account)
    return {
        "required": bool(S.account),
        "signed_in": _signed_in(request),
        "account": {"id": acc["id"], "name": acc["name"]} if acc else None,
        "device": {"id": S.device_id, "name": S.device_name, "kind": S.device_kind},
        "vault": {"enabled": vault.enabled, "unlocked": vault.unlocked},
        # Demo only: the login page offers these as one-click fills (DEMO_HINTS=0 hides them).
        "demo": [{"id": a["id"], "name": a["name"], "password": a["password"]} for a in auth.accounts()]
        if S.account and os.getenv("DEMO_HINTS", "1") == "1" else [],
    }


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=1, max_length=200)


@app.post("/api/login")
async def login(body: LoginBody):
    acc = auth.check_password(body.username, body.password)
    if not acc or acc["id"] != S.account:
        raise HTTPException(401, "Wrong name or password.")
    # The password is at hand only now: derive this account's vault key from it (kept on this device).
    first = not vault.unlocked
    vault.unlock(body.password)
    if first:
        bus.activity("privacy", "Vault unlocked on this device — Private notes now sync encrypted with your other devices")
        asyncio.create_task(syncer.sync(reason="unlock"))
    resp = JSONResponse({"ok": True})
    _set_session(resp, acc["id"])
    return resp


@app.post("/api/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    if S.account:
        resp.delete_cookie(auth.COOKIE, path="/")
    return resp


# ---------------------------------------------------------------- models

class NewMemory(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    sensitivity: Literal["device", "private", "shareable"] = "private"
    team_id: str | None = None  # which team a shareable note goes to; auto-filled if there's only one
    supersedes: str | None = None


class EditMemory(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=4000)
    sensitivity: Literal["device", "private", "shareable"] | None = None
    team_id: str | None = None


class AskBody(BaseModel):
    q: str = Field(min_length=1, max_length=2000)
    cid: str | None = Field(default=None, max_length=64)  # conversation; omitted = start a new one


class NetBody(BaseModel):
    mode: Literal["auto", "offline"]


class PrefBody(BaseModel):
    private_route: Literal["local", "redact"]


class TeamName(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class JoinBody(BaseModel):
    code: str = Field(min_length=6, max_length=12)


# ---------------------------------------------------------------- helpers

def public(rec: dict) -> dict:
    return {k: v for k, v in rec.items() if not k.startswith("_")}


async def local_search(q: str, limit: int = 6) -> tuple[list[dict], dict]:
    t0 = time.perf_counter()
    vocab.refresh(store.version, store.all())
    query, fixes = vocab.correct(q)  # "plumbre" → "plumber": BM25 needs exact words, and so does the meaning vector
    timing = {"searched_for": query if fixes else None}

    # Keyword fast path: exactly one note holds every meaningful word of the question → that's the match,
    # without waiting for the embedding model.
    only = vocab.only_note_with_all(query)
    if only and (rec := store.get(only)) and not rec.get("superseded_by"):
        hit = {**rec, "semantic": 1.0, "keyword": 1.0, "relevant": True, "match": "all words"}
        return [hit], {**timing, "embed_ms": 0.0, "search_ms": round((time.perf_counter() - t0) * 1000, 2), "fast": True}

    t1 = time.perf_counter()
    dense, emb_name = await embedder.dense(query, kind="query")
    t2 = time.perf_counter()
    hits = store.search(dense, embedder.sparse_query(query), limit=limit)
    t3 = time.perf_counter()
    # A meaning score only counts when the note's vector came from the same model as the question's.
    # Notes embedded while the model was down ("hash-fallback"), pulled with another device's vector
    # ("from-cloud") or mid-migration would score ~0 and be lost even on a perfect keyword match: judge
    # those by keywords.
    real = emb_name != "hash-fallback"
    same = sorted((h for h in hits if real and h.get("embedder") == emb_name), key=lambda h: -h["semantic"])
    top = same[0]["semantic"] if same else 0
    kw_top = max((h["keyword"] for h in hits), default=0)
    for h in hits:
        if h in same:
            # Weak matches (0.52-0.58) look alike for "Where did we leave the extra key?" (a note question)
            # and "How do I change a car tyre?" (not one): only shared words tell them apart. Notes near a
            # strong top match ride along, e.g. the router note for "How do I reset the internet box?".
            h["relevant"] = (h["semantic"] >= MIN_SEMANTIC and h["semantic"] >= top - BAND
                             and (top >= STRONG or vocab.covers(query, h["mem_id"], share=0.3)))
        else:
            h["relevant"] = h["keyword"] > 0 and h["keyword"] >= 0.5 * kw_top and vocab.covers(query, h["mem_id"])
    # Clear winner: nothing cleared the bar, but one note stands well above the rest and shares words with
    # the question ("Who is the plumbre?" → the plumber note at 0.56 vs 0.43 for the next).
    if same and not any(h["relevant"] for h in hits):
        second = same[1]["semantic"] if len(same) > 1 else 0
        if top >= CLEAR_MIN and top - second >= CLEAR_GAP and vocab.covers(query, same[0]["mem_id"], share=0.3):
            same[0]["relevant"] = True
            same[0]["match"] = "clear winner"
    return hits, {**timing, "embed_ms": round((t2 - t1) * 1000, 1), "search_ms": round((t3 - t2 + t1 - t0) * 1000, 2)}


def set_links(new_id_: str, old_id: str) -> None:
    old = store.get(old_id)
    if not old:
        raise HTTPException(404, f"{old_id} not found")
    store.set_fields(new_id_, {"supersedes": old_id})
    fields = {"superseded_by": new_id_, "updated_ts": now_ms()}
    if old.get("sensitivity") == "shareable":
        fields["synced"] = False
        fields["updated_by"] = S.device_id
    store.set_fields(old_id, fields)
    bus.activity("memory", f"{new_id_} supersedes {old_id} — older note kept but de-prioritised in answers",
                 mem_id=new_id_)


def append_chat(turn: dict) -> None:
    with chat_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(turn) + "\n")


LEGACY_CHAT = "c_legacy"  # turns written before conversations existed carry no cid


def _all_turns() -> list[dict]:
    if not chat_path.exists():
        return []
    turns = [json.loads(x) for x in chat_path.read_text(encoding="utf-8").splitlines() if x.strip()]
    for t in turns:
        t.setdefault("cid", LEGACY_CHAT)
    return turns


def read_chat(cid: str, n: int = 60) -> list[dict]:
    return [t for t in _all_turns() if t["cid"] == cid][-n:]


def list_chats() -> list[dict]:
    """One entry per conversation, newest activity first; titled by its first question."""
    chats: dict[str, dict] = {}
    for t in _all_turns():
        c = chats.setdefault(t["cid"], {"id": t["cid"], "title": None, "ts": t["ts"], "turns": 0})
        if c["title"] is None and t["role"] == "user":
            c["title"] = t["text"][:80]
        c["ts"] = max(c["ts"], t["ts"])
        c["turns"] += 1
    return sorted(chats.values(), key=lambda c: c["ts"], reverse=True)


def new_chat_id() -> str:
    return f"c_{now_ms()}_{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"


# ---------------------------------------------------------------- state

@app.get("/api/state")
async def get_state():
    return {
        "device": {"id": S.device_id, "name": S.device_name, "kind": S.device_kind, "port": S.port, "account": S.account},
        "network": gate.state(),
        "sync": syncer.status(),
        "memory": store.stats(),
        "models": {
            "embedder": embedder.name,
            "local_llm": local_llm.model if local_llm.available else None,
            "cloud_llm": f"{S.cloud_provider} · {S.cloud_model}" if cloud_llm.configured else None,
            "cloud_llm_error": cloud_llm.rejected,
        },
        "prefs": prefs,
        "teams": team.view_all(),
    }


@app.post("/api/network")
async def set_network(body: NetBody):
    await gate.set_mode(body.mode)
    return gate.state()


@app.post("/api/network/recheck")
async def recheck_network():
    await gate.recheck()
    return gate.state()


@app.post("/api/prefs")
async def set_prefs(body: PrefBody):
    prefs["private_route"] = body.private_route
    bus.activity("privacy", f"Private-context routing set to '{body.private_route}'")
    return prefs


# ---------------------------------------------------------------- memory

def resolve_team_id(requested: str | None) -> str | None:
    """Which team a shareable note goes to: the one explicitly requested (validated), else the
    device's sole team (zero-friction single-team path), else None — unassigned, the frontend
    is responsible for steering the user to pick one."""
    if requested is not None:
        if not team.get(requested):
            raise HTTPException(400, "You're not a member of that team.")
        return requested
    joined = team.teams
    return joined[0]["id"] if len(joined) == 1 else None


@app.get("/api/memories")
async def list_memories():
    return [public(r) for r in store.all()]


@app.post("/api/memories")
async def add_memory(body: NewMemory):
    text = body.text.strip()
    dense, emb_name = await embedder.dense(text)
    sparse = embedder.sparse_doc(text)
    # Evolving memory: look for a note this one might be revising, before inserting.
    near = [h for h in store.search(dense, sparse, limit=4)
            if h["semantic"] >= RELATED_SEMANTIC and not h.get("superseded_by")]
    ts = now_ms()
    tid = resolve_team_id(body.team_id) if body.sensitivity == "shareable" else None
    rec = {
        "mem_id": new_id(), "text": text, "role": "user", "sensitivity": body.sensitivity, "team_id": tid,
        "synced": False, "ts": ts, "updated_ts": ts, "rev": 0, "base_rev": 0,
        "origin": S.device_id, "updated_by": S.device_id, "embedder": emb_name,
        "supersedes": None, "superseded_by": None,
    }
    store.upsert(rec, dense, sparse)
    tag = ("this device only — never leaves it" if body.sensitivity == "device"
           else ("private — encrypted for your other devices" if vault.enabled else "private — stays on this device")
           if body.sensitivity == "private"
           else "queued for sync" if tid else "shareable — needs a team before it can sync")
    bus.activity("memory", f"Stored {rec['mem_id']} locally ({tag})", mem_id=rec["mem_id"], sensitivity=body.sensitivity)
    if body.supersedes:
        set_links(rec["mem_id"], body.supersedes)
    bus.emit("memory", None)
    syncer.soon()
    return {"memory": public(store.get(rec["mem_id"])), "related": [public(h) for h in near]}


@app.patch("/api/memories/{mem_id}")
async def edit_memory(mem_id: str, body: EditMemory):
    rec = store.get(mem_id)
    if not rec:
        raise HTTPException(404, "not found")
    fields: dict = {"updated_ts": now_ms(), "updated_by": S.device_id}
    resulting_sensitivity = body.sensitivity or rec["sensitivity"]

    if body.sensitivity and body.sensitivity != rec["sensitivity"] and body.sensitivity in ("private", "device"):
        if rec["sensitivity"] == "shareable":
            if rec.get("origin") != S.device_id:
                raise HTTPException(409, f"Shared by {rec.get('origin')} — it isn't yours to make private. Delete it or add your own note.")
            if (rec.get("base_rev") or 0) > 0:
                syncer.queue_retraction(mem_id, f"re-tagged {body.sensitivity}", rec.get("team_id"))
        elif rec["sensitivity"] == "private" and rec.get("vault_synced"):
            syncer.queue_retraction(mem_id, "made this-device-only", VAULT_TEAM)  # off your other devices too
        fields.update(sensitivity=body.sensitivity, team_id=None, synced=False, vault_synced=False, rev=0, base_rev=0,
                      private_since=now_ms())
        bus.activity("privacy", f"{mem_id} re-tagged {'this device only' if body.sensitivity == 'device' else 'private'}"
                     " — content will not reach the team again", mem_id=mem_id)

    elif resulting_sensitivity == "shareable" and (body.sensitivity == "shareable" or body.team_id is not None):
        was_shareable = rec["sensitivity"] == "shareable"
        if rec["sensitivity"] == "private" and rec.get("vault_synced"):
            syncer.queue_retraction(mem_id, "shared with a team instead", VAULT_TEAM)
            fields["vault_synced"] = False
        current_team = rec.get("team_id") if was_shareable else None
        target_team = resolve_team_id(body.team_id) if body.team_id is not None else (current_team or resolve_team_id(None))
        if was_shareable and current_team and target_team != current_team and (rec.get("base_rev") or 0) > 0:
            raise HTTPException(409, "This note already synced to a team — make it private, then re-share and pick the new team.")
        fields.update(sensitivity="shareable", team_id=target_team)
        if not was_shareable or target_team != current_team:
            fields["synced"] = False
        verb = "queued for sync" if target_team else "saved — needs a team before it can sync"
        bus.activity("privacy", f"{mem_id} tagged shareable ({verb})", mem_id=mem_id)

    if body.text and body.text.strip() != rec["text"]:
        text = body.text.strip()
        dense, emb_name = await embedder.dense(text)
        merged = {**rec, **fields, "text": text, "embedder": emb_name}
        if merged["sensitivity"] == "shareable":
            merged["synced"] = False
        if merged["sensitivity"] == "private":
            merged["vault_synced"] = False  # the edit goes to your other devices too
        store.upsert(merged, dense, embedder.sparse_doc(text))
        bus.activity("memory", f"Edited {mem_id} on device", mem_id=mem_id)
    else:
        store.set_fields(mem_id, fields)
    bus.emit("memory", None)
    syncer.soon()
    return public(store.get(mem_id))


@app.delete("/api/memories/{mem_id}")
async def delete_memory(mem_id: str):
    rec = store.get(mem_id)
    if not rec:
        raise HTTPException(404, "not found")
    if rec.get("sensitivity") == "shareable" and (rec.get("base_rev") or 0) > 0:
        syncer.queue_retraction(mem_id, "deleted", rec.get("team_id"))
    if rec.get("sensitivity") == "private" and rec.get("vault_synced"):
        syncer.queue_retraction(mem_id, "deleted", VAULT_TEAM)
    store.delete(mem_id)
    bus.activity("memory", f"Deleted {mem_id} from device", mem_id=mem_id)
    bus.emit("memory", None)
    syncer.soon()
    return {"ok": True}


@app.post("/api/memories/{mem_id}/supersede/{old_id}")
async def supersede(mem_id: str, old_id: str):
    if not store.get(mem_id):
        raise HTTPException(404, "not found")
    set_links(mem_id, old_id)
    bus.emit("memory", None)
    return {"ok": True}


@app.post("/api/search")
async def search(body: AskBody):
    bus.emit("searching", {"q": body.q})
    hits, timing = await local_search(body.q, limit=8)
    bus.activity("search", f"Local hybrid search '{body.q[:48]}' → {sum(h['relevant'] for h in hits)} hits "
                           f"in {timing['search_ms']} ms", timing=timing)
    return {"hits": [public(h) for h in hits], "timing": timing}


# ---------------------------------------------------------------- ask

NOTES_PER_PASS = 3  # notes per generation pass; small models answer better from a few than from many
# "Your notes don't mention…" — the cue to try the next notes before giving up.
NOT_FOUND = re.compile(
    r"\b(do(es)?n['’]?t|do(es)? not|can['’]?t|cannot|could ?n['’]?t|no)\b.{0,40}\b(mention|contain|include|say|find|"
    r"information|info|details?|record|provide|offer|specify|suggest|recommend|list)|"
    r"\bnot (mentioned|included|found|in (your|the|these) (notes|memories))", re.I)


def newest_first(notes: list[dict]) -> list[dict]:
    """The prompt lists memories newest first, so the model can prefer the newer of two conflicting notes."""
    return sorted(notes, key=lambda h: h["ts"], reverse=True)


def notes_answer(context: list[dict]) -> str:
    """No model may write the answer here (e.g. Private notes on a server without an on-device model):
    give the note that answers it. When another note matches just as well (a near tie, whose order can
    swap from one search to the next), show both rather than guess; the rest stay under "Based on"."""
    top = context[0]
    tied = [h for h in context[1:3] if abs(h.get("semantic", 0) - top.get("semantic", 0)) <= 0.02]
    if not tied:
        return f"From your notes: {top['text']}"
    return "From your notes:\n" + "\n".join(f"• {h['text']}" for h in [top, *tied])


def no_answer(local_err: str | None, cloud_err: str | None = None) -> str:
    """Nothing in the notes matched and no model answered: say what's missing, plainly."""
    get_ai = "your browser can download its own AI in Admin › Offline AI"
    if local_err:
        return f"No note matches that, and the on-device model {local_llm.model} couldn't answer. {local_err}"
    if not gate.online:
        if not local_llm.preferred:
            return f"No note matches that. While offline, general questions need an AI on your own device: {get_ai}."
        return "No note matches that. While offline, general questions need the on-device model, and it isn't responding."
    if cloud_err:
        return f"No note matches that, and the cloud model couldn't answer: {cloud_err}"
    if not cloud_llm.configured and not local_llm.preferred:
        return f"No note matches that. General questions need an AI model: set GEMINI_API_KEY on the server, or {get_ai}."
    return (f"No note matches that, and the on-device model {local_llm.model} isn't responding "
            "(is Ollama running?). Try again in a moment.")


def plan_route(context: list[dict]) -> tuple[str, str, list[dict]]:
    """Decide who generates, and with which memories. Returns (route, reason, context).

    With no relevant memory the question is answered from general knowledge: by the cloud model when
    online (only the question and non-private chat history leave the device), else by the on-device model.
    """
    private = [h for h in context if h["sensitivity"] != "shareable"]
    local_ok = local_llm.available
    no_local = local_llm.down_reason if local_llm.down_reason and not local_ok else "no on-device model"
    if not context:
        if gate.online and cloud_llm.configured:
            return "cloud", "no note matched · online → general answer from cloud model", []
        why = "offline" if not gate.online else (cloud_llm.rejected or "no cloud LLM key")
        if local_ok:
            return "local", f"no note matched · {why} → general answer on-device", []
        return "retrieval", f"no note matched · {why} and {no_local}", []
    if gate.online and cloud_llm.configured:
        if not private:
            return "cloud", "online · context is shareable", context
        if prefs["private_route"] == "redact":
            shared = [h for h in context if h["sensitivity"] == "shareable"]
            return "cloud", f"online · {len(private)} private memories withheld from cloud", shared
        if local_ok:
            return "local", f"online, but {len(private)} private memories matched → answered on-device", context
        return "retrieval", f"private context and {no_local} → retrieval only", context
    why = "offline" if not gate.online else (cloud_llm.rejected or "no cloud LLM key")
    if local_ok:
        return "local", f"{why} → on-device model", context
    return "retrieval", f"{why} and {no_local} → retrieval only", context


# Public deployments: cap questions per visitor so a shared link can't run up the cloud-LLM bill.
ASK_RATE_LIMIT = int(os.getenv("ASK_RATE_LIMIT", "0"))  # questions per minute per client IP; 0 = off
_ask_log: dict[str, deque] = {}


def rate_limited(request: Request) -> bool:
    if ASK_RATE_LIMIT <= 0:
        return False
    ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()
    now = time.time()
    log = _ask_log.setdefault(ip, deque())
    while log and now - log[0] > 60:
        log.popleft()
    if len(log) >= ASK_RATE_LIMIT:
        return True
    log.append(now)
    return False


@app.post("/api/ask")
async def ask(body: AskBody, request: Request):
    if rate_limited(request):
        raise HTTPException(429, f"Slow down: at most {ASK_RATE_LIMIT} questions a minute on this public demo.")
    q = body.q.strip()
    cid = body.cid or new_chat_id()
    history = read_chat(cid, 8)

    async def run():
        # Stop in the UI aborts the request; Starlette then cancels this generator mid-await, which also
        # closes the model stream. The finally keeps whatever was answered so far in the chat.
        answer, final_route, used, mode, done = "", "retrieval", [], "memory", False

        def save(stopped: bool = False) -> None:
            ts = now_ms()
            is_private = any(h["sensitivity"] != "shareable" for h in used) and final_route != "cloud"
            append_chat({"cid": cid, "role": "user", "text": q, "ts": ts, "private": is_private})
            append_chat({"cid": cid, "role": "assistant", "text": answer, "ts": ts, "route": final_route,
                         "used": [h["mem_id"] for h in used], "private": is_private, "mode": mode,
                         **({"stopped": True} if stopped else {})})
            bus.emit("chats", None)

        try:
            yield json.dumps({"type": "chat", "cid": cid}) + "\n"
            bus.emit("searching", {"q": q})
            hits, timing = await local_search(q, limit=8)
            # Follow-up ("When is grandma's birthday?" → "What does she like?"): the question alone can't find
            # the note, so search again together with the previous question. Only when the question alone found
            # no strong match, so a new question that merely looks like a follow-up isn't pulled off course.
            prev = next((t for t in reversed(history) if t["role"] == "user"), None)
            followup = None
            kind = followup_kind(q) if prev else None
            if kind == "pronoun" or (kind == "hint" and not (timing.get("fast") or any(
                    h["relevant"] and h["semantic"] >= STRONG for h in hits))):
                hits2, timing2 = await local_search(f"{prev['text']} {q}", limit=8)
                if any(h["relevant"] for h in hits2):
                    hits, timing, followup = hits2, {**timing2, "searched_for": timing.get("searched_for")}, prev
                    timing["followup_of"] = prev["text"]
            model_q = timing.get("searched_for") or q  # the model sees the spelling-corrected question
            if followup:
                model_q = f'Earlier question: "{followup["text"]}"\nFollow-up question: {model_q}'
            plain_q = timing.get("searched_for") or q

            def q_for(r: str) -> str:
                # A previous question that used private notes stays on this device: no cloud context from it.
                return plain_q if r == "cloud" and followup and followup.get("private") else model_q
            personal = is_personal(q)  # "my …": with no matching note, say so instead of guessing
            # Best match first. Small models lose track when handed many notes, so each pass sends only the
            # best few; the next ones are tried only if those didn't contain the answer (see below).
            context = [h for h in hits if h["relevant"] and not h.get("superseded_by")]
            # Only weak matches (none reached STRONG, no all-words hit): notes are offered, not imposed.
            weak = bool(context) and not timing.get("fast") and all(h["semantic"] < STRONG for h in context[:NOTES_PER_PASS])
            if not local_llm.available:
                await local_llm.check()  # Ollama may have come up after boot; don't stay model-less forever
            route, reason, used = plan_route(context[:NOTES_PER_PASS])
            used = newest_first(used)
            if len(context) > NOTES_PER_PASS:
                reason += f" · best {len(used)} of {len(context)} matching notes sent"
            used_ids = [h["mem_id"] for h in used]
            general = not context  # nothing in memory matched → general-knowledge answer
            mode = "general" if general else "memory"
            max_tokens = 600 if general else 300
            yield json.dumps({"type": "retrieval", "hits": [public(h) for h in hits], "timing": timing,
                              "route": route, "reason": reason, "used": used_ids, "mode": mode}) + "\n"
            bus.activity("ask", f"'{q[:48]}' → {len(context)} relevant local memories · route: {route} ({reason})",
                         route=route, used=used_ids, timing=timing)

            final_route = route
            local_err = None  # Ollama's own message when the on-device model fails (e.g. not enough memory)
            cloud_err = None  # the cloud model's failure, in plain words (rate limit, bad model name, ...)
            if route in ("cloud", "local"):
                hist = [t for t in history if not t.get("private")] if route == "cloud" else history
                msgs = build_messages(q_for(route), used, hist, general=general, weak=weak, personal=personal)
                try:
                    gen = cloud_llm.stream(msgs, used_ids) if route == "cloud" else local_llm.stream(msgs, max_tokens)
                    async for tok in gen:
                        answer += tok
                        yield json.dumps({"type": "token", "t": tok}) + "\n"
                except OfflineError:
                    final_route = "retrieval"
                    reason_fb = "went offline mid-answer"
                except Exception as e:
                    final_route = "retrieval"
                    if isinstance(e, OllamaError):
                        local_err = str(e)
                    if route == "cloud":
                        cloud_err = describe_cloud_error(e, cloud_llm.provider)
                    reason_fb = f"{route} model error: {cloud_err or local_err or type(e).__name__}"
                    if route == "cloud" and cloud_llm.rejected:
                        reason_fb = cloud_llm.rejected
                        bus.activity("system", f"{cloud_llm.rejected} — answering on-device until the key in .env is fixed and the device restarted")
                if final_route == "retrieval":
                    # Fall back to the local model if cloud failed, else to honest retrieval.
                    if route == "cloud" and local_llm.available:
                        final_route = "local"
                        yield json.dumps({"type": "reroute", "route": "local", "reason": reason_fb + " → on-device model"}) + "\n"
                        answer = ""
                        try:
                            async for tok in local_llm.stream(build_messages(q_for("local"), newest_first(context[:NOTES_PER_PASS]), history, general=general, personal=personal), max_tokens):
                                answer += tok
                                yield json.dumps({"type": "token", "t": tok}) + "\n"
                        except Exception as e:
                            final_route = "retrieval"
                            local_err = str(e) if isinstance(e, OllamaError) else None
                            reason_fb += f" · local model error: {local_err or type(e).__name__}"
                    if final_route == "retrieval":
                        bus.activity("ask", f"'{q[:48]}' → no model answered: {reason_fb}", route="retrieval")
                        yield json.dumps({"type": "reroute", "route": "retrieval", "reason": reason_fb}) + "\n"

            # The best notes didn't have it ("your notes don't mention…")? Try the next few before giving up.
            # Each batch is routed on its own, so a batch holding private notes still never goes to the cloud.
            nxt = NOTES_PER_PASS
            while final_route in ("cloud", "local") and not general and nxt < len(context) and NOT_FOUND.search(answer):
                batch = context[nxt:nxt + NOTES_PER_PASS]
                r2, why2, used2 = plan_route(batch)
                if r2 not in ("cloud", "local"):
                    break
                used, final_route, answer = newest_first(used2), r2, ""
                used_ids = [h["mem_id"] for h in used]
                why = f"first notes didn't say → checked notes {nxt + 1}–{nxt + len(batch)} of {len(context)} ({why2})"
                nxt += NOTES_PER_PASS
                yield json.dumps({"type": "reroute", "route": r2, "reason": why, "used": used_ids}) + "\n"
                hist = [t for t in history if not t.get("private")] if r2 == "cloud" else history
                try:
                    msgs = build_messages(q_for(r2), used, hist, general=False)
                    gen = cloud_llm.stream(msgs, used_ids) if r2 == "cloud" else local_llm.stream(msgs, max_tokens)
                    async for tok in gen:
                        answer += tok
                        yield json.dumps({"type": "token", "t": tok}) + "\n"
                except Exception as e:
                    final_route, used = "retrieval", context[:4]
                    yield json.dumps({"type": "reroute", "route": "retrieval", "reason": f"{r2} model error: {type(e).__name__}"}) + "\n"
                    break

            # None of the matching notes had it: the match was a false lead ("Recommend a good book" brushing
            # past "The library books are due…"). Answer from general knowledge instead of "your notes don't say".
            # Routed like any general question: only the question (no notes) may go to the cloud.
            if final_route in ("cloud", "local") and not general and NOT_FOUND.search(answer):
                r3, why3, _ = plan_route([])
                if r3 in ("cloud", "local"):
                    used, used_ids, mode, final_route, answer = [], [], "general", r3, ""
                    yield json.dumps({"type": "reroute", "route": r3, "mode": "general", "used": [],
                                      "reason": f"your notes didn't have it → general answer ({why3})"}) + "\n"
                    hist = [t for t in history if not t.get("private")] if r3 == "cloud" else history
                    try:
                        msgs = build_messages(q_for(r3), [], hist, general=True, personal=personal)
                        gen = cloud_llm.stream(msgs, []) if r3 == "cloud" else local_llm.stream(msgs, 600)
                        async for tok in gen:
                            answer += tok
                            yield json.dumps({"type": "token", "t": tok}) + "\n"
                    except Exception as e:
                        final_route, used = "retrieval", context[:4]
                        yield json.dumps({"type": "reroute", "route": "retrieval", "reason": f"{r3} model error: {type(e).__name__}"}) + "\n"

            if final_route == "retrieval":
                answer = notes_answer(context) if context else no_answer(local_err, cloud_err)
                yield json.dumps({"type": "token", "t": answer}) + "\n"

            save()
            done = True
            yield json.dumps({"type": "done", "route": final_route, "mode": mode}) + "\n"
        finally:
            if not done:
                bus.activity("ask", f"'{q[:48]}' stopped by user after {len(answer)} characters", route=final_route)
                save(stopped=True)

    return StreamingResponse(run(), media_type="application/x-ndjson")


@app.get("/api/chats")
async def chats():
    return list_chats()


@app.get("/api/chats/{cid}")
async def chat_history(cid: str):
    return read_chat(cid, 200)


@app.delete("/api/chats/{cid}")
async def delete_chat(cid: str):
    keep = [t for t in _all_turns() if t["cid"] != cid]
    chat_path.write_text("".join(json.dumps(t) + "\n" for t in keep), encoding="utf-8")
    bus.emit("chats", None)
    return {"ok": True}


# ---------------------------------------------------------------- cloud / sync

@app.post("/api/sync")
async def sync_now():
    return await syncer.sync(reason="manual")


@app.get("/api/cloud")
async def cloud_view(team_id: str):
    if not team.get(team_id):
        raise HTTPException(404, "not a member of that team")
    cache = state["cloud_cache"].get(team_id, {"records": [], "ts": None})
    if gate.online:
        # Every open page polls this; the sync loop refreshes the same snapshot every few seconds, so a
        # fresh one is served as is instead of asking the server again.
        if cache["ts"] and now_ms() - cache["ts"] < 10_000:
            return {"live": True, "records": cache["records"], "as_of": cache["ts"]}
        try:
            async with cloud.for_team(team.collection(team_id)):
                snap = await cloud.snapshot()
            state.data["cloud_cache"] = {**state["cloud_cache"], team_id: {"records": snap, "ts": now_ms()}}  # memory only
            return {"live": True, "records": snap, "as_of": state["cloud_cache"][team_id]["ts"]}
        except Exception:
            pass
    return {"live": False, "records": cache["records"], "as_of": cache["ts"]}


# ---------------------------------------------------------------- team

async def team_call(fn, *args, reset: str | None = None, reset_resolution: str = "private"):
    """Run a team action, mapping failures to messages the UI can show as-is.

    `reset`, when given, is the team_id whose local shared state should be reset afterwards
    (leaving a team) — creating or joining an *additional* team needs no reset, since nothing
    about the device's other teams changes. `reset_resolution` ("private" or "discard") decides
    what happens to this device's own notes for that team; see reset_shared_state().
    """
    try:
        result = await fn(*args)
    except TeamError as e:
        raise HTTPException(400, str(e))
    except OfflineError:
        raise HTTPException(409, "You're offline — connect to the server to manage your team.")
    except Exception as e:
        raise HTTPException(503, f"Couldn't reach the team server ({type(e).__name__}).")
    if reset:
        reset_shared_state(reset, reset_resolution)
        asyncio.create_task(syncer.sync(reason="team"))
    bus.emit("team", team.view_all())
    return {"teams": team.view_all(), "result": result}


@app.get("/api/team")
async def team_get():
    """Joined teams + members; refreshed from the server when online, else the cached copy."""
    if gate.online and team.teams:
        try:
            _, removed_ids = await team.refresh_all()
            for tid in removed_ids:
                reset_shared_state(tid)
        except Exception:
            pass
    return {"teams": team.view_all()}


@app.post("/api/team")
async def team_create(body: TeamName):
    return await team_call(team.create, body.name.strip())


@app.post("/api/team/join")
async def team_join(body: JoinBody):
    return await team_call(team.join, body.code)


@app.post("/api/team/{team_id}/leave")
async def team_leave(team_id: str, resolution: Literal["private", "discard"] = "private"):
    return await team_call(team.leave, team_id, reset=team_id, reset_resolution=resolution)


@app.post("/api/team/{team_id}/rename")
async def team_rename(team_id: str, body: TeamName):
    return await team_call(team.rename, team_id, body.name.strip())


@app.post("/api/team/{team_id}/code")
async def team_new_code(team_id: str):
    return await team_call(team.new_code, team_id)


@app.delete("/api/team/{team_id}/members/{device_id}")
async def team_remove(team_id: str, device_id: str):
    return await team_call(team.remove, team_id, device_id)


@app.get("/api/conflicts")
async def conflicts():
    return state["conflicts"]


@app.post("/api/conflicts/{cid}/restore")
async def restore_conflict(cid: str):
    c = next((c for c in state["conflicts"] if c["id"] == cid), None)
    if not c:
        raise HTTPException(404, "not found")
    loser = c["remote"] if c["winner"] == "local" else c["local"]
    rec = await edit_memory(c["mem_id"], EditMemory(text=loser["text"]))
    c["resolved"] = True
    state.save()
    bus.activity("conflict", f"Restored {loser['by']}'s version of {c['mem_id']} as a new edit", mem_id=c["mem_id"])
    return rec


@app.get("/api/activity")
async def activity():
    return bus.recent(150)


@app.get("/api/privacy/audit")
async def privacy_audit():
    """Prove the boundary: compare private ids against (a) every outbound payload and (b) every
    team's live shared store.

    (b) lists each team's server-side ids and compares them here, so the audit itself sends
    nothing private. The guarantee has to cover every joined team, not just one — a future bug
    in the per-team push path should still get caught here regardless of which team it hit.
    """
    private = {r["mem_id"]: r.get("private_since") or r.get("ts") or 0
               for r in store.all() if r.get("sensitivity") in ("private", "device")}
    device_only = {r["mem_id"] for r in store.all() if r.get("sensitivity") == "device"}
    # A record shared earlier and later re-tagged private legitimately appears in the ledger from
    # before the re-tag, so only outbound calls made while it was private count as violations.
    leaked = sorted({m for m, ts in gate.last_sent.items() if m in private and ts >= private[m]}
                    | {m for m, ts in gate.sealed_sent.items() if m in device_only and ts >= private[m]})
    in_cloud: list[str] | None = None
    in_vault: list[str] = []
    teams_checked = 0
    if gate.online:
        try:
            # Tombstones carry no text or vectors, so only live records count as "in the cloud".
            live: set[str] = set()
            for t in team.teams:
                async with cloud.for_team(team.collection(t["id"])):
                    live |= {m for m, meta in (await cloud.index()).items() if not meta.get("deleted")}
                teams_checked += 1
            in_cloud = sorted(set(private) & live)
            # Your vault may hold Private notes, but only sealed: no text and no vectors. A device-only
            # note, or anything readable, in it is a violation.
            if vault.enabled:
                async with cloud.for_team(vault.collection):
                    sealed = {m: meta for m, meta in (await cloud.sealed_index()).items() if not meta.get("deleted")}
                in_vault = sorted(sealed)
                in_cloud += sorted(m for m, meta in sealed.items()
                                   if m in device_only or meta.get("text") or meta.get("has_vectors") or not meta.get("sealed"))
        except Exception:
            in_cloud = None
    retracting = {r["mem_id"] for r in state["retractions"]}
    return {
        "private_records": len(private),
        "device_only_records": len(device_only),
        "encrypted_in_vault": len(in_vault),
        "outbound_calls": gate.calls,
        "private_in_outbound": leaked,
        "private_in_cloud": in_cloud,
        "teams_checked": teams_checked,
        "pending_retraction": sorted(retracting & set(private)),
        "cloud_checked": in_cloud is not None,
        "ok": not leaked and not [m for m in (in_cloud or []) if m not in retracting],
    }


@app.get("/api/egress")
async def egress():
    from dataclasses import asdict
    return [asdict(e) for e in list(gate.ledger)[-80:]][::-1]


# ---------------------------------------------------------------- events

@app.get("/api/events")
async def events():
    q = bus.subscribe()

    async def gen():
        try:
            yield f"event: hello\ndata: {json.dumps(gate.state())}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"event: {msg['event']}\ndata: {json.dumps(msg['data'])}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# ---------------------------------------------------------------- web UI

if S.web_dist.exists():
    app.mount("/assets", StaticFiles(directory=S.web_dist / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        f = S.web_dist / path
        return FileResponse(f if path and f.is_file() else S.web_dist / "index.html")
