# AI Teleprompter for Calls

A reusable, **multi-flow** framework that turns an Ops browser Plivo web-call into a
**guided, AI-assisted call**: a fixed on-screen question list whose highlight advances
automatically as the other party speaks (real-time STT + LLM), with post-call
transcription, AI coaching analysis, coverage scoring, and per-caller trend tracking —
all surfaced on **Settings → Call Analytics** as one filterable call list across flows.

**Flow #1 = Guided Verification Call** (New Technician Lead vetting). Future flows
(booking details, job reminders, …) plug into the same engine.

> **Everything is additive + flag-gated.** With `teleprompter.enabled=false` (default),
> no new code path is reachable and every existing flow (web-call, click-to-call,
> AI-calling POC, Call Analytics) behaves exactly as before.

---

## 1. Architecture

```
Ops → Easyfixer verification page → "Start Guided Call"
  → POST /admin/teleprompter/start {flow, efrId}
        · build the ordered question list from fetchDeepSkillCatalog()
        · INSERT tbl_teleprompter_session(status='calling', question_list_json)
        · return { sessionId, questionList }
  → FE places the EXISTING web call: placeWebCall({efrId}, {teleprompterSessionId, flow})
        → POST /admin/calls/web-start (stashes teleprompterSessionId on the dial)
Plivo answers → /api/public/plivo/web-answer:
        buildAnswerXml(number, { record, streamWssUrl })   ← streamWssUrl ONLY when
        the dial maps to a teleprompter session AND teleprompter.enabled
        = <Response>
            <Stream bidirectional="false" keepCallAlive="true"
                    contentType="audio/x-mulaw;rate=8000">wss://…/teleprompter-stream?t=JWT</Stream>
            <Dial …><Number>…</Number></Dial>       ← the human↔human bridge, unchanged
          </Response>
Plivo media ws → ai-voice-server upgrade (path /teleprompter-stream; JWT + hard cap)
        → teleprompter-relay: μ-law frames → muLawToPcm16k (worker pool) → OSS STT sidecar
        → STT finals → flow.decideNext(transcript) [Sophy] → next_question_id (persisted)
Browser polls GET /admin/teleprompter/:id (status, current/next, transcript, result)
Browser mic VAD (ops speaking) → POST /:id/promote → lock current + record asked-sequence
Hangup/stop → relay teardown → post-call queue:
        · coverage(askedSequence)  · mapTranscript → captured skills+areas
        · analyzeTranscript [Sophy] → coaching score → tbl_plivo_call_log.call_analysis
        · caller-scorecard rollup
Ops reviews captured skills+areas in the panel → Apply → existing option-mappings +
        serviceable-pincodes endpoints → verification page refetches.
```

The live audio path runs **in the shared unified backend** and follows the same
event-loop discipline as the AI-calling relay: near-zero CPU per frame (STT inference is
**out-of-process** in the sidecar; only the μ-law→PCM transcode runs, off-thread in the
worker pool), a hard concurrency cap at the ws upgrade, backpressure = drop, per-call
max-duration + idle reap + heartbeat, total try/caught error isolation, and durable
cross-replica state in `tbl_teleprompter_session`.

---

## 2. The teleprompter mechanic (current / next)

- The question list is **fixed and ordered** (built from the catalog). The UI shows every
  question; exactly one is **CURRENT** ("Ask now", locked) and one is **NEXT** ("Up next").
- The relay's STT feeds `flow.decideNext()` (Sophy, text), which updates **only the NEXT**
  suggestion (`next_question_id`) — never the current one.
- **Promotion** (next → current) fires when the Ops caller **starts reading** the next
  question, detected by **browser mic VAD**. It is gated on the AI having produced a fresh
  suggestion (i.e. the technician has answered), so it never jumps ahead while the current
  question is still being read. A **"Next" override** button is always available; if the
  STT sidecar is down (manual mode), the override is the advance mechanism.
- Every promotion appends `{id, ts}` to `asked_sequence_json` → the **coverage** score.

---

## 3. STT (speech-to-text) — free / open-source, self-hosted

**Sophy is text-only** (no audio/STT/TTS). STT is a **separate, self-hosted OSS sidecar**
— free ($0 licence), no third-party account, data stays in-house. There is **no free
managed real-time STT**; managed vendors (Deepgram/Sarvam/Google/OpenAI) are deliberately
excluded per the project constraint.

