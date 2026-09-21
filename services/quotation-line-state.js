/*
 * quotation-line-state — the SINGLE owner of "what state is this
 * quotation_details line in". Material Request Flow v2 (2026-09-21). See
 * docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md
 * ("State model").
 *
 * A quotation_details row moves through exactly one of six states, derived —
 * never stored — from four existing/new columns:
 *
 *   draft            sent_on IS NULL
 *   review_pending   sent_on IS NOT NULL AND action_on IS NULL
 *   rejected         action_on IS NOT NULL AND CAST(status AS UNSIGNED) = 0
 *   approval_pending action_on IS NOT NULL AND status = 1 AND client_status IS NULL
 *   client_approved  client_status = 1
 *   client_rejected  client_status = 0
 *
 * `status` is bit(1) — always CAST(status AS UNSIGNED). `client_status` is
 * TINYINT — db.js's typeCast coerces a bare TINYINT to a boolean, so every
 * SELECT of it must also CAST(... AS SIGNED/UNSIGNED). quotationLineState()
 * below assumes the CALLER already did that casting (SQL-side); it does not
 * re-guess a boolean back into 0/1/null.
 *
 * ONE place owns this so the mobile quotation list, the admin quotations
 * list, the admin Material Review completeness check, and the job-level
 * material_state/material_count aggregate (services/job.service.js) can never
 * silently disagree about what "review_pending" means. tests/quotation-line-
 * state.test.js's guard test fails the build if a second copy of the state
 * labels turns up anywhere else in services/ or routes/.
 */

const STATE = {
  DRAFT: 'draft',
  REVIEW_PENDING: 'review_pending',
  REJECTED: 'rejected',
  APPROVAL_PENDING: 'approval_pending',
  CLIENT_APPROVED: 'client_approved',
  CLIENT_REJECTED: 'client_rejected',
};

// The technician-editable states (add/edit/delete allowed while the job's own
// status permits it — see the design's "Locks"). Also exactly the set
// material_count sums over ("count of lines in draft / review_pending /
// approval_pending").
const OPEN_STATES = [STATE.DRAFT, STATE.REVIEW_PENDING, STATE.APPROVAL_PENDING];

// The states a technician may still write to (add a line as a sibling of, or
// delete). Deliberately NOT the same list as OPEN_STATES: approval_pending
// (client already has it) is open for COUNTING purposes but locked for tech
// WRITES — see assertTechLineEditable below.
const TECH_EDITABLE_STATES = [STATE.DRAFT, STATE.REVIEW_PENDING];

/*
 * The raw SQL boolean for one state, over the given table alias. Every other
 * SQL fragment in this file is built ONLY from these — never a hand-written
 * duplicate of the predicate.
 */
function statePredicateSql(alias, state) {
  switch (state) {
    case STATE.DRAFT:
      return `${alias}.sent_on IS NULL`;
    case STATE.REVIEW_PENDING:
      return `${alias}.sent_on IS NOT NULL AND ${alias}.action_on IS NULL`;
    case STATE.REJECTED:
      return `${alias}.action_on IS NOT NULL AND CAST(${alias}.status AS UNSIGNED) = 0`;
    case STATE.APPROVAL_PENDING:
      return `${alias}.action_on IS NOT NULL AND CAST(${alias}.status AS UNSIGNED) = 1 AND ${alias}.client_status IS NULL`;
    case STATE.CLIENT_APPROVED:
      return `${alias}.client_status = 1`;
    case STATE.CLIENT_REJECTED:
      return `${alias}.client_status = 0`;
    default:
      throw new Error(`quotation-line-state: unknown state "${state}"`);
  }
}

/*
 * A CASE expression (no trailing alias — callers write `AS state`) that
 * evaluates to the line's state. client_status is checked first: once the
 * client has decided, that decision is final regardless of what action_on/
 * status still say. Order otherwise doesn't change the result — each
 * predicate above is already mutually exclusive with the others by
 * construction — but client-first reads as "the client's word is final".
 */
function quotationLineStateSql(alias = 'qd') {
  const order = [
    STATE.CLIENT_APPROVED, STATE.CLIENT_REJECTED,
    STATE.REJECTED, STATE.APPROVAL_PENDING, STATE.REVIEW_PENDING,
  ];
  const whens = order
    .map((s) => `WHEN ${statePredicateSql(alias, s)} THEN '${s}'`)
    .join('\n    ');
  return `CASE\n    ${whens}\n    ELSE '${STATE.DRAFT}'\n  END`;
}

/* "Is this row in one of `states`?" as a single OR'd SQL boolean. */
function anyStateSql(alias, states) {
  return states.map((s) => `(${statePredicateSql(alias, s)})`).join('\n       OR ');
}

/* The material_count predicate — draft + review_pending + approval_pending. */
function openLineSql(alias = 'qd') {
  return anyStateSql(alias, OPEN_STATES);
}

/*
 * JS mirror of quotationLineStateSql, for code that already has the row (a
 * fake-pool test, a post-UPDATE re-check, a bulk-delete loop) and would rather
 * not round-trip through SQL to know a line's state.
 *
 * `line.status` / `line.client_status` must already be Number|null (CAST'd
 * SQL-side, or a plain JS value in a test fixture) — NOT a raw TINYINT
 * boolean. `sent_on` / `action_on` are Date|string|null; only nullishness is
 * examined.
 */
function quotationLineState(line) {
  const status = line.status == null ? null : Number(line.status);
  const clientStatus = line.client_status == null ? null : Number(line.client_status);
  if (clientStatus === 1) return STATE.CLIENT_APPROVED;
  if (clientStatus === 0) return STATE.CLIENT_REJECTED;
  if (line.action_on != null) return status === 0 ? STATE.REJECTED : STATE.APPROVAL_PENDING;
  if (line.sent_on != null) return STATE.REVIEW_PENDING;
  return STATE.DRAFT;
}

function isTechEditable(state) {
  return TECH_EDITABLE_STATES.includes(state);
}

module.exports = {
  STATE,
  OPEN_STATES,
  TECH_EDITABLE_STATES,
  statePredicateSql,
  quotationLineStateSql,
  anyStateSql,
  openLineSql,
  quotationLineState,
  isTechEditable,
};
