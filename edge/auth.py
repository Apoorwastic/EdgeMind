"""Demo sign-in: one EdgeMind device per person, each behind a login.

A device started with ACCOUNT=<id> belongs to that person: its API answers only a browser whose session
cookie names that account. Everyone signs in at one address (edge/host.py): it checks
which account and device the session names and forwards each request to that device.

Accounts and passwords are demo values from deploy/demo.json (or EDGEMIND_ACCOUNTS, a JSON list). Set
AUTH_SECRET in production: the session cookie is signed with it, and the default is public.
"""
import hashlib
import hmac
import json
import os
import time

from pathlib import Path

DEMO_FILE = Path(os.getenv("EDGEMIND_DEMO", Path(__file__).resolve().parent.parent / "deploy" / "demo.json"))
SESSION_TTL = 30 * 24 * 3600  # a signed-in browser stays signed in for 30 days

_SECRET = (os.getenv("AUTH_SECRET") or "edgemind-demo-secret").encode()


def demo() -> dict:
    """deploy/demo.json: the demo's people, devices and teams (EDGEMIND_DEMO points elsewhere)."""
    return json.loads(DEMO_FILE.read_text(encoding="utf-8")) if DEMO_FILE.exists() else {}


def accounts() -> list[dict]:
    raw = os.getenv("EDGEMIND_ACCOUNTS")
    return json.loads(raw) if raw else demo().get("accounts", [])


def get(account_id: str | None) -> dict | None:
    return next((a for a in accounts() if a["id"] == account_id), None)


def check_password(username: str, password: str) -> dict | None:
    """The account for this name (its id or display name, any case) when the password matches."""
    u = username.strip().lower()
    acc = next((a for a in accounts() if u in (a["id"].lower(), a["name"].lower())), None)
    if acc and hmac.compare_digest(acc["password"].encode(), password.encode()):
        return acc
    return None


COOKIE = "em_session"  # one session for the whole site; it says which account and which of its devices


def sign(account_id: str, device_id: str, ttl: int) -> str:
    msg = f"{account_id}.{device_id}.{int(time.time()) + ttl}"
    return f"{msg}.{hmac.new(_SECRET, msg.encode(), hashlib.sha256).hexdigest()}"


def verify(token: str | None) -> dict | None:
    """{account, device} a token was issued for, if it's genuine and not expired."""
    try:
        account_id, device_id, exp, sig = (token or "").split(".")
    except ValueError:
        return None
    good = hmac.new(_SECRET, f"{account_id}.{device_id}.{exp}".encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(good, sig) or int(exp) < time.time():
        return None
    return {"account": account_id, "device": device_id}
