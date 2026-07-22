# Switchable Call Transcription: Plivo ⇄ Gemini (PLAN — not yet built)

> **Status:** plan only, awaiting review. Nothing in this document is implemented.
> **Decision already taken:** Gemini is called **DIRECTLY** (Google AI Studio REST),
> **NOT** through Sophy. See §1 — this is forced, not a preference.

---

## 1. Why NOT Sophy (settled — do not revisit without new information)

Sophy is Channelplay's central OpenAI-compatible LLM gateway and is the correct
home for *text* reasoning. It **cannot** carry transcription:

- **It is text-only, by design.** `services/sophy.service.js:16` states it
  outright: *"Sophy is TEXT-ONLY — no realtime / audio / STT / TTS."* The request
  body is `messages: [{ role: 'user', content }]` where `content` is a **plain
  string** (`sophy.service.js:63`) — there is no multimodal `parts` array, so
  there is physically nowhere to attach audio bytes.
- **We don't choose the model.** `sophy.service.js:4-5`: *"the `mw_live_…` key
  carries that config; the `model` we send is ignored."* The model is a
  key-level setting on Sophy's side. So even a Gemini-backed Sophy key yields a
  **text** endpoint that cannot accept an MP3 — provisioning a key does not
  unblock this.
- **Precedent, twice over.** The AI-calling voice leg already bypasses Sophy and
  hits OpenAI Realtime directly for exactly this reason (`sophy.service.js:16-18`).
  And CRS — the one Channelplay team already doing Gemini transcription — calls
  `generativelanguage.googleapis.com` **directly** with its own `gemini.api.key`,
  not via Sophy.

**Split that stands after this work:** audio → Gemini direct; text reasoning
(the existing call-coaching analysis) → Sophy, unchanged. This respects Sophy's
charter rather than pretending it can do STT.

⚠ **Consequence to accept explicitly:** transcription then sits outside Sophy's
central quota/cost/model control, and call transcripts are **customer PII** — a
new API key means a **new data processor**. Retention/DPA review applies before
Production.

---

## 2. Reference implementation — CRS (copy this, with the fixes in §5)

**The transcriber is in `legacy-microservices`, NOT `recruiter-microservices`.**
This trips people up: `recruiter-microservices/.../GeminiAnalysisService.java`
also calls Gemini but takes a **finished transcript as a String** (`callTranscript`
param, `buildFullPrompt` :292) and emits a screening report. **It is not a
transcriber — do not port it.**

| Concern | CRS location |
|---|---|
| The Gemini call | `Microservices/legacy-microservices/.../services/PlivoServiceImpl.java` → `transcribeFromUrl()` **:701–812** |
| Audio download | same file → `downloadAudioFile()` **:818–850** |
| Persistence | `saveTranscriptionData()` **:465–521** |
| Model resolution | `getGeminiTranscriptionModel()` **:678–680** |
| Trigger | `PlivoController.java` → `fetchAndSaveTranscription()` **:354–416**, hangup hook **:328** |
| Table | `TranscriptionData.java` → `channelplay_office_recruitment.transcription_data` |

### 2.1 Endpoint (verbatim, `PlivoServiceImpl.java:724-725`)
```java
String apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/"
        + model + ":generateContent?key=" + geminiApiKey;
```
Google **AI Studio REST** — not Vertex AI, **no SDK** (the code comment at :699
notes "No SDK dependency required"). The API key is a **`?key=` query param**,
not a header.

### 2.2 Model — runtime-switchable, NOT pinned in code
```java
private String getGeminiTranscriptionModel() {
    return getPropertyFromDb("transcription.gemini.model", geminiModelDefault);
}
```
Resolution order: DB property → `@Value("${gemini.model}")` fallback (no inline
default; the bean fails if unsupplied).

⚠ **CRS's own hints disagree** and its real value lives outside git: the Javadoc
(:683) says *"Gemini 2.5 Flash"*, while `application-local.yml.example:249` says
`gemini-1.5-flash`. **Do NOT inherit either.** Pick a current model id at
implementation time, verified against Google's docs that day, and put it in the
DB property so it changes without a redeploy.

### 2.3 Audio → model (verbatim, `PlivoServiceImpl.java:752-757`)
```java
JSONObject inlineData = new JSONObject();
inlineData.put("mimeType", "audio/wav"); // Plivo typically provides WAV format
inlineData.put("data", base64Audio);
audioPart.put("inlineData", inlineData);
parts.put(audioPart);
```
- `inlineData` is **camelCase** (not `inline_data`). Not the Files API, not a `fileUri`.
- Request shape: `contents[0].parts = [ {text: prompt}, {inlineData: {...}} ]` — **text part first**.
- **No `generationConfig` at all** on the transcription request.
- Audio bytes come from Plivo over **Basic Auth** (`downloadAudioFile()` :818-850) — S3 is not the source in CRS.

