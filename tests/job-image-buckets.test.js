const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROOF_AFTER_CATEGORIES,
  PROOF_BEFORE_CATEGORIES,
  DOCUMENT_CATEGORIES,
  proofBucketOf,
  persistedCategory,
  sqlCategoryList,
  isPhotoFile,
} = require('../utils/job-image-buckets');

/*
 * The categories that actually exist in tbl_job_image, measured 2026-09-01 over
 * all 1.38M rows. Fixtures elsewhere used 'booking' / 'completion' — the values
 * THIS backend writes — which is exactly how a reader that could not see a
 * single 'checkout' row passed its tests for months. These are the real ones,
 * with their real volumes, so a rule that only works on our own spelling fails
 * here.
 */
const LIVE_CATEGORIES = [
  { category: 'checkout', rows: 536992, bucket: 'after' },
  { category: 'checkin', rows: 445013, bucket: 'before' },
  { category: 'feedback', rows: 278115, bucket: null },
  { category: 'customer signature', rows: 64117, bucket: null },
  { category: 'unconfirmed', rows: 31403, bucket: 'before' },
  { category: 'questionaire', rows: 11480, bucket: null },
  { category: 'jobsheet', rows: 3129, bucket: null },
  { category: 'po', rows: 2565, bucket: null },
  { category: 'booking', rows: 30, bucket: 'before' },
];

test('every category in the live table classifies the way it was measured', () => {
  for (const { category, rows, bucket } of LIVE_CATEGORIES) {
    assert.equal(
      proofBucketOf({ image_category: category }), bucket,
      `'${category}' (${rows} rows) must bucket as ${bucket ?? 'neither'}`,
    );
  }
});

test('job_stage is never consulted — it cannot separate the two halves', () => {
  // Both checkin and checkout live at stage 2, so any rule that reads the stage
  // is guessing. Stage 5 is the feedback PDF and stage 0 carries po/jobsheet.
  assert.equal(proofBucketOf({ image_category: 'checkin', job_stage: 2 }), 'before');
  assert.equal(proofBucketOf({ image_category: 'checkout', job_stage: 2 }), 'after');
  assert.equal(proofBucketOf({ image_category: 'feedback', job_stage: 5 }), null);
  assert.equal(proofBucketOf({ image_category: 'po', job_stage: 0 }), null);
  // An unlabelled row is honestly unplaceable rather than defaulted into one half.
  assert.equal(proofBucketOf({ image_category: null, job_stage: 2 }), null);
  assert.equal(proofBucketOf({ job_stage: 0 }), null);
});

test('case and padding do not change the bucket', () => {
  assert.equal(proofBucketOf({ image_category: 'Completion' }), 'after');
  assert.equal(proofBucketOf({ image_category: '  CheckIn ' }), 'before');
  assert.equal(proofBucketOf('CHECKOUT'), 'after', 'a bare string works too');
});

test('what a new write STORES is classified back into the bucket it came from', () => {
  // The round trip is the whole point of the write-side mapping: if these two
  // ever disagree, the app writes photos its own read model cannot find.
  assert.equal(persistedCategory('Booking'), 'checkin');
  assert.equal(persistedCategory('Completion'), 'checkout');
  assert.equal(proofBucketOf({ image_category: persistedCategory('Booking') }), 'before');
  assert.equal(proofBucketOf({ image_category: persistedCategory('Completion') }), 'after');
  // Anything else falls through lowercased, as the pre-existing upload path did.
  assert.equal(persistedCategory('Reschedule'), 'reschedule');
  assert.equal(persistedCategory(null), '');
});

test('the before and after allowlists are disjoint, and documents are in neither', () => {
  const before = new Set(PROOF_BEFORE_CATEGORIES);
  for (const category of PROOF_AFTER_CATEGORIES) {
    assert.equal(before.has(category), false, `'${category}' cannot be both halves`);
  }
  for (const category of DOCUMENT_CATEGORIES) {
    assert.equal(proofBucketOf({ image_category: category }), null,
      `'${category}' is proof of something else`);
  }
});

test('a PDF is a document whatever it is tagged', () => {
  assert.equal(isPhotoFile('529042_checkout_20260823060303.jpg'), true);
  assert.equal(isPhotoFile('feedback529042.pdf'), false);
  assert.equal(isPhotoFile('FEEDBACK.PDF'), false);
  assert.equal(isPhotoFile('JobSupportings/Booking_18421_1'), true, 'canonical keys carry no extension');
  assert.equal(isPhotoFile(null), true);
});

test('the SQL IN-list is built from the allowlist, quoted, in order', () => {
  assert.equal(sqlCategoryList(['a', 'b']), "'a', 'b'");
  const before = sqlCategoryList(PROOF_BEFORE_CATEGORIES);
  assert.match(before, /^'booking', /, 'order is load-bearing: tests match on the first value');
  for (const category of PROOF_BEFORE_CATEGORIES) {
    assert.ok(before.includes(`'${category}'`), `${category} must reach the query`);
  }
});
