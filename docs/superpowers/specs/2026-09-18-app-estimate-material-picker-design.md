# App Estimate Material Picker — design

Date: 2026-09-18
Status: derived from the owner's recorded phase-2 decisions
Scope: sub-project **B** of Material Management phase 2
Repos: `EasyFix_Backend`, `Easyfix_Technician_Mobile_Application`
Depends on: **C** (price resolver) and **A** (material add requests)

## Why

Owner decision (2026-09-17): "App Estimate screen material picker — master-list
materials ONLY, plus an Others option; choosing Others raises a new material add
request."

Today `EstimateBuilder.tsx`'s `AddMaterialSheet` is a free-text name plus a
typed price, and the line it writes leaves `quotation_details.material_id` NULL.
So material lines are unpriced by the master, unmatchable in reporting, and
create no master data.

## Backend

New endpoint beside the existing rate-card one, in
`routes/mobile/jobs-estimate.js` (behind `requireTechAuth`):

```
GET /mobile/jobs/:id/materials?search=<term>
->  { items: [ { material_id, material_name, uom_name, pricing_type,
                 brands: [ { brand_id, brand_name, price, price_source } ],
                 price, price_source } ] }
```

- Materials are filtered to the job's `service_catg_id` and `status = 1`.
- Every price comes from `resolveMaterialPrice()` (sub-project C) with the job's
  `client_id` and the job's state, so a client override wins over the master and
  the app never computes a price itself.
- `price_source` (`client_state` | `client_group` | `master_state` |
  `master_group` | `none`) rides along so the app can show where the price came
  from and, for `none`, let the technician type one.
- A material whose brands resolve to different prices returns one entry per
  brand; the technician picks the brand, and that choice sets the price.

`POST /mobile/jobs/:id/quotation` gains `material_id` and `brand_id` for
`type: 'material'` lines:

- `material_id` is required for material lines (the free-text path is removed),
  except when the line was raised through the Others flow.
- The server re-resolves the price from `material_id` + `brand_id` and stores
  THAT, ignoring any price in the payload unless `price_source` is `none`.
  A price the client sends is a suggestion, never the stored value — otherwise a
  modified app could quote any number it liked.
- The write gains an `Idempotency-Key`, which the current quotation writes lack.

## App

`src/features/jobs/components/EstimateBuilder.tsx` — `AddMaterialSheet` becomes:

1. A `SearchSelect` over `GET /mobile/jobs/:id/materials`, showing name, UOM and
   resolved price, with an appended **Others** option (the same sentinel pattern
   `AddProductSheet` already uses for rate cards).
2. A brand `SearchSelect`, shown only when the chosen material has brands.
3. Quantity, always editable.
4. Price: read-only and labelled with its source when the resolver returned one;
   editable only when the source is `none`.
5. Choosing **Others** swaps the sheet for a request form — material name, brand
   (optional), expected price, quantity, note — which POSTs
   `/mobile/jobs/:id/material-request` (sub-project A) with an idempotency key,
   and closes with a "sent for approval" toast. It does NOT add a quotation line.
6. The job's pending requests are listed under the materials section with their
   status, so the technician can see the review is outstanding, and its reject
   reason once reviewed.

Offline: the request POST goes through the existing queue in `src/lib/offline.ts`
like other writes; the materials GET is online-only (an empty list with a "no
connection" note is better than a stale price).

## Testing

Backend:
1. The materials list is scoped to the job's service category, and the resolved
   price matches `resolveMaterialPrice` for the job's client and state (assert
   against a client override, a master state price and a master group price).
2. A quotation material line stores the RESOLVED price, not the payload price —
   positive control: send a different price and assert the stored value.
3. A material line without `material_id` is rejected (422) unless it came from
   the Others flow.
4. Idempotency: the same key twice creates one line / one request.

App: a component test that Others opens the request form and never adds a line,
and that a picked material's price field is read-only when a price resolved.

## Out of scope

- Editing an existing quotation line's material (delete and re-add, as today).
- Showing the client's own material rate card in the app.
