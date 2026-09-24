# Client Material Rates — design

Date: 2026-09-18
Status: approved by the owner (2026-09-18), ready for an implementation plan
Scope: sub-project **C** of Material Management phase 2
Repos: `EasyFix_Backend`, `Easyfix_CRM_UI`

## Why

Phase 1 shipped a material master (Settings › Manage Materials): each material
carries price groups (a group = a set of brands + a price) and, nested inside a
group, optional state overrides. Every client pays those master prices.

Clients negotiate their own material rates. This sub-project lets an operator
record, for one client, a different price for a material — by brand group and,
inside a group, by state — while everything not overridden keeps quoting at the
master price.

Sub-project B (the technician app's Estimate material picker) prices its lines
through the resolver defined here. C ships first so B has the full lookup on
day one.

## Decisions (owner, 2026-09-18)

1. A client override mirrors the master shape: price per brand group, with
   optional state overrides nested in the group.
2. The client card is a curated exception list. An operator adds a material to
   a client before it can carry a client price. Materials not on the card stay
   quotable at the master price — the card never restricts what can be quoted.
3. When a master price changes, client prices do not move. The affected client
   row is flagged for review; an operator accepts or takes the master price.
4. Permissions reuse the client rate-card ones: client view to read,
   `isClientEdit` to write. No new action keys, no RBAC migration.
5. The UI is a Materials section inside the client's existing Rate Cards tab.

## Data model

Three new tables plus one join table, mirroring the phase-1 master shape
(`tbl_material_price_group` / `_brand` / `tbl_material_state_price` / `_state`)
and scoped by `client_id`. The master tables are NOT modified: a nullable
`client_id` on the master tables was rejected, because every existing phase-1
query would then need `client_id IS NULL` and one missed predicate leaks one
client's price into the master or into another client's quote.

```
tbl_client_material_price_group
  group_id          INT AUTO_INCREMENT PRIMARY KEY
  client_id         INT           NOT NULL
  material_id       INT           NOT NULL
  price             DECIMAL(12,2) NOT NULL   -- client prices are never "pending"
  master_price_seen DECIMAL(12,2) NULL       -- master price when last saved/accepted
  status            TINYINT       NOT NULL DEFAULT 1
  created_by / created_at / updated_by / updated_at
  KEY ix_client_material (client_id, material_id)

tbl_client_material_price_group_brand
  id          INT AUTO_INCREMENT PRIMARY KEY
  group_id    INT NOT NULL
  client_id   INT NOT NULL
  material_id INT NOT NULL
  brand_id    INT NOT NULL
  UNIQUE KEY uq_client_group_brand (client_id, material_id, brand_id)

tbl_client_material_state_price
  state_price_id INT AUTO_INCREMENT PRIMARY KEY
  group_id       INT           NOT NULL
  client_id      INT           NOT NULL
  price          DECIMAL(12,2) NOT NULL

tbl_client_material_state_price_state
  id             INT AUTO_INCREMENT PRIMARY KEY
  state_price_id INT NOT NULL
  group_id       INT NOT NULL
  state_id       INT NOT NULL
  UNIQUE KEY uq_client_group_state (group_id, state_id)
```

Notes:

- `uq_client_group_brand` is the client-scoped twin of phase 1's
  `uq_group_brand_material`: one brand appears in at most one group per client
  per material.
- Adding a material to a client's card creates its group rows. Removing the
  material deletes them (its groups, brands, state prices and state rows in one
  transaction), and the client falls back to the master.
- The "No Brand" mode from phase 1 applies unchanged: a single group with no
  brands is legal only as the sole group for that material. Unlike the master,
  its price is REQUIRED — a client row exists only to state a price.
- `status` is `TINYINT`, so `db.js` typeCast returns a boolean. Every select
  that exposes it uses `CAST(status AS SIGNED)`, guarded by a test
  (see Testing).
- Migration style follows `feedback_easyfix_minimal_migration_style`: one
  statement per line, `CREATE TABLE IF NOT EXISTS`, no `@set`/`PREPARE`, and it
  must be idempotent on re-run. No RBAC seed rows (decision 4). It lands in
  `migrations/`, never in `migrations/executed/`.

## Price resolution

One shared module, `services/material-price-resolver.js`, is the single place
that answers "what does this material cost?". CRM quoting, sub-project B and
any later rate-change prompt call it rather than writing their own SQL.

```
resolveMaterialPrice({ clientId, materialId, brandId, stateId })
  -> { price: number|null, source: 'client_state'|'client_group'|'master_state'|'master_group'|'none', groupId }
```

Order, first hit wins:

1. `client_state` — the client's state price for the group holding `brandId`.
2. `client_group` — the client's group price for `brandId`.
3. `master_state` — the master state price for the group holding `brandId`.
4. `master_group` — the master group price for `brandId`.
5. `none` — no price anywhere; the caller must ask for a manual price. This is
   the phase-1 "Price Pending" case (a FIXED material imported without a price).

Rules:

- A missing `brandId` (the No Brand case) resolves against the sole group.
- A missing `stateId` skips steps 1 and 3.
- A client group with no state entry for `stateId` falls to step 2, NOT to the
  master state price: once a client sets a price for a brand, the master's state
  variation no longer applies to them.
- `source` is returned so callers can label a line "client rate" or "master
  rate" without a second lookup.

## Master-change review

No fan-out writes when a master price changes. `master_price_seen` on the
client group row stores what the master price was when the row was last saved
or accepted. The client list query resolves today's master price for the same
brand set and compares.

- `master_price_seen IS NULL` (rows created before this column is populated, or
  by a data fix) → no flag.
- `master_price_seen <> master price today` → the row shows
  `master changed ₹<seen> → ₹<today>` with two actions:
  - **Accept** — stamps `master_price_seen` to today's value; the client price
    does not change.
  - **Update** — sets the client price to the master price and stamps
    `master_price_seen`. Just a normal save; no separate endpoint.
- Phase 1's `onMaterialPricesChanged(materialId, diff)` hook stays a no-op. It
  is deliberately not used: a derived comparison cannot drift out of sync with
  the master the way a copied flag column can.

## API

All under the existing client routes (`routes/admin/clients.js`), so the client
scope-guard and `requireClientEdit` (`isClientEdit`) already in that file apply.
Paths are kebab-case per `feedback_easyfix_route_casing`.

| Method | Path | Gate | Purpose |
|---|---|---|---|
| GET | `/admin/clients/:clientId/material-rates` | client view | The client's materials: groups, brands, state prices, today's master price, review flag |
| GET | `/admin/clients/:clientId/material-rates/options` | client view | Master materials not yet on this client's card (for the Add picker) |
| PUT | `/admin/clients/:clientId/material-rates/:materialId` | `isClientEdit` | Full replace of that material's groups + states for this client (also the Add path) |
| DELETE | `/admin/clients/:clientId/material-rates/:materialId` | `isClientEdit` | Remove the override; the client falls back to master |
| POST | `/admin/clients/:clientId/material-rates/:materialId/accept-master` | `isClientEdit` | Stamp `master_price_seen`; price unchanged |

Request body for PUT mirrors the phase-1 material payload, minus the master-only
fields:

```json
{ "groups": [ { "brand_ids": [5, 8], "price": 250.00,
                "states": [ { "state_ids": [12], "price": 275.00 } ] } ] }
```

Validation (Joi, 422 on failure), reusing the phase-1 rules:

- A brand appears in at most one group.
- Every `brand_id` / `state_id` exists and is active.
- `price` is required and `> 0` on every client group and state entry.
- `brand_ids: []` is legal only as the sole group (No Brand mode) and cannot be
  mixed with branded groups.
- The material exists and is active. Adding and editing are the same call: PUT
  creates the client's rows when it has none and replaces them when it does.

Responses use `modernOk` / `modernError` like the rest of the admin routes.

## UI

`Easyfix_CRM_UI/src/components/client/RateCardsTab.tsx` gains a **Materials**
section below the existing service grid:

- A table: Material, Brand Groups (brands + price per group), States (count),
  Master flag, row actions Edit / Remove (Remove asks via `useConfirm()`; no
  native dialogs).
- **Add Material** — a `SearchSelect` over the options endpoint, opening the
  same editor as Edit.
- The editor is a dialog reusing `src/components/ui/price-tree.tsx` unchanged,
  which is what phase 1 built it for (its header comment already names the
  client rate card as the intended second consumer). `requirePrice` is on.
- A one-line note under the heading: materials not listed here quote at the
  master price.
- Everything is read-only when `canEdit` is false, matching the tab's existing
  behaviour.
- Data comes from `@/lib/hooks` `useFetch`; every mutation calls `refetch()` and
  `invalidateFetch` for the options key, per `feedback_crm_ui_fetch_hooks`.
- Labels are Title Case per `feedback_easyfix_label_casing`; type sizes stay at
  or above the 12px floor enforced by `check:brand`.

## Testing

Backend (`node:test` + the fake-pool harness), each check first made to fail on
purpose:

1. Resolver: one test per branch — `client_state`, `client_group`,
   `master_state`, `master_group`, `none` — plus the two rules above (no
   `stateId`, and a client group without that state NOT falling to
   `master_state`).
2. Validation guards: duplicate brand across groups → 422, missing price → 422,
   mixing No Brand with a branded group → 422.
3. Review flag: `master_price_seen` equal → no flag; different → flag with both
   values; NULL → no flag.
4. TINYINT cast guard, in the shape of
   `tests/manage-materials-tinyint-cast.test.js`: the select must
   `CAST(status AS SIGNED)` (fake-pool rows return numbers and cannot catch it).
5. Route gate: write endpoints require `isClientEdit`; the client scope-guard
   rejects a material-rate id belonging to another client.

CRM: `npm test` is the gate (brand:verify → check:brand → typecheck →
test:build → node tests), run before any push.

Manual QA on the QA environment: add a material to a client, quote both an
overridden and a non-overridden material, change the master price and confirm
the flag appears and Accept clears it.

## Out of scope

- Effective dates / versioning of client prices, and any approval workflow on a
  client price (not requested; YAGNI).
- Bulk import of client material rates (the master has one; add later if asked).
- Sub-projects A (material add requests), B (app Estimate picker) and D
  (Pending for Material, status 16). Each gets its own spec.

## Delivery

Migration first on QA (never Prod without an explicit instruction), then
backend, then CRM — each promoted only after the owner's explicit yes, with the
served-build guard in `easyfix-deploy.mjs` respected (never remove a colleague's
deployed work).

## 2026-09-24 — Tx Share

Owner-approved, implemented alongside the CRM built in parallel against this
section as the contract.

**Concept**: a client's material rate now carries a **Tx Share** — the
technician's charge on top of the material Price — alongside the Price. The
CLIENT is asked to approve Price + Tx Share (shown as one combined rate on
the letterhead PDF, never the split); the TECHNICIAN only ever sees the
Price. Default Tx Share = 20% of the price, rounded to 2dp.

### Schema

`migrations/2026-09-24-client-material-tx-share.sql` adds
`tx_share DECIMAL(12,2) NULL` to `tbl_client_material_price_group` and
`tbl_client_material_state_price` (the two client tables only — the MASTER
tables carry no such column; a master hit always computes 20% on the fly).
Backfill: `tx_share = ROUND(price * 0.2, 2) WHERE tx_share IS NULL`. NULL
(pre-migration rows, or a data fix) reads as the same computed 20% at every
call site — the column is never a required write.

### API

- `GET`/`PUT`/`POST .../batch` on `/:clientId/material-rates*` — every group
  and every state override carries `tx_share`. On write: optional, a number
  `>= 0` with at most 2 decimal places (Joi `precision(2)` at the route,
  which rounds; `client-material-rates.service.js#invalidTxShare` rejects at
  the SERVICE level for callers that skip Joi, e.g. the bulk-upload parser).
  Omitted/null → `ROUND(price * 0.2, 2)`. Reads always return a value — NULL
  legacy → computed 20%.
- **NEW** `GET /:clientId/material-rates/master-rows?search=&limit=` →
  `{ items: [{ material_id, material_name, brand_id, brand_name, label,
  price, state_prices: [{state_id, state_name, price}] }] }` — one row per
  active master material x active brand (`tbl_material_price_group` +
  `_brand`); a No-Brand material (or a group whose brands are all now
  inactive) gives brand_id/brand_name null. Same read-level guard as the
  other material-rates GETs; for the CRM's "Add Material" picker behind
  `POST /admin/jobs/:id/quotation-lines`. `services/material.service.js#masterRows`.

### Resolver

`services/material-price-resolver.js#resolveMaterialPrice` returns a new
`tx_share` field alongside `price`/`source`/`groupId`:

| source | tx_share |
|---|---|
| `client_state` | that state row's own `tx_share` (NULL → 20% of that row's price) |
| `client_group` | the group's own `tx_share` (NULL → 20% of the group's price) |
| `master_state` / `master_group` | always `ROUND(price * 0.2, 2)` — no column on the master tables |
| `none` | `null` |

