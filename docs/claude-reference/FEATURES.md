# EasyFix_Backend — Feature Implementation Reference

> Detailed per-feature notes extracted from CLAUDE.md. Read the relevant section when working on
> bulk upload, auto-assignment, file storage, notifications, or webhook delivery.

## Excel bulk job upload (Step 7)

**Endpoint**: `POST /api/admin/jobs/upload` — multipart; field name `file`; `.xlsx`/`.xls`; max 10 MB.
**Query flag**: `?dryRun=true` — validate all rows without inserting.
**Column spec** (row 1 = header, data from row 2, matching legacy EasyFix_CRM layout):

| Col | Field | Required | Notes |
|---|---|---|---|
| 0 | Customer Mobile | ✓ | 10 digits; bad rows appear in report as `skipped` |
| 1 | Customer Name | ✓ | upserted by mobile — reuses existing `tbl_customer` row |
| 2 | Customer Email | | |
| 3 | Client | ✓ | accepts client_name (case-insensitive) OR numeric `client_id` |
| 4 | Client Ref ID | | |
| 5 | Service Type | | name or numeric ID |
| 6 | Client Service IDs | | CSV of tbl_client_service IDs |
| 7 | Job Description | | |
| 8 | Requested Date/Time | ✓ | Excel date cell or `DD-MM-YYYY HH:mm` string |
| 9 | Address | ✓ | |
| 10 | City | ✓ | name or numeric ID |
| 11 | PIN Code | ✓ | 6 digits |
| 12 | Job Owner | | user_id |
| 13 | Time Slot | | |
| 14 | Job Type | | default `Installation` |
| 15 | Helper Required | | `yes`/`no`/`y`/`n`/`true`/`false` |
| 16 | GPS Location | | `lat,lng` |

**Response shape**:
```json
{
  "success": true,
  "data": {
    "summary": { "totalRows": 5, "createdCount": 2, "failedCount": 2, "skipCount": 1, "dryRun": false },
    "results": [
      { "rowNumber": 2, "status": "created", "jobId": 385703 },
      { "rowNumber": 4, "status": "skipped", "reason": "invalid mobile \"912345678\"" },
      { "rowNumber": 5, "status": "failed",  "errors": ["unrecognised city \"Atlantis\""] }
    ]
  }
}
```

**Known risk — SheetJS on npm**: the `xlsx` package on the npm registry is the SheetJS community build with two unfixed advisories (prototype pollution, ReDoS). Since this endpoint is admin-only and only trusted internal staff can upload, exposure is limited. Before going to production, migrate to the SheetJS CDN tarball: `npm install https://cdn.sheetjs.com/xlsx-latest/xlsx-latest.tgz` — that build has the patches.

## Auto-assignment engine (Step 9)

**Endpoints** (all under `/api/admin/auto-assign`):
- `GET /:jobId/candidates?limit=10&ignoreDistance=false` — preview the ranked list without assigning.
- `POST /:jobId` — commit: picks the top candidate and calls `jobService.assign()` (status bump BOOKED→SCHEDULED + `scheduling_history` row).
- `POST /bulk?limit=50&dryRun=true` — iterate all unassigned BOOKED jobs; per-row status report.

**3-layer pipeline** (implemented in `services/auto-assign.service.js`):

1. **L1 — SQL eligibility**: `efr_status=1 AND is_technician_verified=1 AND efr_cityId = job.city_id` AND service-category LIKE match AND `efr_id NOT IN (scheduling_history rows for this job with non-null reschedule_reason)`. The last filter prevents re-offering a tech who previously rescheduled off this job.
2. **L2 — code availability**: `active_jobs < MAX_CONCURRENT_JOBS` (count of status 0/1/2); distance ≤ `MAX_TRAVEL_DISTANCE_KM` (haversine against customer GPS using `efr_base_gps` ONLY — never `efr_current_gps`); no time-slot conflict on the requested date.
3. **L3 — weighted score** (env-tunable weights, stats from last 90 days):
   ```
   score = 0.35·distance_score + 0.30·workload_score + 0.20·rating_score + 0.15·completion_score
   ```
   Defaults when no history: rating 3.0/5, completion 0.8.

**Perf**: stats are batch-fetched in 4 queries regardless of candidate count (active_jobs, time_slot conflicts, rating avg, completion ratio) — no N+1. For 123 eligible candidates the pipeline runs in ~2s against the 384k-row `tbl_job`.

**Route-order gotcha**: `/bulk` is declared before `/:jobId` because Express matches in declaration order and `:jobId` would otherwise capture the literal string `"bulk"` and fail the Joi integer validator.

