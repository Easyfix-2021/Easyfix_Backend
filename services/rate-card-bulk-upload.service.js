const XLSX = require('xlsx');
const { pool } = require('../db');
const logger = require('../logger');
const { nameKey } = require('../utils/name-key');
const { streamStyledXlsx, buildStyledWorkbook, streamWorkbook } = require('../utils/xlsx-styled-export');
const clientServicesSvc = require('./client-services.service');
const materialRatesSvc = require('./client-material-rates.service');
const stateService = require('./state.service');
// Tx Share (2026-09-24) — the shared "20% of price, rounded to 2dp" default.
const { defaultTxShare } = require('./material-price-resolver');

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

/*
 * Reads `preferredName` when the workbook has a sheet by that name
 * (case/whitespace-insensitive), else falls back to the FIRST sheet.
 *
 * This is what lets the combined GET /:clientId/rate-cards/export.xlsx
 * download (sheets literally named "Services" and "Materials") round-trip
 * through EITHER tab's upload — the Services tab asks for "Services" and
 * gets it even though it's the first sheet of a two-sheet file; the
 * Materials tab asks for "Materials" and gets the SECOND sheet instead of
 * silently reading the Services data as if it were materials. A single-
 * sheet file — either tab's own per-tab download ("Rate Cards" / "Material
 * Rates") or the upload template — has no sheet by that name, so both fall
 * back to "whatever the one sheet is", unchanged from before this existed.
 */
function namedOrFirstSheet(buffer, preferredName) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const wantedKey = preferredName.trim().toLowerCase();
  const matchName = wb.SheetNames.find((n) => n.trim().toLowerCase() === wantedKey);
  const sheet = wb.Sheets[matchName || wb.SheetNames[0]];
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
  const raw = namedOrFirstSheet(buffer, 'Services');
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

/*
 * Plain edit-distance nearest-neighbour for "did you mean" suggestions on an
 * unresolved Material/Brand/State cell.
 *
 * ponytail: this is a linear scan + classic Levenshtein, fine at the scale of
 * a few hundred materials/brands/states (a full preview parse already does a
 * handful of DB round-trips; this adds microseconds). It would need a real
 * fuzzy-search library (e.g. Fuse.js) if any of these lists grows into the
 * thousands and this starts being slow or the threshold starts misfiring.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

function suggestClosest(rawName, byKeyMap, nameField) {
  const target = nameKey(rawName);
  if (!target) return null;
  let best = null;
  let bestDist = Infinity;
  for (const rec of byKeyMap.values()) {
    const d = levenshtein(target, nameKey(rec[nameField]));
    if (d < bestDist) { bestDist = d; best = rec; }
  }
  const threshold = Math.max(2, Math.ceil(target.length / 3));
  return best && bestDist <= threshold ? best[nameField] : null;
}

function unknownNameError(label, rawName, byKeyMap, nameField) {
  const suggestion = suggestClosest(rawName, byKeyMap, nameField);
  return suggestion
    ? `Unknown ${label} "${rawName}" — did you mean "${suggestion}"?`
    : `Unknown ${label} "${rawName}"`;
}

/*
 * Hidden "Lists" sheet + per-column dropdown validation, so a Material/
 * Brand/State cell can only be filled from an actual master-data name —
 * the owner's fix for "a little typo ... can create errors or duplicate
 * entries". A hidden sheet + a named range is the standard Excel pattern
 * for a long dropdown list (an inline list is capped at 255 characters).
 * ExcelJS (already a dependency) supports both natively — no new package.
 *
 * `lastDataRow` is a fixed cap (Excel validation needs a bounded range, not
 * "the rest of the sheet") — 1000 rows is generous for a rate-card upload.
 */
const TEMPLATE_LAST_DATA_ROW = 1000;

