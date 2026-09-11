const Joi = require('joi');

/*
 * In-app issue reporter validators — for routes/admin/issues.js.
 *
 * Conventions:
 *  - Lengths mirror migrations/2026-09-10-crm-issue-reporter.sql exactly. A
 *    Joi .max() looser than the column turns an operator typo into a MySQL
 *    1406 truncation error instead of a field-level 400.
 *  - `scope` and `status` are closed vocabularies; anything else is a 400, so
 *    the service never has to defend against an unknown value.
 *  - The CREATE body arrives as multipart/form-data whenever a screenshot is
 *    attached (see the route header for why it cannot be base64 JSON), so
 *    every field lands as a STRING. Joi's convert:true — set in
 *    middleware/validate.js — coerces them back, which is why nothing here
 *    needs a manual parse.
 */

/*
 * PATHNAME ONLY. Query strings in this CRM carry job and client ids
 * (?jobId=…, ?clientId=…), and an issue queue that every issue manager can
 * read must not become a side-channel listing which jobs a given user was
 * looking at. The strip happens HERE, at the trust boundary, rather than in
 * the service: this is the only writer of the column, so stripping once on the
 * way in means no reader anywhere has to remember to sanitise it, and the
 * stored value cannot disagree with the rule.
 *
 * Order matters — the fragment is cut before the query, because a URL may
 * carry `#/foo?bar=1` and cutting on '?' first would leave the fragment's own
 * query behind. Both are removed regardless of order of appearance.
 *
 * The result is truncated to the column width AFTER stripping, so a long query
 * string can never push the pathname out of the column.
 */
const pagePath = Joi.string().trim().max(2048).custom((value) => {
  const stripped = String(value).split('#')[0].split('?')[0].trim();
  return stripped.slice(0, 255);
}, 'strip-query-and-fragment');

const issueIdParam = Joi.object({
  issueId: Joi.number().integer().positive().required(),
});

const issueCreate = Joi.object({
  title:       Joi.string().trim().min(3).max(200).required(),
  description: Joi.string().trim().min(3).max(4000).required(),
  // Optional: a reporter may be on a page the FE could not resolve. Empty
  // string is accepted and normalised to null by the service — a multipart
  // form posts '' for an untouched field rather than omitting it.
  page_path:   pagePath.allow('').optional(),
});

const issueListQuery = Joi.object({
  // 'mine' is the default on purpose: the safe answer for a caller with no
  // grant, so a client that forgets the parameter gets its own issues rather
  // than a 403. 'all' is refused in the service unless the caller holds
  // isIssueManage — the check belongs there because that is where the
  // permission is already resolved.
  scope:  Joi.string().valid('mine', 'all').default('mine'),
  status: Joi.string().valid('open', 'closed').optional(),
  limit:  Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const issueCommentCreate = Joi.object({
  comment_text: Joi.string().trim().min(1).max(2000).required(),
});

const issueClose = Joi.object({
  close_note: Joi.string().trim().max(1000).allow('').optional(),
});

/*
 * REQUIRED, unlike close_note: a reopen with no reason puts a ticket back in
 * the queue with nothing for the manager to act on. 600, not comment_text's
 * 2000: the reopen comment also carries the close it undoes (up to ~1311 chars:
 * a 255-char name and a 1000-char close note), and all of it must fit
 * VARCHAR(2000). The CRM textareas use the same 600.
 */
const REOPEN_NOTE_MSG = 'Tell us what is still wrong';
const issueReopen = Joi.object({
  reopen_note: Joi.string().trim().min(1).max(600).required()
    .messages({ 'any.required': REOPEN_NOTE_MSG, 'string.empty': REOPEN_NOTE_MSG }),
});

module.exports = {
  issueIdParam,
  issueCreate,
  issueListQuery,
  issueCommentCreate,
  issueClose,
  issueReopen,
};
