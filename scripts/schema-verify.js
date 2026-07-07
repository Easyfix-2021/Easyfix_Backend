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
  training_videos: ['id', 'title', 'description', 'sub_title', 'sub_description'],
  tbl_easyfixer: [
    'efr_id', 'efr_name', 'efr_no', 'efr_status', 'efr_cityId',
    'current_balance', 'balance_updated',
    'adhaar_card_number', 'pan_card_number', 'have_driving_lisence',
    'is_technician_verified', 'is_email_verified', 'date_of_birth',
  ],
};

// Tables the code GRACEFULLY HANDLES being missing — we don't fail
// the verify run for these, just note them in the report.
const OPTIONAL = {
  tbl_ai_call_session: 'AI-calling test flow (Validate Flows) — needs migrations/2026-07-06-create-tbl-ai-call-session.sql; gated by ai.calling.enabled, code degrades when absent',
  pincode_decathlon: 'Decathlon variant returns null when missing (handled in integration.service.js)',
  product: 'Product CRUD requires migrations/2026-05-12-create-product-tables.sql to be run',
  product_code: 'Product CRUD requires migrations/2026-05-12-create-product-tables.sql to be run',
  product_additional_image: 'Product CRUD requires migrations/2026-05-12-create-product-tables.sql to be run',
};

/**
 * Returns { ok, requiredMismatches, optionalMissing, columnsChecked }.
 * Does NOT exit the process — caller decides what to do.
 */
async function verifySchemaAgainstLiveDb() {
  const dbName = process.env.DB_NAME;
  let totalChecked = 0, missingCount = 0;
  const missing = [];
  const optionalMissing = [];

  for (const [table, columns] of Object.entries(EXPECTED)) {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, table]
    );
    const actual = new Set(rows.map((r) => r.COLUMN_NAME));
    if (actual.size === 0) {
      missing.push({ table, missing: '<TABLE DOES NOT EXIST>' });
      missingCount += columns.length;
      continue;
    }
    for (const col of columns) {
      totalChecked++;
      if (!actual.has(col)) {
        missing.push({ table, col });
        missingCount++;
      }
    }
  }

  for (const [table, note] of Object.entries(OPTIONAL)) {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [dbName, table]
    );
    if (rows[0].n === 0) optionalMissing.push({ table, note });
  }

  return {
    ok: missing.length === 0,
    columnsChecked: totalChecked,
    tablesChecked: Object.keys(EXPECTED).length,
    requiredMismatches: missing,
    optionalMissing,
  };
}

// CLI mode: print report and exit. Closes the pool on the way out so
// the script doesn't hang waiting on idle connections.
async function cliMain() {
  const report = await verifySchemaAgainstLiveDb();
  console.log(`\nChecked ${report.columnsChecked} columns across ${report.tablesChecked} required tables`);
  if (report.ok) {
    console.log('✅ All required columns exist in production schema.');
  } else {
    console.log(`✗ ${report.requiredMismatches.length} required mismatches:`);
    for (const m of report.requiredMismatches) {
      console.log(`  ${m.table}.${m.col || m.missing}`);
    }
    process.exitCode = 1;
  }
  if (report.optionalMissing.length > 0) {
    console.log(`\nℹ ${report.optionalMissing.length} OPTIONAL tables missing (code handles gracefully):`);
    for (const m of report.optionalMissing) console.log(`  - ${m.table} — ${m.note}`);
  }
  await pool.end();
}

module.exports = { verifySchemaAgainstLiveDb };

// Run as CLI only when invoked directly (not when require()d from server.js)
if (require.main === module) {
  cliMain().catch((e) => { console.error('FAIL', e.message); process.exit(2); });
}
