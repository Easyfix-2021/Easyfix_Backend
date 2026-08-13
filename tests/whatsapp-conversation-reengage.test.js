/*
 * handleInbound's NO-ACTIVE-CONVERSATION path:
 *   (a) it must say WHICH of four situations it is in, and
 *   (b) exactly one of them — an expired session — must get a reply, and that
 *       reply must be FREE-FORM, never a template.
 *
 * WHY THIS FILE EXISTS
 *
 * `reason=no_active_conversation` covered four causes that need four different
 * responses (never started / expired / completed / closed as no-service) and
 * distinguished none of them. During the 2026-08 inbound incident that ambiguity
 * cost four wrong turns — the real cause was an envelope bug in
 * routes/webhook/whatsapp.js, but twice the log line supported the wrong
 * conclusion first. So the four cases are pinned here INDIVIDUALLY: if a future
 * refactor collapses them back into one string, these tests fail.
 *
 * WHY FREE-FORM IS THE THING UNDER TEST
 *
 * Meta's 24h customer service window OPENS on a customer message. We are
 * replying WHILE HANDLING THEIR INBOUND, so free-form is deliverable and a
 * template is not required. An earlier cut of this feature sent the magic-link
 * TEMPLATE via jml.sendForJob, which consumes the per-client "Max Magic-Link
 * Send Count" — burning the client's outreach budget BECAUSE THE CUSTOMER TEXTED
 * US, and letting a chatty customer drain the quota meant for other jobs. So the
 * assertions below run in BOTH directions: sendText WAS called, and no template
 * path was. "We send something" is not the property that matters here.
 *
 * The rest pins the guards on that send. Each exists to stop a specific way of
 * messaging the wrong person:
 *   • completed / closed_no_service — the customer already reached a decision;
 *     re-opening it is spam and undoes that decision.
 *   • job no longer status 9 — nothing left to confirm; the link is nonsense.
 *   • once per conversation row — five inbounds must produce one reply, so the
 *     once-only test drives handleInbound TWICE against one fixture rather than
 *     inspecting the marker.
 *   • no link → NO MESSAGE. Telling a customer to tap something that is not
 *     there is worse than silence.
 *   • a throwing send (provider down) must never reach the webhook, which has to
 *     keep answering 200.
 *
 * The last section drives jml.sendForJob itself: the link sequence it used to
 * carry inline now lives in buildShortLinkForJob, and the path this feature does
 * NOT own must be unchanged by that extraction.
 *
 * No DB, no network: fake pool + stubbed senders, same harness as
 * tests/whatsapp-conversation.test.js. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-reengage';

const convo = require('../services/whatsapp-conversation.service');
const jml = require('../services/job-magic-link.service');
const gallabox = require('../services/gallabox.whatsapp.service');
const urlShortener = require('../services/url-shortener.service');
const jobComment = require('../services/job-comment.service');

const MOBILE = '919876543210';
const SHORT_LINK = 'https://qa.easyfix.in/book/abc123';
const INBOUND = { from: MOBILE, type: 'text', text: 'sorry, only seeing this now — is the technician still coming?', messageId: 'wamid.1' };

// The two queries the diagnosis path owns, matched on their own shapes.
const RE_ACTIVE_LOOKUP = /SELECT \* FROM tbl_whatsapp_conversation/;
const RE_DIAGNOSIS     = /SELECT conversation_id, job_id, status/;
const RE_JOB_STATUS    = /SELECT job_status FROM tbl_job/;
const RE_CLAIM         = /JSON_SET/;

/*
 * One harness for every outbound seam this path can touch:
 *   text     — the free-form reply, the ONLY one that may fire
 *   link     — job-magic-link's link builder (the single mint/shorten site)
 *   template — jml.sendForJob AND gallabox.sendTemplate, both TRIPWIRES. They
 *              record instead of asserting so each test can state the negative
 *              in its own words, next to the positive it pairs with.
 *   comment  — the CRM-visible audit stamp. Stubbed for EVERY test, not just
 *              the two that assert on it: job-comment.service captures the real
 *              db singleton at require time, so leaving it live would have this
 *              file open a socket to prod on the happy path.
 * `impl` on text/link/comment lets a test make the seam fail the way the real
 * one does.
 */
