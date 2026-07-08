# AI Calling — Engine Comparison (GPT vs Gemini)

_Last researched: July 2026. Model IDs + prices for realtime/preview models move fast —
re-confirm the exact rows on the provider pricing pages before committing to a cost model._

The AI-calling feature runs on a selectable **engine**, switchable via `easyfix_properties`
(`ai.calling.engine` = `gemini` | `openai`, **default `gemini`**) and the Validate-Flows engine
dropdown. Both engines drive the same Plivo `<Stream>` telephony leg, the same flow registry,
and the same post-call mapping; they differ only in which model powers the live conversation.

| Engine | Live conversation | Heavy reasoning (map / route) | Providers |
|---|---|---|---|
| **Gemini** (default) | Gemini Live **`gemini-3.1-flash-live-preview`** — native audio, PCM only | `gemini-2.5-flash` (text) | Google |
| **GPT** | OpenAI Realtime `gpt-realtime-2.1` — μ-law native | `gpt-4.1` (text, via Sophy) | OpenAI (+ Sophy) |

> **Chosen Gemini model: `gemini-3.1-flash-live-preview`.** See §7 — we **pre-load the
> technician's context** into the agent brief, so no mid-call lookups (async tools) are needed;
> that removes 2.5's advantage and lets 3.1's **lower latency + fluent voice** win. Emotion
> *detection* is done post-call on the transcript. `GEMINI_LIVE_MODEL` switches to
> `gemini-2.5-flash-native-audio` for affective dialog + async in-call tools if ever needed.

---

## 1. The decisive architectural difference — telephony audio format

Plivo streams **G.711 μ-law @ 8 kHz**.

| | OpenAI Realtime | Gemini Live (2.5 NA & 3.1 FL) |
|---|---|---|
| Input audio | `pcm16` **and `g711_ulaw`/`pcmu`** + `pcma` | **raw 16-bit PCM only** (16 kHz in / 24 kHz out) |
| Telephony μ-law | **Native passthrough — ZERO transcode** | **Not supported → must transcode** μ-law8k ↔ PCM16 every frame |
| Also offers | WebRTC, WebSocket, **SIP** | WebSocket (BidiGenerateContent) |

