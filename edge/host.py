"""Every demo device in one process, plus the one sign-in address for all accounts.

    python -m edge.host        # devices from deploy/demo.json on their own ports, sign-in on :8100

Each device is still a separate EdgeMind device — its own settings, Qdrant Edge shard, sync loop, vault
and port — loaded as its own copy of edge/app.py. What they share is the process: Python, the libraries
and the search model load once (~270 MB) instead of once per device, so ten people fit where two did.

The sign-in address (GATEWAY_PORT, 8100) serves the web app and answers the login page itself. Every
other /api/ request goes straight to the device the signed session names (an in-process call, so
streamed answers and live events pass through untouched). That device checks the session again.

EDGEMIND_DEVICES=id,id,… runs only those devices; DEMO_ACCOUNTS=0 runs only the open ones (no login);
DEMO_OPEN_DEVICES=0 runs only the accounts (what the deploy does). `--ports` prints the ports and exits.
"""
import asyncio
import importlib
import importlib.util
import json
import os
import sys
from http.cookies import SimpleCookie
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import auth
from . import config as config_mod

HERE = Path(__file__).resolve().parent
DIST = config_mod.ROOT / "web" / "dist"


def wanted_devices() -> list[dict]:
    devices = auth.demo().get("devices", [])
    if only := os.getenv("EDGEMIND_DEVICES"):
        keep = {x.strip() for x in only.split(",")}
        devices = [d for d in devices if d["id"] in keep]
    if os.getenv("DEMO_ACCOUNTS", "1") != "1":
        devices = [d for d in devices if not d.get("account")]
    if os.getenv("DEMO_OPEN_DEVICES", "1") != "1":  # the deploy runs only the accounts behind the sign-in page
        devices = [d for d in devices if d.get("account")]
    return devices


def ports(devices: list[dict]) -> list[int]:
    """Every port this host listens on: each device's, plus the sign-in address when accounts run."""
    out = [d["port"] for d in devices]
    if any(d.get("account") for d in devices):
        out.append(int(os.getenv("GATEWAY_PORT", "8100")))
    return out


def load_device(d: dict, data_root: Path):
    """A fresh copy of edge/app.py with this device's settings (config is re-read for each copy)."""
    os.environ.update({"DEVICE_ID": d["id"], "DEVICE_NAME": d["name"], "DEVICE_KIND": d.get("kind", "laptop"),
                       "PORT": str(d["port"]), "ACCOUNT": d.get("account") or "", "DATA_DIR": str(data_root / d["id"])})
    importlib.reload(config_mod)
    name = f"edge.app__{d['id']}"
    spec = importlib.util.spec_from_file_location(name, HERE / "app.py")
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = "edge"
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod.app


# ---------------------------------------------------------------- the sign-in address

def _json(data, status=200):
    return JSONResponse(data, status_code=status)


