const { pool } = require('../db');
const logger = require('../logger');
const geocode = require('./pincode-geocode.service');

/*
 * Generic pincode catalog — `tbl_pincode` (created in
 * migrations/2026-05-01-create-tbl-pincode.sql).
 *
 * Distinct from `pincode_firefox_city_mapping`, which is firefox-client-
 * specific data that we must NOT mutate. firefox-bound flows (zone-pincode
 * coverage in zone.service.js, customer-pincode → zone resolution in
 * auto-assign.service.js) continue to read from the firefox table; this
 * service operates entirely on tbl_pincode.
 *
 * Status model (computed at read time, NOT stored):
 *   LOCAL    — row active AND ≥1 active+verified easyfixer maps to a zone
 *              covering this pincode's city.
 *   TRAVEL   — row active but no qualifying tech.
 *   UNZONED  — pincode missing from this table. This service only lists
 *              rows that ARE present, so UNZONED is detected at job-create
 *              time (job.service.js) and never appears in this list view.
 *
 * Self-correcting status: the join to tbl_easyfixer is live, so onboarding
 * or deactivating a tech in an area flips affected pincodes between
 * LOCAL/TRAVEL on the next read — no migration job, no stale flag.
 */

const STATUS = Object.freeze({ LOCAL: 'LOCAL', TRAVEL: 'TRAVEL', UNZONED: 'UNZONED' });

// Active+verified easyfixer count per pincode, batched.
//
// Changed from the zone-chain join (tbl_pincode → tbl_zone_city_mapping →
// tbl_easyfixer.efr_zone_city_id) to a SERVICEABLE-PINCODE count:
// technicians whose tbl_efr_serviceable_pincodes row explicitly lists the
// pincode value (CSV TEXT column, matched with FIND_IN_SET). This matches
// the exact pattern used by candidate-ranking.service.js to identify
// serviceable technicians for a job pincode — so LOCAL/TRAVEL status now
// directly reflects "can a tech actually service this pincode" rather than
// "is a tech in the same city zone".
//
// Performance: per-page call is ~100 rows; bounded by WHERE p.pincode_id IN (?)
// + FIND_IN_SET scans only the serviceable_pincodes rows, not the full
// tbl_easyfixer table. Acceptable for an ops settings page.
async function pincodeIdToActiveEfrCount(pincodeIds) {
  if (!pincodeIds.length) return new Map();
  const placeholders = pincodeIds.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT p.pincode_id, COUNT(DISTINCT e.efr_id) AS active_efr_count
       FROM tbl_pincode p
       LEFT JOIN tbl_efr_serviceable_pincodes sp
              ON FIND_IN_SET(p.pincode, sp.pincodes) > 0
       LEFT JOIN tbl_easyfixer e
              ON e.efr_id = sp.easyfixer_id
             AND e.efr_status = 1
             AND e.is_technician_verified = 1
      WHERE p.pincode_id IN (${placeholders})
      GROUP BY p.pincode_id`,
    pincodeIds
  );
  const map = new Map();
  for (const r of rows) map.set(Number(r.pincode_id), Number(r.active_efr_count) || 0);
  return map;
}

/*
 * List active+verified technicians who explicitly service a pincode.
 *
 * Reuses the same FIND_IN_SET match as pincodeIdToActiveEfrCount and
 * candidate-ranking.service.js's serviceable-pincodes query. Supports
 * free-text search (q) over efr_name / efr_id / efr_no (mobile).
 *
 * Returns { items: [...], total } where each item has:
 *   efr_id, efr_name, efr_no, zone_name, city_name
 */
async function listTechniciansForPincode(pincodeId, { q = '', limit = 20, offset = 0 } = {}) {
  logger.info('Listing technicians for pincode · pincodeId=' + pincodeId + ' q=' + (q || '') + ' limit=' + limit + ' offset=' + offset);
  limit  = Math.min(Math.max(Number(limit)  || 20, 1), 200);
  offset = Math.max(Number(offset) || 0, 0);

  // Resolve the 6-digit pincode string from the id — needed for FIND_IN_SET.
  const [[pinRow]] = await pool.query(
    'SELECT pincode FROM tbl_pincode WHERE pincode_id = ? LIMIT 1',
    [pincodeId]
  );
  if (!pinRow) return { items: [], total: 0 };
  const pincodeVal = String(pinRow.pincode);

  const searchWhere = [];
  const searchParams = [];
  const term = String(q || '').trim();
  if (term) {
    const like = `%${term}%`;
    if (/^[0-9]+$/.test(term)) {
      searchWhere.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR e.efr_id = ?)');
      searchParams.push(like, like, Number(term));
    } else {
      searchWhere.push('(e.efr_name LIKE ? OR e.efr_no LIKE ?)');
      searchParams.push(like, like);
    }
  }
  const extraWhere = searchWhere.length ? ` AND ${searchWhere.join(' AND ')}` : '';

  const baseParams = [pincodeVal, ...searchParams];

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(DISTINCT e.efr_id) AS total
       FROM tbl_efr_serviceable_pincodes sp
       JOIN tbl_easyfixer e ON e.efr_id = sp.easyfixer_id
                           AND e.efr_status = 1
                           AND e.is_technician_verified = 1
      WHERE FIND_IN_SET(?, sp.pincodes) > 0${extraWhere}`,
    baseParams
  );

  const [rows] = await pool.query(
    `SELECT e.efr_id,
            e.efr_name,
            e.efr_no,
            MAX(c.city_name)  AS city_name,
            MAX(zm.zone_name) AS zone_name
       FROM tbl_efr_serviceable_pincodes sp
       JOIN tbl_easyfixer e ON e.efr_id = sp.easyfixer_id
                           AND e.efr_status = 1
                           AND e.is_technician_verified = 1
       LEFT JOIN tbl_city              c   ON c.city_id = e.efr_cityId
       LEFT JOIN tbl_zone_city_mapping zcm ON zcm.city_zone_id = e.efr_zone_city_id
       LEFT JOIN tbl_zone_master       zm  ON zm.zone_id = zcm.zone_id
      WHERE FIND_IN_SET(?, sp.pincodes) > 0${extraWhere}
      GROUP BY e.efr_id, e.efr_name, e.efr_no
      ORDER BY e.efr_name ASC
      LIMIT ? OFFSET ?`,
    [...baseParams, limit, offset]
  );

  const items = rows.map((r) => ({
    efr_id:    r.efr_id,
    efr_name:  r.efr_name  ?? null,
    efr_no:    r.efr_no    ?? null,
    city_name: r.city_name ?? null,
    zone_name: r.zone_name ?? null,
  }));

  logger.info('Returning ' + items.length + ' technicians · total=' + (Number(total) || 0));
  return { items, total: Number(total) || 0 };
}

// Active-zone count per pincode, batched. Mirrors pincodeIdToActiveEfrCount.
//
// A pincode is now MANY-TO-MANY with zones via tbl_zone_pincode_mapping
// (the scalar tbl_pincode.zone_id is vestigial and deliberately NOT read
// here). We count DISTINCT active zones (tbl_zone_master.zone_status = 1)
// that include each pincode. Pincodes absent from the junction return 0.
//
// Performance: bounded by WHERE zpm.pincode_id IN (?) which hits the
// KEY(pincode_id) index; one query per page regardless of page size.
async function pincodeIdToZoneCount(pincodeIds) {
  if (!pincodeIds.length) return new Map();
  const placeholders = pincodeIds.map(() => '?').join(',');
  // Count ALL zones a pincode is mapped to (active OR inactive). This is a
  // management/inventory view and MUST match the zone-side pincode_count
  // (zone.service.js), which also doesn't filter zone_status — otherwise a
  // pincode mapped only to an inactive zone shows Zones=0 here while the zone
  // shows pincode_count>=1. zone_status is binary (1/0, no "deleted"
  // tombstone) so nothing needs excluding. candidate-ranking does its own
  // active-only zone filtering separately and is unaffected.
  const [rows] = await pool.query(
    `SELECT zpm.pincode_id, COUNT(DISTINCT zpm.zone_id) AS zone_count
       FROM tbl_zone_pincode_mapping zpm
      WHERE zpm.pincode_id IN (${placeholders})
      GROUP BY zpm.pincode_id`,
    pincodeIds
  );
  const map = new Map();
  for (const r of rows) map.set(Number(r.pincode_id), Number(r.zone_count) || 0);
  return map;
}

