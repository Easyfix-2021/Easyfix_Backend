const XLSX = require('xlsx');
const { pool } = require('../db');
const logger = require('../logger');
const { nameKey } = require('../utils/name-key');
const { streamStyledXlsx } = require('../utils/xlsx-styled-export');
const brandSvc = require('./brand.service');
const materialSvc = require('./material.service');

/*
 * Bulk import for Brands and Materials (Manage Materials).
 *
 * Stateless by design: preview() and commit() each take the raw file buffer
 * and re-run the SAME validation pass — commit never trusts a client-held
 * preview result. Parsing reuses the `xlsx` package already used by
 * services/zone-upload.service.js (no new dependency); template/errors
 * workbooks are built with the one sanctioned writer, xlsx-styled-export.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

function firstSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

// Header lookup tolerant of the trailing "*" required-marker and case.
function cell(row, ...names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const norm = name.trim().toLowerCase();
    const found = keys.find((k) => k.trim().toLowerCase().replace(/\*$/, '') === norm);
    if (found !== undefined) return row[found];
  }
  return '';
}

// ─── Brand import ───────────────────────────────────────────────────────

async function generateBrandTemplate(res) {
  await streamStyledXlsx(res, 'easyfix-brand-import-template.xlsx', {
    title: 'EasyFix · Brand Import Template',
    meta: 'Fill "Brand Name" below, one brand per row, then upload.',
    sheetName: 'Brands',
    columns: [{ header: 'Brand Name*', key: 'brand_name', width: 32 }],
    rows: [{ brand_name: 'Philips' }],
  });
}

async function parseBrandRows(buffer) {
  const raw = firstSheet(buffer);
  const [existingRows] = await pool.query('SELECT brand_id, brand_name, brand_key FROM tbl_brand_master');
  const existingByKey = new Map(existingRows.map((r) => [r.brand_key, r]));

  const seenInFile = new Map(); // key -> { rowNumber, brand_name }
  const rows = [];
  raw.forEach((r, i) => {
    const rowNumber = i + 2; // header is row 1
    const brand_name = String(cell(r, 'Brand Name') || '').trim();
    const errors = [];
    let outcome = 'NEW';

    if (!brand_name) {
      errors.push('Brand name is required');
      outcome = 'BLOCKED';
    } else {
      const key = nameKey(brand_name);
      const dupInFile = seenInFile.get(key);
      if (dupInFile) {
        errors.push(`Duplicate of row ${dupInFile.rowNumber} ("${dupInFile.brand_name}")`);
        outcome = 'BLOCKED';
      } else {
        seenInFile.set(key, { rowNumber, brand_name });
        if (existingByKey.has(key)) outcome = 'EXISTS';
        else outcome = 'NEW';
      }
    }
    rows.push({ row_number: rowNumber, brand_name, outcome, errors });
  });
  return rows;
}

function summarizeBrandRows(rows) {
  const summary = { new: 0, exists: 0, blocked: 0 };
  for (const r of rows) {
    if (r.outcome === 'NEW') summary.new++;
    else if (r.outcome === 'EXISTS') summary.exists++;
    else summary.blocked++;
  }
  return summary;
}

async function previewBrandImport(buffer) {
  const rows = await parseBrandRows(buffer);
  return { rows, summary: summarizeBrandRows(rows) };
}

async function commitBrandImport(buffer, actor = {}) {
  const rows = await parseBrandRows(buffer);
  const toCreate = rows.filter((r) => r.outcome === 'NEW');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of toCreate) {
      const key = nameKey(r.brand_name);
      await conn.query(
        `INSERT INTO tbl_brand_master (brand_name, brand_key, is_system, status, created_by, created_at)
         VALUES (?, ?, 0, 1, ?, ?)`,
        [r.brand_name, key, actor.userId || null, new Date()]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.error('Brand import commit failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
  logger.info({ created: toCreate.length }, 'Brand import committed');
  return { summary: summarizeBrandRows(rows) };
}

async function generateBrandErrorsXlsx(res, buffer) {
  const rows = (await parseBrandRows(buffer)).filter((r) => r.outcome === 'BLOCKED');
  await streamStyledXlsx(res, 'easyfix-brand-import-errors.xlsx', {
    title: 'EasyFix · Brand Import Errors',
    meta: `${rows.length} row(s) blocked`,
    sheetName: 'Errors',
    columns: [
      { header: 'Row', key: 'row_number', width: 8 },
      { header: 'Brand Name', key: 'brand_name', width: 32 },
      { header: 'Reason', key: 'reason', width: 60 },
    ],
    rows: rows.map((r) => ({ row_number: r.row_number, brand_name: r.brand_name, reason: r.errors.join('; ') })),
    emptyMessage: 'No blocked rows.',
  });
}

// ─── Material import ────────────────────────────────────────────────────

async function generateMaterialTemplate(res) {
  await streamStyledXlsx(res, 'easyfix-material-import-template.xlsx', {
    title: 'EasyFix · Material Import Template',
    meta: 'One row = one brand group. Rows sharing Material Name + Category are the same material.',
    sheetName: 'Materials',
    columns: [
      { header: 'Material Name*', key: 'material_name', width: 28 },
      { header: 'Category*', key: 'category', width: 22 },
      { header: 'Pricing Type*', key: 'pricing_type', width: 14 },
      { header: 'UOM', key: 'uom', width: 14 },
      { header: 'Description', key: 'description', width: 32 },
      { header: 'Brands', key: 'brands', width: 28 },
      { header: 'Price', key: 'price', width: 12 },
    ],
    rows: [{
      material_name: 'Adapter 5A', category: 'Electrical', pricing_type: 'Fixed',
      uom: 'Nos', description: '', brands: 'Philips, Havells', price: 150,
    }],
  });
}

// A "Brands" cell blank or normalising to one of these aliases means the row
// carries no brand at all (Decision A: "No Brand" pricing, replacing the old
// "Not Applicable" system brand).
const NO_BRAND_ALIASES = new Set(['not applicable', 'na', 'n/a', 'no brand']);

async function loadImportReferenceData() {
  const [[categories], [uoms], [brands]] = await Promise.all([
    pool.query('SELECT service_catg_id, service_catg_name FROM tbl_service_catg WHERE service_catg_status = 1'),
    pool.query('SELECT uom_id, uom_name FROM tbl_uom_master WHERE status = 1'),
    pool.query('SELECT brand_id, brand_name, brand_key, is_system FROM tbl_brand_master'),
  ]);
  return {
    categoryByKey: new Map(categories.map((c) => [nameKey(c.service_catg_name), c])),
    uomByKey: new Map(uoms.map((u) => [nameKey(u.uom_name), u])),
    brandByKey: new Map(brands.map((b) => [b.brand_key, b])),
  };
}

/*
 * Parses + validates every row, grouping rows into materials by
 * (nameKey(material_name), category). Returns the flat row list (contract
 * shape) plus the material groups needed by commit() to actually write.
 */
