/*
 * ROUTE-LEVEL tests for /api/public/website-booking — the marketing-site QR
 * booking surface (routes/public/website-booking.js).
 *
 * WHY THIS FILE EXISTS. This is the ONLY sub-router in the whole backend that is
 * both completely unauthenticated AND writes a row. Everything protecting it is
 * in-handler logic: the never-fail client resolution, the magic-byte photo
 * sniffing, the size ceilings, the honeypot, the IST date gate and — most
 * fragile of all — the UTC-midnight date sentinel. None of that is expressible
 * as a type or a schema, so it can only be held in place by tests.
 *
 * THE ONE THAT MUST NEVER REGRESS: the appointment is handed to
 * jobService.create() as a UTC-MIDNIGHT SENTINEL (`YYYY-MM-DDT00:00:00.000Z`)
 * plus a SEPARATE `requested_time` of 'HH:MM'. create() runs the date through
 * `new Date(value)`, so a naive local ISO string ('2026-08-12T09:00:00') is
 * parsed as SERVER-local — and prod containers run UTC — after which
 * formatMysqlDateTimeIST adds +05:30 and a 09:00 morning booking silently lands
 * at 14:30, inside the AFTERNOON band. It fails silently, on prod only, and only
 * for the customer's time band. See the sentinel tests at the bottom.
 *
 * FAITHFULNESS. We mount the REAL router, behind the REAL validate() middleware
 * and the REAL rate limiters, under an `express.json({ limit: '25mb' })` that
 * mirrors server.js exactly — so the photo-size tests exercise the true
 * body-parser-then-Joi-then-handler ordering rather than a simplified stand-in.
 *
 * NO DATABASE, AND NO JOB IS EVER CREATED. jobService.create is replaced with a
 * capture stub, the pincode service and the storage utils are stubbed, and the
 * only real DB seam (the tbl_client reference_code lookup + the extra-photo
 * INSERT) goes through tests/helpers/fake-pool.
 *
 * DETERMINISM. Two things here would otherwise rot:
 *   · the clock — the date gate compares against the IST wall-clock date, so a
 *     real clock breaks the suite at IST midnight and behaves differently in a
 *     UTC CI container. jobService.formatMysqlDateTimeIST (the one function
 *     todayIST() calls) is stubbed to a FIXED instant instead.
 *   · the rate limiter — the POST is capped at 8 per 10 min PER IP, and this
 *     file sends far more than 8. Every request carries its own synthetic
 *     x-forwarded-for so each lands in its own bucket. That is not a workaround
 *     for the limiter; it is how the limiter is meant to partition callers, and
 *     `clientIp()` reads the first XFF hop exactly as it does in prod.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// ─── Fixtures the fake pool + the stubs read ─────────────────────────

/*
 * The FIXED "now". Every date assertion in this file is relative to it, and the
 * clock stub below is the only thing that decides what "today" means — so this
 * suite gives the same result at 00:00 IST, in a UTC container, and in June.
 */
const FIXED_TODAY = '2026-08-07';
const FIXED_IST_NOW = `${FIXED_TODAY} 10:15:00`;   // what formatMysqlDateTimeIST returns
const YESTERDAY = '2026-08-06';
const TOMORROW = '2026-08-08';

/* ACTIVE clients keyed by reference_code, as tbl_client rows. */
const CLIENTS = {
  EFXQR7: { client_id: 42, client_name: 'Voltas Retail', reference_code: 'EFXQR7' },
};

/* Pincodes tbl_pincode already holds. Anything else is "not on file". */
const KNOWN_PINCODES = {
  560038: { pincode_id: 9, city_id: 77, city_name: 'Bengaluru', is_active: true },
  110001: { pincode_id: 10, city_id: 12, city_name: 'New Delhi', is_active: false },
};

/* The job_id the stubbed create() (and the fake tbl_job INSERT) hands back. */
const NEW_JOB_ID = 918273;

const fake = installFakePool([
  // findClientByCode — the ONE parameterised query this router runs itself.
  [/FROM\s+tbl_client/i, (_sql, params) => {
    const row = CLIENTS[String(params && params[0])];
    return row ? [row] : [];
  }],
  /*
   * The rest of these exist ONLY for the one test that runs the REAL
   * jobService.create (the in-transaction ordering proof at the end of §2).
   * Every route test stubs create() out entirely, so nothing else reaches them.
   * `\b` after tbl_job excludes tbl_job_services / tbl_job_image.
   */
  [/INSERT INTO tbl_job\b/i, () => ({ insertId: NEW_JOB_ID })],
  [/SELECT customer_id FROM tbl_customer WHERE customer_id/i, [{ customer_id: 7 }]],
  // The booking-image write itself. Nothing reads the result; it exists so the
  // statement is CAPTURED, in order, alongside BEGIN/COMMIT.
  [/INSERT INTO tbl_job_image/i, () => ({ affectedRows: 1 })],
]);

const express = require('express');
const logger = require('../logger');
const jobService = require('../services/job.service');
const pincodeService = require('../services/pincode.service');
const lookupService = require('../services/lookup.service');
const s3Storage = require('../utils/s3-storage');
const fileStorage = require('../utils/file-storage');
const { BAND_MORNING, BAND_AFTERNOON, BAND_EVENING } = require('../services/time-slot');
const bookingRouter = require('../routes/public/website-booking');

/*
 * The REAL create(), captured before before() replaces it with the capture
 * stub. The in-transaction ordering test calls this directly — it is the only
 * place in this file where job.service's own SQL runs.
 */
const realJobCreate = jobService.create;