function addMaterialListsAndValidation(wb, sheetName, firstDataRow, { materialNames, brandNames, stateNames }) {
  const listsWs = wb.addWorksheet('Lists', { state: 'hidden' });
  listsWs.getColumn(1).values = ['Materials', ...materialNames];
  listsWs.getColumn(2).values = ['Brands', ...brandNames];
  listsWs.getColumn(3).values = ['States', ...stateNames];

  const ws = wb.getWorksheet(sheetName);
  const lastRow = TEMPLATE_LAST_DATA_ROW;
  const rangeFormula = (col, names) => (names.length ? [`Lists!$${col}$2:$${col}$${names.length + 1}`] : null);

  const materialsRange = rangeFormula('A', materialNames);
  const brandsRange = rangeFormula('B', brandNames);
  const statesRange = rangeFormula('C', stateNames);
  // Lists sheet columns are unrelated to the DATA sheet's own layout — these
  // three letters (A/B/C) name where the Lists sheet keeps its lookup
  // columns, not where Material/Brand/State live on the Materials sheet.

  if (materialsRange) {
    ws.dataValidations.add(`A${firstDataRow}:A${lastRow}`, {
      type: 'list', allowBlank: false, formulae: materialsRange,
      showErrorMessage: true, errorTitle: 'Unknown material', error: 'Pick a material from the dropdown list.',
    });
  }
  if (brandsRange) {
    ws.dataValidations.add(`B${firstDataRow}:B${lastRow}`, {
      type: 'list', allowBlank: true, formulae: brandsRange,
      showErrorMessage: true, errorTitle: 'Unknown brand',
      error: 'Pick a brand from the dropdown list, or leave blank for No Brand.',
    });
  }
  if (statesRange) {
    // Column E — State — now that Tx Share (2026-09-24) occupies D between
    // Price and State on the Materials sheet.
    ws.dataValidations.add(`E${firstDataRow}:E${lastRow}`, {
      type: 'list', allowBlank: true, formulae: statesRange,
      showErrorMessage: true, errorTitle: 'Unknown state',
      error: 'Pick a state from the dropdown list, or leave blank for the all-states price.',
    });
  }
}

/*
 * Material | Brand | Price | State (2026-09-21 redesign — see the design
 * doc). ONE ROW per (material, brand, state); State blank = the all-states
 * base price; Brand blank = No Brand. Dropdowns on all three name columns
 * (see addMaterialListsAndValidation) so a typo is rejected by Excel itself
 * before the file ever reaches this parser.
 *
 * Applying the SAME dropdowns to a DOWNLOADED file (the per-tab download or
 * the combined export.xlsx) was considered and deliberately skipped: those
 * files already contain valid current names (no dropdown needed to prevent a
 * typo that isn't there), and building it would mean threading the master
 * material/brand/state lists into services/client-xlsx.service.js, which
 * today does no DB access at all — a bigger change for a secondary case.
 * The parser below is the real safety net either way: every cell is
 * validated against master data on upload regardless of which file it came
 * from, dropdown or not.
 */
async function generateMaterialRatesTemplate(res) {
  const ref = await loadMaterialRatesRef();
  const materialNames = [...new Set([...ref.materialByKey.values()].map((m) => m.material_name))].sort();
  const brandNames = [...new Set([...ref.brandByKey.values()].map((b) => b.brand_name))].sort();
  const stateNames = [...new Set([...ref.stateByKey.values()].map((s) => s.state_name))].sort();

  const wb = buildStyledWorkbook({
    title: 'EasyFix · Rate Card (Materials) Template',
    meta: 'One row = one (Material, Brand, State) price. Leave State blank for the all-states price; leave Brand blank for No Brand; leave Tx Share blank for the 20% default. Use the dropdown in each cell.',
    sheetName: 'Material Rates',
    columns: [
      { header: 'Material', key: 'material', width: 28 },
      { header: 'Brand',    key: 'brand',    width: 20 },
      { header: 'Price',    key: 'price',    width: 14 },
      { header: 'Tx Share', key: 'tx_share', width: 14 },
      { header: 'State',    key: 'state',    width: 20 },
    ],
    rows: [
      { material: materialNames[0] || 'Adapter 5A', brand: brandNames[0] || 'Philips', price: 150, tx_share: '', state: '' },
      { material: materialNames[0] || 'Adapter 5A', brand: brandNames[0] || 'Philips', price: 275, tx_share: '', state: stateNames[0] || 'Maharashtra' },
    ],
  });
  // buildStyledWorkbook with no `kpis` puts the header on row 4 (title/meta/
  // spacer), so data starts row 5 — see xlsx-styled-export.js's own headerRow
  // default.
  addMaterialListsAndValidation(wb, 'Material Rates', 5, { materialNames, brandNames, stateNames });
  await streamWorkbook(res, 'easyfix-rate-card-materials-template.xlsx', wb);
}

