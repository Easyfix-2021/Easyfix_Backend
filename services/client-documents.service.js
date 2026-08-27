/*
 * Client Documents — PAN / TAN / GSTIN / Aadhaar / other.
 *
 * Backed by `tbl_client_document` (created by
 * migrations/2026-05-25-create-client-documents.sql). The table is
 * brand-new; pre-migration deployments are tolerated by a runtime
 * presence probe that gates all reads/writes.
 *
 * S3 storage:
 *   - putClientDocument(...) → key under `ClientDocs/<ts>_<rand>`
 *   - resolveClientDocumentUrl(key) → 5-min presigned GET
 *
 * Doc-type vocabulary (kept open for forward compat — the BE doesn't
 * enforce a strict set since legacy uses both lower-case and
 * Title-Case in different surfaces):
 *   'pan' | 'tan' | 'gstin' | 'aadhaar' | 'other'
 */

const { pool } = require('../db');
const s3 = require('../utils/s3-storage');
const logger = require('../logger');

/* ─── Table-presence probe (cached) ───────────────────────────────── */

let _hasTablePromise = null;
async function hasTable() {
  if (!_hasTablePromise) {
    _hasTablePromise = (async () => {
      try {
        const [rows] = await pool.query(
          `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'tbl_client_document'
            LIMIT 1`,
        );
        const present = rows.length > 0;
        logger.info({ present }, '[client-documents] tbl_client_document presence probe');
        return present;
      } catch (e) {
        /*
         * NOT "assume absent", and NOT cached.
         *
         * A false here does not degrade — it asserts. The CRM Documents tab
         * 503s "storage not provisioned" and the client portal answers
         * { items: [], provisioned: false }, telling a client their KYC
         * checklist is empty. Because the catch sat inside this memoised
         * promise, a two-second blip made that permanent until the container
         * restarted. Uploads were worse: routes/admin/clients.js writes the
         * object to S3 BEFORE calling recordUpload, so every retry orphaned a
         * PAN or Aadhaar file with no row pointing at it.
         *
         * If information_schema is unreachable the data query would fail too,
         * so propagating costs one honest error instead of a confident lie.
         * The genuinely un-migrated case is unaffected: that is a SUCCESSFUL
         * probe returning false, which still short-circuits exactly as before.
         */
        _hasTablePromise = null;
        logger.warn({ err: e?.message }, '[client-documents] table probe failed — not concluding absent');
        throw e;
      }
    })();
  }
  return _hasTablePromise;
}

function unavailableError() {
  return Object.assign(
    new Error('client documents storage not provisioned — run migrations/2026-05-25-create-client-documents.sql'),
    { status: 503 },
  );
}

/* ─── Reads ───────────────────────────────────────────────────────── */

/*
 * List the active documents for a client. Each row carries a
 * presigned URL (5-min TTL) so the FE can render thumbnails / links
 * without a second round-trip. URL resolution failures yield `url:null`
 * (the FE shows a stale-link badge in that case).
 */
async function listForClient(clientId) {
  logger.info('List client documents · clientId=' + clientId);
  if (!(await hasTable())) throw unavailableError();
  const [rows] = await pool.query(
    `SELECT document_id, client_id, doc_type, doc_label, s3_key,
            original_filename, content_type, uploaded_by, uploaded_at
       FROM tbl_client_document
      WHERE client_id = ? AND is_deleted = 0
      ORDER BY uploaded_at DESC`,
    [clientId],
  );
  logger.info('Found ' + rows.length + ' client documents · clientId=' + clientId);
  const withUrls = await Promise.all(rows.map(async (r) => ({
    ...r,
    url: await s3.resolveClientDocumentUrl(r.s3_key).catch(() => null),
  })));
  logger.info('Returning ' + withUrls.length + ' client documents · clientId=' + clientId);
  return withUrls;
}

/* ─── Writes ──────────────────────────────────────────────────────── */

/*
 * Record an upload that has already landed in S3. The route handler
 * runs the multer + S3 putClientDocument flow first, then calls this
 * with the resulting key.
 */
async function recordUpload(clientId, {
  docType, docLabel, s3Key, originalFilename, contentType, uploadedBy,
}) {
  logger.info('Record client document upload · clientId=' + clientId + ' docType=' + (docType || 'other') + ' contentType=' + (contentType || '-'));
  if (!(await hasTable())) throw unavailableError();
  const [ins] = await pool.query(
    `INSERT INTO tbl_client_document
       (client_id, doc_type, doc_label, s3_key, original_filename, content_type, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      clientId,
      String(docType || 'other').toLowerCase(),
      docLabel || null,
      s3Key,
      originalFilename || null,
      contentType || null,
      uploadedBy ?? null,
    ],
  );
  logger.info('Client document recorded · id=' + ins.insertId + ' clientId=' + clientId);
  return ins.insertId;
}

async function softDelete(documentId) {
  logger.info('Soft-delete client document · id=' + documentId);
  if (!(await hasTable())) throw unavailableError();
  const [r] = await pool.query(
    'UPDATE tbl_client_document SET is_deleted = 1 WHERE document_id = ?',
    [documentId],
  );
  logger.info('Client document deleted · id=' + documentId + ' affected=' + r.affectedRows);
  return r.affectedRows;
}

module.exports = {
  hasTable,
  listForClient,
  recordUpload,
  softDelete,
};