function deriveStatus(activeEfrCount) {
  return activeEfrCount > 0 ? STATUS.LOCAL : STATUS.TRAVEL;
}

// ─── List with filters + computed status ─────────────────────────────
async function listPincodes({ q, status, cityId, createdByTech = false, includeInactive = false, limit = 100, offset = 0, sortBy, sortDir = 'asc' } = {}) {
  logger.info('Listing pincodes · q=' + (q || '') + ' status=' + (status || '') + ' cityId=' + (cityId || '') + ' createdByTech=' + createdByTech + ' includeInactive=' + includeInactive + ' limit=' + limit + ' offset=' + offset);
  // "Created By (technician)" tracking columns are a pending migration — guard
  // the projection + filter on their presence so this query stays valid where
  // the migration hasn't run (mirrors getByIdCore's vertical_id gate).
  const hasCreator = await hasPincodeCreatorCol();
  // created_by is a polymorphic id — created_by_type says which table to resolve
  // the name from (technician→tbl_easyfixer, user→tbl_user).
  const creatorSelect = hasCreator
    ? "p.created_by, p.created_by_type, COALESCE(cbe.efr_name, cbu.user_name) AS created_by_name"
    : 'NULL AS created_by, NULL AS created_by_type, NULL AS created_by_name';
  const creatorJoin = hasCreator
    ? `LEFT JOIN tbl_easyfixer cbe ON (p.created_by_type = 'technician' AND cbe.efr_id = p.created_by)
       LEFT JOIN tbl_user      cbu ON (p.created_by_type = 'user'       AND cbu.user_id = p.created_by)`
    : '';
  // Cap limit defensively. Bumped from 500 → 200000 to support the CRM
  // verification page's "load-all" dropdown (~155k rows post-seed). The
  // query is indexed on `pincode` (PK) and runs sub-second; pagination
  // is preserved for callers that still want page-size LIMITs.
  limit  = Math.min(Math.max(Number(limit)  || 100, 1), 200000);
  offset = Math.max(Number(offset) || 0, 0);

  const where = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('p.pincode_status = 1');
  // Field-aware search (#8): an all-digits term targets the pincode column as a
  // PREFIX (`pincode LIKE 'q%'`) so MySQL can seek the index (a leading `%`
  // would force a full scan); a non-numeric term matches city_name OR district
  // (LIKE). district falls back to the city's district via COALESCE so rows
  // whose own p.district is NULL still match by their city.
  const term = String(q || '').trim();
  if (term) {
    if (/^\d+$/.test(term)) {
      where.push('p.pincode LIKE ?');
      params.push(`${term}%`);
    } else {
      // Match LOCATION (area label), CITY, or district so a pincode is findable
      // by any of Pincode / Location / City.
      where.push('(p.location LIKE ? OR c.city_name LIKE ? OR COALESCE(p.district, c.district) LIKE ?)');
      params.push(`%${term}%`, `%${term}%`, `%${term}%`);
    }
  }
  if (cityId) {
    where.push('p.city_id = ?');
    params.push(Number(cityId));
  }
  // Only pincodes a technician minted on the fly.
  if (createdByTech && hasCreator) where.push("p.created_by_type = 'technician'");

  // Whitelisted sort. Only map-resolved column literals + an ASC/DESC literal
  // are ever spliced into SQL — `sortBy`/`sortDir` are never interpolated raw
  // (MySQL can't parameterise identifiers). Unknown keys fall back to pincode.
  //
  // NOTE: the LOCAL/TRAVEL "Mapping" value (deriveStatus(active_efr_count)) is
  // intentionally NOT a sort key here. It is a virtual value computed in JS
  // AFTER pagination (see below), so it can't be ORDER BY'd in this query shape
  // without pushing active_efr_count into SQL as a derived column. The CRM page
  // sorts "Mapping" client-side instead. Mapping it to p.pincode_status (the
  // unrelated Serviceable/Non-Serviceable flag) would silently order by the
  // wrong column, so it's omitted on purpose.
  const SORT_MAP = {
    pincode:       'p.pincode',
    location:      'p.location',
    zonal_manager: 'zm.user_name',
    // Status column = Serviceable / Non-Serviceable. Unlike the virtual
    // LOCAL/TRAVEL "Mapping" value above, this is a real column (pincode_status,
    // 1/0), so it CAN be ordered server-side across the whole result set.
    is_active:     'p.pincode_status',
  };
  const dir     = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const sortCol = SORT_MAP[sortBy] || 'p.pincode';
  // Zonal manager comes from a LEFT JOIN on c.state_user, which is NULL for
  // many cities — keep those rows at the bottom in BOTH directions.
  const nullClause = sortBy === 'zonal_manager' ? '(zm.user_name IS NULL), ' : '';

  const [rows] = await pool.query(
    `SELECT
        p.pincode_id,
        p.pincode,
        p.location,
        p.city_id,
        c.city_name,
        COALESCE(p.district, c.district) AS district,
        s.state_name,
        p.pincode_status,
        p.lat,
        p.lng,
        zm.user_name AS zonal_manager_name,
        ${creatorSelect}
       FROM tbl_pincode    p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
       LEFT JOIN tbl_user  zm ON zm.user_id = c.state_user
       ${creatorJoin}
      WHERE ${where.join(' AND ')}
      ORDER BY ${nullClause}${sortCol} ${dir}, p.pincode ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM tbl_pincode p
       LEFT JOIN tbl_city c ON c.city_id = p.city_id
      WHERE ${where.join(' AND ')}`,
    params
  );

  // Batch-compute LOCAL/TRAVEL status + zone count (one query each,
  // regardless of page size).
  const pincodeIds = rows.map((r) => Number(r.pincode_id));
  const activeMap = await pincodeIdToActiveEfrCount(pincodeIds);
  const zoneMap   = await pincodeIdToZoneCount(pincodeIds);
  const items = rows.map((r) => {
    const activeCount = activeMap.get(Number(r.pincode_id)) || 0;
    return {
      pincode_id:       r.pincode_id,
      pincode:          String(r.pincode),
      location:         r.location || null,
      city_id:          r.city_id,
      city_name:        r.city_name || null,
      district:         r.district || null,
      state_name:       r.state_name || null,
      is_active:        Number(r.pincode_status) === 1,
      status:           deriveStatus(activeCount),
      active_efr_count: activeCount,
      zone_count:       zoneMap.get(Number(r.pincode_id)) || 0,
      lat:              r.lat != null ? Number(r.lat) : null,
      lng:              r.lng != null ? Number(r.lng) : null,
      // Each pincode → city → city.state_user (zonal/city manager). Blank for
      // a new city (state_user not yet assigned). Display-only column.
      zonal_manager_name: r.zonal_manager_name || null,
      // Creator audit: created_by (id) + created_by_type ('technician'|'user')
      // + resolved name. NULL for legacy/seed rows created before tracking.
      created_by:      r.created_by != null ? Number(r.created_by) : null,
      created_by_type: r.created_by_type || null,
      created_by_name: r.created_by_name || null,
    };
  });

  // In-app status filter. Applied after computation since status is virtual.
  // For 100 rows per page this is fine; if pagination ever shows 5k rows in
  // one page, push this into a HAVING clause on the main query.
  const filtered = status
    ? items.filter((it) => it.status === String(status).toUpperCase())
    : items;

  logger.info('Returning ' + filtered.length + ' pincodes · total=' + total);
  return { items: filtered, total };
}

