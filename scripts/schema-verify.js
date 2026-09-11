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
    /*
     * Added 2026-09-07 by verifyExpectedIsComplete(): every one of these is
     * named by the code's own SQL and was missing from this list, so the loop
     * below never looked at it. Each was confirmed against the live
     * INFORMATION_SCHEMA before being added — the whole point of this map is
     * that a name here which does NOT exist turns the boot gate red for the
     * wrong reason.
     *
     * Magic link (routes/admin/job-magic-link.js,
     * services/job-magic-link.service.js, services/job-magic-link-cron.js).
     * The exact set named in verifyExpectedIsComplete's own worked example.
     */
    'magic_link_sent_at', 'magic_link_send_count', 'magic_link_last_action',
    'customer_submitted_at', 'customer_submitted_payload',
    /*
     * Client-dashboard job list + the Unreachable / Enquiry outcome pair
     * (routes/client/index.js, services/enquiry-notification.service.js).
     * `call_later` is probe-gated on the WRITE side (job.service.js
     * hasCallLaterColumn, job-comment.service.js hasJobColumn) and named by an
     * unguarded SELECT on the READ side (quicksight-admin-dashboard.service.js
     * line 560, routes/client/index.js) — so it is NOT optional: losing it
     * still 500s the admin dashboard report. Listed strictly, exactly as
     * training_videos.is_global and courses.is_mandatory are.
     */
    'ticket_created_date_time', 'enquiry_date_time', 'call_later',
    'sub_job_id', 'ready_for_billing', 'enquiry_reason_id',
    // The Jobs export's audit columns (services/job-export.service.js). Every
    // one is a literal in that SELECT, so a rename empties a column of the
    // operator-facing XLSX with no error anywhere.
    'remarks_date_time', 'enum_reason_id',
    'fk_scheduled_by', 'fk_checkout_by', 'first_scheduled_by',
    // Technician app job lifecycle — check-in OTP, questionnaire binding,
    // cash collection and the revisit triple (services/mobile-job-lifecycle
    // .service.js, services/mobile-phe.service.js). These gate check-out, so a
    // gap is a technician who cannot close a job.
    'otp', 'fk_questionaire_id', 'problem_reason_id',
    'is_collected_cash_by_app', 'material_charge', 'collect_cash_reason_id',
    'revisit_reason_id', 'revisit_date', 'revisit_time_slot',
    'app_checkout_date_time', 'visit_number',
    // QuickSight report columns (services/quicksight/*.service.js) + the
    // webhook reschedule reason (services/webhook.service.js). Same story as
    // the Supply Gap incident recorded on tbl_user below: a report reads these
    // by name and 500s on every environment the moment one moves.
    'original_scheduling_date_time', 'billing_checkout_date_time',
    'custom_property', 'reschedule_reason_id',
    /*
     * The technician-app REQUEST model (2026-09-10 — see THE REQUEST MODEL in
     * services/mobile-job-lifecycle.service.js). The cancel/reschedule request
     * writes name every one of these with NO column probe, deliberately: they
     * are long-standing production columns and a probe would turn a genuinely
     * broken deploy into a request that silently records nothing. Listing them
     * here is what makes that safe — a missing column fails the boot gate
     * instead of dropping a technician's ask on the floor at runtime.
     *
     * job_vertical_manager is the job's Project Manager snapshot (int FK →
     * tbl_user), the recipient of the reschedule-request WhatsApp. It is the
     * one this list was actually missing; verifyExpectedIsComplete found it.
     */
    'is_cancelled_by_app', 'is_rescheduled_by_app',
    'job_cancel_reason_id_by_easyfixer', 'reschedule_date_time_app',
    'reschedule_remarks', 'reschedule_at_app', 'resch_job_count',
    'job_vertical_manager',
  ],
  tbl_job_services: [
    'job_service_id', 'job_id', 'service_id', 'service_type_id', 'service_category_id',
    'quantity', 'total_charge', 'material_charge', 'easyfix_charge',
    'easyfixer_charge', 'client_charge', 'job_charge_type',
    'service_charge_description', 'job_service_status',
    // The two-stage charge approval (services/job-charges.service.js) and the
    // Material report's line total (quicksight-material-report.service.js).
    'approval_by_client', 'is_approved_by_pm', 'total_cost',
  ],
  tbl_job_comment: [
    'comment_id', 'job_id', 'comments', 'comment_on', 'created_on',
    'appointment_on', 'commented_by', 'enum_reason_id', 'efr_id',
    // The escalation author's NAME, as text (escalation writers leave
    // commented_by NULL) — listComments' legacy "Remark By" falls back to it.
    'job_escalated_by',
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
  // city / pin_code / is_personal_detail_filled feed the Supply Gap report's
  // self-registration funnel (services/quicksight/quicksight-supply-gap.service
  // .js). They were absent from this list, and the query that reads them named
  // them on tbl_easyfixer instead — which 500'd the report on EVERY environment
  // with "Unknown column 'city' in 'field list'". Listing them is what makes
  // the next such rename fail the boot check rather than one report.
  tbl_user: [
    'user_id', 'user_name', 'official_email', 'mobile_no', 'alternate_no',
    'user_role', 'user_type_id', 'city_id', 'user_status',
    'manage_clients', 'manage_cities', 'manage_states', 'manage_verticals',
    'reporting_manager',
    'city', 'pin_code', 'is_personal_detail_filled',
    'insert_date', 'update_date', 'updated_by',
    // Added 2026-09-07. Same family as city / pin_code above and the same
    // hazard: `personal_details_filled` and `is_personal_detail_filled` are two
    // DIFFERENT live columns (singular vs plural, one prefixed `is_`), read
    // side by side in services/candidate-ranking.service.js's pre-lifecycle
    // derivation. A rename of either is silent until the funnel reads wrong.
    'user_code', 'personal_details_filled', 'state', 'district', 'is_released',
  ],
  // vertical_desc + the four audit columns are written by the Manage Verticals
  // CRUD (routes/admin/verticals.js); only the three-column read was listed.
  tbl_vertical: [
    'vertical_id', 'vertical_name', 'status',
    'vertical_desc', 'inserted_on', 'inserted_by', 'updated_on', 'updated_by',
  ],
  confirmation_token: [
    'id', 'token', 'login_id', 'is_verified', 'client_id', 'easyfixer_id', 'is_token_expired',
  ],
  // city_name is denormalised onto the mapping row and selected directly by
  // services/auto-assign.service.js, rather than joined from
  // firefox_city_mapping — so it is a real dependency, not a duplicate.
  pincode_firefox_city_mapping: ['id', 'pincode', 'firefox_city_id', 'city_name'],
  firefox_city_mapping: ['id', 'city_name', 'city_id', 'no_of_slot'],
  // training_video_id is the FK into `document` that resolves a video's
  // playable URL; services/lms.service.js both reads it and writes it
  // (SET training_video_id = NULL / = ?), so it belongs here like any other
  // column the code's own SQL names.
  //
  // is_global is listed even though services/lms.service.js now PROBES it
  // (2026-08-26-lms-mandatory-flags.sql). The probe stops a missing column
  // 500ing a request; it does not make the column optional. Listing it here is
  // what makes the gap visible at boot instead of as a silently empty
  // mandatory set that nobody goes looking for.
  training_videos: [
    'id', 'title', 'description', 'sub_title', 'sub_description',
    'training_video_id', 'is_global',
  ],
  // ─── LMS (services/lms.service.js) ──────────────────────────────────────
  // `courses` and `easyfixer_courses` pre-date the LMS work; only
  // courses.status is new (migrations/executed/2026-08-13-lms-foundation.sql).
  // Both are read on the LMS list/detail/report paths, so a missing column
  // here is a 500 on first request, not a degraded behaviour.
  // is_mandatory: same migration, same reasoning as training_videos.is_global.
  // Its absence from this list on 2026-08-26 is why the course list shipped
  // ahead of its migration and 500'd rather than failing the boot check.
  // reward_points / certificate_enabled: 2026-09-01-course-completion-rewards.
  // Listed STRICTLY, not probed. A wrong "absent" on is_mandatory silently
  // disables mandatory training platform-wide, which is why that one is probed;
  // a missing reward_points is a loud 500 the pre-swap boot gate catches before
  // traffic moves, and silently paying nobody is the worse failure.
  courses: [
    'id', 'name', 'description', 'status', 'created_at', 'updated_at', 'is_mandatory',
    'reward_points', 'certificate_enabled',
  ],
  // badge_earned_at: 2026-09-01-course-completion-rewards. The EARNED stamp —
  // a badge/certificate entitlement, recorded so a later course edit cannot
  // revoke one. Strict, like its two siblings on `courses`.
  // completion_date / due_date: the assignment's own dates, read by
  // routes/admin/lms-action.js and services/lms.service.js. Older than
  // badge_earned_at and simply never listed. Strict, like its siblings.
  easyfixer_courses: [
    'id', 'easyfixer_id', 'course_id', 'score', 'created_at', 'updated_at',
    'badge_earned_at', 'completion_date', 'due_date',
  ],
  /*
   * Course CONTENT (2026-08-26-lms-content-types-and-assessments.sql). These
   * replaced course_videos, which is no longer read anywhere and is therefore
   * no longer listed — the migration keeps the table as a rollback surface,
   * not as something the code depends on.
   *
   * These belong under the STRICT rule, not the fail-soft one, and the reason
   * is worth stating: lms_content is what isTrainingComplete,
   * mandatoryVideoIdsSql() and both completion stamps now read, and those
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
  // image_key: 2026-09-01-lms-question-image. S3 key, NULL for a text question.
  lms_question: ['id', 'assessment_id', 'question_text', 'sequence', 'status', 'image_key'],
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
    // The CRM-review pair the Supply Gap funnel judges on (null / 1 / 2).
    // `personal_detail_filled_verified_by_crm` -- the name the report used --
    // exists in no table at all; this is the real one.
    'is_personal_details_verified_by_crm', 'is_identity_details_verified_by_crm',
    /*
     * Added 2026-09-07. This table held 42 of the 91 columns the code named and
     * this list did not — by far the largest blind spot, because everything
     * above was added one incident at a time and nobody ever swept it. All 42
     * confirmed present in the live INFORMATION_SCHEMA before listing.
     *
     * Identity + contact, read on nearly every technician-facing surface
     * (routes/admin/calls.js, routes/admin/validate.js, routes/mobile/rewards
     * .js, services/easyfixer-profile-update-link.service.js).
     */
    'efr_first_name', 'efr_last_name', 'efr_email', 'efr_alt_no',
    'efr_address', 'efr_address_res', 'efr_pin_no',
    'efr_marital_status', 'efr_children', 'about_yourself', 'about_yourself2',
    'efr_profile_img', 'efr_profile_perc',
    // The four per-section completion percentages beside efr_profile_perc.
    // routes/mobile/index.js reads all five in one SELECT and writes them
    // back with COALESCE; only the aggregate was ever listed, so the four
    // that drive the onboarding checklist were unguarded. Each confirmed
    // present on tbl_easyfixer (float) before being added.
    'efr_personal_details_perc', 'efr_professional_details_perc',
    'efr_bank_details_perc', 'efr_identity_details_perc',
    'user_id', 'experience_id', 'updated_by',
    'insert_date', 'update_date',
    // Assignment + ranking inputs (services/auto-assign.service.js,
    // services/candidate-ranking.service.js). A gap here does not 500 loudly —
    // it silently changes who gets offered the job.
    'efr_zone_city_id', 'efr_service_category', 'efr_service_type',
    'efr_manager_id', 'skill_rating', 'tool_rating',
    'inactive_comment', 'inactive_reason', 'send_back_to_tx_reason_crm',
    'last_inactive_date_time', 'profile_activation_date_time',
    'scheduled_reactivation_date',
    /*
     * The v5.1 technician lifecycle (services/easyfixer-lifecycle.service.js +
     * its two crons). These are the closest thing in this batch to a genuinely
     * OPTIONAL column — easyfixer-lifecycle.service.js probes the schema
     * (hasLifecycleSchema) and readProjection() substitutes NULL literals when
     * it is absent. They are still listed STRICTLY, for the reason already
     * recorded for training_videos.is_global: the probe stops a 500, it does
     * not make the column optional. And the tolerance is not even complete —
     * services/withdrawal.service.js line 47, services/lms-action.service.js
     * line 253, services/easyfixer-work-eligibility.service.js line 26 and
     * services/easyfixer-reactivation-cron.js line 49 all name lifecycle_status
     * in unguarded SQL, so losing it 500s withdrawals and the LMS action list
     * whatever the probe says.
     */
    'lifecycle_status', 'lifecycle_changed_at', 'lifecycle_reason_code',
    'lifecycle_reason', 'lifecycle_version', 'lifecycle_source',
    // Profile-save OTP gate (services/easyfixer-profile-otp.service.js) and the
    // profile-update magic link's send audit
    // (services/easyfixer-profile-update-link.service.js).
    'profile_update_otp', 'profile_update_otp_valid_up_to',
    'profile_update_sent_at', 'profile_update_send_count',
    // Insurance flags shown on the technician's own profile screen
    // (services/mobile-profile-extra.service.js). BIT(1) — see SCHEMA.md.
    'health_insurance', 'accidental_insurance',
  ],
  tbl_idempotency_key: [
    'actor_type', 'actor_id', 'idempotency_key', 'method', 'path',
    'request_fingerprint', 'state', 'lease_token', 'lease_expires_at',
    'response_status', 'response_json', 'created_at', 'completed_at', 'expires_at',
  ],
  easyfixer_watched_video: [
    'id', 'easyfixer_id', 'video_id', 'watched_percentage', 'update_date',
  ],
  /*
   * The technician's Ratings screen. Its PK is `table_id`, NOT `id` — the query
   * in services/mobile-profile-extra.service.js named `id`, threw
   * ER_BAD_FIELD_ERROR on every call, and the catch around it swallowed that
   * and returned an empty list. Every technician saw zero ratings, permanently,
   * with one warn line and no error. Listed here so the next rename fails the
   * boot check instead of going quiet for months.
   */
  tbl_easyfixer_rating_by_customer: [
    'table_id', 'easyfixer_id', 'job_id', 'customer_rating', 'comment',
    'review_comment', 'is_escalated', 'insert_date_time',
    // The escalation's WHO and WHEN — is_escalated was listed, the pair that
    // records it was not (routes/admin/jobs.js writes them,
    // services/job-export.service.js reads escalated_time).
    'escalated_by', 'escalated_time',
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

/*
 * Directories that hold no SQL that ever runs in production. Everything else
 * under the repo root is walked, which is the point: this is an EXCLUDE list,
 * not an include list. An include list is one more hand-maintained record — a
 * new directory holding SQL would silently fall outside it and the scan would
 * come back clean on a file it never opened. An exclude list fails towards MORE
 * coverage instead: a new directory is scanned until somebody deliberately
 * names it here.
 *
 * `scripts/` is excluded because this file lives in it — EXPECTED itself is a
 * pile of column names and scanning it would report every entry as its own
 * justification. `tests/` because fixtures deliberately name columns that do
 * not exist, and `migrations/` because a DDL file names the column it is adding.
 */
const NON_RUNTIME_DIRS = new Set([
  'node_modules', 'tests', 'scripts', 'migrations', 'docs', 'deploy', 'uploads',
  'coverage', 'stt-service',
]);

function runtimeSourceFiles() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || NON_RUNTIME_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(root);
  return out.map((f) => ({ rel: path.relative(root, f), src: fs.readFileSync(f, 'utf8') }));
}

