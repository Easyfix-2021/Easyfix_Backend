const { pool } = require('../db');

/*
 * Reference registry for Manage Materials — answers "what points at this
 * brand/material?" for delete-guard 409s and for replace-and-delete
 * repointing.
 *
 * A new entity type registers itself here instead of every deletion path
 * hand-rolling its own reference scan. Today only brand ← price-group-brand
 * is registered (a material's own price groups are its children and are
 * deleted WITH it, not a "reference"). Future client rate cards / quotation
 * lines that carry a brand_id or material_id register here too.
 */

const REGISTRY = { brand: [], material: [] };

/**
 * @param {'brand'|'material'} entity
 * @param {string} type        machine key, e.g. 'material_price_group_brand'
 * @param {string} label       human label for the 409 payload, e.g. 'Materials'
 * @param {string} countSql    SQL returning one row `cnt` for a given id — must
 *                              take exactly one `?` placeholder (the entity id).
 * @param {string=} repointSql UPDATE that swaps fromId -> toId on the referencing
 *                              table — takes `(toId, fromId)` placeholders, in
 *                              that order. Required for repointReferences() to work.
 * @param {string=} conflictSql SELECT returning rows describing rows where the
 *                              replacement is ALREADY present alongside fromId
 *                              (so repointing would collide) — takes
 *                              `(fromId, toId)` placeholders, in that order.
 */
function registerReference({ entity, type, label, countSql, repointSql, conflictSql }) {
  if (!REGISTRY[entity]) throw new Error(`registerReference: unknown entity "${entity}"`);
  REGISTRY[entity].push({ type, label, countSql, repointSql, conflictSql });
}

async function countReferences(entity, id) {
  const regs = REGISTRY[entity] || [];
  const by_type = [];
  let total = 0;
  for (const r of regs) {
    const [[row]] = await pool.query(r.countSql, [id]);
    const count = Number(row && row.cnt) || 0;
    // A countSql may also return `active_cnt` — split so the UI can explain why
    // a list "Used By" (active only) reads 0 while delete is still blocked.
    const split = row && row.active_cnt != null
      ? { active: Number(row.active_cnt) || 0, inactive: count - (Number(row.active_cnt) || 0) }
      : {};
    if (count > 0) by_type.push({ type: r.type, label: r.label, count, ...split });
    total += count;
  }
  return { total, by_type };
}

/** Returns rows describing any conflict (replacement already present alongside fromId). */
async function findRepointConflicts(entity, fromId, toId) {
  const regs = REGISTRY[entity] || [];
  const conflicts = [];
  for (const r of regs) {
    if (!r.conflictSql) continue;
    const [rows] = await pool.query(r.conflictSql, [fromId, toId]);
    conflicts.push(...rows);
  }
  return conflicts;
}

/** Repoints every registered reference from fromId to toId, inside the caller's transaction. */
async function repointReferences(conn, entity, fromId, toId) {
  const regs = REGISTRY[entity] || [];
  let repointed = 0;
  for (const r of regs) {
    if (!r.repointSql) continue;
    const [result] = await conn.query(r.repointSql, [toId, fromId]);
    repointed += result.affectedRows || 0;
  }
  return repointed;
}

// ─── Registrations ──────────────────────────────────────────────────────

registerReference({
  entity: 'brand',
  type: 'material_price_group_brand',
  label: 'Materials',
  countSql: `SELECT COUNT(DISTINCT gb.material_id) AS cnt,
                    COUNT(DISTINCT CASE WHEN m.status = 1 THEN gb.material_id END) AS active_cnt
               FROM tbl_material_price_group_brand gb
               LEFT JOIN tbl_material_master m ON m.material_id = gb.material_id
              WHERE gb.brand_id = ?`,
  // Repointing a brand on a group where the replacement is ALREADY present on
  // the same material would collide with uq_group_brand_material — the
  // caller must check findRepointConflicts() first and 409 before calling this.
  repointSql: `UPDATE tbl_material_price_group_brand SET brand_id = ? WHERE brand_id = ?`,
  // Placeholder order matches the documented (fromId, toId) contract:
  // 1st ? = fromId (the brand being replaced), 2nd ? = toId (the replacement).
  conflictSql: `
    SELECT DISTINCT gb_to.material_id, m.material_name
      FROM tbl_material_price_group_brand gb_from
      JOIN tbl_material_price_group_brand gb_to
        ON gb_to.material_id = gb_from.material_id AND gb_from.brand_id = ?
      JOIN tbl_material_master m ON m.material_id = gb_from.material_id
     WHERE gb_to.brand_id = ?`,
});

module.exports = { registerReference, countReferences, findRepointConflicts, repointReferences };
