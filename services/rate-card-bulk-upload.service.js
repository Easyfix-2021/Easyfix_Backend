const XLSX = require('xlsx');
const { pool } = require('../db');
const logger = require('../logger');
const { nameKey } = require('../utils/name-key');
const { streamStyledXlsx } = require('../utils/xlsx-styled-export');
const clientServicesSvc = require('./client-services.service');
const materialRatesSvc = require('./client-material-rates.service');

/*
 * Rate Card Bulk Upload (Services + Materials tabs) — see
 * docs/superpowers/specs/2026-09-21-rate-card-bulk-upload-design.md.
 *
 * "The upload takes back the file Download produces": both tabs' upload
 * accepts EXACTLY what services/client-xlsx.service.js's exportRateCards /
 * exportMaterialRates write. Stateless, same shape as the phase-1 Manage
 * Materials import (services/material-import.service.js): preview() and
 * commit() both re-parse the raw buffer from scratch — commit never trusts
 * a client-held preview result.
 *
 * Client id is ALWAYS the caller's clientId (from the URL) — never read
 * from the file, unlike the legacy client-services/upload route this
 * deliberately does not reuse (see the design doc's "Why not the existing
 * Services upload").
 *
 * Writers reused (not duplicated):
 *   - Services → services/client-services.service.js#update()/#create(),
 *     the SAME per-row writer the "Add/Edit Client Service" modals use.
 *     (PUT /:clientId/rate-cards's bulkUpsert() is a permanently-disabled
 *     503 stub writing the WRONG table per its own file-header comment —
 *     verified current as of this file — so it is not "Save All"'s real
 *     writer and is not reused here.)
 *   - Materials → services/client-material-rates.service.js#replace(),
 *     the SAME writer PUT /:clientId/material-rates/:materialId uses, plus
 *     its validateClientGroupsPayload()/assertBrandsAndStatesExist().
 * Both writers were given an optional `conn` so this file's per-tab loop
 * can share ONE transaction across every row/material in the upload.
 */

function mkErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

function firstSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

// Header lookup tolerant of case/whitespace (mirrors material-import.service.js).
function cell(row, ...names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const norm = name.trim().toLowerCase();
    const found = keys.find((k) => k.trim().toLowerCase().replace(/\*$/, '') === norm);
    if (found !== undefined) return row[found];
  }
  return '';
}

/* ══════════════════════════ Services tab ══════════════════════════════ */

// [export header, tbl_client_service column, client-services.service.js body key]
const COST_FIELDS = [
  ['Easyfix Direct Fixed',    'easyfix_direct_fixed',    'easyfixDirectFixed'],
  ['Easyfix Direct Variable', 'easyfix_direct_variable', 'easyfixDirectVariable'],
  ['Overhead Fixed',          'overhead_fixed',          'overheadFixed'],
  ['Overhead Variable',       'overhead_variable',       'overheadVariable'],
  ['Client Fixed',            'client_fixed',            'clientFixed'],
  ['Client Variable',         'client_variable',         'clientVariable'],
];

async function generateServicesTemplate(res) {
  await streamStyledXlsx(res, 'easyfix-rate-card-services-template.xlsx', {
    title: 'EasyFix · Rate Card (Services) Template',
    meta: 'Service Type ID identifies the row. Blank cost cells are treated as 0.',
    sheetName: 'Rate Cards',
    columns: [
      { header: 'Service Type ID',           key: 'service_type_id',           width: 16 },
      { header: 'Service Type Name',         key: 'service_type_name',         width: 28 },
      { header: 'Easyfix Direct Fixed',      key: 'easyfix_direct_fixed',      width: 18 },
      { header: 'Easyfix Direct Variable',   key: 'easyfix_direct_variable',   width: 20 },
      { header: 'Overhead Fixed',            key: 'overhead_fixed',            width: 16 },
      { header: 'Overhead Variable',         key: 'overhead_variable',         width: 16 },
      { header: 'Client Fixed',              key: 'client_fixed',              width: 14 },
      { header: 'Client Variable',           key: 'client_variable',           width: 14 },
    ],
    rows: [{
      service_type_id: 1, service_type_name: 'AC Installation',
      easyfix_direct_fixed: 200, easyfix_direct_variable: 10,
      overhead_fixed: 10, overhead_variable: 20,
      client_fixed: 0, client_variable: 0,
    }],
  });
}

async function loadServiceTypeRef() {
  const [rows] = await pool.query(
    `SELECT service_type_id, service_type_name, CAST(service_type_status AS SIGNED) AS service_type_status, service_catg_id
       FROM tbl_service_type WHERE service_type_status <> 3`,
  );
  return new Map(rows.map((r) => [r.service_type_id, r]));
}

