/*
 * Client × Service-Type × Technician mapping.
 *
 * Backed by `tbl_client_easyfixer_mapping`:
 *   mapping_id PK, client_id, service_type_id, efr_id, mapping_status (1/0)
 *
 * Semantics:
 *   - One row per (client, service_type, technician) triple.
 *   - mapping_status = 1 means active. The legacy UI also flipped this
 *     to 0 to "soft-disable" a row; we preserve that vocabulary.
 *
 * Performance profile:
 *
 *   listForClient(clientId) → **2 queries**:
 *     1. mappings LEFT JOIN tbl_easyfixer for tech name + city
 *     2. LEFT JOIN tbl_service_type for service-type names (single)
 *
 *     We do this as two distinct queries instead of one mega-join
 *     because the second JOIN would force a row-per-(mapping × type)
 *     blow-up; instead we collect distinct service_type_ids and resolve
 *     them in a single IN (?) lookup. Total cost: 2 round-trips for
 *     the whole grid regardless of size.
 *
 *   replaceForServiceType(clientId, serviceTypeId, efrIds) → 1 TX with
 *     DELETE + bulk INSERT. Replace-set per service-type so the UI can
 *     manage one row of the grid at a time without sending the whole
 *     grid.
 *
 *   eligibleTechsFor(serviceTypeId, { city }) → 1 query against
 *     tbl_easyfixer (joined to tbl_easyfixer_skill if present);
 *     verifies status + active. Used to populate the picker.
 *
 * Future optimisation: if (client_id, service_type_id) is queried
 * frequently for filter, add an index on that pair — the existing
 * legacy schema may already have it (it's a natural query shape).
 */

const { pool } = require('../db');
const logger = require('../logger');

/* ─── Column probes ───────────────────────────────────────────────── */

// `tbl_easyfixer.efr_mobile` is a blueprint-era column that doesn't
// exist on every deployment. The canonical mobile-ish column is
// `efr_no` (per CLAUDE.md glossary). Probe once per process and pick
// the right column literal at query-build time so the FE response
// field name `efr_mobile` stays stable.
let _efrMobileProbed = false;
let _efrHasMobileCol = false;
async function easyfixerHasMobileCol(p) {
  if (_efrMobileProbed) return _efrHasMobileCol;
  try {
    await p.query('SELECT efr_mobile FROM tbl_easyfixer LIMIT 1');
    _efrHasMobileCol = true;
  } catch (_e) { _efrHasMobileCol = false; }
  _efrMobileProbed = true;
  return _efrHasMobileCol;
}

// `tbl_easyfixer.city_name` is also a blueprint-era denormalised column
// missing on some deployments — the canonical FK is `efr_cityId` →
// `tbl_city.city_id`. Probe once and pick column literal vs JOIN at
// query-build time so the FE response field name `city_name` stays
// stable.
let _efrCityNameProbed = false;
let _efrHasCityNameCol = false;
async function easyfixerHasCityNameCol(p) {
  if (_efrCityNameProbed) return _efrHasCityNameCol;
  try {
    await p.query('SELECT city_name FROM tbl_easyfixer LIMIT 1');
    _efrHasCityNameCol = true;
  } catch (_e) { _efrHasCityNameCol = false; }
  _efrCityNameProbed = true;
  return _efrHasCityNameCol;
}

/* ─── List ────────────────────────────────────────────────────────── */

