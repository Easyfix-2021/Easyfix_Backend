const { pool } = require('../db');
const logger = require('../logger');
const materialSvc = require('./material.service');

/*
 * Client Material Rates (Material Management phase 2, sub-project C) — see
 * docs/superpowers/specs/2026-09-18-client-material-rates-design.md.
 *
 * The client card is a curated exception list on top of the material master
 * (material.service.js / tbl_material_price_group*): an operator adds a
 * material to a client before it can carry a client price. Everything not on
 * the card quotes at the master price via material-price-resolver.js.
 *
 * A client override mirrors the master shape (price per brand group, with
 * optional per-state overrides), but unlike the master, price is ALWAYS
 * required and > 0 — a client row exists only to state a price, so it is
 * never "pending".
 */

function mkErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

// ─── Validation (phase-1 rules, adapted: price is always required > 0) ───

function validateClientGroupsPayload(groups) {
  const list = Array.isArray(groups) ? groups : [];
  if (list.length === 0) throw mkErr(422, 'At least one price group is required.');

  const seenBrandAcrossGroups = new Set();
  let noBrandGroupCount = 0;

  for (const g of list) {
    const brandIds = Array.isArray(g.brand_ids) ? g.brand_ids.map(Number) : [];
    if (brandIds.length === 0) noBrandGroupCount++;

    if (g.price === null || g.price === undefined || Number(g.price) <= 0) {
      throw mkErr(422, 'Each price group requires a price greater than 0.');
    }

    const dedupe = new Set(brandIds);
    if (dedupe.size !== brandIds.length) throw mkErr(422, 'A brand cannot repeat within one price group.');
    for (const bid of brandIds) {
      if (seenBrandAcrossGroups.has(bid)) throw mkErr(422, 'A brand cannot repeat across price groups on this material.');
      seenBrandAcrossGroups.add(bid);
    }

    const states = Array.isArray(g.states) ? g.states : [];
    const seenStateInGroup = new Set();
    for (const s of states) {
      const stateIds = Array.isArray(s.state_ids) ? s.state_ids.map(Number) : [];
      if (stateIds.length === 0) throw mkErr(422, 'A state-price override requires at least one state.');
      if (s.price === null || s.price === undefined || Number(s.price) <= 0) {
        throw mkErr(422, 'A state-price override requires a price greater than 0.');
      }
      for (const sid of stateIds) {
        if (seenStateInGroup.has(sid)) throw mkErr(422, 'A state cannot repeat within one price group.');
        seenStateInGroup.add(sid);
      }
    }
  }

  // No Brand mode is legal only as the sole group for the material.
  if (noBrandGroupCount > 0 && list.length > 1) {
    throw mkErr(422, 'No Brand pricing cannot be mixed with brand prices.');
  }
}