async function getPincodeById(pincodeId) {
  logger.info('Fetching pincode by id · pincodeId=' + pincodeId);
  const [[row]] = await pool.query(
    `SELECT p.pincode_id, p.pincode, p.location, p.city_id, c.city_name,
            COALESCE(p.district, c.district) AS district, s.state_name,
            p.pincode_status, p.lat, p.lng, zm.user_name AS zonal_manager_name
       FROM tbl_pincode    p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
       LEFT JOIN tbl_user  zm ON zm.user_id = c.state_user
      WHERE p.pincode_id = ?
      LIMIT 1`,
    [pincodeId]
  );
  if (!row) { logger.warn('Pincode not found · pincodeId=' + pincodeId); return null; }
  const activeMap = await pincodeIdToActiveEfrCount([Number(row.pincode_id)]);
  const zoneMap   = await pincodeIdToZoneCount([Number(row.pincode_id)]);
  const activeCount = activeMap.get(Number(row.pincode_id)) || 0;

  // The pincode's CURRENT ACTIVE zones — powers the reverse Pincode→Zones
  // mapping modal's pre-checked state. Intentionally active-only (UNLIKE
  // zone_count above, which now counts ALL mapped zones): the modal can only
  // map a pincode to ACTIVE zones — setZonesForPincode() validates + replaces
  // against active zones, so pre-checking an inactive zone would be a row the
  // Save path can't preserve (it would be deleted). Net result: zone_count may
  // exceed this list when a pincode is also mapped to inactive zones — that
  // divergence is expected, do not "fix" it by dropping the filter here.
  const [zoneRows] = await pool.query(
    `SELECT z.zone_id, z.zone_name
       FROM tbl_zone_pincode_mapping zpm
       JOIN tbl_zone_master z ON z.zone_id = zpm.zone_id
                             AND z.zone_status = 1
      WHERE zpm.pincode_id = ?
      ORDER BY z.zone_name ASC`,
    [Number(row.pincode_id)]
  );

  return {
    pincode_id:       row.pincode_id,
    pincode:          String(row.pincode),
    location:         row.location || null,
    city_id:          row.city_id,
    city_name:        row.city_name || null,
    district:         row.district || null,
    state_name:       row.state_name || null,
    // lat/lng + zonal_manager_name added for shape-parity with the list payload
    // so the auto-open-existing Edit path shows coordinates + distance-ranked
    // zone suggestions identically to a row-launched Edit.
    lat:              row.lat != null ? Number(row.lat) : null,
    lng:              row.lng != null ? Number(row.lng) : null,
    zonal_manager_name: row.zonal_manager_name || null,
    is_active:        Number(row.pincode_status) === 1,
    status:           deriveStatus(activeCount),
    active_efr_count: activeCount,
    zone_count:       zoneMap.get(Number(row.pincode_id)) || 0,
    zones:            zoneRows.map((z) => ({ zone_id: Number(z.zone_id), zone_name: z.zone_name })),
  };
}

/*
 * Bulk lookup by 6-digit code. Used by the CRM verification page's
 * "Add All Matching Pincodes" bulk-paste flow. De-dupes + sanitises input,
 * caps at 500, runs a single indexed IN(...) scan. Returns
 *   { items: [...], notFound: ['110099', ...] }
 * so the FE can toast the unmatched codes.
 */
async function lookupManyByCode(pincodes) {
  logger.info('Bulk pincode lookup by code · input=' + (Array.isArray(pincodes) ? pincodes.length : 0));
  if (!Array.isArray(pincodes) || pincodes.length === 0) {
    return { items: [], notFound: [] };
  }
  const clean = Array.from(new Set(
    pincodes.map((p) => String(p).trim()).filter((p) => /^\d{6}$/.test(p))
  )).slice(0, 500);
  if (clean.length === 0) return { items: [], notFound: pincodes };

  const placeholders = clean.map(() => '?').join(',');
  const [items] = await pool.query(
    `SELECT p.pincode_id, p.pincode, p.location AS location,
            p.city_id, c.city_name, c.state_id, s.state_name
       FROM tbl_pincode    p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE p.pincode IN (${placeholders})
        AND p.pincode_status = 1`,
    clean
  );

  const foundSet = new Set(items.map((i) => String(i.pincode)));
  const notFound = clean.filter((p) => !foundSet.has(p));
  logger.info('Bulk lookup matched ' + items.length + ' pincodes · notFound=' + notFound.length);
  return { items, notFound };
}

async function getPincodeByValue(pincode) {
  const [[row]] = await pool.query(
    'SELECT pincode_id FROM tbl_pincode WHERE pincode = ? LIMIT 1', [String(pincode)]
  );
  return row ? getPincodeById(row.pincode_id) : null;
}

