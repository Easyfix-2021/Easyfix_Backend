/*
 * The Kaleyra report sync must never write a TELECOM CARRIER into the voice
 * VENDOR column.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * tbl_job_caller_info.provider means one thing to the whole system: which voice
 * VENDOR placed the call — 'plivo' or 'kaleyra'. Two surfaces branch on it
 * behaviourally (recording playback, hangup) and the Call Tracking report
 * filters and labels on it.
 *
 * Kaleyra's report payload also has a field called `provider`, and it is a
 * different thing entirely: the TELECOM CARRIER for the leg — 'JIO', 'Airtel',
 * 'Vodafone', 'IDEA', 'BSNL'. This cron used to write it through
 * `provider = COALESCE(?, provider)`, so a row correctly stamped 'kaleyra'
 * could be overwritten with 'Airtel'. That is almost certainly the origin of
 * the ~2,721 carrier-valued rows measured in the 2021 data (the measurement
 * lives above PROVIDER_RULE in quicksight-call-tracking.service.js).
 *
 * Nothing was lost by dropping the write: the cron's own work list selects only
 * rows already known to be Kaleyra's, so it can never learn a vendor it did not
 * already know — every write it could make was a no-op or the corruption.
 *
 * ─── WHY THESE ARE SOURCE ASSERTIONS ──────────────────────────────────────
 *
 * applyReportToRow is not exported (only syncPendingReports is), and driving
 * the cron end to end would need Kaleyra's HTTP API. The regression worth
 * guarding is textual anyway — someone restoring the COALESCE line — and it ran
 * live on a 4-hourly schedule (server/scheduler.js) with NO coverage at all
 * until now, which is how the carrier write survived as long as it did.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'kaleyra-report-sync.service.js'), 'utf8',
);

/** The UPDATE statement applyReportToRow runs, plus the params array beside it. */
function updateCall() {
  const i = SRC.indexOf('UPDATE tbl_job_caller_info');
  assert.ok(i > 0, 'the UPDATE moved — re-point this test before trusting it');
  const sql = SRC.slice(i, SRC.indexOf('`', i));
  const after = SRC.slice(i);
  const arr = after.slice(after.indexOf('[') + 1, after.indexOf(']'));
  const params = arr.split(',').map((x) => x.trim()).filter(Boolean);
  return { sql, params };
}

test('the UPDATE assigns no provider at all', () => {
  const { sql } = updateCall();
  assert.equal(
    /provider\s*=/.test(sql), false,
    'a carrier value must never reach the vendor column — this is the exact line that '
    + 'could overwrite a correct "kaleyra" stamp with "Airtel"',
  );
});

/*
 * Comments are stripped first, on purpose. The block explaining the omission
 * NAMES report.provider, so a naive scan of the whole file matches its own
 * documentation and the assertion passes or fails on prose rather than on code
 * — which is not a test, it is a coincidence.
 */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
  .replace(/^\s*\/\/.*$/gm, '');          // line comments

test('report.provider is not read by any CODE in the file', () => {
  // Reading it is harmless alone, but it is the first half of restoring the
  // bug, and the comment is easier to trust when the value is genuinely out of
  // scope rather than merely unused.
  assert.equal(
    /\breport\.provider\b/.test(CODE), false,
    'the carrier field must not be pulled off the payload',
  );
  // …and the explanation is still present in the file as a whole.
  assert.match(SRC, /report\.provider/, 'the omission must stay documented');
});

test('placeholders and params still balance — the class of bug that shifts every binding', () => {
  const { sql, params } = updateCall();
  const placeholders = (sql.match(/\?/g) || []).length;
  assert.equal(
    params.length, placeholders,
    `UPDATE has ${placeholders} placeholders but ${params.length} params: ${params.join(', ')}`,
  );
  // The removed one was the 8th of 9; everything after it would have shifted by
  // one had the param not been removed with it. Pin the survivors in order.
  assert.deepEqual(params, [
    'startTime', 'endTime', 'duration', 'callerSt', 'receiverSt',
    'recording', 'location', 'jobCallerInfoId',
  ]);
});

test('everything the cron legitimately syncs is still written', () => {
  // Dropping the provider write must not have quietly dropped a sibling.
  const { sql } = updateCall();
  for (const col of ['start_time', 'end_time', 'duration', 'caller_status',
    'reciever_status', 'recording', 'location', 'is_updated']) {
    assert.match(sql, new RegExp(col + '\\s*='), `${col} must still be synced`);
  }
  assert.match(sql, /WHERE job_caller_info = \?/, 'and it still targets one row');
});

test('the omission is explained where the next reader will look', () => {
  /*
   * A silently absent line reads as an oversight and invites restoration. The
   * comment is the artefact that stops that, so it is part of the fix.
   */
  assert.match(SRC, /TELECOM CARRIER/i);
  assert.match(SRC, /NOT READ/i);
});
