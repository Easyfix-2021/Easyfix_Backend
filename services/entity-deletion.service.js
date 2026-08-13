const { pool } = require('../db');
const logger = require('../logger');
const {
  assertActiveAadhaarAvailable,
  mapAadhaarUniqueViolation,
  normalizeAadhaar,
} = require('../utils/aadhaar-uniqueness');

/**
 * Restore-flavoured Aadhaar conflict. Same 409 code as everywhere else so the
 * client vocabulary stays uniform, but a different sentence: the operator needs
 * to know this record cannot be un-deleted as-is. Carries no value and no
 * holder id — returning either would make restore an enumeration oracle.
 */
async function assertRestorableAadhaar(runner, aadhaar, efrId) {
  try {
    await assertActiveAadhaarAvailable(runner, aadhaar, efrId);
  } catch (error) {
    if (error?.details?.code !== 'AADHAAR_ALREADY_REGISTERED') throw error;
    const conflict = new Error(
      "This technician's Aadhaar number has since been registered to another technician",
    );
    conflict.status = 409;
    conflict.details = { code: 'AADHAAR_ALREADY_REGISTERED' };
    throw conflict;
  }
}

/*
 * Admin entity delete + restore (easyfixer / user) — TOMBSTONE strategy.
 *
 * WHY tombstone (vs hard delete): the parent row is KEPT as an id-anchor so the
 * AUTO_INCREMENT id can NEVER be reissued to a different entity (the user's hard
 * requirement), and so any lingering reference stays valid. On delete we:
 *   1. BLOCK if the entity has any OPERATIONAL footprint (jobs / transactions /
 *      payouts / comments / managerial links). The admin is told to deactivate
 *      instead. This keeps delete scoped to erroneous/test/duplicate accounts
 *      and means the scary tbl_job FK columns are never touched.
 *   2. SNAPSHOT the full parent row + every own-data child row to JSON.
 *   3. PURGE the own-data child rows (recreated verbatim on restore).
 *   4. SCRUB the parent's PII columns + neutralise its visibility flags + set a
 *      deleted-status sentinel, so it surfaces in no CRM list/search/queue.
 *   5. Archive the snapshot in tbl_admin_deleted_archive for an OTP-gated restore.
 *
 * The reference GRAPH below is derived from a LIVE information_schema probe of
 * easyfix_core (declared FKs + convention columns). The shared tbl_easyfixer /
 * tbl_user schema is NEVER altered — the deleted-status marker reuses the
 * existing status column (sentinel 3) and the new tbl_admin_deleted_archive is
 * the authoritative "what is deleted" source.
 */

// efr_status / user_status sentinel meaning "deleted" — distinct from
// 1 (active) and 0 (inactive), so every status-filtered list excludes it.
const DELETED_STATUS = 3;

