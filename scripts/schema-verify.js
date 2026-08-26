#!/usr/bin/env node
/**
 * Cross-verify every column the new backend touches against the live
 * MySQL `INFORMATION_SCHEMA`. Read-only.
 *
 * Catches the "phantom column" class of bugs that destroyed earlier
 * iterations — the migration audit relied on legacy raw SQL grep,
 * but production DDL is the ultimate source of truth.
 */
require('dotenv').config();
const { pool } = require('../db');

// Tables × columns the new backend writes or reads. Adding a column
// here that DOESN'T exist in the live DB is a real bug to fix.
const EXPECTED = {
  tbl_job: [
    'job_id', 'job_reference_id', 'client_ref_id', 'job_status', 'job_type',
    'source_type', 'job_desc', 'created_date_time', 'requested_date_time',
    'scheduled_date_time', 'checkin_date_time', 'checkout_date_time',
    'fk_customer_id', 'fk_client_id', 'fk_easyfixter_id', 'fk_address_id',
    'job_owner', 'fk_created_by',
    'approved_by_client_contact', 'approved_on_date_time',
    'approval_reject_reason', 'approval_reject_date_time',
    'approval_sent_on_date_time', 'no_of_req_approval',
    'full_fillment_reason', 'full_fillment_time', 'full_fillment_by',
    'full_fillment_created_time', 'no_of_req_foh',
    'reporting_contact_id', 'client_spoc_email',
    'cancel_reason_id', 'cancel_comment', 'cancel_by', 'cancel_date_time',
    /*
     * Book-Call column set added 2026-05-25. These are written by
     * `services/job.service.js#create()` + accepted on UPDATE via
     * MUTABLE_COLUMNS. Listing them here means a missing column on
     * any deploy fails the schema parity check at boot instead of
     * surfacing as a runtime 500 mid-request.
     */
    'requested_time', 'time_slot', 'booking_cut_off_time_slot',
    'service_type_ids', 'fk_service_type_id', 'fk_service_catg_id',
    'job_customer_name', 'client_spoc', 'client_spoc_name',
    'additional_name', 'additional_number',
    'collected_by', 'eta_status', 'paid_by',
    'original_appointment_date_time', 'original_appointment_time',
    'job_client_owner', 'helper_req', 'remarks',
    'efr_special_notes', 'branch_details', 'last_update_time',
  ],
  tbl_job_services: [
    'job_service_id', 'job_id', 'service_id', 'service_type_id', 'service_category_id',
    'quantity', 'total_charge', 'material_charge', 'easyfix_charge',
    'easyfixer_charge', 'client_charge', 'job_charge_type',
    'service_charge_description', 'job_service_status',
  ],
  tbl_job_comment: [
    'comment_id', 'job_id', 'comments', 'comment_on', 'created_on',
    'appointment_on', 'commented_by', 'enum_reason_id', 'efr_id',
  ],
  /*
   * tbl_job_logs — the job-history archive (1.7M rows, written since 2015).
   * Until services/job-log.service.js there was not one reference to this table
   * in any .js or .sql, and its absence from THIS list is why a source-level
   * survey could not see it at all. The column list is the legacy JobsLog entity
   * (EasyFix_CRM .../Jobs/model/JobsLog.java), confirmed against
   * INFORMATION_SCHEMA. `event_received_date` is listed although the new backend
   * does not write it: the old API does, and a reader of this history will meet
   * it, so a deploy that lost the column should be REPORTED rather than surprise
   * whoever builds the Job Log tab.
   *
   * Listed in FAIL_SOFT_TABLES below, so a gap here warns on every boot instead
   * of stopping it — every write to this table is deliberately swallowed, so it
   * cannot 500 a request and must not be able to block a deploy either.
   */
  tbl_job_logs: [
    'job_log_id', 'log_for', 'old_data', 'new_data', 'comments',
    'changed_by', 'change_date', 'job_id', 'eta_status', 'event_received_date',
  ],
  tbl_customer_feedback: [
    'feedback_id', 'job_id', 'easyfixer_rating', 'easyfix_rating', 'happy_with_service',
  ],
  tbl_client_invoice: [
    'id', 'fk_client_id', 'invoice_number', 'invoice_date',
    'billing_from_date', 'billing_to_date', 'total_invoice_amount',
    'total_paid_amount', 'total_tds_deducted',
    'current_due_amount', 'previous_due_amount',
    'is_paid', 'is_raised', 'amount_due_date',
    'invoiced_job_ids', 'invoice_desc',
    'file_path_pdf', 'file_path_excel', 'updated_comments',
  ],
  tbl_client_invoice_paid: [
    'paid_id', 'fk_invoice_id', 'fk_client_id', 'paid_amount',
    'paid_date', 'paid_by', 'comments', 'upload_documents',
  ],
  tbl_service_payout: [
    'payout_id', 'efr_id', 'efr_balance',
    'pm_req_amount', 'pm_req_date', 'pm_req_by',
    'ops_amount', 'ops_approved_amount',
    'fin_approved_amount', 'fin_payout_ref', 'fin_payout_doc',
    'fin_rejected_by', 'fin_reject_date',
    'is_approved_by_fin',
  ],
  tbl_ndm_recharge: [
    'recharge_id', 'efr_id', 'ndm_id', 'recharge_amount', 'recharge_date',
    'approval_date', 'recharge_type', 'comments', 'approved_by_finance',
    'document_path', 'payment_mode', 'reference_id',
  ],
  quotation_details: [
    'id', 'type', 'name', 'unit', 'unit_price',
    'tx_charge', 'client_charge', 'approved_charge', 'margin',
    'status', 'easyfxer_id',
    'action_by', 'sent_by', 'sent_on', 'action_on',
    'job_id', 'client_service_id', 'material_id', 'job_service_id',
  ],
  tbl_questionaire: [
    'c_questionaire_id', 'client_id', 'c_questionaire_name', 'status',
    'inserted_by', 'insert_date', 'updated_by', 'update_date',
  ],
  tbl_questionaire_details: [
    'c_qd_id', 'c_questionaire_id', 'c_qd_category', 'c_qd_seq',
    'c_qd_type', 'c_qd_sub_type', 'c_qd_text', 'c_qd_instn', 'c_qd_values',
    'c_qd_mandatory', 'c_qd_proof_allowed', 'c_qd_proof_mandatory',
    'c_qd_cmnts_allowed', 'c_qd_cmnts_mandatory',
    'c_qd_weightage', 'c_qd_visibility', 'c_qd_image_doc',
    'c_qd_depends_id', 'c_qd_depends_option', 'c_qd_depends_choice', 'status',
  ],
  tbl_easyfixer_attendance: [
    'id', 'easyfixer_id', 'morning_slot', 'evening_slot',
    'is_leave_marked', 'created_on', 'insert_date', 'updated_on',
  ],
  tbl_customer: [
    'customer_id', 'customer_mob_no', 'customer_name', 'customer_email',
    'is_active', 'insert_date', 'update_date', 'created_by', 'updated_by',
  ],
  tbl_easyfixer_transaction: [
    'transaction_id', 'easyfixer_id', 'source', 'description',
    'transaction_type', 'transaction_date', 'amount', 'balance',
    'created_date', 'created_by', 'job_id', 'trans_reason_code',
  ],
  tbl_easyfixer_withdrawal_request: [
    'request_id', 'fk_easyfixer_id', 'amount', 'status',
    'requested_on', 'processed_on', 'processed_by', 'remarks',
    'bank_details_id', 'bank_account_number', 'bank_ifsc',
    'bank_account_holder_name', 'bank_id', 'bank_name',
  ],
  tbl_tools: [
    'tool_id', 'tool_name', 'tool_desc', 'tool_status', 'tool_img',
  ],
  tbl_role: [
    'role_id', 'role_name', 'role_desc', 'menu_ids', 'role_status',
    'insert_date', 'update_date',
    'updayted_by', // legacy DB typo ("updayted", not "updated") — preserve
    'inserted_by', 'display_job_dashboard', 'logging_tracking',
  ],
  tbl_user: [
    'user_id', 'user_name', 'official_email', 'mobile_no', 'alternate_no',
    'user_role', 'user_type_id', 'city_id', 'user_status',
    'manage_clients', 'manage_cities', 'manage_states', 'manage_verticals',
    'reporting_manager',
    'insert_date', 'update_date', 'updated_by',
  ],
  tbl_vertical: ['vertical_id', 'vertical_name', 'status'],
  confirmation_token: [
    'id', 'token', 'login_id', 'is_verified', 'client_id', 'easyfixer_id', 'is_token_expired',
  ],
  pincode_firefox_city_mapping: ['id', 'pincode', 'firefox_city_id'],
  firefox_city_mapping: ['id', 'city_name', 'city_id', 'no_of_slot'],
  // training_video_id is the FK into `document` that resolves a video's
  // playable URL; services/lms.service.js both reads it and writes it
  // (SET training_video_id = NULL / = ?), so it belongs here like any other
  // column the code's own SQL names.
  training_videos: [
    'id', 'title', 'description', 'sub_title', 'sub_description',
    'training_video_id',
  ],
  // ─── LMS (services/lms.service.js) ──────────────────────────────────────
  // `courses` and `easyfixer_courses` pre-date the LMS work; only
  // courses.status is new (migrations/executed/2026-08-13-lms-foundation.sql).
  // Both are read on the LMS list/detail/report paths, so a missing column
  // here is a 500 on first request, not a degraded behaviour.
  courses: ['id', 'name', 'description', 'status', 'created_at', 'updated_at'],
  easyfixer_courses: [
    'id', 'easyfixer_id', 'course_id', 'score', 'created_at', 'updated_at',
  ],
  /*
   * Course CONTENT (2026-08-26-lms-content-types-and-assessments.sql). These
   * replaced course_videos, which is no longer read anywhere and is therefore
   * no longer listed — the migration keeps the table as a rollback surface,
   * not as something the code depends on.
   *
   * These belong under the STRICT rule, not the fail-soft one, and the reason
   * is worth stating: lms_content is what isTrainingComplete,
   * MANDATORY_VIDEO_IDS_SQL and both completion stamps now read, and those
   * gate EARNING. Deploying this code against a database without these tables
   * would not degrade — it would make every technician's training unreadable,
   * which reads as incomplete, which stops them receiving work. Refusing to
   * boot is the loud, recoverable failure; the quiet one locks the field out.
   */
  lms_content: ['id', 'course_id', 'kind', 'ref_id', 'sequence', 'status', 'created_at', 'updated_at'],
  lms_document: [
    'id', 'title', 'file_key', 'mime_type', 'size_bytes', 'page_count',
    'status', 'created_at', 'created_by',
  ],
  lms_assessment: [
    'id', 'title', 'description', 'pass_percent', 'max_attempts', 'status',
    'created_at', 'updated_at',
  ],
  lms_question: ['id', 'assessment_id', 'question_text', 'sequence', 'status'],
  lms_question_option: ['id', 'question_id', 'option_text', 'is_correct', 'sequence'],
  lms_assessment_attempt: [
    'id', 'easyfixer_id', 'assessment_id', 'course_id', 'attempt_no',
    'score_pct', 'passed', 'created_at',
  ],
  lms_document_ack: ['id', 'easyfixer_id', 'content_id', 'acknowledged_at'],
  tbl_easyfixer: [
    'efr_id', 'efr_name', 'efr_no', 'efr_status', 'efr_cityId',
    'current_balance', 'balance_updated',
    'adhaar_card_number', 'pan_card_number', 'have_driving_lisence',
    'is_technician_verified', 'is_email_verified', 'date_of_birth',
    'active_aadhaar_unique',
  ],
  tbl_idempotency_key: [
    'actor_type', 'actor_id', 'idempotency_key', 'method', 'path',
    'request_fingerprint', 'state', 'lease_token', 'lease_expires_at',
    'response_status', 'response_json', 'created_at', 'completed_at', 'expires_at',
  ],
  easyfixer_watched_video: [
    'id', 'easyfixer_id', 'video_id', 'watched_percentage', 'update_date',
  ],
};