### 2.4 The prompt (CRS, `PlivoServiceImpl.java:734-743`)
Multilingual, tuned for Indian call audio. Reuse essentially as-is:
> Produce a precise transcript of this call using the rules below so the output is
> clear and accurate. The audio may include Hindi, Tamil, Telugu, Kannada,
> Malayalam, Bengali, Marathi, Gujarati, Punjabi, English or a mix of languages.
> Rules: (1) non-Hindi → natural English, original in brackets where it preserves
> nuance; (2) Hindi stays in Hindi script; (3) English exactly as spoken; …

### 2.5 Trigger
Plivo hangup webhook → async on `webhookExecutor` (`PlivoController.java:325-328`),
`Thread.sleep(3000)` then up to 3 recording-lookup attempts 2s apart. **No cron.**
Idempotency via `findByRecruitmentCallHistoryId` (:496-502).

---

## 3. What EasyFix has today

- **Transcript store:** `tbl_plivo_call_log.transcription` + `transcription_status`
  + `transcription_fetched_at`. Column-probed (`hasTranscriptionColumn`, `calls.js:738`).
- **Status values (bare string literals in 3 files — no constants):**
  `NULL` (never attempted — the only state a request may start from) ·
  `'processing'` · `'completed'` · `'not_available'` (terminal).
- **Three entry points, all inlining the same logic:**
  1. lazy-on-play — `calls.js:943` `storeTranscriptionBestEffort` (fire-and-forget)
  2. on-demand — `calls.js:991` `fetchTranscriptOnDemand`, **inside the request path** for `GET /:id/analysis`
  3. cron — `*/30 * * * *`, `call-transcription-cron.js:53-107`
- **Flag:** `plivo.transcription.enabled` (`plivo.service.js:52`), read in 4 places
  incl. **cron registration at boot** (`scheduler.js:707`) → **restart required**.
- **Audio:** `tbl_job_caller_info.recording` holds an S3 key (`CallRecordings/…`);
  `tbl_plivo_call_log.recording_url` holds the Plivo URL. **Different tables.**
- **Downstream:** `callAnalysis.analyzeTranscript(transcript)` takes a **plain
  string** → already provider-agnostic, needs **zero change**.

---

## 4. The design

### 4.1 There is no seam today — that's the core work
No function takes a recording and returns transcript text. `fetchTranscription`
and `createTranscription` are each *half* the operation and both are keyed on
`recordingId` — a **Plivo-internal handle** that cannot be handed to Gemini.
**So the seam must be drawn in the currency of AUDIO, not provider ids.**

This block is triplicated across `calls.js:776-813`, `calls.js:820-850`,
`call-transcription-cron.js:53-107`:
```
1. resolve recordingId → 2. GET transcript → 3. if none and status NULL: POST, mark
   'processing' | 'not_available' → 4. if text: store, mark 'completed'
```
Per `feedback_easyfix_no_route_duplication`, this is the textbook extract case.

### 4.2 Proposed shape (mirrors the existing `voice.service.js` provider factory)
```
services/transcription.service.js                  ← provider-neutral façade
services/transcription-providers/plivo.adapter.js  ← wraps the existing pair
services/transcription-providers/gemini.adapter.js ← NEW
services/call-recording.service.js                 ← promoted ensureRecordingInS3
```

**Adapter interface (the provider boundary):**
```
getTranscript({ recordingId, recordingUrl, s3Key, callUuid })
  → { ok, text, notAvailable, pending, notEnabled }
```
- **Plivo adapter** — GET; on 404 → POST → `{ pending: true }`; 402/403 → `{ notEnabled: true }`. Consumes `recordingId`.
- **Gemini adapter** — consumes `s3Key`/`recordingUrl`, returns `{ ok, text }` **synchronously**; **never** `pending`.

**Orchestrator (replaces all three call sites):**
```
transcription.ensureTranscript({ jobCallerInfoId, callUuid, recordingId?, currentStatus })
  → { text | null, status }
```
Owns: the flag/provider read, the status state machine, the DB write, and the
`< 10` chars "too short" threshold (currently duplicated at `calls.js:990`,
`calls.js:994`, `call-analysis.service.js:59`).

**Audio supply:** promote `ensureRecordingInS3` (`call-metrics-cron.js:21-34`,
currently private to that cron) into a shared service. It already does
recording→S3-key with a Plivo fetch on miss — exactly what an audio-consuming
provider needs. `calls.js:930-939` duplicates it today; a third copy would be wrong.

