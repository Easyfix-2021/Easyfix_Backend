const { pool } = require('../db');
const logger = require('../logger');
const coverage = require('./pincode-coverage.service');

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * TAT ENGINE — implements EasyFix_TAT_Final_August2026.xlsx, "Developer
 * Specification v1.0" (sheet: Developer Instructions).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the ONE place TAT is computed. Nothing else may re-derive it.
 * (The older day-based `tat_count` metrics in the QuickSight reports, the job
 * export and the client portal are a SEPARATE, pre-existing definition and are
 * deliberately untouched. This engine does not replace them yet.)
 *
 * ── The model (spec §1) ────────────────────────────────────────────────────
 *
 * TAT is measured at JOB level. Every job gets a YES / NO / N/A / Pending flag
 * per segment. There is no single pass/fail and no running total — the four
 * clocks are independent, each anchored on its own pair of events.
 *
 *   Seg 1 · Visit       ticket created  → app check-in       EASYFIX OWNED
 *   Seg 2 · Estimate    app check-in    → estimate sent      EASYFIX OWNED
 *   Seg 3 · Approval    estimate sent   → client decided     ⚠ CLIENT OWNED
 *   Seg 4 · Completion  approval (else check-in) → checkout  EASYFIX OWNED
 *
 * OWNERSHIP IS THE POINT. Seg3 is the client's clock. It is scored separately
 * and NEVER folded into the EasyFix score, so EasyFix is not penalised for a
 * client sitting on an approval. Two scores ship on every result:
 *
 *   EF Score      met/total across Seg1, Seg2, Seg4   → "2/3"
 *   Client Score  Seg3 alone                          → "1/1" | "0/1"
 *
 * ── Targets (spec §3 STEP 1) ───────────────────────────────────────────────
 *
 * Seg1 is the ONLY target that varies, and it varies by LOCALITY:
 *   LOCAL  → 24h    at least one active technician covers the job's pincode
 *   TRAVEL → 48h    nobody covers it, so somebody has to travel
 * Seg2 = 24h, Seg3 = 24h, Seg4 = 48h, regardless of job type.
 *
 * "Covers the pincode" means the technician's CURRENT pincode
 * (`tbl_easyfixer.efr_pin_no`) equals the job's, OR the job's pincode appears
 * in their serviceable list (`tbl_efr_serviceable_pincodes.pincodes`, a CSV
 * matched with FIND_IN_SET after stripping spaces — the same predicate
 * candidate-ranking uses, so "local" here means the same thing it means to the
 * allocation engine).
 *
 * NOTE this supersedes BOTH earlier designs: the first assumed LOCAL because
 * locality was not stored, and the second read `tbl_city.tier` per the
 * workbook. Tier turned out to be unusable — 86 of 680 city rows have no tier
 * at all, and inspecting them shows why: they are states ("Rajasthan",
 * "Kerala"), divisions ("Konkan Division") and villages, not cities. Supply
 * coverage answers the real question ("does somebody have to travel?")
 * directly, rather than through a proxy that is 13% unpopulated.
 *
 * ⚠ LOCALITY IS COMPUTED LIVE, NOT SNAPSHOTTED. Onboarding a technician into a
 * pincode flips its jobs from TRAVEL to LOCAL — including historical ones,
 * retroactively tightening their Visit target from 48h to 24h. That is a real
 * property of this rule, not a bug in it, and it is disclosed in the UI.
 * Snapshotting `tat_locality` at booking is the fix when it matters.
 *
 * ── Applicability (spec §3 STEPS 3-4) ──────────────────────────────────────
 *
 * `is_estimate_sent` gates Seg2 AND Seg3. No estimate → both are N/A, and the
 * job is scored on Seg1 + Seg4 alone. Material is NOT a classifier — the
 * earlier A/B/C/D scenario matrix is gone, replaced by this single flag.
 *
 * ── Honest limits ──────────────────────────────────────────────────────────
 *
 * 1. SEG 1 IS THIN ON HISTORY. `checkin_date_time` is now written write-once by
 *    routes/mobile/index.js, but only from 2026-08-19 — every job worked before
 *    that was stamped solely by the legacy Java mobile API, and anything worked
 *    through the new app in between has no anchor at all. Those segments report
 *    `Pending`, which is EXCLUDED from every denominator rather than silently
 *    scored. We do not substitute another timestamp: a fabricated anchor
 *    produces a confident wrong number instead of an honest gap.
 *
 * 2. `is_estimate_sent` IS INFERRED, not read. The spec asks for a real
 *    BOOLEAN column. Today we infer it from `approval_sent_on_date_time`
 *    (which is also `estimate_sent_on` — one event, one column) or the
 *    `no_of_req_approval` counter. Both are stamped in the same UPDATE by both
 *    send-for-approval writers, and job-export.service.js documents the
 *    timestamp as legacy's own definition of "was an estimate ever shared".
 *
 * 3. STOP CLOCK IS NOT IMPLEMENTED. Spec §5 deducts paused hours from Seg4
 *    (material wait / OEM part / entry permission). No such columns exist, so
 *    `stopHours` is always 0 and Seg4 is reported GROSS. Every result carries
 *    `stopClockAvailable: false` so a consumer cannot mistake gross for net.
 *
 * 4. ONLY COMPLETED JOBS ARE ROLLED UP — `job_status IN (3,5)`. In-progress
 *    work has open clocks. (The spec keeps Pending jobs visible in a Pending
 *    column; that is a reporting choice for later, not this preview.)
 */

// ─── Targets (spec §3 STEP 1) ────────────────────────────────────────
const SEG1_TARGET_LOCAL = 24;
const SEG1_TARGET_TRAVEL = 48;
const SEG2_TARGET = 24;
const SEG3_TARGET = 24;
const SEG4_TARGET = 48;


// Spec §4: max client wait before auto-escalation. Reported, not enforced here.
const SEG3_ESCALATION_HOURS = 48;