const GRAPH = {
  easyfixer: {
    parentTable: 'tbl_easyfixer',
    pk: 'efr_id',
    statusColumn: 'efr_status',
    // PII / free-text scrubbed on tombstone.
    scrubColumns: [
      'efr_name', 'efr_first_name', 'efr_last_name', 'efr_no', 'efr_alt_no', 'efr_email',
      'efr_building', 'efr_landmark', 'efr_address', 'efr_address_res', 'efr_pin_no',
      'efr_base_gps', 'efr_current_gps', 'adhaar_card_number', 'pan_card_number',
      'date_of_birth', 'about_yourself', 'about_yourself2', 'efr_profile_img', 'ec_report',
      'profile_update_otp',
      // Financial fields scrubbed too (all restored verbatim from the snapshot)
      // so a by-id finance/payout read of a tombstone returns no balance/receipt.
      // Moot in practice (operational history blocks deletion → ~0 balance) but
      // closes the leak defensively.
      'current_balance', 'efr_sec_dept_amnt', 'efr_receipt_num',
    ],
    // Flags neutralised so the tombstone leaves the registration queue
    // ((new_easy_fixer OR is_existing_easyfixer) AND is_technician_verified IS NULL).
    hideColumns: { new_easy_fixer: 0, is_existing_easyfixer: 0 },
    // ANY row here BLOCKS deletion (operational / financial / managerial).
    operational: [
      { table: 'tbl_job', col: 'fk_easyfixter_id', label: 'jobs assigned' },
      { table: 'tbl_easyfixer_transaction', col: 'easyfixer_id', label: 'wallet transactions' },
      { table: 'tbl_service_payout', col: 'efr_id', label: 'service payouts' },
      { table: 'tbl_ndm_recharge', col: 'efr_id', label: 'NDM recharges' },
      { table: 'tbl_job_comment', col: 'efr_id', label: 'job comments' },
      { table: 'tbl_job_caller_info', col: 'job_efr_id', label: 'call records on jobs' },
      { table: 'tbl_job_escalation_info', col: 'easyfixer_id', label: 'job escalations' },
      { table: 'tbl_easyfixer_rating_by_customer', col: 'easyfixer_id', label: 'customer ratings' },
      { table: 'tbl_easyfixer', col: 'efr_manager_id', label: 'subordinate easyfixers (is a manager)' },
    ],
    // Own private data — snapshot then PURGE (rebuilt verbatim on restore).
    ownData: [
      { table: 'tbl_easyfixer_app', col: 'efr_id' },
      { table: 'tbl_easyfixer_assessment', col: 'efr_Id' },
      { table: 'tbl_easyfixer_bank_details', col: 'efr_Id' },
      { table: 'tbl_easyfixer_events', col: 'efr_id' },
      { table: 'tbl_easyfixer_schedule', col: 'efr_id' },
      { table: 'tbl_easyfixer_document', col: 'efr_id' },
      { table: 'tbl_easyfixer_call_record', col: 'efr_id' },
      { table: 'tbl_easyfixer_rejected_call_record', col: 'efr_id' },
      { table: 'tbl_efr_advance_payment', col: 'efr_id' },
      { table: 'tbl_log_app_notification', col: 'efr_id' },
      { table: 'easyfixer_courses', col: 'easyfixer_id' },
      { table: 'tbl_client_easyfixer_mapping', col: 'easyfixer_id' },
      { table: 'easyfixer_watched_video', col: 'easyfixer_id' },
      { table: 'efr_dskill_status', col: 'easyfixer_id' },
      { table: 'tbl_efr_deepskill_mapping', col: 'easyfixer_id' },
      { table: 'tbl_efr_serviceable_pincodes', col: 'easyfixer_id' },
      { table: 'tbl_easyfixer_attendance', col: 'easyfixer_id' },
      { table: 'tbl_easyfixer_daily_counter', col: 'easyfixer_id' },
      { table: 'easyfixer_comments', col: 'easyfixer_id' },
      { table: 'easyfixer_service_type', col: 'easyfixer_id' },
      { table: 'confirmation_token', col: 'easyfixer_id' },
      { table: 'scheduling_history', col: 'easyfixer_id' },
      { table: 'tbl_easyfixer_rating_by_easyfix_audit', col: 'easyfixer_id' },
      { table: 'tbl_easyfixer_score', col: 'easyfixer_id' },
      { table: 'tbl_tx_confidence_score', col: 'efr_id' },
      { table: 'tx_job_confidence_mapping', col: 'efr_id' },
    ],
    labelOf: (row) => [row.efr_name, row.efr_no].filter(Boolean).join(' · ') || `Easyfixer #${row.efr_id}`,
  },
  user: {
    parentTable: 'tbl_user',
    pk: 'user_id',
    statusColumn: 'user_status',
    scrubColumns: ['user_name', 'official_email', 'mobile_no', 'alternate_no', 'city', 'user_code', 'session_id'],
    hideColumns: {},
    operational: [
      { table: 'tbl_job', col: 'fk_created_by', label: 'jobs created' },
      { table: 'tbl_job', col: 'job_owner', label: 'jobs owned' },
      { table: 'tbl_job', col: 'fk_scheduled_by', label: 'jobs scheduled' },
      { table: 'tbl_job', col: 'invoice_approved_by', label: 'invoices approved' },
      { table: 'tbl_job', col: 'cancel_by', label: 'jobs cancelled' },
      { table: 'tbl_job', col: 'fk_checkout_by', label: 'jobs checked out' },
      { table: 'tbl_job_comment', col: 'commented_by', label: 'job comments' },
      { table: 'tbl_easyfixer_transaction', col: 'created_by', label: 'wallet transactions created' },
      { table: 'tbl_estimate_details', col: 'action_by', label: 'estimate actions' },
      { table: 'tbl_ndm_recharge', col: 'ndm_id', label: 'NDM recharges' },
      { table: 'tbl_easyfixer', col: 'ndm_id', label: 'easyfixers managed (NDM)' },
      { table: 'tbl_easyfixer', col: 'user_id', label: 'linked easyfixer account' },
      { table: 'tbl_vertical_mapping', col: 'user_id', label: 'client/vertical scope mappings' },
      { table: 'tbl_user', col: 'reporting_manager', label: 'direct reports (is a manager)' },
    ],
    ownData: [
      { table: 'tbl_address', col: 'user_id' },
      { table: 'tbl_user_login_logout_logs', col: 'user_id' },
      { table: 'device_info', col: 'user_id' },
      /*
       * The user's PERSONAL (home) email address. Must be here, not merely in
       * scrubColumns: scrubColumns only covers the parent tbl_user row, so
       * without this line a delete would wipe user_name / official_email /
       * mobile_no / alternate_no and leave the private address behind
       * indefinitely — the one contact detail the person never gave us for
       * operational use. Deletion is only reachable for a user with no
       * operational footprint (typically a mistaken create), and personal_email
       * is mandatory on create, so this row essentially always exists.
       *
       * Snapshotted → purged → restored verbatim with the rest of the record,
       * and isMissingSchema() covers the pre-migration host.
       */
      { table: 'tbl_user_personal_details', col: 'user_id' },
    ],
    labelOf: (row) => [row.user_name, row.official_email].filter(Boolean).join(' · ') || `User #${row.user_id}`,
  },
};