function stubOutbound({ link, text, comment } = {}) {
  const textSent = [];
  const linkCalls = [];
  const templateCalls = [];
  const comments = [];
  const originals = {
    sendText: gallabox.sendText,
    sendTemplate: gallabox.sendTemplate,
    buildShortLinkForJob: jml.buildShortLinkForJob,
    sendForJob: jml.sendForJob,
    addComment: jobComment.addComment,
  };

  gallabox.sendText = async (args) => {
    textSent.push(args);
    if (text) return await text(args);
    return { delivered: true };
  };
  gallabox.sendTemplate = async (args) => { templateCalls.push({ via: 'gallabox.sendTemplate', args }); return { delivered: true }; };
  jml.sendForJob = async (jobId, opts, pool) => { templateCalls.push({ via: 'jml.sendForJob', jobId, opts, pool }); return { delivered: true }; };
  jml.buildShortLinkForJob = async (jobId, pool) => {
    linkCalls.push({ jobId, pool });
    if (link) return await link(jobId, pool);
    return SHORT_LINK;
  };
  jobComment.addComment = async (jobId, fields) => {
    comments.push({ jobId, ...fields });
    if (comment) return await comment(jobId, fields);
    return { id: 1 };
  };

  return {
    textSent,
    linkCalls,
    templateCalls,
    comments,
    restore() {
      Object.assign(gallabox, { sendText: originals.sendText, sendTemplate: originals.sendTemplate });
      Object.assign(jml, { buildShortLinkForJob: originals.buildShortLinkForJob, sendForJob: originals.sendForJob });
      jobComment.addComment = originals.addComment;
    },
  };
}

// A closed/expired conversation row as the diagnosis query projects it.
function convoRow(over = {}) {
  return {
    conversation_id: 501,
    job_id: 42,
    status: 'expired',
    current_step: 'awaiting_slot',
    customer_mob_no: MOBILE,
    expires_at: new Date(Date.now() - 3 * 3600 * 1000 - 5 * 60 * 1000), // 3h05m ago
    ...over,
  };
}

/*
 * The whole fixture for one inbound that finds no ACTIVE row: no active match,
 * one latest row (or none), a job status, and a claim UPDATE that behaves like
 * the real conditional one — it flips the marker on the row object and reports
 * affectedRows 0 once it is already held. That last part is what lets the
 * once-only test drive handleInbound twice and observe the real behaviour
 * instead of reading the flag back out.
 */
function fixture({ latest = convoRow(), jobStatus = 9 } = {}) {
  const claimed = { at: null };
  return makeFakePool([
    [RE_ACTIVE_LOOKUP, []],
    [RE_DIAGNOSIS, latest ? [latest] : []],
    [RE_JOB_STATUS, jobStatus == null ? [] : [{ job_status: jobStatus }]],
    [RE_CLAIM, (_sql, params) => {
      if (claimed.at) return { affectedRows: 0 };
      claimed.at = params[0];
      return { affectedRows: 1 };
    }],
  ]);
}

// ── 1. The four cases are individually legible ──────────────────────────

test('NEVER STARTED — no row has ever existed for this number', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ latest: null });
    const res = await convo.handleInbound(INBOUND, fake.pool);

    assert.equal(res.handled, false);
    // The webhook prints `reason` verbatim, and tests/whatsapp-conversation.test.js
    // and routes/webhook/whatsapp.js both know this exact string. It stays.
    assert.equal(res.reason, 'no_active_conversation');
    assert.equal(res.detail, 'never_started');
    assert.equal(res.jobId, null);
    assert.equal(res.reengage, 'not_applicable', 'there is no job to re-engage against');
    assert.equal(out.textSent.length, 0);
  } finally { out.restore(); }
});

test('EXPIRED — reported with an AGE, because 3h ago and 9d ago are different problems', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture();
    const res = await convo.handleInbound(INBOUND, fake.pool);

    assert.equal(res.reason, 'no_active_conversation');
    assert.equal(res.detail, 'expired');
    assert.equal(res.age, '3h', '"expired" alone is not actionable; "expired 3h ago" is');
    assert.equal(res.jobId, 42);
  } finally { out.restore(); }
});