async function parseMaterialRows(buffer, { canCreateBrands = false } = {}) {
  const raw = firstSheet(buffer);
  const ref = await loadImportReferenceData();
  const [existingMaterials] = await pool.query(
    'SELECT material_id, material_key, service_catg_id FROM tbl_material_master'
  );
  const existingByKey = new Map(existingMaterials.map((m) => [`${m.material_key}::${m.service_catg_id}`, m]));

  const brandsToCreate = new Map(); // key -> display name
  const materials = new Map(); // groupKey -> accumulator
  const rows = [];

  raw.forEach((r, i) => {
    const rowNumber = i + 2;
    const errors = [];
    const material_name = String(cell(r, 'Material Name') || '').trim();
    const categoryName = String(cell(r, 'Category') || '').trim();
    const pricingTypeRaw = String(cell(r, 'Pricing Type') || '').trim();
    const uomName = String(cell(r, 'UOM') || '').trim();
    const description = String(cell(r, 'Description') || '').trim();
    const brandsRaw = String(cell(r, 'Brands') || '').trim();
    const priceRaw = String(cell(r, 'Price') ?? '').trim();

    if (!material_name) errors.push('Material Name is required');
    if (!categoryName) errors.push('Category is required');
    if (!pricingTypeRaw) errors.push('Pricing Type is required');

    const pricingType = /^fixed$/i.test(pricingTypeRaw) ? 'FIXED'
      : /^dynamic$/i.test(pricingTypeRaw) ? 'DYNAMIC' : null;
    if (pricingTypeRaw && !pricingType) errors.push('Pricing Type must be Fixed or Dynamic');

    const category = categoryName ? ref.categoryByKey.get(nameKey(categoryName)) : null;
    if (categoryName && !category) errors.push(`Unknown category "${categoryName}"`);

    let uom = null;
    if (uomName) {
      uom = ref.uomByKey.get(nameKey(uomName));
      if (!uom) errors.push(`Unknown UOM "${uomName}"`);
    }

    // Blank, or a recognised "no brand" alias, means this row is a No Brand
    // group — not an unresolved/unknown brand.
    const isNoBrandCell = pricingType === 'FIXED' && (!brandsRaw || NO_BRAND_ALIASES.has(nameKey(brandsRaw)));

    let brandNames = [];
    let price = null;
    let priceOutcome = null; // 'PRICE_PENDING' when FIXED price is blank/non-numeric
    if (pricingType === 'DYNAMIC') {
      if (brandsRaw) errors.push('DYNAMIC materials cannot carry Brands');
      if (priceRaw) errors.push('DYNAMIC materials cannot carry Price');
    } else if (pricingType === 'FIXED') {
      brandNames = isNoBrandCell ? [] : brandsRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (!isNoBrandCell && brandNames.length === 0) errors.push('FIXED rows require at least one brand');
      if (!priceRaw || !/^-?\d+(\.\d+)?$/.test(priceRaw)) {
        priceOutcome = 'PRICE_PENDING';
      } else {
        price = Number(priceRaw);
        if (price < 0) errors.push('Price must be >= 0');
      }
    }

    // Resolve brands (only meaningful once we have a FIXED row with names).
    const resolvedBrandIds = [];
    if (pricingType === 'FIXED' && brandNames.length && errors.length === 0) {
      const dedupe = new Set();
      for (const bn of brandNames) {
        const bkey = nameKey(bn);
        if (dedupe.has(bkey)) { errors.push(`Brand "${bn}" repeated within the same row`); continue; }
        dedupe.add(bkey);
        const existing = ref.brandByKey.get(bkey);
        if (existing) {
          resolvedBrandIds.push(existing.brand_id);
        } else if (canCreateBrands) {
          brandsToCreate.set(bkey, bn);
          resolvedBrandIds.push(`__new__${bkey}`); // resolved to a real id at commit time
        } else {
          errors.push(`Unknown brand "${bn}" (missing isBrandAddNew to create it)`);
        }
      }
    }

    let outcome = errors.length ? 'BLOCKED' : (priceOutcome || 'NEW'); // NEW/UPDATE resolved below once grouped

    const parsed = {
      row_number: rowNumber, material_name, category: categoryName, uom: uomName,
      pricing_type: pricingType || pricingTypeRaw, brands: brandsRaw, price: priceRaw,
      errors, outcome,
      _category_id: category ? category.service_catg_id : null,
      _uom_id: uom ? uom.uom_id : null,
      _pricing_type: pricingType,
      _description: description,
      _brand_ids: resolvedBrandIds,
      _price: price,
      _price_pending: priceOutcome === 'PRICE_PENDING',
    };
    rows.push(parsed);

    if (errors.length || !category || !pricingType) return; // isolated row, no grouping

    const groupKey = `${nameKey(material_name)}::${category.service_catg_id}`;
    if (!materials.has(groupKey)) {
      materials.set(groupKey, {
        groupKey, material_name, description, category_id: category.service_catg_id,
        uom_id: uom ? uom.uom_id : null, pricing_type: pricingType,
        firstRowNumber: rowNumber, groups: [], brandIdsSeen: new Set(), rows: [],
        hasNoBrandRow: false, hasBrandedRow: false,
      });
    }
    const acc = materials.get(groupKey);
    acc.rows.push(parsed);

    // Cross-row conflicts within one material.
    if (acc.pricing_type !== pricingType) {
      parsed.errors.push(`Conflicting Pricing Type with row ${acc.firstRowNumber}`);
      parsed.outcome = 'BLOCKED';
      return;
    }
    if (uom && acc.uom_id && acc.uom_id !== uom.uom_id) {
      parsed.errors.push(`Conflicting UOM with row ${acc.firstRowNumber}`);
      parsed.outcome = 'BLOCKED';
      return;
    }
    if (description && acc.description && description !== acc.description) {
      parsed.errors.push(`Conflicting Description with row ${acc.firstRowNumber}`);
      parsed.outcome = 'BLOCKED';
      return;
    }

    if (pricingType === 'FIXED') {
      if (isNoBrandCell) acc.hasNoBrandRow = true; else acc.hasBrandedRow = true;
      if (acc.hasNoBrandRow && acc.hasBrandedRow) {
        parsed.errors.push(`Cannot mix No Brand and brand prices for "${acc.material_name}"`);
        parsed.outcome = 'BLOCKED';
        return;
      }

      for (const bid of resolvedBrandIds) {
        if (acc.brandIdsSeen.has(bid)) {
          parsed.errors.push(`Brand repeated across rows for this material (first on row ${acc.firstRowNumber})`);
          parsed.outcome = 'BLOCKED';
        } else {
          acc.brandIdsSeen.add(bid);
        }
      }
      if (parsed.outcome === 'BLOCKED') return;
      acc.groups.push({ price: parsed._price_pending ? null : parsed._price, brand_ids: resolvedBrandIds, rowNumber });
    }

    // NEW vs UPDATE, now that the material is resolved.
    if (parsed.outcome !== 'PRICE_PENDING') {
      parsed.outcome = existingByKey.has(groupKey) ? 'UPDATE' : 'NEW';
    }
  });

  return { rows, materials, brandsToCreate };
}