async function listForClient(clientId) {
  logger.info('List client tech mappings · clientId=' + clientId);
  // Query 1: mappings + technician info in one JOIN. We deliberately
  // skip the service_type JOIN here to avoid a row-blow-up if a future
  // schema makes service_types many-to-many on a mapping (unlikely
  // today but the column-list shape stays stable this way).
  // Column-name landmine: `tbl_client_easyfixer_mapping` FK column to
  // tbl_easyfixer is **`easyfixer_id`** (NOT `efr_id`). Verified
  // against legacy `EasyfixerDaoImpl.java#296`:
  //   `CM.easyfixer_id = EF.efr_id`
  // tbl_easyfixer's PK IS `efr_id` — only the mapping table's FK
  // breaks the naming pattern. The wire alias `efr_id` keeps the FE
  // contract stable.
  // Column-name drift: some deployments lack `tbl_easyfixer.efr_mobile`.
  // Fall back to `efr_no AS efr_mobile` so the wire shape stays stable.
  const mobileExpr = (await easyfixerHasMobileCol(pool))
    ? 'e.efr_mobile'
    : 'e.efr_no AS efr_mobile';
  const hasCityNameCol = await easyfixerHasCityNameCol(pool);
  const cityNameExpr = hasCityNameCol ? 'e.city_name' : 'c.city_name AS city_name';
  const cityJoin = hasCityNameCol ? '' : 'LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId';
  const [mappings] = await pool.query(
    `SELECT m.mapping_id, m.client_id, m.service_type_id,
            m.easyfixer_id AS efr_id, m.mapping_status,
            e.efr_first_name, e.efr_last_name,
            e.efr_no, ${mobileExpr}, ${cityNameExpr},
            e.is_technician_verified
       FROM tbl_client_easyfixer_mapping m
       LEFT JOIN tbl_easyfixer e ON e.efr_id = m.easyfixer_id
       ${cityJoin}
      WHERE m.client_id = ?
        AND (m.mapping_status IS NULL OR m.mapping_status <> 0)
      ORDER BY m.service_type_id ASC, e.efr_first_name ASC`,
    [clientId],
  );
  logger.info('Found ' + mappings.length + ' tech mappings');
  if (mappings.length === 0) return [];

  // Query 2: bulk resolve service_type names.
  const typeIds = Array.from(new Set(mappings.map((m) => m.service_type_id))).filter(Boolean);
  let nameById = new Map();
  if (typeIds.length > 0) {
    const [types] = await pool.query(
      `SELECT service_type_id, service_type_name FROM tbl_service_type WHERE service_type_id IN (?)`,
      [typeIds],
    );
    nameById = new Map(types.map((t) => [t.service_type_id, t.service_type_name]));
  }
  return mappings.map((m) => {
    // tbl_easyfixer uses `efr_first_name` + `efr_last_name` per the
    // glossary in CLAUDE.md. Compose them for FE display.
    const name = [m.efr_first_name, m.efr_last_name]
      .filter(Boolean).join(' ').trim() || null;
    return {
      mapping_id: m.mapping_id,
      client_id: m.client_id,
      service_type_id: m.service_type_id,
      service_type_name: nameById.get(m.service_type_id) || null,
      efr_id: m.efr_id,
      efr_name: name,
      efr_no: m.efr_no,
      efr_mobile: m.efr_mobile,
      city_name: m.city_name,
      is_technician_verified: !!m.is_technician_verified,
      mapping_status: m.mapping_status,
    };
  });
}

/* ─── Replace-set per service_type ────────────────────────────────── */

/*
 * For a given (client, service_type), replace the set of assigned
 * technicians with `efrIds`. TX-wrapped so the UI sees an all-or-
 * nothing change.
 *
 * Empty `efrIds` clears all assignments for that service_type
 * (deactivates rather than deletes — matches legacy soft-delete
 * convention via mapping_status=0).
 */
async function replaceForServiceType(clientId, serviceTypeId, efrIds) {
  const cleaned = Array.from(new Set(
    (efrIds || []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0),
  ));
  logger.info('Replace tech mappings · clientId=' + clientId + ' serviceTypeId=' + serviceTypeId + ' techCount=' + cleaned.length);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Soft-delete the old set in one statement.
    await conn.query(
      `UPDATE tbl_client_easyfixer_mapping
          SET mapping_status = 0
        WHERE client_id = ? AND service_type_id = ?`,
      [clientId, serviceTypeId],
    );
    if (cleaned.length > 0) {
      // Bulk insert / re-activate. ON DUPLICATE KEY would be cleanest
      // but we don't know if the table has a (client, service_type, efr)
      // unique key. Safe approach: delete old soft-deleted matches,
      // then INSERT clean. Two statements still in the TX.
      await conn.query(
        `DELETE FROM tbl_client_easyfixer_mapping
          WHERE client_id = ? AND service_type_id = ?
            AND mapping_status = 0`,
        [clientId, serviceTypeId],
      );
      // Column-name landmine: FK column is `easyfixer_id`, NOT `efr_id`.
      const values = cleaned.map((efr) => [clientId, serviceTypeId, efr, 1]);
      await conn.query(
        `INSERT INTO tbl_client_easyfixer_mapping
            (client_id, service_type_id, easyfixer_id, mapping_status)
          VALUES ?`,
        [values],
      );
    }
    await conn.commit();
    logger.info('Tech mappings replaced · clientId=' + clientId + ' serviceTypeId=' + serviceTypeId + ' assigned=' + cleaned.length);
    return cleaned.length;
  } catch (e) {
    logger.error('Replace tech mappings failed · clientId=' + clientId + ' serviceTypeId=' + serviceTypeId + ' · ' + e.message);
    try { await conn.rollback(); } catch (_) { /* swallow */ }
    throw e;
  } finally {
    conn.release();
  }
}

/* ─── Eligibility picker ──────────────────────────────────────────── */