| Tool | Licence | Indian-lang fit | Real-time | Hardware | Notes |
|---|---|---|---|---|---|
| **AI4Bharat IndicConformer 30M** | MIT | Best (light), 22 langs + code-switch | Yes (RNNT, ~<100 ms, WS) | **CPU-capable** | **Default** (`stt.provider=indicconformer`). No GPU to start. |
| AI4Bharat IndicConformer 600M | MIT | Best overall | Yes | GPU | Accuracy upgrade at scale. |
| Vosk | Apache-2.0 | Fair | Yes | CPU (light) | Ultra-light fallback (`stt.provider=vosk`). |
| faster-whisper / WhisperLive | MIT | Good (Hinglish so-so) | Near-live | GPU preferred | Whisper-based alt. |

The Node side is provider-abstracted (`services/stt-engines/`): both providers talk to the
**same sidecar** over WebSocket; only the model the sidecar loads differs.

### Sidecar protocol (Node ⇄ STT service)
- Connect to `STT_SERVICE_URL` (e.g. `ws://stt:8300/stt`).
- Node → sidecar: first a JSON text frame
  `{ "type":"config", "provider":"indicconformer|vosk", "sampleRate":16000, "encoding":"pcm16le", "language":"hi|null" }`,
  then **binary** frames of raw PCM16LE @16 kHz mono (transcoded from Plivo μ-law by the
  worker pool), then `{ "type":"eof" }` on close.
- Sidecar → Node (JSON text): `{ "type":"partial", "text":"…" }`,
  `{ "type":"final", "text":"…", "speaker":"agent|customer?" }`, `{ "type":"error", "message":"…" }`.

A reference implementation lives in **`stt-service/`** (see its README). It is a **separate
deployable** — never run STT inference inside the Node process.

---

## 4. Flags & backward compatibility

| Flag (easyfix_properties) | Meaning | Default |
|---|---|---|
| `teleprompter.enabled` | Master on/off. OFF ⇒ routes 403, web-answer never forks, feature invisible. | `false` |
| `stt.provider` | `indicconformer` \| `vosk`. Live STT usable only if this + `STT_SERVICE_URL` are set; else **manual mode**. | `indicconformer` |
| `teleprompter.emails` | CSV allowlist of Ops emails who may launch guided calls (NOT RBAC-grantable). | `''` |

Env: `STT_SERVICE_URL` (sidecar ws URL), `SOPHY_API_KEY_TELEPROMPTER` (falls back to
`SOPHY_API_KEY_AI_CALLING`), `MAX_CONCURRENT_TELEPROMPTER` (50), `TELEPROMPTER_MAX_DURATION_SEC`
(1200), `TELEPROMPTER_IDLE_SEC` (60), `TELEPROMPTER_CONNECT_TIMEOUT_SEC` (120).

**STT sidecar lifecycle.** STT is mandatory. Run it one of two ways depending on environment:

- **Local (`npm run start` / `npm run dev`): auto-start in-process + auto-install deps.** Set
  `STT_AUTOSTART=true`. On boot the Node server (`services/stt-sidecar.service.js`) **auto-provisions a venv at
  `stt-service/.venv`** from `STT_PYTHON` (default `python3`) and `pip install`s `requirements.txt` into it if a
  dep is missing (`--only-binary=:all:`, so it fails fast on a Python with no wheels instead of a slow source
  build) — no manual pip step. It then spawns + supervises the sidecar: the model loads ONCE (not per call),
  `STT_SERVICE_URL` is advertised only after the model is ready (so `/start` refuses during warm-up), restarts
  on crash (cap 5), killed on shutdown. Only runs when `teleprompter.enabled` is also on. Tunables:
  `STT_SIDECAR_PORT` (8300), `STT_MODEL` (small), `STT_PYTHON`.
  **Requires a working Python 3.9–3.13 with wheels** — set `STT_PYTHON=python3.12`/`python3.13` if the default
  `python3` is a brand-new release (e.g. 3.14) without ML wheels, or is a broken Homebrew build
  (`brew reinstall python@3.13`). A missing/broken Python degrades cleanly (feature stays off, clear log hint).

