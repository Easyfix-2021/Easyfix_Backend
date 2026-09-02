const router = require('express').Router();
const Joi = require('joi');

const requireAuth = require('../middleware/auth');
const validate = require('../middleware/validate');
const { rateLimit } = require('../middleware/rate-limit');
const { pool } = require('../db');
const { modernOk, modernError } = require('../utils/response');
const logger = require('../logger');
const selfService = require('../services/profile-self.service');
const requestService = require('../services/profile-update-request.service');

/*
 * /api/profile — HRMS "My Profile", the SELF-SERVICE surface.
 *
 * ── THE SECURITY BOUNDARY ───────────────────────────────────────────────
 * Every route here acts on `req.user.user_id` and NOTHING ELSE. There is no
 * :userId in any path, no user id accepted in any body, and no id read from the
 * query string. That is not a style choice: unlike /api/admin/users, which is
 * gated to the admin role group, this router is reachable by EVERY
 * authenticated CRM user. A single id parameter anywhere on this surface would
 * turn "edit my own bank details" into "edit anyone's bank details".
 *
 * The one id that does appear — DELETE /update-requests/:id — is a REQUEST id,
 * and the service scopes the DELETE with `AND user_id = ?` in the statement, so
 * another user's request id matches nothing.
 *
 * ── WHY NOT UNDER /api/admin ────────────────────────────────────────────
 * /api/admin/* carries role(['admin']) plus scope resolution plus mobile
 * masking, all of which are wrong here: the surface is for every user, there is
 * no row-level scope to apply (there is one row and it is yours), and the
 * caller must be able to READ THEIR OWN mobile number to change it.
 *
 * ── WHAT NEEDS APPROVAL ─────────────────────────────────────────────────
 *   alternate_no    direct write, no approval (a convenience contact)
 *   date_of_birth   ONE free set while NULL, then approval
 *   mobile_no       always approval (it is a login identity)
 *   bank            always approval (it is where money goes)
 */

router.use(requireAuth);

/*
 * CRM principals only. requireAuth also resolves TECHNICIAN bearers (subject
 * `efr:<id>`), which live in tbl_easyfixer and have no tbl_user row at all —
 * their `user_id` is the string 'efr:12'. Left unguarded, every statement here
 * would coerce that to 0 and quietly read or write user_id 0. Technicians have
 * their own profile surface under /api/mobile.
 */
router.use((req, res, next) => {
  const id = Number(req.user && req.user.user_id);
  if (req.user?.__principal === 'mobile' || !Number.isInteger(id) || id <= 0) {
    return modernError(res, 403, 'this profile surface is for CRM users only');
  }
  // The ONLY id any handler below is allowed to use.
  req.profileUserId = id;
  return next();
});

/*
 * Services throw { status, code, message }. Surface the status plus the machine
 * code the FE branches on (DOB_ALREADY_SET drives the switch from the direct
 * write to the request form); anything without a status is a real bug and goes
 * to the central handler as a 500.
 */
function fail(res, next, e, what) {
  if (e && e.status) {
    logger.warn(what + ' failed · ' + e.message);
    return modernError(res, e.status, e.message, e.code ? { code: e.code } : undefined);
  }
  return next(e);
}

// ─── READ ────────────────────────────────────────────────────────────
router.get('/details', async (req, res, next) => {
  try {
    const data = await selfService.getMyProfile(req.profileUserId, pool);
    modernOk(res, data);
  } catch (e) { fail(res, next, e, 'Load my profile'); }
});

// ─── DIRECT WRITES ───────────────────────────────────────────────────
/*
 * Joi here checks SHAPE. The value rules live in profile-self.service so
 * submission and approve-time re-validation cannot drift apart — see the note
 * at the top of that file.
 *
 * The pattern is the canonical /^[6-9][0-9]{9}$/ (see services/profile-self.service.js),
 * NOT the frontend's tighter INDIAN_MOBILE_REGEX /^[6-9]\d{9}$/: the existing
 * routes/admin/users.js create/update path uses the looser one, and two backend
 * surfaces disagreeing about what a valid number is means a number Add User
 * accepts that self-service rejects.
 *
 * '' and null are explicitly allowed. alternate_no is an optional column that
 * the create path already lets through empty, so CLEARING a stale number must
 * not require an approval workflow — the service maps blank to NULL.
 */
const alternateNoBody = Joi.object({
  alternate_no: Joi.string().trim().pattern(/^[6-9][0-9]{9}$/).allow('', null).required(),
});

router.patch('/alternate-no', validate(alternateNoBody), async (req, res, next) => {
  try {
    const data = await selfService.setAlternateNo(req.profileUserId, req.body.alternate_no, pool);
    modernOk(res, data, 'Alternate Number Updated');
  } catch (e) { fail(res, next, e, 'Update alternate number'); }
});

/*
 * Personal email — a direct write. `.allow('', null)` because clearing it is a
 * legitimate action, and the service maps blank to NULL. Shape only: the real
 * rule (format, and the ban on our own company domains) is
 * normalisePersonalEmail, called by the service.
 */
const personalEmailBody = Joi.object({
  personal_email: Joi.string().trim().max(255).allow('', null).required(),
});

