const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// tbl_client_rate_card: crc_id, crc_servicetype_id, crc_ratecard_name, status
// tbl_retail_rate_card: (schema TBD — stub with minimal fields)

router.get('/client', async (req, res, next) => {
  try {
    const { serviceTypeId, q } = req.query;
    logger.info('List client rate cards · serviceTypeId=' + (serviceTypeId ?? '-') + (q ? ' q=' + q : ''));
    const clauses = ['status = 1'], params = [];
    if (serviceTypeId != null) { clauses.push('crc_servicetype_id = ?'); params.push(serviceTypeId); }
    if (q) { clauses.push('crc_ratecard_name LIKE ?'); params.push(`%${q}%`); }
    const [rows] = await pool.query(
      `SELECT crc_id, crc_servicetype_id, crc_ratecard_name, status FROM tbl_client_rate_card WHERE ${clauses.join(' AND ')} ORDER BY crc_ratecard_name LIMIT 500`, params);
    logger.info('Returning ' + rows.length + ' client rate cards');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

router.post('/client', async (req, res, next) => {
  try {
    const b = req.body || {};
    logger.info('Create client rate card · name=' + (b.name ?? '-') + ' serviceTypeId=' + (b.serviceTypeId ?? '-'));
    if (!b.name || !b.serviceTypeId) { logger.warn('Create client rate card rejected · name and serviceTypeId required'); return modernError(res, 400, 'name and serviceTypeId required'); }
    const [ins] = await pool.query(
      `INSERT INTO tbl_client_rate_card (crc_ratecard_name, crc_servicetype_id, status, insert_date, inserted_by) VALUES (?, ?, 1, NOW(), ?)`,
      [b.name, b.serviceTypeId, req.user.user_id]);
    logger.info('Client rate card created · id=' + ins.insertId);
    res.status(201);
    modernOk(res, { crc_id: ins.insertId });
  } catch (e) { next(e); }
});

router.put('/client/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    logger.info('Update client rate card · id=' + req.params.id);
    const sets = [], vals = [];
    if (b.name) { sets.push('crc_ratecard_name = ?'); vals.push(b.name); }
    if (b.serviceTypeId) { sets.push('crc_servicetype_id = ?'); vals.push(b.serviceTypeId); }
    if (b.status !== undefined) { sets.push('status = ?'); vals.push(b.status ? 1 : 0); }
    if (sets.length === 0) { logger.warn('Update client rate card rejected · nothing to update · id=' + req.params.id); return modernError(res, 400, 'nothing to update'); }
    sets.push('update_date = NOW()', 'updated_by = ?');
    vals.push(req.user.user_id, req.params.id);
    await pool.query(`UPDATE tbl_client_rate_card SET ${sets.join(', ')} WHERE crc_id = ?`, vals);
    logger.info('Client rate card updated · id=' + req.params.id);
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.delete('/client/:id', async (req, res, next) => {
  try {
    logger.info('Deactivate client rate card · id=' + req.params.id);
    await pool.query(`UPDATE tbl_client_rate_card SET status = 0, update_date = NOW(), updated_by = ? WHERE crc_id = ?`,
      [req.user.user_id, req.params.id]);
    logger.info('Client rate card deactivated · id=' + req.params.id);
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

// ─── /admin/rate-cards/client-services/upload — bulk Excel import ───
// Mirrors legacy `uploadRcExcelFile` + `addUpdateClientServicesFromExcel`.
//
// VERIFIED tbl_client_service columns (ClientDaoImpl.java:498):
//   client_service_id (PK), client_id, service_type_id, service_catg_id,
//   rate_card_id, charge_type, total_amount,
//   easyfix_direct_fixed, easyfix_direct_variable,
//   overhead_fixed, overhead_variable,
//   client_fixed, client_variable, service_status
//
// Legacy SP signature (16 params, last is OUT):
//   sp_ef_client_add_update_client_service_from_excel(
//     clientServiceId, clientId, serviceTypeId, rateCardId, chargeType,
//     totalCharge, easyfixDirectFixed, easyfixDirectVariable,
//     overheadFixed, overheadVariable, clientFixed, clientVariable,
//     serviceStatus, updatedBy, serviceCatgId, OUT activityId
//   )
//
// Excel column layout (header row + data rows from row 2):
//   0  client_service_id (blank or 0 = new row)
//   1  client_id
//   2  service_type_id
//   3  service_catg_id
//   4  rate_card_id
//   5  charge_type
//   6  total_amount
//   7  easyfix_direct_fixed
//   8  easyfix_direct_variable
//   9  overhead_fixed
//   10 overhead_variable
//   11 client_fixed
//   12 client_variable
//   13 service_status (1 active, 0 inactive)
router.post('/client-services/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) { logger.warn('Client services upload rejected · file required'); return modernError(res, 400, 'file required'); }
    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
    logger.info('Client services Excel upload · dryRun=' + dryRun);

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    logger.info('Parsed ' + Math.max(rows.length - 1, 0) + ' client service rows');

    const results = [];
    let createdCount = 0, updatedCount = 0, failedCount = 0, skipCount = 0;

    // Skip header (row 0)
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rowNumber = i + 1;
      if (!r || r.every((c) => c == null || c === '')) {
        skipCount++; continue;
      }
      const clientServiceId = Number(r[0]) || 0;
      const clientId        = Number(r[1]) || 0;
      const serviceTypeId   = Number(r[2]) || 0;
      const serviceCatgId   = Number(r[3]) || 0;
      const rateCardId      = Number(r[4]) || 0;
      const chargeType      = Number(r[5]) || 0;
      const totalCharge     = Number(r[6]) || 0;
      const efDirFixed      = Number(r[7]) || 0;
      const efDirVar        = Number(r[8]) || 0;
      const ovrhFixed       = Number(r[9]) || 0;
      const ovrhVar         = Number(r[10]) || 0;
      const cliFixed        = Number(r[11]) || 0;
      const cliVar          = Number(r[12]) || 0;
      const serviceStatus   = r[13] != null && r[13] !== '' ? Number(r[13]) : 1;

      if (!clientId || !serviceTypeId || !rateCardId) {
        results.push({ rowNumber, status: 'failed', errors: ['client_id, service_type_id, rate_card_id required'] });
        failedCount++; continue;
      }

      if (dryRun) {
        results.push({ rowNumber, status: clientServiceId ? 'would-update' : 'would-create' });
        continue;
      }

      try {
        // Use the legacy SP. It encapsulates the upsert + audit logic
        // (insert if clientServiceId=0, update otherwise) so we don't
        // reimplement the state machine. SET @act = 0 first because
        // mysql2 won't let us register OUT params with positional ?s.
        await pool.query('SET @act = 0');
        await pool.query(
          `CALL sp_ef_client_add_update_client_service_from_excel(
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, @act
           )`,
          [
            clientServiceId, clientId, serviceTypeId, rateCardId, chargeType,
            totalCharge, efDirFixed, efDirVar, ovrhFixed, ovrhVar,
            cliFixed, cliVar, serviceStatus, req.user.user_id, serviceCatgId,
          ]
        );
        const [[{ act }]] = await pool.query('SELECT @act AS act');
        if (clientServiceId) {
          updatedCount++; results.push({ rowNumber, status: 'updated', activityId: act });
        } else {
          createdCount++; results.push({ rowNumber, status: 'created', activityId: act });
        }
      } catch (err) {
        failedCount++;
        logger.warn('Client service row failed · row=' + rowNumber + ' · ' + err.message);
        results.push({ rowNumber, status: 'failed', errors: [err.message] });
      }
    }

    logger.info('Client services upload done · created=' + createdCount + ' updated=' + updatedCount + ' failed=' + failedCount + ' skipped=' + skipCount + ' dryRun=' + dryRun);
    modernOk(res, {
      summary: {
        totalRows: rows.length - 1,
        createdCount, updatedCount, failedCount, skipCount, dryRun,
      },
      results,
    });
  } catch (e) { next(e); }
});

// Retail rate card (read-only stub)
router.get('/retail', async (req, res, next) => {
  try {
    logger.info('List retail rate cards');
    const [rows] = await pool.query("SELECT * FROM tbl_retail_rate_card LIMIT 500").catch(() => [[]]);
    logger.info('Returning ' + rows.length + ' retail rate cards');
    modernOk(res, rows);
  } catch (e) { next(e); }
});

module.exports = router;
