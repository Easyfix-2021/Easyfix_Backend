const test = require('node:test');
const { after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * SHARED-JOB WEB LINK — a contact works a delegated job from a web copy of the
 * technician app. The parts worth testing hardest are the ones that decide WHO
 * may act: the guest token resolves to the SHARER's identity, so the fence
 * (share-guest-scope) and the per-request liveness check are all that stand
 * between a WhatsApp link and every other thing the sharer can do.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const readRaw = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const readSrc = (rel) => stripComments(readRaw(rel));
// routes/mobile/index.js holds a `/*` inside a string, which the stripper reads
// as a comment opener and swallows half the file — so it is read RAW, and each
// negative check below is paired with a positive one that proves it looked.

/* ─── Stubs: the owner technician, OTP delivery, the attempt window ───── */
const OWNER = { efr_id: 901, efr_no: '9000000001', efr_name: 'Ravi', lifecycle: { status: 'ACTIVE', capabilities: { mutateAssignedJobs: true } } };
function stub(rel, exports) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../services/tech-auth.service', { findById: async (id) => (Number(id) === 901 ? { ...OWNER } : null) });
let delivered = [];
let deliverResult = { finalDelivered: true, disabled: false };
stub('../services/otp-delivery.service', {
  deliverOtp: async (args) => { delivered.push(args); return deliverResult; },
});
const attempts = new Map();
stub('../services/attempt-window.service', {
  sharedAttemptWindow: () => ({
    claim: async (key) => {
      const n = (attempts.get(key) || 0) + 1;
      attempts.set(key, n);
      return n > 5 ? { locked: true, retryAfterMinutes: 30 } : { locked: false };
    },
    state: async (key) => {
      const n = attempts.get(key) || 0;
      return n >= 5 ? { locked: true, retryAfterMinutes: 30 } : { locked: false, attemptsRemaining: 5 - n };
    },
    clear: async (key) => { attempts.delete(key); },
  }),
});

/* ─── Fake DB: one share row, its OTP columns, the job facts ──────────── */
let shareRow;
let otpRow;
let updates = [];
const fake = installFakePool([
  [/UPDATE tbl_job_share_link SET otp = \?/i, (sql, params) => {
    otpRow = { otp: params[0], otp_valid_up_to: params[1] };
    return { affectedRows: 1 };
  }],
  [/UPDATE tbl_job_share_link SET otp = NULL/i, () => { otpRow = { otp: null, otp_valid_up_to: null }; return { affectedRows: 1 }; }],
  [/UPDATE tbl_job_share_link SET status/i, (sql, params) => {
    updates.push({ sql, params });
    shareRow = { ...shareRow, status: params[0] };
    return { affectedRows: 1 };
  }],
  [/SELECT otp, otp_valid_up_to/i, () => [otpRow]],
  [/FROM tbl_job_share_link s/i, () => (shareRow ? [shareRow] : [])],
  [/FROM tbl_job j/i, () => [{ job_id: 5001, slot: null, service_catg_name: 'AC Repair', locality: 'Sector 18', city_name: 'Noida', pin_code: '201301', sharer_no: '9000000001' }]],
]);

const tokens = require('../utils/jwt');
const guest = require('../services/job-share-guest.service');
const { guestPathAllowed, requireShareGuestScope } = require('../middleware/share-guest-scope');
const requireTechAuth = require('../middleware/tech-auth');
const requireAuth = require('../middleware/auth');
const capability = require('../middleware/require-tech-lifecycle-capability');

after(() => fake.restore());
beforeEach(() => {
  shareRow = {
    share_id: 77, job_id: 5001, fk_easyfixer_id: 901, delegate_efr_id: null,
    contact_name: 'Suresh', contact_number: '9876543210', status: 'pending',
    sharer_name: 'Ravi', delegate_name: null, delegate_no: null,
  };
  otpRow = { otp: null, otp_valid_up_to: null };
  updates = [];
  delivered = [];
  deliverResult = { finalDelivered: true, disabled: false };
  attempts.clear();
});

function res() {
  return {
    statusCode: 200, body: null, locals: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function run(mw, req) {
  const r = res();
  let nexted = false;
  await mw(req, r, () => { nexted = true; });
  return { r, nexted };
}

/* ─── 1. Tokens: two types that can never stand in for each other ─────── */

test('the link token names a share and is never accepted as a guest session, and vice versa', () => {
  const link = tokens.signJobShareLinkToken(77);
  assert.equal(tokens.verifyJobShareLinkToken(link), 77);
  assert.equal(tokens.jobShareGuestClaims(jwt.verify(link, process.env.JWT_SECRET)), null);

  const session = tokens.signJobShareGuestToken({ shareId: 77, jobId: 5001 });
  assert.deepEqual(tokens.jobShareGuestClaims(jwt.verify(session, process.env.JWT_SECRET)), { shareId: 77, jobId: 5001 });
  assert.throws(() => tokens.verifyJobShareLinkToken(session), { status: 404 });
  // A technician token is neither.
  const tech = jwt.sign({ sub: 'efr:901' }, process.env.JWT_SECRET);
  assert.throws(() => tokens.verifyJobShareLinkToken(tech), { status: 404 });
  assert.equal(tokens.jobShareGuestClaims(jwt.verify(tech, process.env.JWT_SECRET)), null);
});

/* ─── 2. The fence ─────────────────────────────────────────────────────── */

test('a guest reaches its own job and uploads, and nothing else', () => {
  const allowed = [
    ['GET', '/jobs/5001'], ['POST', '/jobs/5001/checkin'], ['POST', '/jobs/5001/selfie'],
    ['POST', '/jobs/5001/material-request'], ['POST', '/jobs/5001/permission-requests'],
    ['POST', '/jobs/5001/checkout'], ['POST', '/uploads'], ['POST', '/uploads/document'],
  ];
  const refused = [
    ['GET', '/jobs/5002'], ['POST', '/jobs/50011/checkin'], ['GET', '/jobs'], ['GET', '/jobs/offered'],
    ['POST', '/jobs/5001/share'], ['DELETE', '/jobs/5001/share'], ['POST', '/jobs/5001/share/accept'],
    ['POST', '/jobs/5001/accept'], ['POST', '/jobs/5001/reject'],
    ['GET', '/dashboard'], ['POST', '/attendance'], ['GET', '/earnings'], ['GET', '/profile'],
    ['GET', '/uploads'], ['POST', '/uploads/other'],
  ];
  for (const [m, p] of allowed) assert.equal(guestPathAllowed(p, m, 5001), true, `${m} ${p} must be allowed`);
  for (const [m, p] of refused) assert.equal(guestPathAllowed(p, m, 5001), false, `${m} ${p} must be refused`);

  // The fence's path shapes agree with the lock's on the same cases.
  const { JOB_ID_PATH, SHARE_PATH } = capability._internals;
  for (const p of ['/jobs/5001', '/jobs/5001/checkin', '/jobs/5001/share', '/jobs', '/jobs/offered']) {
    assert.equal(JOB_ID_PATH.test(p), /^\/jobs\/\d+(?:\/|$)/.test(p), p);
    assert.equal(SHARE_PATH.test(p), /^\/jobs\/\d+\/share(?:\/|$)/.test(p), p);
  }
});

test('the fence answers share_guest_scope, and ignores a request that is not a guest', async () => {
  const guestReq = { method: 'GET', path: '/dashboard', shareGuest: { shareId: 77, jobId: 5001 } };
  const refused = await run(requireShareGuestScope, guestReq);
  assert.equal(refused.nexted, false);
  assert.equal(refused.r.statusCode, 403);
  assert.equal(refused.r.body.code, 'share_guest_scope');

  const tech = await run(requireShareGuestScope, { method: 'GET', path: '/dashboard' });
  assert.equal(tech.nexted, true);
});

test('the fence is mounted directly after requireTechAuth, before anything can act', () => {
  const src = readRaw('routes/mobile/index.js');
  const auth = src.indexOf('router.use(requireTechAuth);');
  const fence = src.indexOf('router.use(requireShareGuestScope);');
  const lock = src.indexOf('router.use(requireTechJobMutationCapability);');
  assert.ok(auth > 0 && fence > auth && lock > fence, 'order must be auth → fence → lock');
  // requireTechAuth is mounted nowhere else, so this is the only door.
  assert.equal((src.match(/router\.use\(requireTechAuth\)/g) || []).length, 1);
});

/* ─── 3. requireTechAuth: guest → the sharer, while the share is live ─── */

test('a live guest session authenticates as the sharer and is marked as a guest', async () => {
  shareRow.status = 'accepted';
  const token = tokens.signJobShareGuestToken({ shareId: 77, jobId: 5001 });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const { r, nexted } = await run(requireTechAuth, req);
  assert.equal(nexted, true, JSON.stringify(r.body));
  assert.equal(req.tech.efr_id, 901);
  assert.equal(req.shareGuest.jobId, 5001);
  assert.equal(req.shareGuest.contactNumber, '9876543210');
});

test('once the share ends — cancelled, revoked, completed — the session is refused with share_ended', async () => {
  const token = tokens.signJobShareGuestToken({ shareId: 77, jobId: 5001 });
  for (const status of ['cancelled', 'released', 'completed', 'pending']) {
    shareRow.status = status;
    const { r, nexted } = await run(requireTechAuth, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(nexted, false, status);
    assert.equal(r.statusCode, 401, status);
    assert.equal(r.body.code, 'share_ended', status);
  }
  // A token for another job never resolves, whatever the share's status.
  shareRow.status = 'started';
  const wrongJob = tokens.signJobShareGuestToken({ shareId: 77, jobId: 5002 });
  const { r } = await run(requireTechAuth, { headers: { authorization: `Bearer ${wrongJob}` } });
  assert.equal(r.body.code, 'share_ended');
});

/* ─── 4. /api/shared auth: reason lists only ──────────────────────────── */

test('on /api/shared a guest may GET lookups and nothing else', async () => {
  shareRow.status = 'started';
  const token = tokens.signJobShareGuestToken({ shareId: 77, jobId: 5001 });
  const ok = await run(requireAuth, { method: 'GET', originalUrl: '/api/shared/lookup/app-cancel-reasons', headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.nexted, true);
  for (const [method, url] of [
    ['POST', '/api/shared/files'], ['GET', '/api/admin/jobs'], ['GET', '/api/client/jobs'], ['DELETE', '/api/shared/files/1'],
  ]) {
    const refused = await run(requireAuth, { method, originalUrl: url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(refused.nexted, false, `${method} ${url}`);
    assert.equal(refused.r.statusCode, 403, `${method} ${url}`);
  }
});

/* ─── 5. The OTP ──────────────────────────────────────────────────────── */

test('the OTP goes to the share\'s phone and never appears in the response', async () => {
  const link = tokens.signJobShareLinkToken(77);
  const out = await guest.sendOtp(link);
  assert.equal(out.sent, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].mobile, '9876543210');
  assert.equal(Number(delivered[0].otp), Number(otpRow.otp));
  assert.doesNotMatch(JSON.stringify(out), new RegExp(String(otpRow.otp)));
  // No channel carried it → not "sent".
  deliverResult = { finalDelivered: false, disabled: false };
  await assert.rejects(guest.sendOtp(link), { status: 502 });
});

test('a wrong code counts down; the right one accepts the share and issues a one-job session', async () => {
  const link = tokens.signJobShareLinkToken(77);
  await guest.sendOtp(link);
  const right = String(otpRow.otp);
  const wrong = right === '1111' ? '2222' : '1111';

  await assert.rejects(guest.verifyOtp(link, wrong), (e) => e.status === 400 && e.details.code === 'otp_invalid' && e.details.attemptsRemaining === 4);

  const out = await guest.verifyOtp(link, right);
  assert.equal(out.jobId, 5001);
  assert.equal(shareRow.status, 'accepted', 'verify must accept a pending share');
  assert.deepEqual(tokens.jobShareGuestClaims(jwt.verify(out.sessionToken, process.env.JWT_SECRET)), { shareId: 77, jobId: 5001 });
  // One-shot: the code is consumed.
  await assert.rejects(guest.verifyOtp(link, right), (e) => e.details.code === 'otp_expired');
});

test('the sixth wrong code locks, and an ended share refuses the whole flow', async () => {
  const link = tokens.signJobShareLinkToken(77);
  await guest.sendOtp(link);
  const wrong = String(otpRow.otp) === '1111' ? '2222' : '1111';
  let last;
  for (let i = 0; i < 6; i += 1) last = await guest.verifyOtp(link, wrong).catch((e) => e);
  assert.equal(last.details.code, 'otp_locked');

  shareRow.status = 'released';
  await assert.rejects(guest.peek(link), (e) => e.status === 410 && e.details.code === 'share_ended');
  await assert.rejects(guest.sendOtp(link), (e) => e.status === 410);
});

test('peek shows job-level facts only — never the customer', async () => {
  const out = await guest.peek(tokens.signJobShareLinkToken(77));
  assert.deepEqual(Object.keys(out.share).sort(), ['area', 'id', 'jobId', 'maskedNumber', 'service', 'sharedByName', 'status']);
  assert.equal(out.share.service, 'AC Repair');
  assert.notEqual(out.share.maskedNumber, '9876543210');
});

/* ─── 6. The lock: the guest is the delegate ──────────────────────────── */

test('a guest\'s first write starts the share; a read does not', async () => {
  const lock = capability.requireTechJobMutationCapability;
  shareRow.status = 'accepted';
  const read = { method: 'GET', path: '/jobs/5001', tech: { ...OWNER }, shareGuest: { shareId: 77, jobId: 5001, status: 'accepted', share: shareRow } };
  assert.equal((await run(lock, read)).nexted, true);
  assert.equal(updates.length, 0, 'a read must not start the share');

  const write = { method: 'POST', path: '/jobs/5001/checkin', tech: { ...OWNER }, shareGuest: { shareId: 77, jobId: 5001, status: 'accepted', share: shareRow } };
  const { r, nexted } = await run(lock, write);
  assert.equal(nexted, true, JSON.stringify(r.body));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].params[0], 'started');
});

/* ─── 7. How a share ends ─────────────────────────────────────────────── */

test('Can\'t Complete Today keeps the share; only completion closes it; no time-based expiry', () => {
  const mobile = readRaw('routes/mobile/index.js');
  assert.match(mobile, /closeForJobOutcome/, 'the checkout site must be in view');
  assert.match(mobile, /if \(!isRevisit\) \{\s*try \{\s*await delegation\.closeForJobOutcome\(job\.job_id, 'completed'\)/);
  assert.doesNotMatch(mobile, /'handed_back'/);
  assert.doesNotMatch(readSrc('server/scheduler.js'), /job-share-expiry|expireStaleShares/);
  assert.doesNotMatch(readSrc('services/job-share-delegation.service.js'), /expireStaleShares|JOB_SHARE_TTL_HOURS/);
});

test('the customer bridge call rings the guest\'s phone, not the sharer\'s', () => {
  assert.match(readRaw('routes/mobile/index.js'),
    /const techMobile = req\.shareGuest \? req\.shareGuest\.contactNumber : req\.tech\.efr_no;/);
});
