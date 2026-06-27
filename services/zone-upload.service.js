const ExcelJS = require('exceljs');
const XLSX    = require('xlsx');
const { pool } = require('../db');
const logger = require('../logger');

/*
 * Bulk upload for spec-aligned Manage Zones.
 *
 * Workbook layout:
 *   Sheet 1: "Zone Pincodes" (editable; default tab) — Cols:
 *              zone_name | city_name | pincode
 *            Each row = "this pincode belongs to this zone in this city."
 *            Zones are created on the fly if (city_name, zone_name) doesn't
 *            exist; pincodes must already be in tbl_pincode for that city.
 *            Coverage is many-to-many (tbl_zone_pincode_mapping): a pincode
 *            may belong to multiple zones, so rows are never skipped for
 *            "already in another zone".
 *   Sheet 2: "Cities (Master)" — locked; (city_id, city_name).
 *   Sheet 3: "Existing Zones"  — locked; (zone_id, zone_name, city_name).
 *   Sheet 4: "Read me"         — locked; format notes.
 */

const TEMPLATE_PASSWORD = 'easyfix-zones';
const MAX_DATA_ROWS = 5000;

async function generateTemplate() {
  logger.info('Generating Manage Zones upload template');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix CRM';
  wb.created = new Date();

  const [[cities], [zones]] = await Promise.all([
    pool.query('SELECT city_id, city_name FROM tbl_city ORDER BY city_name ASC'),
    pool.query(`SELECT z.zone_id, z.zone_name, c.city_name
                  FROM tbl_zone_master z
                  LEFT JOIN tbl_city c ON c.city_id = z.city_id
                 ORDER BY c.city_name, z.zone_name`),
  ]);
  logger.info('Loaded ' + cities.length + ' cities and ' + zones.length + ' zones for template');

  // ── Editable sheet first (default-active tab) ──
  const sheet = wb.addWorksheet('Zone Pincodes');
  sheet.columns = [
    { header: 'zone_name', key: 'zone_name', width: 24 },
    { header: 'city_name', key: 'city_name', width: 24 },
    { header: 'pincode',   key: 'pincode',   width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' },
  };

  // pincode column — text format, 6-digit validation.
  for (let row = 2; row <= MAX_DATA_ROWS + 1; row++) {
    sheet.getCell(`C${row}`).numFmt = '@';
    sheet.getCell(`C${row}`).dataValidation = {
      type: 'textLength',
      operator: 'equal',
      formulae: [6],
      showErrorMessage: true,
      errorTitle: 'Invalid pincode',
      error: 'Pincode must be exactly 6 digits.',
    };
  }

  // ── Cities (Master) ──
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

  // city_name column — list validation against the Cities master.
  const cityListRange = `'Cities (Master)'!$B$2:$B$${cities.length + 1}`;
  for (let row = 2; row <= MAX_DATA_ROWS + 1; row++) {
    sheet.getCell(`B${row}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: [cityListRange],
      showErrorMessage: true,
      errorTitle: 'Invalid city',
      error: 'Pick a city from the Cities (Master) sheet.',
    };
  }

  // ── Existing Zones (reference) ──
  const zonesSheet = wb.addWorksheet('Existing Zones');
  zonesSheet.columns = [
    { header: 'zone_id',   key: 'zone_id',   width: 10 },
    { header: 'zone_name', key: 'zone_name', width: 28 },
    { header: 'city_name', key: 'city_name', width: 24 },
  ];
  zonesSheet.getRow(1).font = { bold: true };
  zones.forEach((z) => zonesSheet.addRow(z));
  zonesSheet.protect(TEMPLATE_PASSWORD, {
    selectLockedCells: true, selectUnlockedCells: true,
  });

  // ── Read me ──
  const notes = wb.addWorksheet('Read me');
  notes.getColumn(1).width = 90;
  [
    'EasyFix — Manage Zones bulk upload',
    '',
    '1. Fill the "Zone Pincodes" sheet. One row per (zone, city, pincode).',
    '2. zone_name is free text. If the (city_name, zone_name) pair does not exist yet,',
    '   the zone is created on commit and the pincode is assigned to it.',
    '3. The pincode must already be present in Manage Pincodes (tbl_pincode) for the',
    '   given city. Add missing pincodes there first.',
    '4. A pincode may belong to MULTIPLE zones. Re-uploading a (zone, pincode) pair',
    '   that already exists is a harmless no-op (reported as "unchanged").',
    '5. Run a Dry-run from the upload modal to see what would happen before committing.',
  ].forEach((line, i) => {
    const c = notes.getCell(`A${i + 1}`);
    c.value = line;
    if (i === 0) c.font = { bold: true, size: 14 };
  });
  notes.protect(TEMPLATE_PASSWORD, { selectLockedCells: true, selectUnlockedCells: true });

  // Make the editable sheet the default tab regardless of platform.
  wb.views = [{
    x: 0, y: 0, width: 12000, height: 8000,
    firstSheet: 0, activeTab: 0, visibility: 'visible',
  }];

  return wb.xlsx.writeBuffer();
}

// ─── Upload parser ───────────────────────────────────────────────────
async function processUpload(buffer, { dryRun = false, userId = null } = {}) {
  logger.info('Processing zone bulk upload · dryRun=' + dryRun);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets['Zone Pincodes'] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    logger.warn('Zone upload aborted · no "Zone Pincodes" sheet found');
    return {
      summary: { totalRows: 0, createdZones: 0, assignedPincodes: 0, failedCount: 0, skipCount: 0, dryRun },
      results: [{ rowNumber: null, status: 'failed', errors: ['No "Zone Pincodes" sheet found'] }],
    };
  }
  const records = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  logger.info('Parsed ' + records.length + ' rows from upload');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[cities], [zones], [pincodes], [mappings]] = await Promise.all([
      conn.query('SELECT city_id, city_name FROM tbl_city'),
      // ALL zones (incl. inactive) so an existing inactive zone with the same
      // (city, name) is RECOGNISED rather than silently duplicated; rows that
      // target an inactive zone are rejected below (reactivate it first).
      conn.query('SELECT zone_id, zone_name, city_id, zone_status FROM tbl_zone_master'),
      conn.query('SELECT pincode_id, pincode, city_id FROM tbl_pincode WHERE pincode_status = 1'),
      conn.query('SELECT zone_id, pincode_id FROM tbl_zone_pincode_mapping'),
    ]);
    const cityByName = new Map(cities.map((c) => [String(c.city_name).trim().toLowerCase(), c.city_id]));
    const zoneByCityName = new Map();
    for (const z of zones) zoneByCityName.set(`${z.city_id}::${String(z.zone_name).trim().toLowerCase()}`, z);
    const pincodeByValue = new Map(pincodes.map((p) => [String(p.pincode), p]));
    // Existing zone<->pincode coverage, for idempotent dry-run prediction.
    const mappedPincodeIdsByZone = new Map();
    for (const m of mappings) {
      if (!mappedPincodeIdsByZone.has(m.zone_id)) mappedPincodeIdsByZone.set(m.zone_id, new Set());
      mappedPincodeIdsByZone.get(m.zone_id).add(m.pincode_id);
    }

    const results = [];
    let createdZones = 0;
    let assignedPincodes = 0;
    let failedCount = 0;
    let skipCount = 0;

    for (let i = 0; i < records.length; i++) {
      const rowNumber = i + 2;
      const r = records[i];
      const zoneName = String(r.zone_name || '').trim();
      const cityName = String(r.city_name || '').trim();
      const pincode  = String(r.pincode  || '').trim();

      if (!zoneName && !cityName && !pincode) continue;

      const errors = [];
      if (!zoneName) errors.push('zone_name is required');
      if (!cityName) errors.push('city_name is required');
      if (!/^\d{6}$/.test(pincode)) errors.push(`Invalid pincode "${pincode}" (must be 6 digits)`);

      const cityId = cityByName.get(cityName.toLowerCase());
      if (!cityId && cityName) errors.push(`Unknown city "${cityName}"`);

      if (errors.length) {
        results.push({ rowNumber, status: 'failed', errors });
        failedCount++;
        continue;
      }

      // Resolve or create zone (within this city).
      const zoneKey = `${cityId}::${zoneName.toLowerCase()}`;
      let zone = zoneByCityName.get(zoneKey);
      // Existing INACTIVE zone: don't duplicate it and don't map pincodes to an
      // inactive zone (preserves the "inactive zone ⟹ 0 pincodes" invariant).
      // The operator must reactivate it from Manage Zones first.
      if (zone && Number(zone.zone_status) !== 1) {
        results.push({ rowNumber, status: 'failed', errors: [`Zone "${zoneName}" exists in ${cityName} but is inactive — reactivate it before uploading pincodes`] });
        failedCount++;
        continue;
      }
      if (!zone) {
        if (dryRun) {
          zone = { zone_id: -(createdZones + 1), zone_name: zoneName, city_id: cityId, zone_status: 1 };
          zoneByCityName.set(zoneKey, zone);
        } else {
          const [zr] = await conn.query(
            `INSERT INTO tbl_zone_master (zone_name, city_id, zone_status, created_date)
             VALUES (?, ?, 1, NOW())`,
            [zoneName, cityId]
          );
          await conn.query(
            'INSERT INTO tbl_zone_city_mapping (zone_id, city_id) VALUES (?, ?)',
            [zr.insertId, cityId]
          );
          zone = { zone_id: zr.insertId, zone_name: zoneName, city_id: cityId, zone_status: 1 };
          zoneByCityName.set(zoneKey, zone);
        }
        createdZones++;
      }

      // Resolve pincode + city integrity check.
      const p = pincodeByValue.get(pincode);
      if (!p) {
        results.push({ rowNumber, status: 'failed', errors: [`Pincode ${pincode} not in Manage Pincodes — add it first`] });
        failedCount++;
        continue;
      }
      if (Number(p.city_id) !== Number(cityId)) {
        results.push({ rowNumber, status: 'failed', errors: [`Pincode ${pincode} is in a different city than "${cityName}"`] });
        failedCount++;
        continue;
      }
      // Multi-zone is allowed (many-to-many via tbl_zone_pincode_mapping).
      // INSERT IGNORE is idempotent: a brand-new (zone_id, pincode_id) pair is
      // an assignment; an existing pair is a no-op (affectedRows === 0).
      if (dryRun) {
        // Predict the outcome without writing.
        if (!mappedPincodeIdsByZone.has(zone.zone_id)) mappedPincodeIdsByZone.set(zone.zone_id, new Set());
        const zoneSet = mappedPincodeIdsByZone.get(zone.zone_id);
        if (zoneSet.has(p.pincode_id)) {
          results.push({ rowNumber, status: 'skipped', reason: `Pincode ${pincode} already in this zone` });
          skipCount++;
        } else {
          zoneSet.add(p.pincode_id);
          results.push({ rowNumber, status: 'assigned', pincode, zone_name: zoneName, city_name: cityName });
          assignedPincodes++;
        }
        continue;
      }

      const [ins] = await conn.query(
        `INSERT IGNORE INTO tbl_zone_pincode_mapping (zone_id, pincode_id, created_on, created_by)
         VALUES (?, ?, NOW(), ?)`,
        [zone.zone_id, p.pincode_id, userId]
      );
      if (ins.affectedRows > 0) {
        results.push({ rowNumber, status: 'assigned', pincode, zone_name: zoneName, city_name: cityName });
        assignedPincodes++;
      } else {
        results.push({ rowNumber, status: 'skipped', reason: `Pincode ${pincode} already in this zone` });
        skipCount++;
      }
    }

    if (dryRun) await conn.rollback(); else await conn.commit();
    logger.info('Zone upload ' + (dryRun ? 'dry-run' : 'committed') + ' · createdZones=' + createdZones + ' assigned=' + assignedPincodes + ' skipped=' + skipCount + ' failed=' + failedCount);

    return {
      summary: {
        totalRows: records.length,
        createdZones,
        assignedPincodes,
        skipCount,
        failedCount,
        dryRun,
      },
      results,
    };
  } catch (e) {
    await conn.rollback();
    logger.error('Zone upload failed · rolled back · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { generateTemplate, processUpload };