async function assertBrandsAndStatesExist(groups) {
  const brandIds = new Set();
  const stateIds = new Set();
  for (const g of groups) {
    for (const b of (g.brand_ids || [])) brandIds.add(Number(b));
    for (const s of (g.states || [])) for (const sid of (s.state_ids || [])) stateIds.add(Number(sid));
  }
  if (brandIds.size) {
    const ids = [...brandIds];
    const [rows] = await pool.query(`SELECT brand_id FROM tbl_brand_master WHERE brand_id IN (?) AND status = 1`, [ids]);
    const found = new Set(rows.map((r) => r.brand_id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw mkErr(422, `Unknown or inactive brand_id(s): ${missing.join(', ')}`);
  }
  if (stateIds.size) {
    const ids = [...stateIds];
    const [rows] = await pool.query(`SELECT state_id FROM tbl_state WHERE state_id IN (?)`, [ids]);
    const found = new Set(rows.map((r) => r.state_id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw mkErr(422, `Unknown state_id(s): ${missing.join(', ')}`);
  }
}

// ─── Master-change review (derived, never stored — see the design doc) ───

/**
 * The master's price for the SAME brand set a client group carries — the
 * comparator for the review flag, and what gets stamped into
 * master_price_seen on save/accept. An empty brandIds means No Brand mode:
 * resolves against the master's sole no-brand group for the material.
 */
async function resolveMasterPriceForBrandSet(materialId, brandIds) {
  if (!brandIds.length) {
    const [rows] = await pool.query(
      `SELECT g.price
         FROM tbl_material_price_group g
        WHERE g.material_id = ?
          AND NOT EXISTS (SELECT 1 FROM tbl_material_price_group_brand gb WHERE gb.group_id = g.group_id)
        LIMIT 1`,
      [materialId],
    );
    return rows[0] ? rows[0].price : null;
  }
  const [rows] = await pool.query(
    `SELECT mg.price
       FROM tbl_material_price_group_brand gb
       JOIN tbl_material_price_group mg ON mg.group_id = gb.group_id
      WHERE gb.material_id = ? AND gb.brand_id IN (?)
      LIMIT 1`,
    [materialId, brandIds],
  );
  return rows[0] ? rows[0].price : null;
}

function reviewFlag(masterPriceSeen, masterPriceToday) {
  if (masterPriceSeen === null || masterPriceSeen === undefined) return { flagged: false };
  const seen = Number(masterPriceSeen);
  const today = (masterPriceToday === null || masterPriceToday === undefined) ? null : Number(masterPriceToday);
  if (today !== null && seen === today) return { flagged: false };
  return { flagged: true, master_price_seen: seen, master_price_today: today };
}

// ─── List / options ───────────────────────────────────────────────────

async function list(clientId) {
  clientId = Number(clientId);
  const [groupRows] = await pool.query(
    `SELECT g.group_id, g.material_id, g.price, g.master_price_seen, CAST(g.status AS SIGNED) AS status
       FROM tbl_client_material_price_group g
      WHERE g.client_id = ? AND g.status = 1
      ORDER BY g.material_id ASC, g.group_id ASC`,
    [clientId],
  );
  if (!groupRows.length) return [];

  const groupIds = groupRows.map((g) => g.group_id);
  const materialIds = [...new Set(groupRows.map((g) => g.material_id))];

  const [materialRows] = await pool.query(
    `SELECT material_id, material_name, pricing_type FROM tbl_material_master WHERE material_id IN (?)`,
    [materialIds],
  );
  const materialById = new Map(materialRows.map((m) => [m.material_id, m]));

  const [brandRows] = await pool.query(
    `SELECT gb.group_id, bm.brand_id, bm.brand_name
       FROM tbl_client_material_price_group_brand gb
       JOIN tbl_brand_master bm ON bm.brand_id = gb.brand_id
      WHERE gb.group_id IN (?)`,
    [groupIds],
  );
  const brandsByGroup = new Map();
  for (const b of brandRows) {
    if (!brandsByGroup.has(b.group_id)) brandsByGroup.set(b.group_id, []);
    brandsByGroup.get(b.group_id).push({ brand_id: b.brand_id, brand_name: b.brand_name });
  }

  const [stateRows] = await pool.query(
    `SELECT state_price_id, group_id, price FROM tbl_client_material_state_price WHERE group_id IN (?)`,
    [groupIds],
  );
  const statePriceIds = stateRows.map((s) => s.state_price_id);
  let stateStateRows = [];
  if (statePriceIds.length) {
    [stateStateRows] = await pool.query(
      `SELECT state_price_id, state_id FROM tbl_client_material_state_price_state WHERE state_price_id IN (?)`,
      [statePriceIds],
    );
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

  const groupsOut = await Promise.all(groupRows.map(async (g) => {
    const brands = brandsByGroup.get(g.group_id) || [];
    const masterToday = await resolveMasterPriceForBrandSet(g.material_id, brands.map((b) => b.brand_id));
    return {
      group_id: g.group_id,
      material_id: g.material_id,
      price: g.price,
      status: g.status,
      brands,
      states: statesByGroup.get(g.group_id) || [],
      master_price_seen: g.master_price_seen,
      master_price_today: masterToday,
      review: reviewFlag(g.master_price_seen, masterToday),
    };
  }));

  const byMaterial = new Map();
  for (const g of groupsOut) {
    if (!byMaterial.has(g.material_id)) {
      const m = materialById.get(g.material_id) || {};
      byMaterial.set(g.material_id, {
        material_id: g.material_id,
        material_name: m.material_name || null,
        pricing_type: m.pricing_type || null,
        groups: [],
      });
    }
    byMaterial.get(g.material_id).groups.push(g);
  }
  return [...byMaterial.values()];
}

async function options(clientId) {
  clientId = Number(clientId);
  const [rows] = await pool.query(
    `SELECT m.material_id, m.material_name, m.pricing_type
       FROM tbl_material_master m
      WHERE m.status = 1
        AND NOT EXISTS (
          SELECT 1 FROM tbl_client_material_price_group g
           WHERE g.client_id = ? AND g.material_id = m.material_id AND g.status = 1
        )
      ORDER BY m.material_name ASC`,
    [clientId],
  );
  return rows;
}

// ─── Replace (add / edit — same call) ────────────────────────────────

/*
 * `conn` (optional, 5th arg): pass an open transaction connection so a
 * caller writing several materials atomically (the rate-card bulk-upload
 * commit — one file, one transaction, all materials or none) shares that
 * ONE transaction instead of each replace() beginning/committing its own.
 * Same idiom as job.service.js#setStatus's `conn: externalConn` param.
 * Omitted (every existing caller), replace() manages its own transaction
 * exactly as before.
 */
async function replace(clientId, materialId, input, actor = {}, { conn: externalConn = null } = {}) {
  clientId = Number(clientId);
  materialId = Number(materialId);
  const groups = Array.isArray(input.groups) ? input.groups : [];

  const material = await materialSvc.getMaterialRow(materialId);
  if (!material || material.status !== 1) throw mkErr(404, 'Material not found');

  validateClientGroupsPayload(groups);
  await assertBrandsAndStatesExist(groups);

  const conn = externalConn || await pool.getConnection();
  const manageTx = !externalConn;
  try {
    if (manageTx) await conn.beginTransaction();
    await conn.query(
      `DELETE FROM tbl_client_material_state_price_state
        WHERE group_id IN (SELECT group_id FROM tbl_client_material_price_group WHERE client_id = ? AND material_id = ?)`,
      [clientId, materialId],
    );
    await conn.query(
      `DELETE FROM tbl_client_material_state_price
        WHERE group_id IN (SELECT group_id FROM tbl_client_material_price_group WHERE client_id = ? AND material_id = ?)`,
      [clientId, materialId],
    );
    await conn.query(`DELETE FROM tbl_client_material_price_group_brand WHERE client_id = ? AND material_id = ?`, [clientId, materialId]);
    await conn.query(`DELETE FROM tbl_client_material_price_group WHERE client_id = ? AND material_id = ?`, [clientId, materialId]);

    for (const g of groups) {
      const price = Number(g.price);
      const brandIds = Array.isArray(g.brand_ids) ? g.brand_ids.map(Number) : [];
      const masterPriceToday = await resolveMasterPriceForBrandSet(materialId, brandIds);
      const [gr] = await conn.query(
        `INSERT INTO tbl_client_material_price_group
           (client_id, material_id, price, master_price_seen, status, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [clientId, materialId, price, masterPriceToday, actor.userId || null, new Date(), actor.userId || null, new Date()],
      );
      const groupId = gr.insertId;
      for (const bid of brandIds) {
        await conn.query(
          `INSERT INTO tbl_client_material_price_group_brand (group_id, client_id, material_id, brand_id) VALUES (?, ?, ?, ?)`,
          [groupId, clientId, materialId, bid],
        );
      }
      const states = Array.isArray(g.states) ? g.states : [];
      for (const s of states) {
        const [sr] = await conn.query(
          `INSERT INTO tbl_client_material_state_price (group_id, client_id, price) VALUES (?, ?, ?)`,
          [groupId, clientId, Number(s.price)],
        );
        const statePriceId = sr.insertId;
        const stateIds = Array.isArray(s.state_ids) ? s.state_ids.map(Number) : [];
        for (const sid of stateIds) {
          await conn.query(
            `INSERT INTO tbl_client_material_state_price_state (state_price_id, group_id, state_id) VALUES (?, ?, ?)`,
            [statePriceId, groupId, sid],
          );
        }
      }
    }
    if (manageTx) await conn.commit();
    logger.info({ client_id: clientId, material_id: materialId }, 'Client material rate saved');
    return { material_id: materialId, saved: true };
  } catch (e) {
    if (manageTx) await conn.rollback();
    logger.error('Save client material rate failed, rolled back · ' + e.message);
    throw e;
  } finally {
    if (manageTx) conn.release();
  }
}

// ─── Remove ───────────────────────────────────────────────────────────

async function remove(clientId, materialId) {
  clientId = Number(clientId);
  materialId = Number(materialId);
  const [[row]] = await pool.query(
    `SELECT group_id FROM tbl_client_material_price_group WHERE client_id = ? AND material_id = ? LIMIT 1`,
    [clientId, materialId],
  );
  if (!row) throw mkErr(404, 'This material is not on the client card.');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM tbl_client_material_state_price_state
        WHERE group_id IN (SELECT group_id FROM tbl_client_material_price_group WHERE client_id = ? AND material_id = ?)`,
      [clientId, materialId],
    );
    await conn.query(
      `DELETE FROM tbl_client_material_state_price
        WHERE group_id IN (SELECT group_id FROM tbl_client_material_price_group WHERE client_id = ? AND material_id = ?)`,
      [clientId, materialId],
    );
    await conn.query(`DELETE FROM tbl_client_material_price_group_brand WHERE client_id = ? AND material_id = ?`, [clientId, materialId]);
    await conn.query(`DELETE FROM tbl_client_material_price_group WHERE client_id = ? AND material_id = ?`, [clientId, materialId]);
    await conn.commit();
    logger.info({ client_id: clientId, material_id: materialId }, 'Client material rate removed');
    return { deleted: true };
  } catch (e) {
    await conn.rollback();
    logger.error('Remove client material rate failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Accept master (stamp master_price_seen; price unchanged) ────────

async function acceptMaster(clientId, materialId, actor = {}) {
  clientId = Number(clientId);
  materialId = Number(materialId);
  const [groupRows] = await pool.query(
    `SELECT g.group_id FROM tbl_client_material_price_group g WHERE g.client_id = ? AND g.material_id = ? AND g.status = 1`,
    [clientId, materialId],
  );
  if (!groupRows.length) throw mkErr(404, 'This material is not on the client card.');

  const [brandRows] = await pool.query(
    `SELECT group_id, brand_id FROM tbl_client_material_price_group_brand WHERE group_id IN (?)`,
    [groupRows.map((g) => g.group_id)],
  );
  const brandsByGroup = new Map();
  for (const b of brandRows) {
    if (!brandsByGroup.has(b.group_id)) brandsByGroup.set(b.group_id, []);
    brandsByGroup.get(b.group_id).push(b.brand_id);
  }

  for (const g of groupRows) {
    const masterToday = await resolveMasterPriceForBrandSet(materialId, brandsByGroup.get(g.group_id) || []);
    await pool.query(
      `UPDATE tbl_client_material_price_group SET master_price_seen = ?, updated_by = ?, updated_at = ? WHERE group_id = ?`,
      [masterToday, actor.userId || null, new Date(), g.group_id],
    );
  }
  logger.info({ client_id: clientId, material_id: materialId }, 'Client material rate — master price accepted');
  return { accepted: true };
}

module.exports = {
  mkErr,
  validateClientGroupsPayload,
  assertBrandsAndStatesExist,
  resolveMasterPriceForBrandSet,
  reviewFlag,
  list,
  options,
  replace,
  remove,
  acceptMaster,
};