`defaultTxShare(price)` (the shared 20%-rounded-to-2dp helper) is exported
alongside `resolveMaterialPrice` and reused everywhere else this document
says "20% default" — the resolver, `client-material-rates.service.js`,
`routes/admin/jobs.js`'s CRM add-line route, and
`rate-card-bulk-upload.service.js`'s per-row Materials parser.

**The technician app must never see `tx_share`.** Every mobile response this
backend returns (`GET /mobile/jobs/:id/materials`, `GET/POST
/mobile/jobs/:id/quotation`, etc.) strips it — guarded by tests asserting the
JSON payload never contains the string, with a positive control (a non-zero
fixture tx_share) so an accidentally-vacuous pass is ruled out.

### Quotation lines (`quotation_details.tx_charge`)

Audited every reader/writer of this legacy FLOAT column before reusing it
(2026-09-24): it was written as a literal/caller-supplied `0` by three paths
(`routes/admin/quotations.js` POST `/product`/`/material` — a generic,
out-of-scope admin route, left untouched; `services/mobile-job-estimate
.service.js#insertDraftLine`; `routes/admin/jobs.js` POST
`/:id/quotation-lines`) and otherwise only ever SELECTed for display
(`GET /admin/quotations?jobId=`) or schema-existence-checked
(`scripts/schema-verify.js`) — no billing, finance, ledger, export or
client-portal reader consumes it (those all key off `client_charge` /
`approved_charge` / `unit_price` — see `services/job-line-total.js`,
`routes/admin/finance.js`, `services/job-export.service.js`,
`routes/client/index.js`). No conflicting meaning found, so it is now the
**per-unit Tx Share snapshot**:

- Mobile `addQuotationLine` / `POST .../quotation/draft` (via the shared
  `resolveLineForInsert` → `insertDraftLine`) and the CRM's
  `POST /admin/jobs/:id/quotation-lines` all set `tx_charge` from the
  resolver's `tx_share`, falling back to `defaultTxShare(unit_price)` (20% of
  the actually-billed price) when the resolver had none (`source: 'none'`).
  Product lines carry no Tx Share concept and keep `tx_charge = 0`.
  `tx_charge` is appended LAST in each INSERT's column list (not its native
  table position) so no pre-existing positional test assertion had to move.
- `GET /admin/quotations?jobId=` rows gain `tx_share`: the row's own
  `tx_charge` when it is a real (non-zero, non-null) per-unit snapshot; for a
  legacy row (`tx_charge` 0/NULL, inserted before this date) it is computed —
  20% of `client_charge` when the line has one, else 20% of `unit_price`.
- `POST /admin/jobs/:id/material-review` (approve) — each approved line may
  now carry an optional `quoted_unit_price` (a whole number `>= 0` —
  `quotation_details.unit_price` is a legacy INT column, so a fractional
  value 422s before any write, same rule the technician app's own quote
  already enforces), which updates `unit_price` in the SAME transaction,
  before the approval columns. `approved_amount` semantics (the line total
  sent to the client) are unchanged.