/*
 * Tables in EXPECTED whose column mismatches are a DEGRADATION, not a boot
 * blocker — reported through the same softer channel the hardening invariants
 * below use (invariantMismatches: warn loudly every boot, block only under
 * REQUIRE_SCHEMA_INVARIANTS=true).
 *
 * The rule the rest of EXPECTED obeys is "the code's own SQL names this column,
 * so a request 500s the moment it runs — refuse to boot". That rule is what
 * makes the strictness correct, and it is exactly what does not hold for a table
 * whose EVERY write is deliberately fail-soft: services/job-log.service.js
 * swallows its own errors and returns null so a history row can never cost the
 * job mutation it describes. A table that cannot break a REQUEST must not be
 * able to break a DEPLOY — otherwise shipping into an environment where
 * tbl_job_logs is missing or differently-shaped crash-loops the container
 * instead of quietly losing log rows, and the only recovery,
 * SKIP_SCHEMA_VERIFY=true, ALSO switches off the phantom-column protection for
 * the twenty-odd tables where the strict rule DOES hold. That is the shape of
 * the 2026-08-12 outage, and it is why this is a severity change and not a
 * deletion: the columns are still checked and still reported on every boot.
 *
 * Anything added here must be able to justify the same sentence: every write is
 * swallowed, and every read tolerates the table being absent.
 */