// ─── Stub bookkeeping ────────────────────────────────────────────────
/*
 * The router reaches every collaborator through a LATE-BOUND property access
 * (`jobService.create(...)`, `pincodeService.getPincodeByValue(...)`), so
 * replacing the property on the shared module object is enough — no loader
 * tricks, and the router under test is the real, unmodified one.
 */
const stubbed = [];
function stub(obj, key, fn) {
  stubbed.push([obj, key, obj[key]]);
  obj[key] = fn;
}
function restoreStubs() {
  while (stubbed.length) {
    const [obj, key, original] = stubbed.pop();
    obj[key] = original;
  }
}

/* Everything the last request handed to jobService.create, or null. */
let created = null;
/* Every log line the request emitted, so we can assert on what we DIDN'T log. */
let logLines = [];

let server;
let baseUrl;

before(async () => {
  // ── the clock ──
  stub(jobService, 'formatMysqlDateTimeIST', () => FIXED_IST_NOW);

  // ── the write. Records and returns; nothing reaches a database. ──
  stub(jobService, 'create', async (payload, actor) => {
    created = { payload, actor };
    return { job_id: NEW_JOB_ID, job_reference_id: 'EF-TEST-918273' };
  });

  // ── pincode ──
  stub(pincodeService, 'getPincodeByValue', async (pin) => KNOWN_PINCODES[String(pin)] || null);
  stub(pincodeService, 'ensurePincode', async (pin) => {
    // Mirrors the real service: a non-Indian / ungeocodable pincode is a 400
    // carrying `.status`, which mapKnownError turns into a modernError.
    const err = new Error(`Pincode ${pin} could not be geocoded`);
    err.status = 400;
    throw err;
  });

  // ── storage. S3 OFF so the local-filesystem branch is exercised, and even
  //    that is stubbed — no bytes are written anywhere. ──
  stub(s3Storage, 'isEnabled', () => false);
  let storedSeq = 0;
  stub(fileStorage, 'writeBuffer', (_category, _buffer, originalName) => {
    storedSeq += 1;
    return { filename: `wb-test-${storedSeq}${String(originalName).slice(-4)}` };
  });

  // ── /context catalogue ──
  stub(lookupService, 'serviceCategories', async () => ([
    { service_catg_id: 21, service_catg_name: 'Air Conditioner' },
    { service_catg_id: 22, service_catg_name: 'Refrigerator' },
  ]));

  /*
   * Capture the logger instead of silencing it. Two reasons: the TAP output
   * stays readable, AND the "no multi-MB blob in the message" assertions can
   * check the LOG as well as the response — validate() logs its own redacted
   * sample, and Joi's default messages interpolate the offending value.
   */
  for (const level of ['info', 'warn', 'error']) {
    stub(logger, level, (a, b) => {
      logLines.push(typeof a === 'string' ? a : JSON.stringify(a) + ' ' + String(b || ''));
    });
  }

  const app = express();
  /*
   * MIRRORS server.js DELIBERATELY. The 25 MB limit is the thing several tests
   * below depend on: a ~16 MB maximal-but-legal photo batch must reach our own
   * validation rather than dying at body-parser with a 413. If server.js's
   * limit changes, this number must change with it or the suite silently stops
   * testing what it claims to.
   */
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/public/website-booking', bookingRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err && err.status ? err.status : 500).json({ success: false, error: String(err && err.message) });
  });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  restoreStubs();
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  created = null;
  logLines = [];
});

// ─── Request helpers ─────────────────────────────────────────────────

/*
 * A fresh synthetic client IP per request. The POST limiter is 8 / 10 min keyed
 * on `wb-post:<clientIp>`, and clientIp() honours the FIRST x-forwarded-for hop
 * — so this is the limiter's own partitioning, used as intended, not a bypass.
 */