async function loadMaterialRatesRef() {
  const [[materials], [brands], states] = await Promise.all([
    pool.query('SELECT material_id, material_name FROM tbl_material_master WHERE status = 1'),
    pool.query('SELECT brand_id, brand_name, brand_key FROM tbl_brand_master WHERE status = 1'),
    // Every accepted spelling → an ACTIVE state (its own name as state_name),
    // so the template lists active states only and an old spelling in a filled
    // sheet ("Orissa") still lands on Odisha, never on an inactive row.
    stateService.stateNameVariants(),
  ]);
  return {
    materialByKey: new Map(materials.map((m) => [nameKey(m.material_name), m])),
    brandByKey: new Map(brands.map((b) => [nameKey(b.brand_name), b])),
    stateByKey: new Map(states.map((s) => [nameKey(s.name), { state_id: s.state_id, state_name: s.state_name }])),
  };
}

// Canonical signature for a price group — order-independent so the
// round-trip test (export → reimport, unchanged) matches regardless of how
// brands/states were listed within a cell. Includes tx_share (2026-09-24) —
// two brands with the same price but a DIFFERENT tx_share must never be
// folded into one group (a group has exactly one tx_share value).
function groupSignature(price, txShare, brandIds, states) {
  const b = [...brandIds].map(Number).sort((a, c) => a - c).join(',');
  const s = states
    .map((st) => `${[...st.state_ids].map(Number).sort((a, c) => a - c).join(',')}:${Number(st.price).toFixed(2)}:${Number(st.tx_share).toFixed(2)}`)
    .sort()
    .join('|');
  return `${Number(price).toFixed(2)}|${Number(txShare).toFixed(2)}|${b}|${s}`;
}

// Every row that individually failed to parse, or that a later cross-row
// check condemns, blocks the WHOLE material — replace() rewrites a
// material's entire group set atomically, so a clean sibling row can't be
// written half of a group set the file also describes incorrectly for the
// same material.
function blockAllRows(rows, message) {
  for (const r of rows) {
    r.errors.push(message);
    r.outcome = 'blocked';
  }
}

/*
 * Parses the flat sheet into { rows, materials, stateNameById }.
 *
 *   rows      — one entry per raw sheet row, in file order (for the
 *               row-level echo / error display).
 *   materials — Map keyed by `id:<material_id>` (resolved) or
 *               `name:<raw text key>` (material name itself didn't
 *               resolve — still bucketed so the compiled-plan preview has
 *               somewhere to show the error), each an accumulator with
 *               { material_id, material_name, rows, groups?, outcome? }.
 *               `groups` (client-price-group shape, ready for
 *               validateClientGroupsPayload/replace()) is present only when
 *               the material compiled cleanly.
 */
