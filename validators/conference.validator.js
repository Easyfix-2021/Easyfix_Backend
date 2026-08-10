const Joi = require('joi');

/*
 * Ops conference calling (Plivo Multi-Party Call) — request validators.
 *
 * ─── WHY THIS FILE EXISTS AT ALL, SEPARATELY ─────────────────────────────
 *
 * The obvious-looking move would have been to add a `customNumber` key to
 * `clickToCallBody` in validators/calls.validator.js and reuse it here. That
 * would be a privacy regression, and it is the single most important thing
 * about this file.
 *
 * `clickToCallBody`'s opening comment states the invariant the whole masking
 * model rests on:
 *
 *     "NO mobile number keys are accepted. The FE must supply only an
 *      identifier … if FE doesn't possess the unmasked number it can't
 *      accidentally send it."
 *
 * Because the 1:1 call schema accepts no number, an operator who can see only
 * `9988••••••` has no way to turn a masked number into a dialled one. Adding a
 * number key to that schema would reopen the loophole for EVERY existing
 * caller on EVERY existing call. So the custom-number capability lives HERE,
 * on the conference participant endpoint only, where it is a separate schema,
 * behind a separate permission key, rate-limited, and individually audited.
 *
 * DO NOT LOOSEN clickToCallBody. If a future feature needs a raw number, give
 * it its own schema the way this one does.
 *
 * ─── THE TWO ARMS ────────────────────────────────────────────────────────
 *
 *   ROSTER (default)  exactly one of jobId | efrId | spocJobId |
 *                     reportingContactId, optionally + useAlt. An IDENTIFIER;
 *                     the server resolves the digits from the job. The browser
 *                     never sends and never receives a number.
 *
 *   CUSTOM (gated)    customNumber, ten digits, `^[6-9]\d{9}$`. Mutually
 *                     exclusive with every roster key.
 *
 * `.xor(...)` across all five keys means EXACTLY ONE may be present — which is
 * precisely the "reject a custom number sent on the roster arm" rule, enforced
 * by the schema rather than by a handler branch someone can forget.
 *
 * ─── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────
 *
 *  • `customerId` — click-to-call has it; a conference participant does not.
 *    A participant must be reachable FROM THE JOB the conference is anchored
 *    to, and a bare customer id is not job-scoped: it would let an operator
 *    enumerate customer ids and conference in someone unrelated to the call.
 *    The route re-derives the roster from the conference's own job and
 *    refuses anything not on it — the schema simply never offers the shape.
 *
 *  • `callFrom` / `callTo` — the QA-mode override pair on clickToCallBody.
 *    Conference legs are always dialled from PLIVO_CALLER_ID to a
 *    server-resolved destination; there is no operator-supplied leg to
 *    override, so there is no QA arm to abuse.
 *
 *  • `provider` — conferencing is Plivo-only (Kaleyra is post-call-report
 *    only and has no live surface). Nothing to select between.
 */

const intId = Joi.number().integer().positive();

/*
 * Ten-digit Indian mobile, first digit 6-9. Copied rather than imported to
 * match the existing convention: the same constant is declared independently
 * in validators/client.validator.js:35 and validators/job.validator.js:28.
 *
 * Note this ALSO closes a masked-value round-trip: `customNumber` is not in
 * utils/mask-mobile.js's MOBILE_FIELDS, so middleware/reject-masked-mobile
 * would not catch a `9988••••••` sent back at this key — but the regex does,
 * because bullets are not digits.
 */
const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

/*
 * POST /api/admin/conferences — start.
 *
 * `jobId` is OPTIONAL by design. A conference normally hangs off a job, but an
 * ad-hoc ops call (a customer callback, a lookup with no job yet) has no job
 * and must still be recorded, capped and reaped. A job-less conference simply
 * has an EMPTY roster — see the route: with no job there is nothing to derive
 * a roster from, so only the custom-number arm can add anyone.
 */
const startConferenceBody = Joi.object({
  jobId: intId.optional(),
});

/*
 * POST /api/admin/conferences/:id/participants — add one party mid-call.
 *
 * The security boundary. Two independent checks have to pass and BOTH are
 * required — neither substitutes for the other:
 *
 *   1. THIS SCHEMA stops an operator TYPING a number. Free text is refused;
 *      the only number-shaped key is `customNumber`, which is format-checked
 *      here and permission-checked in the route.
 *   2. THE ROUTE stops an operator ENUMERATING ids. It re-derives the roster
 *      from the conference's own job and refuses any target that is not on it,
 *      so a valid-looking `efrId` for some other job's technician is a 400.
 *
 * A schema alone would let someone walk efr ids; a roster check alone would
 * let someone type digits. Both, or neither is worth having.
 */
const conferenceParticipantBody = Joi.object({
  // ── ROSTER ARM — identifiers only, same vocabulary as click-to-call ──
  //   jobId              → the job's customer (or their alternate, with useAlt)
  //   efrId              → the technician ASSIGNED TO THIS JOB
  //   spocJobId          → the SPOC captured on the job (tbl_job.client_spoc)
  //   reportingContactId → a contact of THIS JOB'S CLIENT (tbl_client_contacts)
  jobId:              intId,
  efrId:              intId,
  spocJobId:          intId,
  reportingContactId: intId,

  // Scopes the jobId arm to the customer's ALTERNATE number
  // (tbl_job.additional_number) instead of tbl_customer.customer_mob_no.
  // Same permissive coercion as clickToCallBody.useAlt so an FE encoding
  // slip cannot 400 a live call.
  useAlt: Joi.alternatives(
    Joi.boolean(),
    Joi.string().valid('true', 'false', '1', '0'),
    Joi.number().valid(0, 1),
  ).optional(),

  // ── CUSTOM ARM ──
  // No permission of its own: calling access IS conference access (owner
  // decision — see routes/admin/conferences.js). So this pattern is the FIRST
  // real constraint on the arm, not a convenience — with the roster bypassed,
  // what stops an arbitrary string reaching the dialler is exactly this line
  // plus the route's rate limit and audit. Rejected HERE, never in the UI.
  customNumber: Joi.string().pattern(INDIAN_MOBILE_REGEX).messages({
    'string.pattern.base': 'Enter a valid 10-digit Indian mobile number starting with 6, 7, 8 or 9.',
  }),

  // A human label for a custom number so the live panel shows "Landlord"
  // rather than a bare masked number. Roster rows take their name from the
  // database, so this is meaningless — and refused — on that arm.
  displayName: Joi.string().trim().max(120).optional(),
})
  .xor('jobId', 'efrId', 'spocJobId', 'reportingContactId', 'customNumber')
  .with('useAlt', 'jobId')
  .with('displayName', 'customNumber')
  .messages({
    'object.xor': 'Send exactly one of jobId, efrId, spocJobId, reportingContactId or customNumber.',
    'object.missing': 'Send exactly one of jobId, efrId, spocJobId, reportingContactId or customNumber.',
  });

/*
 * POST /api/admin/conferences/:id/end — hang the whole room up.
 *
 * Deliberately takes NO body. `end_reason` is written by the server as
 * 'operator', because that is the only reason this route can represent: an
 * operator pressed End. The other reasons in the column's vocabulary
 * (last_left, reaper, max_duration, error) are produced by the webhook and the
 * reaper, and letting a request name one would put a false story in the audit
 * trail — 'reaper' in particular is the metric that says a cost leak was
 * caught, so it must never be settable from outside.
 */
const endConferenceBody = Joi.object({});

module.exports = {
  startConferenceBody,
  conferenceParticipantBody,
  endConferenceBody,
  INDIAN_MOBILE_REGEX,
};
