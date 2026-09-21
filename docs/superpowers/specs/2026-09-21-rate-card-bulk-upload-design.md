# Rate Card Bulk Upload (Services + Materials) — design

Date: 2026-09-21
Status: owner-requested ("there should be an option to Bulk Upload materials in
Rate Card" · "Same for Services")
Repos: `EasyFix_Backend`, `Easyfix_CRM_UI`

## Principle: the upload takes back the file Download produces

Both tabs already (or, for Materials, now) have a **Download** button. The upload
accepts exactly that workbook: an operator downloads, edits prices in Excel, and
uploads it. So there is one column layout per tab, defined by the export, and a
round-trip test proves download → upload changes nothing.

A **Download Template** link in the upload dialog serves the same layout with a
header row and one example row, for a client that has no rows yet (Download is
disabled when empty).

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

Columns = the Materials export: Material, Brands, Client Price, State Overrides,
Master Price Today, Review Flag. The last two are READ-ONLY and ignored.

- One row = one price group. Rows sharing a Material form that material's full
  set of groups, and a material present in the file is REPLACED as a whole — the
  same semantics as `PUT /:clientId/material-rates/:materialId`, reusing the
  same validation (`validateClientGroupsPayload`, `assertBrandsAndStatesExist`)
  and the same `replace()` write, inside one transaction for the whole file.
  Materials absent from the file are untouched.
- Material is matched by name to an active master material (name normalised the
  way phase 1 does — `utils/name-key.js`); unknown → blocked.
- Brands: comma-separated brand names matched to active brands; blank or
  "No Brand" = the No Brand group (sole group only, as everywhere else).
- Client Price: required, > 0.
- State Overrides: the exact text the export writes, e.g.
  `Maharashtra, Gujarat: 275; Delhi: 260` — state names matched to tbl_state;
  unknown state or malformed segment → blocked with the segment quoted.

## Testing

- Round-trip: export a client's rows, feed that buffer to preview → every row
  `unchanged`, zero blocked (both tabs). This is the test that keeps export and
  import from drifting apart.
- The client id comes from the URL: a file carrying another client's data (or a
  Service Type/Material the client cannot see) cannot write to another client.
- Commit re-validates: a file that turns invalid between preview and commit is
  refused and writes nothing; a failing row rolls back the whole file.
- Blocked-row reasons for: unknown material/brand/state/service type, negative
  or missing price, No Brand mixed with brands, malformed State Overrides.
- `isClientEdit` required for preview/commit/template.
- Each new check made to fail on purpose once.

## Out of scope

- Deleting rows via upload.
- Changing the legacy `/admin/rate-cards/client-services/upload` route (flagged).