// One row per (client_id, service_type_id) is the model this tab renders —
// same singular `service_type_id` column client-rate-cards.service.js's
// listForClient reads (distinct from client-services.service.js's
// multi-select `service_type_ids` CSV model over the same table).
async function loadExistingClientServiceByType(clientId) {
  const [rows] = await pool.query(
    `SELECT client_service_id, service_type_id,
            COALESCE(easyfix_direct_fixed,0)    AS easyfix_direct_fixed,
            COALESCE(easyfix_direct_variable,0) AS easyfix_direct_variable,
            COALESCE(overhead_fixed,0)          AS overhead_fixed,
            COALESCE(overhead_variable,0)       AS overhead_variable,
            COALESCE(client_fixed,0)            AS client_fixed,
            COALESCE(client_variable,0)         AS client_variable
       FROM tbl_client_service
      WHERE client_id = ? AND (service_status IS NULL OR service_status <> 0)`,
    [Number(clientId)],
  );
  const byTypeId = new Map();
  for (const r of rows) if (!byTypeId.has(r.service_type_id)) byTypeId.set(r.service_type_id, r);
  return byTypeId;
}

async function parseServiceRows(buffer, clientId) {
  const raw = firstSheet(buffer);
  const [typeById, existingByTypeId] = await Promise.all([
    loadServiceTypeRef(), loadExistingClientServiceByType(clientId),
  ]);

  const seenTypeIds = new Map(); // service_type_id -> first rowNumber
  const rows = [];

  raw.forEach((r, i) => {
    const rowNumber = i + 2;
    const errors = [];
    const warnings = [];

    const idRaw = String(cell(r, 'Service Type ID') || '').trim();
    const nameRaw = String(cell(r, 'Service Type Name') || '').trim();
    const serviceTypeId = /^\d+$/.test(idRaw) ? Number(idRaw) : null;
    if (!serviceTypeId) errors.push('Service Type ID is required and must be a positive integer');

    let type = null;
    if (serviceTypeId) {
      type = typeById.get(serviceTypeId) || null;
      if (!type) errors.push(`Unknown Service Type ID ${serviceTypeId}`);
    }

    if (serviceTypeId) {
      const dup = seenTypeIds.get(serviceTypeId);
      if (dup) errors.push(`Duplicate of row ${dup} for Service Type ID ${serviceTypeId}`);
      else seenTypeIds.set(serviceTypeId, rowNumber);
    }

    if (type && nameRaw && nameKey(nameRaw) !== nameKey(type.service_type_name || '')) {
      warnings.push(`Service Type Name "${nameRaw}" does not match Service Type ID ${serviceTypeId} ("${type.service_type_name}")`);
    }

    const existing = serviceTypeId ? existingByTypeId.get(serviceTypeId) : null;

    const costs = {};
    for (const [header, dbKey] of COST_FIELDS) {
      const raw2 = cell(r, header);
      const s = raw2 === '' || raw2 == null ? '' : String(raw2).trim();
      if (s === '') { costs[dbKey] = 0; continue; }
      if (!/^-?\d+(\.\d+)?$/.test(s)) { errors.push(`${header} must be a number`); costs[dbKey] = 0; continue; }
      const n = Number(s);
      if (n < 0) errors.push(`${header} must be >= 0`);
      costs[dbKey] = n;
    }

    // "must be a real, active service type" applies to a NEW row only — an
    // already-linked (existing) row can still have its costs edited even if
    // the service type has since gone inactive.
    if (type && !existing && Number(type.service_type_status) !== 1) {
      errors.push(`Service Type "${type.service_type_name}" is inactive`);
    }

    let outcome;
    if (errors.length) {
      outcome = 'blocked';
    } else if (!existing) {
      outcome = 'new';
    } else {
      const unchanged = COST_FIELDS.every(([, dbKey]) => Number(existing[dbKey]) === Number(costs[dbKey]));
      outcome = unchanged ? 'unchanged' : 'update';
    }

    rows.push({
      row_number: rowNumber,
      service_type_id: serviceTypeId,
      service_type_name: nameRaw,
      costs, outcome, errors, warnings,
      _service_catg_id: type ? type.service_catg_id : null,
      _client_service_id: existing ? existing.client_service_id : null,
    });
  });

  return rows;
}

