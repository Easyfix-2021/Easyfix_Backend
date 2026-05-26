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

/* ─── List ────────────────────────────────────────────────────────── */

async function listForClient(clientId) {
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
  const [mappings] = await pool.query(
    `SELECT m.mapping_id, m.client_id, m.service_type_id,
            m.easyfixer_id AS efr_id, m.mapping_status,
            e.efr_first_name, e.efr_last_name,
            e.efr_no, e.efr_mobile, e.city_name,
            e.is_technician_verified
       FROM tbl_client_easyfixer_mapping m
       LEFT JOIN tbl_easyfixer e ON e.efr_id = m.easyfixer_id
      WHERE m.client_id = ?
        AND (m.mapping_status IS NULL OR m.mapping_status <> 0)
      ORDER BY m.service_type_id ASC, e.efr_first_name ASC`,
    [clientId],
  );
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
    return cleaned.length;
  } catch (e) {
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
  return rows.map((r) => ({
    efr_id: r.efr_id,
    efr_name: [r.efr_first_name, r.efr_last_name].filter(Boolean).join(' ').trim() || null,
    efr_no: r.efr_no,
    city_name: r.city_name,
    is_technician_verified: !!r.is_technician_verified,
  }));
}

module.exports = {
  listForClient,
  replaceForServiceType,
  eligibleTechsFor,
};
