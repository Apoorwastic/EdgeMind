"""Teams: who a device shares its "Team" notes with.

A team lives on the central Qdrant Server, because that is the one place every device can reach:

  * registry collection `<QDRANT_COLLECTION>_registry` holds one point per team (name, invite code, admin)
    and one point per member device (name, role, joined/last-seen times);
  * each team's shared notes live in their own collection, `<QDRANT_COLLECTION>_<team_id>`,
    so members of one team can never read another team's notes.

A device can belong to any number of teams at once. Each shareable note is scoped to exactly one
team (chosen when it's saved or shared), so different notes can go to different teams, but a
single note never fans out to more than one. Creating or joining a team needs a connection;
everything else keeps working offline from the cached copy in `team.json`. Only device ids and
names go into the registry, never note content. There is no authentication: the invite code is
the only key (out of scope for the hackathon).
"""
import json
import random
import time
import uuid
from pathlib import Path

from qdrant_client import AsyncQdrantClient, models

from .events import EventBus
from .network import NetworkGate

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I


def now_ms() -> int:
    return int(time.time() * 1000)


def _pid(key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"edgemind:{key}"))


def _code() -> str:
    c = "".join(random.choices(CODE_ALPHABET, k=6))
    return f"{c[:3]}-{c[3:]}"


def normalize_code(code: str) -> str:
    c = "".join(ch for ch in code.upper() if ch.isalnum())
    return f"{c[:3]}-{c[3:]}" if len(c) == 6 else code.strip().upper()


class TeamError(RuntimeError):
    pass


