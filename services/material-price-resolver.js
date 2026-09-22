const { pool } = require('../db');

/*
 * Price resolver — the single place that answers "what does this material
 * cost?". CRM quoting, sub-project B (the technician app's Estimate picker)
 * and any later rate-change prompt call this rather than writing their own
 * SQL. See docs/superpowers/specs/2026-09-18-client-material-rates-design.md
 * ("Price resolution") for the contract this implements.
 *
 * Order, first hit wins:
 *   1. client_state — the client's state price for the group holding brandId.
 *   2. client_group — the client's group price for brandId.
 *   3. master_state — the master state price for the group holding brandId.
 *   4. master_group — the master group price for brandId.
 *   5. none         — no price anywhere (phase-1 "Price Pending").
 *
 * Rules:
 *   - A missing brandId (No Brand case) resolves against the sole group —
 *     legal only as the sole group for a material (phase-1 + this rule).
 *   - A missing stateId skips steps 1 and 3.
 *   - A client group with no state entry for stateId falls to step 2 (client_
 *     group), NEVER to master_state: once a client has a price for a brand,
 *     the master's state variation no longer applies to them.
 */

async function findClientGroup(clientId, materialId, brandId) {
  if (brandId) {
    const [rows] = await pool.query(
      `SELECT g.group_id, g.price
         FROM tbl_client_material_price_group_brand gb
         JOIN tbl_client_material_price_group g ON g.group_id = gb.group_id
        WHERE gb.client_id = ? AND gb.material_id = ? AND gb.brand_id = ? AND g.status = 1
        LIMIT 1`,
      [clientId, materialId, brandId],
    );
    return rows[0] || null;
  }
  // No Brand mode — the sole client group carrying zero brand rows.
  const [rows] = await pool.query(
    `SELECT g.group_id, g.price
       FROM tbl_client_material_price_group g
      WHERE g.client_id = ? AND g.material_id = ? AND g.status = 1
        AND NOT EXISTS (SELECT 1 FROM tbl_client_material_price_group_brand gb WHERE gb.group_id = g.group_id)
      LIMIT 1`,
    [clientId, materialId],
  );
  return rows[0] || null;
}

async function findClientStatePrice(groupId, stateId) {
  const [rows] = await pool.query(
    `SELECT sp.price
       FROM tbl_client_material_state_price sp
       JOIN tbl_client_material_state_price_state sps ON sps.state_price_id = sp.state_price_id
      WHERE sp.group_id = ? AND sps.state_id = ?
      LIMIT 1`,
    [groupId, stateId],
  );
  return rows[0] ? rows[0].price : null;
}

async function findMasterGroup(materialId, brandId) {
  if (brandId) {
    const [rows] = await pool.query(
      `SELECT g.group_id, g.price
         FROM tbl_material_price_group_brand gb
         JOIN tbl_material_price_group g ON g.group_id = gb.group_id
        WHERE gb.material_id = ? AND gb.brand_id = ?
        LIMIT 1`,
      [materialId, brandId],
    );
    return rows[0] || null;
  }
  // No Brand mode — the sole master group carrying zero brand rows.
  const [rows] = await pool.query(
    `SELECT g.group_id, g.price
       FROM tbl_material_price_group g
      WHERE g.material_id = ?
        AND NOT EXISTS (SELECT 1 FROM tbl_material_price_group_brand gb WHERE gb.group_id = g.group_id)
      LIMIT 1`,
    [materialId],
  );
  return rows[0] || null;
}

async function findMasterStatePrice(groupId, stateId) {
  const [rows] = await pool.query(
    `SELECT sp.price
       FROM tbl_material_state_price sp
       JOIN tbl_material_state_price_state sps ON sps.state_price_id = sp.state_price_id
      WHERE sp.group_id = ? AND sps.state_id = ?
      LIMIT 1`,
    [groupId, stateId],
  );
  return rows[0] ? rows[0].price : null;
}

async function resolveMaterialPrice({ clientId, materialId, brandId, stateId }) {
  clientId = Number(clientId);
  materialId = Number(materialId);
  brandId = brandId ? Number(brandId) : null;
  stateId = stateId ? Number(stateId) : null;

  const clientGroup = await findClientGroup(clientId, materialId, brandId);
  if (clientGroup) {
    if (stateId) {
      const statePrice = await findClientStatePrice(clientGroup.group_id, stateId);
      if (statePrice !== null) return { price: statePrice, source: 'client_state', groupId: clientGroup.group_id };
    }
    // No client state match — client_group wins outright, never master_state.
    return { price: clientGroup.price, source: 'client_group', groupId: clientGroup.group_id };
  }

  const masterGroup = await findMasterGroup(materialId, brandId);
  if (masterGroup) {
    if (stateId) {
      const statePrice = await findMasterStatePrice(masterGroup.group_id, stateId);
      if (statePrice !== null) return { price: statePrice, source: 'master_state', groupId: masterGroup.group_id };
    }
    if (masterGroup.price !== null && masterGroup.price !== undefined) {
      return { price: masterGroup.price, source: 'master_group', groupId: masterGroup.group_id };
    }
  }

  return { price: null, source: 'none', groupId: null };
}

module.exports = { resolveMaterialPrice };