async function parseMaterialRateRows(buffer, clientId) {
  const raw = namedOrFirstSheet(buffer, 'Materials');
  const ref = await loadMaterialRatesRef();
  const stateNameById = new Map([...ref.stateByKey.values()].map((s) => [s.state_id, s.state_name]));
  const existingItems = await materialRatesSvc.list(clientId);
  const existingByMaterialId = new Map(existingItems.map((it) => [it.material_id, it]));
  const existingSignaturesByMaterialId = new Map();
  for (const it of existingItems) {
    existingSignaturesByMaterialId.set(
      it.material_id,
      new Set(it.groups.map((g) => groupSignature(g.price, g.tx_share, g.brands.map((b) => b.brand_id), g.states))),
    );
  }

  const rows = [];
  const materials = new Map(); // bucket key -> accumulator (see doc-comment above)

  raw.forEach((r, i) => {
    const rowNumber = i + 2;
    const errors = [];
    const warnings = [];

    const materialRaw = String(cell(r, 'Material') || '').trim();
    const brandRaw = String(cell(r, 'Brand') || '').trim();
    const priceRaw = String(cell(r, 'Price') ?? '').trim();
    const txShareRaw = String(cell(r, 'Tx Share') ?? '').trim();
    const stateRaw = String(cell(r, 'State') || '').trim();

    let material = null;
    if (!materialRaw) errors.push('Material is required');
    else {
      material = ref.materialByKey.get(nameKey(materialRaw)) || null;
      if (!material) errors.push(unknownNameError('material', materialRaw, ref.materialByKey, 'material_name'));
    }

    const isNoBrand = !brandRaw || NO_BRAND_ALIASES.has(nameKey(brandRaw));
    let brand = null;
    if (!isNoBrand) {
      brand = ref.brandByKey.get(nameKey(brandRaw)) || null;
      if (!brand) errors.push(unknownNameError('brand', brandRaw, ref.brandByKey, 'brand_name'));
    }

    let state = null;
    if (stateRaw) {
      state = ref.stateByKey.get(nameKey(stateRaw)) || null;
      if (!state) errors.push(unknownNameError('state', stateRaw, ref.stateByKey, 'state_name'));
    }

    let price = null;
    if (!priceRaw) errors.push('Price is required');
    else if (!/^-?\d+(\.\d+)?$/.test(priceRaw)) errors.push('Price must be a number');
    else {
      price = Number(priceRaw);
      if (!(price > 0)) errors.push('Price must be greater than 0');
    }

    // Tx Share (2026-09-24) — optional; blank defaults to 20% of THIS row's
    // own price (computed below, once price itself is known to be valid).
    let txShare = null;
    if (txShareRaw) {
      if (!/^-?\d+(\.\d+)?$/.test(txShareRaw)) errors.push('Tx Share must be a number');
      else {
        txShare = Number(txShareRaw);
        if (txShare < 0) errors.push('Tx Share must be >= 0');
      }
    }

    const row = {
      row_number: rowNumber, material: materialRaw, brand: brandRaw, price: priceRaw,
      tx_share: txShareRaw, state: stateRaw,
      errors, warnings, outcome: errors.length ? 'blocked' : null,
      _resolved: errors.length === 0,
      _brand_key: isNoBrand ? '' : (brand ? nameKey(brand.brand_name) : null),
      _brand_id: isNoBrand ? null : (brand ? brand.brand_id : null),
      _brand_name: isNoBrand ? '' : (brand ? brand.brand_name : brandRaw),
      _state_id: state ? state.state_id : null,
      _price: price,
      // errors is empty here only when price parsed cleanly, so this default
      // is always computed from a real price.
      _tx_share: errors.length === 0 ? (txShare !== null ? txShare : defaultTxShare(price)) : null,
    };
    rows.push(row);

    const bucketKey = material ? `id:${material.material_id}` : `name:${nameKey(materialRaw)}`;
    if (!materials.has(bucketKey)) {
      materials.set(bucketKey, {
        material_id: material ? material.material_id : null,
        material_name: material ? material.material_name : (materialRaw || '(blank)'),
        rows: [],
      });
    }
    materials.get(bucketKey).rows.push(row);
  });

  for (const acc of materials.values()) {
    const resolvedRows = acc.rows.filter((r) => r._resolved);
    if (resolvedRows.length === 0) continue; // every row already individually blocked

    const hasNoBrand = resolvedRows.some((r) => r._brand_key === '');
    const hasBranded = resolvedRows.some((r) => r._brand_key !== '');
    if (hasNoBrand && hasBranded) {
      blockAllRows(acc.rows, `Cannot mix No Brand and brand prices for "${acc.material_name}"`);
      continue;
    }

    // Duplicate / conflicting (brand, state) keys within this material.
    const byKey = new Map();
    for (const r of resolvedRows) {
      const key = `${r._brand_key}|${r._state_id ?? 'base'}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    let hasConflict = false;
    for (const dupRows of byKey.values()) {
      if (dupRows.length < 2) continue;
      const sigs = new Set(dupRows.map((r) => `${r._price}:${r._tx_share}`));
      if (sigs.size > 1) {
        const rowNums = dupRows.map((r) => r.row_number).join(', ');
        for (const r of dupRows) r.errors.push(`Conflicting duplicate rows (${rowNums}) for the same material/brand/state with different Price or Tx Share`);
        hasConflict = true;
      } else {
        // Identical duplicates — keep the first for grouping, warn on the rest.
        for (const r of dupRows.slice(1)) {
          r.warnings.push(`Duplicate of row ${dupRows[0].row_number} — identical, ignored`);
          r._dropped = true;
        }
      }
    }
    if (hasConflict) {
      blockAllRows(acc.rows, `Blocked — a duplicate row for "${acc.material_name}" has conflicting prices`);
      continue;
    }

    // Base price (State blank) required for every brand that appears.
    const liveRows = resolvedRows.filter((r) => !r._dropped);
    const brandKeys = [...new Set(liveRows.map((r) => r._brand_key))];
    let missingBase = false;
    for (const bk of brandKeys) {
      const brandRows = liveRows.filter((r) => r._brand_key === bk);
      if (!brandRows.some((r) => r._state_id == null)) {
        const label = bk === '' ? 'No Brand' : brandRows[0]._brand_name;
        blockAllRows(acc.rows, `${label} has state prices but no all-states price for "${acc.material_name}"`);
        missingBase = true;
      }
    }
    if (missingBase) continue;

    // Compile client price GROUPS: brands whose base price + tx_share AND
    // whole state-override map (price + tx_share) are identical share ONE
    // group (2026-09-24: tx_share is now part of what "identical" means).
    const perBrand = new Map();
    for (const bk of brandKeys) {
      const brandRows = liveRows.filter((r) => r._brand_key === bk);
      const baseRow = brandRows.find((r) => r._state_id == null);
      const overrides = new Map();
      for (const r of brandRows) if (r._state_id != null) overrides.set(r._state_id, { price: r._price, txShare: r._tx_share });
      perBrand.set(bk, {
        brand_id: baseRow._brand_id, brand_name: baseRow._brand_name,
        basePrice: baseRow._price, baseTxShare: baseRow._tx_share, overrides,
      });
    }

    const bySig = new Map();
    for (const b of perBrand.values()) {
      const ov = [...b.overrides.entries()].sort((a, c) => a[0] - c[0])
        .map(([sid, o]) => `${sid}:${Number(o.price).toFixed(2)}:${Number(o.txShare).toFixed(2)}`).join(',');
      const sig = `${Number(b.basePrice).toFixed(2)}|${Number(b.baseTxShare).toFixed(2)}|${ov}`;
      if (!bySig.has(sig)) bySig.set(sig, { basePrice: b.basePrice, baseTxShare: b.baseTxShare, overrides: b.overrides, brand_ids: [], brand_names: [] });
      const entry = bySig.get(sig);
      if (b.brand_id != null) { entry.brand_ids.push(b.brand_id); entry.brand_names.push(b.brand_name); }
    }

    const groups = [...bySig.values()].map((entry) => {
      // Group states sharing the same override price AND tx_share into one entry.
      const priceToStates = new Map();
      for (const [stateId, o] of entry.overrides) {
        const priceKey = `${Number(o.price).toFixed(2)}:${Number(o.txShare).toFixed(2)}`;
        if (!priceToStates.has(priceKey)) priceToStates.set(priceKey, { price: Number(o.price), tx_share: Number(o.txShare), state_ids: [] });
        priceToStates.get(priceKey).state_ids.push(stateId);
      }
      return {
        price: entry.basePrice, tx_share: entry.baseTxShare, brand_ids: entry.brand_ids, brand_names: entry.brand_names,
        states: [...priceToStates.values()],
      };
    });

    // Belt-and-suspenders: reuse the SAME cross-row validation the direct
    // PUT route enforces — the per-row checks above should already agree,
    // but this guarantees commit-time parity with replace().
    const groupsForValidation = groups.map((g) => ({ price: g.price, tx_share: g.tx_share, brand_ids: g.brand_ids, states: g.states }));
    try {
      materialRatesSvc.validateClientGroupsPayload(groupsForValidation);
    } catch (e) {
      blockAllRows(acc.rows, e.message);
      continue;
    }

    acc.groups = groups;

    const isNewMaterial = acc.material_id == null || !existingByMaterialId.has(acc.material_id);
    const existingSigs = acc.material_id != null ? existingSignaturesByMaterialId.get(acc.material_id) : null;
    const newSigs = new Set(groups.map((g) => groupSignature(g.price, g.tx_share, g.brand_ids, g.states)));
    const unchanged = !isNewMaterial && existingSigs && existingSigs.size === newSigs.size
      && [...newSigs].every((s) => existingSigs.has(s));
    acc.outcome = isNewMaterial ? 'new' : (unchanged ? 'unchanged' : 'update');
    for (const r of resolvedRows) r.outcome = acc.outcome;
  }

  return { rows, materials, stateNameById };
}

function publicMaterialRow(r) {
  return {
    row_number: r.row_number, material: r.material, brand: r.brand, price: r.price,
    tx_share: r.tx_share, state: r.state,
    outcome: r.outcome, errors: r.errors, warnings: r.warnings,
  };
}

// The compiled "what goes where" plan for one material — a group's brands
// and state overrides expanded back into Brand/State/Price lines, the same
// expansion services/client-xlsx.service.js#addMaterialRatesSheet uses when
// writing the sheet, so the preview reads as "this is what the download
// would show" even though it's built from the parser's own group shape (IDs
// only) rather than client-material-rates.service.js#list()'s shape (which
// carries names).
function publicMaterialPlan(acc, stateNameById) {
  const lines = [];
  for (const g of (acc.groups || [])) {
    const brandLabels = g.brand_ids.length === 0 ? ['No Brand'] : g.brand_names;
    for (const brandLabel of brandLabels) {
      lines.push({ brand: brandLabel, state: 'All States', price: g.price, tx_share: g.tx_share });
      for (const s of g.states) {
        for (const stateId of s.state_ids) {
          lines.push({ brand: brandLabel, state: stateNameById.get(stateId) || `#${stateId}`, price: s.price, tx_share: s.tx_share });
        }
      }
    }
  }
  return {
    material: acc.material_name,
    material_id: acc.material_id,
    outcome: acc.outcome || 'blocked',
    lines,
    errors: [...new Set(acc.rows.flatMap((r) => r.errors))],
  };
}

