#!/usr/bin/env python3
"""Docker HEALTHCHECK for the STT WebSocket server.

Performs a REAL WebSocket handshake against the server and closes cleanly, so a
"healthy" result means the server actually ACCEPTS WebSocket connections — not
merely that the TCP port is open. (The previous bare TCP connect couldn't tell
the two apart and, worse, spammed the server logs with an "opening handshake
failed" traceback on every probe.) Exit 0 = handshake OK; exit 1 = any failure.
Uses the `websockets` lib the server already ships — no extra dependency.
"""
import asyncio
import os
import sys

import websockets

PORT = int(os.getenv("STT_PORT", "8300"))
URL = f"ws://127.0.0.1:{PORT}/stt"


async def _check() -> None:
    # asyncio.wait_for guards a hung / half-loaded server. Version-robust across
    # websockets 12 (legacy) and 13+ (asyncio) — connect(...) is awaitable in
    # both. A clean ws.close() ends the server-side handler without noise.
    ws = await asyncio.wait_for(websockets.connect(URL), timeout=4)
    await ws.close()


try:
    asyncio.run(_check())
except Exception as exc:  # any failure → unhealthy
    print(f"[healthcheck] WS handshake failed: {exc}", file=sys.stderr)
    sys.exit(1)