test('the age is coarse but honest across minutes, hours and days', async () => {
  const out = stubOutbound();
  try {
    const cases = [
      [45 * 60 * 1000, '45m'],
      [3 * 3600 * 1000, '3h'],
      [47 * 3600 * 1000, '47h'],
      [9 * 24 * 3600 * 1000, '9d'],
    ];
    for (const [agoMs, expected] of cases) {
      const fake = fixture({ latest: convoRow({ expires_at: new Date(Date.now() - agoMs - 1000) }) });
      const res = await convo.handleInbound(INBOUND, fake.pool);
      assert.equal(res.age, expected, `${agoMs}ms ago should read as ${expected}`);
    }
    // A row with no window stamp must not invent one.
    const noStamp = fixture({ latest: convoRow({ expires_at: null }) });
    assert.equal((await convo.handleInbound(INBOUND, noStamp.pool)).age, null);
  } finally { out.restore(); }
});

test('COMPLETED — the customer already finished the flow', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ latest: convoRow({ status: 'completed' }) });
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(res.detail, 'completed');
    assert.equal(res.reason, 'no_active_conversation');
  } finally { out.restore(); }
});

test('CLOSED NO SERVICE — the customer said they do not need the service', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ latest: convoRow({ status: 'closed_no_service' }) });
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(res.detail, 'closed_no_service');
  } finally { out.restore(); }
});

test('the four cases are FOUR distinct values, not one string wearing four hats', async () => {
  const out = stubOutbound();
  try {
    const seen = [];
    for (const latest of [null, convoRow(), convoRow({ status: 'completed' }), convoRow({ status: 'closed_no_service' })]) {
      const fake = fixture({ latest, jobStatus: 3 }); // status 3 → no send; we are only reading the label here
      seen.push((await convo.handleInbound(INBOUND, fake.pool)).detail);
    }
    assert.equal(new Set(seen).size, 4, 'collapsing these back into one reason is the bug this file exists to prevent');
  } finally { out.restore(); }
});

test('an UNRECOGNISED status prints itself rather than being folded into one of the four', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ latest: convoRow({ status: 'archived_by_ops' }) });
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(res.detail, 'status_archived_by_ops');
    assert.equal(out.textSent.length, 0, 'only a KNOWN expired row earns a reply');
  } finally { out.restore(); }
});

test('a FAILING diagnosis query says "unknown", never "never started"', async () => {
  const out = stubOutbound();
  try {
    const fake = makeFakePool([
      [RE_ACTIVE_LOOKUP, []],
      [RE_DIAGNOSIS, () => { throw new Error('ER_LOCK_WAIT_TIMEOUT'); }],
    ]);
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(res.detail, 'diagnosis_failed', 'reporting "never started" when we simply failed to look is the original sin');
    assert.equal(res.handled, false);
    assert.equal(out.textSent.length, 0);
  } finally { out.restore(); }
});

// ── 2. The healthy path pays nothing ────────────────────────────────────

test('an ACTIVE conversation issues NO diagnosis query — the cost claim, enforced', async () => {
  const out = stubOutbound();
  try {
    const active = {
      conversation_id: 700, job_id: 42, customer_mob_no: MOBILE,
      status: 'active', current_step: 'awaiting_extras',
      context: JSON.stringify({ confirmed_date: '2026-08-20' }),
      expires_at: new Date(Date.now() + 3600 * 1000),
    };
    const fake = makeFakePool([[RE_ACTIVE_LOOKUP, [active]]]);
    const res = await convo.handleInbound({ ...INBOUND, text: 'Done' }, fake.pool);
    assert.equal(res.handled, true, 'the customer\'s reply routed normally');

    // Asserted on the CAPTURED SQL, not on a comment claiming it.
    assert.equal(fake.calls.filter((c) => RE_DIAGNOSIS.test(c.sql)).length, 0,
      'the extra lookup must run ONLY after the active lookup comes back empty');
    assert.equal(fake.calls.filter((c) => RE_JOB_STATUS.test(c.sql)).length, 0);
    assert.equal(fake.calls.filter((c) => RE_CLAIM.test(c.sql)).length, 0);
    assert.equal(out.linkCalls.length, 0);
  } finally { out.restore(); }
});

// ── 3. Re-engagement: FREE-FORM, and never a template ───────────────────

