const { pool } = require('../db');
const logger = require('../logger');

/*
 * Activity Log Service — unified append-only audit trail.
 *
 * Tracks all technician lifecycle events: LEAD invites, app downloads,
 * OTP verification, registration steps, status changes, bank verification,
 * comments from CRM. No updates or deletes — purely append.
 *
 * Design: mirrors existing tbl_easyfixer_lifecycle_status_log and
 * tbl_easyfixer_sensitive_change_log; new tbl_easyfixer_activity_log is
 * a unified feed, not a replacement.
 *
 * Calls sp_activity_log_append or inserts directly via pool.query.
 */

/**
 * Append a single event to the activity log.
 *
 * @param {Object} payload
 * @param {number} payload.efr_id — technician ID (NULL until registered)
 * @param {string} payload.mobile — phone number (LEAD identifier)
 * @param {number} payload.supply_request_id — links LEAD to supply-gap allocation
 * @param {string} payload.event_type — e.g. INVITE_SENT, OTP_VERIFIED, REGISTERED, etc.
 * @param {string} payload.category — COMMUNICATION | LIFECYCLE | VERIFICATION | SENSITIVE_CHANGE | COMMENT
 * @param {string} payload.section — optional, which tab: onboarding | bank | work | skills
 * @param {string} payload.from_stage — for STATUS_CHANGED: old state
 * @param {string} payload.to_stage — for STATUS_CHANGED: new state
 * @param {string} payload.source — SUPPLY_DASHBOARD | APP | CRM | CRON | SYSTEM | QUICKSIGHT
 * @param {string} payload.actor_type — TECHNICIAN | STAFF | SYSTEM
 * @param {number} payload.actor_user_id — CRM user_id (if actor_type=STAFF)
 * @param {string} payload.actor_name — display name (e.g. "Harkirpa Kaur", "Technician")
 * @param {string} payload.summary — human line, e.g. "Invite sent via WhatsApp"
 * @param {Object} payload.metadata — JSON object, event-specific (reason_code, field, old_value, etc.)
 * @returns {Promise<Object>} { log_id, created_at, ... }
 */
