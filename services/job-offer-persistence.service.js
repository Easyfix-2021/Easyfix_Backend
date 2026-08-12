const { OFFER_STATUS } = require('./offer-status');

const MAX_OFFER_RECIPIENTS = 50;

function inputError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function normalizeInput(jobId, efrIds) {
  const normalizedJobId = Number(jobId);
  if (!Number.isInteger(normalizedJobId) || normalizedJobId <= 0) {
    throw inputError('jobId must be a positive integer', 'INVALID_JOB_ID');
  }
  if (!Array.isArray(efrIds) || efrIds.length === 0) {
    throw inputError('at least one easyfixer is required to persist job offers', 'INVALID_OFFER_RECIPIENTS');
  }
  if (efrIds.length > MAX_OFFER_RECIPIENTS) {
    throw inputError(
      `a maximum of ${MAX_OFFER_RECIPIENTS} easyfixers can receive one offer batch`,
      'TOO_MANY_OFFER_RECIPIENTS',
    );
  }

  const normalizedEfrIds = efrIds.map(Number);
  if (normalizedEfrIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw inputError('easyfixer IDs must be positive integers', 'INVALID_OFFER_RECIPIENTS');
  }
  if (new Set(normalizedEfrIds).size !== normalizedEfrIds.length) {
    throw inputError('easyfixer IDs must be deduplicated', 'DUPLICATE_OFFER_RECIPIENT');
  }

  return { jobId: normalizedJobId, efrIds: normalizedEfrIds };
}

function sourceFor(efrId, source, sourceByEfr) {
  return sourceByEfr?.[efrId] || source || null;
}

/**
 * Persist a bounded offer batch on an existing transaction connection.
 *
 * The caller must already hold the selected technician rows in ascending ID
 * order. This function then locks only the latest existing offer row for every
 * (job, technician) pair and performs set-based writes: one bulk re-open, one
 * duplicate clean-up, and one multi-row insert as applicable. Query count is
 * therefore capped at four for every supported batch size (1..50).
 *
 * @param {object} conn mysql2 transaction connection
 * @param {object} input offer batch
 * @param {number|string} input.jobId job identifier
 * @param {number[]} input.efrIds unique technician identifiers (maximum 50)
 * @param {string|null} [input.source] batch-wide source fallback
 * @param {Record<string, string>|null} [input.sourceByEfr] per-technician source
 * @param {number|null} [input.offeredBy] offering CRM user, or null for system
 * @returns {Promise<number[]>} every technician ID persisted by the batch
 */
async function persistJobOfferBatch(conn, {
  jobId,
  efrIds,
  source = null,
  sourceByEfr = null,
  offeredBy = null,
}) {
  if (!conn || typeof conn.query !== 'function') {
    throw new TypeError('an active transaction connection is required');
  }

  const normalized = normalizeInput(jobId, efrIds);
  const ids = normalized.efrIds;
  const idPlaceholders = ids.map(() => '?').join(', ');

  const [latestRows] = await conn.query(
    `SELECT jo.fk_easyfixter_id, jo.job_offer_id AS latest_job_offer_id
       FROM tbl_job_offer jo
       JOIN (
         SELECT fk_easyfixter_id, MAX(job_offer_id) AS latest_job_offer_id
           FROM tbl_job_offer
          WHERE job_id = ?
            AND fk_easyfixter_id IN (${idPlaceholders})
          GROUP BY fk_easyfixter_id
       ) latest ON latest.latest_job_offer_id = jo.job_offer_id
      ORDER BY jo.fk_easyfixter_id
      FOR UPDATE`,
    [normalized.jobId, ...ids],
  );

  const latestByEfr = new Map();
  const selected = new Set(ids);
  for (const row of latestRows) {
    const efrId = Number(row.fk_easyfixter_id);
    const offerId = Number(row.latest_job_offer_id);
    if (selected.has(efrId) && Number.isInteger(offerId) && offerId > 0) {
      latestByEfr.set(efrId, offerId);
    }
  }

  const existingIds = ids.filter((id) => latestByEfr.has(id));
  const newIds = ids.filter((id) => !latestByEfr.has(id));

  if (existingIds.length > 0) {
    const latestOfferIds = existingIds.map((id) => latestByEfr.get(id));
    const sourceCases = existingIds.map(() => 'WHEN ? THEN ?').join(' ');
    const offerIdPlaceholders = latestOfferIds.map(() => '?').join(', ');
    const reopenParams = [OFFER_STATUS.OFFERED];
    for (let index = 0; index < existingIds.length; index += 1) {
      reopenParams.push(
        latestOfferIds[index],
        sourceFor(existingIds[index], source, sourceByEfr),
      );
    }
    reopenParams.push(offeredBy ?? null, ...latestOfferIds);

    await conn.query(
      `UPDATE tbl_job_offer
          SET offer_status = ?,
              offered_at = NOW(),
              updated_on = NOW(),
              offer_count = offer_count + 1,
              offer_source = COALESCE(
                CASE job_offer_id ${sourceCases} ELSE NULL END,
                offer_source
              ),
              offered_by_user_id = COALESCE(?, offered_by_user_id),
              responded_at = NULL,
              reject_reason = NULL,
              reject_reason_id = NULL
        WHERE job_offer_id IN (${offerIdPlaceholders})`,
      reopenParams,
    );

    const existingIdPlaceholders = existingIds.map(() => '?').join(', ');
    await conn.query(
      `UPDATE tbl_job_offer
          SET offer_status = ?, responded_at = NOW()
        WHERE job_id = ?
          AND fk_easyfixter_id IN (${existingIdPlaceholders})
          AND offer_status = ?
          AND job_offer_id NOT IN (${offerIdPlaceholders})`,
      [
        OFFER_STATUS.EXPIRED,
        normalized.jobId,
        ...existingIds,
        OFFER_STATUS.OFFERED,
        ...latestOfferIds,
      ],
    );
  }

  if (newIds.length > 0) {
    const insertValues = newIds.map(() => '(?, ?, ?, NOW(), NOW(), NOW(), 1, ?, ?)').join(', ');
    const insertParams = newIds.flatMap((efrId) => [
      normalized.jobId,
      efrId,
      OFFER_STATUS.OFFERED,
      sourceFor(efrId, source, sourceByEfr),
      offeredBy ?? null,
    ]);

    await conn.query(
      `INSERT INTO tbl_job_offer
         (job_id, fk_easyfixter_id, offer_status, offered_at, created_on, updated_on,
          offer_count, offer_source, offered_by_user_id)
       VALUES ${insertValues}`,
      insertParams,
    );
  }

  return [...ids];
}

module.exports = {
  MAX_OFFER_RECIPIENTS,
  persistJobOfferBatch,
};