const FAIL_SOFT_TABLES = {
  tbl_job_logs:
    'history rows only — every write goes through services/job-log.service.js, '
    + 'which swallows its own errors after the job mutation has committed',
};

// These constraints are correctness requirements, not optional tuning. A
// missing idempotency key UNIQUE can execute an offline mutation twice; a
// missing training UNIQUE makes ON DUPLICATE KEY UPDATE insert duplicates; and
// the active-Aadhaar UNIQUE is the authoritative cross-technician race guard.
//
// SEVERITY (2026-08-12, after a production boot-loop): these are reported
// SEPARATELY from missing columns. A missing COLUMN is a phantom-column bug —
// the code's own SQL names it, so a request 500s the moment it runs; the server
// must refuse to boot. A missing INDEX/TRIGGER/GENERATED COLUMN below is a
// hardening invariant — every query still executes, the behaviour simply
// degrades to what production did before the invariant existed. Blocking boot
// on those coupled the server's availability to a migration that is itself
// blocked on an audited Ops decision (the active-Aadhaar duplicates), so the
// only way back up was SKIP_SCHEMA_VERIFY=true — which ALSO disables the
// phantom-column protection this file exists for. They now warn loudly on every
// boot and block only when REQUIRE_SCHEMA_INVARIANTS=true (set that once the
// migrations have landed, to make the guarantee permanent).
const REQUIRED_INDEXES = [
  {
    table: 'tbl_idempotency_key',
    columns: ['actor_type', 'actor_id', 'idempotency_key'],
    unique: true,
  },
  { table: 'tbl_idempotency_key', columns: ['expires_at'], unique: false },
  {
    table: 'easyfixer_watched_video',
    columns: ['easyfixer_id', 'video_id'],
    unique: true,
  },
  { table: 'tbl_easyfixer', columns: ['active_aadhaar_unique'], unique: true },
  // assignCourse() does INSERT … ON DUPLICATE KEY UPDATE on easyfixer_courses,
  // so this UNIQUE is the ONLY thing making re-assignment idempotent — exactly
  // the easyfixer_watched_video story above. Without it, re-assigning a course
  // inserts a second row and the report double-counts the technician.
  {
    table: 'easyfixer_courses',
    columns: ['easyfixer_id', 'course_id'],
    unique: true,
  },
  // setCourseContent() UPSERTS onto this key — it is what makes a re-order
  // keep each item's existing row id, and therefore what stops a saved course
  // from orphaning every lms_document_ack that pointed at the old row.
  { table: 'lms_content', columns: ['course_id', 'kind', 'ref_id'], unique: true },
  // The ONLY thing making "three attempts" mean three attempts: submitAssessment
  // allocates attempt_no from a read, and this key is what turns two racing
  // submits into one ER_DUP_ENTRY retry instead of two attempt 2s.
  {
    table: 'lms_assessment_attempt',
    columns: ['easyfixer_id', 'assessment_id', 'attempt_no'],
    unique: true,
  },
  // Makes the document acknowledgement idempotent — the app replays it.
  { table: 'lms_document_ack', columns: ['easyfixer_id', 'content_id'], unique: true },
  {
    table: 'tbl_easyfixer_withdrawal_request',
    columns: ['fk_easyfixer_id', 'status'],
    unique: false,
  },
];