## File storage (Step 10)

**Dev vs prod paths**: `.env` ships with `./uploads` under the repo (gitignored) for local dev. Production uses `/var/www/html/easydoc/...` which Nginx serves directly. The same category map works for both — only the env-var values change.

**Categories** (hardcoded allowlist in `utils/file-storage.js::CATEGORIES`):

| Category | Env var | Public URL prefix |
|---|---|---|
| `easyfixer_documents` | `UPLOAD_EASYFIXER_DOCS` | `/easydoc/easyfixer_documents/` |
| `job_files` | `UPLOAD_JOB_FILES` | `/easydoc/upload_jobs/` |
| `invoices` | `UPLOAD_INVOICES` | `/easydoc/client_invoice/` |
| `general` | `UPLOAD_ROOT_PATH` | `/easydoc/` |

**Extensions**: `.png .jpg .jpeg .webp .gif .pdf .xlsx .xls .csv .txt`. Anything else → 400.

**Mime allowlist**: images, PDF, spreadsheet, CSV, plaintext, `application/octet-stream` (browsers sometimes label PDFs this way). Everything else → 400.

**Path-traversal defence** (implemented at 3 layers):
1. Joi rejects absent/overlong filenames.
2. Runtime guard rejects `/`, `\`, and `\0` in the supplied filename.
3. `path.resolve(root, filename)` result must start with `root + path.sep`. Any escape → 400.

**`DELETE /api/shared/files/:id` note**: the blueprint's `:id` pattern has no backing schema (there's no `tbl_files` registry, and we're forbidden from creating one). We implemented `DELETE /api/shared/files?category=X&filename=Y` as the pragmatic equivalent. Entity-aware deletes that also drop DB rows (e.g. `DELETE /api/mobile/documents/:id`) belong to the owning route groups, not here.

## Notification services (Step 11)

Four outbound channels, each a module exposing a `send*` function with a consistent return shape `{ delivered: boolean, disabled?, error?, ... }`.

| Channel | File | Provider | Contract |
|---|---|---|---|
| SMS | `services/sms.service.js` | SMSCountry | `POST http://smscountry.com/SMSCwebservice_Bulk.aspx` form body with `User/passwd/mobilenumber/message/sid/mtype=N/DR=N` |
| Email | `services/email.service.js` | Gmail SMTP | `nodemailer` over 587 + STARTTLS, shared `ithelpdesk@easyfix.in` account |
| WhatsApp | `services/whatsapp.service.js` | Gallabox | `POST https://server.gallabox.com/devapi/messages/whatsapp`, headers `apiKey` + `apiSecret`, pre-approved templateName |
| Push | `services/fcm.service.js` | Firebase FCM (legacy HTTP) | `POST https://fcm.googleapis.com/fcm/send`, header `Authorization: Key=<FCM_API_KEY>` |

**Dev guard — NOTIFICATIONS_DISABLE**: set to `true` in `.env` for local dev so provider calls are short-circuited with a logged-only `{delivered: false, disabled: true}` response. Critical when working against the QA database, where mobile numbers and emails belong to real customers. Flip to `false` only when deliberately testing real delivery.

**Test-mode recipient overrides** (safer alternative to DISABLE when you want to see real delivery but only to yourself):
- `TEST_EMAILS=a@x.com,b@y.com` — every email is redirected to this list. `cc`/`bcc` are dropped. Subject is prefixed `[TEST→<originalTo>]`.
- `TEST_MOBILE=9310992052` — every SMS and WhatsApp goes to this number instead of the real recipient.
- `TEST_FCM_TOKEN=<device-token>` — if set, FCM pushes redirect here. If blank while test-mode is active (either TEST_EMAILS or TEST_MOBILE set), FCM calls are SKIPPED rather than going to real user devices.

Interception lives in each of `services/{sms,email,whatsapp,fcm}.service.js` — immediately before the outbound `fetch`/`sendMail` call, after validation and after the orchestrator. Every code path that calls these services gets the redirect automatically; no caller can bypass. Result object includes `{redirected: true, intendedTo: <originalRecipient>}` for audit visibility in logs.

**FCM v1 migration (known future work)**: Google deprecated the legacy `/fcm/send` endpoint. When it finally shuts down, swap `fcm.service.js` for the v1 API (`https://fcm.googleapis.com/v1/projects/{id}/messages:send` with OAuth 2.0 service-account token). Android/iOS clients don't need changes — they consume the same notification payload shape.