- **GPT engine:** μ-law rides straight through (`audio/pcmu`) — zero-CPU passthrough.
- **Gemini engine:** every 20 ms frame needs **μ-law decode + resample 8k→16k** in, and
  **resample 24k→8k + μ-law encode** out. We do this in a **worker-thread pool**
  (`services/audio-transcode-pool.js` + `workers/mulaw-pcm.worker.js`) with transferable buffers,
  so the shared event loop stays free even at hundreds of concurrent calls. Naive inline
  transcoding is reported "choppy" with "unnecessary noise" — the worker + proper resampler
  avoids that. ([G.711 feature-request thread](https://discuss.ai.google.dev/t/live-api-support-for-mulaw-g711-ulaw-input-output/86053))

---

## 2. Cost (per 1M tokens)

### Live / audio models

| | Audio in | Audio out | Text in | Text out | Cached audio in |
|---|---|---|---|---|---|
| **OpenAI `gpt-realtime-2.1`** | $32.00 | $64.00 | $4.00 | $24.00 | $0.40 |
| OpenAI `gpt-realtime-2.1-mini` | $10.00 | $20.00 | $0.60 | $2.40 | $0.30 |
| **Gemini `gemini-3.1-flash-live-preview`** (chosen) | **$3.00** | **$12.00** | $0.75 | $4.50 | — |
| Gemini `gemini-2.5-flash-native-audio` | $3.00 | $12.00 | $0.50 | $2.00 | — |

**The two Gemini Live models have identical audio pricing ($3/$12).** Audio is ~99% of a
call's cost, so 3.1's slightly higher *text* price is immaterial. Gemini audio is ~5–10× cheaper
than OpenAI's flagship realtime.

### Text mapper (the post-call reasoning pass — tiny, ~$0.002–0.01/call either way)

| | Input | Output |
|---|---|---|
| `gpt-4.1` (GPT engine) | $2.00 | $8.00 |
| `gemini-2.5-flash` (Gemini engine) | $0.30 | $2.50 |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 |

### Blended cost of one ~3-min call (≈50/50 split + one mapping pass)

| Engine | Naive list | Real-world (context re-billed per turn) |
|---|---|---|
| **Gemini (3.1)** | ~$0.04 | **~$0.04–0.15** |
| **GPT** | ~$0.16 | **~$0.16–1.40** (cached ~$0.16–0.31) |

**At 1,000 calls/day × 3 min:** Gemini ≈ **$1.2k–4.5k/mo** (+ transcode CPU); GPT ≈ **$5k–42k/mo**.
Audio tokenization: OpenAI ~600 in / ~1,200 out tok/min; Gemini 32 in / 25 out tok/sec.

---

## 3. Specs

| Spec | OpenAI `gpt-realtime-2.1` | Gemini `2.5-flash-native-audio` | Gemini `3.1-flash-live` |
|---|---|---|---|
| Architecture | Native speech-to-speech | Native audio-to-audio | Native audio-to-audio (newer) |
| Telephony μ-law | ✅ native | ❌ transcode | ❌ transcode |
| In-session tools | ✅ (+MCP; long calls don't stall) | ✅ **async** (`NON_BLOCKING`) | ✅ sequential; **90.8% ComplexFuncBench-Audio** |
| Max audio session | 60 min | 15 min | 15 min |
| Context | 32k / 4k | 131k / 8k | 131k / 8k |
| Voices / languages | 70+ langs, Hindi listed | **30 HD voices, 24 langs**, affective + proactive audio | acoustic-nuance (pitch/pace); **no** affective/proactive yet |
| Maturity | **GA** | Preview | Preview (newer) |
| Latency reasoning control | — | — | `thinkingLevel` (default `minimal` = lowest latency) |

---

## 4. Performance & latency

| | OpenAI Realtime | Gemini 2.5 NA | Gemini 3.1 FL |
|---|---|---|---|
| Time-to-first-audio | ~500 ms API / ~800 ms v2v (`-2.1` cut ~25%) | ~320–800 ms (community) | **Lowest of the Gemini pair** — "fewer awkward pauses," `thinkingLevel:minimal` default |
| Voice naturalness | High | High, expressive/affective | **Highest** — better pitch/pace acoustic nuance, "more fluid and natural" |
| Long-session latency | stable | can creep up | improved vs 2.5 |

_(Latency numbers are official-ish for OpenAI and community-measured for Gemini — no Google SLA.
A/B on real Hindi/Hinglish technician calls before locking a default.)_

---

## 5. Languages (Hindi / Hinglish)

All three are **best-effort** multilingual with Hindi support and **no official quality
benchmark** — OpenAI 70+ langs, Gemini 2.5 NA 24 langs (30 HD voices), 3.1 FL native
audio-to-audio. **A/B test Hindi on real calls before committing.**

---

## 6. Operational maturity & build effort on our stack

| | GPT engine | Gemini engine |
|---|---|---|
| Model maturity | **GA** | Preview (all Gemini Live audio models) |
| Already built | Relay written + GA-migrated; μ-law passthrough | New engine + μ-law↔PCM worker transcoder |
| Text path | `gpt-4.1` via Sophy (⚠ superseded by GPT-5.x, still callable) | `gemini-2.5-flash` (direct or via Sophy) |
| New moving parts | none | Google API key, transcode worker pool, preview-model tracking |

---

## 7. Why we chose **Gemini 3.1 Flash Live** over 2.5 Native Audio (and over OpenAI)

The choice hinges on ONE design decision: **do we fetch data mid-call, or pre-load it?**

We **pre-load the technician's context** (name, registration status; extensible to their existing
skills/areas) into the agent's brief at call start — we know the `efrId` before dialing, so the
agent can open relevantly ("Hi Rahul — calling from EasyFix to quickly update your work profile…")
with **zero mid-call lookups**. That single decision cascades:

| Factor | Winner | Why (given we pre-load) |
|---|---|---|
| **Async function calling** | **moot** | 2.5's `NON_BLOCKING` async tools only matter if the agent looks things up *while talking*. With context pre-loaded, there are no in-call lookups → 2.5's headline advantage disappears. (Anything new the caller says is mapped **post-call**.) |
| **Latency** | **3.1** | Lower base TTFA, `thinkingLevel:minimal`, "fewer awkward pauses." Latency is a **universal** naturalness factor — long pauses hurt *every* call. |
| **Prosody / fluency** | **3.1** | Edges 2.5 on pitch/pace — "more fluid and natural." |
| **Cost** | tie | Audio pricing **identical** ($3/$12); audio ≈ 99% of call cost. |
| **Emotion-adaptive (affective) dialog** | 2.5 | 2.5-only. But it's *real-time tone mirroring*, which matters most on **emotional** calls; for short, cooperative technician-intake calls its marginal value is low. And emotion **detection** (abusive/unfriendly → flag) is done cheaply **post-call** on the transcript (the mapping pass can emit a sentiment flag). |
| **Proactive audio ("always-listening")** | 2.5 (n/a) | An *ambient-device* feature (ignore non-directed speech). A 1:1 call wants the agent to always respond; turn-taking is VAD + barge-in, which both models do. |

**Verdict:** because we pre-load context, we don't need async in-call tools — and once that's off
the table, **latency (a universal naturalness factor) beats affective dialog (a situational one)**
for transactional intake calls. So **`gemini-3.1-flash-live-preview` is the default**.
`GEMINI_LIVE_MODEL` switches to `gemini-2.5-flash-native-audio` (which auto-enables affective
dialog) if these calls turn out emotionally charged or we later add dynamic in-call tool lookups.

**Why Gemini over OpenAI as the default engine:** ~5–10× cheaper audio at ~identical
conversational quality, and our calls are short (well under the 15-min cap). We keep the **GPT
engine** as a switchable fallback because it's GA and **telephony-native (zero transcode)** — the
safer choice if the μ-law transcode ever becomes a bottleneck at extreme concurrency, or if Hindi
quality favors OpenAI in A/B testing.

---

## 8. Switchable design (implementation)

- **`easyfix_properties`**: `ai.calling.engine` (default `gemini`). Per-call override from the
  Validate-Flows engine dropdown.
- **`tbl_ai_call_session.engine`** column (additive migration) so the relay knows which provider
  to dial for that session.
- **Engine interface** (`services/ai-voice-engines/`): `openai.engine.js` (current) +
  `gemini.engine.js`. The relay always speaks **μ-law** to the engine; each engine converts
  internally (OpenAI = passthrough; Gemini = worker-thread transcode). Plivo side, concurrency
  cap, timers, teardown, transcript, and mapping stay shared in the relay.
- **Transcode**: `services/audio-transcode-pool.js` (worker pool) + `workers/mulaw-pcm.worker.js`
  (μ-law tables + linear resample, transferable `ArrayBuffer`s).
- **Config**: `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL` (`gemini-3.1-flash-live-preview`),
  `GEMINI_VOICE`; existing `OPENAI_REALTIME_*` for the GPT engine. Affective dialog is
  auto-enabled ONLY for native-audio models (so 3.1 won't be sent the flag).
- **Pre-load context**: each flow may define `preload({efrId, mobile}, pool)` → context object,
  which the relay injects into `buildInstructions({lang, context})` before dialing. This is what
  lets 3.1 respond relevantly with no in-call tools. Async in-call tools remain a future option
  (would need per-flow tool declarations + toolCall/toolResponse handling + a native-audio model).

---

## Sources
OpenAI: [pricing](https://developers.openai.com/api/docs/pricing) ·
[gpt-realtime](https://developers.openai.com/api/docs/models/gpt-realtime) ·
[realtime guide](https://developers.openai.com/api/docs/guides/realtime) ·
[realtime costs](https://developers.openai.com/api/docs/guides/realtime-costs) ·
[real-world cost data](https://hackernoon.com/openai-realtime-api-pricing-in-2026-real-world-data-from-4000-measured-sessions)

Gemini: [pricing](https://ai.google.dev/gemini-api/docs/pricing) ·
[Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) ·
[2.5 native-audio model](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-native-audio-preview-12-2025) ·
[3.1 Flash Live model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) ·
[3.1 Flash Live announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-live/) ·
[2.5 native audio](https://blog.google/innovation-and-ai/models-and-research/google-deepmind/gemini-2-5-native-audio/) ·
[G.711 thread](https://discuss.ai.google.dev/t/live-api-support-for-mulaw-g711-ulaw-input-output/86053) ·
[Twilio + Gemini Live telephony](https://dev.to/googleai/add-telephony-to-a-gemini-live-agent-with-twilio-1elc)
