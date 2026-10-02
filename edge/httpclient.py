"""HTTP clients that are cheap to create.

Building an httpx client loads the whole CA bundle into a new SSL context: ~0.5-0.8 s of CPU on the
event loop, every time. The connectivity probe did that every 1.5 s, which with many devices in one
process (edge/host.py) froze the loop long enough for requests to time out. The context is built once
per process here and shared by every client.
"""
import ssl

import certifi
import httpx

_ctx: ssl.SSLContext | None = None


def http_client(**kw) -> httpx.AsyncClient:
    global _ctx
    if _ctx is None:
        _ctx = ssl.create_default_context(cafile=certifi.where())
    return httpx.AsyncClient(verify=_ctx, **kw)
