const { pool } = require('../db');
const logger = require('../logger');
const { upsertEasyfixerDocuments } = require('./easyfixer-document.service');
const {
  aadhaarConflictError,
  isAadhaarUniqueViolation,
  activeAadhaarLockName,
  assertActiveAadhaarAvailable,
  normalizeAadhaar,
  scrubDuplicateEntry,
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
 * Save Identity fields and document keys in one transaction.
 *
 * DUPLICATE GUARD (restored 2026-08-12). This function previously performed no
 * duplicate lookup at all, delegating uniqueness entirely to the UNIQUE index on
 * active_aadhaar_unique. That index does not exist in production — migration
 * 2026-08-11-03's ADD COLUMN applied but its ADD UNIQUE INDEX aborted on
 * pre-existing duplicates — so the ER_DUP_ENTRY classifier below could never
 * fire and this, the highest-volume Aadhaar writer, was completely unguarded.
 *
 * Note the two locks are NOT interchangeable. `efr_doc:<efrId>` is keyed on the
 * ROW: it serialises one technician against himself and provably cannot stop two
 * DIFFERENT technicians submitting the same Aadhaar concurrently. The value lock
 * added here is keyed on a salted hash of the number itself, and is taken FIRST
 * (coarse before fine) so the two named locks have a total order. Both are
 * acquired before any InnoDB lock, so neither can join a row-lock wait cycle.
 *
 * Neither the Aadhaar value nor a database duplicate-key message is logged.
 */
async function saveIdentityDetails(
  efrId,
  body,
  { database = pool, finalize = null } = {},
) {
  const conn = await database.getConnection();
  const lockKey = `efr_doc:${efrId}`;
  let lockAcquired = false;
  let valueLockKey = null;
  let valueLockAcquired = false;
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
    // 1. VALUE lock (coarse) — the only thing that serialises two DIFFERENT
    //    technicians claiming the same number. Skipped entirely for a doc-only
    //    or PAN-only save, which would otherwise all hash the empty string to
    //    one lock name and serialise the endpoint globally.
    if (normalizeAadhaar(aadhaar)) {
      valueLockKey = activeAadhaarLockName(aadhaar);
      const [[valueLock]] = await conn.query('SELECT GET_LOCK(?, 5) AS acquired', [valueLockKey]);
      valueLockAcquired = Number(valueLock?.acquired) === 1;
      // Same error as the row lock below: a distinct "that Aadhaar is busy"
      // response would be a timing oracle for who is submitting what.
      if (!valueLockAcquired) throw lockUnavailableError();
    }

    // 2. ENTITY lock (fine) — unchanged.
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 10) AS acquired', [lockKey]);
    lockAcquired = Number(lock?.acquired) === 1;
    if (!lockAcquired) throw lockUnavailableError();

    // 3. Transaction, then 4. the check as its FIRST read — the REPEATABLE READ
    //    snapshot opens here, so it observes every commit from a writer that has
    //    already released the value lock.
    await conn.beginTransaction();
    transactionStarted = true;

    await assertActiveAadhaarAvailable(conn, aadhaar, efrId);

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
    // Fail closed: if the index ever lands under a different name the raw
    // mysql2 message embeds the rejected Aadhaar, and the logger renders every
    // key with no redaction. Scrub before it can escape this frame.
    throw scrubDuplicateEntry(error, { aadhaarBound: Boolean(normalizeAadhaar(aadhaar)) });
  } finally {
    // Release fine-to-coarse, the reverse of acquisition.
    if (lockAcquired) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]); } catch (_) { /* connection release frees it */ }
    }
    if (valueLockAcquired) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [valueLockKey]); } catch (_) { /* connection release frees it */ }
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
