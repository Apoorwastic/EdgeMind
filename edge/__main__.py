import sys

import uvicorn

from .config import settings

# On Windows uvicorn defaults to the Proactor loop, whose accept loop permanently closes the listening
# socket after a client aborts mid-handshake (WinError 64) — the process stays alive but stops serving.
# The Selector loop doesn't have that failure mode, and EdgeMind never spawns subprocesses.
loop = "asyncio:SelectorEventLoop" if sys.platform == "win32" else "auto"

uvicorn.run("edge.app:app", host="0.0.0.0", port=settings.port, log_level="warning", loop=loop, timeout_keep_alive=130)