class Gateway:
    def __init__(self, devices: list[dict], apps: dict):
        self.devices = [d for d in devices if d.get("account")]  # only accounts sign in here
        self.apps = apps
        assets = [Mount("/assets", StaticFiles(directory=DIST / "assets"))] if (DIST / "assets").exists() else []
        self.web = Starlette(routes=[*assets, Route("/{path:path}", self.spa)])

    async def spa(self, request):
        f = DIST / request.path_params["path"]
        return FileResponse(f if request.path_params["path"] and f.is_file() else DIST / "index.html")

    def device_for(self, account: str, device_id: str | None) -> dict | None:
        mine = [d for d in self.devices if d["account"] == account]
        return next((d for d in mine if d["id"] == device_id), None) or (mine[0] if mine and not device_id else None)

    def session_device(self, scope) -> dict | None:
        raw = b"; ".join(v for k, v in scope.get("headers", []) if k == b"cookie").decode("latin-1")
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            return None
        s = auth.verify(jar[auth.COOKIE].value) if auth.COOKIE in jar else None
        return self.device_for(s["account"], s["device"]) if s else None

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":  # nothing to start here: the devices' own listeners run theirs
            while True:
                m = await receive()
                if m["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif m["type"] == "lifespan.shutdown":
                    return await send({"type": "lifespan.shutdown.complete"})
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/"):
            return await self.web(scope, receive, send)
        d = self.session_device(scope)

        if path == "/api/login" and scope["method"] == "POST":
            body = b""
            while True:
                m = await receive()
                body += m.get("body", b"")
                if not m.get("more_body"):
                    break
            try:
                req = json.loads(body or b"{}")
            except ValueError:
                req = {}
            acc = auth.check_password(str(req.get("username", "")), str(req.get("password", "")))
            d = acc and self.device_for(acc["id"], req.get("device"))
            if not d:
                return await _json({"detail": "Wrong name or password."}, 401)(scope, receive, send)
            sent = False

            async def replay():  # the device reads the same body (it checks the password and unlocks its vault)
                nonlocal sent
                if sent:
                    return await receive()
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await self.apps[d["id"]](scope, replay, send)

        if path == "/api/logout":
            resp = _json({"ok": True})
            resp.delete_cookie(auth.COOKIE, path="/")
            return await resp(scope, receive, send)

        if not d:
            if path == "/api/session":
                accts = [{"id": a["id"], "name": a["name"], "devices": [x["id"] for x in self.devices if x["account"] == a["id"]]}
                         for a in auth.accounts()]
                return await _json({
                    "required": True, "signed_in": False, "accounts": [a for a in accts if a["devices"]],
                    "demo": [{"id": a["id"], "name": a["name"], "password": a["password"]} for a in auth.accounts()]
                    if os.getenv("DEMO_HINTS", "1") == "1" else [],
                })(scope, receive, send)
            return await _json({"detail": "Sign in first."}, 401)(scope, receive, send)
        return await self.apps[d["id"]](scope, receive, send)


# ---------------------------------------------------------------- run

class _Server(uvicorn.Server):
    def install_signal_handlers(self) -> None:  # one process, many servers: the host handles Ctrl+C
        pass


def rss_mb() -> int | None:
    """This process's resident memory (Linux), for the deploy log."""
    try:
        for line in open("/proc/self/status"):
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) // 1024
    except OSError:
        return None


async def report_memory(every: float = 60) -> None:
    """Logs memory now and then, so a host that's near its limit shows it before it gets killed."""
    while (mb := rss_mb()) is not None:
        print(f"[edgemind] devices process memory: {mb} MB", flush=True)
        await asyncio.sleep(every)


async def main() -> None:
    if os.getenv("EDGEMIND_LOOP_DEBUG") == "1":  # log anything that holds the shared event loop > 0.1 s
        import logging
        logging.basicConfig(level=logging.WARNING)
        loop = asyncio.get_running_loop()
        loop.set_debug(True)
        loop.slow_callback_duration = 0.1
    data_root = Path(os.getenv("EDGEMIND_DATA") or config_mod._default_data_root())
    devices = wanted_devices()
    # Many devices on a small server: sync each one every 20 s rather than 8 (a note change still syncs
    # within ~1.5 s, edge/sync.py `soon`), so background syncing doesn't crowd out answering questions.
    if len(devices) > 2:
        os.environ.setdefault("SYNC_EVERY", "20")
    apps = {}
    for d in devices:
        apps[d["id"]] = load_device(d, data_root)
        print(f"[edgemind] {d['name']} ({d['id']}) on :{d['port']}" + (f" · account {d['account']}" if d.get("account") else ""), flush=True)
    # Keep idle connections open longer than the proxy in front does (Caddy: 2 min). Otherwise the server
    # closes a connection just as the proxy reuses it, and that request fails ("incomplete response").
    keep = int(os.getenv("KEEP_ALIVE_S", "130"))
    servers = [_Server(uvicorn.Config(apps[d["id"]], host="0.0.0.0", port=d["port"], log_level="warning",
                                      timeout_keep_alive=keep)) for d in devices]
    if any(d.get("account") for d in devices):
        port = int(os.getenv("GATEWAY_PORT", "8100"))
        servers.append(_Server(uvicorn.Config(Gateway(devices, apps), host="0.0.0.0", port=port, log_level="warning",
                                              timeout_keep_alive=keep)))
        print(f"[edgemind] sign-in for every account on :{port}", flush=True)
    await asyncio.gather(*(s.serve() for s in servers), report_memory())


if __name__ == "__main__":
    if "--ports" in sys.argv:  # for scripts that wait for the devices: print the ports and stop
        print(" ".join(map(str, ports(wanted_devices()))))
        sys.exit(0)
    if sys.platform == "win32":  # see edge/__main__.py: the Proactor loop can drop its listening socket
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