test('EXPIRED + job still Unconfirmed → a FREE-FORM reply, and NOT a template', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ jobStatus: 9 });
    const res = await convo.handleInbound(INBOUND, fake.pool);

    // The positive: a customer who replied late gets an answer, not silence.
    assert.equal(out.textSent.length, 1, 'exactly one free-form reply');
    assert.equal(out.textSent[0].to, MOBILE, 'sent to the number whose inbound opened the service window');
    assert.equal(res.reengage, 'sent');
    assert.equal(res.handled, false, 'the inbound itself was still not handled — only answered');

    // The negative, which is the point: their message opened the 24h service
    // window, so free-form is deliverable. A template would cost an approval and
    // a slot of the client's Max Magic-Link Send Count — spent BECAUSE THE
    // CUSTOMER TEXTED US. That cap bounds OUR outreach; this is not ours.
    assert.deepEqual(out.templateCalls, [], 'no template may be spent answering an inbound');

    // The marker is CLAIMED before the send, not after: an at-most-once guard
    // that writes after the send is not a guard against concurrent inbounds.
    const claimIdx = fake.calls.findIndex((c) => RE_CLAIM.test(c.sql));
    assert.ok(claimIdx >= 0, 'the once-only marker must be persisted');
    assert.ok(fake.calls[claimIdx].params[0] instanceof Date, 'a JS Date (pool TZ +05:30 → IST), never SQL NOW()');
  } finally { out.restore(); }
});

test('the reply CARRIES the link — a re-engagement without one is just noise', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture();
    await convo.handleInbound(INBOUND, fake.pool);

    assert.equal(out.linkCalls.length, 1, 'the link comes from job-magic-link, the ONE mint/shorten site');
    assert.equal(out.linkCalls[0].jobId, 42);
    assert.equal(out.linkCalls[0].pool, fake.pool, 'built on the caller\'s pool/connection');
    assert.ok(out.textSent[0].body.includes(SHORT_LINK),
      'the customer must be able to tap through from this very message');
  } finally { out.restore(); }
});

test('NO LINK → NOTHING is sent — a message pointing at a missing link is worse than silence', async () => {
  for (const [label, link] of [
    ['the builder returns nothing', async () => null],
    ['the builder throws', async () => { throw new Error('JWT_SECRET env var is not set'); }],
  ]) {
    const out = stubOutbound({ link });
    try {
      const fake = fixture();
      const res = await convo.handleInbound(INBOUND, fake.pool);
      assert.equal(out.textSent.length, 0, `${label}: send nothing rather than a dead link`);
      assert.deepEqual(out.templateCalls, [], `${label}: and certainly not a template as a consolation prize`);
      assert.equal(res.handled, false);
      assert.equal(res.detail, 'expired', `${label}: the diagnosis still stands`);
      assert.equal(res.reengage, 'no_link',
        `${label}: reported as a LINK failure — calling it a send failure sends ops after the wrong fix`);
    } finally { out.restore(); }
  }
});

test('COMPLETED → NOT re-engaged — the customer already finished', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ latest: convoRow({ status: 'completed' }) });
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(out.textSent.length, 0, 'messaging someone who finished would undo a decision they already made');
    assert.equal(res.reengage, 'not_applicable');
    assert.equal(fake.calls.filter((c) => RE_CLAIM.test(c.sql)).length, 0, 'nothing is claimed for a row we will not message');
  } finally { out.restore(); }
});

test('CLOSED NO SERVICE → NOT re-engaged — they told us they do not want it', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ latest: convoRow({ status: 'closed_no_service' }) });
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(out.textSent.length, 0);
    assert.equal(res.reengage, 'not_applicable');
  } finally { out.restore(); }
});

test('job no longer Unconfirmed → NOT re-engaged — there is nothing left to confirm', async () => {
  const out = stubOutbound();
  try {
    for (const jobStatus of [1, 3, 6, null]) {
      const fake = fixture({ jobStatus });
      const res = await convo.handleInbound(INBOUND, fake.pool);
      assert.equal(out.textSent.length, 0, `status ${jobStatus} must not get a confirmation link`);
      assert.equal(res.reengage, 'job_not_unconfirmed');
      assert.equal(fake.calls.filter((c) => RE_CLAIM.test(c.sql)).length, 0,
        'the marker is claimed only for a job we are actually about to message');
    }
  } finally { out.restore(); }
});

test('a SECOND late inbound gets NO second send — once per conversation row', async () => {
  const out = stubOutbound();
  try {
    // ONE fixture, driven TWICE: the claim UPDATE behaves like the real
    // conditional one, so the second pass loses the claim exactly as a
    // concurrent inbound would. Proving it by reading the flag back would only
    // prove the flag was written.
    const fake = fixture();
    const first = await convo.handleInbound(INBOUND, fake.pool);
    const second = await convo.handleInbound({ ...INBOUND, messageId: 'wamid.2', text: 'hello?' }, fake.pool);

    assert.equal(first.reengage, 'sent');
    assert.equal(second.reengage, 'already_reengaged');
    assert.equal(out.textSent.length, 1, 'a customer who texts five times must get ONE reply, not five');
    assert.equal(out.linkCalls.length, 1, 'and the second pass mints no second link');
    // Still fully diagnosed on the second pass — the guard silences the send,
    // not the log.
    assert.equal(second.detail, 'expired');
    assert.equal(second.jobId, 42);
  } finally { out.restore(); }
});

