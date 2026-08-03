/*
 * services/job-share.service.js — the technician "share job" public-link flow.
 *
 * A technician shares a public link to a job; whoever opens it sees a small,
 * NON-CONFIDENTIAL slice of the job (service, address, appointment) and can
 * navigate to it / place a masked call to the customer. This is a deliberately
 * STRIPPED sibling of job-magic-link.service.fetchPrefill — we do NOT reuse
 * that builder because it returns customer PII, SPOC/coordinator identities and
 * pricing, none of which may cross a world-reachable link.
 *
 * The link token is minted by utils/jwt.signJobShareToken (type 'job_share',
 * short TTL). Liveness is enforced here (reject finished/cancelled jobs) rather
 * than via a status-9 gate, since a shared job isn't tied to any one status.
 */

const { signJobShareToken } = require('../utils/jwt');
const { hasTimeOfDay, formatClock12, deriveTimeSlot, canonicalSlot } = require('./time-slot');
const urlShortener = require('./url-shortener.service');
const logger = require('../logger');

// Statuses for which a share link must stop working: COMPLETED(3),
// COMPLETED_ALT(5), CANCELLED(6). A finished/cancelled job must not leak an
// active address or bridge a call.
const NON_SHAREABLE_STATUSES = new Set([3, 5, 6]);

/*
 * Google Maps SEARCH link (GPS preferred, address fallback) — same logic as
 * job-magic-link.service.js. This is a convenience pointer; the FE builds the
 * turn-by-turn DIRECTIONS deep-link from gps_location/address itself.
 */
function buildMapsSearchLink(gpsLocation, address) {
  const gps = gpsLocation ? String(gpsLocation).trim() : '';
  if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(gps)) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(gps)}`;
  }
  if (address && String(address).trim()) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(address).trim())}`;
  }
  return null;
}

/*
 * ─── THE APPOINTMENT LINE ────────────────────────────────────────────────
 *
 * ONE builder for BOTH the public page's `schedule.appointment_label` and the
 * WhatsApp/share-sheet blurb in buildShareMessage. They were two copies of
 * `[requested_date_label, time_slot].join(' · ')` — the page's copy in the FE
 * (Easyfix_CRM_UI shared-job page) and this file's in buildShareMessage — so a
 * fix to one silently left the other wrong. The page now renders this string
 * verbatim.
 *
 * ── WHY THE STORED BAND IS NOT USED ──
 *
 * tbl_job.time_slot is DERIVED: it is the band containing requested_date_time,
 * and resolveTimeSlot re-derives it on every write. A stored value that
 * disagrees with the appointment is therefore already dead — the next save
 * discards it. Job #482491 stores requested_date_time 05:30 ('After Hours')
 * with time_slot '3pm to 7pm', and this link published '3pm to 7pm' to whoever
 * opened it. Same precedence as the writer-side gate and as jobDateLabel in
 * whatsapp-conversation.service.js:
 *
 *   real time-of-day  → the band CONTAINING it (deriveTimeSlot)
 *   date-only / 00:00 → the stored label, canonicalised for spelling only
 *                       (canonicalSlot — a cosmetic fold, never an
 *                       interpretation, so legacy vocabularies like
 *                       'Morning 9 to 2' survive verbatim)
 *
 * ── WHY THE EXACT TIME IS ALSO SHOWN ──
 *
 * Owner request (2026-08-03): the shared page previously carried a DATE-ONLY
 * label and they want the hour on it, so a timed job reads
 *   'Tue, 5 Aug 2026, 5:30 AM · After Hours'
 * and a date-only job keeps the band alone
 *   'Tue, 5 Aug 2026 · 3PM to 7PM'.
 * formatClock12 returns null on the 00:00 sentinel, which is what stops a
 * date-only booking from claiming a "12 AM" appointment it never had.
 *
 * No SQL change was needed: requested_date_time is already projected as an IST
 * wall-clock string ('%Y-%m-%d %H:%i:%s') beside the date label, which is
 * exactly what these helpers parse.
 */
function buildAppointmentLabel(dateLabel, requestedDateTime, storedSlot) {
  const date = dateLabel ? String(dateLabel).trim() : '';
  if (!date) return null;
  const band = hasTimeOfDay(requestedDateTime)
    ? deriveTimeSlot(requestedDateTime)
    : canonicalSlot(storedSlot);
  const clock = formatClock12(requestedDateTime);
  const head = clock ? `${date}, ${clock}` : date;
  return band ? `${head} · ${band}` : head;
}