router.patch('/personal-email', validate(personalEmailBody), async (req, res, next) => {
  try {
    const data = await selfService.setPersonalEmail(req.profileUserId, req.body.personal_email, pool);
    modernOk(res, data, 'Personal Email Updated');
  } catch (e) { fail(res, next, e, 'Update personal email'); }
});

const dobBody = Joi.object({
  date_of_birth: Joi.string().trim().required(),
});

// The ONE free set. 409 DOB_ALREADY_SET ⇒ the FE sends the user to the
// request form instead. The "only once" is enforced in SQL, not by a
// read-then-write — see setDateOfBirthOnce.
router.post('/date-of-birth', validate(dobBody), async (req, res, next) => {
  try {
    const data = await selfService.setDateOfBirthOnce(req.profileUserId, req.body.date_of_birth, pool);
    modernOk(res, data, 'Date Of Birth Saved');
  } catch (e) { fail(res, next, e, 'Set date of birth'); }
});

// ─── APPROVAL REQUESTS ───────────────────────────────────────────────
/*
 * Submit MERGES into the caller's open pending request (or creates one). It
 * NEVER 409s on "you already have a request" — accumulating is the model.
 *
 * The three keys are named in the schema so `stripUnknown` cannot silently
 * discard a whole payload, but their inner types stay permissive: the service
 * owns "what a valid mobile / DOB / bank is", including rejecting an empty
 * `changes` object.
 */
const submitBody = Joi.object({
  changes: Joi.object({
    mobile_no:     Joi.string().trim(),
    date_of_birth: Joi.string().trim(),
    bank: Joi.object({
      account_number: Joi.string().trim(),
      ifsc:           Joi.string().trim(),
      account_name:   Joi.string().trim(),
      bank_name:      Joi.string().trim(),
    }),
  }).required(),
});

router.post('/update-requests', validate(submitBody), async (req, res, next) => {
  try {
    const data = await requestService.submitChanges(req.profileUserId, req.body.changes, pool);
    modernOk(res, data, data.merged ? 'Request Updated' : 'Request Submitted');
  } catch (e) { fail(res, next, e, 'Submit profile update request'); }
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

router.delete('/update-requests/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await requestService.withdrawRequest(req.profileUserId, req.params.id, pool);
    modernOk(res, data, 'Request Withdrawn');
  } catch (e) { fail(res, next, e, 'Withdraw profile update request'); }
});

// ─── REVEAL ──────────────────────────────────────────────────────────
/*
 * POST /bank/reveal — the caller's OWN account number and holder name, in full.
 *
 * ── WHAT THIS DOES AND DOES NOT ACHIEVE ─────────────────────────────────
 * A value the browser DISPLAYS must reach the browser, so once someone clicks
 * "reveal" it is in their devtools. That is a property of the web, not of this
 * design, and any scheme that "hides" it — encrypting the response, obfuscating
 * the payload — ships the key to the same tab and buys the appearance of safety
 * only. We do not build that.
 *
 * What is genuinely achieved, and is the reason this route exists at all:
 *   • the value is NEVER in a list, a detail response or the profile payload —
 *     everything else is masked by default (see maskBank);
 *   • it crosses the wire ONLY on a deliberate click, one record at a time;
 *   • the response is no-store, so it does not sit in the disk cache;
 *   • the reveal is attributable afterwards, in tbl_sensitive_reveal_log.
 * Not in the network tab as a matter of routine; in it at the moment someone
 * chose to look, with their name on the row.
 *
 * POST rather than GET even though it reads: a GET lands in browser history,
 * proxy logs and prefetchers, and it would be trivially triggerable from an
 * <img src>. It also HAS a side effect — the audit row.
 */
const noStore = (_req, res, next) => {
  // Belt and braces: `no-store` is the directive that keeps it out of the disk
  // cache; the other two are for intermediaries that predate it.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
};

/*
 * Keyed on the CALLER, not the IP — an office NATs to one address and the thing
 * being bounded is a person clicking a button. Instantiated ONCE at module
 * scope: rateLimit() closes over its own Map, so building it per request would
 * cap nothing.
 *
 * Generous, because this is the user's OWN record and the cap is here to stop a
 * stuck retry loop from filling the audit log, not to ration a legitimate look.
 * The admin route's limit is the tighter one — that is where the reveal is of
 * someone ELSE's details.
 */
const selfRevealLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  key: (req) => `profile-bank-reveal:${(req.user && req.user.user_id) || req.ip}`,
});

/*
 * The address the audit row records. `req.ip` already honours Express's trust-proxy
 * setting, so it is the right value behind the load balancer; the raw socket address
 * is the fallback for a direct hit. Never throws and never blocks the reveal — an
 * audit row with a missing address is a worse row, but a reveal that fails because
 * the address could not be read is a worse outcome.
 */
function clientIp(req) {
  try {
    return req.ip || (req.connection && req.connection.remoteAddress) || null;
  } catch { return null; }
}

router.post('/bank/reveal', selfRevealLimiter, noStore, async (req, res, next) => {
  try {
    const data = await selfService.revealOwnBank(req.profileUserId, pool, clientIp(req));
    modernOk(res, data);
  } catch (e) { fail(res, next, e, 'Reveal own bank details'); }
});

module.exports = router;
