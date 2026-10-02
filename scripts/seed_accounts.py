"""Seed the demo accounts and teams from deploy/demo.json.

    python scripts/seed_accounts.py           # add whatever is missing (safe to run on every start)
    python scripts/seed_accounts.py --reset   # wipe the accounts' notes and teams first

Teams (deploy/demo.json): Thunderbolts (Rakshit, Apoorwa, Akhila), Night Owls (Neha, Karan, Akhila)
and Pixel Pirates (Meera, Dev). Akhila is in two teams; each of her Team notes goes to one of them.
Every note has one of three levels:
  Team         reaches every device in that team
  Private      reaches only the writer's own devices, encrypted (Apoorwa's laptop <-> phone)
  This device  stays on the device it was written on
"""
import argparse
import os
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from edge.auth import demo, get as get_account  # noqa: E402

T, NO, PB = "Thunderbolts", "Night Owls", "Pixel Pirates"
# device id -> [(text, level, team for Team notes)]
NOTES = {
    "rakshit": [
        ("Thunderbolts demo slot is Saturday 4 Oct at 11:30 am in Hall B — be there by 11.", "shareable", T),
        ("Team stand-up is every day at 10 pm on Google Meet; the link is pinned in our WhatsApp group.", "shareable", T),
        ("Rakshit owns the sync engine and Qdrant Edge — ask him about conflicts or the shared server.", "shareable", T),
        ("The live demo link is edgemind-production-fb04.up.railway.app; only redeploy from master.", "shareable", T),
        ("My train home is the 6:40 pm Shatabdi on 5 Oct, coach C3, seat 42.", "private", None),
        ("Pay the ₹200 library fine before Friday or the hall ticket gets blocked.", "private", None),
        ("Call Mom on Sunday evening — she wants to hear how the demo went.", "private", None),
        ("My bike lock combination is 3914.", "device", None),
    ],
    "apoorwa": [
        ("Apoorwa owns the web UI and the offline AI in the browser; send UI bugs to her.", "shareable", T),
        ("Pitch order: the problem, live demo (offline first), privacy audit, team sync, what's next.", "shareable", T),
        ("Venue Wi-Fi is 'CC6-Hackers' and the password is build2026.", "shareable", T),
        ("The judges want to see the privacy audit live — keep Admin › Privacy open during the demo.", "shareable", T),
        ("Gift idea for Akhila's birthday: the noise-cancelling earbuds she liked at the mall.", "private", None),
        ("Dentist appointment on Tuesday 7 Oct at 5 pm.", "private", None),
        ("My GitHub recovery codes are in the blue notebook, page 3.", "private", None),
        ("My laptop's BIOS password is falcon-27.", "device", None),
    ],
    "apoorwa_phone": [
        ("Bought Akhila's earbuds — they're hidden in my wardrobe, top shelf.", "private", None),
        ("My phone's SIM PIN is 8264.", "device", None),
    ],
    "akhila": [
        ("Akhila owns the backend API, embeddings and the end-to-end test script.", "shareable", T),
        ("Before the demo run scripts/e2e_test.py — every check should pass.", "shareable", T),
        ("Lunch on demo day is at 1:30 pm in the cafeteria; Rakshit is vegetarian.", "shareable", T),
        ("Backup plan if the venue internet dies: run everything on the laptop with start.ps1, it works fully offline.", "shareable", T),
        ("Night Owls study group meets Wednesday at 9 pm in Library room 2.", "shareable", NO),
        ("Planning a surprise thank-you card for Rakshit and Apoorwa after the results.", "private", None),
        ("Hostel curfew is 11 pm, so I need to leave the venue by 10:30.", "private", None),
        ("Renew my bus pass before 10 Oct.", "private", None),
        ("Hostel room safe code is 5531.", "device", None),
    ],
    "neha": [
        ("Night Owls: the DBMS assignment is due Monday 6 Oct at midnight on the portal.", "shareable", NO),
        ("Neha booked the group study room for Saturday 2-5 pm; the key is at the front desk.", "shareable", NO),
        ("Night Owls shared drive has the past exam papers in the 'PYQs' folder.", "shareable", NO),
        ("My scholarship renewal form needs the principal's signature by 15 Oct.", "private", None),
        ("Laptop lock screen PIN is 7720.", "device", None),
    ],
    "karan": [
        ("Karan has the projector for Night Owls presentations — ask him a day before.", "shareable", NO),
        ("Night Owls quiz practice: chapters 4 to 6, Thursday 8 pm on Discord.", "shareable", NO),
        ("Owe Neha ₹350 for the pizza on Friday.", "private", None),
        ("Gym membership ends on 20 Oct — renew at the counter.", "private", None),
        ("My locker code at the gym is 4062.", "device", None),
    ],
    "meera": [
        ("Pixel Pirates game jam theme is 'Lost at Sea'; submissions close Sunday 6 pm.", "shareable", PB),
        ("Pixel Pirates repo is github.com/pixel-pirates/jam; push to the dev branch, never main.", "shareable", PB),
        ("Meera is drawing the sprites; send her any art requests by Friday.", "shareable", PB),
        ("Ask Dad about the Diwali train tickets before Wednesday.", "private", None),
        ("Tablet passcode is 1958.", "device", None),
    ],
    "dev": [
        ("Pixel Pirates build: open the project in Godot 4.3 and run export_web.sh.", "shareable", PB),
        ("Dev is writing the soundtrack; the drafts are in the 'audio' folder of the repo.", "shareable", PB),
        ("Interview with the design studio is on 9 Oct at 3 pm — prepare the portfolio.", "private", None),
        ("Wi-Fi router admin password at home is seagull-41.", "device", None),
    ],
}