// ── 4. Nothing here may reach the webhook ───────────────────────────────

test('a THROWING send never propagates — the webhook still gets a plain answer', async () => {
  const out = stubOutbound({ text: async () => { throw new Error('ECONNRESET talking to Gallabox'); } });
  try {
    const fake = fixture();
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(res.handled, false, 'the inbound must still resolve to a 200 upstream');
    assert.equal(res.reason, 'no_active_conversation');
    assert.equal(res.reengage, 'send_failed');
  } finally { out.restore(); }
});

test('a provider REJECTION is not reported as sent — the claim is already burned', async () => {
  const out = stubOutbound({ text: async () => ({ delivered: false, error: 'HTTP 400 invalid phone' }) });
  try {
    const fake = fixture();
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(res.reengage, 'send_failed', 'they get no second attempt, so ops must see this one failed');
  } finally { out.restore(); }
});

test('a failing job-status read is fail-soft too', async () => {
  const out = stubOutbound();
  try {
    const fake = makeFakePool([
      [RE_ACTIVE_LOOKUP, []],
      [RE_DIAGNOSIS, [convoRow()]],
      [RE_JOB_STATUS, () => { throw new Error('ER_LOCK_WAIT_TIMEOUT'); }],
    ]);
    const res = await convo.handleInbound(INBOUND, fake.pool);
    assert.equal(res.detail, 'expired', 'the diagnosis is still reported');
    assert.equal(res.reengage, 'guard_failed', 'the guard never ran, so nothing was claimed and nothing was sent');
    assert.equal(out.textSent.length, 0);
  } finally { out.restore(); }
});

// ── 5. The two lookups must not drift apart ─────────────────────────────

test('the diagnosis matches the phone the SAME way the active lookup does', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture({ latest: null });
    await convo.handleInbound({ ...INBOUND, from: '+91 98765 43210' }, fake.pool);

    const active = fake.calls.find((c) => RE_ACTIVE_LOOKUP.test(c.sql));
    const diag = fake.calls.find((c) => RE_DIAGNOSIS.test(c.sql));
    // Same normalisation, same bound key. If these ever drift, the diagnosis
    // describes a row the real lookup never considered — i.e. it lies about the
    // very lookup it exists to explain.
    assert.deepEqual(diag.params, active.params, 'both must bind the identical last-10-digit key');
    assert.equal(diag.params[0], '9876543210');
    assert.match(active.sql, /RIGHT\(REPLACE\(customer_mob_no, ' ', ''\), 10\) = \?/);
    assert.match(diag.sql, /RIGHT\(REPLACE\(customer_mob_no, ' ', ''\), 10\) = \?/);
    // …and the diagnosis must NOT re-apply the status filter that hid the row.
    assert.doesNotMatch(diag.sql, /status = 'active'/);
  } finally { out.restore(); }
});

// ── 6. The extraction must not have moved sendForJob ────────────────────

/*
 * The re-engagement reply and the admin/cron magic-link template now share ONE
 * mint → url → shorten sequence (job-magic-link.buildShortLinkForJob). This
 * drives the path this feature does NOT own, so a regression there is caught
 * here rather than in production: same token, same url, same shortening, same
 * template — and the shortening still happens AFTER the cap reservation, so a
 * capped send leaves no shortener row for a link nobody receives.
 */