function graphFor(entityType) {
  const g = GRAPH[entityType];
  if (!g) {
    const e = new Error(`Unknown entity type: ${entityType}`);
    e.status = 400;
    throw e;
  }
  return g;
}

// MySQL "table/column does not exist" — a convention table may be absent on some
// deploys; skip it (nothing to snapshot/purge) rather than abort the whole op.
function isMissingSchema(err) {
  return err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR'
    || err.errno === 1146 || err.errno === 1054);
}

// BIT(1)/TINYINT(1) come back as JS booleans (db.js typeCast); coerce to 1/0 so
// re-inserting on restore doesn't choke. Everything else passes through.
function coerce(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

async function queryOn(conn, sql, params) {
  return (conn || pool).query(sql, params);
}

/*
 * Compute the deletion impact for an entity. Returns eligibility + the
 * operational blockers (with counts) + own-data row counts. Read-only.
 */
async function getImpact(entityType, id) {
  logger.info('Compute delete impact · entityType=' + entityType + ' · id=' + id);
  const g = graphFor(entityType);
  const [[parent]] = await pool.query(
    `SELECT * FROM \`${g.parentTable}\` WHERE \`${g.pk}\` = ? LIMIT 1`,
    [id],
  );
  if (!parent) {
    const e = new Error(`${entityType} ${id} not found`);
    e.status = 404;
    throw e;
  }

  const blockedBy = [];
  for (const ref of g.operational) {
    let sql = `SELECT COUNT(*) AS n FROM \`${ref.table}\` WHERE \`${ref.col}\` = ?`;
    const params = [id];
    if (ref.table === g.parentTable) { sql += ` AND \`${g.pk}\` <> ?`; params.push(id); }
    try {
      const [[r]] = await pool.query(sql, params);
      if (r.n > 0) blockedBy.push({ table: ref.table, column: ref.col, label: ref.label, count: r.n });
    } catch (err) {
      if (!isMissingSchema(err)) throw err;
    }
  }

  const ownDataCounts = {};
  for (const ref of g.ownData) {
    try {
      const [[r]] = await pool.query(
        `SELECT COUNT(*) AS n FROM \`${ref.table}\` WHERE \`${ref.col}\` = ?`, [id],
      );
      if (r.n > 0) ownDataCounts[ref.table] = r.n;
    } catch (err) {
      if (!isMissingSchema(err)) throw err;
    }
  }

  logger.info('Delete impact computed · entityType=' + entityType + ' · id=' + id + ' · eligible=' + (blockedBy.length === 0) + ' · blockers=' + blockedBy.length);
  return {
    entityType,
    id: Number(id),
    label: g.labelOf(parent),
    currentStatus: parent[g.statusColumn],
    eligible: blockedBy.length === 0,
    blockedBy,
    ownDataCounts,
  };
}

/*
 * Tombstone-delete an entity. Re-checks eligibility inside the transaction,
 * snapshots everything, purges own-data children, scrubs + flags the parent,
 * and writes the archive row. Returns { archiveId, label }.
 */
async function tombstoneDelete(entityType, id, reason, admin) {
  logger.info('Tombstone-delete · entityType=' + entityType + ' · id=' + id);
  const g = graphFor(entityType);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the parent row for the duration.
    const [[parent]] = await conn.query(
      `SELECT * FROM \`${g.parentTable}\` WHERE \`${g.pk}\` = ? LIMIT 1 FOR UPDATE`,
      [id],
    );
    if (!parent) { const e = new Error(`${entityType} ${id} not found`); e.status = 404; throw e; }
    if (Number(parent[g.statusColumn]) === DELETED_STATUS) {
      const e = new Error(`${entityType} ${id} is already deleted`); e.status = 409; throw e;
    }

    // Re-check operational footprint inside the txn (block, don't null).
    const blockedBy = [];
    for (const ref of g.operational) {
      let sql = `SELECT COUNT(*) AS n FROM \`${ref.table}\` WHERE \`${ref.col}\` = ?`;
      const params = [id];
      if (ref.table === g.parentTable) { sql += ` AND \`${g.pk}\` <> ?`; params.push(id); }
      try {
        const [[r]] = await conn.query(sql, params);
        if (r.n > 0) blockedBy.push({ table: ref.table, label: ref.label, count: r.n });
      } catch (err) {
        if (!isMissingSchema(err)) throw err;
        // Surface schema drift instead of silently skipping — a renamed/missing
        // ownData table would otherwise leave PII un-purged (or un-archived) with
        // no signal. Still skipped (nothing to do), but now logged.
        logger.warn({ err: err.message }, 'entity-deletion: skipped a missing table/column (schema drift)');
      }
    }
    if (blockedBy.length) {
      logger.warn('Tombstone-delete blocked · entityType=' + entityType + ' · id=' + id + ' · blockers=' + blockedBy.length);
      const e = new Error('Entity has operational history and cannot be deleted — deactivate it instead.');
      e.status = 409;
      e.details = blockedBy;
      throw e;
    }

    // Snapshot parent + every own-data child row.
    const snapshot = { strategy: 'tombstone', parentTable: g.parentTable, pk: g.pk, parent, children: {} };
    for (const ref of g.ownData) {
      try {
        const [rows] = await conn.query(
          `SELECT * FROM \`${ref.table}\` WHERE \`${ref.col}\` = ?`, [id],
        );
        if (rows.length) snapshot.children[ref.table] = { col: ref.col, rows };
      } catch (err) {
        if (!isMissingSchema(err)) throw err;
        // Surface schema drift instead of silently skipping — a renamed/missing
        // ownData table would otherwise leave PII un-purged (or un-archived) with
        // no signal. Still skipped (nothing to do), but now logged.
        logger.warn({ err: err.message }, 'entity-deletion: skipped a missing table/column (schema drift)');
      }
    }

    // Purge own-data children.
    for (const ref of g.ownData) {
      if (!snapshot.children[ref.table]) continue;
      await conn.query(`DELETE FROM \`${ref.table}\` WHERE \`${ref.col}\` = ?`, [id]);
    }

    // Scrub PII + neutralise visibility flags + set the deleted sentinel.
    const sets = [];
    const vals = [];
    for (const col of g.scrubColumns) {
      if (col in parent) { sets.push(`\`${col}\` = NULL`); }
    }
    for (const [col, val] of Object.entries(g.hideColumns)) {
      if (col in parent) { sets.push(`\`${col}\` = ?`); vals.push(val); }
    }
    sets.push(`\`${g.statusColumn}\` = ?`); vals.push(DELETED_STATUS);
    vals.push(id);
    await conn.query(
      `UPDATE \`${g.parentTable}\` SET ${sets.join(', ')} WHERE \`${g.pk}\` = ?`,
      vals,
    );

    const label = g.labelOf(parent);
    const [ins] = await conn.query(
      `INSERT INTO tbl_admin_deleted_archive
         (entity_type, entity_id, entity_label, snapshot_json, deletion_reason, strategy,
          status, deleted_by, deleted_by_name, deleted_at)
       VALUES (?, ?, ?, ?, ?, 'tombstone', 'deleted', ?, ?, NOW())`,
      [entityType, id, label, JSON.stringify(snapshot), reason,
        admin.user_id || null, admin.user_name || null],
    );

    await conn.commit();
    logger.info(entityType + ' tombstoned · id=' + id + ' · archiveId=' + ins.insertId);
    logger.event('🗑️', 'yellow',
      `admin-delete: tombstoned ${entityType} ${id} (archive #${ins.insertId}) by ${admin.user_name || admin.user_id}`);
    return { archiveId: ins.insertId, label, entityType, id: Number(id) };
  } catch (err) {
    await conn.rollback();
    logger.warn('Tombstone-delete failed · entityType=' + entityType + ' · id=' + id + ' · ' + err.message);
    throw err;
  } finally {
    conn.release();
  }
}

