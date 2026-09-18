# Ops Material Approval — design

Date: 2026-09-18
Status: owner-approved (2026-09-18)
Scope: sub-project **E** of Material Management phase 2 (follows D)
Repos: `EasyFix_Backend`, `Easyfix_CRM_UI`, `Easyfix_client_UI`

## Why

Owner: "For a Material Quotation raised by the technician from the app, instead
of directly showing it on the Client Dashboard for approval, gate it in the CRM.
Ops approves each material and the approved amount, and only that amount is
visible in the Client Dashboard for the client's approval. In Pending for
Material, Ops reviews the Quoted Amount and adds an Approved Amount (prefilled
with the quoted amount, editable) for each material and submits."

Measured starting point (2026-09-18 sweep, cited in the sub-project D work):

- A technician's material line is a `quotation_details` row with `type='material'`
  and a server-resolved `unit_price` (never the app's number).
- **No file under `routes/client/` or `routes/public/` reads `quotation_details`
  at all.** The client's estimate preview
  (`GET /client/jobs/:id/estimate-preview` → `services/job-line-total.js`) sums
  `tbl_job_services.total_charge × quantity + material_charge`, and NOTHING in
  the codebase writes `tbl_job_services.material_charge`.
- So today the technician's materials never reach the client. The gate the owner
  asked for exists by accident; the work is to build the bridge, with Ops in the
  middle.
- `quotation_details` already carries `approved_charge`, `action_by`, `action_on`
  and `status`, written today by `PATCH /admin/quotations/:id/approve` from the
  CRM Quotations tab (`isQuotationApprove`). The new flow reuses those columns
  rather than adding any.
- **The status scheme is NOT 0 pending / 1 approved / 2 rejected.** That legend
  lives only in a stale CRM comment; no code writes a 2. Verified against the
  writers and readers (`services/mobile-job-estimate.service.js`'s INSERT,
  `routes/admin/quotations.js`, and the EXISTS filters in
  `services/job.service.js` + `services/job-export.service.js`, which all pair
  the status with `action_on IS NOT NULL`):
  - inserted by the app → `status = 1`, `action_on` NULL — **pending**
  - approved → `status = 1`, `action_on` stamped
  - rejected → `status = 0`, `action_on` stamped
  `action_on` is what separates reviewed from unreviewed; reading `status` alone
  shows every freshly quoted line as approved, which is exactly the bug the CRM
  Quotations tab shipped with.

## Decisions (owner, 2026-09-18)

1. Ops can **reject a line** as well as edit its amount. A rejected line is not
   sent to the client. "Approve at ₹0" is not the way to drop a line.
2. The approved total drives **what the client sees and approves only**. Job
   billing is unchanged in this release; the invoice side is a separate piece.

## Flow

```
tech adds material lines (quotation_details, action_on NULL, unit_price = resolved)
        │  Send For Approval
        ▼
16 · Review Pending — Ops opens Material Review in the CRM
        │  per line: Approved Amount (prefilled = quoted) or Reject
        │  Submit
        ▼
approved: status 1 + approved_charge + action_on    rejected: status 0 + action_on
        │  job moves to 15 in the SAME transaction
        ▼
client dashboard shows the APPROVED lines and amounts → client approves/rejects
```

## Backend

`POST /admin/jobs/:id/material-review` (built in sub-project D, gated by
`isJobMaterialReview`) gains an optional `lines` array:

```json
{ "decision": "approve",
  "permission_required": 0,
  "lines": [ { "line_id": 91, "decision": "approve", "approved_amount": 450.00 },
             { "line_id": 92, "decision": "reject" } ] }
```

Rules:

- Every pending `type='material'` line on the job must appear exactly once in
  `lines` when `decision` is `approve`; a missing or unknown line is 422. Ops
  cannot half-review a job by accident.
- `approved_amount` is required and `>= 0` on an approved line, forbidden on a
  rejected one.
- Line writes and the status move to 15 happen in ONE transaction. A job never
  reaches the client with some lines unreviewed.
- An approved line gets `approved_charge`, `status = 1`, `action_by`,
  `action_on`; a rejected line gets `status = 0` with the same stamps (see the
  status-scheme note above).
- `decision: 'reject'` (the whole review) leaves every line unreviewed
  (`action_on` still NULL) so the technician can revise and resend.
- A job at 16 with no material lines is still approvable (the quote may be
  service-only) — `lines` is then empty.

New client-facing read, so the client sees ONLY what Ops approved:

- `services/job-line-total.js` gains approved material lines to the preview it
  builds: each line's `name`, `unit` (qty) and `approved_charge`, summed into a
  `material_subtotal` that joins `grand_total`.
- The query filters `type = 'material' AND status = 1 AND action_on IS NOT NULL`
  — an unreviewed line (action_on NULL) or a rejected one (status 0) is never
  returned, and a job that has not reached 15 has no
  approved lines by construction.
- `GET /client/jobs/:id/estimate-preview` and the public magic-link estimate
  read the same helper, so both agree.
- The technician's `unit_price` is NEVER projected to a client surface.

## CRM

The Material Review panel in `JobModal.tsx` (sub-project D) becomes a table:

| Item | Qty | Quoted Amount | Approved Amount | Reject |
|---|---|---|---|---|

- Quoted Amount is read-only (`unit_price × unit`).
- Approved Amount is an editable number input, prefilled with the quoted amount.
- Reject is a per-row toggle; a rejected row's amount input is disabled.
- A footer shows Quoted Total and Approved Total, so Ops sees what changed.
- Submit posts the `lines` array with the approve decision and the existing
  Appointment / Permission Required tick.
- Approve is blocked while any non-rejected row has a blank or negative amount.
- Everything stays gated by `isJobMaterialReview`.

## Client portal

The estimate view gains a **Materials** section listing each approved line with
its approved amount, above the existing total, and the grand total includes the
material subtotal. Nothing there exposes the quoted amount or a rejected line.

## Testing

Backend, each check made to fail on purpose first:

1. Approve writes each line's `approved_charge` + `status = 1` + `action_on`,
   rejected lines `status = 0` + `action_on`, and the job lands at 15 — all in one transaction (a failing
   line write leaves the job at 16).
2. A missing line, an unknown `line_id`, a negative amount, or an amount on a
   rejected line → 422, and the job stays at 16.
3. The client preview returns ONLY reviewed-and-approved material lines and
   their `approved_charge` — positive control: a pending and a rejected line on the
   same job are absent, and the quoted `unit_price` appears nowhere in the
   payload.
4. `material_subtotal` and `grand_total` include the approved amounts.
5. A review reject leaves every line unreviewed (action_on still NULL).

CRM: `npm test` (its full gate). Client portal: `npm test`.

## Out of scope

- Writing the approved material total into job billing / invoices (owner
  decision 2 — a separate piece).
- Letting the client approve individual lines; client approval stays job-level.
- Editing an approved amount after the client has approved.