### Bulk upload + letterhead PDF

The Materials flat format (`Material, Brand, Price, State`) gains an
optional **Tx Share** column between Price and State — blank defaults to 20%
of that row's own price. `services/client-xlsx.service.js#addMaterialRatesSheet`
(shared by the per-tab download, the combined `export.xlsx`, and — via
`namedOrFirstSheet` — the bulk-upload template/preview/commit, since there is
only ONE writer of this sheet) writes it; the upload template's hidden
`Lists` sheet dropdown for State moved from column D to E accordingly.
`services/rate-card-bulk-upload.service.js#parseMaterialRateRows` parses it,
folds it into the (material, brand, state) grouping/signature comparison
(two brands sharing a price but NOT a Tx Share compile to two groups, not
one — a group has exactly one Tx Share) and re-validates the compiled
groups' `tx_share` through `validateClientGroupsPayload` exactly like the
direct PUT route. The round-trip test (export → preview, all `unchanged`)
stays green because both sides — the export and the "existing" signature —
read `tx_share` from the SAME `materialRatesSvc.list()` call.

`utils/pdf-rate-card.js`'s Materials table shows **ONE** rate per row —
`price + tx_share` combined — for both the base price and every state
override; the literal text "Tx Share" never appears on the letterhead (the
client is shown a single number, not the split, same principle as the
Services table never showing Easyfix Direct/Overhead).