/*
 * List archived (deleted, not-yet-restored) entities. Paginated, newest first.
 */
async function listDeleted({ type, limit = 50, offset = 0 } = {}) {
  logger.info('List deleted archive · type=' + (type || 'all') + ' · limit=' + limit + ' · offset=' + offset);
  const where = ["status = 'deleted'"];
  const params = [];
  if (type) { where.push('entity_type = ?'); params.push(type); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tbl_admin_deleted_archive ${whereSql}`, params,
  );
  const [items] = await pool.query(
    `SELECT id, entity_type, entity_id, entity_label, deletion_reason,
            deleted_by, deleted_by_name, deleted_at
       FROM tbl_admin_deleted_archive ${whereSql}
      ORDER BY deleted_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0)],
  );
  logger.info('Found ' + items.length + ' deleted records (total=' + total + ')');
  return { items, total };
}

/*
 * Generated (VIRTUAL/STORED) columns must never appear in an INSERT or UPDATE
 * column list — MySQL rejects that with errno 3105
 * (ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN), and isMissingSchema() does not
 * swallow it.
 *
 * This became a live restore failure on 2026-08-11: migration
 * 2026-08-11-03-active-aadhaar-uniqueness.sql added the VIRTUAL column
 * tbl_easyfixer.active_aadhaar_unique, snapshots are taken with `SELECT *`, and
 * restore derives its column list from the snapshot's keys — so every technician
 * tombstoned since then failed to restore. Probed from INFORMATION_SCHEMA rather
 * than hard-coding the name, so a future generated column cannot reintroduce it.
 * Cached per table for the process; a probe failure is treated as "none", which
 * preserves the previous behaviour exactly.
 */
