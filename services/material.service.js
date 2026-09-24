const { pool } = require('../db');
const logger = require('../logger');
const { nameKey } = require('../utils/name-key');
const refs = require('./material-references');

/*
 * Manage Materials — Material Master (tbl_material_master + its price-group
 * children). See scratchpad/manage-materials-contract.md for the full rule
 * set; this file enforces it server-side (the FE mirrors it for UX only).
 *
 * Pricing model recap:
 *   FIXED material   → 1+ "groups", each group = a price + the brand(s) it
 *                       applies to (+ optional per-state price overrides).
 *   DYNAMIC material  → no groups at all; price is decided manually per job.
 *   price_pending     → DERIVED (never stored): FIXED and (no groups, or any
 *                       group's price is NULL). Import may leave a group's
 *                       price NULL on purpose; a UI save may not.
 */

function mkErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

// ─── Lookups ────────────────────────────────────────────────────────────

async function listUoms() {
  const [rows] = await pool.query(
    `SELECT uom_id, uom_name FROM tbl_uom_master WHERE status = 1 ORDER BY uom_name ASC`
  );
  return rows;
}

// ─── List / detail ──────────────────────────────────────────────────────

const SORTABLE_COLUMNS = Object.freeze({
  material_name:     'm.material_name',
  service_catg_name: 'sc.service_catg_name',
  pricing_type:      'm.pricing_type',
  price_min:         'pg.price_min',
  status:            'm.status',
});

