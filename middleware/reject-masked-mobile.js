/*
 * reject-masked-mobile.js — defensive middleware against round-trip
 * corruption of mobile fields.
 *
 * Background: `utils/mask-mobile.js` rewrites every MOBILE_FIELDS key in
 * outbound /admin/* responses to "first 4 digits + bullets". If the FE
 * ever sends one of those masked strings BACK to the BE (because a form
 * was prefilled from a non-`unmasked=true` fetch and submitted as-is),
 * the BE would happily store "7470••••••" into the tbl_job /
 * tbl_customer / tbl_easyfixer mobile column — silent data corruption
 * that's impossible to recover from (the bullets erase the real digits).
 *
 * This middleware is the wire-level guard. It walks the incoming
 * req.body and rejects (400) ANY string at a known MOBILE_FIELDS key
 * that contains the bullet character `•` (U+2022). A clear error
 * surfaces in the FE so the bug gets noticed instantly during dev/QA
 * instead of silently writing junk to prod.
 *
 * Idempotent + cheap — runs once per request, walks one body, depth-
 * bounded by JSON shape (no cycles).
 *
 * Mount: globally before /admin/* validators so per-route Joi schemas
 * see clean input. NOT applied to /integration/v1/* (legacy clients
 * pass full numbers; no masking involved).
 */

const { MOBILE_FIELDS } = require('../utils/mask-mobile');
const { redactUrl } = require('../utils/log-format');

const BULLET = '•'; // •

function findMaskedMobileFields(node, path = '', hits = []) {
  if (node == null) return hits;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      findMaskedMobileFields(node[i], path + '[' + i + ']', hits);
    }
    return hits;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const childPath = path ? path + '.' + k : k;
      if (MOBILE_FIELDS.has(k) && typeof v === 'string' && v.includes(BULLET)) {
        hits.push({ field: childPath, value: v });
      } else if (v && typeof v === 'object') {
        findMaskedMobileFields(v, childPath, hits);
      }
    }
  }
  return hits;
}

function rejectMaskedMobileMiddleware(req, res, next) {
  // Only inspect mutating verbs — GETs don't carry a body.
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') {
    return next();
  }
  if (!req.body || typeof req.body !== 'object') return next();

  const hits = findMaskedMobileFields(req.body);
  if (hits.length === 0) return next();

  // Log the violation so ops + dev can trace WHICH FE flow leaked.
  // We log the field path + the route, not the raw bulleted value — the
  // bulleted form is already trivially derivable from the field name.
  const logger = require('../logger');
  logger.warn(
    {
      // This guard fires on mobile-number handling, so the URL is the last place
      // an unredacted number should survive.
      route: redactUrl(req.originalUrl),
      method: req.method,
      fields: hits.map((h) => h.field),
      actor: req.user?.user_id || req.tech?.efr_id || req.spoc?.id || 'unknown',
    },
    'Rejected request: masked mobile value in mutable payload',
  );

  return res.status(400).json({
    success: false,
    error: 'Masked mobile value cannot be persisted',
    details: hits.map((h) => ({
      field: h.field,
      message:
        'This field contains a masked value (bullets). The original digits ' +
        'have been lost in display. Refetch the source record with ' +
        '?unmasked=true to get the real number, or omit this field from the ' +
        'request to leave the stored value untouched.',
    })),
  });
}

module.exports = rejectMaskedMobileMiddleware;
