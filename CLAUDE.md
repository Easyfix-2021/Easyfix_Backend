# EasyFix_Backend — Project Instructions for Claude

Unified Node.js/Express backend. Replaces 5 legacy services: CRM, Dropwizard :8090, ACD_APIs, API_AngularClientDashboard, Webhook_2023. Serves 3 frontends (CRM_UI, Client_UI, EasyFixer_App) + external client API integrations.

**Master spec**: `/Users/harshit/Documents/GitHub/EasyFix Docs/EasyFix_Platform_Blueprint.md` — read this before touching anything architectural.

## 📚 Deep reference (read on demand — keeps this file lean)

| When working on… | Read |
|---|---|
| `tbl_job` / `tbl_easyfixer` columns, status codes, create/assign flows, lookup tables, BIT(1) casting | [`docs/claude-reference/SCHEMA.md`](docs/claude-reference/SCHEMA.md) |
| Excel bulk upload, auto-assignment engine, file storage, notifications, webhook delivery, scheduled crons (visible + hidden) | [`docs/claude-reference/FEATURES.md`](docs/claude-reference/FEATURES.md) |
| Migration phase history / what each phase covered | [`docs/claude-reference/PHASES.md`](docs/claude-reference/PHASES.md) |

> **Migration status**: ✅ COMPLETE 2026-05-12 (phases 1–13 done & adversarially verified; 14–15 operational, deferred by design). Details in PHASES.md.

## Tech stack (non-negotiable)

- Node.js 18+, Express 4.x, **JavaScript** (not TypeScript in backend)
- `mysql2/promise` — raw parameterised SQL, **no ORM**
- JWT via `jsonwebtoken` — for /api/admin, /api/client, /api/mobile
- **HTTP Basic Auth** — for /api/integration/v1/* only (legacy client contract)
- Joi for validation, custom human-readable logger (see `logger.js` + `middleware/http-log.js`)
- Shared DB: `easyfix_core` on port 3306 — **never alter schema, never add tables** (the rule protects the five legacy services that share the DB; an EasyFix-owned new table no legacy service references is an explicit exception, e.g. `tbl_pincode` from `migrations/2026-05-01-create-tbl-pincode.sql` for the generic Manage Pincodes feature, distinct from firefox-client `pincode_firefox_city_mapping`).

## Important — EasyFix is a standalone product

EasyFix is NOT part of the 1Office portfolio. Any references in shared
infrastructure docs, naming conventions, or sample env-var lists that
group EasyFix with 1Office services are coincidental — the codebases
do not share auth, do not share databases, and do not share deployment
pipelines beyond what happens to use the same provider accounts. When
in doubt, treat EasyFix as fully independent: no Suite SSO, no
`{SUITE_URL}/api/auth/validate-token` calls, no `{project_slug}_auth_token`
localStorage convention. EasyFix has its own auth (OTP-based JWT
issued by this backend) and its own DB (`easyfix_core` MySQL).

## Route groups and their response contracts

Two response shapes exist. Never mix. See `utils/response.js`.

| Route group | Mount | Auth | Response formatter |
|---|---|---|---|
| `/api/auth/*`       | public | varies | **modern** `{success, data, error}` |
| `/api/public/*`     | **truly unauthenticated** — no JWT, no Basic, accessible from any browser / app / external system | none | modern |
| `/api/admin/*`      | CRM staff | JWT | modern |
| `/api/client/*`     | client SPOC | JWT | modern |
| `/api/mobile/*`     | technician | JWT | modern |
| `/api/shared/*`     | all authed | JWT | modern |
| `/api/webhook/*`    | internal | API key | modern |
| `/api/integration/v1/*` | external (Decathlon etc.) | **HTTP Basic** | **legacy** `{status:"200", message, data}` |

### `/api/shared/*` token contract

`/api/shared/*` accepts ANY JWT signed by this backend — admin, client, or
mobile group all work. The token is verified against `process.env.JWT_SECRET`
(NOT the legacy Java CRM secret `"esyfixsecret"`), so:

- ✅ New EasyFix_Backend admin / client / mobile bearers work
- ❌ Legacy Java `EasyFix_CRM` bearers do NOT work (different signing secret)
- ❌ Legacy Client Dashboard / Legacy Mobile bearers do NOT work (same reason)

For surfaces where ANY user (including legacy systems + open browsers)
should be able to read non-sensitive data — e.g. deep-skill thumbnails
referenced from skill-picker components in legacy UIs — use `/api/public/*`
instead. That route group is truly unauthenticated and produces the same
short-TTL presigned URLs that `/api/shared/*` does.

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

## tbl_job status codes (quick reference)

`0` BOOKED · `1` SCHEDULED · `2` IN_PROGRESS · `3` COMPLETED · `5` COMPLETED_ALT · `6` CANCELLED · `7` ENQUIRY · `9` CALL_LATER · `10` REVISIT. Full stamping behaviour + create/assign flows in [SCHEMA.md](docs/claude-reference/SCHEMA.md).

## Auth reality (important — differs from blueprint §4)

- **`tbl_user` has no password column.** Internal user login is OTP-only via `otp_details`.
- Legacy `EasyFix_CRM` also supports **Microsoft Azure AD OAuth** (see `AUTH_CLIENT_ID`/`AUTH_TENANT_ID` in that repo's `easyfix.properties`). Not replicated here yet.
- `POST /api/auth/login` is intentionally stubbed with **501** and points callers to `/api/auth/login-otp`. Until password or Azure AD login is a real requirement, keep it this way — don't add a password column to `tbl_user` casually.
- OTP is a 4-digit integer (matches legacy `otp_details.otp` which is `INT`). TTL 5 min. Consumed on first successful verify.
- JWT claims: `sub` = `user_id` (string), `email`, `role`, `name`. Expiry 30 d (env `JWT_EXPIRY`). Signing secret in `JWT_SECRET`; distinct from legacy `"esyfixsecret"` — tokens are NOT interoperable across the coexistence window.
- **Dev OTP delivery**: OTPs are logged at `warn` level by `services/auth.service.js` with the message `"DEV OTP issued"`. Never leave that log line in production.

## Role model

`tbl_role` has 20 rows (8 active). There is no DB concept of "admin" or "client" — those are groupings we apply in code. Mapping lives in `services/role.service.js` (`ROLE_ID_TO_GROUP`).

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

**Quirk**: role_id 19 "Technician" has ~4,700 rows in `tbl_user`. Technicians canonically live in `tbl_easyfixer`, so `/api/mobile/*` auths against that table (not `tbl_user`) even though role 19 exists in `tbl_user`. Treat those `tbl_user` rows as legacy ghosts. If a new role_id is added, update `ROLE_ID_TO_GROUP` — unmapped IDs classify as `unknown` and all guards deny them.

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
