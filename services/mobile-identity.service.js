const { pool } = require('../db');
const logger = require('../logger');
const { upsertEasyfixerDocuments } = require('./easyfixer-document.service');
const {
  aadhaarConflictError,
  isAadhaarUniqueViolation,
} = require('../utils/aadhaar-uniqueness');

function lockUnavailableError() {
  const error = new Error('Identity details are currently being updated; please retry');
  error.status = 409;
  error.details = { code: 'IDENTITY_UPDATE_IN_PROGRESS' };
  return error;
}

async function getIdentityDetails(efrId, { database = pool } = {}) {
  const [rows] = await database.query(
    `SELECT e.efr_name AS name,
            e.adhaar_card_number AS aadhaar_number,
            e.pan_card_number AS pan_number,
            e.date_of_birth AS dob,
            e.is_identity_details_verified_by_crm AS identity_verified,
            documents.aadhaar_doc_id,
            documents.pan_doc_id
       FROM tbl_easyfixer e
       LEFT JOIN (
         SELECT efr_id,
                MAX(CASE WHEN efr_doc_type_id = 13 THEN efr_doc_id END) AS aadhaar_doc_id,
                MAX(CASE WHEN efr_doc_type_id = 3 THEN efr_doc_id END) AS pan_doc_id
           FROM tbl_easyfixer_document
          WHERE efr_id = ?
          GROUP BY efr_id
       ) documents ON documents.efr_id = e.efr_id
      WHERE e.efr_id = ?
      LIMIT 1`,
    [efrId, efrId],
  );
  const row = rows[0];
  if (!row) {
    const error = new Error('Technician not found');
    error.status = 404;
    throw error;
  }
  return {
    aadhaarNumber: row.aadhaar_number || undefined,
    panNumber: row.pan_number || undefined,
    name: row.name || undefined,
    dob: row.dob || undefined,
    aadhaarDocId: row.aadhaar_doc_id == null ? undefined : Number(row.aadhaar_doc_id),
    panDocId: row.pan_doc_id == null ? undefined : Number(row.pan_doc_id),
    isVerified: Number(row.identity_verified) === 1,
  };
}

/*
 * Save Identity fields and document keys in one transaction. The generated
 * active_aadhaar_unique column/index (2026-08-11-03 migration) is the final
 * race authority across technicians. We deliberately avoid a separate
 * duplicate lookup: the UPDATE remains one query lighter and the UNIQUE write
 * is the only race-free truth. Neither the Aadhaar value nor a database
 * duplicate-key message is logged.
 */
async function saveIdentityDetails(
  efrId,
  body,
  { database = pool, finalize = null } = {},
) {
  const conn = await database.getConnection();
  const lockKey = `efr_doc:${efrId}`;
  let lockAcquired = false;
  let transactionStarted = false;
  const aadhaar = body.aadhaarNumber || body.aadhaar || null;
  const panRaw = body.panNumber || body.pan;
  const pan = panRaw ? String(panRaw).toUpperCase() : null;
  const name = String(body.name || '').trim() || null;
  const drivingLicence = body.haveDrivingLicence === undefined
    ? null
    : (body.haveDrivingLicence ? 1 : 0);
  const identityComplete = Boolean(aadhaar);

  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 10) AS acquired', [lockKey]);
    lockAcquired = Number(lock?.acquired) === 1;
    if (!lockAcquired) throw lockUnavailableError();

    await conn.beginTransaction();
    transactionStarted = true;

    await conn.query(
      `UPDATE tbl_easyfixer
          SET efr_name              = COALESCE(?, efr_name),
              adhaar_card_number    = COALESCE(?, adhaar_card_number),
              pan_card_number       = COALESCE(?, pan_card_number),
              efr_first_name        = COALESCE(?, efr_first_name),
              efr_last_name         = COALESCE(?, efr_last_name),
              date_of_birth         = COALESCE(?, date_of_birth),
              have_driving_lisence  = COALESCE(?, have_driving_lisence),
              efr_identity_details_perc = COALESCE(?, efr_identity_details_perc)
        WHERE efr_id = ?`,
      [
        name,
        aadhaar,
        pan,
        body.firstName || null,
        body.lastName || null,
        body.dob || null,
        drivingLicence,
        identityComplete ? 100 : null,
        efrId,
      ],
    );

    const docs = body.docs || {};
    await upsertEasyfixerDocuments(conn, efrId, [
      [13, docs.aadhaarFront],
      [14, docs.aadhaarBack],
      [3, docs.pan],
      [12, docs.drivingLicence],
    ]);

    await conn.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try { await conn.rollback(); } catch (_) { /* retain original error */ }
    }
    if (isAadhaarUniqueViolation(error)) throw aadhaarConflictError();
    throw error;
  } finally {
    if (lockAcquired) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]); } catch (_) { /* connection release frees it */ }
    }
    conn.release();
  }

  let finalization = null;
  if (typeof finalize === 'function') finalization = await finalize(efrId);
  logger.info({ efrId, complete: identityComplete }, 'Identity details saved');
  return { updated: true, finalization };
}

module.exports = {
  getIdentityDetails,
  saveIdentityDetails,
  _internals: { aadhaarConflictError, isAadhaarUniqueViolation, lockUnavailableError },
};