function summarizeMaterialRateRows(rows) {
  const summary = { new: 0, update: 0, unchanged: 0, blocked: 0 };
  for (const r of rows) summary[r.outcome]++;
  return summary;
}

async function previewMaterialRatesUpload(buffer, clientId) {
  const { rows, materials, stateNameById } = await parseMaterialRateRows(buffer, clientId);
  return {
    rows: rows.map(publicMaterialRow),
    materials: [...materials.values()].map((acc) => publicMaterialPlan(acc, stateNameById)),
    summary: summarizeMaterialRateRows(rows),
  };
}

async function commitMaterialRatesUpload(buffer, clientId, actor = {}) {
  const { rows, materials } = await parseMaterialRateRows(buffer, clientId);
  const summary = summarizeMaterialRateRows(rows);
  if (summary.blocked > 0) {
    throw mkErr(422, `Upload contains ${summary.blocked} blocked row(s); nothing was written.`,
      { rows: rows.map(publicMaterialRow), summary });
  }

  const writable = [...materials.values()].filter((acc) => acc.groups && acc.material_id != null);

  // Re-validate brand/state existence right before writing — a race between
  // preview and commit (a brand/state deactivated meanwhile) must be caught
  // here, not silently written. materialRatesSvc.replace() below repeats this
  // per-material too; run it once up front so a mid-transaction 422 refuses
  // the WHOLE file before any material is written, matching "all or none".
  for (const acc of writable) {
    await materialRatesSvc.assertBrandsAndStatesExist(
      acc.groups.map((g) => ({ price: g.price, brand_ids: g.brand_ids, states: g.states })),
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const acc of writable) {
      const groups = acc.groups.map((g) => ({ price: g.price, tx_share: g.tx_share, brand_ids: g.brand_ids, states: g.states }));
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
  logger.info({ client_id: clientId, materials: writable.length }, 'Material rate-card bulk upload committed');
  return { summary };
}

module.exports = {
  mkErr,
  generateServicesTemplate, previewServicesUpload, commitServicesUpload,
  generateMaterialRatesTemplate, previewMaterialRatesUpload, commitMaterialRatesUpload,
};
