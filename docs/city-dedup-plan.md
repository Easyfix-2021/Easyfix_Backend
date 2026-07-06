# Manage-Pincodes: City Duplicate Cleanup (DEFERRED — decide later)

> **Prevention decision: RESOLVED & SHIPPED (2026-07-06).** The A/B/C option
> question that used to fill this file is settled. **Option B** (backend auto
> fuzzy-match on create — no UI picker, no explicit "create new") was
> implemented in `services/pincode.service.js` (`fuzzyMatchCity` +
> `findOrCreateCityByName`), and new cities INHERIT `state_user` via
> `resolveInheritedStateUser()`. Geocode-created duplicates are now largely
> prevented at the source, so the option-comparison / fuzzy-building-block
> sections were removed as obsolete.

The only reason this file still exists is the one piece that was **not** built:
retroactively cleaning up the **~526 duplicate cities already in `tbl_city`**.
That cleanup was deferred by product decision ("plan this for now, decide
later"). Sketch below — **DBA-gated, do NOT auto-run on the shared DB.**

## Cleanup of the ~526 existing duplicates (DBA-gated migration)

1. Identify duplicate groups: cities whose normalized name / alias collides with
   another city in the same `state_id`; treat the one WITH a `state_user` (or
   lowest `city_id`) as canonical. Reuse the same normalization the live code
   uses — `CITY_ALIAS` / `CITY_NOISE` / `LOCALITY_TAIL` / `coreCityName()` in
   `services/pincode.service.js` — so grouping matches create-time behaviour.
2. Re-point pincodes: `UPDATE tbl_pincode SET city_id = <canonical> WHERE city_id IN (<dupes>)`.
3. Re-point every other FK referencing the dup `city_id`s (technicians
   `efr_cityId`, jobs, zone mappings) — audit the fan-out FIRST.
4. Deactivate (not delete) the dupes: `UPDATE tbl_city SET city_status = 0 WHERE city_id IN (<dupes>)`.
5. Verify counts before/after; run inside a transaction; DBA review.

Every step must be reviewed against live data first — the canonical-city choice
and the FK fan-out are the risky parts.
