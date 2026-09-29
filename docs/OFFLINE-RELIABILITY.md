# Offline Reliability Contract

The unified backend is the server-side authority for technician-app replay.
Clients may retry a mutation after a lost response, process death, or delayed
reconnect, so a replay-safe endpoint must be atomic and idempotent before the
App adds it to its durable outbox.

## Compatibility boundary

- `Idempotency-Key` is optional. Existing clients that omit it keep their
  existing request and response behavior.
- A keyed JSON mutation is fingerprinted and replayed from the shared ledger.
- A keyed multipart mutation must also send `Idempotency-Content-Digest`; the
  server verifies that digest against the uploaded bytes. Multipart requests
  without an idempotency key remain backward compatible.
- Idempotency middleware is mounted only inside the authenticated `/api/mobile`
  router. Admin/CRM, client, integration, and legacy-backend routes are not
  intercepted.
- A profile-card save may attempt the derived Gate-1 transition after its domain
  transaction commits. It always acknowledges that committed domain write and
  reports a deferred finalization outcome when the derived transition cannot
  run. The independently replayable `/registration/finalize` mutation treats
  missing profile cards as a successful pending state while preserving
  transient failures for retry.
- The mobile Identity path and both CRM Aadhaar write paths share one
  constraint classifier. A duplicate active Aadhaar always becomes a redacted
  `409 / AADHAAR_ALREADY_REGISTERED`; the raw MySQL error never reaches logs or
  clients.
- The authenticated Identity form restores its existing fields and document
  ids through one technician-scoped aggregate query. No caller-supplied
  technician id is accepted.
- Every keyed mobile multipart route, including live-only PAN OCR, verifies the
  declared content digest against the post-Multer bytes. Unkeyed legacy uploads
  retain their existing behavior.

## Replay-safe endpoints

The canonical list lives in `docs/offline-reliability-manifest.json` and must
match the App allowlist.

| Operation | Endpoint | Backend invariant |
|---|---|---|
| Skills | `POST /api/mobile/deepskill/skills` | State replacement behind shared idempotency |
| Work Area | `PUT /api/mobile/registration/work-area` | Home location and complete serviceable set commit atomically |
| Identity | `POST /api/mobile/profile/identity-details` | Identity fields and document references commit atomically |
| Registration derive | `POST /api/mobile/registration/finalize` | Server-derived lifecycle transition |
| Training progress | `POST /api/mobile/training-videos/percentage` | Monotonic per technician/video upsert |
| Language | `PATCH /api/mobile/registration/language` | Latest preference replacement |

Work Area and the mobile edit-profile endpoint resolve six-digit PIN values
only. CRM and public profile-update flows retain their existing numeric
`pincode_id` contract. The resolver never ORs both columns, preventing a PIN
value from colliding with an unrelated catalogue primary key.

Live job lifecycle, reapplication, bank/UPI verification, and withdrawal remain
online-only. Do not make them durable merely because they accept an
`Idempotency-Key`; business-time semantics must be reviewed first.

## Deployment preconditions

- Apply the idempotency-ledger migration before serving keyed App mutations.
- Stop and drain both unified-backend and legacy Java training writers before
  running `2026-08-11-02-training-progress-uniqueness.sql`. The table is MyISAM,
  and MySQL may release an explicit table lock around `ALTER TABLE`; do not rely
  on a low-traffic window. Restart writers only after verifying zero duplicate
  technician/video groups and the exact UNIQUE key.
- Resolve the audited active-Aadhaar conflicts before applying
  `2026-08-11-03-active-aadhaar-uniqueness.sql`, and deploy the legacy Java
  backend's redacted conflict handler before enabling the constraint. Do not
  deploy the matching Identity write path until that constraint is present.
- Apply migrations first, run schema verification, then deploy the unified
  backend and finally the App build. The migration scripts are intentionally
  not run by the pre-commit hook.
- Startup verification checks the exact active-Aadhaar generated expression and
  the monotonic training trigger semantics in addition to columns and indexes;
  a partial or manually drifted migration fails closed.

## Future-change workflow

1. Decide whether the operation is safe when replayed much later.
2. Make the database mutation atomic and bound all lists, media, concurrency,
   retention, and cleanup work.
3. Add the endpoint to this repository's manifest and to the App's exact
   method/path allowlist.
4. Add lost-response, concurrent duplicate, changed-payload, 4xx, 5xx,
   process-restart, and account-isolation tests.
5. Stage the complete reviewed change and run `npm run offline:record`.
6. Stage `docs/offline-reliability-sync.json`. The pre-commit hook compares the
   staged tree, so unstaged files cannot make a stale contract appear current.

The hook is intentionally check-only. It performs no network, database,
browser, document-generation, or source mutation work during commit.