const OWNER = Object.freeze({ EASYFIX: 'EasyFix', CLIENT: 'Client' });

const SEGMENTS = Object.freeze([
  {
    no: 1, key: 'visit', label: 'Visit', owner: OWNER.EASYFIX,
    startLabel: 'Ticket Created', endLabel: 'App Check-In',
  },
  {
    no: 2, key: 'estimate', label: 'Estimate', owner: OWNER.EASYFIX,
    startLabel: 'App Check-In', endLabel: 'Estimate Sent',
  },
  {
    no: 3, key: 'approval', label: 'Approval', owner: OWNER.CLIENT,
    startLabel: 'Estimate Sent', endLabel: 'Client Decided',
  },
  {
    no: 4, key: 'completion', label: 'Completion', owner: OWNER.EASYFIX,
    startLabel: 'Approval (Else Check-In)', endLabel: 'App Checkout',
  },
]);

// Spec vocabulary, used verbatim so the code reads like the document.
// Pending = we cannot evaluate yet (missing anchor). N/A = does not apply.
// NEITHER is a pass, and both are excluded from every denominator.
const STATUS = Object.freeze({
  YES: 'YES', NO: 'NO', NA: 'N/A', PENDING: 'Pending',
});

// Spec §3 STEP 8.
const LABEL = Object.freeze({
  EXCELLENT: 'Excellent', GOOD: 'Good', PARTIAL: 'Partial',
  POOR: 'Poor', PENDING: 'Pending',
});

const COMPLETED_STATUSES = [3, 5];
const MAX_ROWS = 5000;
const CLIENT_LOOKBACK_DAYS = 90;

const STOP_CLOCK_AVAILABLE = true;

/*
 * Spec §5 stop triggers — a FROZEN set, not an ops-editable dropdown.
 *
 * The spec names exactly three, each with a fixed owner, so they live here as
 * constants and are stored on tbl_job_tat_stop.reason_code. There is
 * deliberately no action_taken_reason seed: that table's `action_type` is a
 * bare INTEGER bucket, allocating a free one needs a live SELECT, and
 * services/reason-codes.js warns against resolving a bucket by the legacy
 * action_type.type STRING because it drifts. `reason_id` on the ledger is a
 * nullable hook for the day ops does want an editable list.
 *
 * `owner` is the DEFAULT for each trigger, not a constraint — an entry-permission
 * delay is usually the client's, but a rescheduled site visit we failed to book
 * is ours. The writer picks; this is what it should pre-select.
 */
const STOP_REASONS = Object.freeze([
  { code: 'MATERIAL', label: 'Material / Part Unavailable', owner: 'OEM/Vendor' },
  { code: 'OEM_PART', label: 'OEM Part Required', owner: 'OEM/Vendor' },
  { code: 'ENTRY_PERMISSION', label: 'Entry Permission Pending', owner: 'Client' },
]);

const STOP_OWNERS = Object.freeze(['EasyFix', 'Client', 'OEM/Vendor']);

/*
 * LOCAL when at least one active technician covers the job's pincode.
 *
 * `is_local_pincode` is stamped onto the row by resolveLocality() before this
 * runs — a batch lookup rather than a correlated subquery, so a 5000-job
 * technician history costs ONE extra query instead of 5000 nested scans.
 *
 * A job with NO pincode at all cannot be shown to be covered, so it is TRAVEL:
 * the more forgiving 48h target. Guessing LOCAL would invent a breach out of
 * missing address data.
 */
function resolveJobType(row) {
  return Number(row && row.is_local_pincode) === 1 ? 'Local' : 'Travel';
}

/*
 * Resolve Local/Travel for a page of rows.
 *
 * The FROZEN snapshot (tbl_job_tat_locality, written at job creation) wins
 * whenever it exists — that is the whole point of freezing it. Jobs created
 * before the snapshot shipped have no row and fall back to LIVE coverage, which
 * is flagged per job (`localitySnapshotted`) so a report can disclose which
 * half it is reading rather than quietly mixing two semantics.
 */
async function stampLocality(rows) {
  const ids = rows.map((r) => r.job_id).filter(Boolean);
  const snap = new Map();
  if (ids.length) {
    try {
      const [snapRows] = await pool.query(
        `SELECT job_id, is_local FROM tbl_job_tat_locality
          WHERE job_id IN (${ids.map(() => '?').join(',')})`,
        ids,
      );
      for (const r of snapRows) snap.set(r.job_id, Number(r.is_local));
    } catch (e) {
      logger.warn('TAT locality snapshot unavailable — classifying live · ' + e.message);
    }
  }

  const needLive = rows.filter((r) => !snap.has(r.job_id));
  const covered = needLive.length
    ? await coverage.getCoveredPincodes(needLive.map((r) => r.job_pincode))
    : new Set();

  for (const r of rows) {
    if (snap.has(r.job_id)) {
      r.is_local_pincode = snap.get(r.job_id);
      r.locality_snapshotted = true;
    } else {
      r.is_local_pincode = r.job_pincode && covered.has(String(r.job_pincode)) ? 1 : 0;
      r.locality_snapshotted = false;
    }
  }
  return rows;
}

function seg1Target(jobType) {
  return jobType === 'Travel' ? SEG1_TARGET_TRAVEL : SEG1_TARGET_LOCAL;
}

/*
 * Spec §2 `is_estimate_sent`. Inferred — see limit (2). When the real BOOLEAN
 * column lands this becomes `return Number(row.is_estimate_sent) === 1;` and
 * nothing else changes.
 */
function isEstimateSent(row) {
  return row.approval_sent_on_date_time != null || Number(row.no_of_req_approval || 0) > 0;
}