async function listMaterials({
  search, service_catg_id, pricing_type, brand_id, status = 'active',
  page = 0, limit = 20, sort_by = 'material_name', sort_dir = 'asc',
} = {}) {
  limit = Math.min(Math.max(Number(limit) || 20, 1), 1000);
  page  = Math.max(Number(page) || 0, 0);
  const offset = page * limit;

  logger.info('List materials · search=' + (search || '') + ' catg=' + (service_catg_id || '') + ' status=' + status + ' page=' + page);

  const where = [];
  const params = [];
  if (status === 'active') where.push('m.status = 1');
  else if (status === 'inactive') where.push('m.status = 0');
  // 'price_pending' and 'all' handled via HAVING / no filter below.

  if (search) { where.push('m.material_name LIKE ?'); params.push(`%${search}%`); }
  if (service_catg_id) { where.push('m.service_catg_id = ?'); params.push(Number(service_catg_id)); }
  if (pricing_type) { where.push('m.pricing_type = ?'); params.push(String(pricing_type).toUpperCase()); }
  if (brand_id) {
    where.push(`EXISTS (SELECT 1 FROM tbl_material_price_group_brand gb WHERE gb.material_id = m.material_id AND gb.brand_id = ?)`);
    params.push(Number(brand_id));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const havingSql = status === 'price_pending' ? 'HAVING price_pending = 1' : '';

  const sortExpr = SORTABLE_COLUMNS[sort_by] || SORTABLE_COLUMNS.material_name;
  const dir = String(sort_dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const [rows] = await pool.query(
    `SELECT m.material_id, m.material_name, m.description, m.service_catg_id, sc.service_catg_name,
            m.uom_id, u.uom_name, m.pricing_type, CAST(m.status AS SIGNED) AS status,
            COALESCE(pg.group_count, 0) AS group_count,
            pg.price_min, pg.price_max,
            bn.brand_names_raw,
            CASE WHEN m.pricing_type = 'FIXED' AND (COALESCE(pg.group_count,0) = 0 OR COALESCE(pg.null_price_count,0) > 0)
                 THEN 1 ELSE 0 END AS price_pending
       FROM tbl_material_master m
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = m.service_catg_id
       LEFT JOIN tbl_uom_master u ON u.uom_id = m.uom_id
       LEFT JOIN (
         SELECT material_id, COUNT(*) AS group_count, MIN(price) AS price_min, MAX(price) AS price_max,
                SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS null_price_count
           FROM tbl_material_price_group GROUP BY material_id
       ) pg ON pg.material_id = m.material_id
       LEFT JOIN (
         SELECT gb.material_id, GROUP_CONCAT(DISTINCT bm.brand_name ORDER BY bm.brand_name SEPARATOR '␟') AS brand_names_raw
           FROM tbl_material_price_group_brand gb
           JOIN tbl_brand_master bm ON bm.brand_id = gb.brand_id
          GROUP BY gb.material_id
       ) bn ON bn.material_id = m.material_id
       ${whereSql}
       ${havingSql}
      ORDER BY ${sortExpr} ${dir}, m.material_id ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [totalRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM (
       SELECT m.material_id,
              CASE WHEN m.pricing_type = 'FIXED' AND (COALESCE(pg.group_count,0) = 0 OR COALESCE(pg.null_price_count,0) > 0)
                   THEN 1 ELSE 0 END AS price_pending
         FROM tbl_material_master m
         LEFT JOIN (
           SELECT material_id, COUNT(*) AS group_count,
                  SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS null_price_count
             FROM tbl_material_price_group GROUP BY material_id
         ) pg ON pg.material_id = m.material_id
         ${whereSql}
     ) t ${havingSql}`,
    params
  );
  const total = totalRows[0] ? totalRows[0].total : 0;

  const items = rows.map((r) => ({
    material_id: r.material_id,
    material_name: r.material_name,
    description: r.description,
    service_catg_id: r.service_catg_id,
    service_catg_name: r.service_catg_name,
    uom_id: r.uom_id,
    uom_name: r.uom_name,
    pricing_type: r.pricing_type,
    status: r.status,
    price_pending: !!r.price_pending,
    group_count: r.group_count,
    brand_names: r.brand_names_raw ? r.brand_names_raw.split('␟') : [],
    price_min: r.price_min,
    price_max: r.price_max,
  }));
  logger.info('Found ' + items.length + ' materials (total=' + total + ')');
  return { items, total };
}

async function getMaterialRow(id) {
  const [[row]] = await pool.query(
    `SELECT m.material_id, m.material_name, m.description, m.service_catg_id, sc.service_catg_name,
            m.uom_id, u.uom_name, m.pricing_type, CAST(m.status AS SIGNED) AS status
       FROM tbl_material_master m
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = m.service_catg_id
       LEFT JOIN tbl_uom_master u ON u.uom_id = m.uom_id
      WHERE m.material_id = ?
      LIMIT 1`,
    [id]
  );
  return row || null;
}

async function getMaterialById(id) {
  const row = await getMaterialRow(id);
  if (!row) return null;

  const [groupRows] = await pool.query(
    `SELECT group_id, price FROM tbl_material_price_group WHERE material_id = ? ORDER BY sort_order ASC, group_id ASC`,
    [id]
  );
  const groupIds = groupRows.map((g) => g.group_id);
  let brandRows = [];
  let stateRows = [];
  let stateStateRows = [];
  if (groupIds.length) {
    [[brandRows], [stateRows]] = await Promise.all([
      pool.query(
        `SELECT gb.group_id, bm.brand_id, bm.brand_name, CAST(bm.status AS SIGNED) AS status, CAST(bm.is_system AS SIGNED) AS is_system
           FROM tbl_material_price_group_brand gb
           JOIN tbl_brand_master bm ON bm.brand_id = gb.brand_id
          WHERE gb.group_id IN (?)`,
        [groupIds]
      ),
      pool.query(
        `SELECT state_price_id, group_id, price FROM tbl_material_state_price WHERE group_id IN (?)`,
        [groupIds]
      ),
    ]);
    const spIds = stateRows.map((s) => s.state_price_id);
    if (spIds.length) {
      const [ssRows] = await pool.query(
        `SELECT state_price_id, state_id FROM tbl_material_state_price_state WHERE state_price_id IN (?)`,
        [spIds]
      );
      stateStateRows = ssRows;
    }
  }

  const statesByPriceId = new Map();
  for (const s of stateStateRows) {
    if (!statesByPriceId.has(s.state_price_id)) statesByPriceId.set(s.state_price_id, []);
    statesByPriceId.get(s.state_price_id).push(s.state_id);
  }
  const statesByGroup = new Map();
  for (const sp of stateRows) {
    if (!statesByGroup.has(sp.group_id)) statesByGroup.set(sp.group_id, []);
    statesByGroup.get(sp.group_id).push({
      state_price_id: sp.state_price_id,
      price: sp.price,
      state_ids: statesByPriceId.get(sp.state_price_id) || [],
    });
  }
  const brandsByGroup = new Map();
  for (const b of brandRows) {
    if (!brandsByGroup.has(b.group_id)) brandsByGroup.set(b.group_id, []);
    brandsByGroup.get(b.group_id).push({
      brand_id: b.brand_id, brand_name: b.brand_name, status: b.status, is_system: b.is_system,
    });
  }

  const groups = groupRows.map((g) => ({
    group_id: g.group_id,
    price: g.price,
    brands: brandsByGroup.get(g.group_id) || [],
    states: statesByGroup.get(g.group_id) || [],
  }));

  const price_pending = row.pricing_type === 'FIXED' && (groups.length === 0 || groups.some((g) => g.price === null));

  return { ...row, price_pending, groups };
}

// ─── Group-payload validation (UI + import share this) ──────────────────

/**
 * Validates a create/edit groups payload against the contract rules.
 * `allowNullPrice` = true lets a FIXED group's price be NULL (import path,
 * which stores it as Price Pending); UI create/edit always passes false —
 * except a "No Brand" group (brand_ids: []), whose price is always optional,
 * even on a UI save (Decision A: No Brand replaces the old "Not Applicable"
 * system brand). A No Brand group is legal only as the sole group.
 */
async function validateGroupsPayload(pricingType, groups, { allowNullPrice = false } = {}) {
  const type = String(pricingType || '').toUpperCase();
  if (type !== 'FIXED' && type !== 'DYNAMIC') throw mkErr(422, 'pricing_type must be FIXED or DYNAMIC.');

  const list = Array.isArray(groups) ? groups : [];

  if (type === 'DYNAMIC') {
    if (list.length > 0) throw mkErr(422, 'DYNAMIC materials cannot carry price groups.');
    return;
  }

  // FIXED from here.
  if (list.length === 0) throw mkErr(422, 'FIXED materials require at least one price group.');

  const seenBrandAcrossGroups = new Set();
  let noBrandGroupCount = 0;

  for (const g of list) {
    const brandIds = Array.isArray(g.brand_ids) ? g.brand_ids.map(Number) : [];
    const isNoBrand = brandIds.length === 0;
    if (isNoBrand) noBrandGroupCount++;

    if (isNoBrand || allowNullPrice) {
      if (g.price !== null && g.price !== undefined && Number(g.price) < 0) throw mkErr(422, 'Price must be >= 0.');
    } else {
      if (g.price === null || g.price === undefined) throw mkErr(422, 'Each price group requires a price.');
      if (Number(g.price) < 0) throw mkErr(422, 'Price must be >= 0.');
    }

    const dedupe = new Set(brandIds);
    if (dedupe.size !== brandIds.length) throw mkErr(422, 'A brand cannot repeat within one price group.');
    for (const bid of brandIds) {
      if (seenBrandAcrossGroups.has(bid)) throw mkErr(422, 'A brand cannot repeat across price groups on the same material.');
      seenBrandAcrossGroups.add(bid);
    }

    const states = Array.isArray(g.states) ? g.states : [];
    const seenStateInGroup = new Set();
    for (const s of states) {
      const stateIds = Array.isArray(s.state_ids) ? s.state_ids.map(Number) : [];
      if (stateIds.length === 0) throw mkErr(422, 'A state-price override requires at least one state.');
      if (s.price === null || s.price === undefined) throw mkErr(422, 'A state-price override requires a price.');
      if (Number(s.price) < 0) throw mkErr(422, 'State-price override must be >= 0.');
      for (const sid of stateIds) {
        if (seenStateInGroup.has(sid)) throw mkErr(422, 'A state cannot repeat within one price group.');
        seenStateInGroup.add(sid);
      }
    }
  }

  if (noBrandGroupCount > 0 && list.length > 1) {
    throw mkErr(422, 'A material cannot mix No Brand pricing with brand prices.');
  }
}

// ponytail: no-op hook — the client-propagation prompt (re-quote affected
// client rate cards / quotations when a material's prices change) plugs in
// here later. Kept as an explicit call site so that work is a pure addition.
function onMaterialPricesChanged(materialId, diff) {
  logger.info({ material_id: materialId, diff }, 'onMaterialPricesChanged (no-op)');
}

// Price overrides go on ACTIVE states only — an inactive state is offered
// nowhere, so a price on it would never apply. validateGroupsPayload stays
// pure (no DB), so this runs beside it.
async function assertGroupStatesActive(groups) {
  const ids = [];
  for (const g of (Array.isArray(groups) ? groups : [])) {
    for (const st of (Array.isArray(g.states) ? g.states : [])) ids.push(...(st.state_ids || []));
  }
  await require('./state.service').assertActiveStates(ids);
}

async function writeGroups(conn, materialId, pricingType, groups, { allowNullPrice = false } = {}) {
  await conn.query(
    `DELETE FROM tbl_material_state_price_state WHERE group_id IN (SELECT group_id FROM tbl_material_price_group WHERE material_id = ?)`,
    [materialId]
  );
  await conn.query(
    `DELETE FROM tbl_material_state_price WHERE group_id IN (SELECT group_id FROM tbl_material_price_group WHERE material_id = ?)`,
    [materialId]
  );
  await conn.query(`DELETE FROM tbl_material_price_group_brand WHERE material_id = ?`, [materialId]);
  await conn.query(`DELETE FROM tbl_material_price_group WHERE material_id = ?`, [materialId]);

  if (String(pricingType).toUpperCase() !== 'FIXED') return;

  let sortOrder = 0;
  for (const g of groups) {
    const price = (g.price === null || g.price === undefined) ? null : Number(g.price);
    const [gr] = await conn.query(
      `INSERT INTO tbl_material_price_group (material_id, price, sort_order) VALUES (?, ?, ?)`,
      [materialId, price, sortOrder++]
    );
    const groupId = gr.insertId;
    const brandIds = Array.isArray(g.brand_ids) ? g.brand_ids.map(Number) : [];
    for (const bid of brandIds) {
      await conn.query(
        `INSERT INTO tbl_material_price_group_brand (group_id, material_id, brand_id) VALUES (?, ?, ?)`,
        [groupId, materialId, bid]
      );
    }
    const states = Array.isArray(g.states) ? g.states : [];
    for (const s of states) {
      const [sr] = await conn.query(
        `INSERT INTO tbl_material_state_price (group_id, price) VALUES (?, ?)`,
        [groupId, Number(s.price)]
      );
      const statePriceId = sr.insertId;
      const stateIds = Array.isArray(s.state_ids) ? s.state_ids.map(Number) : [];
      for (const sid of stateIds) {
        await conn.query(
          `INSERT INTO tbl_material_state_price_state (state_price_id, group_id, state_id) VALUES (?, ?, ?)`,
          [statePriceId, groupId, sid]
        );
      }
    }
  }
}

// ─── Create / update ──────────────────────────────────────────────────

async function createMaterial(input, actor = {}) {
  const name = String(input.material_name || '').trim();
  if (!name) throw mkErr(400, 'material_name is required');
  if (!input.service_catg_id) throw mkErr(400, 'service_catg_id is required');
  const pricingType = String(input.pricing_type || '').toUpperCase();
  const key = nameKey(name);

  await validateGroupsPayload(pricingType, input.groups, { allowNullPrice: false });
  await assertGroupStatesActive(input.groups);

  const [[dup]] = await pool.query(
    `SELECT material_id, material_name FROM tbl_material_master WHERE material_key = ? AND service_catg_id = ? LIMIT 1`,
    [key, input.service_catg_id]
  );
  if (dup) {
    const [[catg]] = await pool.query(`SELECT service_catg_name FROM tbl_service_catg WHERE service_catg_id = ?`, [input.service_catg_id]);
    throw mkErr(409, `A material named "${dup.material_name}" already exists in ${catg ? catg.service_catg_name : 'this category'}.`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let materialId;
    try {
      const [r] = await conn.query(
        `INSERT INTO tbl_material_master
           (material_name, material_key, description, service_catg_id, uom_id, pricing_type, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [name, key, input.description || null, input.service_catg_id, input.uom_id || null, pricingType, actor.userId || null, new Date()]
      );
      materialId = r.insertId;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw mkErr(409, `A material named "${name}" already exists in this category.`);
      throw e;
    }
    await writeGroups(conn, materialId, pricingType, input.groups || [], { allowNullPrice: false });
    await conn.commit();
    logger.info({ material_id: materialId, name }, 'Material created');
    onMaterialPricesChanged(materialId, { created: true });
    return getMaterialById(materialId);
  } catch (e) {
    await conn.rollback();
    logger.error('Create material failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

async function updateMaterial(id, input, actor = {}) {
  const me = await getMaterialRow(id);
  if (!me) throw mkErr(404, 'Material not found');

  const name = String(input.material_name || '').trim();
  if (!name) throw mkErr(400, 'material_name is required');
  if (!input.service_catg_id) throw mkErr(400, 'service_catg_id is required');
  const pricingType = String(input.pricing_type || '').toUpperCase();
  const key = nameKey(name);

  await validateGroupsPayload(pricingType, input.groups, { allowNullPrice: false });
  await assertGroupStatesActive(input.groups);

  const [[dup]] = await pool.query(
    `SELECT material_id, material_name FROM tbl_material_master WHERE material_key = ? AND service_catg_id = ? AND material_id <> ? LIMIT 1`,
    [key, input.service_catg_id, id]
  );
  if (dup) {
    const [[catg]] = await pool.query(`SELECT service_catg_name FROM tbl_service_catg WHERE service_catg_id = ?`, [input.service_catg_id]);
    throw mkErr(409, `A material named "${dup.material_name}" already exists in ${catg ? catg.service_catg_name : 'this category'}.`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await conn.query(
        `UPDATE tbl_material_master
            SET material_name = ?, material_key = ?, description = ?, service_catg_id = ?, uom_id = ?,
                pricing_type = ?, updated_by = ?, updated_at = ?
          WHERE material_id = ?`,
        [name, key, input.description || null, input.service_catg_id, input.uom_id || null, pricingType, actor.userId || null, new Date(), id]
      );
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw mkErr(409, `A material named "${name}" already exists in this category.`);
      throw e;
    }
    // Switching FIXED→DYNAMIC (or any edit) replaces the group set atomically —
    // writeGroups deletes the old children before inserting the new ones, so a
    // DYNAMIC pricing_type here correctly leaves the material with zero groups.
    await writeGroups(conn, id, pricingType, input.groups || [], { allowNullPrice: false });
    await conn.commit();
    logger.info({ material_id: id, name }, 'Material updated');
    onMaterialPricesChanged(id, { updated: true });
    return getMaterialById(id);
  } catch (e) {
    await conn.rollback();
    logger.error('Update material failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

async function setMaterialStatus(id, isActive, actor = {}) {
  const me = await getMaterialRow(id);
  if (!me) throw mkErr(404, 'Material not found');
  await pool.query(
    `UPDATE tbl_material_master SET status = ?, updated_by = ?, updated_at = ? WHERE material_id = ?`,
    [isActive ? 1 : 0, actor.userId || null, new Date(), id]
  );
  logger.info({ material_id: id, status: isActive ? 1 : 0 }, 'Material status changed');
  return { material_id: id, status: isActive ? 1 : 0 };
}

async function getMaterialReferences(id) {
  const me = await getMaterialRow(id);
  if (!me) throw mkErr(404, 'Material not found');
  // Materials' own price groups are children, deleted with it — not a
  // "reference" in the registry sense. Nothing registered under 'material'
  // yet (future client rate cards / quotation lines).
  return refs.countReferences('material', id);
}

async function deleteMaterial(id) {
  const me = await getMaterialRow(id);
  if (!me) throw mkErr(404, 'Material not found');
  const { total, by_type } = await refs.countReferences('material', id);
  if (total > 0) throw mkErr(409, `Cannot delete "${me.material_name}" — it is referenced by ${total} record(s).`, { references: { total, by_type } });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM tbl_material_state_price_state WHERE group_id IN (SELECT group_id FROM tbl_material_price_group WHERE material_id = ?)`,
      [id]
    );
    await conn.query(
      `DELETE FROM tbl_material_state_price WHERE group_id IN (SELECT group_id FROM tbl_material_price_group WHERE material_id = ?)`,
      [id]
    );
    await conn.query(`DELETE FROM tbl_material_price_group_brand WHERE material_id = ?`, [id]);
    await conn.query(`DELETE FROM tbl_material_price_group WHERE material_id = ?`, [id]);
    await conn.query(`DELETE FROM tbl_material_master WHERE material_id = ?`, [id]);
    await conn.commit();
    logger.info({ material_id: id }, 'Material deleted');
    return { deleted: true };
  } catch (e) {
    await conn.rollback();
    logger.error('Delete material failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

async function replaceAndDeleteMaterial(id, replacementId) {
  const id2 = Number(replacementId);
  if (!id2 || id2 === Number(id)) throw mkErr(422, 'replacement_id must differ from the material being deleted.');
  const me = await getMaterialRow(id);
  if (!me) throw mkErr(404, 'Material not found');
  const replacement = await getMaterialRow(id2);
  if (!replacement) throw mkErr(422, 'replacement_id does not exist.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const repointed = await refs.repointReferences(conn, 'material', id, id2);
    await conn.query(
      `DELETE FROM tbl_material_state_price_state WHERE group_id IN (SELECT group_id FROM tbl_material_price_group WHERE material_id = ?)`,
      [id]
    );
    await conn.query(
      `DELETE FROM tbl_material_state_price WHERE group_id IN (SELECT group_id FROM tbl_material_price_group WHERE material_id = ?)`,
      [id]
    );
    await conn.query(`DELETE FROM tbl_material_price_group_brand WHERE material_id = ?`, [id]);
    await conn.query(`DELETE FROM tbl_material_price_group WHERE material_id = ?`, [id]);
    await conn.query(`DELETE FROM tbl_material_master WHERE material_id = ?`, [id]);
    await conn.commit();
    logger.info({ material_id: id, replacement_id: id2, repointed }, 'Material replaced and deleted');
    return { deleted: true, repointed };
  } catch (e) {
    await conn.rollback();
    logger.error('Replace-and-delete material failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  mkErr,
  listUoms,
  listMaterials,
  getMaterialRow,
  getMaterialById,
  validateGroupsPayload,
  writeGroups,
  createMaterial,
  updateMaterial,
  setMaterialStatus,
  getMaterialReferences,
  deleteMaterial,
  replaceAndDeleteMaterial,
  onMaterialPricesChanged,
};
