const scheduler = require('../server/scheduler');
const { getProperty } = require('./properties.service');
const logger = require('../logger');

/*
 * Scheduled Jobs admin surface (2026-06-06).
 *
 * Tiny shim over server/scheduler.js — its primary job is keeping the
 * route handler free of scheduler internals AND owning the
 * email-allowlist gate that both the route AND the /auth/me payload
 * consume (so the FE can show/hide the sidebar entry by the same
 * rule the BE uses to gate the endpoints).
 */

const PROPERTY_KEY = 'scheduled.jobs.visible.emails';

/*
 * Parse the comma-separated email allowlist from `easyfix_properties`.
 * Returns a lower-cased Set for O(1) membership checks. Empty when
 * the property is unset / blank.
 */
function getAllowedEmails() {
  const raw = String(getProperty(PROPERTY_KEY) ?? '').trim();
  if (!raw) return new Set();
  return new Set(
    raw.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/*
 * Is this user's official email present in the allowlist? Treats every
 * comparison as case-insensitive (email RFC says local-part *may* be
 * case-sensitive but every real-world provider normalises to lowercase;
 * matching the property's normalisation is the pragmatic call).
 *
 * `user` is a `tbl_user` row — typically `req.user` from the auth
 * middleware. Falsy / missing email → false.
 */
function isAllowedUser(user) {
  if (!user || !user.official_email) return false;
  const email = String(user.official_email).trim().toLowerCase();
  if (!email) return false;
  return getAllowedEmails().has(email);
}

/* Pass-through to the scheduler's public projection. */
function list() {
  logger.info('List scheduled jobs');
  return scheduler.getJobs();
}

/* Pass-through to the scheduler's manual trigger. */
async function trigger(id) {
  logger.info('Trigger scheduled job · id=' + id);
  return scheduler.triggerJob(id);
}

/*
 * Pass-through to the scheduler's TEST send (2026-06-06). Distinct from
 * trigger() because the test path dispatches a single message to an
 * operator-typed mobile (never to the original recipient) instead of
 * running the full eligibility loop. Throws 400 from the scheduler if
 * the targeted job didn't register a tester closure.
 */
async function test(id, opts) {
  logger.info('Test scheduled job (single send) · id=' + id);
  return scheduler.testJob(id, opts);
}

module.exports = {
  PROPERTY_KEY,
  getAllowedEmails,
  isAllowedUser,
  list,
  trigger,
  test,
};