const generatedColumnCache = new Map();
async function generatedColumnsFor(runner, table) {
  if (generatedColumnCache.has(table)) return generatedColumnCache.get(table);
  let columns = new Set();
  try {
    const [rows] = await runner.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND EXTRA LIKE '%GENERATED%'`,
      [table],
    );
    columns = new Set(rows.map((row) => row.COLUMN_NAME));
  } catch { /* treat as none — restores behave exactly as before the probe */ }
  generatedColumnCache.set(table, columns);
  return columns;
}

function buildInsert(table, row, skip = new Set()) {
  const cols = Object.keys(row).filter((c) => !skip.has(c));
  const placeholders = cols.map(() => '?').join(', ');
  const colSql = cols.map((c) => `\`${c}\``).join(', ');
  const vals = cols.map((c) => coerce(row[c]));
  return { sql: `INSERT INTO \`${table}\` (${colSql}) VALUES (${placeholders})`, vals };
}

/*
 * Restore a tombstoned entity from its archive snapshot, on the SAME id.
 * Re-applies the full parent row (un-scrub + status) and re-inserts every
 * purged child row. Idempotent per child table (delete-then-insert).
 */
async function restore(archiveId, admin) {
  logger.info('Restore archived entity · archiveId=' + archiveId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[arch]] = await conn.query(
      `SELECT * FROM tbl_admin_deleted_archive WHERE id = ? LIMIT 1 FOR UPDATE`, [archiveId],
    );
    if (!arch) { const e = new Error(`Archive record ${archiveId} not found`); e.status = 404; throw e; }
    if (arch.status !== 'deleted') {
      const e = new Error('This record has already been restored'); e.status = 409; throw e;
    }

    const snapshot = JSON.parse(arch.snapshot_json);
    const g = graphFor(arch.entity_type);
    const parent = snapshot.parent;
    // Older snapshots were taken with SELECT * AFTER the generated column
    // existed, so they carry it; it can never be written back.
    const generated = await generatedColumnsFor(conn, g.parentTable);

    /*
     * Aadhaar duplicate guard. Restore is the ONLY path that moves a row out of
     * efr_status = 3, and therefore the only path that RE-RESERVES an Aadhaar
     * under the generated column's semantics — the number may well have been
     * claimed by an active technician while this row sat tombstoned.
     */
    if (g.parentTable === 'tbl_easyfixer' && normalizeAadhaar(parent.adhaar_card_number)) {
      await assertRestorableAadhaar(conn, parent.adhaar_card_number, arch.entity_id);
    }

    // Re-apply the full parent row (the tombstone row still occupies the id).
    const setCols = Object.keys(parent).filter((c) => c !== g.pk && !generated.has(c));
    const setSql = setCols.map((c) => `\`${c}\` = ?`).join(', ');
    const setVals = setCols.map((c) => coerce(parent[c]));
    const [upd] = await conn.query(
      `UPDATE \`${g.parentTable}\` SET ${setSql} WHERE \`${g.pk}\` = ?`,
      [...setVals, arch.entity_id],
    );
    if (upd.affectedRows === 0) {
      // Tombstone row was hard-removed out of band — re-insert it whole.
      const { sql, vals } = buildInsert(g.parentTable, parent, generated);
      await conn.query(sql, vals);
    }

    // Re-insert each purged child row (delete-then-insert = idempotent).
    for (const [table, payload] of Object.entries(snapshot.children || {})) {
      try {
        await conn.query(`DELETE FROM \`${table}\` WHERE \`${payload.col}\` = ?`, [arch.entity_id]);
        for (const row of payload.rows) {
          const { sql, vals } = buildInsert(table, row);
          await conn.query(sql, vals);
        }
      } catch (err) {
        if (!isMissingSchema(err)) throw err;
        // Surface schema drift instead of silently skipping — a renamed/missing
        // ownData table would otherwise leave PII un-purged (or un-archived) with
        // no signal. Still skipped (nothing to do), but now logged.
        logger.warn({ err: err.message }, 'entity-deletion: skipped a missing table/column (schema drift)');
      }
    }

    await conn.query(
      `UPDATE tbl_admin_deleted_archive
          SET status = 'restored', restored_by = ?, restored_by_name = ?, restored_at = NOW()
        WHERE id = ?`,
      [admin.user_id || null, admin.user_name || null, archiveId],
    );

    await conn.commit();
    logger.info(arch.entity_type + ' restored · id=' + arch.entity_id + ' · archiveId=' + archiveId);
    logger.event('♻️', 'green',
      `admin-restore: restored ${arch.entity_type} ${arch.entity_id} (archive #${archiveId}) by ${admin.user_name || admin.user_id}`);
    return { entityType: arch.entity_type, id: arch.entity_id, label: arch.entity_label };
  } catch (err) {
    await conn.rollback();
    // Map BEFORE logging: a raw mysql2 ER_DUP_ENTRY message embeds the rejected
    // Aadhaar, and this line would write it straight into the application log.
    const safe = mapAadhaarUniqueViolation(err);
    logger.warn('Restore failed · archiveId=' + archiveId + ' · ' + safe.message);
    throw safe;
  } finally {
    conn.release();
  }
}

module.exports = { getImpact, tombstoneDelete, listDeleted, restore, DELETED_STATUS, GRAPH };
