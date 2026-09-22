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
