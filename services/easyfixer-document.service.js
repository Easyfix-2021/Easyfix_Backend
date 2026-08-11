/*
 * Transaction-scoped EasyFixer document upsert shared by the mobile Personal,
 * Professional, and Identity profile sections.
 *
 * tbl_easyfixer_document has no UNIQUE(efr_id, efr_doc_type_id), so the caller
 * must hold the per-technician `efr_doc:<efrId>` MySQL named lock until its
 * surrounding transaction commits. Keeping the helper runner-injected avoids
 * nested transactions and keeps all profile fields/documents atomic.
 */

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

module.exports = { upsertEasyfixerDocuments };