function publicServiceRow(r) {
  return {
    row_number: r.row_number,
    service_type_id: r.service_type_id,
    service_type_name: r.service_type_name,
    easyfix_direct_fixed:    r.costs.easyfix_direct_fixed,
    easyfix_direct_variable: r.costs.easyfix_direct_variable,
    overhead_fixed:          r.costs.overhead_fixed,
    overhead_variable:       r.costs.overhead_variable,
    client_fixed:            r.costs.client_fixed,
    client_variable:         r.costs.client_variable,
    outcome: r.outcome,
    errors: r.errors,
    warnings: r.warnings,
  };
}

function summarizeServiceRows(rows) {
  const summary = { new: 0, update: 0, unchanged: 0, blocked: 0 };
  for (const r of rows) summary[r.outcome]++;
  return summary;
}

async function previewServicesUpload(buffer, clientId) {
  const rows = await parseServiceRows(buffer, clientId);
  return { rows: rows.map(publicServiceRow), summary: summarizeServiceRows(rows) };
}

async function commitServicesUpload(buffer, clientId, actor = {}) {
  const rows = await parseServiceRows(buffer, clientId);
  const summary = summarizeServiceRows(rows);
  if (summary.blocked > 0) {
    throw mkErr(422, `Upload contains ${summary.blocked} blocked row(s); nothing was written.`,
      { rows: rows.map(publicServiceRow), summary });
  }

  const writable = rows.filter((r) => r.outcome === 'new' || r.outcome === 'update');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of writable) {
      const body = {
        easyfixDirectFixed:    r.costs.easyfix_direct_fixed,
        easyfixDirectVariable: r.costs.easyfix_direct_variable,
        overheadFixed:         r.costs.overhead_fixed,
        overheadVariable:      r.costs.overhead_variable,
        clientFixed:           r.costs.client_fixed,
        clientVariable:        r.costs.client_variable,
      };
      if (r.outcome === 'update') {
        await clientServicesSvc.update(r._client_service_id, body, { conn });
      } else {
        await clientServicesSvc.create(clientId, {
          serviceCategoryId: r._service_catg_id,
          serviceTypeIds: [r.service_type_id],
          ...body,
        }, { conn });
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.error('Services rate-card bulk upload commit failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
  logger.info({ client_id: clientId, written: writable.length }, 'Services rate-card bulk upload committed');
  return { summary };
}

/* ══════════════════════════ Materials tab ══════════════════════════════ */

// Aliases that mean "this row carries no brand" — same set material-import
// treats as No Brand (Decision A), matched via the same nameKey normaliser.
const NO_BRAND_ALIASES = new Set(['not applicable', 'na', 'n/a', 'no brand']);

async function generateMaterialRatesTemplate(res) {
  await streamStyledXlsx(res, 'easyfix-rate-card-materials-template.xlsx', {
    title: 'EasyFix · Rate Card (Materials) Template',
    meta: 'One row = one price group. Brands blank or "No Brand" = a brand-less price. Master Price Today / Review Flag are read-only.',
    sheetName: 'Material Rates',
    columns: [
      { header: 'Material',            key: 'material',            width: 28 },
      { header: 'Brands',              key: 'brands',              width: 24 },
      { header: 'Client Price',        key: 'price',               width: 14 },
      { header: 'State Overrides',     key: 'state_overrides',     width: 34 },
      { header: 'Master Price Today',  key: 'master_price_today',  width: 18 },
      { header: 'Review Flag',         key: 'review_flag',         width: 24 },
    ],
    rows: [{
      material: 'Adapter 5A', brands: 'Philips, Havells', price: 150,
      state_overrides: 'Maharashtra, Gujarat: ₹275.00', master_price_today: '', review_flag: '',
    }],
  });
}

async function loadMaterialRatesRef() {
  const [[materials], [brands], [states]] = await Promise.all([
    pool.query('SELECT material_id, material_name FROM tbl_material_master WHERE status = 1'),
    pool.query('SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1'),
    pool.query('SELECT state_id, state_name FROM tbl_state'),
  ]);
  return {
    materialByKey: new Map(materials.map((m) => [nameKey(m.material_name), m])),
    brandByKey: new Map(brands.map((b) => [b.brand_key, b])),
    stateByKey: new Map(states.map((s) => [nameKey(s.state_name), s])),
  };
}

// Canonical signature for a price group — order-independent so the
// round-trip test (export → reimport, unchanged) matches regardless of how
// brands/states were listed within a cell.
function groupSignature(price, brandIds, states) {
  const b = [...brandIds].map(Number).sort((a, c) => a - c).join(',');
  const s = states
    .map((st) => `${[...st.state_ids].map(Number).sort((a, c) => a - c).join(',')}:${Number(st.price).toFixed(2)}`)
    .sort()
    .join('|');
  return `${Number(price).toFixed(2)}|${b}|${s}`;
}

// Parses "Maharashtra, Gujarat: ₹275.00; Delhi: ₹260.00" — the EXACT grammar
// services/client-xlsx.service.js#exportMaterialRates writes: groups joined
// by "; ", each "<comma-separated state names>: ₹<price to 2dp>". The ₹ sign
// is optional on parse (tolerant of a manually-edited cell) but the segment
// is quoted verbatim in any error, per the design doc.
function parseStateOverridesCell(raw, stateByKey) {
  const text = String(raw || '').trim();
  if (!text) return { states: [], errors: [] };
  const errors = [];
  const states = [];
  for (const segment of text.split(';').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.+?):\s*₹?\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(segment);
    if (!m) { errors.push(`Malformed State Overrides segment "${segment}"`); continue; }
    const stateNames = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (!stateNames.length) { errors.push(`Malformed State Overrides segment "${segment}"`); continue; }
    const stateIds = [];
    let bad = false;
    for (const sn of stateNames) {
      const st = stateByKey.get(nameKey(sn));
      if (!st) { errors.push(`Unknown state "${sn}" in State Overrides segment "${segment}"`); bad = true; continue; }
      stateIds.push(st.state_id);
    }
    if (bad) continue;
    const price = Number(m[2]);
    if (!(price > 0)) { errors.push(`State Overrides segment "${segment}" must have a price greater than 0`); continue; }
    states.push({ state_ids: stateIds, price });
  }
  return { states, errors };
}

async function parseMaterialRateRows(buffer, clientId) {
  const raw = firstSheet(buffer);
  const ref = await loadMaterialRatesRef();
  const existingItems = await materialRatesSvc.list(clientId);
  const existingByMaterialId = new Map(existingItems.map((it) => [it.material_id, it]));
  const existingSignaturesByMaterialId = new Map();
  for (const it of existingItems) {
    existingSignaturesByMaterialId.set(
      it.material_id,
      new Set(it.groups.map((g) => groupSignature(g.price, g.brands.map((b) => b.brand_id), g.states))),
    );
  }

  const rows = [];
  const materials = new Map(); // material_id -> accumulator

  raw.forEach((r, i) => {
    const rowNumber = i + 2;
    const errors = [];

    const materialName = String(cell(r, 'Material') || '').trim();
    const brandsRaw = String(cell(r, 'Brands') || '').trim();
    const priceRaw = String(cell(r, 'Client Price') ?? '').trim();
    const stateOverridesRaw = String(cell(r, 'State Overrides') || '').trim();

    if (!materialName) errors.push('Material is required');
    const material = materialName ? ref.materialByKey.get(nameKey(materialName)) || null : null;
    if (materialName && !material) errors.push(`Unknown material "${materialName}"`);

    const isNoBrand = !brandsRaw || NO_BRAND_ALIASES.has(nameKey(brandsRaw));
    const brandIds = [];
    if (!isNoBrand) {
      const dedupe = new Set();
      for (const bn of brandsRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
        const bkey = nameKey(bn);
        if (dedupe.has(bkey)) { errors.push(`Brand "${bn}" repeated within the same row`); continue; }
        dedupe.add(bkey);
        const b = ref.brandByKey.get(bkey);
        if (!b) { errors.push(`Unknown brand "${bn}"`); continue; }
        brandIds.push(b.brand_id);
      }
    }

    let price = null;
    if (!priceRaw) errors.push('Client Price is required');
    else if (!/^-?\d+(\.\d+)?$/.test(priceRaw)) errors.push('Client Price must be a number');
    else {
      price = Number(priceRaw);
      if (!(price > 0)) errors.push('Client Price must be greater than 0');
    }

    const { states, errors: stateErrors } = parseStateOverridesCell(stateOverridesRaw, ref.stateByKey);
    errors.push(...stateErrors);

    const parsed = {
      row_number: rowNumber, material: materialName, brands: brandsRaw, price: priceRaw,
      state_overrides: stateOverridesRaw, errors,
      outcome: errors.length ? 'blocked' : null,
      _material_id: material ? material.material_id : null,
    };
    rows.push(parsed);

    if (errors.length || !material) return; // unresolved — stays 'blocked', not grouped

    if (!materials.has(material.material_id)) {
      materials.set(material.material_id, {
        material_id: material.material_id, material_name: material.material_name,
        groups: [], rows: [], hasNoBrandRow: false, hasBrandedRow: false, brandIdsSeen: new Set(),
      });
    }
    const acc = materials.get(material.material_id);
    acc.rows.push(parsed);

    if (isNoBrand) acc.hasNoBrandRow = true; else acc.hasBrandedRow = true;
    if (acc.hasNoBrandRow && acc.hasBrandedRow) {
      parsed.errors.push(`Cannot mix No Brand and brand prices for "${material.material_name}"`);
      parsed.outcome = 'blocked';
      return;
    }
    for (const bid of brandIds) {
      if (acc.brandIdsSeen.has(bid)) {
        parsed.errors.push(`Brand repeated across rows for "${material.material_name}"`);
        parsed.outcome = 'blocked';
      } else {
        acc.brandIdsSeen.add(bid);
      }
    }
    if (parsed.outcome === 'blocked') return;

    acc.groups.push({ price, brand_ids: brandIds, states, _row: parsed });
  });

  // Resolve outcome per material, now that each material's full group set
  // (every row sharing its name) is assembled. replace() rewrites a
  // material's ENTIRE group set atomically, so one bad row for a material
  // blocks every row of that material — a clean sibling can't be written
  // half of a group set the file also describes incorrectly.
  for (const acc of materials.values()) {
    const blockedRows = acc.rows.filter((row) => row.outcome === 'blocked');
    if (blockedRows.length) {
      for (const row of acc.rows) {
        if (row.outcome !== 'blocked') {
          row.errors.push(`Blocked — another row for "${acc.material_name}" is invalid (row ${blockedRows[0].row_number})`);
          row.outcome = 'blocked';
        }
      }
      continue;
    }

    // Belt-and-suspenders: reuse the SAME cross-row validation the direct
    // PUT route enforces (No Brand mixing / duplicate brand / price>0 /
    // duplicate state) — the per-row checks above should already agree,
    // but this guarantees commit-time parity with replace().
    const groupsForValidation = acc.groups.map((g) => ({ price: g.price, brand_ids: g.brand_ids, states: g.states }));
    try {
      materialRatesSvc.validateClientGroupsPayload(groupsForValidation);
    } catch (e) {
      for (const row of acc.rows) { row.errors.push(e.message); row.outcome = 'blocked'; }
      continue;
    }

    const isNewMaterial = !existingByMaterialId.has(acc.material_id);
    const existingSigs = existingSignaturesByMaterialId.get(acc.material_id);
    for (const g of acc.groups) {
      const sig = groupSignature(g.price, g.brand_ids, g.states);
      g._row.outcome = isNewMaterial ? 'new' : (existingSigs && existingSigs.has(sig) ? 'unchanged' : 'update');
    }
  }

  return { rows, materials };
}

function publicMaterialRow(r) {
  return {
    row_number: r.row_number, material: r.material, brands: r.brands, price: r.price,
    state_overrides: r.state_overrides, outcome: r.outcome, errors: r.errors,
  };
}

function summarizeMaterialRateRows(rows) {
  const summary = { new: 0, update: 0, unchanged: 0, blocked: 0 };
  for (const r of rows) summary[r.outcome]++;
  return summary;
}

async function previewMaterialRatesUpload(buffer, clientId) {
  const { rows } = await parseMaterialRateRows(buffer, clientId);
  return { rows: rows.map(publicMaterialRow), summary: summarizeMaterialRateRows(rows) };
}

async function commitMaterialRatesUpload(buffer, clientId, actor = {}) {
  const { rows, materials } = await parseMaterialRateRows(buffer, clientId);
  const summary = summarizeMaterialRateRows(rows);
  if (summary.blocked > 0) {
    throw mkErr(422, `Upload contains ${summary.blocked} blocked row(s); nothing was written.`,
      { rows: rows.map(publicMaterialRow), summary });
  }

  // Re-validate brand/state existence right before writing — a race between
  // preview and commit (a brand/state deactivated meanwhile) must be caught
  // here, not silently written. materialRatesSvc.replace() below repeats this
  // per-material too; run it once up front so a mid-transaction 422 refuses
  // the WHOLE file before any material is written, matching "all or none".
  for (const acc of materials.values()) {
    await materialRatesSvc.assertBrandsAndStatesExist(
      acc.groups.map((g) => ({ price: g.price, brand_ids: g.brand_ids, states: g.states })),
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const acc of materials.values()) {
      const groups = acc.groups.map((g) => ({ price: g.price, brand_ids: g.brand_ids, states: g.states }));
      await materialRatesSvc.replace(clientId, acc.material_id, { groups }, actor, { conn });
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.error('Material rate-card bulk upload commit failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
  logger.info({ client_id: clientId, materials: materials.size }, 'Material rate-card bulk upload committed');
  return { summary };
}

module.exports = {
  mkErr,
  generateServicesTemplate, previewServicesUpload, commitServicesUpload,
  generateMaterialRatesTemplate, previewMaterialRatesUpload, commitMaterialRatesUpload,
};
