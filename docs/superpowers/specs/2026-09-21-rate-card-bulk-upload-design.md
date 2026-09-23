# Rate Card Bulk Upload (Services + Materials) — design

Date: 2026-09-21
Status: owner-requested ("there should be an option to Bulk Upload materials in
Rate Card" · "Same for Services")
Repos: `EasyFix_Backend`, `Easyfix_CRM_UI`

## Principle: the upload takes back the file Download produces

Both tabs' uploads accept exactly the columns their respective exporter writes:
an operator downloads, edits prices in Excel, and uploads it. So there is one
column layout per tab, defined by the export, and a round-trip test proves
download → upload changes nothing.

A **Download Template** link in the upload dialog serves the same layout with a
header row and one example row, for a client that has no rows yet (Download is
disabled when empty).

**2026-09-21 addition — ONE combined Download button.** The CRM originally had
a separate Download button per tab (Services, Materials). The owner replaced
both with a single "Rate Cards · Brand-Level" Download button offering:

- **Excel Workbook** — `GET /:clientId/rate-cards/export.xlsx`, ONE workbook,
  sheet "Services" (`services/client-xlsx.service.js#exportRateCards`'s exact
  columns) + sheet "Materials" (`exportMaterialRates`'s exact columns). Both
  sheets are built by the SAME per-sheet builders the per-tab downloads use
  (`addRateCardsSheet` / `addMaterialRatesSheet`), just added to one workbook
  under different sheet names — no column list is duplicated.
  `rate-card-bulk-upload.service.js#namedOrFirstSheet` is what lets EITHER
  tab's upload read this combined file correctly: the Services upload asks for
  a sheet named "Services" and gets the first of the two; the Materials upload
  asks for "Materials" and gets the second — falling back to "whichever sheet
  the file has" for the still-unchanged single-sheet per-tab downloads and
  upload templates.
- **PDF (Letterhead)** — `GET /:clientId/rate-cards/export.pdf`, a
  `utils/pdf-rate-card.js` letterhead document meant to be **shared outside
  EasyFix**. Its Services table therefore shows ONLY the service and the rate
  the client is charged (`tbl_client_service.total_amount`, the same column
  `job.service.js` falls back to when a job has no per-job override —
  `COALESCE(NULLIF(js.total_charge,0), CS.total_amount)`) — never the internal
  Easyfix Direct / Overhead / Client Fixed+Variable split, which is EasyFix's
  margin structure. Letterhead (company name, CIN, address, brand red) lives in
  `utils/pdf-letterhead.js`, sharing `BRAND_RED` (`#C42430`) with
  `utils/pdf-certificate.js` rather than re-declaring the hex.

Per-tab downloads (`/:clientId/rate-cards/download`,
`/:clientId/material-rates/download`) and the CRM's Bulk Upload templates are
UNCHANGED by this — only the CRM's Download BUTTON was consolidated; the
underlying per-tab routes and their single-sheet shapes still exist for
anything else that calls them.

## Why not the existing Services upload

`POST /admin/rate-cards/client-services/upload` (routes/admin/rate-cards.js) is
unsafe to expose from a client page, and is NOT reused as a route:

- it reads `client_id` FROM THE FILE — an operator on client A's page could write
  client B's rates;
- it has no `requireAction` guard at all;
- it takes raw numeric ids by column POSITION (0..13), not the export's headers.

The new routes are client-scoped: **the client id always comes from the URL,
never the file**, and they sit behind the client routes' existing
`loadAndGuardClient` + `requireClientEdit` (`isClientEdit`). The legacy route is
left alone (out of scope) and flagged separately.

## Flow (both tabs, stateless — the phase-1 Manage Materials import pattern)

1. **Bulk Upload** button → dialog → choose .xlsx.
2. `POST …/upload/preview` (multipart) → the server parses and validates every
   row and returns `{ rows: [{ row_number, outcome: 'new'|'update'|'unchanged'|'blocked', errors: [] , …}], summary }`.
   Nothing is written.
3. The dialog shows the summary and a table of rows, blocked rows first with
   their reasons. **Confirm** is disabled while any row is blocked.
4. `POST …/upload/commit` (multipart, the SAME file) → the server RE-RUNS the
   same validation (it never trusts a client-held preview) and writes all rows in
   ONE transaction, or none.

## Services

Routes, in routes/admin/clients.js:
`GET  /:clientId/rate-cards/template` · `POST /:clientId/rate-cards/upload/preview` ·
`POST /:clientId/rate-cards/upload/commit`.

Columns = the export's (`services/client-xlsx.service.js` `exportRateCards`):
Service Type ID, Service Type Name, Easyfix Direct Fixed, Easyfix Direct
Variable, Overhead Fixed, Overhead Variable, Client Fixed, Client Variable (plus
any further columns the export writes — read-only ones are ignored on upload).

- A row is matched by **Service Type ID within this client**: an existing
  client-service row → `update`; a service type the client does not have yet →
  `new` (must be a real, active service type); identical values → `unchanged`.
- Service Type Name is informational; a mismatch with the id is a warning, not a
  block (the id wins).
- Cost cells must be numbers ≥ 0; blank = 0 only where the grid itself treats
  blank as 0.
- The write goes through the SAME path the tab's "Save All" uses (verify what
  that is — `PUT /:clientId/rate-cards` / `client-services.service.js`), not a
  second writer. If Save All itself uses the legacy SP, call it the same way.
- Rows absent from the file are left untouched (upload never deletes).

## Materials

Routes: `GET /:clientId/material-rates/template` ·
`POST /:clientId/material-rates/upload/preview` ·
`POST /:clientId/material-rates/upload/commit`.

**2026-09-21 redesign** (owner, after the single-Download-button change below
shipped): the original "one row = one price group, brands/state-overrides
packed into a cell" grammar made a small typo in a packed cell invisible until
upload, and occasionally silently duplicated an entry. Replaced with:

Columns = the Materials export: **Material, Brand, Price, State.** ONE ROW per
(material, brand, state) — "single row for each material of each brand in each
state" (owner, verbatim). Blank **State** = the all-states base price for that
material+brand. Blank/"No Brand" **Brand** = the No Brand price for that
material. `Master Price Today` / `Review Flag` are dropped from this file
entirely (they were read-only noise on the old sheet; the review flag stays
visible in the CRM's own Materials table, it's just not part of the
round-trippable file).

The upload TEMPLATE additionally carries a hidden "Lists" sheet + Excel
dropdown (list) validation on all three name columns, sourced from active
master materials/brands/states — so a typo is rejected by Excel itself before
the file is ever uploaded. This is UX sugar on top of, not instead of, the
parser's own validation below (which applies regardless of dropdown or file
origin). Not applied to the per-tab/combined DOWNLOAD files — those already
contain valid current names, and doing so would mean threading master lists
into `services/client-xlsx.service.js`, which today does no DB access at all.