// ─── Create / Update / Delete ────────────────────────────────────────
function badReq(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

async function assertCityExists(cityId) {
  const [[row]] = await pool.query('SELECT city_id FROM tbl_city WHERE city_id = ? LIMIT 1', [cityId]);
  if (!row) throw badReq(`Unknown city_id ${cityId}`);
}

// India is the only country EasyFix operates in; resolve its country_id for
// new-state creation. Defensive: name-match first, fall back to the first
// country row. Returns null only if tbl_country is empty/unreadable — the
// caller treats null as a hard 400 since tbl_state.country_id is NOT NULL.
async function indiaCountryId() {
  try {
    const [[row]] = await pool.query(
      "SELECT country_id FROM tbl_country WHERE LOWER(country_name) LIKE '%india%' ORDER BY country_id ASC LIMIT 1"
    );
    if (row) return Number(row.country_id);
  } catch (e) { logger.warn({ err: e.message }, 'indiaCountryId by-name lookup failed'); }
  try {
    const [[any]] = await pool.query('SELECT country_id FROM tbl_country ORDER BY country_id ASC LIMIT 1');
    return any ? Number(any.country_id) : null;
  } catch (e) { logger.warn({ err: e.message }, 'indiaCountryId fallback lookup failed'); return null; }
}

// Find a state by name (case-insensitive, trimmed) or create it. Dedup-first
// so an auto-fetch that returns an existing state never makes a duplicate row.
async function findOrCreateStateByName(stateName, { userId = null } = {}) {
  void userId;
  const name = String(stateName || '').trim();
  if (!name) throw badReq('State name is required to create a new state');
  const [[existing]] = await pool.query(
    'SELECT state_id FROM tbl_state WHERE LOWER(TRIM(state_name)) = LOWER(?) LIMIT 1', [name]
  );
  if (existing) return { state_id: Number(existing.state_id), created: false };
  const countryId = await indiaCountryId();
  if (countryId == null) throw badReq('Cannot create a new state — no country configured in tbl_country');
  const [r] = await pool.query(
    'INSERT INTO tbl_state (state_name, country_id) VALUES (?, ?)', [name, countryId]
  );
  return { state_id: r.insertId, created: true };
}

/*
 * A newly-created city's zonal manager (tbl_city.state_user) can NEVER be
 * derived from a geocode — it's a manual business assignment. But every
 * zonal-scoped report (QuickSight admin-dashboard / supply-gap / city- /
 * client- / technician-performance / employee-productivity) AND technician
 * scoping filters on `c.state_user`, so a NULL-manager city's pincodes and
 * jobs silently vanish from all of those views. To avoid orphaning a new city,
 * inherit the manager from an existing city in the SAME district (preferred),
 * else the SAME state — picking the MOST COMMON assigned manager (mode), which
 * is that area's real zonal owner. Returns null only when the state has no
 * assigned manager at all (nothing to inherit — the city stays NULL and should
 * be flagged for manual assignment).
 */
async function resolveInheritedStateUser(stateId, district = null) {
  if (!stateId) return null;
  const d = String(district || '').trim();
  if (d) {
    const [[byDistrict]] = await pool.query(
      `SELECT state_user FROM tbl_city
        WHERE state_user IS NOT NULL AND state_id = ? AND LOWER(TRIM(district)) = LOWER(?)
        GROUP BY state_user ORDER BY COUNT(*) DESC LIMIT 1`,
      [Number(stateId), d]
    );
    if (byDistrict) return Number(byDistrict.state_user);
  }
  const [[byState]] = await pool.query(
    `SELECT state_user FROM tbl_city
      WHERE state_user IS NOT NULL AND state_id = ?
      GROUP BY state_user ORDER BY COUNT(*) DESC LIMIT 1`,
    [Number(stateId)]
  );
  return byState ? Number(byState.state_user) : null;
}

/*
 * FUZZY city matching (2026-07-03) — Google returns NAME VARIANTS the exact
 * match misses ("Gurgaon Division" vs "Gurugram", "Ganeshpur (Purnea)" vs
 * "Ganeshpur", "Bengaluru" vs "Bangalore"), which used to mint duplicate
 * cities. So before creating, we normalise (drop parentheticals + admin words +
 * apply a common-alias map) and match against existing cities IN THE SAME STATE
 * (never cross-state). No UI picklist — the resolution is fully backend-auto.
 */
const CITY_ALIAS = {
  gurgaon: 'gurugram', bengaluru: 'bangalore', calcutta: 'kolkata', bombay: 'mumbai',
  madras: 'chennai', poona: 'pune', mysuru: 'mysore', mangaluru: 'mangalore',
  belagavi: 'belgaum', vadodara: 'baroda', cochin: 'kochi', trivandrum: 'thiruvananthapuram',
  pondicherry: 'puducherry', allahabad: 'prayagraj', banaras: 'varanasi', benares: 'varanasi',
  vizag: 'visakhapatnam', vishakhapatnam: 'visakhapatnam', gauhati: 'guwahati', cawnpore: 'kanpur',
};
// Administrative / postal noise words that never distinguish two real cities.
const CITY_NOISE = /\b(division|district|dist|tehsil|taluk|taluka|taluq|mandal|block|city|town)\b/g;
// Sub-locality qualifier tokens — a name that extends an existing city with ONLY
// these (+ numbers) is the same place ("Gurugram Sector 14" ⊃ "Gurugram"); a
// name that adds a REAL word ("Rampur Bushahr" ⊃ "Rampur") is a different place.
const LOCALITY_TAIL = new Set([
  'sector', 'sec', 'phase', 'ph', 'part', 'block', 'nagar', 'colony', 'extension', 'extn',
  'road', 'marg', 'enclave', 'vihar', 'puram', 'chowk', 'market', 'area', 'industrial',
  'estate', 'gali', 'lane', 'no', 'number',
]);
function aliasTokens(x) { return x.split(' ').map((w) => CITY_ALIAS[w] || w).join(' '); }
// The CORE city name for matching: drop parentheticals + admin noise + alias.
function coreCityName(s) {
  let x = String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(CITY_NOISE, ' ');
  x = x.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return aliasTokens(x);
}
// A district/qualifier token (for disambiguation): a plain word list, aliased.
function normToken(s) {
  const x = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  return x ? aliasTokens(x) : '';
}
// The parenthetical qualifier in a name, e.g. "Ganeshpur (Purnea)" → "purnea".
function parenQualifier(s) {
  const m = String(s || '').match(/\(([^)]+)\)/);
  return m ? normToken(m[1]) : '';
}
// ⚠️ Two same-named places in DIFFERENT districts are DIFFERENT places
// ("Ganeshpur (Purnea)" ≠ "Ganeshpur (Saharsa)"). Only block a match when BOTH
// districts are known AND differ; an unknown district on either side is permissive.
function districtsCompatible(a, b) { return !(a && b && a !== b); }

// Existing city_id in the SAME STATE whose CORE name matches (exact-normalised
// preferred, else a length-guarded prefix) AND whose district is compatible.
// Returns null → caller creates a new city.
async function fuzzyMatchCity(name, stateId, district = null) {
  const target = coreCityName(name);
  // >=4 so a name whose only non-noise remainder is a short generic token
  // ("New Town" → "new") never fuzzy-matches; exact match still handles real
  // short names before we get here.
  if (!target || target.length < 4) return null;
  // Input qualifier = the name's parenthetical, else the geocoded district.
  const inQual = parenQualifier(name) || normToken(district);
  const [cities] = await pool.query(
    'SELECT city_id, city_name FROM tbl_city WHERE state_id = ? AND (city_status = 1 OR city_status IS NULL)',
    [Number(stateId)]
  );
  let best = null;
  for (const c of cities) {
    const cand = coreCityName(c.city_name);
    if (!cand) continue;
    // ⚠️ Use the candidate's NAME parenthetical only — tbl_city.district is
    // unreliable (often holds the full city name). Empty on either side ⇒
    // permissive (we can't prove they're different places).
    const candQual = parenQualifier(c.city_name);
    if (!districtsCompatible(inQual, candQual)) continue; // distinct places in different districts
    let score = 0;
    if (cand === target) score = 100;
    else {
      // WORD-BOUNDARY prefix, AND the extra tail must be ONLY sub-locality
      // qualifiers: "gurugram sector 14" ⊃ "gurugram" matches, but "rampura" ⊅
      // "rampur" (no space) and "rampur bushahr" ⊅ "rampur" (bushahr is a real
      // distinguishing word, not a locality tag) do NOT merge.
      const [shorter, longer] = cand.length <= target.length ? [cand, target] : [target, cand];
      if (shorter.length >= 4 && longer.startsWith(shorter + ' ')) {
        const tail = longer.slice(shorter.length + 1).split(' ').filter(Boolean);
        if (tail.length && tail.every((t) => LOCALITY_TAIL.has(t) || /^\d+$/.test(t))) score = 70;
      }
    }
    if (score > 0 && (!best || score > best.score || (score === best.score && Number(c.city_id) < best.city_id))) {
      best = { city_id: Number(c.city_id), score };
    }
  }
  return best ? best.city_id : null;
}

// Cached column probes for the tech-creator tracking columns (pending
// migrations 2026-07-03-add-tech-creator-tracking.sql) — no-op stamping where
// the column isn't present yet.
// Probe the created_by_type discriminator (pending migration). tbl_city also
// gets created_by + created_date in the same migration, so this one flag gates
// the whole tracking. created_by (id) + created_date already exist on
// tbl_pincode — only its created_by_type is new.
let _hasCityCreatorCol = null;
async function hasCityCreatorCol() {
  if (_hasCityCreatorCol !== null) return _hasCityCreatorCol;
  try { const [r] = await pool.query("SHOW COLUMNS FROM tbl_city LIKE 'created_by_type'"); _hasCityCreatorCol = r.length > 0; }
  catch { _hasCityCreatorCol = false; }
  return _hasCityCreatorCol;
}
let _hasPincodeCreatorCol = null;
async function hasPincodeCreatorCol() {
  if (_hasPincodeCreatorCol !== null) return _hasPincodeCreatorCol;
  try { const [r] = await pool.query("SHOW COLUMNS FROM tbl_pincode LIKE 'created_by_type'"); _hasPincodeCreatorCol = r.length > 0; }
  catch { _hasPincodeCreatorCol = false; }
  return _hasPincodeCreatorCol;
}