/* The band this job's appointment actually sits in — same precedence as above,
 * exposed on its own so a consumer of `schedule.time_slot` can never pick up
 * the stale stored string. '' collapses to null for the JSON payload. */
function resolveDisplaySlot(requestedDateTime, storedSlot) {
  const band = hasTimeOfDay(requestedDateTime)
    ? deriveTimeSlot(requestedDateTime)
    : canonicalSlot(storedSlot);
  return band || null;
}

/*
 * Mint the share link + its expiry. base = SHARE_LINK_BASE_URL, falling back to
 * MAGIC_LINK_BASE_URL (same host the job-completion links use), then qa.
 */
function buildShareLink(jobId) {
  const ttlHours = Number(process.env.JOB_SHARE_LINK_TTL_HOURS || 72);
  const token = signJobShareToken({ jobId });
  const base = (process.env.SHARE_LINK_BASE_URL || process.env.MAGIC_LINK_BASE_URL || 'https://qa.easyfix.in').replace(/\/$/, '');
  return {
    url: `${base}/public/shared-job/${token}`,
    token,
    expires_at: new Date(Date.now() + ttlHours * 3600 * 1000).toISOString(),
  };
}

/*
 * Non-confidential job details for the public shared page. Throws plain
 * `{status, code, message}` shapes (404 not-found / 410 no-longer-active) that
 * the route catch maps to modernError. Excludes every customer/SPOC/coordinator
 * /pricing field by construction (they're simply never selected).
 */