test('sendForJob still mints, shortens and sends exactly as before the extraction', async () => {
  const originals = { sendTemplate: gallabox.sendTemplate, shortenUrl: urlShortener.shortenUrl };
  const templates = [];
  const shortened = [];
  const fake = makeFakePool([
    [/SELECT j\.job_id, j\.fk_client_id/, [{
      job_id: 42, fk_client_id: 7, magic_link_sent_at: null, magic_link_send_count: 0,
      customer_name: 'Asha', customer_mob_no: MOBILE, client_name: 'For Testing', max_send_count: 3,
    }]],
    [/magic_link_send_count = magic_link_send_count \+ 1/, { affectedRows: 1 }],
  ]);
  gallabox.sendTemplate = async (args) => { templates.push(args); return { delivered: true, providerMessageId: 'p-1' }; };
  urlShortener.shortenUrl = async (url, opts, pool) => {
    // Captured at call time so the ORDER against the reservation is observable.
    shortened.push({ url, opts, pool, callsSoFar: fake.calls.length });
    return { short_url: SHORT_LINK };
  };
  try {
    const res = await jml.sendForJob(42, { action: 'first' }, fake.pool);

    assert.equal(res.delivered, true);
    assert.match(res.url, /\/public\/job-completion\//, 'the long JWT url is still built and returned');
    assert.ok(res.url.endsWith(res.token), 'url and token are still the same pair');

    assert.equal(shortened.length, 1, 'the link is shortened exactly once');
    assert.equal(shortened[0].url, res.url);
    assert.equal(shortened[0].opts.purpose, 'unconfirmed_book', 'the audit tag every cleanup/report query filters on');
    assert.ok(shortened[0].opts.expiresAt instanceof Date);
    assert.equal(shortened[0].pool, fake.pool);

    const reserveIdx = fake.calls.findIndex((c) => /magic_link_send_count = magic_link_send_count \+ 1/.test(c.sql));
    assert.ok(reserveIdx >= 0 && shortened[0].callsSoFar > reserveIdx,
      'shortening still runs AFTER the cap reservation — an at-cap send must leave no orphan short link');

    assert.equal(templates.length, 1);
    assert.equal(templates[0].templateName, 'confirm_order');
    assert.equal(templates[0].bodyValues[3], SHORT_LINK, 'the SHORT url is what reaches the customer');
    assert.equal(templates[0].bodyValues[1], 'Asha');
  } finally {
    gallabox.sendTemplate = originals.sendTemplate;
    urlShortener.shortenUrl = originals.shortenUrl;
  }
});

/* ═══ the FIRST late message is the one that must get the reply ═════════ */

/*
 * A fixture for the OTHER late path: the row is still ACTIVE but already past
 * expires_at. Everything above drives the case where getActiveByMobile finds
 * nothing; this drives the one where it finds a row and handleInbound is the
 * thing that expires it.
 */
function lateActiveFixture({ jobStatus = 9 } = {}) {
  const claimed = { at: null };
  const active = convoRow({ status: 'active' });   // expires_at is already 3h05m past
  return makeFakePool([
    [RE_ACTIVE_LOOKUP, [active]],
    [RE_DIAGNOSIS, [convoRow()]],
    [RE_JOB_STATUS, jobStatus == null ? [] : [{ job_status: jobStatus }]],
    [RE_CLAIM, (_sql, params) => {
      if (claimed.at) return { affectedRows: 0 };
      claimed.at = params[0];
      return { affectedRows: 1 };
    }],
    [/UPDATE tbl_whatsapp_conversation/, { affectedRows: 1 }],
  ]);
}

test('a customer whose FIRST text arrives late is answered on THAT message', async () => {
  /*
   * The feature answered the wrong message. handleInbound has two paths that
   * both mean "too late":
   *
   *   1. the row is still `active` but past expires_at — handleInbound flips it
   *      to 'expired' and returns. This is the customer's FIRST late text.
   *   2. the row is already 'expired', so getActiveByMobile finds nothing —
   *      only reachable on their SECOND text.
   *
   * Re-engagement was wired to (2) alone, so the ordinary case — someone who
   * texts once and waits — got silence, and the reply only ever reached a
   * customer who had already been ignored once. Which is exactly the behaviour
   * it was built to end.
   */
  const out = stubOutbound();
  try {
    const r = await convo.handleInbound(INBOUND, lateActiveFixture().pool);
    assert.equal(r.handled, false);
    assert.equal(r.reason, 'expired');
    assert.equal(r.reengage, 'sent', 'the FIRST late text gets the reply');
    assert.equal(out.textSent.length, 1, 'exactly one free-form reply');
    assert.deepEqual(out.templateCalls, [], 'and still never a template');
    assert.ok(out.textSent[0].body.includes(SHORT_LINK), 'carrying the link');
  } finally { out.restore(); }
});

/* ═══ the reply must leave a trace ops can SEE ═════════════════════════ */

/*
 * This reply touches no magic_link_* column — deliberately, because it is the
 * customer's inbound and not our outreach (see the top of this file). The cost
 * of that is invisibility: without an audit stamp the ONLY evidence a late
 * customer was answered is a log line, and someone looking at the job in the
 * CRM cannot tell "answered" from "ignored". The job comment thread is the
 * surface ops already reads, and the one this service already writes to for
 * WhatsApp cancel/reschedule reasons — so the stamp goes there. No new column.
 */
test('a re-engaged customer leaves a CRM-visible comment on the job', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture();
    const res = await convo.handleInbound(INBOUND, fake.pool);

    assert.equal(res.reengage, 'sent');
    assert.equal(out.comments.length, 1, 'exactly one audit stamp for one reply');
    assert.equal(out.comments[0].jobId, 42, 'stamped on the job the conversation belongs to');
    assert.equal(out.comments[0].comment_on, 1, 'lifecycle — the same code the WhatsApp reason mirror uses');
    assert.match(out.comments[0].comments, /whatsapp/i);
    assert.match(out.comments[0].comments, /expired/i,
      'the comment has to say WHY we messaged them, or it explains nothing');
    // The link carries a signed token. A job comment is the wrong place to park
    // credentials, so it is described, never quoted.
    assert.ok(!out.comments[0].comments.includes(SHORT_LINK),
      'the tokenised link must not be pasted into the comment thread');
  } finally { out.restore(); }
});