**Compile / validation pipeline** (preview and commit share it; commit re-runs
it against the live DB, same all-or-nothing contract as before):

1. Parse every row; trim. Match Material/Brand/State to master records via the
   phase-1 normaliser (`utils/name-key.js`, case/whitespace-insensitive). An
   unmatched name BLOCKS that row, naming the closest active name by a plain
   Levenshtein distance (no new dependency) when one is close enough: `Unknown
   brand "Philps" — did you mean "Philips"?`.
2. Group by material → brand → state → price. Every (material, brand) that has
   ANY row needs a base (State blank) row; state-only rows with no base price
   for that brand → the WHOLE material blocked (`"<brand>" has state prices but
   no all-states price for "<material>"`) — same "one bad row blocks the whole
   material" rule as before, because `replace()` still rewrites a material's
   entire group set atomically.
3. Same (material, brand, state) twice with DIFFERENT prices → both rows
   blocked, naming both row numbers. Identical duplicates → the first is kept,
   the rest get a warning and are dropped from grouping (not blocked).
4. No Brand rows cannot be mixed with branded rows for the same material →
   blocked (unchanged rule).
5. Client price GROUPS are then compiled per material: brands whose base price
   AND whole state-override map are byte-identical share ONE group (matching
   `validateClientGroupsPayload`'s own "one group, several brand_ids" shape);
   states sharing the same override price collapse into one `{price,
   state_ids}` entry. The compiled groups are re-validated with
   `validateClientGroupsPayload` / `assertBrandsAndStatesExist` exactly as
   before, then written with `replace()` in ONE transaction for the whole file.
6. The preview response adds a compiled **plan** alongside the row-level echo:
   `materials: [{ material, material_id, outcome, lines: [{brand, state,
   price}], errors }]` — the CRM's Materials Bulk Upload preview renders this
   grouped-per-material view (Material · Brand · State ("All States" when
   blank) · Price, with the outcome chip and errors) instead of a flat row
   table, with the commit button labelled "Upload".

Materials absent from the file are, as before, left untouched.

## Testing

- Round-trip: export a client's rows, feed that buffer to preview → every row
  `unchanged`, zero blocked (both tabs). This is the test that keeps export and
  import from drifting apart.
- The client id comes from the URL: a file carrying another client's data (or a
  Service Type/Material the client cannot see) cannot write to another client.
- Commit re-validates: a file that turns invalid between preview and commit is
  refused and writes nothing; a failing row rolls back the whole file.
- Blocked-row reasons for: unknown material/brand/state/service type (with a
  "did you mean" suggestion where one is close), negative or missing price, No
  Brand mixed with brands, a state price with no all-states base, conflicting
  duplicates (blocked, both rows named), identical duplicates (warned, deduped
  not blocked).
- Grouping: two brands with the same base price + state map compile to ONE
  client price group; different base prices compile to two; two states sharing
  one override price collapse into one `{price, state_ids}` entry — proven via
  the OUTCOME ('unchanged') against a pre-seeded existing card shaped exactly
  like a correct merge, since the flattened preview `lines` read identically
  whether the merge happened or not.
- `isClientEdit` required for preview/commit/template.
- The combined `export.xlsx` has exactly two sheets, "Services" and
  "Materials", matching the single-sheet exporters row-for-row; it round-trips
  through BOTH tab uploads with every row `unchanged`.
- `export.pdf` returns `application/pdf`, starts with `%PDF`, and its own text
  (inflated + decoded from the content stream — pdfkit compresses by default)
  contains the company name, the client name and a service rate, and does NOT
  contain "Easyfix Direct" / "Overhead".
- Each new check made to fail on purpose once.

## Out of scope

- Deleting rows via upload.
- Changing the legacy `/admin/rate-cards/client-services/upload` route (flagged).