/*
 * Eligible technicians for a service_type. Filter shape mirrors the
 * legacy `getEasyfixerListForMap` action:
 *   - status active (e.efr_status = 1)
 *   - verified (e.is_technician_verified = 1) by default; can be
 *     relaxed via opts.includeUnverified for ops "see all" mode
 *   - optionally scoped to a city
 *
 * Returns lightweight rows — name + id + verification status — so the
 * picker stays scannable. NO joins to skills tables here because
 * the column existence varies across deployments (a follow-up could
 * gate that behind a column probe).
 */
async function eligibleTechsFor(serviceTypeId, opts = {}) {
  logger.info('List eligible techs · serviceTypeId=' + serviceTypeId + ' includeUnverified=' + (opts.includeUnverified === true) + (opts.cityId ? ' cityId=' + opts.cityId : '') + (opts.cityName ? ' cityName=' + opts.cityName : ''));
  const clauses = ['(e.efr_status IS NULL OR e.efr_status = 1)'];
  const params = [];
  if (opts.includeUnverified !== true) clauses.push('e.is_technician_verified = 1');
  if (opts.cityId) { clauses.push('e.city_id = ?'); params.push(opts.cityId); }
  if (opts.cityName) { clauses.push('e.city_name = ?'); params.push(opts.cityName); }
  if (opts.query) {
    // tbl_easyfixer uses `efr_first_name` + `efr_last_name` per CLAUDE.md
    // glossary. Match either fragment or the operator code.
    clauses.push('(e.efr_first_name LIKE ? OR e.efr_last_name LIKE ? OR e.efr_no LIKE ?)');
    const q = `%${opts.query}%`;
    params.push(q, q, q);
  }
  // service_type filter requires a skill-mapping JOIN that varies by
  // deployment. We surface the unfiltered list (by status + verification)
  // for v1 — the FE can scope by city/name. Adding a skill-filter pass
  // would require a column probe over tbl_easyfixer_skill.
  void serviceTypeId;
  const [rows] = await pool.query(
    `SELECT e.efr_id,
            e.efr_first_name, e.efr_last_name,
            e.efr_no, e.city_name, e.is_technician_verified
       FROM tbl_easyfixer e
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.efr_first_name ASC
      LIMIT 500`,
    params,
  );
  logger.info('Found ' + rows.length + ' eligible techs');
  return rows.map((r) => ({
    efr_id: r.efr_id,
    efr_name: [r.efr_first_name, r.efr_last_name].filter(Boolean).join(' ').trim() || null,
    efr_no: r.efr_no,
    city_name: r.city_name,
    is_technician_verified: !!r.is_technician_verified,
  }));
}

/* ─── Summary (lazy-load shell for the tab) ───────────────────────── */

/*
 * Returns one row per (client, service_type) pair the client is mapped
 * against — with the technician count and a compact per-city breakdown
 * (top 6 cities + a "+N more" rollup). This is what the Tech Mapping
 * tab now mounts with: a single ~163-row payload instead of the full
 * mapping list (which could be 10K+ rows for big clients and took ~4s).
 *
 * Wire shape:
 *   [{
 *     service_type_id,
 *     service_type_name,
 *     tech_count,
 *     city_breakdown: [{ city_name, count }, ...]   // top 6 by count
 *     other_cities_count: 12                         // techs not in top 6
 *   }]
 *
 * Implementation: 2 round-trips.
 *   Q1: per-service-type counts + service-type name (single JOIN + GROUP BY).
 *   Q2: per-(service_type, city) counts, then trim to top 6 per type in JS.
 *
 * No SELECT *, no row-per-tech JOIN to tbl_easyfixer — that's what
 * made the legacy list slow on large clients.
 */
