# Material request flow v2 — design

Date: 2026-09-21
Status: owner-approved ("Keep 15, looks right, make the changes in one go")
Supersedes the sub-status-1 ("Quotation Pending") parts of
`2026-09-18-pending-for-material-status-16-design.md`.
Repos: `EasyFix_Backend`, `Easyfix_CRM_UI`, `Easyfix_Technician_Mobile_Application`

**Amendment, 2026-09-22** (owner decision — "once Tx clicks Send for
Approval he won't be able to edit the quotation — we provide Save for
drafts. Additional material after sending = a NEW quotation."): once sent, a
line is locked to the technician (`review_pending` is no longer
tech-editable); drafting is now allowed at 15 too, but sending is not; a
send stamps one strictly-later `sent_on` shared by the whole quotation; both
quotation lists gain a display-only `quotationNo`/`quotation_no`. See
"Locks", "Transitions" and "API contract" below (backend only — this
repo's `EasyFix_Backend`; the CRM/app UI-facing parts of this amendment are
tracked separately).

## Owner requirements (2026-09-21, verbatim intent)

1. A job shows in Pending for Material as soon as the technician raises the
   material request — "Review Pending"; after CRM review it goes to the client
   — "Approval Pending".
2. The technician can add more material to the quotation until the CRM has
   reviewed it; after CRM approval that quotation is locked for him. A CRM user
   can add material from Pending for Material until the client approves. The
   app shows Review Pending / Approval Pending.
3. Order Details: added materials are asked Save or Send for Approval. The
   estimate's "Send for Approval" button becomes "Save" (draft); sending is done
   from the footer.
4. Once any material is added, the footer's Complete Job is replaced by
   **Send for Approval**; each material gets a delete button, and **Delete All**
   sits next to Save. "Send for Approval means Material Required" — the separate
   Material Required button goes away.
5. CRM job modal: Quotations and Materials tabs are merged (a material request
   is part of the quotation).
6. Adding material after client approval raises a new client approval request.
7. App Bookings: a **Material Required** chip listing jobs with draft materials
   or a sent-but-not-approved request; those cards are yellow and show
   "X Materials".

## State model

One job-level request, repeated per round. Line state is DERIVED from existing
`quotation_details` columns plus two new ones — one helper
(`services/quotation-line-state.js`) owns the derivation, SQL and JS:

| line state         | predicate                                                          |
|--------------------|--------------------------------------------------------------------|
| `draft`            | `sent_on IS NULL`                                                  |
| `review_pending`   | `sent_on IS NOT NULL AND action_on IS NULL`                        |
| `rejected`         | `action_on IS NOT NULL AND CAST(status AS UNSIGNED) = 0`           |
| `approval_pending` | `action_on IS NOT NULL AND status = 1 AND client_status IS NULL`   |
| `client_approved`  | `client_status = 1`                                                |
| `client_rejected`  | `client_status = 0`                                                |

`status` is `bit(1)` — always `CAST(status AS UNSIGNED)`; `client_status` is
TINYINT — `CAST(client_status AS SIGNED)` (db.js typeCast).

Legacy rows already carry `sent_on` (the old insert stamped it), so they read as
sent — correct.

Job-level (`material_state`, exposed on mobile list + detail and admin job):
`review_pending` if the job is 16; `approval_pending` if the job is 15;
otherwise `draft` if any draft line exists; otherwise `null`.
`material_count` = count of lines in draft / review_pending / approval_pending.

| label (app + CRM)    | job status                         |
|----------------------|------------------------------------|
| (draft, "X Materials") | unchanged                        |
| **Review Pending**   | 16, `material_sub_status = 2`      |
| **Approval Pending** | 15 (kept — owner decision)         |
| approved             | 1, same technician (unchanged)     |

`material_sub_status = 1` is no longer written.

### Pre-request status

`tbl_job_material_review.pre_material_status TINYINT NULL` (new column, side
table — `tbl_job` is at the row-size limit) records the status a job left when
it entered 16 or 15 from a non-request status (1, 2 or 20). "Return to
pre-status" below means that value, defaulting to 2.

## Locks

**AMENDED 2026-09-22** (owner decision — "once Tx clicks Send for Approval
he won't be able to edit the quotation — we provide Save for drafts.
Additional material after sending = a NEW quotation."):

- A QUOTATION is the set of lines stamped by ONE send — they share an exact
  `sent_on`. Drafts (`sent_on IS NULL`) are the NEXT quotation being built.
  No migration: this is a re-reading of columns that already exist.
- **Technician** may add / edit / delete lines ONLY in `draft` state — never
  `review_pending` any more — on a job in 1, 2, 20, 16 **or 15**. 15 is new:
  drafting the next quotation is allowed while the current one sits with the
  client. Lines in any other state (`review_pending` included) → 409
  `"This material is locked"`. Delete-all deletes only drafts.
  Send-for-approval is the ONE write still refused at 15, with its own
  message: 409 `"Your previous quotation is with the client — send this one
  after they decide"`. Because a technician can never delete a sent line any
  more, the old "deletes the last non-draft line at 16 → revert to
  pre-status" transition is unreachable and has been removed (its dead code
  and tests too) — CRM Reject Request still reverts to pre-status, unchanged.
- `sendForApproval` stamps every current draft with ONE timestamp, strictly
  later than any `sent_on` already on the job —
  `max(now, lastSentOn + 1s)`, since `quotation_details.sent_on` is a
  second-precision DATETIME — so two sends can never collide onto the same
  stamp and merge into one quotation (`services/quotation-line-state.js`'s
  `nextSentOn`).
- **CRM** may add lines while the job is 1, 2, 20, 16 or 15 (not closed /
  cancelled) — UNCHANGED. A CRM-added line is born reviewed:
  `sent_on = action_on = now`, `status = 1`, `approved_charge` = the entered
  amount.
- **Client-approved** lines are locked everywhere.

## Transitions

**AMENDED 2026-09-22**: `tech send-for-approval` from 15 is now reachable
(job-status-wise) — it 409s on its own dedicated check, not the generic
job-level write lock, and with its own message. The `tech deletes last
non-draft line` row below is REMOVED (unreachable — see "Locks").

| trigger | from | effect |
|---|---|---|
| tech send-for-approval | 1/2/20 (≥1 draft) | drafts → sent (one shared, strictly-later timestamp); job → 16 / sub 2; store pre-status |
| tech send-for-approval | 16 (≥1 draft) | drafts → sent; job stays 16 |
| tech send-for-approval | 15 | 409 `"Your previous quotation is with the client — send this one after they decide"` |
| CRM review "Send Request to Client" | 16 | unchanged (→ 15 + email), BUT every `review_pending` line must be in the payload, else **409** `"New materials were added — reload and review again"` |
| CRM "Reject Request" | 16 | all `review_pending` lines → rejected; job → pre-status; reason stored (`material_reject_reason`) |
| CRM add line | 16 | line born reviewed; job stays 16 |
| CRM add line | 15 | line born reviewed; job stays 15; client request re-sent |
| CRM add line | 1/2/20 | line born reviewed; job → 15; store pre-status; client request sent |
| client approve | 15 | job → 1 (unchanged); `approval_pending` lines → `client_status = 1, client_action_on = now` |
| client reject | 15 | job → 2/20 (unchanged); `approval_pending` lines → `client_status = 0` |

"Client request sent" = the existing
`services/material-client-request.service.js#sendMaterialClientRequest`
(fire-and-forget after commit).

## API contract

### Mobile (`routes/mobile/jobs-estimate.js`, technician-scoped)

- `GET  /mobile/jobs/:id/quotation` (existing list, whatever its current path
  is) — each line gains `state` (table above) and, **AMENDED 2026-09-22**,
  `quotationNo` — 1..n by ascending distinct `sent_on` within the job, `null`
  for a draft (computed by `services/quotation-line-state.js`'s
  `quotationNumbers`, in JS, not a SQL window function). `ponytail:` legacy
  pre-v2 rows each carry their own insert-time `sent_on`, so each shows as
  its own quotation — acceptable, display-only.
- `POST /mobile/jobs/:id/quotation` (existing single add) — now inserts a
  **draft** (`sent_on NULL`). Lock rules apply — **AMENDED 2026-09-22**:
  allowed at 15 too (drafting the next quotation).
- **NEW** `POST /mobile/jobs/:id/quotation/draft`
  `{ lines: [{ type, itemId?, materialId?, brandId?, name?, quantity, amount }] }`
  (1..50, same line shape and validation as the single add) → `{ lineIds }`,
  one transaction. Also allowed at 15.
- **NEW** `DELETE /mobile/jobs/:id/quotation` → deletes every technician-editable
  line — **AMENDED 2026-09-22**: `draft` ONLY, not `review_pending` — →
  `{ deleted: n }`. The old "last non-draft line" revert transition no longer
  applies (removed — see "Locks").
- `DELETE|POST /mobile/jobs/:id/quotation/:lineId` (existing) — lock rules;
  **AMENDED 2026-09-22**: only a `draft` line may be touched — a
  `review_pending` line now 409s `"This material is locked"` exactly like any
  other sent state, so the "last non-draft line" revert transition is
  unreachable here too.
- `POST /mobile/jobs/:id/send-for-approval` `{ checkInImageRefs?, lines? }` —
  `lines` (same shape as draft) are inserted as drafts in the SAME transaction
  first; then transitions above. No drafts at all → 422
  `"Add materials before sending for approval"`. **AMENDED 2026-09-22**: at
  15 → 409 `"Your previous quotation is with the client — send this one
  after they decide"` (its own check, distinct from the generic job-level
  write lock, which now allows 15 for every OTHER write).
- `POST /mobile/jobs/:id/material-required` — kept for older builds as an alias
  of send-for-approval (inherits its 15 message unchanged).
- Mobile job list + `GET /mobile/jobs/:id` gain `material_state` and
  `material_count` (one aggregated subquery, no N+1).

### Admin

- `GET /admin/quotations?jobId=` — each row gains `state` and, **AMENDED
  2026-09-22**, `quotation_no` (same `quotationNumbers` helper as the mobile
  list above — one shared implementation, not a second copy).
- `PATCH /admin/quotations/:id/approve|reject` — only on `review_pending`
  lines, else 409.
- `POST /admin/jobs/:id/material-review` — "pending" now also requires
  `sent_on IS NOT NULL`; a missing / extra line → **409**; reject → pre-status.
- **NEW** `POST /admin/jobs/:id/quotation-lines`
  `{ materialId, brandId?, quantity, approvedAmount }` behind
  `scopedJob` + `requireAction('isJobMaterialReview')` → `{ lineId, job_status }`.
  `unit_price = round(approvedAmount)`, `client_charge` = resolved rate-card
  price (NULL when none), `name` = master material name.
- `GET /admin/aux/materials/job/:jobId` — filtered to
  `type IS NULL OR type = 'Material'` (Travel / Penalty / Incentive rows are
  billing, shown by the Billing tab).
- Admin job detail exposes `material_state` / `material_count`.

### Client

- The existing 15 approve / reject handlers stamp `client_status` /
  `client_action_on` on the `approval_pending` lines in the same transaction.

## Migration

`migrations/2026-09-21-material-request-flow-v2.sql`, one statement per line:

```sql
ALTER TABLE quotation_details ADD COLUMN client_status TINYINT NULL;
ALTER TABLE quotation_details ADD COLUMN client_action_on DATETIME NULL;
ALTER TABLE tbl_job_material_review ADD COLUMN pre_material_status TINYINT NULL;
```

## App

- `EstimateBuilder`: added lines are staged locally; **Save** → `quotation/draft`;
  per-line delete (staged: local; saved: DELETE); **Delete All** next to Save
  (confirm) → local clear + `DELETE /quotation`. Leaving the order screen with
  staged lines prompts **Save** / **Send for Approval** / Discard. Lines whose
  `state` is not `draft`/`review_pending`, and everything at 15, are read-only;
  Add hides at 15.
- Order footer: when the job has any draft or staged line, **Send for Approval**
  replaces Complete Job (sends staged lines in the body). At 16 / 15 a chip
  shows Review Pending / Approval Pending. The Material Required button is
  removed. The estimate section is visible and editable at 16.
- Bookings: a **Material Required** filter chip (`material_state` not null);
  matching cards use the warning (yellow) surface and show "X Materials".
- i18n in all 8 locales.

## CRM

- Job modal: the Materials tab is removed; **Quotations** shows the
  `quotation_details` lines with a state chip (Draft · Review Pending ·
  Approval Pending · Approved · Rejected · Client Rejected), Approve/Reject only
  on Review Pending, an **Add Material** button (`isJobMaterialReview`, job in
  1/2/20/16/15) and a read-only "Legacy Materials" block (the filtered aux
  list) when it has rows.
- Material Review modal: **Add Material** row; a 409 shows the message and
  reloads the lines.
- Pending for Material (My Orders / Jobs): stage statuses `[16, 15]`; the status
  column shows Review Pending (16) / Approval Pending (15); the Material Review
  action stays 16-only. Existing tabs that already list 15 keep it.

## Testing (each check made to fail once)

- draft insert → send → 16/2 with pre-status stored; send at 15 → 409; send
  with no drafts → 422; send with body `lines` inserts them atomically.
- technician delete at review_pending allowed; at approval_pending → 409;
  deleting the last sent line at 16 → pre-status.
- material-review with a review_pending line missing → 409; drafts are ignored
  by the review.
- CRM add at 2 → 15 + client request sent; at 15 → stays 15, re-sent; at 16 →
  stays 16.
- client approve stamps only approval_pending lines.
- mobile list `material_state` / `material_count` for draft / 16 / 15 / none.
- CRM: build + tests; app: `tsc` + tests; QA APK + TestFlight build; deck.
