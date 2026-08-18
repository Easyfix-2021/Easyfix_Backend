/*
 * /api/integration/v2/jobs — one request instead of four.
 *
 * v1 makes a partner with three photographs call the image endpoint three
 * times, collect an imageId from each, then create the job carrying those
 * ids. v2 takes the job payload and the files in a single multipart request.
 *
 * Two properties are worth pinning above all others:
 *   · v1 must be COMPLETELY unaffected — real partners depend on it.
 *   · an image failure must NOT fail the job. The job is already committed,
 *     and a 500 would make the partner re-post a job that already exists.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../routes/integration/v2/index.js'), 'utf8');
const V1 = fs.readFileSync(path.join(__dirname, '../routes/integration/v1/index.js'), 'utf8');
const MOUNT = fs.readFileSync(path.join(__dirname, '../routes/integration/index.js'), 'utf8');

/*
 * Strip LINE comments BEFORE block comments — order matters here.
 * `// /api/integration/v1/*` contains a `/*`, so a block-comment pass running
 * first treats it as an opening delimiter and swallows everything up to the
 * next `*​/`, including the code in between. That bug hid the v1 mount from
 * this file's own assertions.
 */
const code = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('v2 is mounted separately, so a v1 caller cannot be affected', () => {
  assert.match(code(MOUNT), /router\.use\('\/v1', require\('\.\/v1'\)\)/);
  assert.match(code(MOUNT), /router\.use\('\/v2', require\('\.\/v2'\)\)/);
});

test('v1 still exposes the two-step flow it always has', () => {
  // The whole promise of v2 is that v1 keeps working untouched.
  assert.match(code(V1), /router\.post\(\['\/jobs', '\/jobs\/newJob'\]/, 'v1 create intact');
  assert.match(code(V1), /jobImage\/addJobImages/, 'v1 image upload intact');
});

test('v2 accepts a repeated `images` part, capped at 5', () => {
  const c = code(SRC);
  assert.match(c, /const MAX_IMAGES = 5/);
  assert.match(c, /upload\.array\('images', MAX_IMAGES\)/,
    'array(), not single() — the part name repeats once per file');
});

test('exceeding the cap is a clean 400, not multer’s opaque error', () => {
  const c = code(SRC);
  assert.match(c, /LIMIT_UNEXPECTED_FILE|LIMIT_FILE_COUNT/);
  assert.match(c, /At most \$\{MAX_IMAGES\} images/);
  assert.match(c, /LIMIT_FILE_SIZE/, 'oversized image also handled explicitly');
});

test('multer runs ONLY on multipart, so the JSON path keeps its body', () => {
  // Running multer over a JSON body consumes the stream and leaves req.body
  // empty — the no-images path would break silently.
  const c = code(SRC);
  assert.match(c, /multipart\/form-data/);
  assert.match(c, /if \(!ct[\s\S]{0,60}includes\('multipart\/form-data'\)\) return next\(\)/);
});

test('a partner with no images can post plain JSON', () => {
  assert.match(code(SRC), /return \{ payload: req\.body \|\| \{\}, error: null \}/);
});

test('an unparseable payload part is a 400 that names the problem', () => {
  const c = code(SRC);
  assert.match(c, /not valid JSON/);
  assert.match(c, /payload` part containing the job JSON is required|payload. part containing/);
});

test('the field mapping matches v1 exactly — v2 changes the envelope, not the semantics', () => {
  // A partner moving v1 → v2 must not re-learn what any field does. Every
  // create() input v1 sets must be set by v2 too.
  const fields = [
    'fk_client_id', 'job_desc', 'job_type', 'source_type', 'requested_date_time',
    'time_slot', 'client_ref_id', 'client_spoc_name', 'client_spoc_email', 'client_spoc',
    'additional_name', 'additional_number', 'helper_req', 'efr_special_notes',
    'booking_cut_off_time_slot', 'collected_by', 'service_type_ids',
  ];
  const c = code(SRC);
  for (const f of fields) assert.ok(c.includes(f), `v2 must map ${f} like v1 does`);
  assert.match(c, /paid_by/, 'paidBy stamped as in v1');
  assert.match(c, /resolveCityId/, 'city resolved by name, as in v1');
  assert.match(c, /paymentCollectedByCode/, 'same payment enum as v1');
});

test('images are inserted in ONE batched statement, not one per file', () => {
  // The entire point is fewer DB round trips than v1's insert-per-upload.
  const c = code(SRC);
  assert.match(c, /INSERT INTO tbl_job_image[\s\S]{0,200}VALUES \$\{rows\.map/,
    'a single multi-row INSERT');
});

test('an image failure does NOT fail the job', () => {
  const c = code(SRC);
  // The job is committed before images are touched, and the catch marks the
  // image rather than rethrowing.
  assert.match(c, /status: 'failed'/);
  assert.ok(!/throw .*image/i.test(c), 'an image problem must never throw out of the handler');
  const insertAt = c.indexOf('INSERT INTO tbl_job_image');
  const createAt = c.indexOf('jobService.create');
  assert.ok(createAt !== -1 && insertAt > createAt, 'the job is created before images are attached');
});

test('the response carries v1’s body plus per-image outcomes', () => {
  const c = code(SRC);
  assert.match(c, /legacyJobEntity\(persisted\)/, 'same entity shape as v1 create');
  assert.match(c, /\.\.\.legacyJobEntity\(persisted\), images/);
  assert.match(c, /res\.status\(201\)/, '201 like v1');
  assert.match(c, /setHeader\('Location'/);
});

test('v2 requires the same Basic Auth as v1', () => {
  assert.match(code(SRC), /router\.use\(basicAuth\)/);
});