let ipSeq = 0;
function nextIp() {
  ipSeq += 1;
  return `198.51.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

async function post(body) {
  const res = await fetch(`${baseUrl}/api/public/website-booking`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(path) {
  const res = await fetch(`${baseUrl}/api/public/website-booking${path}`, {
    headers: { 'x-forwarded-for': nextIp() },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/* A minimal booking that passes every gate. Overrides merge on top. */
function booking(overrides = {}) {
  return {
    name: 'Anita Rao',
    mobile: '9876500001',
    address: '12 MG Road, Indiranagar',
    pincode: '560038',
    description: 'Split AC not cooling, makes a rattling noise',
    jobType: 'Repair',
    date: FIXED_TODAY,
    timeSlot: BAND_MORNING,
    consent: true,
    ...overrides,
  };
}

/* Every validation `details[].message` on a 400, flattened. */
const detailMessages = (res) => (res.body?.details || []).map((d) => d.message).join(' | ');
/* The whole response + everything logged, as one string. */
const everythingSaid = (res) => JSON.stringify(res.body) + '\n' + logLines.join('\n');

// ─── Photo fixtures ──────────────────────────────────────────────────
/*
 * Real magic bytes per type, so the DECLARED type and the DECODED type can be
 * varied independently — which is the entire point of the matrix below.
 * Payload is padding ('A'), because sniffPhotoMime only ever reads the header.
 */
const MAGIC = {
  'image/jpeg': Buffer.from([0xFF, 0xD8, 0xFF]),
  'image/png': Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  'image/webp': Buffer.concat([
    Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii'),
  ]),
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function imageBuffer(actualType, totalBytes = 96) {
  const magic = MAGIC[actualType];
  return Buffer.concat([magic, Buffer.alloc(Math.max(0, Math.floor(totalBytes) - magic.length), 0x41)]);
}
/* `declared` is what the data: prefix CLAIMS; `actual` is what the bytes ARE. */
function photoDataUrl(declared, actual = declared, totalBytes = 96) {
  return `data:${declared};base64,${imageBuffer(actual, totalBytes).toString('base64')}`;
}

const MB = 1024 * 1024;

// ═══ 1. CLIENT RESOLUTION — must NEVER lose a booking ════════════════
/*
 * The 2026-08-07 product reversal: an unmatched code used to 503 and discard the
 * lead. Exactly two branches survive, and neither can fail. The 503 assertion is
 * the load-bearing one — it is the regression the reversal was FOR.
 */

test('a matched ACTIVE reference_code resolves to that client', async () => {
  const res = await post(booking({ code: 'EFXQR7' }));
  assert.equal(res.status, 200);
  assert.equal(created.payload.fk_client_id, 42);
});

test('an UNKNOWN reference_code falls back to client 1 (RETAIL) — never a 503', async () => {
  const res = await post(booking({ code: 'NO-SUCH-CODE' }));
  assert.notEqual(res.status, 503, 'an unmatched code must never cost us the lead');
  assert.equal(res.status, 200);
  assert.equal(created.payload.fk_client_id, 1);
});

test('an ABSENT reference_code falls back to client 1 (RETAIL) — never a 503', async () => {
  const res = await post(booking());
  assert.notEqual(res.status, 503);
  assert.equal(res.status, 200);
  assert.equal(created.payload.fk_client_id, 1);
});

test('the resolution branch is LOGGED so ops can find rows still on the fallback', async () => {
  await post(booking());
  assert.match(logLines.join('\n'), /branch=default-retail/);
  logLines = [];
  await post(booking({ code: 'EFXQR7' }));
  assert.match(logLines.join('\n'), /branch=code/);
});

test('no client_id ever leaves the router, on either branch', async () => {
  const matched = await post(booking({ code: 'EFXQR7' }));
  const fallback = await post(booking());
  for (const res of [matched, fallback]) {
    const keys = Object.keys(res.body.data);
    assert.deepEqual(keys.sort(), ['jobId', 'referenceId']);
  }
});

// ═══ 2. PHOTO VALIDATION MATRIX — declared MIME × decoded bytes ══════
/*
 * The declared type in a data: URL is attacker-controlled text. The full 3×3
 * matrix is spelled out rather than only the diagonal, because the interesting
 * failure is a `data:image/png;` wrapper around something that is not a PNG —
 * an SVG or an HTML document rendered by the CRM's <img> would be stored XSS
 * from an unauthenticated surface.
 */

for (const declared of IMAGE_TYPES) {
  test(`photo accepted when declared ${declared} matches the decoded bytes`, async () => {
    const res = await post(booking({ photos: [photoDataUrl(declared)] }));
    assert.equal(res.status, 200, `${declared} must be accepted`);
    assert.ok(created, 'a matching photo must not block the booking');
    assert.deepEqual(
      created.payload.job_image_filenames.length, 1,
      'the photo rides along on create(), as the plural field',
    );
  });

  for (const actual of IMAGE_TYPES.filter((t) => t !== declared)) {
    test(`photo REJECTED when declared ${declared} but the bytes are ${actual}`, async () => {
      const res = await post(booking({ photos: [photoDataUrl(declared, actual)] }));
      assert.equal(res.status, 400);
      assert.match(
        String(res.body?.error ?? ''),
        /content does not match its declared type/i,
      );
      assert.match(String(res.body?.error ?? ''), new RegExp(declared.replace('/', '\\/')),
        'the message must name the DECLARED type so the caller knows what it claimed');
      assert.equal(created, null, 'a spoofed photo must not create a job');
    });
  }
}

test('the offending photo INDEX is named, so a customer with five files knows which', async () => {
  const res = await post(booking({
    photos: [
      photoDataUrl('image/jpeg'),
      photoDataUrl('image/jpeg'),
      photoDataUrl('image/png', 'image/jpeg'),   // the bad one
    ],
  }));
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /^Photo 3\b/);
});

test('a NON-IMAGE data URL is refused at the Joi layer, before any decode', async () => {
  const res = await post(booking({ photos: ['data:text/plain;base64,aGVsbG8gd29ybGQ='] }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.match(detailMessages(res), /base64 data URL of type image\/jpeg, image\/png, image\/webp/);
  assert.equal(created, null);
});

test('an SVG data URL is refused — it is a script container, never an image here', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = await post(booking({ photos: [`data:image/svg+xml;base64,${svg.toString('base64')}`] }));
  assert.equal(res.status, 400);
  assert.equal(created, null);
});

test('an SVG wearing an image/png declaration is caught by the magic-byte sniff', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const res = await post(booking({ photos: [`data:image/png;base64,${svg.toString('base64')}`] }));
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /content does not match its declared type/i);
  assert.equal(created, null);
});

test('a BARE base64 string with no data: prefix is refused', async () => {
  const res = await post(booking({ photos: [imageBuffer('image/jpeg').toString('base64')] }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.match(detailMessages(res), /base64 data URL/);
  assert.equal(created, null);
});

test('the LEGACY singular `photo` still works, and `photos` wins when both are sent', async () => {
  const legacy = await post(booking({ photo: photoDataUrl('image/png') }));
  assert.equal(legacy.status, 200);
  assert.equal(created.payload.job_image_filenames.length, 1,
    'the legacy field must still attach an image');

  // Both present: `photos` is the deliberate choice of a caller that knows about
  // the new field, so a BROKEN `photo` alongside a VALID `photos` must succeed.
  const both = await post(booking({
    photos: [photoDataUrl('image/jpeg')],
    photo: photoDataUrl('image/png', 'image/jpeg'),   // would 400 if it were read
  }));
  assert.equal(both.status, 200);
});

test('EVERY photo rides through create() — the router writes no image row itself', async () => {
  const res = await post(booking({
    photos: [photoDataUrl('image/jpeg'), photoDataUrl('image/png'), photoDataUrl('image/webp')],
  }));
  assert.equal(res.status, 200);
  // All three go to create() together, in submission order…
  assert.equal(created.payload.job_image_filenames.length, 3);
  assert.ok(created.payload.job_image_filenames.every((f) => typeof f === 'string' && f.length > 0));
  // …on the PLURAL field only, so photo 1 can never be inserted twice.
  assert.equal(created.payload.job_image_filename, undefined);
  // …and the router issues ZERO tbl_job_image statements of its own. The
  // post-commit attachExtraPhotos() helper is gone; if it ever comes back,
  // this is the assertion that fails.
  const inserts = fake.calls.filter((c) => /INSERT INTO tbl_job_image/i.test(c.sql));
  assert.equal(inserts.length, 0, 'no image row may be written outside create()\'s transaction');
  assert.match(logLines.join('\n'), /photos=3 sent\/3 attached/);
});

test('create() writes EVERY image row INSIDE the transaction, before COMMIT', async () => {
  /*
   * THE REGRESSION THIS PINS. Until 2026-08-07 the router attached photos
   * 2..N with its own pool.query AFTER create() had already committed. A
   * failure in that window left objects in S3 with no tbl_job_image row
   * pointing at them, and the customer's photos silently vanished while the
   * booking stood. Ordering — not merely "the rows exist" — is the contract.
   *
   * This is the ONE test in the file that runs the REAL jobService.create
   * (captured as realJobCreate before before() stubbed it out), over the same
   * fake pool. The fake connection's beginTransaction/commit are no-ops that
   * record nothing, so we wrap them to push BEGIN / COMMIT markers into the
   * same captured-call list as the queries — and make commit THROW, which
   * stops the run right there. Everything after COMMIT in create() is
   * post-commit bookkeeping (getById + the fire-and-forget auto-assign) that
   * this test has no interest in and must not let leak into later tests.
   *
   * The input is the minimal shape job-service-create.test.js established:
   * a pre-existing customer_id + address_id + job_client_owner +
   * branch_details, so the sub-inserts / SPOC lookup / branch-mandatory check
   * are all skipped and the image INSERT is easy to isolate.
   */
  const db = require('../db');
  const realGetConnection = db.pool.getConnection;
  db.pool.getConnection = async () => {
    const conn = await realGetConnection();
    return {
      ...conn,
      beginTransaction: async () => { fake.calls.push({ sql: 'BEGIN', params: [] }); },
      commit: async () => {
        fake.calls.push({ sql: 'COMMIT', params: [] });
        throw new Error('__STOP_AT_COMMIT__');
      },
    };
  };
  try {
    await assert.rejects(
      () => realJobCreate(
        {
          fk_client_id: 42,
          customer: { customer_id: 7 },
          address: { address_id: 55 },
          job_client_owner: 9,     // skips the Primary-SPOC lookup
          branch_details: 'B1',    // skips the branch-mandatory client lookup
          job_image_filenames: ['wb-1.jpg', 'wb-2.png', 'wb-3.webp'],
        },
        { user_id: null },
      ),
      /__STOP_AT_COMMIT__/,
    );
  } finally {
    db.pool.getConnection = realGetConnection;
  }

  const sqls = fake.calls.map((c) => c.sql);
  const begin = sqls.indexOf('BEGIN');
  const commit = sqls.indexOf('COMMIT');
  assert.ok(begin >= 0, 'create() must open a transaction');
  assert.ok(commit > begin, 'create() must reach its commit');

  const imageStmts = fake.calls
    .map((c, i) => ({ ...c, i }))
    .filter((c) => /INSERT INTO tbl_job_image/i.test(c.sql));
  assert.equal(imageStmts.length, 1, 'all three rows go out as ONE multi-row INSERT');

  const stmt = imageStmts[0];
  assert.ok(stmt.i > begin && stmt.i < commit,
    'the image INSERT must sit BETWEEN begin and commit — never after it');
  assert.equal((stmt.sql.match(/\(\?, \?, \?, \?, NOW\(\)\)/g) || []).length, 3,
    'one VALUES group per photo, each still stamping created_date with NOW()');
  assert.deepEqual(stmt.params, [
    NEW_JOB_ID, 'wb-1.jpg', 'booking', 0,
    NEW_JOB_ID, 'wb-2.png', 'booking', 0,
    NEW_JOB_ID, 'wb-3.webp', 'booking', 0,
  ], 'every row carries the SAME column values the single-image branch always did');
  assert.ok(
    !fake.calls.slice(commit + 1).some((c) => /INSERT INTO tbl_job_image/i.test(c.sql)),
    'nothing may write an image row once the transaction has closed',
  );
});

test('create() still honours the LEGACY scalar job_image_filename, unchanged', async () => {
  /*
   * Backward compatibility, pinned. /api/admin/jobs, /api/client/jobs,
   * /api/integration/v1/jobs and both bulk-upload paths still send the
   * singular string; it must emit exactly the statement it always did —
   * one VALUES group, four bound params — and a null/absent value must
   * still be a complete no-op.
   */
  const db = require('../db');
  const realGetConnection = db.pool.getConnection;
  db.pool.getConnection = async () => {
    const conn = await realGetConnection();
    return { ...conn, commit: async () => { throw new Error('__STOP_AT_COMMIT__'); } };
  };
  const runCreate = (imageFields) => assert.rejects(
    () => realJobCreate(
      {
        fk_client_id: 42,
        customer: { customer_id: 7 },
        address: { address_id: 55 },
        job_client_owner: 9,
        branch_details: 'B1',
        ...imageFields,
      },
      { user_id: null },
    ),
    /__STOP_AT_COMMIT__/,
  );
  const imageStmts = () => fake.calls.filter((c) => /INSERT INTO tbl_job_image/i.test(c.sql));

  try {
    await runCreate({ job_image_filename: '  legacy-one.jpg  ' });
    assert.equal(imageStmts().length, 1);
    assert.deepEqual(imageStmts()[0].params, [NEW_JOB_ID, 'legacy-one.jpg', 'booking', 0],
      'still trimmed, still four params, still the same column values');
    assert.match(imageStmts()[0].sql, /VALUES \(\?, \?, \?, \?, NOW\(\)\)$/);

    for (const noop of [{}, { job_image_filename: null }, { job_image_filename: '' },
      { job_image_filenames: [] }, { job_image_filenames: ['', null] }]) {
      fake.calls.length = 0;
      // eslint-disable-next-line no-await-in-loop -- each run needs a clean call log.
      await runCreate(noop);
      assert.equal(imageStmts().length, 0,
        `${JSON.stringify(noop)} must write no image row at all`);
    }

    // Both shapes together: unioned, de-duplicated, singular first.
    fake.calls.length = 0;
    await runCreate({ job_image_filename: 'a.jpg', job_image_filenames: ['a.jpg', 'b.png'] });
    assert.equal(imageStmts().length, 1);
    assert.deepEqual(imageStmts()[0].params, [
      NEW_JOB_ID, 'a.jpg', 'booking', 0,
      NEW_JOB_ID, 'b.png', 'booking', 0,
    ], 'the duplicate collapses instead of inserting the same image twice');
  } finally {
    db.pool.getConnection = realGetConnection;
  }
});

// ═══ 3. PHOTO LIMITS ═════════════════════════════════════════════════
/*
 * Every message here is asserted NOT to echo the payload. That is not
 * defensiveness for its own sake: Joi's DEFAULT `string.pattern.base` and
 * `string.max` messages interpolate the offending value, which would splice
 * multiple megabytes of base64 into both the 400 body and the validation warn
 * log. The custom messages in bookingBody exist solely to prevent that, and
 * these assertions are what stop someone deleting them as noise.
 */

test('a SIXTH photo is refused, and the message states the limit', async () => {
  const res = await post(booking({
    photos: Array.from({ length: 6 }, () => photoDataUrl('image/jpeg')),
  }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.match(detailMessages(res), /At most 5 photos may be attached/);
  assert.equal(created, null);
});

test('exactly 5 photos is still accepted — the boundary is inclusive', async () => {
  const res = await post(booking({
    photos: Array.from({ length: 5 }, () => photoDataUrl('image/jpeg')),
  }));
  assert.equal(res.status, 200);
});

test('a photo over the per-photo 5MB ceiling is refused by the Joi PRE-FILTER, without echoing it', async () => {
  const oversized = photoDataUrl('image/jpeg', 'image/jpeg', 6 * MB);
  const res = await post(booking({ photos: [oversized] }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.match(detailMessages(res), /Each photo must be under 5MB/);
  assert.equal(created, null);
  // The regression the custom messages exist for.
  assert.ok(!everythingSaid(res).includes(oversized.slice(200, 400)),
    'neither the response nor the log may echo the base64 payload');
  assert.ok(JSON.stringify(res.body).length < 2000, 'the 400 body must stay small');
});

test('a photo that slips past the pre-filter is still caught by the DECODED byte check', async () => {
  /*
   * MAX_PHOTO_DATA_URL_CHARS is a deliberately loose character-count guard
   * (+64 slack for the data: prefix and padding), so a payload can be a hair
   * over 5 MB DECODED while still under the character cap. That gap is exactly
   * what the authoritative Buffer.length check in decodePhotos() covers, and it
   * is reachable — this is the test that proves the pre-filter is not the only
   * gate.
   */
  const justOver = photoDataUrl('image/jpeg', 'image/jpeg', 5 * MB + 1);
  const res = await post(booking({ photos: [justOver] }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Photo 1 exceeds the 5MB limit',
    'the handler-level decoded check, not the Joi pre-filter');
  assert.equal(created, null);
  assert.ok(!everythingSaid(res).includes(justOver.slice(200, 400)));
});

test('a batch over the COMBINED 12MB cap is refused, and the message states 12MB', async () => {
  // 3 × 4.5 MB = 13.5 MB decoded. Each photo is individually legal; only the
  // SUM is over — the case a naive front-end (and a naive per-item check) miss.
  const photos = Array.from({ length: 3 }, () => photoDataUrl('image/jpeg', 'image/jpeg', 4.5 * MB));
  const res = await post(booking({ photos }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Photos exceed the combined 12MB limit');
  assert.equal(created, null);
  assert.ok(!everythingSaid(res).includes(photos[0].slice(200, 400)),
    'the combined-limit message must not echo the payload either');
  assert.ok(JSON.stringify(res.body).length < 2000);
});

test('a batch JUST UNDER the 12MB cap is ACCEPTED — the raised wire limit is real', async () => {
  /*
   * The end-to-end proof that server.js's 25 MB JSON limit actually admits the
   * 12 MB combined budget. 12 MB decoded ≈ 16.8 M base64 characters; under the
   * OLD 10 MB wire limit this request would have died at body-parser with an
   * opaque 413 and never reached a handler. If someone lowers the global limit,
   * THIS is the test that goes red.
   *
   * 3 × 3.75 MB = 11.25 MB decoded. Deliberately a little under the 12 MB cap
   * rather than exactly on it: decodePhotos' cheap pre-filter measures ENCODED
   * characters, which include each photo's ~23-char `data:` prefix, so a batch
   * sized to exactly 12 MB of image data reads as fractionally over budget.
   */
  const photos = Array.from({ length: 3 }, () => photoDataUrl('image/jpeg', 'image/jpeg', 3.75 * MB));
  const wireBytes = JSON.stringify(booking({ photos })).length;
  assert.ok(wireBytes > 10 * MB, `the fixture must exceed the OLD 10MB limit (was ${wireBytes})`);
  assert.ok(wireBytes < 25 * MB, 'and must still fit the NEW 25MB limit');

  const res = await post(booking({ photos }));
  assert.equal(res.status, 200, 'a 413 here means the global JSON limit regressed');
  assert.equal(created.payload.fk_client_id, 1);
});

// ═══ 4. GPS ══════════════════════════════════════════════════════════

test('a valid India pair passes through verbatim to address.gps_location', async () => {
  const res = await post(booking({ gps: '12.9716,77.5946' }));
  assert.equal(res.status, 200);
  assert.equal(created.payload.address.gps_location, '12.9716,77.5946');
});

test('an OUT-OF-INDIA pair is dropped silently and the booking still proceeds', async () => {
  // (0,0) — the classic browser-geolocation failure, in the Gulf of Guinea.
  const res = await post(booking({ gps: '0,0' }));
  assert.equal(res.status, 200, 'a bad reading must NEVER cost the customer their booking');
  assert.equal(created.payload.address.gps_location, undefined,
    'out-of-bounds must reach the address writer as absent, not as a bogus pin');
  assert.match(logLines.join('\n'), /GPS dropped/, 'a systematically broken FE must be visible in the logs');
});

test('every side of the India bounding box is enforced', async () => {
  const outside = ['5.9,77.5', '38.1,77.5', '20.0,67.9', '20.0,98.1'];
  for (const gps of outside) {
    // eslint-disable-next-line no-await-in-loop -- each POST needs its own IP bucket.
    const res = await post(booking({ gps }));
    assert.equal(res.status, 200, `${gps} must be dropped, not rejected`);
    assert.equal(created.payload.address.gps_location, undefined, `${gps} must not be stored`);
  }
  // …and the corners just INSIDE are kept.
  for (const gps of ['6.1,68.1', '37.9,97.9']) {
    // eslint-disable-next-line no-await-in-loop -- see above.
    await post(booking({ gps }));
    assert.equal(created.payload.address.gps_location, gps, `${gps} is inside India and must persist`);
  }
});

test('a MALFORMED gps string is REJECTED 400 at the validator (not dropped)', async () => {
  /*
   * Asserting the REAL behaviour, which differs from the out-of-range case on
   * purpose: a value that is not a lat,lng pair at all never reaches
   * sanitiseGps() — Joi's GPS_PAIR_RE rejects it first. Only a WELL-FORMED but
   * implausible pair gets the silent-drop treatment.
   */
  const res = await post(booking({ gps: 'somewhere near the park' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
  assert.match(detailMessages(res), /GPS must be "<latitude>,<longitude>"/);
  assert.equal(created, null);
  assert.ok(!everythingSaid(res).includes('somewhere near the park'),
    'the custom message exists so the raw value is not echoed back');
});

test('an ABSENT gps leaves gps_location undefined without any log noise', async () => {
  const res = await post(booking());
  assert.equal(res.status, 200);
  assert.equal(created.payload.address.gps_location, undefined);
  assert.doesNotMatch(logLines.join('\n'), /GPS dropped/);
});

// ═══ 5. DATE GATE — IST, and deterministic ═══════════════════════════
/*
 * todayIST() is jobService.formatMysqlDateTimeIST(new Date()).slice(0,10), and
 * that function is stubbed to FIXED_IST_NOW for this whole file. So these tests
 * do not care what time it is, what timezone the container is in, or whether
 * the run straddles IST midnight — the three ways a real clock would break them.
 */

test('the clock IS stubbed — these date tests cannot drift with real time', () => {
  assert.equal(jobService.formatMysqlDateTimeIST(new Date()), FIXED_IST_NOW);
  assert.equal(FIXED_IST_NOW.slice(0, 10), FIXED_TODAY);
});

test('a PAST IST date is refused 400 and creates nothing', async () => {
  const res = await post(booking({ date: YESTERDAY }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Appointment date cannot be in the past');
  assert.equal(created, null);
});

test('TODAY in IST is accepted', async () => {
  const res = await post(booking({ date: FIXED_TODAY }));
  assert.equal(res.status, 200);
  assert.equal(created.payload.requested_date_time.slice(0, 10), FIXED_TODAY);
});

test('a FUTURE date is accepted', async () => {
  const res = await post(booking({ date: TOMORROW }));
  assert.equal(res.status, 200);
  assert.equal(created.payload.requested_date_time.slice(0, 10), TOMORROW);
});

test('the gate reads the IST wall clock, NOT the container date', async () => {
  /*
   * The scenario this protects: it is 2026-08-07 23:30 IST, which is
   * 2026-08-07 18:00 UTC — same day. But at 2026-08-08 00:30 IST the container
   * (UTC) still reads 2026-08-07, so a customer booking "today" 08-08 late in
   * the IST evening must be accepted. Move the stubbed IST clock past midnight
   * while the UTC day has not turned, and 08-08 must pass while 08-07 fails.
   */
  const original = jobService.formatMysqlDateTimeIST;
  jobService.formatMysqlDateTimeIST = () => `${TOMORROW} 00:30:00`;   // 19:00 UTC on 08-07
  try {
    assert.equal((await post(booking({ date: TOMORROW }))).status, 200,
      'the new IST day must be bookable the moment IST rolls over');
    assert.equal((await post(booking({ date: FIXED_TODAY }))).status, 400,
      'and the IST day that just ended must close, even though UTC still reads it as today');
  } finally {
    jobService.formatMysqlDateTimeIST = original;
  }
});

test('a date the pincode step would reject never gets there — the date gate runs FIRST', async () => {
  const res = await post(booking({ date: YESTERDAY, pincode: '999999' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Appointment date cannot be in the past',
    'the cheap in-memory gate must precede the paid geocoding path');
});

// ═══ 6. HONEYPOT ═════════════════════════════════════════════════════

test('a filled honeypot returns a SUCCESS-SHAPED 200 and creates nothing', async () => {
  const res = await post(booking({ website: 'https://spam.example' }));
  assert.equal(res.status, 200, 'a bot that learns why it failed simply adapts');
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data, { accepted: true });
  assert.equal(created, null, 'jobService.create must NEVER be called for a honeypot hit');
  assert.equal(fake.calls.length, 0, 'and not a single query may run');
});

test('the honeypot short-circuits BEFORE the date gate and the photo decode', async () => {
  // Every other gate in this payload would have 400'd. The honeypot wins, and
  // still returns the indistinguishable 200 — no error leaks the reason.
  const res = await post(booking({
    website: 'bot',
    date: YESTERDAY,
    photos: [photoDataUrl('image/png', 'image/jpeg')],
  }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { accepted: true });
  assert.equal(created, null);
});

test('an EMPTY honeypot is a real customer and books normally', async () => {
  const res = await post(booking({ website: '' }));
  assert.equal(res.status, 200);
  assert.ok(created, 'the hidden field is empty for every real browser');
  assert.equal(res.body.data.jobId, 918273);
});

// ═══ 7. THE PAYLOAD HANDED TO jobService.create ══════════════════════

test('source_type is EXACTLY lowercase \'website\'', async () => {
  await post(booking());
  assert.equal(created.payload.source_type, 'website');
  assert.notEqual(created.payload.source_type, 'Website');
  assert.notEqual(created.payload.source_type, 'Easyfix Website');
});

test('initial_status is 9 (Unconfirmed) and is never taken from the body', async () => {
  // A caller trying to pick a status must not be able to; the field is not even
  // in the schema, so stripUnknown drops it before the handler.
  await post(booking({ initial_status: 1, status: 3, job_status: 3 }));
  assert.equal(created.payload.initial_status, 9);
  assert.equal(created.payload.initial_status, jobService.STATUS.UNCONFIRMED);
});

test('NO client_spoc* key is ever sent — those columns stay NULL on a website booking', async () => {
  await post(booking({ code: 'EFXQR7' }));
  const spocKeys = Object.keys(created.payload).filter((k) => k.startsWith('client_spoc'));
  assert.deepEqual(spocKeys, [],
    'the SPOC is the CLIENT\'s named contact; guessing one stamps a real person onto a stranger\'s order');
});

test('the actor is null — there is no authenticated user behind a public booking', async () => {
  await post(booking());
  assert.deepEqual(created.actor, { user_id: null });
});

test('preferredWindow is folded into remarks as a [Preferred Window] line', async () => {
  await post(booking({ preferredWindow: '08:00-10:00' }));
  assert.ok(created.payload.remarks.includes('[Preferred Window]'));
  assert.equal(created.payload.remarks, '[Preferred Window] 08:00-10:00');
});

test('preferredWindow is PRESENTATION ONLY — it never moves the booked band', async () => {
  await post(booking({ timeSlot: BAND_MORNING, preferredWindow: '18:00-20:00' }));
  assert.equal(created.payload.time_slot, BAND_MORNING, 'the canonical band still governs scheduling');
  assert.equal(created.payload.requested_time, '09:00');
});

test('no preferredWindow leaves remarks undefined (tbl_job.remarks stays NULL)', async () => {
  await post(booking());
  assert.equal(created.payload.remarks, undefined);
});

test('customer + address fields land in the nested blocks create() expects', async () => {
  await post(booking({ email: 'anita@example.com', building: 'Tower A', landmark: 'Near Park' }));
  assert.deepEqual(created.payload.customer, {
    customer_name: 'Anita Rao',
    customer_mob_no: '9876500001',
    customer_email: 'anita@example.com',
  });
  assert.equal(created.payload.address.city_id, 77, 'resolved from the pincode, not sent by the caller');
  assert.equal(created.payload.address.pin_code, '560038');
  assert.equal(created.payload.address.mobile_number, '9876500001');
});

test('an unresolvable pincode 400s from the geocoding fallback and creates nothing', async () => {
  const res = await post(booking({ pincode: '999999' }));
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /999999/);
  assert.equal(created, null);
});

// ── THE SENTINEL. The single most fragile thing in this route. ───────
/*
 * `requested_date_time` MUST be a UTC-midnight sentinel and the time-of-day MUST
 * ride separately on `requested_time`. combineDateTime() detects the midnight
 * sentinel and splices the HH:MM in as IST clock time. Send a naive local ISO
 * string instead and `new Date()` parses it as SERVER-local — UTC on our
 * containers — after which formatMysqlDateTimeIST adds +05:30 and every morning
 * booking silently files itself into the afternoon band. Nothing throws. The
 * only symptom is customers being visited in the wrong window.
 */

test('SENTINEL: requested_date_time is UTC midnight, with the hour on requested_time', async () => {
  await post(booking({ date: TOMORROW, timeSlot: BAND_MORNING }));
  assert.equal(created.payload.requested_date_time, `${TOMORROW}T00:00:00.000Z`);
  assert.match(created.payload.requested_time, /^\d{2}:\d{2}$/);
  assert.equal(created.payload.requested_time, '09:00');
});

test('SENTINEL: the date form is Z-terminated UTC midnight, never a naive local ISO string', async () => {
  await post(booking({ date: TOMORROW, timeSlot: BAND_AFTERNOON }));
  const sent = created.payload.requested_date_time;
  assert.ok(sent.endsWith('T00:00:00.000Z'), `must end at UTC midnight, got ${sent}`);
  assert.doesNotMatch(sent, /T\d{2}:\d{2}:\d{2}$/,
    'a naive (offset-less) ISO string is the bug this test exists for');
  assert.ok(!/T(?!00:00:00\.000Z)/.test(sent), 'the time-of-day must not be baked into the date');

  // Parsed as an instant it is EXACTLY UTC midnight on the requested calendar
  // day — which is what makes it identical on a UTC container and an IST laptop.
  const d = new Date(sent);
  assert.equal(d.getUTCHours(), 0);
  assert.equal(d.getUTCMinutes(), 0);
  assert.equal(d.toISOString().slice(0, 10), TOMORROW,
    'the UTC calendar day must equal the date the customer picked — no ±1 day shift');
});

test('SENTINEL: every band maps to an hour INSIDE itself, so resolveTimeSlot agrees', async () => {
  /*
   * tbl_job.time_slot is DERIVED from the appointment instant, overriding any
   * label we pass — so an hour outside the chosen band would silently rewrite
   * the customer's slot. This pins the band → start-hour table.
   */
  const expected = [[BAND_MORNING, '09:00'], [BAND_AFTERNOON, '12:00'], [BAND_EVENING, '15:00']];
  for (const [band, hour] of expected) {
    // eslint-disable-next-line no-await-in-loop -- each POST needs its own IP bucket.
    const res = await post(booking({ date: TOMORROW, timeSlot: band }));
    assert.equal(res.status, 200);
    assert.equal(created.payload.requested_time, hour, `${band} must start at ${hour}`);
    assert.equal(created.payload.time_slot, band);
    assert.equal(created.payload.requested_date_time, `${TOMORROW}T00:00:00.000Z`);
  }
});

test('\'After Hours\' is NOT offered to an unauthenticated form', async () => {
  const res = await post(booking({ timeSlot: 'After Hours' }));
  assert.equal(res.status, 400, 'an after-hours visit is an ops decision, not a public promise');
  assert.equal(created, null);
});

// ═══ 8. GET /context ═════════════════════════════════════════════════

test('/context publishes the NEW 12MB combined cap alongside the unchanged per-photo limits', async () => {
  const res = await get('/context');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.maxTotalPhotoBytes, 12 * MB, 'the FE validates its selection against this');
  assert.equal(res.body.data.maxPhotoBytes, 5 * MB);
  assert.equal(res.body.data.maxPhotos, 5);
  assert.deepEqual(res.body.data.acceptedPhotoTypes, IMAGE_TYPES);
});

test('/context echoes the client DISPLAY NAME and code — never the client_id', async () => {
  const res = await get('/context?code=EFXQR7');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.client, { name: 'Voltas Retail', code: 'EFXQR7' });
  assert.ok(!JSON.stringify(res.body).includes('client_id'));
  assert.ok(!JSON.stringify(res.body).includes('"42"') && !/[^0-9]42[^0-9]/.test(JSON.stringify(res.body.data.client)));
});

test('/context returns client:null with HTTP 200 for an unknown code — not a 404 oracle', async () => {
  const unknown = await get('/context?code=NOT-A-CODE');
  assert.equal(unknown.status, 200, 'a 404 would let an attacker enumerate our client list');
  assert.equal(unknown.body.data.client, null);
  const absent = await get('/context');
  assert.equal(absent.status, 200);
  assert.equal(absent.body.data.client, null);
  // Same shape either way — only `client` differs.
  assert.deepEqual(Object.keys(unknown.body.data).sort(), Object.keys(absent.body.data).sort());
});

// ═══ 9. GET /serviceability — advisory, and never a write ════════════

test('/serviceability reports a known pincode without ever calling ensurePincode', async () => {
  let ensured = 0;
  const original = pincodeService.ensurePincode;
  pincodeService.ensurePincode = async () => { ensured += 1; };
  try {
    const res = await get('/serviceability?pincode=560038');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { known: true, serviceable: true, cityName: 'Bengaluru' });
    const off = await get('/serviceability?pincode=110001');
    assert.equal(off.body.data.serviceable, false);
    const unknown = await get('/serviceability?pincode=999999');
    assert.deepEqual(unknown.body.data, { known: false, serviceable: false, cityName: null });
    assert.equal(ensured, 0,
      'a read endpoint must not reach the PAID geocoder or create geography rows');
  } finally {
    pincodeService.ensurePincode = original;
  }
});

test('/serviceability is ADVISORY — a non-serviceable pincode still books', async () => {
  const advisory = await get('/serviceability?pincode=110001');
  assert.equal(advisory.body.data.serviceable, false);
  const res = await post(booking({ pincode: '110001' }));
  assert.equal(res.status, 200, 'coverage changes the moment a technician is onboarded');
  assert.equal(created.payload.address.city_id, 12);
});
