/*
 * Transaction-scoped EasyFixer document upsert shared by the mobile Personal,
 * Professional, and Identity profile sections.
 *
 * tbl_easyfixer_document has no UNIQUE(efr_id, efr_doc_type_id), so the caller
 * must hold the per-technician `efr_doc:<efrId>` MySQL named lock until its
 * surrounding transaction commits. Keeping the helper runner-injected avoids
 * nested transactions and keeps all profile fields/documents atomic.
 */

const logger = require('../logger');
const s3Storage = require('../utils/s3-storage');
const { publicUrlFor } = require('../utils/file-storage');

async function upsertEasyfixerDocuments(connection, efrId, rows) {
  for (const [typeId, key] of rows) {
    if (!key) continue;
    const [[existing]] = await connection.query(
      `SELECT efr_doc_id
         FROM tbl_easyfixer_document
        WHERE efr_id = ? AND efr_doc_type_id = ?
        LIMIT 1`,
      [efrId, typeId],
    );
    if (existing) {
      await connection.query(
        'UPDATE tbl_easyfixer_document SET efr_document_name = ? WHERE efr_doc_id = ?',
        [key, existing.efr_doc_id],
      );
    } else {
      await connection.query(
        `INSERT INTO tbl_easyfixer_document
           (efr_id, efr_doc_type_id, efr_document_name, created_date, created_by)
         VALUES (?, ?, ?, NOW(), ?)`,
        [efrId, typeId, key, efrId],
      );
    }
  }
}

/*
 * Read side of the same column: turn a stored `efr_document_name` into
 * something the app can actually render.
 *
 * WHY IT LIVES HERE. `efr_document_name` holds an S3 KEY, never a URL, and
 * until now nothing in the codebase converted one back — every read path
 * handed the app a numeric `efr_doc_id` and stopped, so a technician
 * re-opening a KYC screen saw empty tiles even though the photos were stored.
 * Keeping the reader next to the writer keeps both halves of the convention in
 * one file.
 *
 * WHY PREFIX-AGNOSTIC, AND WHY IT PROBES FIRST. Three shapes live in this
 * column: `MobileUploads/<efrId>_<ts>_<rand8>` written by POST
 * /api/mobile/uploads, a bare filename written by the legacy Flutter app whose
 * S3 object sits under the `easyfixer_documents/` prefix (mirroring the Nginx
 * layout in utils/file-storage.js), and an absolute URL on the oldest rows. We
 * did not write them all, so we HEAD before signing: `getSignedUrl` happily
 * signs a key that does not exist, and that URL 403s at fetch time — the app
 * renders a broken tile instead of its "no photo yet" placeholder.
 *
 * Never throws. A prefill image is an enhancement, never a blocker: a missing
 * row, a missing object, an S3 outage or a signing failure all degrade to null.
 */
async function resolveEasyfixerDocumentUrl(storedValue) {
  const stored = String(storedValue || '').trim();
  if (!stored) return null;
  // Oldest rows stored an absolute URL rather than a key — pass it through.
  if (/^https?:\/\//i.test(stored)) return stored;

  if (!s3Storage.isEnabled()) {
    /*
     * Local dev (S3_BUCKET_NAME unset). The upload fell back to disk via
     * file-storage.writeBuffer('general', …) and the column holds that bare
     * on-disk filename, so the same URL builder the upload replied with is the
     * truthful answer here. A value WITH a separator can only be an S3 key
     * from an S3-enabled environment — there is no local file behind it, so
     * null beats fabricating a link that 404s.
     */
    return stored.includes('/') ? null : publicUrlFor('general', stored);
  }

  const candidates = stored.includes('/')
    ? [stored]
    : [stored, `easyfixer_documents/${stored}`];
  for (const key of candidates) {
    try {
      if (await s3Storage.exists(key)) return await s3Storage.getPresignedUrl(key);
    } catch (error) {
      // One failed candidate is not a failed prefill — try the rest. The KEY is
      // safe to log; the signed URL never is, so it is not built on this path.
      logger.warn({ key, err: error.message }, 'easyfixer document URL resolution failed');
    }
  }
  return null;
}

module.exports = { upsertEasyfixerDocuments, resolveEasyfixerDocumentUrl };