/*
 * Spec §5. Hours to DEDUCT from Segment 4 for pauses that overlap its window.
 *
 * Only the OVERLAP counts: a stop that opened before the Seg4 clock started, or
 * ran past checkout, must not deduct time the clock was not running for —
 * otherwise net could go below zero and a genuinely slow job would score YES.
 * An OPEN stop (no end) is clamped to the segment end.
 *
 * Stops arrive pre-attached as `row.stops` by attachStops(); a row with none
 * deducts nothing, so this stays correct before the ledger has any data.
 */
function stopClockHours(row, segStartMs, segEndMs) {
  const stops = (row && row.stops) || [];
  if (!stops.length || segStartMs == null || segEndMs == null) return 0;
  let ms = 0;
  for (const st of stops) {
    const a = toMs(st.stop_start);
    const b = toMs(st.stop_end) ?? segEndMs;   // still paused → clamp to checkout
    if (a == null) continue;
    const from = Math.max(a, segStartMs);
    const to = Math.min(b, segEndMs);
    if (to > from) ms += to - from;
  }
  return Number((ms / 3600000).toFixed(1));
}

/*
 * Batch-load the stop ledger for the rows in scope and attach it. One query
 * regardless of job count — the same shape as the locality batch, for the same
 * reason. Fails SOFT: the ledger is a new EasyFix-owned table, and a report
 * must not 500 on an environment where the migration has not run yet.
 */
