# EasyFix_Backend — Project Instructions for Claude

Unified Node.js/Express backend. Replaces 5 legacy services: CRM, Dropwizard :8090, ACD_APIs, API_AngularClientDashboard, Webhook_2023. Serves 3 frontends (CRM_UI, Client_UI, EasyFixer_App) + external client API integrations.

**Master spec**: `/Users/harshit/Documents/GitHub/EasyFix Docs/EasyFix_Platform_Blueprint.md` — read this before touching anything architectural.

## Tech stack (non-negotiable)

- Node.js 18+, Express 4.x, **JavaScript** (not TypeScript in backend)
- `mysql2/promise` — raw parameterised SQL, **no ORM**
- JWT via `jsonwebtoken` — for /api/admin, /api/client, /api/mobile
- **HTTP Basic Auth** — for /api/integration/v1/* only (legacy client contract)
- Joi for validation, custom human-readable logger (see `logger.js` + `middleware/http-log.js`)
- Shared DB: `easyfix_core` on port 3306 — **never alter schema, never add tables** (the rule protects the five legacy services that share the DB; an EasyFix-owned new table no legacy service references is an explicit exception, e.g. `tbl_pincode` from `migrations/2026-05-01-create-tbl-pincode.sql` for the generic Manage Pincodes feature, distinct from firefox-client `pincode_firefox_city_mapping`).

## Route groups and their response contracts

Two response shapes exist. Never mix. See `utils/response.js`.

| Route group | Mount | Auth | Response formatter |
|---|---|---|---|
| `/api/auth/*`       | public | varies | **modern** `{success, data, error}` |
| `/api/admin/*`      | CRM staff | JWT | modern |
| `/api/client/*`     | client SPOC | JWT | modern |
| `/api/mobile/*`     | technician | JWT | modern |
| `/api/shared/*`     | all authed | JWT | modern |
| `/api/webhook/*`    | internal | API key | modern |
| `/api/integration/v1/*` | external (Decathlon etc.) | **HTTP Basic** | **legacy** `{status:"200", message, data}` |

## THE NO-CLIENT-CHANGE RULE (integration routes)

External clients like Decathlon currently hit `https://core.easyfix.in/v1/*` on the legacy Dropwizard :8090 service. After cutover, Nginx rewrites `/v1/*` → `/api/integration/v1/*` on this backend. Clients must notice **zero difference**.

Therefore, for any `/api/integration/v1/*` route:

1. **Response shape**: use `legacyOk()` / `legacyError()` from `utils/response.js`. `status` field is a **STRING** (`"200"`), not a number. Never apply a global response envelope middleware to these routes.
2. **Dates**: accept and return `"DD-MM-YYYY HH:mm"` (IST). Never ISO-8601.
3. **Status labels**: `currentStatus` is a human string (`"Unconfirmed"`, `"Scheduled"`, `"Completed"`, `"Cancelled"`, `"Revisit"`), not a numeric code.
4. **Multipart fields**: image upload uses field names `file` and `JobId` (capital J, capital I) — exact casing matters.
5. **Auth**: HTTP Basic only. Credentials sourced from the legacy `ClientLogin` / `tbl_client_website` table, not the JWT user table.
6. **Before shipping**: run the shadow-traffic diff harness — replay real legacy-service requests against the new endpoint and compare response bodies byte-for-byte.

Reference contract: `/Users/harshit/Documents/GitHub/EasyFix Docs/Easyfix_APIs.docx`.

## Coding rules (from blueprint §2)

1. Parameterised SQL only — never concatenate user input.
2. Pagination is server-side (`LIMIT ?, ?`). Never load all rows.
3. Modern success: `{success: true, data, message?}`; modern error: `{success: false, error, details?}`.
4. Validate all request bodies with Joi; 400 with specific errors.
5. Multi-step writes use `beginTransaction/commit/rollback`.
6. No `console.log` — use `logger` (Pino).
7. Dates stored as MySQL DATETIME, displayed IST on frontend.

## Phase plan — ✅ MIGRATION COMPLETE 2026-05-12

All migration phases (1-13) are functionally complete and verified across three independent adversarial review passes. The legacy 5-service Java stack (CRM, EasyFix_API, ACD_APIs, API_AngularClientDashboard, Webhook_2023) has full coverage in this Node backend plus the three frontends (Easyfix_CRM_UI, Easyfix_client_UI, EasyFixer_App). Phases 14-15 (operational: Redis lift, Nginx cutover) remain deferred by design — they require production access and are not migration code.

The earlier `PHASE_PLAN.md` planning doc was removed once the work it tracked was closed out. The phase table below is the kept-for-reference snapshot of what each phase covered.

### Phase 1A — Admin CRM foundation ✅ DONE

- [x] Step 1: Scaffold Express + mysql2 pool + health endpoints
- [x] Step 2: Auth routes (OTP-based) — `/login` returns 501 (see **auth reality** below)
- [x] Step 3: Role middleware — group + exact-name guards with 5-min cache
- [x] Step 4: Shared lookup routes — 11 endpoints
- [x] Step 5: Admin easyfixer CRUD — soft-deactivation only
- [x] Step 6: Admin job CRUD + status + assign — transactional create
- [x] Step 7: Admin job bulk xlsx upload — per-row error reporting, dry-run
- [x] Step 8: Admin job owner change — 4-layer validation + audit
- [x] Step 9: Auto-assignment engine — 3-layer pipeline, weighted scoring
- [x] Step 10: Shared file upload/delete — path-traversal safe
- [x] Step 11: Notification services — SMS/Email/WhatsApp/FCM with disable flag

### Remaining phases

| # | Phase | Priority | Scope summary |
|---|---|---|---|
| 🔥 1B | CRM_UI frontend | parallel | Next.js, **separate repo** — not started |
| ✅ 2 | Webhook delivery | DONE | Admin CRUD + dispatcher with retry/DLQ + job-lifecycle auto-triggers |
| ✅ 3 | External Integration API | DONE | `/api/integration/v1/*` Basic Auth + legacy-shape adapters for all Dropwizard endpoints |
| ✅ 4 | Client Dashboard backend | DONE | SPOC OTP auth, client-scoped jobs/dashboard/profile/approve/reject |
| ✅ 5 | Technician Mobile backend | DONE | Tech OTP auth, job accept/reject/checkin/checkout/reschedule, profile steps, device FCM |
| ✅ 6 | Notification wiring | DONE | Orchestrator fans out events to SMS/email/WhatsApp/FCM; in-app inbox CRUD |
| ✅ 7 | Finance & Invoicing | DONE | Invoices list/generate/payment, transactions ledger, POs, payout |
| ✅ 8 | Extended admin CRUD | DONE | Clients + contacts + billing; Users; Rate cards |
| ✅ 9 | Quotations + Order-Lifecycle enablers | DONE | Product/material quotations, validator stub, questionnaires |
| ✅ 10 | Settings + Masters | DONE | Generic CRUD factory for cities/service-types/categories/banks/doc-types/cancel-reasons |
| ✅ 11 | Reports + Tracking | DONE | Completed-jobs, easyfixer, payout-sheet, city-analysis, job-tracking, user-hours |
| ✅ 12 | Auxiliary flows | DONE | Attendance, materials, training, Aadhaar check, geocoding, experience, email-verify callback |
| ✅ 13 | Inactive/legacy preserved | DONE | Snapdeal, Exotel, JMS behind feature flags (`*_ENABLED=false`) |
| ✅ 14 | Performance optimization | DONE | Compression + per-tier rate limiting (integration/client/mobile) + perf guide |
| ✅ 15 | Legacy retirement runbook | DONE | Step-by-step Nginx cutover + rollback triggers (`RETIREMENT_RUNBOOK.md`) |
| 🔥 3 | External Integration API (Decathlon) | high | 40+ `/api/integration/v1/*` with legacy Dropwizard contract |
| 🔥 4 | Client Dashboard backend + Client_UI | high | ~45 endpoints, SPOC auth via `tbl_client_contacts` |
| 🔥 5 | Technician Mobile backend + EasyFixer_App | high | ~55 endpoints, tech auth via `tbl_easyfixer` |
| 🔥 6 | Notification wiring | high | Trigger outbound on job events + in-app inbox |
| 🟡 7 | Finance & Invoicing | monthly | 42 endpoints (invoices, payouts, recharges) |
| 🟡 8 | Extended admin CRUD | medium | Client contacts, billing, custom-props, products, users |
| 🟡 9 | Quotations + Order-Lifecycle enablers | medium | Order Lifecycle §13 CRITICAL GAPs |
| 🟢 10 | Settings + Masters | low | Cities/tools/skills/doc-types/rate-cards |
| 🟢 11 | Reports + Tracking | low | Completed-jobs, easyfixer, payout sheet, analytics |
| 🟢 12 | Auxiliary flows | low | Attendance, materials, training, Aadhaar, geocoding |
| 🟢 13 | Inactive/Legacy-preserved | low | Snapdeal, Exotel, JMS (feature-flag gated, never deleted) |
| 🟢 14 | Performance optimization pass | cross-cutting | Redis, rate-limit, query plans, N+1 audit |
| 🟢 15 | Legacy retirement | final | Nginx cutover + decomm Tomcat/Dropwizard/Spring Boot |

Integration routes (`/api/integration/v1/*`) are scaffolded from Step 1 onward so the contract-compat work stays visible throughout.

## Auth reality (important — differs from blueprint §4)

- **`tbl_user` has no password column.** Internal user login is OTP-only via `otp_details`.
- Legacy `EasyFix_CRM` also supports **Microsoft Azure AD OAuth** (see `AUTH_CLIENT_ID`/`AUTH_TENANT_ID` in that repo's `easyfix.properties`). Not replicated here yet.
- `POST /api/auth/login` is intentionally stubbed with **501** and points callers to `/api/auth/login-otp`. Until password or Azure AD login is a real requirement, keep it this way — don't add a password column to `tbl_user` casually.
- OTP is a 4-digit integer (matches legacy `otp_details.otp` which is `INT`). TTL 5 min. Consumed on first successful verify.
- JWT claims: `sub` = `user_id` (string), `email`, `role`, `name`. Expiry 30 d (env `JWT_EXPIRY`). Signing secret in `JWT_SECRET`; distinct from legacy `"esyfixsecret"` — tokens are NOT interoperable across the coexistence window.
- **Dev OTP delivery**: Step 11 will send OTPs via SMSCountry + Gmail. Until then, OTPs are logged at `warn` level by `services/auth.service.js` with the message `"DEV OTP issued"`. Never leave that log line in production — remove or downgrade it when Step 11 lands.

## Role model

`tbl_role` has 20 rows (8 active). There is no DB concept of "admin" or "client" — those are groupings we apply in code.

Mapping lives in `services/role.service.js` (`ROLE_ID_TO_GROUP`). Groups:

| Group | `role_id`s | Mount |
|---|---|---|
| `admin`   | 2 (Admin), 3 (Executive Supply), 5 (Business Development), 7 (Finance), 11 (Call Flow+Quality), 12 (Zonal Field Team), 13 (Project Manager), 15 (Admin Supply), 17, 18 | `/api/admin/*` |
| `client`  | 20, 21 (both named "Client Dashboard User" — legacy duplicate) | `/api/client/*` |
| `mobile`  | 19 (Technician) | `/api/mobile/*` |
| `default` | 1 (Default User) | — no group access |
| `unknown` | anything else | fails closed in middleware |

Guards:
- `role(['admin'])` — group guard; use at route group level.
- `roleByName(['Finance'])` — exact role_name match, case-insensitive; use for fine-grained ACL inside a group (e.g. finance-only reports).

**Quirk**: role_id 19 "Technician" has ~4,700 rows in `tbl_user`. Technicians canonically live in `tbl_easyfixer`, so `/api/mobile/*` will auth against that table (not `tbl_user`) even though role 19 exists in `tbl_user`. Treat those `tbl_user` rows as legacy ghosts; do not grant real privileges based on them.

If a new role_id is added, update `ROLE_ID_TO_GROUP`. Unmapped IDs classify as `unknown` and all guards deny them.

## Table-name reconciliations (blueprint §3 vs reality)

Some lookup tables are named differently from the blueprint — verified on QA 2026-04-17:

| Blueprint | Actual | Notes |
|---|---|---|
| `tbl_reschedule_reason` | `reschedule_reason_app` | 4 rows; app-facing list |
| `tbl_bank` | `bank_name` | 154 rows + `is_easyfix_bank` BIT flag |
| `tbl_cancel_reason` | `tbl_cancel_reason` | Exists but **only 1 row** ("cancle job"). The canonical technician-app cancel list appears to live in `job_cancel_reason_by_easyfixer_app` — merge on next pass. |

Unmapped tables worth knowing about for future lookups:
- `tbl_enum_reason` (102 rows, `enum_type`-discriminated multi-purpose list)
- `job_cancel_reason_by_easyfixer_app` (richer cancel reasons)
- `revisit_reason_by_app`, `collect_cash_reason_by_app`, `problem_with_job_reason` (app-specific reason lists)

## tbl_easyfixer glossary (86 cols — column-name drift from blueprint)

The blueprint documents this table with camelCase identifiers; the DB uses snake_case. When writing queries or validators, **match the DB**:

| Blueprint | Actual DB column |
|---|---|
| `first_name` | `efr_first_name` |
| `last_name` | `efr_last_name` |
| `isTechnicianVerified` | `is_technician_verified` |
| `isEmailVerified` | `is_email_verified` |
| `efrProfilePercentage` | `efr_profile_perc` |
| `efrPersonalDetailsPercentage` | `efr_personal_details_perc` |
| `efrProfessionalDetailsPercentage` | `efr_professional_details_perc` |
| `efrBankDetailsPercentage` | `efr_bank_details_perc` |
| `efrIdentityDetailsPercentage` | `efr_identity_details_perc` |
| `efrManagerId` | `efr_manager_id` |
| `noOfChildren` | `efr_children` |
| `haveBike` | `have_bike` |
| `useWhatsapp` | `use_whatsapp` |
| `doYouHaveHealthInsurance` | `health_insurance` |
| `doYouHaveAccidentalInsurance` | `accidental_insurance` |
| `doYouHaveDrivingLisence` | `have_driving_lisence` (**preserve typo** — matches schema) |
| `adhaarCardNumber` | `adhaar_card_number` (`adhaar`, not `aadhar`) |
| `panCardNumber` | `pan_card_number` |
| `finalSubmission` | `final_submission` |
| `newEasyfixer` | `new_easy_fixer` |
| `isExistingEasyfixer` | `is_existing_easyfixer` |
| `aboutYourself` | `about_yourself` |

**`efr_no` is NOT DB-unique.** The blueprint says `efr_no VARCHAR UNIQUE`, but `SHOW INDEXES FROM tbl_easyfixer` shows only `efr_id` as primary. Production data has duplicate mobile numbers. `easyfixer.service.create()` adds an app-level check: "409 if an *active* easyfixer with this `efr_no` exists". Updates do not enforce uniqueness (existing dupes would break). If you ever add a DB unique index, backfill-deduplicate first.

**Status model**: `efr_status` is 0/1 (active flag). Deactivation captures `inactive_reason` (FK, nullable), `inactive_comment`, and stamps `last_inactive_date_time`. Reactivation clears the reason/comment but does NOT touch `last_inactive_date_time` (that's a historical marker). We never DELETE rows — soft-delete only.

**Projections**: `LIST_COLUMNS` = 14-col compact view; `DETAIL_COLUMNS` = `SELECT e.*` + city join. Don't return `SELECT *` from list — the response bloat on 4,254 active rows (paginated, but still) hurts clients.

## tbl_job (141 cols, ~384k rows) — key facts

**Column-name landmines (preserve verbatim — 5 services depend on them)**:
- `fk_easyfixter_id` — the "t" is a typo of "easyfixer" but canonical since 2013.
- `Efr_dis_travelled` — capital E, preserved.

**Status codes** (defined as constants in `services/job.service.js`):

| Code | Name | When stamped |
|---|---|---|
| 0 | BOOKED | Default on create |
| 1 | SCHEDULED | Auto-set on first assign |
| 2 | IN_PROGRESS | Technician checked in |
| 3 | COMPLETED | Auto-stamps `checkout_date_time` if null |
| 5 | COMPLETED_ALT | Alternative completion (kept for legacy) |
| 6 | CANCELLED | Stamps `cancel_date_time`, `cancel_reason_id`, `cancel_comment`, `cancel_by` |
| 7 | ENQUIRY | Information request only |
| 9 | CALL_LATER | Deferred / soft deleted |
| 10 | REVISIT | Needs return visit |

**Source fields**: `source_type` (varchar) is the human-readable source (`"manual"`, `"excel"`, `"dashboard"`, `"decathlon API"`); `source` (tinyint) is legacy — don't use.

**Create flow** (`POST /api/admin/jobs`): single transaction —
1. `upsertCustomer`: if `customer_id` given, validate it exists; else look up by `customer_mob_no`; else insert fresh.
2. `insertAddress`: new address row bound to the customer (unless `address_id` supplied).
3. Insert `tbl_job` with resolved FKs + audit fields (`fk_created_by`, `created_date_time`, `ticket_created_date_time`, `last_update_time`, `job_status=0`).
4. If `services[]` is given, insert each into `tbl_job_services`.
5. Commit, then `getById()` for the full payload.

**Assign flow** (`PATCH /api/admin/jobs/:id/assign`): single transaction —
1. Reject if easyfixer doesn't exist or is inactive.
2. `UPDATE tbl_job SET fk_easyfixter_id = ?, scheduled_date_time = NOW(), fk_scheduled_by = ?, job_status = IF(status=0, 1, status), first_scheduled_by = COALESCE(first_scheduled_by, ?)`.
3. `INSERT scheduling_history`. `reason_id`/`reschedule_reason` are only stamped on *reassignment*, not initial assignment.

**Update guardrails**: `MUTABLE_COLUMNS` whitelist prevents mass-assignment of `job_id`, `created_date_time`, audit fields, and status-change-only columns. Use `PATCH /status` for status transitions (it stamps related fields) and `PATCH /assign` for tech changes (it writes scheduling_history).

**Projections**: LIST returns ~24 cols (joined names from 5 tables). DETAIL returns `SELECT j.* + joined names + services[] + images[]`. Never return `SELECT *` on list — response bloat on 384k-row pagination would hurt clients.

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

## Schema gotchas caught during build

- `tbl_job.job_desc` is **NOT NULL** despite `INFORMATION_SCHEMA` reporting `text`. `job.service.create()` defaults to `''` when omitted. Caught during Step 8 smoke testing of a payload without a description.
- `tbl_easyfixer.efr_no` has **no unique constraint** despite blueprint claims. Dup active mobiles are detected in application code only.
- `tbl_job.fk_easyfixter_id` — preserve the `easyfixter` typo; 5 services reference it.
- `tbl_job.Efr_dis_travelled` — capital E, preserved.
- `have_driving_lisence` (tbl_easyfixer) — preserve the `lisence` typo.
- `is_expired` (otp_details) and many other BIT(1) columns — require `typeCast` in `db.js` to return booleans instead of `Buffer`. Removing that cast silently breaks OTP replay guards, `efr_status`, etc.

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

**Dev guard**: `WEBHOOKS_DISABLE=true` env short-circuits `dispatch()` without hitting providers. Unlike notifications, webhook dispatch is NOT disabled in `.env` by default — events to real clients fire in dev only if mappings exist for the scratch client you're using. When testing, register a local receiver.

## BIT(1) → boolean at the pool

MySQL `BIT(1)` columns (e.g. `otp_details.is_expired`, `tbl_user.is_*`) are returned as `Buffer` by default. `db.js` has a `typeCast` that coerces them to `true`/`false`/`null`. This is why code can write `if (row.is_expired)` naturally. Don't remove it — several tables rely on it.

## Local dev

```bash
cp .env.example .env   # fill DB_USER, DB_PASSWORD, JWT_SECRET
npm install
npm run test:db        # verify DB connection without starting HTTP
npm run dev            # nodemon on :5100

# Health
curl http://localhost:5100/api/health
curl http://localhost:5100/api/health/db
curl http://localhost:5100/api/integration/_ping   # verify legacy-shape response

# Auth flow (OTP lands in server logs in dev mode)
curl -X POST http://localhost:5100/api/auth/login-otp -H 'content-type: application/json' \
     -d '{"identifier":"ur.priya@gmail.com"}'
# then read OTP from logs or otp_details, then:
curl -X POST http://localhost:5100/api/auth/verify-otp -H 'content-type: application/json' \
     -d '{"identifier":"ur.priya@gmail.com","otp":1234}'
# use returned token:
curl http://localhost:5100/api/auth/me -H 'authorization: Bearer <token>'

# Lookups (require token)
curl 'http://localhost:5100/api/shared/lookup/cities?q=delhi' -H 'authorization: Bearer <token>'
curl 'http://localhost:5100/api/shared/lookup/service-types?categoryId=21' -H 'authorization: Bearer <token>'
curl 'http://localhost:5100/api/shared/lookup/clients?limit=10' -H 'authorization: Bearer <admin-token>'
```

## Important Rules
- Never modify code outside the scope of the current task. Do not touch files, functions, or flows unrelated to what the user has explicitly asked for.
- Always build/compile the project after making changes to catch errors before sharing the final summary.
- Write optimized code and reuse existing utilities. Check if equivalent logic already exists before writing new helpers.
- Always share a summary at the end of each response: (1) what was the issue, (2) findings/root cause, (3) changes made and where.