function canonicalSql(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/_utf8mb4|_utf8/g, '')
    .replace(/[`\s()]/g, '');
}

function matchesActiveAadhaarGeneratedColumn(row) {
  // EXTRA + GENERATION_EXPRESSION are shared by MySQL and MariaDB. MariaDB
  // additionally exposes IS_GENERATED, but selecting that field makes MySQL
  // abort the startup verifier before any invariant can be checked.
  const generated = /\b(?:VIRTUAL|STORED|PERSISTENT)\b/i.test(String(row?.extra || ''));
  return generated && canonicalSql(row?.generation_expression) ===
    "casewhennotefr_status<=>3thennulliftrimadhaar_card_number,''elsenullend";
}

const ACTIVE_AADHAAR_GENERATED_COLUMN_SQL =
  `SELECT GENERATION_EXPRESSION AS generation_expression,
          EXTRA AS extra
     FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = 'tbl_easyfixer'
      AND COLUMN_NAME = 'active_aadhaar_unique'`;

function matchesTrainingMonotonicTrigger(row) {
  return String(row?.action_timing || '').toUpperCase() === 'BEFORE'
    && String(row?.event_manipulation || '').toUpperCase() === 'UPDATE'
    && String(row?.event_object_table || '').toLowerCase() === 'easyfixer_watched_video'
    && canonicalSql(row?.action_statement) ===
      'setnew.watched_percentage=greatestcoalesceold.watched_percentage,0,coalescenew.watched_percentage,0';
}

// Tables the code GRACEFULLY HANDLES being missing — we don't fail
// the verify run for these, just note them in the report.
const OPTIONAL = {
  tbl_ai_call_session: 'AI-calling flow (Validate Flows) — needs migrations 2026-07-06-create-tbl-ai-call-session + 2026-07-08-add-engine + 2026-07-08-add-recording; gated by ai.calling.enabled, code degrades when absent',
  pincode_decathlon: 'Decathlon variant returns null when missing (handled in integration.service.js)',
  product: 'Product CRUD requires migrations/2026-05-12-create-product-tables.sql to be run',
  product_code: 'Product CRUD requires migrations/2026-05-12-create-product-tables.sql to be run',
  product_additional_image: 'Product CRUD requires migrations/2026-05-12-create-product-tables.sql to be run',
};

/**
 * Returns { ok, requiredMismatches, invariantMismatches, optionalMissing, ... }.
 *
 * `requiredMismatches` = missing tables/columns → the code's own SQL names them,
 *   so these are runtime 500s waiting to happen. Callers MUST refuse to boot.
 * `invariantMismatches` = missing UNIQUE index / generated column / trigger, or
 *   a missing column on a FAIL_SOFT_TABLES table → queries still run, behaviour
 *   degrades. Callers warn; blocking is opt-in (REQUIRE_SCHEMA_INVARIANTS).
 *
 * Does NOT exit the process — caller decides what to do.
 */
async function verifySchemaAgainstLiveDb() {
  const dbName = process.env.DB_NAME;
  let totalChecked = 0;
  const missing = [];
  const invariants = [];
  const optionalMissing = [];

  for (const [table, columns] of Object.entries(EXPECTED)) {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, table]
    );
    const actual = new Set(rows.map((r) => r.COLUMN_NAME));
    // Fail-soft tables report through the invariant channel — same two-class
    // severity the indexes/trigger use. See FAIL_SOFT_TABLES.
    const impact = FAIL_SOFT_TABLES[table];
    const bucket = impact ? invariants : missing;
    if (actual.size === 0) {
      bucket.push({ table, col: '<TABLE DOES NOT EXIST>', missing: '<TABLE DOES NOT EXIST>', impact });
      continue;
    }
    for (const col of columns) {
      totalChecked++;
      if (!actual.has(col)) bucket.push({ table, col, impact });
    }
  }

  for (const required of REQUIRED_INDEXES) {
    const [rows] = await pool.query(
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
         FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [dbName, required.table],
    );
    const indexes = new Map();
    for (const row of rows) {
      if (!indexes.has(row.INDEX_NAME)) {
        indexes.set(row.INDEX_NAME, { unique: Number(row.NON_UNIQUE) === 0, columns: [] });
      }
      indexes.get(row.INDEX_NAME).columns.push(row.COLUMN_NAME);
    }
    const found = [...indexes.values()].some((index) => {
      if (required.unique && !index.unique) return false;
      // A non-unique lookup can use a wider index with this left prefix. A
      // UNIQUE invariant must match exactly; UNIQUE(a,b,c) does not enforce
      // uniqueness of (a,b).
      if (required.unique && index.columns.length !== required.columns.length) return false;
      return required.columns.every((column, i) => index.columns[i] === column);
    });
    if (!found) {
      invariants.push({
        table: required.table,
        col: `<${required.unique ? 'UNIQUE ' : ''}INDEX(${required.columns.join(',')})>`,
        impact: required.table === 'tbl_idempotency_key'
          ? 'an offline mutation can execute twice'
          : required.table === 'easyfixer_watched_video'
            ? 'ON DUPLICATE KEY UPDATE cannot fire — training saves insert duplicate rows'
            : 'the cross-technician Aadhaar race guard is not enforced by the database',
      });
    }
  }

  const [generatedColumns] = await pool.query(
    ACTIVE_AADHAAR_GENERATED_COLUMN_SQL,
    [dbName],
  );
  if (!matchesActiveAadhaarGeneratedColumn(generatedColumns[0])) {
    invariants.push({
      table: 'tbl_easyfixer',
      col: '<GENERATED active_aadhaar_unique EXPRESSION>',
      impact: 'no runtime query reads this column; only the DB-level uniqueness guard is absent',
    });
  }

  const [trainingTriggers] = await pool.query(
    `SELECT TRIGGER_NAME AS trigger_name,
            EVENT_OBJECT_TABLE AS event_object_table,
            ACTION_TIMING AS action_timing,
            EVENT_MANIPULATION AS event_manipulation,
            ACTION_STATEMENT AS action_statement
       FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = ?
        AND TRIGGER_NAME = 'trg_easyfixer_watched_video_monotonic'`,
    [dbName],
  );
  if (!matchesTrainingMonotonicTrigger(trainingTriggers[0])) {
    invariants.push({
      table: 'easyfixer_watched_video',
      col: '<BEFORE UPDATE MONOTONIC TRIGGER>',
      impact: 'the legacy Java writer can lower training progress already advanced by an offline replay',
    });
  }

  for (const [table, note] of Object.entries(OPTIONAL)) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, table]
    );
    if (rows[0].n === 0) optionalMissing.push({ table, note });
  }

  return {
    ok: missing.length === 0 && invariants.length === 0,
    columnsChecked: totalChecked,
    indexesChecked: REQUIRED_INDEXES.length,
    invariantsChecked: 2,
    tablesChecked: Object.keys(EXPECTED).length,
    // Boot-blocking: the code's SQL names these, so they are runtime 500s.
    requiredMismatches: missing,
    // Degradations: warn on boot; block only under REQUIRE_SCHEMA_INVARIANTS.
    invariantMismatches: invariants,
    optionalMissing,
  };
}

/**
 * THE boot decision — the single source of truth for "will the server refuse to
 * start with this schema?". server.js and the deploy pipeline's --boot-check
 * BOTH call this, so the pre-swap gate can never drift from real boot behaviour.
 * If these two ever disagreed, the pipeline would wave through a release that
 * then crash-loops with no old container left to serve — the 2026-08-12 outage.
 *
 * Missing columns always block: the code's own SQL names them, so requests 500.
 * Missing hardening invariants block only under REQUIRE_SCHEMA_INVARIANTS=true;
 * otherwise every query still runs and behaviour merely degrades.
 */
function bootWouldFail(report, { strictInvariants } = {}) {
  const strict = strictInvariants === undefined
    ? String(process.env.REQUIRE_SCHEMA_INVARIANTS).toLowerCase() === 'true'
    : strictInvariants === true;
  return report.requiredMismatches.length > 0
    || (strict && report.invariantMismatches.length > 0);
}

/*
 * CLI mode: print report and exit. Closes the pool on the way out so
 * the script doesn't hang waiting on idle connections.
 *
 * Two exit policies:
 *   default        — STRICT. Any mismatch of either class exits 1. This is the
 *                    pre-merge / audit gate: the schema should be perfect.
 *   --boot-check   — Exits non-zero exactly when the SERVER WOULD REFUSE TO
 *                    BOOT (see server.js): missing columns always, missing
 *                    invariants only under REQUIRE_SCHEMA_INVARIANTS=true.
 *                    The deploy pipeline uses this so the gate is a faithful
 *                    prediction of "will the new container come up?" — it must
 *                    not block a deploy for a degradation the server tolerates,
 *                    or the pipeline reintroduces the very coupling that took
 *                    production down (an unshippable release while a hardening
 *                    migration waits on an audited Ops decision).
 */
async function cliMain() {
  const bootCheck = process.argv.includes('--boot-check');
  const report = await verifySchemaAgainstLiveDb();
  console.log(`\nChecked ${report.columnsChecked} columns, ${report.indexesChecked} required indexes, and ${report.invariantsChecked} schema invariants across ${report.tablesChecked} required tables`);
  if (report.ok) {
    console.log('✅ All required columns, indexes and invariants exist in production schema.');
  } else {
    const strictInvariants = String(process.env.REQUIRE_SCHEMA_INVARIANTS).toLowerCase() === 'true';
    if (report.requiredMismatches.length > 0) {
      console.log(`✗ ${report.requiredMismatches.length} BOOT-BLOCKING mismatches (missing columns/tables — the code's SQL names these):`);
      for (const m of report.requiredMismatches) {
        console.log(`  ${m.table}.${m.col || m.missing}`);
      }
    }
    if (report.invariantMismatches.length > 0) {
      const blocks = strictInvariants || !bootCheck;
      console.log(`${blocks ? '✗' : '⚠'} ${report.invariantMismatches.length} MISSING INVARIANTS (server still boots; behaviour degrades):`);
      for (const m of report.invariantMismatches) {
        console.log(`  ${m.table}.${m.col}${m.impact ? ` — ${m.impact}` : ''}`);
      }
      console.log('  → run the pending migrations in migrations/ to restore these.');
    }
    // --boot-check mirrors server.js exactly (same bootWouldFail call), so a
    // pass here means the new container WILL come up. Default (audit) mode
    // stays strict on both classes.
    const wouldFailBoot = bootWouldFail(report, { strictInvariants });
    process.exitCode = bootCheck ? (wouldFailBoot ? 1 : 0) : 1;
    if (bootCheck && !wouldFailBoot) {
      console.log('\n✅ Boot check PASSED — the server will start with this schema.');
    }
  }
  if (report.optionalMissing.length > 0) {
    console.log(`\nℹ ${report.optionalMissing.length} OPTIONAL tables missing (code handles gracefully):`);
    for (const m of report.optionalMissing) console.log(`  - ${m.table} — ${m.note}`);
  }
  await pool.end();
}

module.exports = {
  verifySchemaAgainstLiveDb,
  bootWouldFail,
  _internals: {
    // Exported so a test can build a faithful INFORMATION_SCHEMA stand-in
    // (every expected column present) and then take exactly one table away.
    EXPECTED,
    FAIL_SOFT_TABLES,
    ACTIVE_AADHAAR_GENERATED_COLUMN_SQL,
    canonicalSql,
    matchesActiveAadhaarGeneratedColumn,
    matchesTrainingMonotonicTrigger,
  },
};

// Run as CLI only when invoked directly (not when require()d from server.js)
if (require.main === module) {
  cliMain().catch((e) => { console.error('FAIL', e.message); process.exit(2); });
}