test('only a re-engagement that actually WENT OUT is stamped', async () => {
  // A comment saying we answered the customer, on a job where nothing was sent,
  // is worse than no comment: it retires a follow-up that never happened.
  for (const [label, opts] of [
    ['no link could be built', { link: async () => null }],
    ['the provider rejected the send', { text: async () => ({ delivered: false, error: 'HTTP 400' }) }],
    ['the send threw', { text: async () => { throw new Error('ECONNRESET'); } }],
  ]) {
    const out = stubOutbound(opts);
    try {
      await convo.handleInbound(INBOUND, fixture().pool);
      assert.deepEqual(out.comments, [], `${label}: nothing was delivered, so nothing may claim it was`);
    } finally { out.restore(); }
  }
});

test('a FAILING comment does not undo the send', async () => {
  /*
   * The message is already with the customer by the time the stamp is written,
   * and the once-only marker is already burned — so a comment hiccup must
   * neither throw into the webhook nor downgrade the outcome to a send failure.
   * Reporting it as 'send_failed' would send ops looking at Gallabox for a
   * problem in our own comment table.
   */
  const out = stubOutbound({ comment: async () => { throw new Error('ER_NO_SUCH_TABLE: tbl_job_comment'); } });
  try {
    const res = await convo.handleInbound(INBOUND, fixture().pool);
    assert.equal(res.reengage, 'sent', 'the customer got their reply; that is what the outcome reports');
    assert.equal(res.handled, false);
    assert.equal(out.textSent.length, 1, 'the send stands');
  } finally { out.restore(); }
});

test('the stamp rides the FIRST-late path too, not just the second', async () => {
  // The two re-engagement call sites must not drift: a customer answered on
  // their first late text is exactly as invisible to ops as one answered on
  // their second.
  const out = stubOutbound();
  try {
    const r = await convo.handleInbound(INBOUND, lateActiveFixture().pool);
    assert.equal(r.reengage, 'sent');
    assert.equal(out.comments.length, 1);
    assert.equal(out.comments[0].jobId, 42);
  } finally { out.restore(); }
});

test('a second late inbound adds no second comment', async () => {
  const out = stubOutbound();
  try {
    const fake = fixture();
    await convo.handleInbound(INBOUND, fake.pool);
    await convo.handleInbound({ ...INBOUND, messageId: 'wamid.2', text: 'hello?' }, fake.pool);
    assert.equal(out.comments.length, 1, 'one reply, one stamp — the at-most-once guard covers both');
  } finally { out.restore(); }
});

test('the first-late path still respects the job guard', async () => {
  // The new call site must not bypass the guards the other one honours: a job
  // past status 9 has nothing left to confirm, so the link would be nonsense.
  const out = stubOutbound();
  try {
    const r = await convo.handleInbound(INBOUND, lateActiveFixture({ jobStatus: 3 }).pool);
    assert.equal(r.reason, 'expired');
    assert.equal(r.reengage, 'job_not_unconfirmed');
    assert.equal(out.textSent.length, 0, 'nothing sent');
  } finally { out.restore(); }
});