/**
 * Is EXPECTED itself complete? Needs no database — this compares the list
 * against the SOURCE, not against the schema.
 *
 * WHY THIS EXISTS. EXPECTED is a RECORD: a hand-maintained map somebody updates
 * when they remember to. verifySchemaAgainstLiveDb() below loops it, and that
 * makes the loop self-referential — it can only ask "is everything I wrote down
 * still in the database". A column the code reads and writes but nobody wrote
 * down here is not reported as unchecked; it is not reported at all. Mutations
 * of a listed column are caught, ADDITIONS are invisible, and the pass line
 * counts the record so it cannot disagree with the loop that produced it.
 *
 * That is not hypothetical. tbl_job grew `magic_link_sent_at`; three files
 * (services/whatsapp-conversation.service.js, services/job.service.js,
 * services/job-magic-link-cron.js) read and write it; this file did not mention
 * it. The boot gate was passing while blind to a live column — so a deploy that
 * renamed it would have sailed through and 500'd the magic-link flow in
 * production, which is precisely the 2026-08-27 shape verify-phantom-columns.js
 * was written for.
 *
 * The CONTRACT is the set of columns the codebase's own SQL names on the tables
 * EXPECTED claims to guard. That set is derived, not written down, so it grows
 * on its own when a query does. This iterates it and treats "named by the code,
 * absent from EXPECTED" as a failure.
 *
 * The extraction is scripts/verify-phantom-columns.js's, deliberately reused
 * rather than reimplemented: one parser means the two gates can never disagree
 * about which columns the code names, and that parser already carries two
 * incidents' worth of hard-won rules (NOT_AN_ALIAS, derived aliases, blanked
 * interpolations). Required lazily so neither it nor a repo-wide file walk ever
 * enters server.js's boot path.
 */
