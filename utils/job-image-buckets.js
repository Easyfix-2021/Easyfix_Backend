/*
 * tbl_job_image classification — the ONE place that knows what a job image is.
 *
 * Several producers write this table with different vocabularies for the same
 * evidence, and every consumer that re-derived the rules got a different subset
 * of them right:
 *
 *   legacy Java / Flutter stack   'checkin' / 'checkout'      job_stage 2
 *     (still ~all live rows;       (also seen at stage 0, 1, 9 and 20)
 *      537k checkout, 445k checkin)
 *   this backend, recordImages()  'Booking' / 'Completion'    job_stage 0 / 5
 *   website / WhatsApp / CRM      'booking'                   job_stage 0
 *   partner API v1 + v2           'unconfirmed'               job_stage 0
 *   customer feedback PDF         'feedback'                  job_stage 5
 *
 * ⚠ `job_stage` is NOT a before/after axis. Measured over the full table:
 * stage 2 carries BOTH checkin and checkout so it cannot separate them; stage 0
 * also carries 'po' / 'jobsheet' / 'questionaire'; stage 5 is 278k feedback
 * PDFs. An `OR job_stage = 5` after-predicate in the PHE read model returned
 * 278,977 rows of which ZERO were work photos, so the technician app showed the
 * customer's feedback PDF as a completed job's only "after photo" while every
 * real checkout image was dropped. Classify on the category label; never on the
 * stage.
 */

/** Booking-time and arrival evidence — the "before" half of proof of work. */
const PROOF_BEFORE_CATEGORIES = ['booking', 'before', 'checkin', 'unconfirmed'];

/** Completion evidence — the "after" half. */
const PROOF_AFTER_CATEGORIES = ['completion', 'after', 'checkout'];

/*
 * Categories that are proof of something else. Listed so a consumer can say
 * "not a work photo" positively instead of by falling off the end of an if/else
 * — and so the next category added here is a decision, not an accident.
 */
const DOCUMENT_CATEGORIES = ['feedback', 'po', 'jobsheet', 'questionaire', 'customer signature'];

/** Lowercased, whitespace-normalised category — 'Customer Signature' → 'customer_signature'. */
function normaliseCategory(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * 'before' | 'after' | null for one tbl_job_image row (or bare category string).
 * null means "not a before/after work photo" — a document, or an unlabelled row
 * that nothing can honestly place (stage 2 holds both halves, so guessing from
 * it would be a coin flip).
 */
function proofBucketOf(rowOrCategory) {
  const category = normaliseCategory(
    rowOrCategory && typeof rowOrCategory === 'object' ? rowOrCategory.image_category : rowOrCategory,
  );
  if (PROOF_AFTER_CATEGORIES.includes(category)) return 'after';
  if (PROOF_BEFORE_CATEGORIES.includes(category)) return 'before';
  return null;
}

/**
 * Quote a FIXED INTERNAL allowlist for a SQL `IN (...)` list. The only callers
 * pass the constants above — never request data — so there is no injection
 * surface; the alternative (placeholders) would make the two bucket queries
 * textually identical, which their tests discriminate on.
 */
function sqlCategoryList(categories) {
  return categories.map((c) => `'${c}'`).join(', ');
}

/**
 * A stored image value that is a PDF is a document, not a photo. `feedback` is
 * 100% PDF and `po` is 92%, and a PDF handed to an <Image> renders as a blank
 * tile — which reads as a broken photo rather than as the wrong category.
 */
function isPhotoFile(storedValue) {
  return !/\.pdf$/i.test(String(storedValue ?? ''));
}

/*
 * WHAT NEW WRITES STORE.
 *
 * The app speaks 'Booking' / 'Completion' — that is its own S3 key convention
 * (JobSupportings/<Category>_<jobId>_<seq>) and its request contract, and both
 * stay as they are. But the value PERSISTED in image_category is now the legacy
 * vocabulary, because that is the one every other consumer in the estate was
 * already written against: the client mobile app filters proof photos on
 * 'checkin' / 'checkout' and could not see a single photo the new app took.
 *
 * One vocabulary in the column, two spellings on the wire, and readers keep
 * accepting both — 445k historical rows are not going to be rewritten.
 */
const WRITE_CATEGORY = { Booking: 'checkin', Completion: 'checkout' };

/**
 * The value to STORE for an app-supplied category. Unknown categories pass
 * through lowercased, which is what the pre-existing upload path already did.
 */
function persistedCategory(category) {
  return WRITE_CATEGORY[String(category ?? '').trim()] ?? normaliseCategory(category);
}

module.exports = {
  PROOF_BEFORE_CATEGORIES,
  PROOF_AFTER_CATEGORIES,
  DOCUMENT_CATEGORIES,
  normaliseCategory,
  proofBucketOf,
  sqlCategoryList,
  isPhotoFile,
  persistedCategory,
};
