"""Seed both devices with demo notes.

    python scripts/seed_demo.py                    # everyday household scenario (default)
    python scripts/seed_demo.py --scenario field   # field-engineer scenario
    python scripts/seed_demo.py --reset            # wipe notes, chat, teams and shared collections first

Device A creates the scenario's team and device B joins it with the invite code, so shared notes
sync straight away. Run after scripts/start.ps1 (use -Fresh for a completely clean server as well).
"""
import argparse
import os
from pathlib import Path

import httpx
from qdrant_client import QdrantClient

ROOT = Path(__file__).resolve().parent.parent
A = httpx.Client(base_url=os.getenv("SEED_DEVICE_A", "http://127.0.0.1:8101"), timeout=60)
B = httpx.Client(base_url=os.getenv("SEED_DEVICE_B", "http://127.0.0.1:8102"), timeout=60)

TEAM_NAMES = {"home": "Our Family", "field": "Field Crew"}

SCENARIOS = {
    # A person's own laptop (A) and the family tablet at home (B). The private notes are
    # things you'd never want on a shared family device, or anywhere in the cloud.
    "home": {
        "a": [
            ("Planning a surprise birthday party for Sam on Saturday 12 Oct — don't tell anyone at home!", "private"),
            ("My dentist appointment is Thursday 10 Oct at 4:30 pm at Dr. Mehta's clinic.", "private"),
            ("Passport number ends in 4821 and it expires in June 2028.", "private"),
            ("Salary comes in on the 28th; rent auto-pays on the 1st.", "private"),
            ("Home Wi-Fi is 'MapleHouse' and the password is sunflower2024.", "shareable"),
            ("Trash and recycling go out every Tuesday night.", "shareable"),
            ("Bruno the dog eats 1 cup of food at 8 am and 6 pm — never give him chocolate or grapes.", "shareable"),
            ("The spare house key is with the neighbours in flat 4B.", "shareable"),
        ],
        "b": [
            ("Plumber Ravi fixed the kitchen sink — call him on 555-0142 if it leaks again.", "shareable"),
            ("Grandma's birthday is 3 November — she loves orchids.", "shareable"),
            ("Gift idea for Mom: the blue scarf from the Sunday market, about $25.", "private"),
        ],
    },
    "field": {
        "a": [
            ("The compressor torque spec for unit 7 is 45 Nm — from the OEM binder, not the wiki.", "private"),
            ("Client contact at Harbor Cold Storage is Priya Nair, prefers calls before 10am.", "private"),
            ("Door code for the Harbor Cold Storage plant room is 4417.", "private"),
            ("Warehouse zone B wifi drops near the metal shelving after 3pm — use the loading bay AP.", "shareable"),
            ("Unit 7 condenser fan bearing is noisy; replacement part is SKF 6204-2RS.", "shareable"),
            ("Refrigerant on units 5-8 is R-448A. Units 1-4 were retrofitted to R-449A in 2025.", "shareable"),
        ],
        "b": [
            ("Parking for contractors at Harbor Cold Storage is behind gate 3, not the main lot.", "shareable"),
            ("Site safety induction must be renewed every 12 months — mine expires in March.", "private"),
        ],
    },
}


def reset():
    """Delete every note on both devices, leave their teams, clear chat, and drop the shared collections."""
    for c in (A, B):
        c.post("/api/network", json={"mode": "auto"})
        for m in c.get("/api/memories").json():
            c.delete(f"/api/memories/{m['mem_id']}")
        c.post("/api/team/leave")
        for chat in c.get("/api/chats").json():
            c.delete(f"/api/chats/{chat['id']}")
    # Team registry, every team's collection and the pre-team shared collection all share this prefix.
    prefix = os.getenv("QDRANT_COLLECTION", "edgemind_shared")
    q = QdrantClient(url=os.getenv("QDRANT_URL", "http://127.0.0.1:6333"), api_key=os.getenv("QDRANT_API_KEY") or None)
    for col in q.get_collections().collections:
        if col.name == prefix or col.name.startswith(prefix + "_"):
            q.delete_collection(col.name)


def ensure_team(name: str) -> None:
    """A creates (or keeps) its team; B joins it with the invite code."""
    ta = A.get("/api/state").json()["team"]
    if not ta:
        ta = A.post("/api/team", json={"name": name}).raise_for_status().json()["team"]
    tb = B.get("/api/state").json()["team"]
    if tb and tb["id"] != ta["id"]:
        B.post("/api/team/leave").raise_for_status()
        tb = None
    if not tb:
        B.post("/api/team/join", json={"code": ta["code"]}).raise_for_status()
    print(f"team: {ta['name']} · invite code {ta['code']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=sorted(SCENARIOS), default="home")
    ap.add_argument("--reset", action="store_true", help="wipe existing notes and chat on both devices first")
    args = ap.parse_args()

    if args.reset:
        reset()
    notes = SCENARIOS[args.scenario]
    for c, key in ((A, "a"), (B, "b")):
        c.post("/api/network", json={"mode": "auto"})
        for text, sensitivity in notes[key]:
            c.post("/api/memories", json={"text": text, "sensitivity": sensitivity}).raise_for_status()

    ensure_team(TEAM_NAMES[args.scenario])
    print("A sync:", A.post("/api/sync").json())
    print("B sync:", B.post("/api/sync").json())
    ensure_team(TEAM_NAMES[args.scenario])
    print("A sync:", A.post("/api/sync").json())
    print("audit A:", A.get("/api/privacy/audit").json()["ok"], " audit B:", B.get("/api/privacy/audit").json()["ok"])


if __name__ == "__main__":
    main()