function verifyExpectedIsComplete() {
  const { scanFile } = require('./verify-phantom-columns');

  /*
   * scanFile reports columns MISSING from the map it is handed, so handing it
   * empty sets turns it into an enumerator: every column the SQL names on an
   * EXPECTED table comes back as a hit.
   *
   * The js-fragment pass is dropped. It resolves aliases against a FILE-wide
   * map, which is safe in verify-phantom-columns because there the map holds
   * every live table — an alias bound to several tables only counts when the
   * column is missing from all of them. Here the map holds ~35 tables, so an
   * alias meaning tbl_reward_claim in one query and `courses` in another
   * resolves to the only member it knows and invents the finding. Measured:
   * 124 of 215 hits were that artefact. The alias and bare passes resolve per
   * QUERY and do not have the problem.
   */
  const blank = new Map(Object.keys(EXPECTED).map((t) => [t.toLowerCase(), new Set()]));
  const referenced = new Map();
  const files = runtimeSourceFiles();
  for (const { rel, src } of files) {
    for (const hit of scanFile(rel, src, blank)) {
      if (hit.kind === 'js-fragment') continue;
      if (!referenced.has(hit.table)) referenced.set(hit.table, new Map());
      const cols = referenced.get(hit.table);
      if (!cols.has(hit.col.toLowerCase())) cols.set(hit.col.toLowerCase(), rel);
    }
  }

  // ── The contract, iterated ──────────────────────────────────────────────
  // `referenced` is the CONTRACT (what the code's SQL names); EXPECTED is the
  // RECORD (what somebody listed). Looping the contract is what makes an
  // unlisted column visible at all — looping EXPECTED, as every other check in
  // this file does, can only ever revisit entries that already exist.
  const unlisted = [];
  let contractColumns = 0;
  for (const [table, used] of referenced) {
    const listed = new Set((EXPECTED[table] || []).map((c) => c.toLowerCase()));
    contractColumns += used.size;
    for (const [col, rel] of used) if (!listed.has(col)) unlisted.push({ table, col, rel });
  }

  // ── The reverse direction, reported separately ──────────────────────────
  // A listed column no literal SELECT names is a different animal from an
  // unlisted one and must not share its message: it is at worst dead weight,
  // never a blind spot. It is also weak evidence — this scan reads SELECT lists
  // and alias references, so a column only ever written by an INSERT (every
  // tbl_idempotency_key column, most of tbl_job_logs) looks unreferenced while
  // being entirely live. Counted, never failed on, never used to delete.
  const unreferenced = [];
  let listedColumns = 0;
  for (const [table, columns] of Object.entries(EXPECTED)) {
    const used = referenced.get(table.toLowerCase()) || new Map();
    listedColumns += columns.length;
    for (const col of columns) if (!used.has(col.toLowerCase())) unreferenced.push(`${table}.${col}`);
  }

  return { unlisted, unreferenced, contractColumns, listedColumns, filesScanned: files.length };
}

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
 *
 * EXPECTED's own completeness runs FIRST, and under the default policy only.
 * First because it needs no database, so it still reports on a host that cannot
 * reach one. Default-only because an unlisted column is a hole in THIS GATE,
 * not a runtime fault: the column exists, every query runs, and the container
 * comes up — so failing --boot-check on it would break the one promise that
 * mode makes (a faithful prediction of "will the new container start?") for the
 * same reason the hardening invariants above are not boot-blocking.
 */