// Find a city by (state, name) or create it. Resolution order: exact name →
// FUZZY match (name variants/aliases, same state) → create. A newly-created
// city INHERITS a zonal manager (state_user) from the same district/state so
// it isn't orphaned from zonal-scoped reporting. Creator audit: a new city
// records created_by (efr_id when a technician minted it, else the CRM user_id)
// + created_by_type ('technician'|'user') + created_date — see hasCityCreatorCol.
// (NOTE: the legacy `stateId` camelCase column is intentionally left NULL — it
// holds inconsistent legacy values and NO CRM/QuickSight filter reads it; every
// filter keys on `state_id`.)
async function findOrCreateCityByName(cityName, stateId, { district = null, createdByEfrId = null, userId = null } = {}) {
  const name = String(cityName || '').trim();
  if (!name) throw badReq('City name is required to create a new city');
  if (!stateId) throw badReq('A state is required to create a new city');
  const [[existing]] = await pool.query(
    'SELECT city_id FROM tbl_city WHERE state_id = ? AND LOWER(TRIM(city_name)) = LOWER(?) LIMIT 1',
    [Number(stateId), name]
  );
  if (existing) return { city_id: Number(existing.city_id), created: false };
  const fuzzy = await fuzzyMatchCity(name, stateId, district);
  if (fuzzy) {
    logger.info('Fuzzy-matched city "' + name + '" → existing city_id=' + fuzzy + ' · state_id=' + stateId);
    return { city_id: fuzzy, created: false, matched: 'fuzzy' };
  }
  const inheritedStateUser = await resolveInheritedStateUser(stateId, district);
  const [r] = await pool.query(
    'INSERT INTO tbl_city (city_name, state_id, district, city_status, state_user) VALUES (?, ?, ?, 1, ?)',
    [name, Number(stateId), district || null, inheritedStateUser]
  );
  const cityId = r.insertId;
  // Creator audit (guarded — no-op where the pending migration is unrun).
  if (await hasCityCreatorCol()) {
    const creatorId = createdByEfrId || userId || null;
    const creatorType = createdByEfrId ? 'technician' : (userId ? 'user' : null);
    await pool.query(
      'UPDATE tbl_city SET created_by = ?, created_by_type = ?, created_date = NOW() WHERE city_id = ?',
      [creatorId, creatorType, cityId]
    );
  }
  logger.info('Created city · id=' + cityId + ' name="' + name + '" state_id=' + stateId
    + ' inherited_state_user=' + (inheritedStateUser ?? 'none')
    + ' created_by=' + (createdByEfrId ? 'efr:' + createdByEfrId : (userId ? 'user:' + userId : 'none')));
  return { city_id: cityId, created: true, state_user: inheritedStateUser };
}

/*
 * Create a pincode. Accepts EITHER an existing `city_id`, OR a `newCity`
 * ({ city_name, state_id? , state_name? }) which is find-or-created (state
 * first if new, then city). Persists geocoded lat/lng. Optionally maps the new
 * pincode to `zoneIds` (the chosen zone suggestions). Duplicate pincode → 409.
 */