async function attachStops(rows) {
  const ids = rows.map((r) => r.job_id).filter(Boolean);
  if (!ids.length) return rows;
  try {
    const [stops] = await pool.query(
      `SELECT job_id, stop_start, stop_end, reason_code, stop_owned_by
         FROM tbl_job_tat_stop
        WHERE job_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byJob = new Map();
    for (const st of stops) {
      if (!byJob.has(st.job_id)) byJob.set(st.job_id, []);
      byJob.get(st.job_id).push(st);
    }
    for (const r of rows) r.stops = byJob.get(r.job_id) || [];
  } catch (e) {
    logger.warn('TAT stop ledger unavailable — Segment 4 reported GROSS · ' + e.message);
    for (const r of rows) r.stops = [];
  }
  return rows;
}

/*
 * DECOMPOSITION — what a Segment 1 breach is actually made of.
 *
 * Seg1 measures ticket-created → check-in. Both endpoints are server clocks, but
 * the interval BETWEEN them is not all ours:
 *
 *   ticket created ──[ we schedule ]──[ the wait the customer ASKED for ]──[ we arrive ]──> check-in
 *
 * A Monday booking for a Thursday slot reads ~72h however well we performed. So
 * a 50h average and a sub-50% pass rate are unactionable on their own — you
 * cannot tell whether we were slow or the customer simply chose a later date.
 *
 * These two figures split it:
 *   bookingLeadHours   ticket created → the appointment.  PURELY the customer's
 *                      choice. Not a target, not scored — context.
 *   punctualityHours   appointment → check-in. OURS. Negative = arrived early.
 *                      This is the same comparison SDA/OTA already make.
 *
 * ⚠ MIDNIGHT SENTINEL. Date-only bookings (website / QR flow) store the
 * appointment as 'YYYY-MM-DD 00:00:00' with the real hour in `requested_time`.
 * Comparing check-in against midnight would score every such job as late by the
 * whole working day, so a sentinel appointment yields NULL rather than a number
 * invented out of a placeholder.
 *
 * original_appointment_date_time is preferred over requested_date_time: it is
 * the FIRST promise, frozen at creation and deliberately not moved by a
 * reschedule, so punctuality is measured against what the customer was
 * originally told rather than a date we may have moved ourselves.
 */
function isMidnightSentinel(ms) {
  if (ms == null) return false;
  const d = new Date(ms);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
}

function decompose(row, created, checkin) {
  const appointment = toMs(row.original_appointment_date_time) ?? toMs(row.requested_date_time);
  const usable = appointment != null && !isMidnightSentinel(appointment);
  return {
    appointmentAt: iso(appointment),
    appointmentIsDateOnly: appointment != null && !usable,
    bookingLeadHours: (created != null && usable) ? hoursBetween(created, appointment) : null,
    punctualityHours: (checkin != null && usable) ? hoursBetween(appointment, checkin) : null,
  };
}

/* MySQL DATETIME (or Date) → epoch ms, or null. Never throws. */
function toMs(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T'));
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

const hoursBetween = (a, b) => Number(((b - a) / 3600000).toFixed(1));
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

/* One segment result. Kept in one shape so the UI never branches on segment. */
function segResult(meta, { target, start, end, hrs, status, note }) {
  return {
    ...meta,
    targetHours: target,
    startedAt: iso(start),
    endedAt: iso(end),
    hours: hrs,
    overrunHours: (status === STATUS.NO && hrs != null && target != null)
      ? Number((hrs - target).toFixed(1))
      : null,
    status,
    note: note ?? null,
  };
}

/*
 * Score ONE job. Implements spec §3 STEPS 1-8 in order; each block is labelled
 * with its step so the code can be diffed against the document.
 */
function computeForRow(row) {
  // STEP 1 — job type + Seg1 target.
  const jobType = resolveJobType(row);
  const s1Target = seg1Target(jobType);

  const created = toMs(row.ticket_created_date_time);
  const checkin = toMs(row.checkin_date_time);
  const estimateSentOn = toMs(row.approval_sent_on_date_time);
  const approvedOn = toMs(row.approved_on_date_time);
  const rejectedOn = toMs(row.approval_reject_date_time);
  // Spec §2 names app_checkout_date; tbl_job's reliable completion instant is
  // checkout_date_time (COALESCE-stamped on every 3/5 transition, verified
  // 0-NULL across the live table). app_checkout is mobile-only, so it is the
  // FALLBACK, not the primary.
  const checkout = toMs(row.checkout_date_time) ?? toMs(row.app_checkout_date_time);
  const estimateSent = isEstimateSent(row);

  // STEP 2 — Seg1 Visit. ticket created → check-in. No stop conditions.
  const s1 = (() => {
    if (created == null || checkin == null) {
      return segResult(SEGMENTS[0], {
        target: s1Target, start: created, end: checkin, hrs: null,
        status: STATUS.PENDING,
        note: checkin == null ? 'No app check-in recorded on this job.' : null,
      });
    }
    const hrs = hoursBetween(created, checkin);
    return segResult(SEGMENTS[0], {
      target: s1Target, start: created, end: checkin, hrs,
      status: hrs <= s1Target ? STATUS.YES : STATUS.NO,
    });
  })();

  // STEP 3 — Seg2 Estimate. Gated on is_estimate_sent. Measured from the
  // VISIT (check-in), not from the ticket.
  const s2 = (() => {
    if (!estimateSent) {
      return segResult(SEGMENTS[1], {
        target: SEG2_TARGET, start: null, end: null, hrs: null, status: STATUS.NA,
        note: 'No estimate was sent for this job.',
      });
    }
    if (checkin == null || estimateSentOn == null) {
      return segResult(SEGMENTS[1], {
        target: SEG2_TARGET, start: checkin, end: estimateSentOn, hrs: null,
        status: STATUS.PENDING,
        note: checkin == null ? 'No app check-in to measure from.' : null,
      });
    }
    const hrs = hoursBetween(checkin, estimateSentOn);
    return segResult(SEGMENTS[1], {
      target: SEG2_TARGET, start: checkin, end: estimateSentOn, hrs,
      status: hrs <= SEG2_TARGET ? STATUS.YES : STATUS.NO,
    });
  })();

  // STEP 4 — Seg3 Approval. CLIENT OWNED. A rejection is a NO.
  const s3 = (() => {
    if (!estimateSent) {
      return segResult(SEGMENTS[2], {
        target: SEG3_TARGET, start: null, end: null, hrs: null, status: STATUS.NA,
        note: 'No estimate was sent, so no approval was due.',
      });
    }
    if (approvedOn == null && rejectedOn == null) {
      const waiting = estimateSentOn != null
        ? hoursBetween(estimateSentOn, Date.now())
        : null;
      return segResult(SEGMENTS[2], {
        target: SEG3_TARGET, start: estimateSentOn, end: null, hrs: null,
        status: STATUS.PENDING,
        note: waiting != null && waiting > SEG3_ESCALATION_HOURS
          ? `Awaiting the client for ${waiting}h — past the ${SEG3_ESCALATION_HOURS}h escalation threshold.`
          : 'Awaiting the client\'s decision.',
      });
    }
    if (approvedOn != null && estimateSentOn != null) {
      const hrs = hoursBetween(estimateSentOn, approvedOn);
      return segResult(SEGMENTS[2], {
        target: SEG3_TARGET, start: estimateSentOn, end: approvedOn, hrs,
        status: hrs <= SEG3_TARGET ? STATUS.YES : STATUS.NO,
      });
    }
    // Rejected → NO, per spec, regardless of how fast the rejection came.
    return segResult(SEGMENTS[2], {
      target: SEG3_TARGET, start: estimateSentOn, end: rejectedOn,
      hrs: (estimateSentOn != null && rejectedOn != null) ? hoursBetween(estimateSentOn, rejectedOn) : null,
      status: STATUS.NO,
      note: 'Estimate was rejected by the client.',
    });
  })();

  // STEP 5 — Seg4 Completion. Starts at approval when there was one, else at
  // the visit. Gross hours minus any STOP deduction (always 0 today).
  const s4 = (() => {
    const start = approvedOn ?? checkin;
    if (checkout == null || start == null) {
      return segResult(SEGMENTS[3], {
        target: SEG4_TARGET, start, end: checkout, hrs: null, status: STATUS.PENDING,
        note: start == null ? 'No approval or check-in to measure from.' : null,
      });
    }
    const gross = hoursBetween(start, checkout);
    const paused = stopClockHours(row, start, checkout);
    const net = Math.max(0, Number((gross - paused).toFixed(1)));
    return segResult(SEGMENTS[3], {
      target: SEG4_TARGET, start, end: checkout, hrs: net,
      status: net <= SEG4_TARGET ? STATUS.YES : STATUS.NO,
      note: (approvedOn != null ? 'Measured from client approval.' : 'Measured from the visit (no approval leg).')
        + (paused > 0 ? ` ${paused}h of stop-clock time deducted.` : ''),
    });
  })();

  const segments = [s1, s2, s3, s4];
  const breakdown = decompose(row, created, checkin);

  // STEP 6 — EF Score. Seg1 + Seg2 + Seg4 only. N/A and Pending are excluded
  // from the denominator so the score is fair.
  const efSegments = [s1, s2, s4];
  const efApplicable = efSegments.filter((s) => s.status === STATUS.YES || s.status === STATUS.NO);
  const efMet = efApplicable.filter((s) => s.status === STATUS.YES).length;
  const efTotal = efApplicable.length;

  // STEP 7 — Client Score. Seg3 alone, reported separately and never folded in.
  const clientScore = s3.status === STATUS.NA ? STATUS.NA
    : s3.status === STATUS.PENDING ? STATUS.PENDING
      : s3.status === STATUS.YES ? '1/1' : '0/1';

  // STEP 8 — performance label from the EF score only.
  const pctMet = efTotal ? efMet / efTotal : null;
  const label = pctMet == null ? LABEL.PENDING
    : pctMet === 1 ? LABEL.EXCELLENT
      : pctMet >= 0.67 ? LABEL.GOOD
        : pctMet >= 0.34 ? LABEL.PARTIAL
          : LABEL.POOR;

  return {
    jobId: row.job_id,
    jobReferenceId: row.job_reference_id ?? null,
    jobStatus: row.job_status,
    // Rollup dimensions (spec §4).
    clientName: row.client_name ?? null,
    cityName: row.city_name ?? null,
    tier: row.tier ?? null,
    categoryName: row.category_name ?? null,
    technicianName: row.efr_name ?? null,
    projectManager: row.project_manager ?? null,
    verticalName: row.vertical_name ?? null,
    jobType,
    localitySnapshotted: row.locality_snapshotted === true,
    ...breakdown,
    checkoutDateTime: row.checkout_date_time,
    isEstimateSent: estimateSent,
    stopClockAvailable: STOP_CLOCK_AVAILABLE,
    segments,
    efScore: efTotal ? `${efMet}/${efTotal}` : STATUS.PENDING,
    efMet,
    efTotal,
    efPct: pctMet == null ? null : Number((pctMet * 100).toFixed(1)),
    clientScore,
    performance: label,
  };
}

/*
 * The projection every mode shares. All the spec §2 rollup dimensions are
 * resolved here in one pass. Tier comes from the JOB address's city — never
 * the technician's — and the PM is the vertical mapping's user_type=1 user,
 * matching how every existing report resolves it.
 */
const JOB_SELECT = `
  SELECT
    j.job_id, j.job_reference_id, j.job_status,
    j.ticket_created_date_time, j.checkin_date_time,
    j.requested_date_time, j.original_appointment_date_time,
    j.app_checkout_date_time, j.checkout_date_time,
    j.approval_sent_on_date_time, j.no_of_req_approval,
    j.approved_on_date_time, j.approval_reject_date_time,
    j.fk_client_id, j.fk_easyfixter_id,
    c.client_name,
    a.pin_code AS job_pincode,
    city.city_name, city.tier,
    catg.service_catg_name AS category_name,
    e.efr_name,
    pm.user_name          AS project_manager,
    v.vertical_name
  FROM tbl_job j
  LEFT JOIN tbl_client         c    ON c.client_id           = j.fk_client_id
  LEFT JOIN tbl_address        a    ON a.address_id          = j.fk_address_id
  LEFT JOIN tbl_city           city ON city.city_id          = a.city_id
  LEFT JOIN tbl_service_catg   catg ON catg.service_catg_id  = j.fk_service_catg_id
  LEFT JOIN tbl_easyfixer      e    ON e.efr_id              = j.fk_easyfixter_id
  LEFT JOIN tbl_vertical_mapping vm ON vm.client_id          = c.client_id AND vm.user_type = 1
  LEFT JOIN tbl_user           pm   ON pm.user_id            = vm.user_id
  LEFT JOIN tbl_vertical       v    ON v.vertical_id         = c.vertical_id`;

/* Spec §4 MET %: YES / (YES + NO). N/A and Pending never enter a denominator. */
function metPct(yes, no) {
  const denom = yes + no;
  return denom ? Number(((100 * yes) / denom).toFixed(1)) : null;
}

/*
 * Fold N scored jobs into the per-segment tallies, the two scores, the label
 * distribution and the per-dimension rollups (spec §4).
 */
function summarise(scored) {
  const perSegment = SEGMENTS.map((s) => ({
    no: s.no, key: s.key, label: s.label, owner: s.owner,
    yes: 0, noCount: 0, na: 0, pending: 0,
    totalHours: 0, totalOverrun: 0, evaluated: 0, breached: 0,
  }));

  const labels = { Excellent: 0, Good: 0, Partial: 0, Poor: 0, Pending: 0 };
  // Decomposition roll-up — see decompose(). Averaged over the jobs where each
  // figure is measurable, NOT over all jobs, so a date-only booking cannot drag
  // the mean toward zero.
  let leadSum = 0; let leadN = 0;
  let punctSum = 0; let punctN = 0; let onTimeArrivals = 0;
  let efMetSum = 0;
  let efTotalSum = 0;
  let clientYes = 0;
  let clientNo = 0;

  for (const job of scored) {
    labels[job.performance] += 1;
    if (job.bookingLeadHours != null) { leadSum += job.bookingLeadHours; leadN += 1; }
    if (job.punctualityHours != null) {
      punctSum += job.punctualityHours; punctN += 1;
      if (job.punctualityHours <= 0) onTimeArrivals += 1;
    }
    efMetSum += job.efMet;
    efTotalSum += job.efTotal;
    if (job.segments[2].status === STATUS.YES) clientYes += 1;
    if (job.segments[2].status === STATUS.NO) clientNo += 1;

    job.segments.forEach((s, i) => {
      const t = perSegment[i];
      if (s.status === STATUS.YES) { t.yes += 1; t.evaluated += 1; t.totalHours += s.hours; }
      else if (s.status === STATUS.NO) {
        t.noCount += 1; t.evaluated += 1; t.breached += 1;
        t.totalHours += s.hours ?? 0;
        t.totalOverrun += s.overrunHours ?? 0;
      } else if (s.status === STATUS.NA) t.na += 1;
      else t.pending += 1;
    });
  }

  const segments = perSegment.map((t) => ({
    no: t.no, key: t.key, label: t.label, owner: t.owner,
    yes: t.yes, noCount: t.noCount, na: t.na, pending: t.pending,
    metPct: metPct(t.yes, t.noCount),
    avgHours: t.evaluated ? Number((t.totalHours / t.evaluated).toFixed(1)) : null,
    avgOverrunHours: t.breached ? Number((t.totalOverrun / t.breached).toFixed(1)) : null,
    // Of the jobs this segment APPLIED to, how many could we evaluate?
    coveragePct: (t.evaluated + t.pending)
      ? Number(((100 * t.evaluated) / (t.evaluated + t.pending)).toFixed(1))
      : null,
  }));

  return {
    jobsAnalysed: scored.length,
    // Spec §4 "EF Score rollup": sum met / sum total across the group.
    efScorePct: efTotalSum ? Number(((100 * efMetSum) / efTotalSum).toFixed(1)) : null,
    efMet: efMetSum,
    efTotal: efTotalSum,
    clientScorePct: metPct(clientYes, clientNo),
    /*
     * The Visit breakdown. avgBookingLeadHours is the customer's own chosen
     * wait; avgPunctualityHours is ours (negative = we arrived early). Together
     * they explain the Visit MET %, which on its own cannot distinguish "we were
     * slow" from "they booked for next week".
     */
    avgBookingLeadHours: leadN ? Number((leadSum / leadN).toFixed(1)) : null,
    avgPunctualityHours: punctN ? Number((punctSum / punctN).toFixed(1)) : null,
    arrivedOnTimePct: punctN ? Number(((100 * onTimeArrivals) / punctN).toFixed(1)) : null,
    punctualityMeasurable: punctN,
    clientMet: clientYes,
    clientEvaluated: clientYes + clientNo,
    labels,
    segments,
    rollups: buildRollups(scored),
  };
}

/*
 * Spec §4 rollups. One table per dimension, each row carrying the EF score and
 * the per-segment MET %. Sorted worst-EF-first so the problem rows surface
 * without the operator sorting — an unscored group sorts last, not first, so a
 * group with no evaluable jobs cannot masquerade as the worst offender.
 */
const ROLLUP_DIMENSIONS = Object.freeze([
  { key: 'client', label: 'Client', field: 'clientName' },
  { key: 'city', label: 'City', field: 'cityName' },
  { key: 'category', label: 'Category', field: 'categoryName' },
  { key: 'technician', label: 'Technician', field: 'technicianName' },
  { key: 'projectManager', label: 'Project Manager', field: 'projectManager' },
  { key: 'vertical', label: 'Vertical', field: 'verticalName' },
  { key: 'jobType', label: 'Local / Travel', field: 'jobType' },
]);

function buildRollups(scored) {
  const out = {};
  for (const dim of ROLLUP_DIMENSIONS) {
    const groups = new Map();
    for (const job of scored) {
      const name = job[dim.field] || 'Unspecified';
      if (!groups.has(name)) {
        groups.set(name, {
          name, jobs: 0, efMet: 0, efTotal: 0,
          seg: SEGMENTS.map(() => ({ yes: 0, noCount: 0 })),
          labels: { Excellent: 0, Good: 0, Partial: 0, Poor: 0, Pending: 0 },
        });
      }
      const g = groups.get(name);
      g.jobs += 1;
      g.efMet += job.efMet;
      g.efTotal += job.efTotal;
      g.labels[job.performance] += 1;
      job.segments.forEach((s, i) => {
        if (s.status === STATUS.YES) g.seg[i].yes += 1;
        else if (s.status === STATUS.NO) g.seg[i].noCount += 1;
      });
    }
    out[dim.key] = [...groups.values()]
      .map((g) => ({
        name: g.name,
        jobs: g.jobs,
        efScorePct: g.efTotal ? Number(((100 * g.efMet) / g.efTotal).toFixed(1)) : null,
        efMet: g.efMet,
        efTotal: g.efTotal,
        segmentMetPct: g.seg.map((s) => metPct(s.yes, s.noCount)),
        labels: g.labels,
      }))
      .sort((a, b) => {
        if (a.efScorePct == null && b.efScorePct == null) return b.jobs - a.jobs;
        if (a.efScorePct == null) return 1;   // unscored sorts LAST
        if (b.efScorePct == null) return -1;
        return a.efScorePct - b.efScorePct;   // worst first
      });
  }
  return out;
}

/* Caveats that travel with every result, so they cannot be read without them. */
function assumptions() {
  return [
    {
      key: 'checkin',
      severity: 'warning',
      title: 'Segment 1 reads Pending on most new-CRM jobs',
      detail: 'checkin_date_time has no writer in this backend — only the legacy mobile API ever stamped '
        + 'it. Rather than substitute another timestamp and produce a confident wrong number, those '
        + 'segments are Pending and excluded from every denominator. Segment 2 measures FROM check-in, so '
        + 'it is affected too.',
    },
    {
      key: 'locality-live',
      severity: 'warning',
      title: 'Local vs Travel is computed live, so history can move',
      detail: 'A job is Local when an active technician\'s current or serviceable pincode covers it. That '
        + 'is evaluated NOW, not at booking — so onboarding a technician into an area retroactively '
        + 'tightens every past job there from a 48h Visit target to 24h. Re-running this report after a '
        + 'supply change will not reproduce the earlier numbers.',
    },
    {
      key: 'estimate-flag',
      severity: 'warning',
      title: 'is_estimate_sent is inferred, not stored',
      detail: 'The spec asks for a real BOOLEAN column. Today it is inferred from the approval-sent '
        + 'timestamp (the same event as estimate-sent) or the approval counter. An estimate produced but '
        + 'never sent for approval is therefore invisible.',
    },
    {
      key: 'stop-clock',
      severity: 'info',
      title: 'Segment 4 deducts stop-clock time, but only where it was recorded',
      detail: 'Material-wait, OEM-part and entry-permission pauses are deducted from Segment 4 when a '
        + 'stop was logged against the job. Nothing logs them automatically yet, so a job that genuinely '
        + 'waited on a part but had no stop recorded still reports gross.',
    },
    {
      key: 'completed-only',
      severity: 'info',
      title: 'Only completed jobs are rolled up',
      detail: 'Jobs still in progress have open clocks. Only job_status 3 / 5 are counted, so the Pending '
        + 'counts you see are per-SEGMENT gaps on finished jobs, not unfinished work.',
    },
  ];
}

// ─── Open decisions (rendered under "How It Works?") ─────────────────
const OPEN_DECISIONS = Object.freeze([
  {
    id: 'stop-clock-writers',
    owner: 'Product / Ops → then Engineering',
    status: 'blocked',
    question: 'Who logs a stop, and from where?',
    today: 'The ledger exists and Segment 4 deducts from it, but nothing WRITES to it — so in practice '
      + 'every job still reports gross.',
    impact: 'Realistic entry points are the CRM job modal (beside the existing hold controls) and the '
      + 'technician app. Both need a UI and a permission key. Until one ships, the stop clock is '
      + 'plumbing with no source.',
  },
  {
    id: 'is-estimate-sent-column',
    owner: 'Engineering',
    status: 'gap',
    question: 'Store is_estimate_sent explicitly?',
    today: 'Inferred from the approval-sent timestamp. An estimate drafted but never sent for approval '
      + 'reads as "no estimate".',
    impact: 'Spec §2 lists it as a required BOOLEAN input. It gates Segments 2 AND 3, so a wrong value '
      + 'silently changes which segments a job is scored on.',
  },
  {
    id: 'checkin-writer',
    owner: 'Engineering',
    status: 'gap',
    question: 'Start writing checkin_date_time.',
    today: 'Never written by this backend. Segment 1 is Pending on most jobs, and Segment 2 inherits the '
      + 'gap because it measures from check-in.',
    impact: 'Two of the three EasyFix-owned segments are unevaluable until this lands, which makes the EF '
      + 'score itself thin.',
  },
  {
    id: 'estimate-rejected-column',
    owner: 'Engineering',
    status: 'gap',
    question: 'Separate estimate rejection from plain job rejection?',
    today: 'approval_reject_date_time is written by BOTH the estimate-reject route and the plain '
      + 'job-reject route, so a non-estimate rejection can score Segment 3 as NO.',
    impact: 'Spec §2 lists estimate_rejected_on as its own field. Without the split, some Segment 3 NOs '
      + 'are not really the client missing an estimate window.',
  },
  {
    id: 'pending-jobs-in-report',
    owner: 'Product / Ops',
    status: 'assumed',
    question: 'Should in-progress jobs appear with a Pending label?',
    today: 'Only completed jobs (status 3/5) are pulled. The spec keeps Pending jobs visible in a Pending '
      + 'column so they can be chased.',
    impact: 'Including them makes this a live operational queue rather than a retrospective scorecard. '
      + 'Different tool, same engine.',
  },
  {
    id: 'business-hours',
    owner: 'Product / Ops',
    status: 'assumed',
    question: 'Wall clock, or business hours?',
    today: 'Wall clock. 24 hours across a Sunday counts as 24 hours.',
    impact: 'A Friday-evening booking fails a 24h Visit target that an identical Monday-morning booking '
      + 'passes. Switching changes every number.',
  },
  {
    id: 'escalation-wiring',
    owner: 'Product / Ops',
    status: 'blocked',
    question: 'Wire the two escalations in spec §6?',
    today: 'Neither fires. Nothing consumes this engine yet.',
    impact: 'Spec: a Poor job flags for PM review within 24h, and client approval past 48h auto-reminds '
      + 'the SPOC. Both need an owner and a channel before they can be built.',
  },
  {
    id: 'locality-snapshot',
    owner: 'Product / Ops → then Engineering',
    status: 'assumed',
    question: 'Should Local vs Travel be snapshotted at booking?',
    today: 'It is computed live from technician pincode coverage, so a past job\'s Visit target changes '
      + 'whenever supply in its area changes.',
    impact: 'Live is right for "can we serve this today?" and wrong for a scorecard nobody can reproduce. '
      + 'Snapshotting a tat_locality column at booking freezes the target a job was actually operating '
      + 'under. Until then, quote TAT numbers with the date they were run.',
  },
]);

// ─── Mode: one job ───────────────────────────────────────────────────
async function forJob(jobId) {
  logger.info('TAT compute · job · id=' + jobId);
  const [rows] = await pool.query(`${JOB_SELECT} WHERE j.job_id = ?`, [jobId]);
  if (!rows.length) {
    const e = new Error('Job not found');
    e.status = 404;
    throw e;
  }
  await stampLocality(rows);
  await attachStops(rows);
  const job = computeForRow(rows[0]);
  logger.info('TAT computed · job=' + jobId + ' · type=' + job.jobType
    + ' · ef=' + job.efScore + ' · ' + job.performance);
  return { mode: 'job', job, summary: summarise([job]), assumptions: assumptions() };
}

async function aggregate({ sql, params, mode, subject, windowLabel }) {
  const [rows] = await pool.query(sql, params);
  const truncated = rows.length >= MAX_ROWS;
  if (truncated) {
    logger.warn('TAT compute · ' + mode + ' hit the ' + MAX_ROWS + '-row cap — result is a partial view');
  }
  await stampLocality(rows);
  await attachStops(rows);
  const scored = rows.map((r) => computeForRow(r));
  logger.info('TAT computed · ' + mode + ' · jobs=' + scored.length + (truncated ? ' (CAPPED)' : ''));
  return {
    mode, subject, windowLabel, truncated, rowCap: MAX_ROWS,
    summary: summarise(scored),
    jobs: scored,
    assumptions: assumptions(),
  };
}

// ─── Mode: one client, completed in the last N days ──────────────────
async function forClient(clientId, days = CLIENT_LOOKBACK_DAYS) {
  logger.info('TAT compute · client · id=' + clientId + ' · days=' + days);
  const [[client]] = await pool.query('SELECT client_id, client_name FROM tbl_client WHERE client_id = ?', [clientId]);
  if (!client) {
    const e = new Error('Client not found');
    e.status = 404;
    throw e;
  }
  return aggregate({
    sql: `${JOB_SELECT}
           WHERE j.fk_client_id = ?
             AND j.job_status IN (${COMPLETED_STATUSES.join(',')})
             AND j.checkout_date_time IS NOT NULL
             AND j.checkout_date_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
           ORDER BY j.checkout_date_time DESC
           LIMIT ${MAX_ROWS}`,
    params: [clientId, days],
    mode: 'client',
    subject: { id: client.client_id, name: client.client_name },
    windowLabel: `Completed In The Last ${days} Days`,
  });
}

/*
 * Generic dimension modes — City, Category, Project Manager, Vertical.
 *
 * One table rather than four near-identical functions: each entry names the
 * WHERE fragment and the label lookup, and everything else is shared. Adding a
 * fifth dimension is one row here, not another 30-line copy.
 *
 * All four use the same completed-jobs + lookback window as the client mode.
 * The PM filter goes through tbl_vertical_mapping (user_type = 1), which is how
 * every existing report resolves a project manager — resolving it any other way
 * here would make this page disagree with the ones ops already trust.
 */
const DIMENSION_MODES = Object.freeze({
  city: {
    label: 'City',
    where: 'city.city_id = ?',
    nameSql: 'SELECT city_name AS name FROM tbl_city WHERE city_id = ?',
    notFound: 'City not found',
  },
  category: {
    label: 'Category',
    where: 'j.fk_service_catg_id = ?',
    nameSql: 'SELECT service_catg_name AS name FROM tbl_service_catg WHERE service_catg_id = ?',
    notFound: 'Service category not found',
  },
  'project-manager': {
    label: 'Project Manager',
    where: 'vm.user_id = ?',
    nameSql: 'SELECT user_name AS name FROM tbl_user WHERE user_id = ?',
    notFound: 'Project manager not found',
  },
  vertical: {
    label: 'Vertical',
    where: 'c.vertical_id = ?',
    nameSql: 'SELECT vertical_name AS name FROM tbl_vertical WHERE vertical_id = ?',
    notFound: 'Vertical not found',
  },
});

async function forDimension(dimension, id, days = CLIENT_LOOKBACK_DAYS) {
  const dim = DIMENSION_MODES[dimension];
  if (!dim) {
    const e = new Error('Unknown dimension');
    e.status = 400;
    throw e;
  }
  logger.info('TAT compute · ' + dimension + ' · id=' + id + ' · days=' + days);
  const [[found]] = await pool.query(dim.nameSql, [id]);
  if (!found) {
    const e = new Error(dim.notFound);
    e.status = 404;
    throw e;
  }
  return aggregate({
    sql: `${JOB_SELECT}
           WHERE ${dim.where}
             AND j.job_status IN (${COMPLETED_STATUSES.join(',')})
             AND j.checkout_date_time IS NOT NULL
             AND j.checkout_date_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
           ORDER BY j.checkout_date_time DESC
           LIMIT ${MAX_ROWS}`,
    params: [id, days],
    mode: dimension,
    subject: { id: Number(id), name: found.name },
    windowLabel: `${dim.label} · Completed In The Last ${days} Days`,
  });
}

// ─── Mode: one technician, lifetime ──────────────────────────────────
async function forTechnician(efrId) {
  logger.info('TAT compute · technician · id=' + efrId);
  const [[tech]] = await pool.query('SELECT efr_id, efr_name FROM tbl_easyfixer WHERE efr_id = ?', [efrId]);
  if (!tech) {
    const e = new Error('Technician not found');
    e.status = 404;
    throw e;
  }
  return aggregate({
    sql: `${JOB_SELECT}
           WHERE j.fk_easyfixter_id = ?
             AND j.job_status IN (${COMPLETED_STATUSES.join(',')})
             AND j.checkout_date_time IS NOT NULL
           ORDER BY j.checkout_date_time DESC
           LIMIT ${MAX_ROWS}`,
    params: [efrId],
    mode: 'technician',
    subject: { id: tech.efr_id, name: tech.efr_name },
    windowLabel: 'All Completed Jobs (Lifetime)',
  });
}

/* The rules themselves, so the "How It Works?" panel renders exactly what the
 * engine applies rather than a hand-copied duplicate. */
function policy() {
  return {
    segments: SEGMENTS,
    targets: {
      seg1Local: SEG1_TARGET_LOCAL,
      seg1Travel: SEG1_TARGET_TRAVEL,
      seg2: SEG2_TARGET,
      seg3: SEG3_TARGET,
      seg4: SEG4_TARGET,
    },
    localityRule: 'A job is LOCAL when at least one active technician\'s current or serviceable pincode matches the job pincode. Otherwise it is TRAVEL.',
    seg3EscalationHours: SEG3_ESCALATION_HOURS,
    labelThresholds: [
      { label: LABEL.EXCELLENT, min: 100 },
      { label: LABEL.GOOD, min: 67 },
      { label: LABEL.PARTIAL, min: 34 },
      { label: LABEL.POOR, min: 0 },
    ],
    rollupDimensions: ROLLUP_DIMENSIONS.map(({ key, label }) => ({ key, label })),
    inputModes: [
      { key: 'job', label: 'Job', kind: 'id' },
      { key: 'client', label: 'Client', kind: 'lookup' },
      { key: 'technician', label: 'Technician', kind: 'lookup' },
      ...Object.entries(DIMENSION_MODES).map(([key, d]) => ({ key, label: d.label, kind: 'lookup' })),
    ],
    stopClockAvailable: STOP_CLOCK_AVAILABLE,
    stopReasons: STOP_REASONS,
    stopOwners: STOP_OWNERS,
    clientLookbackDays: CLIENT_LOOKBACK_DAYS,
    assumptions: assumptions(),
    openDecisions: OPEN_DECISIONS,
  };
}

module.exports = {
  forJob,
  forClient,
  forTechnician,
  forDimension,
  policy,
  // exported for tests + future consumers
  computeForRow,
  summarise,
  buildRollups,
  resolveJobType,
  stampLocality,
  isEstimateSent,
  SEGMENTS,
  STATUS,
  LABEL,
  OWNER,
  ROLLUP_DIMENSIONS,
  DIMENSION_MODES,
  STOP_REASONS,
  STOP_OWNERS,
  COMPLETED_STATUSES,
  CLIENT_LOOKBACK_DAYS,
  OPEN_DECISIONS,
  SEG1_TARGET_LOCAL,
  SEG1_TARGET_TRAVEL,
  SEG2_TARGET,
  SEG3_TARGET,
  SEG4_TARGET,
};