async function appendEvent(payload) {
  const {
    efr_id,
    mobile,
    supply_request_id,
    event_type,
    category,
    section,
    from_stage,
    to_stage,
    source,
    actor_type,
    actor_user_id,
    actor_name,
    summary,
    metadata,
  } = payload;

  try {
    const result = await pool.query(
      `INSERT INTO tbl_easyfixer_activity_log (
        efr_id, mobile, supply_request_id, event_type, category, section,
        from_stage, to_stage, source, actor_type, actor_user_id, actor_name,
        summary, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        efr_id || null,
        mobile || null,
        supply_request_id || null,
        event_type,
        category,
        section || null,
        from_stage || null,
        to_stage || null,
        source,
        actor_type || null,
        actor_user_id || null,
        actor_name || null,
        summary || null,
        metadata ? JSON.stringify(metadata) : null,
        new Date(),
      ],
    );

    logger.debug(`Activity log appended: log_id=${result[0].insertId} · event=${event_type}`);

    return {
      log_id: result[0].insertId,
      created_at: new Date(),
      ...payload,
    };
  } catch (e) {
    logger.error(`Failed to append activity log: ${e.message}`);
    throw {
      status: 500,
      message: 'Failed to log activity',
      details: e.message,
    };
  }
}

/**
 * Append a COMMENT_ADDED event from CRM (e.g., during onboarding review).
 *
 * @param {Object} opts
 * @param {number} opts.efr_id — technician ID
 * @param {string} opts.section — which tab (onboarding | bank | contact | work | skills | pincodes)
 * @param {string} opts.comment — the text
 * @param {number} opts.actor_user_id — CRM staff user_id
 * @param {string} opts.actor_name — staff name
 * @returns {Promise<Object>}
 */
async function appendComment(opts) {
  const { efr_id, section, comment, actor_user_id, actor_name } = opts;
  return appendEvent({
    efr_id,
    mobile: null,
    supply_request_id: null,
    event_type: 'COMMENT_ADDED',
    category: 'COMMENT',
    section,
    from_stage: null,
    to_stage: null,
    source: 'CRM',
    actor_type: 'STAFF',
    actor_user_id,
    actor_name,
    summary: `Comment: ${comment.substring(0, 100)}${comment.length > 100 ? '...' : ''}`,
    metadata: { comment },
  });
}

/**
 * Append a STATUS_CHANGED event (lifecycle transition).
 *
 * @param {Object} opts
 * @param {number} opts.efr_id — technician ID
 * @param {string} opts.from_stage — old state
 * @param {string} opts.to_stage — new state
 * @param {string} opts.reason_code — e.g. ACCEPTED, REJECTED, SENT_BACK
 * @param {string} opts.reason_text — human reason
 * @param {number} opts.actor_user_id — CRM staff user_id
 * @param {string} opts.actor_name — staff name
 * @param {string} opts.source — CRM | CRON | SYSTEM (default CRM)
 * @returns {Promise<Object>}
 */
async function appendStatusChange(opts) {
  const {
    efr_id,
    from_stage,
    to_stage,
    reason_code,
    reason_text,
    actor_user_id,
    actor_name,
    source = 'CRM',
  } = opts;

  return appendEvent({
    efr_id,
    mobile: null,
    supply_request_id: null,
    event_type: 'STATUS_CHANGED',
    category: 'LIFECYCLE',
    section: 'status',
    from_stage,
    to_stage,
    source,
    actor_type: source === 'CRON' || source === 'SYSTEM' ? 'SYSTEM' : 'STAFF',
    actor_user_id,
    actor_name,
    summary: `${from_stage} → ${to_stage}${reason_text ? ' — ' + reason_text : ''}`,
    metadata: { reason_code, reason_text },
  });
}

/**
 * Append a BANK_VERIFIED event (finance approval).
 *
 * @param {Object} opts
 * @param {number} opts.efr_id — technician ID
 * @param {string} opts.account_number — masked account
 * @param {string} opts.verified_by — staff name
 * @param {number} opts.actor_user_id — staff user_id
 * @param {Object} opts.metadata — { verified_fields: [...], notes: "..." }
 * @returns {Promise<Object>}
 */
async function appendBankVerification(opts) {
  const { efr_id, account_number, verified_by, actor_user_id, metadata } = opts;

  return appendEvent({
    efr_id,
    mobile: null,
    supply_request_id: null,
    event_type: 'BANK_VERIFIED',
    category: 'VERIFICATION',
    section: 'bank',
    from_stage: null,
    to_stage: null,
    source: 'CRM',
    actor_type: 'STAFF',
    actor_user_id,
    actor_name: verified_by,
    summary: `Bank account verified: ${account_number}`,
    metadata,
  });
}

/**
 * Query activity log for a technician.
 *
 * @param {number} efr_id — technician ID
 * @param {Object} opts
 * @param {number} opts.limit — max rows (default 100)
 * @param {number} opts.offset — pagination (default 0)
 * @param {string} opts.eventType — filter by event_type
 * @param {string} opts.category — filter by category
 * @returns {Promise<Array>}
 */
async function getActivityLog(efr_id, opts = {}) {
  const { limit = 100, offset = 0, eventType, category } = opts;

  let sql = 'SELECT * FROM tbl_easyfixer_activity_log WHERE efr_id = ?';
  const params = [efr_id];

  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  try {
    const [rows] = await pool.query(sql, params);
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }));
  } catch (e) {
    logger.error(`Failed to query activity log: ${e.message}`);
    throw {
      status: 500,
      message: 'Failed to retrieve activity log',
    };
  }
}

module.exports = {
  appendEvent,
  appendComment,
  appendStatusChange,
  appendBankVerification,
  getActivityLog,
};