async function createPincode(
  { pincode, location, city_id, district, lat, lng, newCity, zoneIds, is_active = true },
  { userId = null, createdByEfrId = null } = {}
) {
  logger.info('Creating pincode · pincode=' + pincode + ' city_id=' + (city_id || '') + ' is_active=' + is_active);
  if (!/^\d{6}$/.test(String(pincode))) throw badReq('Pincode must be exactly 6 digits');

  const [[existing]] = await pool.query(
    'SELECT pincode_id FROM tbl_pincode WHERE pincode = ? LIMIT 1', [String(pincode)]
  );
  if (existing) {
    logger.warn('Create pincode rejected — already exists · pincode=' + pincode);
    const err = new Error(`Pincode ${pincode} already exists`);
    err.status = 409;
    throw err;
  }

  // ── Resolve the city ──
  let resolvedCityId = city_id ? Number(city_id) : null;
  if (resolvedCityId) {
    await assertCityExists(resolvedCityId);
  } else if (newCity && String(newCity.city_name || '').trim()) {
    let stateId = newCity.state_id ? Number(newCity.state_id) : null;
    if (stateId) {
      const [[srow]] = await pool.query('SELECT state_id FROM tbl_state WHERE state_id = ? LIMIT 1', [stateId]);
      if (!srow) throw badReq(`Unknown state_id ${stateId}`);
    } else {
      stateId = (await findOrCreateStateByName(newCity.state_name, { userId })).state_id;
    }
    resolvedCityId = (await findOrCreateCityByName(newCity.city_name, stateId, { district, createdByEfrId, userId })).city_id;
  } else {
    throw badReq('Either city_id or newCity (city_name + state) is required');
  }

  const latN = (lat != null && lat !== '') ? Number(lat) : null;
  const lngN = (lng != null && lng !== '') ? Number(lng) : null;

  // Creator = the technician (efr_id) when this came from the self-service path,
  // else the CRM operator (user_id). created_by holds the id; created_by_type
  // (stamped below) disambiguates which table it points at.
  const creatorId = createdByEfrId || userId || null;
  // pincode_status from the Add form's Status toggle (defaults Serviceable).
  const statusVal = is_active === false ? 0 : 1;
  const [result] = await pool.query(
    `INSERT INTO tbl_pincode
       (pincode, location, city_id, district, lat, lng, pincode_status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(pincode), location || null, resolvedCityId, district || null, latN, lngN, statusVal, creatorId, creatorId]
  );
  const pincodeId = result.insertId;
  // Stamp WHICH table created_by points at (guarded — no-op where unrun).
  if (creatorId && await hasPincodeCreatorCol()) {
    const creatorType = createdByEfrId ? 'technician' : 'user';
    await pool.query('UPDATE tbl_pincode SET created_by_type = ? WHERE pincode_id = ?', [creatorType, pincodeId]);
  }
  logger.info('Pincode created · id=' + pincodeId + ' pincode=' + pincode
    + ' created_by=' + (createdByEfrId ? 'efr:' + createdByEfrId : (userId ? 'user:' + userId : 'none')));

  // Map the chosen suggested zones (optional). Reuses the validated junction
  // writer (its own txn); a zone-map hiccup leaves the pincode created.
  const zoneList = Array.isArray(zoneIds) ? zoneIds.map(Number).filter(Number.isFinite) : [];
  if (zoneList.length) {
    // The pincode IS already created; a zone-map hiccup must not fail the whole
    // create (operator can map zones later via the zones editor). Log + proceed.
    try {
      await setZonesForPincode(pincodeId, zoneList, { userId });
    } catch (e) {
      logger.warn({ err: e.message, pincodeId }, 'createPincode: zone mapping failed (pincode kept)');
    }
  }
  return getPincodeById(pincodeId);
}

/*
 * ensurePincode — admin/public "on-the-fly" pincode creation.
 *
 * Idempotent: if the pincode already exists, returns the existing row with
 * `created:false` (no geocode, no write). Otherwise it geocodes via Google,
 * HARD-REJECTS (400) any result that isn't a geocodable INDIA pincode,
 * find-or-creates the matched state + city, inserts the row, and returns it
 * with `created:true`.
 *
 * India guard: geocodeAndMatch pins `|country:IN` in the geocode URL AND now
 * surfaces the returned country/country_code. We reject when the result is not
 * geocodable OR the resolved country is anything other than India — belt and
 * braces over the URL component.
 *
 * Return shape (both branches):
 *   { pincode_id, pincode, city_id, city_name, state_name, lat, lng, created }
 */
async function ensurePincode(pincodeRaw, { userId = null, createdByEfrId = null } = {}) {
  const pin = String(pincodeRaw || '').trim();
  logger.info('Ensuring pincode · pincode=' + pin);
  if (!/^\d{6}$/.test(pin)) throw badReq('Pincode must be exactly 6 digits');

  // ── Dedup-first: existing row → created:false, no geocode/write ──
  const existing = await getPincodeByValue(pin);
  if (existing) {
    logger.info('Pincode already exists · id=' + existing.pincode_id + ' pincode=' + pin);
    return {
      pincode_id: existing.pincode_id,
      pincode:    existing.pincode,
      city_id:    existing.city_id,
      city_name:  existing.city_name,
      state_name: existing.state_name,
      lat:        existing.lat,
      lng:        existing.lng,
      created:    false,
    };
  }

  // ── Geocode + India gate ──
  const match = await geocodeAndMatch(pin);
  // geocodeAndMatch can race-detect a duplicate created between the lookup
  // above and the geocode call — honour it as the idempotent branch.
  if (match.duplicate) {
    const dupDetail = await getPincodeById(match.duplicate.pincode_id);
    return {
      pincode_id: dupDetail.pincode_id,
      pincode:    dupDetail.pincode,
      city_id:    dupDetail.city_id,
      city_name:  dupDetail.city_name,
      state_name: dupDetail.state_name,
      lat:        dupDetail.lat,
      lng:        dupDetail.lng,
      created:    false,
    };
  }
  if (!match.geocoded) {
    logger.warn('Ensure pincode failed — not geocodable · pincode=' + pin);
    throw badReq(`Pincode ${pin} is not a valid Indian pincode (could not be located)`);
  }
  // India-only: accept ISO short_code 'IN' or a long_name containing "india".
  const code = String(match.country_code || '').trim().toUpperCase();
  const name = String(match.country || '').trim().toLowerCase();
  const isIndia = code === 'IN' || name.includes('india');
  if (!isIndia) {
    logger.warn('Ensure pincode rejected — non-India result · pincode=' + pin + ' country_code=' + (code || '-'));
    throw badReq(`Pincode ${pin} is not a valid Indian pincode`);
  }

  // ── Resolve state + city (find-or-create) ──
  // geocodeAndMatch only fills city.name when it also matched a state, so use
  // the google.* blocks for the create-from-scratch path.
  const stateName = match.google?.state || match.state?.name;
  const cityName  = match.google?.city  || match.city?.name;
  if (!stateName) throw badReq(`Pincode ${pin} geocoded without a resolvable state`);
  if (!cityName)  throw badReq(`Pincode ${pin} geocoded without a resolvable city`);

  const stateId = match.state?.state_id
    || (await findOrCreateStateByName(stateName, { userId })).state_id;
  const cityId  = match.city?.city_id
    || (await findOrCreateCityByName(cityName, stateId, { district: match.district, createdByEfrId, userId })).city_id;

  let detail;
  try {
    detail = await createPincode(
      {
        pincode:  pin,
        location: cityName,
        city_id:  cityId,
        district: match.district,
        lat:      match.lat,
        lng:      match.lng,
        is_active: true,
      },
      { userId, createdByEfrId },
    );
  } catch (err) {
    // Lost a create race: another caller inserted this pincode between our
    // dedup check (above) and this INSERT. Treat 409 as the idempotent branch
    // — re-read and return the existing row instead of propagating a conflict.
    if (err && err.status === 409) {
      const dup = await getPincodeByValue(pin);
      if (dup) {
        logger.info('Pincode create raced — returning existing · pincode=' + pin);
        return {
          pincode_id: dup.pincode_id,
          pincode:    dup.pincode,
          city_id:    dup.city_id,
          city_name:  dup.city_name,
          state_name: dup.state_name,
          lat:        dup.lat,
          lng:        dup.lng,
          created:    false,
        };
      }
    }
    throw err;
  }

  logger.info('Pincode ensured (created) · id=' + detail.pincode_id + ' pincode=' + pin);
  return {
    pincode_id: detail.pincode_id,
    pincode:    detail.pincode,
    city_id:    detail.city_id,
    city_name:  detail.city_name,
    state_name: detail.state_name,
    lat:        detail.lat,
    lng:        detail.lng,
    created:    true,
  };
}

/*
 * recomputeServiceableStatus — bulk refresh of tbl_pincode.pincode_status.
 *
 * A pincode is "Serviceable" (status=1) iff it is covered by at least one
 * ACTIVE + VERIFIED technician, where coverage = the union of
 *   (a) tbl_efr_serviceable_pincodes.pincodes (CSV TEXT, FIND_IN_SET match), and
 *   (b) the tech's own tbl_easyfixer.efr_pin_no (current pincode).
 *
 * Single transaction: reset ALL rows to 0, then set the covered union to 1.
 * Returns { serviceableCount, total } reflecting post-recompute state.
 */
async function recomputeServiceableStatus({ userId = null } = {}) {
  logger.info('Recomputing serviceable pincode status');
  void userId;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Everything → Non-Serviceable.
    await conn.query('UPDATE tbl_pincode SET pincode_status = 0');

    // 2. Union of (serviceable CSV ∪ efr_pin_no) for active+verified techs → 1.
    //    EXISTS keeps it set-based (no JS CSV split); FIND_IN_SET matches the
    //    CSV column, the efr_pin_no equality catches the current pincode.
    const [upd] = await conn.query(
      `UPDATE tbl_pincode p
          SET p.pincode_status = 1
        WHERE EXISTS (
          SELECT 1
            FROM tbl_easyfixer e
            LEFT JOIN tbl_efr_serviceable_pincodes sp
                   ON sp.easyfixer_id = e.efr_id
           WHERE e.efr_status = 1
             AND e.is_technician_verified = 1
             AND ( (sp.pincodes IS NOT NULL AND FIND_IN_SET(p.pincode, sp.pincodes) > 0)
                   OR (e.efr_pin_no IS NOT NULL AND e.efr_pin_no = p.pincode) )
        )`,
    );

    const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM tbl_pincode');

    await conn.commit();
    const serviceableCount = Number(upd.affectedRows) || 0;
    logger.info({ serviceableCount, total }, 'recomputeServiceableStatus: pincode status refreshed');
    return { serviceableCount, total: Number(total) || 0 };
  } catch (e) {
    await conn.rollback();
    logger.error({ err: e.message }, 'recomputeServiceableStatus failed; rolled back');
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * Lazy geocode-on-edit. If a pincode row has no coordinates, fetch + persist
 * them now as a side-effect of an edit. This is how lat/lng get backfilled — on
 * demand, one row at a time, as pincodes are touched in Manage Pincodes —
 * instead of a manual bulk run (avoids the bulk Google cost + key throttling).
 * getCentroid() does an India-pinned Google lookup and writes the centroid onto
 * tbl_pincode via persistCentroid; it is fail-soft (returns null, logs a warn,
 * never throws), so a geocode miss or Google outage can never fail the edit.
 * Rows Google can't resolve (ZERO_RESULTS — e.g. some rural sub-localities)
 * stay blank and are retried on the next edit. Pass the already-loaded row
 * ({pincode, lat, lng}) so the no-op case (coords present) costs nothing.
 * Returns {lat,lng} when present/just-filled, else null.
 */
async function ensureCoordsForPincode({ pincode, lat, lng } = {}) {
  if (lat != null && lng != null) return { lat: Number(lat), lng: Number(lng) };
  if (!pincode) return null;
  const centroid = await geocode.getCentroid(pincode);
  return (centroid && centroid.lat != null && centroid.lng != null)
    ? { lat: centroid.lat, lng: centroid.lng }
    : null;
}

async function updatePincode(pincodeId, fields, { userId = null } = {}) {
  logger.info('Updating pincode · pincodeId=' + pincodeId + ' fields=' + Object.keys(fields || {}).join(','));
  // Whitelist of mutable fields. `pincode` is intentionally excluded — the
  // value is the user-meaningful key; changing it would orphan downstream
  // job rows that reference it. Delete + re-add is the explicit path.
  const sets = [];
  const params = [];
  if (fields.location !== undefined)       { sets.push('location = ?');       params.push(fields.location || null); }
  if (fields.city_id !== undefined)        { sets.push('city_id = ?');        params.push(Number(fields.city_id)); await assertCityExists(fields.city_id); }
  if (fields.district !== undefined)       { sets.push('district = ?');       params.push(fields.district || null); }
  // is_active true → pincode_status 1 (Serviceable); false → 0 (Non-Serviceable).
  if (fields.is_active !== undefined)      { sets.push('pincode_status = ?'); params.push(fields.is_active ? 1 : 0); }
  if (!sets.length) throw badReq('No mutable fields supplied');
  sets.push('updated_by = ?');
  params.push(userId);

  const [result] = await pool.query(
    `UPDATE tbl_pincode SET ${sets.join(', ')} WHERE pincode_id = ?`,
    [...params, pincodeId]
  );
  if (!result.affectedRows) { logger.warn('Update pincode no-op — row not found · pincodeId=' + pincodeId); return null; }
  logger.info('Pincode updated · id=' + pincodeId);

  const updated = await getPincodeById(pincodeId);
  // Lazy geocode-on-edit (see ensureCoordsForPincode): fill coords if missing.
  if (updated) {
    const coords = await ensureCoordsForPincode(updated);
    if (coords) { updated.lat = coords.lat; updated.lng = coords.lng; }
  }
  return updated;
}

/*
 * Soft-delete. We never DELETE rows because tbl_job (and other downstream
 * tables) reference pincodes by string value; a hard delete would orphan
 * historical jobs. Setting pincode_status = 0 hides the row from default
 * lists while preserving join integrity.
 */
async function deletePincode(pincodeId, { userId = null } = {}) {
  logger.info('Soft-deleting pincode · pincodeId=' + pincodeId);
  const [result] = await pool.query(
    'UPDATE tbl_pincode SET pincode_status = 0, updated_by = ? WHERE pincode_id = ?',
    [userId, pincodeId]
  );
  if (result.affectedRows > 0) logger.info('Pincode deactivated · id=' + pincodeId);
  else logger.warn('Delete pincode no-op — row not found · pincodeId=' + pincodeId);
  return result.affectedRows > 0;
}

// ─── Replace a pincode's zone set (reverse of zone.setPincodeMapping) ──
/*
 * Reverse of zone.service.js::setPincodeMapping — the Manage Pincodes page
 * maps ONE pincode to many zones. The editor sends the WHOLE zone-id list it
 * wants this pincode to belong to; we make this pincode's
 * tbl_zone_pincode_mapping rows exactly equal the accepted set: DELETE the
 * pincode's rows whose zone is not in the set, then INSERT IGNORE the wanted
 * (zone_id, pincode_id) rows. Other pincodes' rows are never touched
 * (many-to-many is allowed). Zone ids that don't exist are reported back as
 * `rejected` rather than failing the whole call.
 */
async function setZonesForPincode(pincodeId, zoneIds, { userId = null } = {}) {
  const ids = Array.from(new Set((zoneIds || []).map(Number).filter(Number.isFinite)));
  logger.info('Setting zones for pincode · pincodeId=' + pincodeId + ' zoneCount=' + ids.length);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[pinRow]] = await conn.query(
      'SELECT pincode_id FROM tbl_pincode WHERE pincode_id = ? LIMIT 1', [pincodeId]
    );
    if (!pinRow) { const e = new Error('Pincode not found'); e.status = 404; throw e; }

    const rejected = [];
    const acceptable = [];
    if (ids.length) {
      // Validate every requested zone id: must exist as an active zone.
      const placeholders = ids.map(() => '?').join(',');
      const [rows] = await conn.query(
        `SELECT zone_id FROM tbl_zone_master
          WHERE zone_id IN (${placeholders}) AND zone_status = 1`,
        ids
      );
      const valid = new Set(rows.map((r) => Number(r.zone_id)));
      for (const id of ids) {
        if (valid.has(id)) acceptable.push(id);
        else rejected.push({ zone_id: id, reason: 'Zone not found or inactive' });
      }
    }

    // Make this pincode's junction rows exactly = acceptable set.
    if (acceptable.length) {
      const ph = acceptable.map(() => '?').join(',');
      // Drop this pincode's rows whose zone is no longer wanted (other
      // pincodes untouched).
      await conn.query(
        `DELETE FROM tbl_zone_pincode_mapping
          WHERE pincode_id = ? AND zone_id NOT IN (${ph})`,
        [pincodeId, ...acceptable]
      );
      // Idempotently add the wanted rows for THIS pincode.
      const values = acceptable.map(() => '(?, ?, NOW(), ?)').join(', ');
      const params = [];
      for (const id of acceptable) params.push(id, pincodeId, userId);
      await conn.query(
        `INSERT IGNORE INTO tbl_zone_pincode_mapping
           (zone_id, pincode_id, created_on, created_by)
         VALUES ${values}`,
        params
      );
    } else {
      // Empty/all-rejected list = clear THIS pincode's junction rows only.
      await conn.query(
        'DELETE FROM tbl_zone_pincode_mapping WHERE pincode_id = ?', [pincodeId]
      );
    }

    await conn.commit();
    logger.info('Pincode zones updated · pincodeId=' + pincodeId + ' accepted=' + acceptable.length + ' rejected=' + rejected.length);
    const detail = await getPincodeById(pincodeId);
    // Lazy geocode-on-edit: mapping zones is also an edit — fill coords if
    // missing. Runs AFTER commit on the pool (not the txn conn). Wrapped so a
    // freak geocode/DB error here can NEVER reach the catch below and "roll back"
    // the already-committed zone mapping; geocoding is strictly best-effort.
    if (detail) {
      try {
        const coords = await ensureCoordsForPincode(detail);
        if (coords) { detail.lat = coords.lat; detail.lng = coords.lng; }
      } catch (geoErr) {
        logger.warn({ err: geoErr.message, pincodeId }, 'lazy geocode after zone-map failed (non-fatal)');
      }
    }
    return { ...detail, rejected };
  } catch (e) {
    await conn.rollback();
    logger.error({ err: e.message, pincodeId }, 'setZonesForPincode failed; rolled back');
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * Auto-fetch flow for the Add-Pincode modal. Geocodes the PIN via Google
 * (lat/lng + state/city/district from address_components), checks for a
 * duplicate, and maps the Google state/city to our tbl_state/tbl_city
 * (case-insensitive). Returns matched ids + `isNew` flags so the FE can show
 * the 'New' chip and warn on Save. Never throws on geocode failure (returns
 * nulls + geocoded:false).
 */
async function geocodeAndMatch(pincodeRaw) {
  const pin = String(pincodeRaw || '').trim();
  logger.info('Geocoding + matching pincode · pincode=' + pin);
  if (!/^\d{6}$/.test(pin)) throw badReq('Pincode must be exactly 6 digits');

  const [[dup]] = await pool.query(
    `SELECT p.pincode_id, p.location, c.city_name, s.state_name, p.pincode_status
       FROM tbl_pincode p
       LEFT JOIN tbl_city  c ON c.city_id  = p.city_id
       LEFT JOIN tbl_state s ON s.state_id = c.state_id
      WHERE p.pincode = ? LIMIT 1`,
    [pin]
  );

  const detail = await geocode.geocodePincodeDetail(pin); // {lat,lng,state,district,city,geocoded}

  let matchedState = null;
  if (detail?.state) {
    const [[srow]] = await pool.query(
      'SELECT state_id, state_name FROM tbl_state WHERE LOWER(TRIM(state_name)) = LOWER(?) LIMIT 1',
      [detail.state.trim()]
    );
    if (srow) matchedState = { state_id: Number(srow.state_id), state_name: srow.state_name };
  }

  // Only match the city WITHIN the matched state — never name-only across all
  // states (that could bind the PIN to a same-named city in a different state).
  // If the state is new/unmatched, the city is treated as new too.
  let matchedCity = null;
  if (detail?.city && matchedState) {
    const [[crow]] = await pool.query(
      'SELECT city_id, city_name, state_id FROM tbl_city WHERE state_id = ? AND LOWER(TRIM(city_name)) = LOWER(?) LIMIT 1',
      [matchedState.state_id, detail.city.trim()]
    );
    if (crow) matchedCity = { city_id: Number(crow.city_id), city_name: crow.city_name, state_id: Number(crow.state_id) };
  }

  logger.info('Pincode geocode-match done · pincode=' + pin + ' geocoded=' + (!!detail?.geocoded) + ' duplicate=' + (!!dup) + ' stateMatched=' + (!!matchedState) + ' cityMatched=' + (!!matchedCity));
  return {
    pincode: pin,
    duplicate: dup ? {
      pincode_id: Number(dup.pincode_id),
      location:   dup.location || null,
      city_name:  dup.city_name || null,
      state_name: dup.state_name || null,
      is_active:  Number(dup.pincode_status) === 1,
    } : null,
    geocoded: !!detail?.geocoded,
    lat: detail?.lat ?? null,
    lng: detail?.lng ?? null,
    district: detail?.district ?? null,
    country: detail?.country ?? null,
    country_code: detail?.country_code ?? null,
    google: { state: detail?.state ?? null, city: detail?.city ?? null, district: detail?.district ?? null, country: detail?.country ?? null },
    state: {
      state_id: matchedState?.state_id ?? null,
      name:     detail?.state ?? null,
      isNew:    !!(detail?.state && !matchedState),
    },
    city: {
      city_id:  matchedCity?.city_id ?? null,
      name:     detail?.city ?? null,
      state_id: matchedCity?.state_id ?? matchedState?.state_id ?? null,
      isNew:    !!(detail?.city && !matchedCity),
    },
  };
}

/*
 * Suggest the top-N (default 3) zones a new pincode could belong to.
 * Relevance is derived ENTIRELY from each zone's already-mapped pincodes (the
 * tbl_zone_pincode_mapping junction — the source of truth; tbl_zone_master
 * .city_id is NOT consulted). Ranking (per the chosen spec):
 *   1. zones that already contain a pincode in the SAME city as the new PIN;
 *   2. among those (and as fill), nearest by haversine from the new PIN's
 *      lat/lng to the zone's closest mapped pincode.
 * One query loads active zones' mapped pincodes (city + lat/lng); grouping +
 * distance run in JS (zone set is CRM-managed and small).
 */
async function suggestZonesForLocation({ cityId = null, lat = null, lng = null, limit = 3 } = {}) {
  logger.info('Suggesting zones for location · cityId=' + (cityId || '') + ' hasPoint=' + (lat != null && lng != null) + ' limit=' + limit);
  const n = Math.min(Math.max(Number(limit) || 3, 1), 10);
  const point = (lat != null && lat !== '' && lng != null && lng !== '')
    ? { lat: Number(lat), lng: Number(lng) } : null;
  const cid = cityId ? Number(cityId) : null;

  let ranked = [];
  // Relevance ranking runs only when we have a city or a geocoded point;
  // otherwise we skip straight to the random fill below (and never scan the
  // whole junction). Bounded scan: only pincodes in the SAME city, or within a
  // ~1.5° (~165 km) bounding box of the new PIN.
  if (cid || point) {
    const conds = [];
    const params = [];
    if (cid) { conds.push('p.city_id = ?'); params.push(cid); }
    if (point) {
      const D = 1.5;
      conds.push('(p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?)');
      params.push(point.lat - D, point.lat + D, point.lng - D, point.lng + D);
    }
    const [rows] = await pool.query(
      `SELECT z.zone_id, z.zone_name, p.city_id AS p_city_id, p.lat, p.lng
         FROM tbl_zone_master z
         JOIN tbl_zone_pincode_mapping zpm ON zpm.zone_id = z.zone_id
         JOIN tbl_pincode p ON p.pincode_id = zpm.pincode_id
        WHERE z.zone_status = 1 AND (${conds.join(' OR ')})`,
      params
    );
    const zones = new Map();
    for (const r of rows) {
      const id = Number(r.zone_id);
      let z = zones.get(id);
      if (!z) { z = { zone_id: id, zone_name: r.zone_name, sameCity: false, minDist: null }; zones.set(id, z); }
      if (cid && Number(r.p_city_id) === cid) z.sameCity = true;
      if (point && r.lat != null && r.lng != null) {
        const d = geocode.haversineKm(point, { lat: Number(r.lat), lng: Number(r.lng) });
        if (d != null && (z.minDist == null || d < z.minDist)) z.minDist = d;
      }
    }
    ranked = [...zones.values()].sort((a, b) => {
      if (a.sameCity !== b.sameCity) return a.sameCity ? -1 : 1; // same-city first
      const ad = a.minDist == null ? Infinity : a.minDist;
      const bd = b.minDist == null ? Infinity : b.minDist;
      if (ad !== bd) return ad - bd;                              // then nearest
      return String(a.zone_name).localeCompare(String(b.zone_name));
    }).slice(0, n).map((z) => ({
      zone_id: z.zone_id,
      zone_name: z.zone_name,
      reason: z.sameCity ? 'same_city' : 'nearby',
      distance_km: z.minDist == null ? null : Number(z.minDist.toFixed(1)),
    }));
  }

  // ALWAYS return n suggestions: pad with RANDOM active zones (excluding the
  // already-ranked ones) when fewer than n relevant zones exist — including the
  // no-signal case (brand-new city with no nearby zones). Padded rows carry
  // reason:'random' so the FE can label them. tbl_zone_master is small, so
  // ORDER BY RAND() is fine here.
  if (ranked.length < n) {
    const have = ranked.map((z) => z.zone_id);
    const notIn = have.length ? `AND zone_id NOT IN (${have.map(() => '?').join(',')})` : '';
    const [randRows] = await pool.query(
      `SELECT zone_id, zone_name FROM tbl_zone_master
        WHERE zone_status = 1 ${notIn}
        ORDER BY RAND() LIMIT ?`,
      [...have, n - ranked.length]
    );
    for (const r of randRows) {
      ranked.push({ zone_id: Number(r.zone_id), zone_name: r.zone_name, reason: 'random', distance_km: null });
    }
  }
  logger.info('Returning ' + ranked.length + ' suggested zones');
  return ranked;
}

module.exports = {
  STATUS,
  listPincodes,
  getPincodeById,
  getPincodeByValue,
  lookupManyByCode,
  createPincode,
  ensurePincode,
  recomputeServiceableStatus,
  updatePincode,
  deletePincode,
  listTechniciansForPincode,
  setZonesForPincode,
  geocodeAndMatch,
  suggestZonesForLocation,
};
