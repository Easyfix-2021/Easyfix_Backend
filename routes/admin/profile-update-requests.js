const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { rateLimit } = require('../../middleware/rate-limit');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const requestService = require('../../services/profile-update-request.service');
const { REQUEST_STATUSES, MAX_PAGE_SIZE } = requestService;

/*
 * /api/admin/profile-update-requests — HRMS → Approvals, the HR queue.
 *
 * The approval side of the self-service profile surface (/api/profile). A user
 * submits ONE accumulating pending request holding whichever of mobile_no /
 * date_of_birth / bank they want changed; HR sees one row per user and approves
 * or rejects the whole thing.
 *
 * Mount inherits requireAuth + role(['admin']) + scope + mask from
 * routes/admin/index.js. On top of that each route carries its own ACTION KEY,
 * the same pattern every other gated admin surface uses:
 *   isProfileApprovalView     — see the queue
 *   isProfileApprovalProcess  — approve / reject
 * Seeded on menu_action and granted to role_id 2 by the HRMS RBAC migration.
 *
 * ── A NOTE ON MOBILE MASKING ────────────────────────────────────────────
 * `changes` / `old_values` carry a `mobile_no` KEY, and middleware/mask-mobile
 * walks responses by key name, so a requested mobile ships to the approver as
 * "9876••••••" by default. That is the house posture for STAFF numbers (they
 * are masked even when the customer-number visibility flag is on), and the
 * approval decision does not depend on the last six digits — the value applied
 * is the stored one, not anything the approver retypes. When HR does need to
 * read it in full, the standard, already-audited escape hatch applies: the FE
 * appends `?unmasked=true`, exactly as the Edit User form does.
 */

const listQuery = Joi.object({
  status: Joi.string().valid(...REQUEST_STATUSES).optional(),
  q:      Joi.string().trim().max(100).allow('', null).optional(),
  // 1-INDEXED, like every other admin list route.
  page:   Joi.number().integer().min(1).default(1),
  // Ceiling MUST stay in sync with the service clamp AND with what the FE
  // TablePagination "All" option sends — pass this same number to
  // pageSizeToLimit(pageSize, 1000) there, or "All" silently truncates.
  limit:  Joi.number().integer().min(1).max(MAX_PAGE_SIZE).default(20),
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const processBody = Joi.object({
  action:  Joi.string().valid('approve', 'reject').required(),
  remarks: Joi.string().trim().max(255).allow('', null).optional(),
});

// ─── LIST ────────────────────────────────────────────────────────────
router.get('/',
  requireAction('isProfileApprovalView'),
  validate(listQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('List profile update requests · status=' + (req.query.status ?? 'all')
        + ' q=' + (req.query.q ?? '-') + ' page=' + req.query.page);
      const data = await requestService.listRequests(req.query, pool);
      modernOk(res, data);
    } catch (e) { next(e); }
  },
);

// ─── PROCESS (approve / reject) ──────────────────────────────────────
/*
 * Approve APPLIES every field in `changes` and flips the status in ONE
 * transaction — see processRequest for the full shape. Reject writes only the
 * status; the requested values are never applied.
 */
router.post('/:id/process',
  requireAction('isProfileApprovalProcess'),
  validate(idParam, 'params'),
  validate(processBody),
  async (req, res, next) => {
    try {
      logger.info('Process profile update request · id=' + req.params.id
        + ' action=' + req.body.action + ' actor=' + (req.user?.user_id ?? '-'));
      const row = await requestService.processRequest(
        Number(req.params.id), req.body, req.user, pool,
      );
      modernOk(res, row, req.body.action === 'approve' ? 'Request Approved' : 'Request Rejected');
    } catch (e) {
      // The service throws { status, code, message } for every safety reject
      // (409 ALREADY_PROCESSED on a double-approve, 409 MOBILE_TAKEN when the
      // number was claimed between submit and approve, 409 CHANGES_INVALID_NOW,
      // 404). Surface the status + a machine code the FE branches on; anything
      // else is a genuine bug and falls through to the central handler.
      if (e.status) {
        logger.warn('Process profile update request failed · id=' + req.params.id
          + ' · ' + e.message);
        return modernError(res, e.status, e.message, e.code ? { code: e.code } : undefined);
      }
      next(e);
    }
  },
);

// ─── REVEAL (audited) ────────────────────────────────────────────────
/*
 * POST /:id/reveal — the bank values inside ONE request, decrypted.
 *
 * ── WHY isProfileApprovalProcess AND NOT isProfileApprovalView ──────────
 * Seeing the queue and reading a colleague's account number are different
 * privileges, and the queue is legitimately the wider grant — a reviewer or a
 * reporting user can be given the list without ever being handed a payment
 * instruction. APPROVING is what actually needs the number: the approver has to
 * check it against whatever the employee sent them before writing it onto a
 * record that money is paid from. So the reveal rides on the process key.
 *
 * ── WHAT CROSSES THE WIRE, AND WHEN ─────────────────────────────────────
 * Nothing, by default. The list and the process response return
 * '••••1234' / 'A•••• K••••' (services/profile-update-request.service::hydrate),
 * and the ciphertext is never shipped either — "it is encrypted" is not a reason
 * to hand a browser a decryptable secret. The full values exist in exactly one
 * response, produced by exactly one deliberate click, which lands one row in
 * tbl_sensitive_reveal_log naming the approver and the employee.
 *
 * That row is the control. Encryption stops the DATABASE being the leak; it can
 * do nothing about an authorised person reading colleagues' account numbers
 * through the screen built to show them, because that is indistinguishable from
 * the approval it exists to support. Attribution afterwards is what makes it
 * visible.
 *
 * POST rather than GET: a GET lands in browser history and proxy logs, is
 * triggerable from an <img src>, and this call HAS a side effect — the audit row.
 */
const noStore = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
};

/*
 * Tighter than the self-service limiter in routes/profile.js, deliberately:
 * this one reveals SOMEONE ELSE'S details. Ten a minute is comfortably above
 * any real approval rate and well below "export the directory one click at a
 * time". Keyed on the OPERATOR, not the IP — an office NATs to one address and
 * what is being bounded is a person. Instantiated ONCE at module scope;
 * rateLimit() closes over its own Map, so a per-request instance caps nothing.
 */
const revealLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  key: (req) => `hrms-request-reveal:${(req.user && req.user.user_id) || req.ip}`,
});

/* Same contract as the self route's helper — see routes/profile.js. */
function adminClientIp(req) {
  try {
    return req.ip || (req.connection && req.connection.remoteAddress) || null;
  } catch { return null; }
}

router.post('/:id/reveal',
  requireAction('isProfileApprovalProcess'),
  revealLimiter,
  noStore,
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const data = await requestService.revealRequestBank(
        Number(req.params.id), req.user, pool, adminClientIp(req),
      );
      modernOk(res, data);
    } catch (e) {
      if (e.status) {
        logger.warn('Reveal profile update request bank failed · id=' + req.params.id
          + ' · ' + e.message);
        return modernError(res, e.status, e.message, e.code ? { code: e.code } : undefined);
      }
      next(e);
    }
  },
);

module.exports = router;
