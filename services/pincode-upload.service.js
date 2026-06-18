const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { pool } = require('../db');
const logger = require('../logger');

/*
 * Bulk import for `tbl_pincode` (the EasyFix-owned pincode catalog,
 * NOT pincode_firefox_city_mapping which is firefox-client data).
 *
 * Workbook layout:
 *   Sheet 1: "Pincodes"          — user-editable
 *                                  Cols: pincode | location | city_name | district
 *   Sheet 2: "Cities (Master)"   — locked; canonical (city_id, city_name) list
 *   Sheet 3: "Read me"           — locked; usage notes
 *
 * city_name is matched case-insensitively to tbl_city.city_name; matched
 * city_id is what gets stored. Location and district are free-form text.
 */

const TEMPLATE_PASSWORD = 'easyfix-pincodes';
const MAX_DATA_ROWS = 5000;

// ─── Template generator ──────────────────────────────────────────────
async function generateTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix CRM';
  wb.created = new Date();

  const [cities] = await pool.query(
    'SELECT city_id, city_name FROM tbl_city ORDER BY city_name ASC'
  );

  // ── Pincodes sheet (editable) — added FIRST so Excel opens this tab
  //    by default (most spreadsheet apps honor the first-added sheet as
  //    the active one). The data-validation formulas below reference
  //    'Cities (Master)' by name, so the order of physical creation
  //    doesn't matter — only the tab order does.
  const pinSheet = wb.addWorksheet('Pincodes');
  pinSheet.columns = [
    { header: 'pincode',   key: 'pincode',   width: 14 },
    { header: 'location',  key: 'location',  width: 32 },
    { header: 'city_name', key: 'city_name', width: 28 },
    { header: 'district',  key: 'district',  width: 24 },
  ];
  pinSheet.getRow(1).font = { bold: true };
  pinSheet.getRow(1).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' },
  };

  // pincode column — text format, 6-digit validation.
  for (let row = 2; row <= MAX_DATA_ROWS + 1; row++) {
    pinSheet.getCell(`A${row}`).numFmt = '@';
    pinSheet.getCell(`A${row}`).dataValidation = {
      type: 'textLength',
      operator: 'equal',
      formulae: [6],
      showErrorMessage: true,
      errorTitle: 'Invalid pincode',
      error: 'Pincode must be exactly 6 digits.',
    };
  }

  // city_name column — list validation against the Cities master sheet
  // (created below; ExcelJS resolves the cross-sheet range at write time).
  const cityListRange = `'Cities (Master)'!$B$2:$B$${cities.length + 1}`;
  for (let row = 2; row <= MAX_DATA_ROWS + 1; row++) {
    pinSheet.getCell(`C${row}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [cityListRange],
      showErrorMessage: true,
      errorTitle: 'Invalid city',
      error: 'Pick a city from the Cities (Master) sheet.',
    };
  }

  // ── Cities master (locked, reference-only) ──
  const citiesSheet = wb.addWorksheet('Cities (Master)');
  citiesSheet.columns = [
    { header: 'city_id',   key: 'city_id',   width: 10 },
    { header: 'city_name', key: 'city_name', width: 32 },
  ];
  citiesSheet.getRow(1).font = { bold: true };
  cities.forEach((c) => citiesSheet.addRow(c));
  citiesSheet.protect(TEMPLATE_PASSWORD, {
    selectLockedCells: true, selectUnlockedCells: true,
  });

  // ── Notes sheet ──
  const notes = wb.addWorksheet('Read me');
  notes.getColumn(1).width = 90;
  [
    'EasyFix — Manage Pincodes bulk upload',
    '',
    '1. Fill the "Pincodes" sheet only. Other sheets are reference data.',
    '2. pincode must be 6 digits (Indian PIN format). Leading zeros preserved as text.',
    '3. city_name must match the dropdown in column C exactly.',
    '4. location is free-form (e.g. "Sector 18", "Andheri East"). Optional.',
    '5. district is optional — if blank, the pincode inherits the city\'s district.',
    '6. Duplicates (pincode already in the catalog) are reported as "skipped".',
    '7. Save as .xlsx, then upload via Settings → Manage Pincodes.',
  ].forEach((line, i) => {
    const c = notes.getCell(`A${i + 1}`);
    c.value = line;
    if (i === 0) c.font = { bold: true, size: 14 };
  });
  notes.protect(TEMPLATE_PASSWORD, { selectLockedCells: true, selectUnlockedCells: true });

  // Belt-and-suspenders: explicitly mark Pincodes as the active tab. Some
  // versions of Excel for Mac default to the last-modified sheet rather
  // than the first added one, so we set the workbook view directly.
  wb.views = [
    {
      x: 0, y: 0, width: 12000, height: 8000,
      firstSheet: 0,    // index of leftmost visible tab
      activeTab: 0,     // tab Excel opens to (0 = Pincodes)
      visibility: 'visible',
    },
  ];

  return wb.xlsx.writeBuffer();
}

// ─── Upload parser ───────────────────────────────────────────────────
async function processUpload(buffer, { dryRun = false, userId = null } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets['Pincodes'] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    logger.warn({ sheetNames: wb.SheetNames, dryRun }, 'Pincode bulk upload: no readable sheet');
    return {
      error: 'No "Pincodes" sheet found. Download a fresh template and fill the "Pincodes" sheet.',
      summary: { totalRows: 0, createdCount: 0, failedCount: 1, skipCount: 0, dryRun },
      results: [{ rowNumber: null, status: 'failed', errors: ['No "Pincodes" sheet found'] }],
    };
  }

  const records = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

  // ── Header validation ─────────────────────────────────────────────
  // sheet_to_json keys each row object off the sheet's FIRST-ROW header
  // text. We only ever read r.pincode / r.location / r.city_name /
  // r.district, so if the uploaded sheet's headers don't match the
  // template, every row would silently parse to all-empty and (pre-fix)
  // get dropped by the blank-row guard — yielding a deceptive
  // "N total, 0/0/0". Detect that up front and fail loudly instead.
  //
  // We require the two MANDATORY columns (pincode, city_name) to be
  // present in the header; location/district are optional in the template.
  const headerKeys = XLSX.utils
    .sheet_to_json(sheet, { header: 1, range: 0, blankrows: false })[0] || [];
  const presentHeaders = new Set(
    headerKeys.map((h) => String(h || '').trim().toLowerCase())
  );
  const REQUIRED_HEADERS = ['pincode', 'city_name'];
  const missingHeaders = REQUIRED_HEADERS.filter((h) => !presentHeaders.has(h));

  if (missingHeaders.length) {
    // Structural error — the sheet doesn't match the template at all.
    // Surface a top-level banner message AND mark every data row failed so
    // the per-row table and failedCount agree with the banner.
    logger.warn(
      { missingHeaders, foundHeaders: [...presentHeaders], dryRun },
      'Pincode bulk upload: sheet headers do not match template'
    );
    const reason =
      `Sheet columns don't match the template (missing required column${missingHeaders.length > 1 ? 's' : ''}: ${missingHeaders.join(', ')}). ` +
      'Download a fresh template and fill the "Pincodes" sheet.';
    const failedRows = records.map((_r, i) => ({
      rowNumber: i + 2,
      status: 'failed',
      errors: [`Missing required column: ${missingHeaders.join(', ')}`],
    }));
    return {
      error: reason,
      summary: {
        totalRows: records.length,
        createdCount: 0,
        failedCount: failedRows.length,
        skipCount: 0,
        dryRun,
      },
      results: failedRows,
    };
  }

  // Pull cities + existing pincodes once for fast in-memory validation.
  const [[cities], [existing]] = await Promise.all([
    pool.query('SELECT city_id, city_name FROM tbl_city'),
    pool.query('SELECT pincode FROM tbl_pincode'),
  ]);
  const cityByName = new Map(cities.map((c) => [String(c.city_name).trim().toLowerCase(), c.city_id]));
  const existingPins = new Set(existing.map((p) => String(p.pincode)));

  const results = [];
  let createdCount = 0;
  let skipCount = 0;
  let failedCount = 0;

  // Chunked multi-row INSERTs — one round-trip per 500 rows instead of
  // one per Excel row. Must go through .query (text protocol): the
  // mysql2 bulk `VALUES ?` expansion doesn't work with .execute.
  //
  // Blueprint rule 5 (multi-step writes use beginTransaction/commit/
  // rollback): because batches flush mid-loop (every 500 rows), a
  // failure on batch N must NOT leave batches 1..N-1 already committed.
  // So all INSERTs run on a single checked-out connection inside one
  // transaction. Dry-run does no writes — skip the connection entirely.
  const BATCH_SIZE = 500;
  let pendingRows = [];
  const conn = dryRun ? null : await pool.getConnection();
  async function flushBatch() {
    if (!pendingRows.length) return;
    await conn.query(
      `INSERT INTO tbl_pincode
         (pincode, location, city_id, district, pincode_status, created_by, updated_by)
       VALUES ?`,
      [pendingRows]
    );
    pendingRows = [];
  }

  if (conn) await conn.beginTransaction();
  try {
    for (let i = 0; i < records.length; i++) {
      const rowNumber = i + 2; // +2 to align with Excel row numbers (header at row 1)
      const r = records[i];
      const pincode  = String(r.pincode || '').trim();
      const location = String(r.location || '').trim() || null;
      const cityName = String(r.city_name || '').trim();
      const district = String(r.district || '').trim() || null;

      // Genuinely-empty row (every mapped column blank) — silently ignore.
      // Headers are already verified above, so this only fires for true
      // trailing blanks, NOT for a wholesale header mismatch.
      if (!pincode && !location && !cityName && !district) continue;

      const errors = [];
      if (!pincode) {
        errors.push('Missing required column: pincode');
      } else if (!/^\d{6}$/.test(pincode)) {
        errors.push(`Invalid pincode "${pincode}" (must be 6 digits)`);
      }
      let cityId = null;
      if (!cityName) {
        errors.push('Missing required column: city_name');
      } else {
        cityId = cityByName.get(cityName.toLowerCase());
        if (!cityId) errors.push(`Unknown city "${cityName}" — must match Cities (Master)`);
      }

      if (errors.length) {
        results.push({ rowNumber, status: 'failed', errors });
        failedCount++;
        continue;
      }

      if (existingPins.has(pincode)) {
        results.push({ rowNumber, status: 'skipped', reason: `Pincode ${pincode} already exists` });
        skipCount++;
        continue;
      }

      if (!dryRun) {
        pendingRows.push([pincode, location, cityId, district, 1, userId, userId]); // 1 = Serviceable (pincode_status)
        // Track in-memory so a duplicate WITHIN the same upload doesn't
        // produce two INSERTs that succeed (would violate uniq_pincode).
        existingPins.add(pincode);
        if (pendingRows.length >= BATCH_SIZE) await flushBatch();
      }
      results.push({ rowNumber, status: 'created', pincode });
      createdCount++;
    }

    await flushBatch();
    if (conn) await conn.commit();
  } catch (err) {
    if (conn) await conn.rollback();
    logger.error({ err, dryRun, userId }, 'Pincode bulk upload: insert transaction rolled back');
    throw err;
  } finally {
    if (conn) conn.release();
  }

  return {
    summary: {
      totalRows: records.length,
      createdCount,
      failedCount,
      skipCount,
      dryRun,
    },
    results,
  };
}

module.exports = { generateTemplate, processUpload };
