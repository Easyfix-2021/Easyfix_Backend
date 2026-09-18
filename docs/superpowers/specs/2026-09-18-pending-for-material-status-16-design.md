# Pending for Material (status 16) — design

Date: 2026-09-18
Status: derived from the owner's recorded phase-2 decisions (2026-09-17)
Scope: sub-project **D** of Material Management phase 2
Repos: `EasyFix_Backend`, `Easyfix_CRM_UI`, `Easyfix_client_UI`, `Easyfix_Technician_Mobile_Application`

## Why

A technician who cannot close a job because material is needed today calls
`send-for-approval`, which sets `job_status = 15` directly. 15 means "Client
Approval Pending", and the client portal treats every 15 as a quote awaiting the
client. So an unreviewed quote reaches the client with no internal review, which
the T&C (D.5) requires.

Owner decision: a new status **16 "Pending for Material"** sits before 15, with
two sub-states — Quotation Pending, then Review Pending. Codes 16 and 17 were
confirmed unused across the backend and the legacy CRM.

## Flow

```
2 / 20  Pending to Close on App
   │  tech: "Material Required"
   ▼
16  Pending for Material · Quotation Pending      (tech builds the estimate)
   │  tech: Send for Approval
   ▼
16  Pending for Material · Review Pending         (PM reviews in the CRM)
   │  PM approves  ─────────────► 15  Client Approval Pending
   │  PM rejects   ─────────────► 16 Quotation Pending (with a reason to the tech)
   ▼
15  client approves ───────────► 1  Pending to Start   (SAME technician stays assigned)
    client rejects  ───────────► 2/20 Pending to Close on App
```

Rules from the owner:

- After client approval the job keeps its assigned technician; Ops reassigns by
  hand if needed. No auto-assign.
- A client rejection does not loop back to a quote. The job returns to 2/20, the
  technician and Ops both see it, and the ₹300 visiting charge (T&C B.3) applies.
- "Appointment / permission required" is ticked **per job at approval time**, and
  drives the +1 vs +3 day reschedule. It is not a store or branch setting.
- Partners and clients see a status-16 job with a **View Details action only**.

## Data model

```
ALTER TABLE tbl_job ADD COLUMN material_sub_status TINYINT NULL
ALTER TABLE tbl_job ADD COLUMN permission_required TINYINT NOT NULL DEFAULT 0
```

`material_sub_status`: 1 = Quotation Pending, 2 = Review Pending, NULL when the
job is not at 16. It is deliberately a column and not derived from the quotation
rows: "the technician has sent this for review" is a decision, not a row count,
and deriving it would make a deleted line silently un-send a quote.

Both are `TINYINT`, so every select that exposes them uses `CAST(... AS SIGNED)`
(`db.js` typeCast returns booleans for `TINYINT(1)`).

## Backend

1. `services/job.service.js` — add `PENDING_FOR_MATERIAL: 16` to `STATUS` and to
   `ALL_STATUS_VALUES`. Without this, `setStatus()` rejects the code outright.
2. `utils/job-status-label.js` — label "Pending for Material".
3. `routes/mobile/jobs-estimate.js` / `services/mobile-job-estimate.service.js`:
   - New `POST /mobile/jobs/:id/material-required` — 2/20 → 16 with
     `material_sub_status = 1`.
   - `send-for-approval` sets 16 / sub-status 2 instead of 15. This is the
     behaviour change that makes the review real.
4. New `POST /admin/jobs/:id/material-review` `{decision: 'approve'|'reject',
   reason?, permission_required}`:
   - approve → 15, clears `material_sub_status`, stores `permission_required`.
   - reject → 16 sub-status 1, reason to the technician, quote stays editable.
   - Gated by a new action key `isJobMaterialReview`, seeded to the PM role.
5. Client approval of a 15 that arrived this way moves the job to **1**, keeping
   `fk_easyfixter_id` unchanged; rejection moves it to **2/20**. This is the one
   place the client's decision writes a status, and it goes through
   `jobService.setStatus()` so webhooks fire normally. It must NOT reuse the
   hold-release path, which sets 10.
6. `services/integration.service.js` stays FROZEN — the partner status map is a
   published contract and 16 is not added to it. Partner-facing readers map 16
   to the same bucket 15 already uses.

## Readers to update

An earlier sweep enumerated every status reader. Backend: `job-status-label.js`,
`job.service.js` STATUS, `routes/admin/jobs.js` export labels,
`routes/client/index.js` stage labels and the `job_status = 15` counts,
`job-export.service.js` label switches, the QuickSight bucket constants,
`mobile-dashboard.service.js`'s 15 carve-out. CRM: `lib/utils.ts` `ST` +
`statusLabel`, `lib/job-buckets.ts` (16 joins `open`), `lib/job-stages.ts` (a new
`pending-material` stage with its transition targets), `lib/job-tabs.ts` (a
"Pending for Material" tab), the dashboard and job list pages. Client portal:
`lib/utils.ts` labels, `lib/open-book.ts` `OPEN_STATUSES`, the job list and
dashboard counts, and the parity test that compares the client's open-status list
with the server's.

## UI

- **CRM:** a "Pending for Material" tab beside Estimate Pending, showing sub-state
  as a chip. The job modal gains a Material Review panel for sub-status 2: the
  quoted lines with their price source, an **Approve** action carrying the
  "Appointment / Permission Required" tick, and **Reject** with a reason.
- **Client portal:** status 16 renders with a View Details action only — no
  approve or reject affordance, since the quote has not been reviewed yet.
- **App:** a "Material Required" action on a 2/20 job; while at 16 the estimate
  stays editable in sub-state 1 and read-only in sub-state 2, with the PM's
  reject reason shown when it comes back.

## Testing

1. `setStatus` accepts 16 and rejects 17 (positive control that the enum guard
   still works).
2. send-for-approval sets 16/2, never 15 — the regression this whole flow exists
   to prevent.
3. Material review approve → 15 and stores `permission_required`; reject → 16/1
   with the reason.
4. Client approve on a material-flow 15 → 1 with the SAME `fk_easyfixter_id`
   (assert the technician id is unchanged); client reject → 2/20.
5. The client portal shows no approve action at 16, and 16 is in `OPEN_STATUSES`
   (the existing parity test covers the list).
6. `services/integration.service.js` is unchanged — a guard test asserting its
   status map has no 16.
7. TINYINT cast guards for both new columns.

## Out of scope

- Reconciling the +1 / +3 permission rule with T&C C.4's value-based D+1/D+2/D+3
  (still open with the owner).
- Auto-assigning a different technician when the original is unavailable.