**Gallabox templates must be pre-approved** inside the Gallabox admin UI. New `templateName` values won't deliver until approved by WhatsApp — you can't send freeform text via Gallabox's template API. Legacy templates in use (from `WhatsNotificationUtil.java`): `accepted_on_app`, `tx_accepted_client`, `order_reject`, `ota_noo`, `ota_yes`, `cx_revisit_yes`, `eta_sent_clone_clone`, `pm_txreschedule`, `cancel_order`, `cx_revisit_no`, `qa_cx_order_confirm`.

**Dev OTP delivery is now hookable**: with this step in place, `auth.service.js::createLoginOtp()` should switch from log-only to `smsService.send({...})` + `emailService.send({...})`. Deferred — call sites and test coverage come when Client_UI + EasyFixer_App ship.

## Phase 2 — Webhook delivery (DONE 2026-04-17)

**Admin endpoints** under `/api/admin/webhooks`:
- `GET /events`, `POST /events`, `PATCH /events/:id` — event registry (`webhook_events`)
- `GET /mappings?clientId=&eventId=`, `POST /mappings`, `PATCH /mappings/:id`, `DELETE /mappings/:id` — per-client callback URLs (`webhook_client_url_mapping`)
- `GET /preview/:jobId` — inspect the enriched payload without dispatching
- `POST /dispatch { eventName, jobId, mappingId }` — manual re-send for ops reconciliation
- `GET /logs?clientId=&eventId=&jobId=` — paginated audit trail from `webhook_logs`

**Auto-triggers** (wired inside `services/job.service.js`):

| Trigger | Event |
|---|---|
| `assign()` first time (existing `fk_easyfixter_id` was null) | `TechAssigned` |
| `assign()` reassignment | `RescheduleTech` |
| `setStatus()` → 2 IN_PROGRESS | `TechStart` |
| `setStatus()` → 3 or 5 COMPLETED | `TechVisitComplete` |
| `setStatus()` → 6 CANCELLED | `CancelJob` |
| `setStatus()` → 10 REVISIT | `TechVisitInComplete` |

Dispatch is **fire-and-forget via `setImmediate`** — the job API returns before the webhook flies. Internal retry runs in-process with backoff (immediate → 30s → 5min). Failed deliveries log to `webhook_logs.job_data.__delivery.error`; after 3 attempts, `__delivery.dlq = true` marks permanent failure (dead-letter discoverable via logs endpoint).

**Payload contract**: `buildJobPayload(jobId)` returns 39 fields matching the legacy shape byte-for-byte — nested `customer`, `scheduledBy`, `clientSpoc`, `jobImage[]` (absolute URLs), `jobServices[]` (with rate-card nested), `jobRescheduleReason`, camelCase datetime fields. Any drift breaks Decathlon/Powermax/etc. Verified against real `webhook_logs` history before implementation.