class TeamManager:
    def __init__(self, client: AsyncQdrantClient, url: str, prefix: str, device_id: str, device_name: str,
                 gate: NetworkGate, bus: EventBus, path: Path):
        self.client = client
        self.url = url
        self.prefix = prefix
        self.registry = f"{prefix}_registry"
        self.device_id = device_id
        self.device_name = device_name
        self.gate = gate
        self.bus = bus
        self.path = path
        raw: dict = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        # Migrate a pre-multi-team team.json ({"team": {...}, "members": [...], "members_ts": ...})
        # into the list shape. Without this, an existing single-team device would silently lose its
        # team on the first boot after this upgrade.
        if "teams" not in raw and raw.get("team"):
            legacy = raw["team"]
            raw["teams"] = [{**legacy, "members": raw.get("members", []), "members_ts": raw.get("members_ts")}]
        self.data = {"teams": raw.get("teams", [])}

    # ---- local state -------------------------------------------------------

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.data, indent=1), encoding="utf-8")

    @property
    def teams(self) -> list[dict]:
        """A snapshot copy — callers that iterate across awaits should hold onto this list, since
        a concurrent team action (join/leave/remove, from another request) can mutate the live one."""
        return list(self.data["teams"])

    def get(self, team_id: str) -> dict | None:
        return next((t for t in self.data["teams"] if t["id"] == team_id), None)

    def is_admin(self, team_id: str) -> bool:
        t = self.get(team_id)
        return bool(t and t.get("role") == "admin")

    def collection(self, team_id: str) -> str:
        return f"{self.prefix}_{team_id}"

    def view(self, team_id: str) -> dict | None:
        return self.get(team_id)

    def view_all(self) -> list[dict]:
        return self.teams

    def _upsert(self, team: dict) -> None:
        others = [t for t in self.data["teams"] if t["id"] != team["id"]]
        self.data["teams"] = others + [team]
        self._save()

    def _remove(self, team_id: str) -> dict | None:
        team = self.get(team_id)
        self.data["teams"] = [t for t in self.data["teams"] if t["id"] != team_id]
        self._save()
        return team

    # ---- registry ----------------------------------------------------------

    async def _ensure(self) -> None:
        # Re-checked on every action (one cheap call): the server may have been reset since, and a
        # stale "exists" would make writes fail. After a reset the device's teams are simply gone.
        if not await self.client.collection_exists(self.registry):
            try:
                await self.client.create_collection(
                    self.registry, vectors_config=models.VectorParams(size=1, distance=models.Distance.DOT))
                for field in ("kind", "team_id", "code", "device_id"):
                    await self.client.create_payload_index(self.registry, field, field_schema="keyword")
            except Exception:
                if not await self.client.collection_exists(self.registry):
                    raise

    async def _put(self, key: str, payload: dict) -> None:
        await self.client.upsert(self.registry, points=[models.PointStruct(id=_pid(key), vector=[1.0], payload=payload)])

    async def _find(self, **match) -> list[dict]:
        flt = models.Filter(must=[models.FieldCondition(key=k, match=models.MatchValue(value=v)) for k, v in match.items()])
        pts, _ = await self.client.scroll(self.registry, scroll_filter=flt, limit=200, with_payload=True, with_vectors=False)
        return [dict(p.payload) for p in pts]

    def _member(self, team_id: str, role: str) -> dict:
        ts = now_ms()
        return {"kind": "member", "team_id": team_id, "device_id": self.device_id, "device_name": self.device_name,
                "role": role, "joined_ts": ts, "last_seen": ts}

    async def _members(self, team_id: str) -> list[dict]:
        return sorted(await self._find(kind="member", team_id=team_id), key=lambda m: m.get("joined_ts", 0))

    # ---- actions (need a connection) ----------------------------------------

    async def create(self, name: str) -> dict:
        self.gate.egress(self.url, "team-create")
        await self._ensure()
        team_id = "".join(random.choices("abcdefghijkmnpqrstuvwxyz23456789", k=8))
        code = _code()
        team = {"kind": "team", "team_id": team_id, "name": name, "code": code,
                "admin": self.device_id, "created_ts": now_ms()}
        await self._put(f"team:{team_id}", team)
        member = self._member(team_id, "admin")
        await self._put(f"member:{team_id}:{self.device_id}", member)
        view = {"id": team_id, "name": name, "code": code, "role": "admin", "joined_ts": member["joined_ts"],
                "members": [member], "members_ts": now_ms()}
        self._upsert(view)
        self.bus.activity("team", f"Created team “{name}” — invite code {code}")
        return self.view(team_id)

    async def join(self, code: str) -> dict:
        self.gate.egress(self.url, "team-join")
        await self._ensure()
        found = await self._find(kind="team", code=normalize_code(code))
        if not found:
            raise TeamError("No team has that invite code.")
        team = found[0]
        if self.get(team["team_id"]):
            raise TeamError(f"You're already in “{team['name']}”.")
        member = self._member(team["team_id"], "member")
        await self._put(f"member:{team['team_id']}:{self.device_id}", member)
        members = await self._members(team["team_id"])
        view = {"id": team["team_id"], "name": team["name"], "code": team["code"], "role": "member",
                "joined_ts": member["joined_ts"], "members": members, "members_ts": now_ms()}
        self._upsert(view)
        self.bus.activity("team", f"Joined team “{team['name']}” ({len(members)} members)")
        return self.view(team["team_id"])

    async def leave(self, team_id: str) -> dict | None:
        """Drop this device from one team. Works offline too: the registry entry is removed if reachable."""
        team = self.get(team_id)
        if not team:
            return None
        if self.gate.online:
            try:
                self.gate.egress(self.url, "team-leave")
                await self._ensure()
                if self.is_admin(team_id):
                    # Hand the team to the longest-standing member; an empty team is deleted.
                    others = [m for m in await self._members(team_id) if m["device_id"] != self.device_id]
                    record = await self._team_record(team_id)
                    if others:
                        heir = others[0]
                        await self._put(f"team:{team_id}", {**record, "admin": heir["device_id"]})
                        await self._put(f"member:{team_id}:{heir['device_id']}", {**heir, "role": "admin"})
                    else:
                        await self.client.delete(self.registry, points_selector=models.PointIdsList(
                            points=[_pid(f"team:{team_id}")]))
                await self.client.delete(self.registry, points_selector=models.PointIdsList(
                    points=[_pid(f"member:{team_id}:{self.device_id}")]))
            except Exception:
                pass  # offline or server trouble: the admin can still remove the stale entry
        self._remove(team_id)
        self.bus.activity("team", f"Left team “{team['name']}” — its shared notes stay on this device until shared again")
        return team

    async def refresh_all(self) -> tuple[list[dict], list[str]]:
        """Heartbeat every joined team, run on every sync: update last-seen, pick up renames/new
        codes, and detect removal. Returns (still-valid team views, ids of teams this device was
        removed from — by the admin, or because the team is gone).

        Iterates a snapshot (`self.teams`), not the live list, because a concurrent team action from
        another request (join/leave/remove) can mutate `self.data["teams"]` mid-loop.
        """
        valid, removed = [], []
        for team in self.teams:
            try:
                v = await self._refresh_one(team["id"])
            except Exception:
                valid.append(team)  # offline or server trouble: keep the cached copy, try again next time
                continue
            if v is None:
                removed.append(team["id"])
            else:
                valid.append(v)
        return valid, removed

    async def _refresh_one(self, team_id: str) -> dict | None:
        team = self.get(team_id)
        if not team:
            return None
        self.gate.egress(self.url, "team-heartbeat")
        await self._ensure()
        me = await self._find(kind="member", team_id=team_id, device_id=self.device_id)
        info = await self._find(kind="team", team_id=team_id)
        if not me or not info:
            self._remove(team_id)
            self.bus.activity("team", f"This device was removed from team “{team['name']}”", level="warn")
            return None
        member = {**me[0], "last_seen": now_ms(), "device_name": self.device_name}
        await self._put(f"member:{team_id}:{self.device_id}", member)
        t = info[0]
        members = await self._members(team_id)
        view = {**team, "name": t["name"], "code": t["code"],
                "role": "admin" if t.get("admin") == self.device_id else member.get("role", "member"),
                "members": members, "members_ts": now_ms()}
        self._upsert(view)
        return view

    # ---- admin-only --------------------------------------------------------

    def _need_admin(self, team_id: str) -> dict:
        team = self.get(team_id)
        if not team:
            raise TeamError("This device isn't in that team.")
        if not self.is_admin(team_id):
            raise TeamError("Only the team admin can do that.")
        return team

    async def _team_record(self, team_id: str) -> dict:
        found = await self._find(kind="team", team_id=team_id)
        if not found:
            raise TeamError("The team no longer exists on the server.")
        return found[0]

    async def rename(self, team_id: str, name: str) -> dict:
        team = self._need_admin(team_id)
        self.gate.egress(self.url, "team-rename")
        await self._ensure()
        await self._put(f"team:{team_id}", {**await self._team_record(team_id), "name": name})
        self.bus.activity("team", f"Renamed team “{team['name']}” → “{name}”")
        return await self._refresh_one(team_id)

    async def new_code(self, team_id: str) -> dict:
        team = self._need_admin(team_id)
        self.gate.egress(self.url, "team-new-code")
        await self._ensure()
        code = _code()
        await self._put(f"team:{team_id}", {**await self._team_record(team_id), "code": code})
        self.bus.activity("team", f"New invite code for “{team['name']}”: {code} — the old code no longer works")
        return await self._refresh_one(team_id)

    async def remove(self, team_id: str, device_id: str) -> dict:
        team = self._need_admin(team_id)
        if device_id == self.device_id:
            raise TeamError("You can't remove yourself — leave the team instead.")
        self.gate.egress(self.url, "team-remove-member")
        await self._ensure()
        members = self.get(team_id).get("members", [])
        gone = [m for m in members if m["device_id"] == device_id]
        await self.client.delete(self.registry, points_selector=models.PointIdsList(
            points=[_pid(f"member:{team_id}:{device_id}")]))
        name = gone[0]["device_name"] if gone else device_id
        self.bus.activity("team", f"Removed {name} from “{team['name']}” — it stops syncing on its next check")
        return await self._refresh_one(team_id)