### 4.3 Config
| Key | Where | Purpose |
|---|---|---|
| `voice.transcription.provider` | `easyfix_properties` | `'plivo'` \| `'gemini'`. **Fail closed** when unset (per `feedback_easyfix_property_gated_features`). Mirror `POST /default-provider` (`calls.js:644-657`) for the admin setter. |
| `transcription.gemini.model` | `easyfix_properties` | Model id — changeable with no redeploy (CRS's pattern). |
| `plivo.transcription.enabled` | `easyfix_properties` | Kept as the **Plivo sub-gate**. |
| `GEMINI_API_KEY` | env | Local / QA / Prod. |

The existing flag is named for the **provider**, not the capability — hence the
new `voice.transcription.provider` above it.

---

## 5. Traps (each one is a real bug if ignored)

1. **⚠ mimeType.** CRS hardcodes `audio/wav` because Plivo hands *it* WAV. **EasyFix
   records `fileFormat="mp3"`** (`plivo.service.js:212-213`) and S3-caches as
   `audio/mpeg`. A blind port sends MP3 bytes labelled WAV. Send the **actual**
   content type.
2. **⚠ Stereo + payload size.** We record `recordChannelType="stereo"`
   (ch0=agent, ch1=customer — load-bearing for AWS Call Analytics, see
   `project_easyfix_plivo_stereo_channels`). Stereo **doubles** the bytes, and
   inline base64 has a hard request-size ceiling. A long stereo call **will**
   exceed it → use the Files API, or downmix **for the transcript request only**.
   **Never** switch recording to mono to suit a transcript provider.
3. **⚠ `'processing'` is Plivo-shaped.** It exists only because Plivo is
   request-then-poll. Gemini is synchronous and must be allowed `NULL → 'completed'`
   in one hop. Do not force it into the poll state.
4. **⚠ `'not_available'` is terminal and poisons the row** — every path skips it
   (`call-transcription-cron.js:41`). Rows marked so by Plivo's missing add-on
   (402/403) will **never** retry under Gemini. Needs a one-shot reset migration:
   `UPDATE tbl_plivo_call_log SET transcription_status = NULL WHERE transcription_status = 'not_available'`.
   (Precedent: `calls.js:791-796` documents a prior bug of exactly this shape.)
5. **⚠ Cron hardcodes `WHERE jci.provider = 'plivo'`** (`call-transcription-cron.js:36`)
   — relax it, or Gemini only ever sees Plivo-placed calls.
6. **⚠ Boot-time gating.** Cron registration is decided once at start
   (`scheduler.js:707`) → flipping the provider needs a **restart** + property
   cache bust (`project_easyfix_lookup_cache_invalidation`).
7. **⚠ On-demand path is synchronous** (`calls.js:991`, inside `GET /:id/analysis`).
   Plivo's 8s timeout exists for that reason. The Gemini adapter **must** keep a
   bounded timeout or the endpoint hangs — a base64 upload of a long call is slow.
8. **Doc drift to fix in passing:** `scheduler.js:694` claims "last 7 days" but
   `call-transcription-cron.js` has **no date bound** (the sibling metrics cron does).
9. **Table naming.** The transcript lives on the Plivo-named `tbl_plivo_call_log`.
   A non-Plivo provider writing there is odd but acceptable; renaming is out of scope.

---

## 6. Work list

1. `services/transcription.service.js` + `transcription-providers/plivo.adapter.js`;
   move the triplicated block in; add a `TRANSCRIPTION_STATUS` constants object.
2. Promote `ensureRecordingInS3` → `services/call-recording.service.js`; repoint
   `calls.js:930-939` + the metrics cron.
3. `transcription-providers/gemini.adapter.js` — direct REST, actual mimeType,
   size/timeout handling per §5.
4. `voice.transcription.provider` + `transcription.gemini.model` properties + admin setter.
5. Repoint the 3 call sites (`calls.js:943`, `calls.js:991`, cron `:53-107`);
   relax the cron's provider filter.
6. Migration: seed the properties; one-shot `not_available` reset (§5.4).
7. Tests: adapter selection, `NULL → completed` in one hop, the fail-closed gate.
8. **Leave `analyzeTranscript(string)` alone** — already provider-agnostic.

## 7. Open questions for review

1. **Model id** — pin which Gemini model at build time (verify against Google's
   docs that day; do **not** inherit CRS's stale `gemini-1.5-flash`).
2. **Stereo audio** — Files API, or downmix-for-transcript? (§5.2)
3. **Backfill** — re-transcribe existing `'completed'` Plivo transcripts with
   Gemini (accuracy was the whole motivation), or Gemini for new calls only?
4. **PII / DPA** — sign-off for sending customer call audio to Google.