async function cliMain() {
  const bootCheck = process.argv.includes('--boot-check');

  const completeness = verifyExpectedIsComplete();
  console.log(`\nScanned ${completeness.filesScanned} runtime source files: the code's SQL names ${completeness.contractColumns} columns on the ${Object.keys(EXPECTED).length} required tables; EXPECTED lists ${completeness.listedColumns}`);
  if (completeness.unlisted.length > 0) {
    // Not "N mismatches" — these columns are FINE in the database. What is
    // broken is that the check below never looks at them.
    console.log(`✗ ${completeness.unlisted.length} column(s) the code READS OR WRITES that EXPECTED does not list — unguarded: a rename or a dropped column here passes every check in this file:`);
    for (const u of completeness.unlisted) console.log(`  ${u.table}.${u.col}  (first seen in ${u.rel})`);
    console.log('  → add each to EXPECTED above, or move its table to OPTIONAL if the code truly tolerates it being absent.');
    if (!bootCheck) process.exitCode = 1;
  }
  if (completeness.unreferenced.length > 0) {
    console.log(`ℹ ${completeness.unreferenced.length} listed column(s) matched by no literal SELECT — most are INSERT-only or built in an interpolated fragment this scan cannot read, so verify by hand before removing any.`);
  }

  const report = await verifySchemaAgainstLiveDb();
  console.log(`\nChecked ${report.columnsChecked} columns, ${report.indexesChecked} required indexes, and ${report.invariantsChecked} schema invariants across ${report.tablesChecked} required tables`);
  if (report.ok) {
    // Scoped deliberately to "the listed ones". A green tick here while the
    // completeness pass above is red would read as an overall pass and bury it.
    console.log(`✅ All ${completeness.unlisted.length > 0 ? 'LISTED ' : ''}columns, indexes and invariants exist in production schema.`);
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
  // Needs no database, so a test can assert the gate's own completeness without
  // one — and a caller wanting the full unreferenced list can read it here
  // rather than from the CLI's deliberately count-only line.
  verifyExpectedIsComplete,
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