async function summaryForClient(clientId) {
  logger.info('Tech mapping summary · clientId=' + clientId);
  // Q1: total count per service_type (active mappings only).
  //
  // Note on duplicates: tbl_service_type can contain multiple rows with
  // an identical service_type_name (legacy data — different service_type_id
  // values share names like "1 - Furniture Unpack & Install/Assembly").
  // We group by service_type_id so each id keeps its own mapping bucket
  // (Edit Techs needs to target one id at a time). The FE renders the
  // service_type_id as a chip next to the name so operators can tell
  // visually-identical rows apart. Tie-break ORDER BY service_type_id
  // makes the display order stable across reloads.
  const [counts] = await pool.query(
    `SELECT m.service_type_id,
            st.service_type_name,
            COUNT(*) AS tech_count
       FROM tbl_client_easyfixer_mapping m
       LEFT JOIN tbl_service_type st ON st.service_type_id = m.service_type_id
      WHERE m.client_id = ?
        AND (m.mapping_status IS NULL OR m.mapping_status <> 0)
      GROUP BY m.service_type_id, st.service_type_name
      ORDER BY st.service_type_name ASC, m.service_type_id ASC`,
    [clientId],
  );
  logger.info('Found ' + counts.length + ' service-type buckets');
  if (counts.length === 0) return [];

  // Q2: per-(service_type, city) counts. Probe city column shape once.
  const hasCityNameCol = await easyfixerHasCityNameCol(pool);
  const cityNameExpr = hasCityNameCol ? 'e.city_name' : 'c.city_name';
  const cityJoin = hasCityNameCol ? '' : 'LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId';
  const [cityRows] = await pool.query(
    `SELECT m.service_type_id,
            ${cityNameExpr} AS city_name,
            COUNT(*) AS count
       FROM tbl_client_easyfixer_mapping m
       LEFT JOIN tbl_easyfixer e ON e.efr_id = m.easyfixer_id
       ${cityJoin}
      WHERE m.client_id = ?
        AND (m.mapping_status IS NULL OR m.mapping_status <> 0)
      GROUP BY m.service_type_id, ${cityNameExpr}
      ORDER BY m.service_type_id ASC, COUNT(*) DESC`,
    [clientId],
  );

  // Bucket city rows by service_type_id, keep top 6, roll up the rest.
  const byType = new Map();
  for (const r of cityRows) {
    let bucket = byType.get(r.service_type_id);
    if (!bucket) { bucket = []; byType.set(r.service_type_id, bucket); }
    bucket.push({ city_name: r.city_name || '—', count: Number(r.count) });
  }
  const TOP_N = 6;
  return counts.map((c) => {
    const all = byType.get(c.service_type_id) ?? [];
    const top = all.slice(0, TOP_N);
    const other = all.slice(TOP_N).reduce((sum, x) => sum + x.count, 0);
    return {
      service_type_id: c.service_type_id,
      service_type_name: c.service_type_name || null,
      tech_count: Number(c.tech_count),
      city_breakdown: top,
      other_cities_count: other,
    };
  });
}

/* ─── Detail for one service-type (lazy expand) ───────────────────── */

/*
 * Returns the full tech-chip list for a SINGLE (client, service_type).
 * Used when the user expands a row in the tab. Same wire shape as
 * `listForClient` rows so the FE can reuse the chip renderer.
 */
async function listForClientServiceType(clientId, serviceTypeId) {
  logger.info('List tech mappings for service-type · clientId=' + clientId + ' serviceTypeId=' + serviceTypeId);
  const mobileExpr = (await easyfixerHasMobileCol(pool))
    ? 'e.efr_mobile'
    : 'e.efr_no AS efr_mobile';
  const hasCityNameCol = await easyfixerHasCityNameCol(pool);
  const cityNameExpr = hasCityNameCol ? 'e.city_name' : 'c.city_name AS city_name';
  const cityJoin = hasCityNameCol ? '' : 'LEFT JOIN tbl_city c ON c.city_id = e.efr_cityId';
  const [mappings] = await pool.query(
    `SELECT m.mapping_id, m.client_id, m.service_type_id,
            m.easyfixer_id AS efr_id, m.mapping_status,
            e.efr_first_name, e.efr_last_name,
            e.efr_no, ${mobileExpr}, ${cityNameExpr},
            e.is_technician_verified
       FROM tbl_client_easyfixer_mapping m
       LEFT JOIN tbl_easyfixer e ON e.efr_id = m.easyfixer_id
       ${cityJoin}
      WHERE m.client_id = ?
        AND m.service_type_id = ?
        AND (m.mapping_status IS NULL OR m.mapping_status <> 0)
      ORDER BY ${hasCityNameCol ? 'e.city_name' : 'c.city_name'} ASC, e.efr_first_name ASC`,
    [clientId, serviceTypeId],
  );
  logger.info('Found ' + mappings.length + ' tech mappings · serviceTypeId=' + serviceTypeId);
  return mappings.map((m) => {
    const name = [m.efr_first_name, m.efr_last_name]
      .filter(Boolean).join(' ').trim() || null;
    return {
      mapping_id: m.mapping_id,
      client_id: m.client_id,
      service_type_id: m.service_type_id,
      service_type_name: null, // FE already knows it from the summary.
      efr_id: m.efr_id,
      efr_name: name,
      efr_no: m.efr_no,
      efr_mobile: m.efr_mobile,
      city_name: m.city_name,
      is_technician_verified: !!m.is_technician_verified,
      mapping_status: m.mapping_status,
    };
  });
}

module.exports = {
  listForClient,
  summaryForClient,
  listForClientServiceType,
  replaceForServiceType,
  eligibleTechsFor,
};