def signed_in(d: dict) -> httpx.Client:
    acc = get_account(d["account"])
    c = httpx.Client(base_url=os.getenv(f"SEED_URL_{d['id'].upper()}", f"http://127.0.0.1:{d['port']}"), timeout=60)
    c.post("/api/login", json={"username": acc["id"], "password": acc["password"]}).raise_for_status()  # unlocks its vault
    return c


def team_call(c: httpx.Client, path: str, body: dict | None = None, params: dict | None = None) -> dict:
    """Team actions need the shared server; a device mid-sync may miss a probe, so retry briefly."""
    for _ in range(10):
        r = c.post(path, json=body, params=params)
        if r.status_code != 409:
            return r.raise_for_status().json()
        time.sleep(1.5)
    return r.raise_for_status().json()


def sync_all(clients: dict, rounds: int = 2) -> None:
    for _ in range(rounds):  # push from everyone, then pull everyone else's
        for c in clients.values():
            c.post("/api/sync")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="wipe the accounts' notes and teams first")
    args = ap.parse_args()
    spec = demo()
    clients = {d["id"]: signed_in(d) for d in spec["devices"] if d.get("account")}
    for c in clients.values():
        c.post("/api/network", json={"mode": "auto"})
    for who, c in clients.items():  # just started: wait for each device's first connectivity check
        for _ in range(60):
            if c.get("/api/state").json()["network"]["online"]:
                break
            time.sleep(1)
        else:
            sys.exit(f"{who} is offline (no shared server or internet): can't create or join teams")

    if args.reset:
        # Leave every team first (that drops all team notes), then delete what's left. The other order
        # races the background sync: a device still in a team pulls notes back while they're deleted.
        for c in clients.values():
            for t in c.get("/api/state").json()["teams"]:
                team_call(c, f"/api/team/{t['id']}/leave", params={"resolution": "discard"})
        for c in clients.values():
            for m in c.get("/api/memories").json():
                c.delete(f"/api/memories/{m['mem_id']}")
        sync_all(clients, 1)  # clear the vaults too

    # Each team's admin creates it (or keeps it); its members join with the invite code.
    team_ids = {}
    for t in spec.get("teams", []):
        admin = clients[t["admin"]]
        team = next((x for x in admin.get("/api/state").json()["teams"] if x["name"] == t["name"]), None)
        if not team:
            team = team_call(admin, "/api/team", {"name": t["name"]})["result"]
        for who in t["members"]:
            if not any(x["id"] == team["id"] for x in clients[who].get("/api/state").json()["teams"]):
                team_call(clients[who], "/api/team/join", {"code": team["code"]})
        team_ids[t["name"]] = team["id"]
        print(f"team {t['name']}: code {team['code']}, {1 + len(t['members'])} devices")

    for who, c in clients.items():
        have = {m["text"] for m in c.get("/api/memories").json()}  # re-running only adds what's missing
        for text, level, team in NOTES.get(who, []):
            if text not in have:
                body = {"text": text, "sensitivity": level, **({"team_id": team_ids[team]} if team else {})}
                c.post("/api/memories", json=body).raise_for_status()
    sync_all(clients)
    for who, c in clients.items():
        mem = c.get("/api/memories").json()
        n = {k: sum(m["sensitivity"] == k for m in mem) for k in ("shareable", "private", "device")}
        print(f"{who:14} {len(mem):2} notes: {n['shareable']:2} team, {n['private']} private, {n['device']} this device"
              f" | audit ok: {c.get('/api/privacy/audit').json()['ok']}")


if __name__ == "__main__":
    main()