**Per-client authorization**: `webhook_client_url_mapping.authorization` holds bearer tokens (Decathlon's lives here: `c52aeadf5f8a4dae828e88bf508ea2b9a`). Dispatcher sets this as outbound `Authorization` header literally — the column value is used verbatim so clients can include `Bearer ` prefix or not as they prefer.

**Dev guard**: `WEBHOOK_OUTBOUND_ENABLED=false` env short-circuits `dispatch()` without hitting providers (UNSET = enabled, so the guard must be set explicitly). Unlike notifications, webhook dispatch is NOT disabled in `.env` by default — events to real clients fire in dev only if mappings exist for the scratch client you're using. When testing, register a local receiver.

## Scheduled crons (`server/scheduler.js`)

All cron registrations live in `server/scheduler.js::init()`. Time zone is `Asia/Kolkata` for every job — cron expressions evaluate in IST, not UTC. The dev kill switch is `CRON_DISABLED=true` (env), which short-circuits the entire init.

There are **two distinct registration patterns** — the right one depends on whether the cron is operator-facing or pure infrastructure.

### Pattern 1 — Registered via `registerJob({...})` (visible to operators)

These appear on the **Scheduled Jobs** admin page (`/api/admin/scheduled-jobs` → CRM_UI Scheduled Jobs route). Each entry exposes:

- Last-run telemetry (`lastRunAt`, `lastDurationMs`, `lastResult`, `lastError`).
- A "Trigger Now" button (out-of-band manual run via `triggerJob(id)`).
- Optionally a "Test" button when the job exports a `tester` callback (e.g. magic-link, profile reminder, skill+pincode reminder — these dispatch a single WhatsApp to a typed mobile, never to the real recipient).
- A skip reason (`skipReason: 'CRON_DISABLED=true'` or `"property 'X' is not 'true'"`) when an env/property gate kept it from registering. The row still appears so operators can see what *would* have run.

Currently registered visible jobs (IDs match the admin route):

| id | name | cron | gate | description |
|---|---|---|---|---|
| `kaleyra-call-report-sync` | Kaleyra Call-Report Sync | `0 */4 * * *` | always-on | Pulls call records from Kaleyra and writes to `tbl_kaleyra_call_log`. |
| `magic-link-sweep` | Customer Magic-Link Sweep | (see scheduler.js) | `magic.link.cron.enabled` | Sweeps eligible customers and sends magic-link WhatsApp. |
| `easyfixer-profile-reminder` | Easyfixer Profile-Completion Reminder | `0 19 * * 3,6` | `easyfixer.profile_reminder.enabled` | Wed + Sat 19:00 IST. Nudges easyfixers with incomplete profiles. |
| `easyfixer-skill-pincode-reminder` | Easyfixer Skill+Pincode Reminder | `30 12 * * *` | `easyfixer.skill_pincode_reminder.enabled` | Daily 12:30 IST. Nudges easyfixers missing deep-skill or pincode coverage. |

To add a new visible cron: call `registerJob({id, name, description, cron, runner, tester?, testSourceLabel?, testSourceHelp?})` inside `init()`, then either `cron.schedule(job.cron, () => invokeJob(job, 'cron'), {timezone: TZ})` or set `job.skipReason` when a gate is off. Read access to the admin page is allowlisted by email via the `scheduled.jobs.visible.emails` property (see `services/scheduled-jobs.service.js::isAllowedUser`).

### Pattern 2 — Standalone `cron.schedule(...)` (hidden infrastructure)

When a cron is **infrastructure plumbing** rather than an operator-facing scheduled task, register it directly via `cron.schedule(...)` WITHOUT going through `registerJob()`. The result:

- Does NOT appear on the Scheduled Jobs admin page.
- No "Trigger Now" / Test buttons exposed.
- No in-memory telemetry on the job registry.
- Still honors `CRON_DISABLED=true` (must be gated inline).
- Still runs on the `Asia/Kolkata` timezone constant.

This pattern is appropriate when the cron exists to keep the system internally consistent and operators have no meaningful action to take. They wouldn't trigger it manually; they don't need last-run telemetry; surfacing it on the page would create noise without value.

Currently registered hidden crons:

#### `deep-skill image-gen orphan reset` — every 5 min

Wired in `server/scheduler.js` at the tail of `init()`. Calls `services/deep-skill-image-gen.service.js::resetOrphanedPendingImageGens()`.

- **Why it exists**: deep-skill auto-image-generation dispatches via `setImmediate` (fire-and-forget). The in-memory `inflightImageGen: Set<number>` guards against double-dispatch, but a server restart kills the in-flight worker before `generateImage()` can write the final image OR mark the row `'failed'`. The row stays `image_gen_status = 'pending'` forever, the FE polling loop spins, the operator has no Retry path.
- **Reset criterion**: `WHERE image_gen_status = 'pending' AND image_gen_attempted_at < NOW() - INTERVAL 10 MINUTE`. Real DALL-E generations finish well under 60 seconds — 10 minutes is a comfortable buffer that won't race a legitimate in-flight call.
- **Effect**: flips status to `'failed'`. Leaves `image_gen_attempted_at` unchanged so the FE displays "Failed at <original pending stamp>" accurately. The operator's Retry button then re-stamps the timestamp + re-dispatches.
- **Why hidden**: pure infrastructure. Operators don't trigger orphan resets manually; they don't care about telemetry; the visible alternative would be UI clutter for zero ops value.
- **Why no property gate**: cost is one tiny UPDATE per 5 minutes. The alternative (gate disabled → orphans accumulate) is strictly worse than always-on.
- **Telemetry**: silent in steady state (no rows match). When it does reset, logs at `warn` level: `deep-skill-image-gen: reset orphaned pending rows to failed`. Discoverable via log grep, not via UI.
- **Linked code**:
  - Cron registration: `server/scheduler.js` at the end of `init()` (after the visible jobs).
  - Reset function: `services/deep-skill-image-gen.service.js::resetOrphanedPendingImageGens()`.
  - Pending stamp: `services/deep-skill.service.js::create()` and `::update()` — both stamp `image_gen_attempted_at = NOW()` when marking `'pending'`, which is what makes orphan detection possible.

When adding new hidden crons later, document each in this subsection with the same headings (Why it exists, criterion, effect, why hidden, telemetry, linked code) so future Claude sessions or engineers reviewing "what's running" have a single discoverable home.