- **Deployed (QA/Prod): a SEPARATE container.** The backend image is Node-only (Alpine/arm64 can't run
  faster-whisper), so the sidecar is its own container built from `stt-service/Dockerfile` (python-slim,
  arm64 wheels). It's in the docker-compose stack (`deploy/docker-compose*.yml`, service `stt`, port NOT
  host-published, model in a named volume) and deployed INDEPENDENTLY by `.github/workflows/deploy-stt.yml`
  (triggers only on `stt-service/**`; the backend `deploy.yml` `paths-ignore`s it). The backend is wired via
  compose env `STT_SERVICE_URL=ws://stt:8300/stt` and `STT_AUTOSTART=false` (no in-process spawn). **Provision
  once:** ECR repo `easyfix/stt` + secret `ECR_REPOSITORY_STT`, and ~0.5–1 GB EC2 RAM headroom for the model.
  - **Memory fence (`mem_limit`).** The `stt` service is capped so it can never balloon and OOM-kill the
    backend/UIs on a shared box (QA runs backend + 2 UIs + STT together; prod-BE runs backend + STT). The cap
    **auto-adjusts to each box's RAM**: `deploy-stt.yml` runs `free` on the target host, computes
    `STT_MEM_PERCENT`% (default **25%**) of total RAM, clamps to `[STT_MEM_MIN_MB, STT_MEM_MAX_MB]`
    (default **768–1536 MB**), and writes `STT_MEM_LIMIT=<n>m` into `/opt/easyfix/.env`; compose reads it as
    `mem_limit: ${STT_MEM_LIMIT:-1g}` (the `1g` fallback covers a first-boot before deploy-stt has run). Resize
    the instance → next deploy re-measures; no code change. Override the %/clamps via GitHub **Variables**
    (`STT_MEM_PERCENT` / `STT_MEM_MIN_MB` / `STT_MEM_MAX_MB`) — bump `STT_MEM_MAX_MB` if you swap to a bigger
    Whisper model. The clamps (not the %) are what protect co-tenants: the `small` model's footprint is fixed
    (~1 GB), so a raw % of a large box would over-allocate memory STT can't use.
  - **OOM priority — STT dies before the backend.** Two layers. (1) *Airtight:* STT's own `mem_limit` means an
    OOM inside STT is **cgroup-scoped** — the kernel kills a process in STT's cgroup, it cannot reach the
    backend. (2) *Global-pressure backstop:* `oom_score_adj` — `stt: 1000` (first victim), `backend: -500` (last
    **container** the kernel picks) — so if the whole box exhausts RAM, STT is chosen over the backend. We use
    **-500, not the -1000 floor**: at -1000 the backend is effectively unkillable, so a *backend-originated*
    leak would make the kernel kill `sshd`/`ssm-agent` first and leave the box unrecoverable (no way in to
    deploy a fix). -500 still deprioritizes the backend below every other container while letting the kernel
    reclaim it before a total stall. The only way to fully shield the management plane from a backend leak is
    to also cap the backend's memory (deliberately not done — the backend is left unbounded by design).
  - **OOM alerting (email).** A tiny `stt-oom-watch` sidecar (Docker socket mounted **read-only** — same trust
    model as Dozzle) watches `easyfix-stt` for an `oom` event (or a `die` with `State.OOMKilled=true`) and POSTs
    `POST /api/webhook/stt-oom` on the backend. The webhook (auth: shared `STT_OOM_WEBHOOK_KEY` header, injected
    into both containers from `/opt/easyfix/.env`) emails the recipients in
    `easyfix_properties('teleprompter.stt.alert.emails')` via Microsoft Graph (`services/email.service`),
    rate-limited per container (10-min cooldown). **Inert by default:** unset key **or** empty recipients ⇒
    silent no-op. **Provision:** add `STT_OOM_WEBHOOK_KEY=<random>` to `/opt/easyfix/.env` (NOT `backend.env` —
    the compose `environment:` block overrides `env_file`) and set the recipients property.
  - **Flag scope (honest statement).** `teleprompter.enabled` gates all *request-path* behavior (guided calls,
    the `<Stream>` fork, admin routes, alert emails). It does **not** gate container residency: once the STT
    image is deployed, `stt` (~0.5–1 GB resident for the model) and `stt-oom-watch` run 24/7 regardless of the
    flag. They are fenced (`mem_limit` + `oom_score_adj`) so they can't harm the backend, but "flag off ⇒ zero
    new processes" holds only until you deploy the STT image. To make the sidecars themselves flag-gated, put
    them behind a Compose `profiles:` and enable that profile only when the teleprompter is on.

Flip live with `setProperty` (no redeploy). FE flag delivered via `GET /admin/access/features`
→ `canRunTeleprompter`.

---

## 5. Data model (EasyFix-owned)

- **`tbl_teleprompter_session`** — one row per guided call. `question_list_json`,
  `current_question_id`, `next_question_id`, `asked_sequence_json`, `transcript`,
  `captured_result_json`, `coverage_json`, `status` (`calling → streaming → processing →
  done|failed`), `call_uuid` (links to `tbl_plivo_call_log`).
- **`tbl_caller_score_rollup`** — per-caller (`caller_user_id`, `call_flow`) aggregate:
  `avg_overall`, `avg_coverage`, `avg_dimensions_json`, `trend_json`, `calls_count`.
