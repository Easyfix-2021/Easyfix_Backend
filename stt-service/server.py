"""
EasyFix STT sidecar — reference WebSocket server (free / open-source, self-hosted).

Speaks the protocol in README.md: receives a JSON `config` frame, then binary PCM16LE
@16 kHz mono, and streams back JSON {type: partial|final, text}. Default backend is
faster-whisper (CPU-capable, easy to run); swap to AI4Bharat IndicConformer for best
Indic accuracy (see README). This is a REFERENCE to tune, not a tuned production build.

Env:
  STT_PORT   (default 8300)
  STT_HOST   (default 0.0.0.0)
  STT_MODEL  (faster-whisper model: tiny|base|small|medium|large-v3; default 'small')
  STT_DEVICE (cpu|cuda; default cpu)
  STT_COMPUTE(int8|int8_float16|float16; default int8 for CPU)
  STT_WINDOW_SEC (transcribe window; default 2.0)
"""

import asyncio
import json
import logging
import os
import numpy as np
import websockets
from websockets.exceptions import InvalidMessage
from faster_whisper import WhisperModel

# ── Quiet benign liveness-probe noise ───────────────────────────────────────
# The Docker/compose HEALTHCHECK (and any LB / k8s tcpSocket probe) opens a bare
# TCP connection to the port and closes it WITHOUT a WebSocket handshake, purely
# to confirm the port is listening. The `websockets` server logs each one as an
# ERROR with a full traceback ("opening handshake failed" → InvalidMessage /
# EOFError: connection closed while reading HTTP request line). That is expected
# probe traffic, not a real failure — drop it so genuine errors stay visible.
class _QuietProbeHandshakes(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        exc = record.exc_info[1] if record.exc_info else None
        if isinstance(exc, (InvalidMessage, EOFError)):
            return False
        return "opening handshake failed" not in record.getMessage()


logging.getLogger("websockets.server").addFilter(_QuietProbeHandshakes())

PORT = int(os.getenv("STT_PORT", "8300"))
HOST = os.getenv("STT_HOST", "0.0.0.0")
MODEL_NAME = os.getenv("STT_MODEL", "small")
DEVICE = os.getenv("STT_DEVICE", "cpu")
COMPUTE = os.getenv("STT_COMPUTE", "int8")
WINDOW_SEC = float(os.getenv("STT_WINDOW_SEC", "2.0"))
SAMPLE_RATE = 16000

print(f"[stt] loading faster-whisper '{MODEL_NAME}' device={DEVICE} compute={COMPUTE} …", flush=True)
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
print("[stt] model ready", flush=True)


def transcribe(pcm_f32, language):
    """Run the model on a mono float32 @16k window; return the joined text."""
    kwargs = {"beam_size": 1, "vad_filter": True}
    if language:
        kwargs["language"] = language
    segments, _ = model.transcribe(pcm_f32, **kwargs)
    return " ".join(s.text.strip() for s in segments).strip()


async def handle(ws):
    language = None
    window_bytes = int(WINDOW_SEC * SAMPLE_RATE) * 2  # int16 = 2 bytes/sample
    buf = bytearray()
    try:
        async for msg in ws:
            if isinstance(msg, (bytes, bytearray)):
                buf.extend(msg)
                # Chunked transcription: whenever a full window has accumulated, run
                # the model and emit a FINAL for that window, then reset. (IndicConformer
                # RNNT would instead stream word-by-word; see README.)
                while len(buf) >= window_bytes:
                    chunk = bytes(buf[:window_bytes])
                    del buf[:window_bytes]
                    pcm = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
                    text = await asyncio.get_event_loop().run_in_executor(None, transcribe, pcm, language)
                    if text:
                        await ws.send(json.dumps({"type": "final", "text": text}))
            else:
                # JSON control frame
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                if data.get("type") == "config":
                    language = data.get("language") or None
                    print(f"[stt] session config · provider={data.get('provider')} lang={language}", flush=True)
                elif data.get("type") == "eof":
                    # Flush any remainder as a final.
                    if len(buf) >= SAMPLE_RATE:  # at least ~0.5s
                        pcm = np.frombuffer(bytes(buf), dtype=np.int16).astype(np.float32) / 32768.0
                        buf.clear()
                        text = await asyncio.get_event_loop().run_in_executor(None, transcribe, pcm, language)
                        if text:
                            await ws.send(json.dumps({"type": "final", "text": text}))
                    break
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:  # never crash the server on one bad session
        try:
            await ws.send(json.dumps({"type": "error", "message": str(e)[:200]}))
        except Exception:
            pass


async def main():
    print(f"[stt] listening ws://{HOST}:{PORT}/stt", flush=True)
    async with websockets.serve(handle, HOST, PORT, max_size=2 ** 20, ping_interval=20):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    asyncio.run(main())
