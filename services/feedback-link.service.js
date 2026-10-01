/*
 * The customer feedback URL, in one place, so a template can carry ?t=.
 *
 * WHY THIS FILE EXISTS. /api/public/feedback/:jobId now accepts a signed,
 * job-bound token on ?t=, and FEEDBACK_TOKEN_REQUIRED=true will one day make it
 * mandatory. Nothing could produce such a link: no code in this repo built a
 * /feedback/ URL at all. This is that missing half.
 *
 * WHO ACTUALLY SENDS THE LINK — worth knowing before using this.
 * This backend's completion SMS (notification-orchestrator, TechVisitComplete)
 * appends mintFeedbackLink()'s URL, but ONLY while the property
 * `job.feedback_link.enabled` is 'true' — appending a URL changes a
 * DLT-registered body, so ops registers the new template first. With it off
 * (the default; unset on QA, 2026-09-30) that SMS carries no link, and the
 * link a customer holds comes from the legacy system OUTSIDE this codebase,
 * which signs with a different secret and cannot mint one of these tokens.
 *
 * So a tokenised link has to originate here. mintFeedbackLink() is what any
 * sender in this repo calls, and feedbackUrl() is the shape to give whoever
 * owns a template elsewhere.
 *
 * BOTH FLAG STATES WORK, DELIBERATELY. A URL from here carries ?t= and is
 * accepted whether FEEDBACK_TOKEN_REQUIRED is on or off; a legacy URL without
 * ?t= keeps working while it is off. That is what makes the cutover a flag flip
 * rather than a coordinated release.
 */
const { signFeedbackToken } = require('../utils/jwt');

/*
 * Same base and same trailing-slash handling as magicLinkUrl(), so the two
 * customer-facing links cannot end up on different hosts after an env change.
 */
function feedbackBase() {
  return (process.env.MAGIC_LINK_BASE_URL || 'https://qa.easyfix.in').replace(/\/$/, '');
}

/** The page route the client portal serves at /feedback/[jobId]. */
function feedbackUrl(jobId, token) {
  const base = `${feedbackBase()}/feedback/${Number(jobId)}`;
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}

/**
 * mintFeedbackLink(jobId) → { token, url }
 *
 * The token is bound to this jobId and the route rejects a mismatch, so one
 * customer's link cannot be pointed at another customer's job.
 */
function mintFeedbackLink(jobId) {
  const token = signFeedbackToken({ jobId });
  return { token, url: feedbackUrl(jobId, token) };
}

module.exports = { feedbackUrl, mintFeedbackLink };