async function fetchShareDetails(jobId, pool) {
  const [[row]] = await pool.query(
    `SELECT j.job_id, j.fk_client_id, j.job_status, j.job_desc,
            DATE_FORMAT(j.requested_date_time, '%Y-%m-%d %H:%i:%s') AS requested_date_time,
            DATE_FORMAT(j.requested_date_time, '%a, %e %b %Y')      AS requested_date_label,
            j.time_slot,
            ad.address, ad.building, ad.landmark, ad.city_id, ad.pin_code,
            ad.gps_location, ad.address_instruction,
            cl.client_name
       FROM tbl_job j
       LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
       LEFT JOIN tbl_client  cl ON cl.client_id  = j.fk_client_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!row) {
    throw { status: 404, code: 'JOB_NOT_FOUND', message: 'Job not found' };
  }
  const status = row.job_status != null ? Number(row.job_status) : null;
  if (status != null && NON_SHAREABLE_STATUSES.has(status)) {
    throw { status: 410, code: 'JOB_NOT_SHAREABLE', message: 'This job link is no longer active' };
  }

  // City name (best-effort — the shared page shows it and the message uses it).
  let cityName = null;
  if (row.city_id) {
    try {
      const [[c]] = await pool.query('SELECT city_name FROM tbl_city WHERE city_id = ? LIMIT 1', [row.city_id]);
      cityName = c ? c.city_name : null;
    } catch (_e) { /* best-effort */ }
  }

  // The services actually selected for THIS job → type + category names.
  // js.service_id = service_type_id; category resolves THROUGH service_type
  // (cs.service_catg_id is unreliable — see job-magic-link.service.js:504-517).
  const [svcRows] = await pool.query(
    `SELECT st.service_type_name, sc.service_catg_name
       FROM tbl_job_services js
       JOIN tbl_service_type st ON st.service_type_id = js.service_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = st.service_catg_id
      WHERE js.job_id = ? AND js.job_service_status = 1
      ORDER BY js.job_service_id ASC`,
    [jobId],
  );

  return {
    job_id: jobId,
    order_status: status,
    client_name: row.client_name || null,
    service_requested: svcRows.map((s) => ({
      service_type_name: s.service_type_name || null,
      service_catg_name: s.service_catg_name || null,
    })),
    job_desc: row.job_desc || null,
    schedule: {
      requested_date_time: row.requested_date_time || null,
      requested_date_label: row.requested_date_label || null,
      /* The 12-hour appointment time ('5:30 AM'), or null on a date-only /
       * midnight-sentinel booking. */
      requested_time_label: formatClock12(row.requested_date_time),
      /* The band the appointment ACTUALLY falls in — never the raw stored
       * column. See buildAppointmentLabel. */
      time_slot: resolveDisplaySlot(row.requested_date_time, row.time_slot),
      /* The one composed line the page renders and the share message quotes. */
      appointment_label: buildAppointmentLabel(
        row.requested_date_label, row.requested_date_time, row.time_slot,
      ),
    },
    address: {
      address: row.address || null,
      building: row.building || null,
      landmark: row.landmark || null,
      city_id: row.city_id || null,
      city_name: cityName,
      pin_code: row.pin_code || null,
      gps_location: row.gps_location || null,
      address_instruction: row.address_instruction || null,
    },
    maps_link: buildMapsSearchLink(row.gps_location, row.address),
  };
}

/*
 * Compose the share MESSAGE (not a bare URL) so every channel/app shares the
 * same non-confidential blurb + link. Each clause is dropped gracefully when
 * its field is missing. NO customer name/number — only service + city +
 * appointment + link.
 *   "EasyFix job #511425 — AC Repair (Cooling) in Gurugram, scheduled
 *    Sat, 27 Jun 2026, 12 PM · 12PM to 3PM.
 *    View full details & navigate: <url>"
 *
 * The appointment clause is `schedule.appointment_label` — the SAME string the
 * public page renders — so the blurb and the page it links to can never quote
 * different windows. Do not re-join the schedule fields here.
 */
function buildShareMessage(details, url) {
  const svc = (details.service_requested && details.service_requested[0]) || null;
  let head = `EasyFix job #${details.job_id}`;
  if (svc && svc.service_type_name) {
    head += ` — ${svc.service_type_name}`;
    if (svc.service_catg_name) head += ` (${svc.service_catg_name})`;
  }
  const city = details.address && details.address.city_name;
  if (city) head += ` in ${city}`;
  const sched = details.schedule || {};
  const when = sched.appointment_label;
  if (when) head += `, scheduled ${when}`;
  head += '.';
  return `${head}\nView full details & navigate: ${url}`;
}

/*
 * Convenience for the mobile mint endpoint: details + link + message in one go.
 */
async function buildShareBundle(jobId, pool, { sharedByEfrId = null } = {}) {
  const details = await fetchShareDetails(jobId, pool); // also enforces liveness
  const link = buildShareLink(jobId); // long /public/shared-job/<token> URL

  // Shorten so the shared message carries a tidy short URL (resolves via the
  // /public/book/<code> → /public/shared-job/<token> redirect). Best-effort —
  // fall back to the long URL if shortening fails.
  let shareUrl = link.url;
  let shortCode = null;
  try {
    const short = await urlShortener.shortenUrl(
      link.url,
      { purpose: 'job_share', expiresAt: new Date(link.expires_at), createdBy: null },
      pool,
    );
    shareUrl = short.short_url;
    shortCode = short.short_code;
  } catch (e) {
    logger.warn({ jobId, err: e.message }, 'job-share: shorten failed — using long URL');
  }

  // Track WHO shared (technician) + job + short_code. Best-effort; a pre-migration
  // deploy (table absent) simply skips the audit.
  if (sharedByEfrId != null) {
    try {
      await pool.query(
        'INSERT INTO tbl_job_share_link (job_id, fk_easyfixer_id, short_code) VALUES (?, ?, ?)',
        [jobId, sharedByEfrId, shortCode],
      );
    } catch (e) {
      logger.warn({ jobId, err: e.message }, 'job-share: share-audit insert failed (non-fatal)');
    }
  }

  logger.info('Built job share link · jobId=' + jobId + ' · short=' + (shortCode || 'none') + ' · by=' + (sharedByEfrId || '?'));
  return { url: shareUrl, message: buildShareMessage(details, shareUrl), expires_at: link.expires_at };
}

/*
 * Resolve the CUSTOMER's real mobile (+ audit snapshot fields) for the masked
 * call bridge receiver leg. The number never leaves the server unmasked.
 */
async function resolveCustomerForCall(jobId, pool) {
  const [[row]] = await pool.query(
    `SELECT c.customer_mob_no AS mobile,
            COALESCE(j.job_customer_name, c.customer_name) AS name,
            j.job_status, j.fk_easyfixter_id
       FROM tbl_job j
       LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  return row || null;
}

module.exports = {
  buildShareLink,
  fetchShareDetails,
  buildShareMessage,
  buildShareBundle,
  resolveCustomerForCall,
  NON_SHAREABLE_STATUSES,
};