function summarizeMaterialRows(rows, brandsToCreate, canCreateBrands) {
  const summary = { new: 0, update: 0, price_pending: 0, blocked: 0, brands_to_create: [...brandsToCreate.values()], can_create_brands: canCreateBrands };
  for (const r of rows) {
    if (r.outcome === 'NEW') summary.new++;
    else if (r.outcome === 'UPDATE') summary.update++;
    else if (r.outcome === 'PRICE_PENDING') summary.price_pending++;
    else summary.blocked++;
  }
  return summary;
}

function publicRow(r) {
  return { row_number: r.row_number, material_name: r.material_name, category: r.category, uom: r.uom,
    pricing_type: r.pricing_type, brands: r.brands, price: r.price, outcome: r.outcome, errors: r.errors };
}

async function previewMaterialImport(buffer, { canCreateBrands = false } = {}) {
  const { rows, brandsToCreate } = await parseMaterialRows(buffer, { canCreateBrands });
  return { rows: rows.map(publicRow), summary: summarizeMaterialRows(rows, brandsToCreate, canCreateBrands) };
}

async function commitMaterialImport(buffer, actor = {}, { canCreateBrands = false } = {}) {
  const { rows, materials, brandsToCreate } = await parseMaterialRows(buffer, { canCreateBrands });
  const summary = summarizeMaterialRows(rows, brandsToCreate, canCreateBrands);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Create any missing brands, map temp keys -> real ids.
    const createdBrandIdByKey = new Map();
    for (const [bkey, displayName] of brandsToCreate.entries()) {
      const [r] = await conn.query(
        `INSERT INTO tbl_brand_master (brand_name, brand_key, is_system, status, created_by, created_at)
         VALUES (?, ?, 0, 1, ?, ?)`,
        [displayName, bkey, actor.userId || null, new Date()]
      );
      createdBrandIdByKey.set(bkey, r.insertId);
    }
    const resolveBrandId = (id) => (typeof id === 'string' && id.startsWith('__new__'))
      ? createdBrandIdByKey.get(id.slice('__new__'.length))
      : id;

    // 2. Upsert each valid material group with its groups.
    for (const acc of materials.values()) {
      if (acc.rows.some((r) => r.outcome === 'BLOCKED')) continue; // whole material skipped if any row blocked
      const key = nameKey(acc.material_name);
      const [[existing]] = await conn.query(
        `SELECT material_id FROM tbl_material_master WHERE material_key = ? AND service_catg_id = ? LIMIT 1`,
        [key, acc.category_id]
      );
      let materialId;
      if (existing) {
        materialId = existing.material_id;
        await conn.query(
          `UPDATE tbl_material_master
              SET material_name = ?, description = ?, uom_id = ?, pricing_type = ?, updated_by = ?, updated_at = ?
            WHERE material_id = ?`,
          [acc.material_name, acc.description || null, acc.uom_id, acc.pricing_type, actor.userId || null, new Date(), materialId]
        );
      } else {
        const [r] = await conn.query(
          `INSERT INTO tbl_material_master
             (material_name, material_key, description, service_catg_id, uom_id, pricing_type, status, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [acc.material_name, key, acc.description || null, acc.category_id, acc.uom_id, acc.pricing_type, actor.userId || null, new Date()]
        );
        materialId = r.insertId;
      }
      const groups = acc.groups.map((g) => ({ price: g.price, brand_ids: g.brand_ids.map(resolveBrandId), states: [] }));
      await materialSvc.writeGroups(conn, materialId, acc.pricing_type, groups, { allowNullPrice: true });
      materialSvc.onMaterialPricesChanged(materialId, { imported: true });
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.error('Material import commit failed, rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
  logger.info({ materials: materials.size, brandsCreated: brandsToCreate.size }, 'Material import committed');
  return { summary };
}

async function generateMaterialErrorsXlsx(res, buffer, { canCreateBrands = false } = {}) {
  // Must mirror the SAME canCreateBrands the caller's preview/commit used —
  // hardcoding true here would show fewer BLOCKED rows than the caller's own
  // preview did whenever they lack isBrandAddNew (an unknown brand would be
  // silently treated as creatable instead of blocked).
  const { rows } = await parseMaterialRows(buffer, { canCreateBrands });
  const blocked = rows.filter((r) => r.outcome === 'BLOCKED');
  await streamStyledXlsx(res, 'easyfix-material-import-errors.xlsx', {
    title: 'EasyFix · Material Import Errors',
    meta: `${blocked.length} row(s) blocked`,
    sheetName: 'Errors',
    columns: [
      { header: 'Row', key: 'row_number', width: 8 },
      { header: 'Material Name', key: 'material_name', width: 28 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Reason', key: 'reason', width: 60 },
    ],
    rows: blocked.map((r) => ({ row_number: r.row_number, material_name: r.material_name, category: r.category, reason: r.errors.join('; ') })),
    emptyMessage: 'No blocked rows.',
  });
}

module.exports = {
  mkErr,
  generateBrandTemplate, previewBrandImport, commitBrandImport, generateBrandErrorsXlsx,
  generateMaterialTemplate, previewMaterialImport, commitMaterialImport, generateMaterialErrorsXlsx,
};
