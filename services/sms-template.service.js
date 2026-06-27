const { pool } = require('../db');
const logger = require('../logger');

/*
 * Fetches the DLT-approved SMS body for a given `job_stage` from
 * `tbl_sms_transational_meta`. In India, TRAI/DLT requires every SMS sent
 * through an aggregator to EXACTLY match a template registered against the
 * sender's Principal Entity + Header. If the body drifts, SMSCountry still
 * returns 200 OK (they accepted it), but telecom operators silently drop the
 * message on the way to the handset. That's what was happening on first boot:
 * a hand-written "EasyFix login OTP: ..." string was being sent because we
 * weren't sourcing from the template table like the legacy code.
 *
 * Schema: client_id 1 = EasyFix default scope; 0 = generic fallback. Status=1
 * means active. We prefer a per-client row if one exists, otherwise the
 * client=0 default, otherwise any active row for that stage.
 *
 * Placeholder format:
 *   "…is {#var#} - Team EasyFix"     ← DLT format (legacy uses this)
 *   "…is <otp>."                      ← legacy placeholder format (older rows)
 *   "…is {#var1#} {#var2#} {#var3#}"  ← multi-arg DLT templates
 * We accept all three styles, substituting by positional index into `vars`.
 *
 * Cache: templates almost never change. A 5-min in-memory cache saves a DB
 * round-trip on every OTP send.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key: `${job_stage}:${client_id}` → { body, expiresAt }

async function getTemplate(jobStage, { clientId = 1 } = {}) {
  const key = `${jobStage}:${clientId}`;
  logger.info('Resolving SMS template · job_stage=' + jobStage + ' · clientId=' + clientId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    logger.info('SMS template cache hit · job_stage=' + jobStage + ' · clientId=' + clientId);
    return hit.body;
  }

  // Prefer exact (stage, client). Fall back to (stage, 0 = default). Fall back to any active.
  const [rows] = await pool.query(
    `SELECT sms, client_id FROM tbl_sms_transational_meta
      WHERE job_stage = ? AND status = 1
      ORDER BY (client_id = ?) DESC, (client_id = 0) DESC, sms_id ASC
      LIMIT 1`,
    [jobStage, clientId]
  );
  const body = rows[0]?.sms || null;
  cache.set(key, { body, expiresAt: Date.now() + CACHE_TTL_MS });
  if (!body) logger.warn(`No active SMS template for job_stage="${jobStage}" — falling back to inline text (DLT filtering will likely drop this message).`);
  else logger.info('Resolved SMS template · job_stage=' + jobStage + ' · matchedClientId=' + rows[0].client_id);
  return body;
}

/**
 * Fill a DLT template with positional vars. Supports:
 *   {#var#}    → vars[0]
 *   {#var1#}   → vars[0]
 *   {#var2#}   → vars[1]
 *   <otp>      → vars[0]   (legacy placeholder)
 */
function fill(template, vars = []) {
  if (!template) return null;
  let out = template;
  // {#varN#} with explicit index (1-based per DLT convention)
  out = out.replace(/\{#var(\d+)#\}/g, (_, n) => String(vars[Number(n) - 1] ?? ''));
  // {#var#} (single-variable templates) → vars[0]
  out = out.replace(/\{#var#\}/g, String(vars[0] ?? ''));
  // <otp> legacy placeholder → vars[0]
  out = out.replace(/<otp>/gi, String(vars[0] ?? ''));
  return out;
}

function invalidate(jobStage, clientId) {
  logger.info('Invalidating SMS template cache · job_stage=' + (jobStage == null ? 'ALL' : jobStage) + ' · clientId=' + (clientId == null ? 'ALL' : clientId));
  if (jobStage == null) { cache.clear(); return; }
  if (clientId == null) {
    for (const k of cache.keys()) if (k.startsWith(`${jobStage}:`)) cache.delete(k);
    return;
  }
  cache.delete(`${jobStage}:${clientId}`);
}

module.exports = { getTemplate, fill, invalidate };
