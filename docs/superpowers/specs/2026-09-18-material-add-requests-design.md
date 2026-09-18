# Material Add Requests — design

Date: 2026-09-18
Status: derived from the owner's recorded phase-2 decisions; built in the same pass as C, B and D
Scope: sub-project **A** of Material Management phase 2
Repos: `EasyFix_Backend`, `Easyfix_CRM_UI` (the app side is wired in sub-project B)

## Why

Owner decision (2026-09-17): on the technician app's Estimate screen the material
picker offers master-list materials ONLY, plus an "Others" option, and **Others
raises a new-material add request** — not a free-text line.

Today `quotation_details` accepts a free-text material name with a typed price
(`services/mobile-job-estimate.service.js`), so anything a technician types
becomes a priced line nobody has approved, and the master never learns about it.

## Data model

One new table. It is a request log, not a second master: approving it creates a
normal `tbl_material_master` row through the phase-1 service, so there is exactly
one place a material can be born.

```
tbl_material_add_request
  request_id        INT AUTO_INCREMENT PRIMARY KEY
  material_name     VARCHAR(200)  NOT NULL   -- as typed by the technician
  brand_name        VARCHAR(150)  NULL       -- optional, as typed
  service_catg_id   INT           NOT NULL   -- taken from the job, not the app
  job_id            INT           NULL       -- the job it was raised from
  efr_id            INT           NULL       -- requesting technician
  expected_price    DECIMAL(12,2) NULL       -- what the tech expected to charge
  qty               DECIMAL(12,2) NULL
  note              VARCHAR(500)  NULL
  request_status    TINYINT       NOT NULL DEFAULT 1   -- 1 pending, 2 approved, 3 rejected
  reject_reason     VARCHAR(500)  NULL
  material_id       INT           NULL       -- master row created on approval
  reviewed_by       INT           NULL       -- tbl_user id
  reviewed_at       DATETIME      NULL
  created_at        DATETIME      NOT NULL
  KEY ix_status_created (request_status, created_at)
  KEY ix_job (job_id)
```

`service_catg_id` comes from the job on the server, never from the app payload:
the phase-1 uniqueness key is `(material_key, service_catg_id)`, so letting the
client choose it would let a technician create a duplicate in another category.

## API

Mobile (under `routes/mobile/jobs-estimate.js`, behind `requireTechAuth`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/mobile/jobs/:id/material-request` | Raise a request `{material_name, brand_name?, expected_price?, qty?, note?}` |
| GET | `/mobile/jobs/:id/material-requests` | This job's requests with their status, so the app can show "pending review" |

The POST takes an `Idempotency-Key` header, like `checkout` and `job-images`.
The existing quotation writes do not, which is a known gap — a new write must not
repeat it. A duplicate key returns the first request rather than creating a
second.

Admin (new `routes/admin/material-requests.js`):

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/admin/material-requests` | `isMaterialView` | List with `status` filter, search, pagination |
| GET | `/admin/material-requests/count` | `isMaterialView` | Pending count for the badge |
| POST | `/admin/material-requests/:id/approve` | `isMaterialAddNew` | Create the master material and link it |
| POST | `/admin/material-requests/:id/reject` | `isMaterialAddNew` | `{reject_reason}` required |

Approve takes the same body as "Add Material" in phase 1 (name, category, UOM,
pricing type, price groups), prefilled from the request but fully editable — the
reviewer decides the real name, category and price. It calls the phase-1
`createMaterial` service inside the same transaction that stamps the request, so
a failed material create leaves no half-approved request.

Rules:

- Approving a request whose name already matches an active master material
  returns 409 naming that material, with the option to link the request to it
  instead of creating a duplicate (`{link_material_id}` on the approve body).
- A request already approved or rejected returns 409 (terminal, idempotent).
- Reject requires a reason; it is shown to the technician in the app.

## UI

`Settings › Manage Materials` gains a third card, **Material Requests**, above
Materials:

- Tabs Pending / Approved / Rejected, with the pending count in the heading.
- Columns: Material, Brand, Category, Raised By, Job, Expected Price, Raised On,
  actions Approve / Reject (both gated by `isMaterialAddNew`).
- Approve opens the phase-1 `MaterialDialog` prefilled from the request; saving
  calls the approve endpoint rather than the plain create endpoint.
- Reject opens a small dialog requiring a reason.
- Every mutation refreshes the requests list and busts the material lookups, the
  same `invalidateFetch` treatment phase 1 needed.

## Testing

1. Service: approve creates the master material and stamps the request in one
   transaction; a failing create rolls back both.
2. Approve on an already-reviewed request → 409; reject without a reason → 422.
3. Duplicate name → 409 naming the existing material; `link_material_id` links
   instead of creating.
4. `service_catg_id` is read from the job, and a value supplied in the payload is
   ignored (positive control: send a different one and assert the stored value).
5. Idempotency: the same key twice creates one row.
6. RBAC: approve/reject require `isMaterialAddNew`; list requires
   `isMaterialView`.
7. TINYINT cast guard on `request_status`.

## Out of scope

- Notifying the technician by push when a request is reviewed (the app polls the
  job's requests; push can be added later).
- Bulk approve.
