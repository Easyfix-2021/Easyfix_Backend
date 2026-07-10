# EasyFix STT Sidecar (free / open-source, self-hosted)

Real-time speech-to-text for the **AI Teleprompter for Calls**. This is a **separate
deployable** — STT inference is CPU/GPU-heavy and must **never** run inside the shared
Node backend. The Node relay (`services/stt-engines/`) streams PCM16 to this service over
a WebSocket; it streams transcripts back.

$0 licence, no third-party account. Best free option for Indian languages:
**AI4Bharat IndicConformer** (MIT). This reference server ships with a **faster-whisper**
backend (easiest to run, CPU-capable) and documents swapping to IndicConformer for best
Hinglish accuracy.

## Protocol (must match `services/stt-engines/sidecar.engine.js`)

Client (Node) → sidecar:
1. On connect, one JSON text frame:
   `{ "type":"config", "provider":"indicconformer|vosk", "sampleRate":16000, "encoding":"pcm16le", "language":"hi|null" }`
2. Then **binary** frames: raw PCM16LE, 16 kHz, mono.
3. On end: `{ "type":"eof" }`, then close.

Sidecar → client (JSON text frames):
- `{ "type":"partial", "text":"…" }` — interim hypothesis
- `{ "type":"final",   "text":"…", "speaker":"agent|customer" }` — settled turn (speaker optional)
- `{ "type":"error",   "message":"…" }`

WebSocket ping/pong is used for liveness (the relay pings; respond with pong — the
`websockets` library does this automatically).

## Auto-start with the backend (dev/QA)

Instead of running this manually, set `STT_AUTOSTART=true` in the backend `.env` — the Node
server will spawn + supervise this sidecar on boot (model loads once; `STT_SERVICE_URL` is set
automatically once the model is ready). Tunables: `STT_SIDECAR_PORT`, `STT_MODEL`, `STT_PYTHON`.
You still need Python + the deps below installed. For prod, run it as its own service (below).

## Run (local, CPU, faster-whisper)

```bash
cd stt-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# small = fast on CPU; use medium/large-v3 on a GPU for accuracy
STT_MODEL=small STT_PORT=8300 python server.py
```

Then point the backend at it:
```
STT_SERVICE_URL=ws://localhost:8300/stt
```
(set `stt.provider=indicconformer` + `teleprompter.enabled=true` in easyfix_properties.)

## Docker

```bash
docker build -t easyfix-stt .
docker run -p 8300:8300 -e STT_MODEL=small easyfix-stt
```

## Swapping to AI4Bharat IndicConformer (best for Indian languages)

faster-whisper is the default because it runs anywhere. For best Hinglish/Indic accuracy
+ true word-level streaming, replace the transcription backend in `server.py` with
IndicConformer (MIT):

- **Turnkey**: [VEXYL-STT](https://medium.com/@anilmathewm/vexyl-stt-free-self-hosted-indian-language-speech-to-text-server-f2909003aaf6)
  wraps `ai4bharat/indic-conformer-600m-multilingual` behind a WebSocket that already
  accepts 16 kHz PCM — you can point `STT_SERVICE_URL` at it directly if its message
  shapes are adapted to the protocol above.
- **NeMo / sherpa-onnx**: load the IndicConformer checkpoint and use its RNNT decoder for
  streaming (~<100 ms). The 30M model is CPU-capable; the 600M model wants a GPU.

Keep the WebSocket protocol identical so no backend change is needed — only `stt.provider`
in easyfix_properties (sent in the config frame) changes.

## Scaling note

One CPU worker handles a handful of concurrent streams; a GPU handles more. For "hundreds
of concurrent calls" run a horizontally-scaled fleet behind a load balancer and set
`STT_SERVICE_URL` to the LB. This service is stateless per connection.
