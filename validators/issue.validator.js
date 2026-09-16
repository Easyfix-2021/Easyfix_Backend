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
 * PATH AND QUERY, fragment dropped (owner, 2026-09-16: "capture the page URL
 * from where the issue is reported").
 *
 * Until now this kept the PATHNAME ONLY, on purpose: query strings in this CRM
 * carry job and client ids (?jobId=…, ?clientId=…), and an issue queue that
 * every issue manager can read must not become a side-channel listing which
 * jobs a given user was looking at. That trade-off is now decided the other
 * way, deliberately: `/my-orders?tab=pending-start&action=reassign&jobId=509493`
 * IS the reproduction — which tab, which modal, which job — and a path alone
 * sent every triager back to the reporter to ask. The audience is the three
 * named managers behind the two-lock gate (services/issue.service.js
 * resolveActor), not every CRM user.
 *
 * The strip still happens HERE, at the trust boundary, for the same reason as
 * before: this is the only writer of the column, so one rule on the way in is
 * the whole rule. The fragment goes because nothing in this CRM routes on it.
 *
 * THE COLUMN IS STILL VARCHAR(255) and the slice below keeps that true. A
 * filter URL carrying a 400-id CSV will lose its tail rather than 500 the
 * report; widening the column is a migration with a deploy-order hazard on
 * this very table (see project memory) and is a separate, deliberate step.
 */
const pagePath = Joi.string().trim().max(2048).custom((value) => {
  const noFragment = String(value).split('#')[0].trim();
  return noFragment.slice(0, 255);
}, 'strip-fragment');

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