- **`tbl_plivo_call_log`** (reused) — the unified per-call record; `call_flow` tags the flow,
  `call_analysis` holds the coaching score (written by the post-call step, matched by
  `call_uuid`), so the Call Analytics list + scorecard treat teleprompter calls like any call.

Migrations: `migrations/2026-07-09-create-tbl-teleprompter-session.sql`,
`migrations/2026-07-09-create-tbl-caller-score-rollup.sql`.

---

## 6. Backend map

| File | Role |
|---|---|
| `services/teleprompter.service.js` | session store + token + concurrency cap + coverage |
| `services/teleprompter-flows.js` | flow registry (`guided_verification`: buildQuestionList / decideNext / mapResult / coverage) |
| `services/teleprompter-relay.service.js` | per-call media relay: `<Stream>` → STT → next-question + transcript |
| `services/stt-engines/` | STT provider abstraction (`sidecar.engine.js` + registry) |
| `services/teleprompter-postcall.service.js` | coverage + mapping + coaching analysis + scorecard |
| `services/caller-scorecard.service.js` | per-caller rollup + list |
| `services/teleprompter-bus.js` | in-process pub/sub (reserved for a future SSE fast-path) |
| `routes/admin/teleprompter.js` | `POST /start`, `GET /:id`, `POST /:id/promote` |
| `services/ai-voice-server.service.js` | ws upgrade — adds path `/teleprompter-stream` |
| `routes/public/plivo-answer.js` | `webAnswer` appends the `<Stream>` for teleprompter dials |
| `routes/admin/calls.js` | list adds Flow + Score + filters; `GET /scorecard` |

Reused as-is: `fetchDeepSkillCatalog`, `mapTranscript` (ai-profile-extract),
`searchPincodes`/`ensurePincode`, `replaceOptionMappings`/`replaceServiceablePincodes`,
`call-analysis.service`, `sophy.service`, `ai-post-call-queue`, `audio-transcode-pool`.

---

## 7. How to add a new flow

Add ONE entry to `services/teleprompter-flows.js`:

```js
booking_details: {
  id: 'booking_details', label: 'Booking Details', targetType: 'job',
  preload: async ({ targetId }, pool) => ({ /* known context for the greeting */ }),
  buildQuestionList: (catalog, ctx) => [ { id, text, type, required, meta }, … ],
  decideNext: async ({ transcript, questionList, askedIds, currentId }) => '<id|null>',
  mapResult: (transcript, pool) => require('./ai-booking-extract.service')
    .mapTranscript(transcript, pool, { apiKey: process.env.SOPHY_API_KEY_TELEPROMPTER }),
  coverage: (asked, list) => require('./teleprompter.service').computeCoverage(asked, list),
},
```

No engine / relay / route / schema changes — `tbl_teleprompter_session.flow` selects which
flow runs, and the call is tagged `call_flow` so it appears (filterable) on Call Analytics.

---

## 8. Verify end-to-end

1. Run both migrations. Start the STT sidecar (`STT_SERVICE_URL`). Set
   `teleprompter.enabled=true`, `stt.provider=indicconformer`, add your email to
   `teleprompter.emails`; web-call mode on (`voice.call.mode=web`, `plivo.calling.enabled=true`). Restart.
2. Registered Easyfixers → a New Technician Lead → verification page → **Start Guided Call**
   → answer on your phone.
3. Read the highlighted question; as you voice the technician's answers, the **next** highlight
   moves while **current** stays locked; ops speech promotes; asked-sequence records.
   (Disable the sidecar → confirm the call still works in manual mode via the Next override.)
4. Hang up → coverage + captured skills/areas appear → Apply To Profile → the verification
   mapping sections show the applied data.
5. Settings → Call Analytics → the call shows with Caller / Receiver / **Flow** / **Score**,
   filterable, latest→oldest; the Per-Caller Scorecard tab shows the trend.
6. Regression: with `teleprompter.enabled=false`, the button is gone and every existing
   call flow + Call Analytics behaves exactly as before.

### Known Phase-1 caveats
- **Mixed-stream STT**: the `<Stream>` forks the bridged (mixed) audio; speaker separation
  relies on the script + LLM disambiguation. True dual-channel diarization is a Phase-2 item.
- **Mic VAD** promotion is best-effort (browser-dependent, alongside the Plivo SDK mic); the
  **Next override** guarantees advance. Not live-verified in every browser.
- **In-process dial stash + concurrency counter** are single-replica (same caveat as the
  existing web-call); multi-replica needs Redis / sticky routing.
- Applying captured skills uses `replaceOptionMappings` (full replace) — intended for a new
  lead; review the checkboxes before Apply.
