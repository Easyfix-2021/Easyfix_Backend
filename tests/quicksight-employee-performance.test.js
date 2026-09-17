/*
 * QuickSight — Employee Performance snapshot.
 *
 * The uploaded file is data.js: JavaScript by extension, executed in every
 * viewer's browser once injected into the dashboard page. So the guarantees
 * that matter, worst first:
 *
 *   1. ONLY DATA IS STORED. Anything that is not exactly `const D=<json>;`
 *      is refused, and what is stored is a re-serialisation, never the upload.
 *   2. NOTHING IN THE DATA CAN CLOSE THE <script> it is injected into, and no
 *      `$&`-style sequence in it is expanded by the injection.
 *   3. A ROUND TRIP (upload → meta → page) hands the page the same D.
 *
 * No S3, no DB: S3 is forced off before the service loads, so storage is a
 * throwaway directory.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

process.env.S3_BUCKET_NAME = '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-emp-perf-'));
process.env.QS_EMPLOYEE_PERFORMANCE_DIR = TMP;

const service = require('../services/quicksight/quicksight-employee-performance.service');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sample = (over = {}) => ({
  employees: { 'Abhishek Yadav': { team: 'Thor', revenue: 28925, daily: [] } },
  verticals: ['Retail Maintenance'],
  months: ['2026-08', '2026-09'],
  dates: ['2026-08-01', '2026-08-02', '2026-09-13'],
  primarySpocs: ['Abhishek Yadav'],
  zonalManagers: ['Unassigned'],
  teamMembers: { Thor: ['Abhishek Yadav'] },
  displayNames: { 'Abhishek Yadav': 'Abhishek Yadav' },
  txRows: [],
  unassigned: [],
  zmBreakdown: [],
  ...over,
});
// Exactly what build_data.py writes.
const asDataJs = (d) => Buffer.from(`const D=${JSON.stringify(d)};\n`);

const extractD = (html) => {
  const m = html.match(/<script>(const D=[\s\S]*?;)<\/script>/);
  assert.ok(m, 'the data script is present');
  // Round-tripped through JSON: objects from another realm fail deepStrictEqual
  // on their prototypes alone.
  return JSON.parse(JSON.stringify(vm.runInNewContext(`${m[1]} D`)));
};

test('accepts the data.js build_data.py writes and summarises it', () => {
  const { data, summary } = service.parseDashboardData(asDataJs(sample()));
  assert.deepEqual(data, sample());
  assert.deepEqual(summary, { dateFrom: '2026-08-01', dateTo: '2026-09-13', employeeCount: 1, spocCount: 1 });
});

test('accepts the same file gzipped (what the CRM sends)', () => {
  const { summary } = service.parseDashboardData(zlib.gzipSync(asDataJs(sample())));
  assert.equal(summary.dateTo, '2026-09-13');
});

test('refuses anything that is not purely the data literal', () => {
  const bad = [
    Buffer.from(`const D=${JSON.stringify(sample())};alert(1);`),
    Buffer.from(`alert(1);const D=${JSON.stringify(sample())};`),
    Buffer.from('const D=(function(){return {}})();'),
    Buffer.from('<html></html>'),
    Buffer.from(''),
  ];
  for (const b of bad) {
    assert.throws(() => service.parseDashboardData(b), (e) => e.status === 400, b.toString().slice(0, 40));
  }
});

test('names the missing / malformed keys of a wrong JSON file', () => {
  const d = sample();
  delete d.employees;
  d.dates = 'not-an-array';
  assert.throws(() => service.parseDashboardData(asDataJs(d)),
    (e) => e.status === 400 && /employees/.test(e.message) && /dates/.test(e.message));
  assert.throws(() => service.parseDashboardData(asDataJs(sample({ dates: ['13/09/2026'] }))),
    (e) => e.status === 400 && /dates/.test(e.message));
  assert.throws(() => service.parseDashboardData(asDataJs(sample({ employees: {} }))),
    (e) => e.status === 400 && /no employees/.test(e.message));
});

test('the shipped template has the line the data is injected into', () => {
  assert.doesNotThrow(() => service._internals.dashboardTemplate());
});

test('round trip: upload → meta → page carries the same D, script-safe', async () => {
  assert.equal(await service.getMeta(), null, 'nothing uploaded yet');
  assert.equal(await service.getDashboardHtml(), null);

  const hostile = sample({
    employees: { 'X</script><script>alert(1)</script>': { team: '$& $1 $`', revenue: 1, daily: [] } },
  });
  const meta = await service.saveSnapshot({
    buffer: asDataJs(hostile),
    originalName: 'data.js',
    user: { user_id: 7, user_name: 'MIS User' },
  });
  assert.equal(meta.employeeCount, 1);
  assert.deepEqual(meta.uploadedBy, { userId: 7, name: 'MIS User' });
  assert.deepEqual(await service.getMeta(), meta);

  const html = await service.getDashboardHtml();
  assert.equal(html.includes(service._internals.DATA_HOOK), false, 'the data.js tag is replaced');
  assert.equal((html.match(/alert\(1\)<\/script>/g) || []).length, 0, 'data cannot close the script element');
  assert.deepEqual(extractD(html), hostile, 'D reaches the page unchanged');
});

test('the page signals the CRM when it is drawn, without depending on rAF', async () => {
  /*
   * The CRM keeps a "preparing" panel over the frame until this message
   * arrives, because the iframe's own load event fires before the ~6.5 MB page
   * has painted. requestAnimationFrame is SUSPENDED in a hidden window, so a
   * signal built on it alone never fires in a background tab and the panel
   * would sit there forever — which is exactly what happened in testing. The
   * timer is the part that must survive.
   */
  const html = await service.getDashboardHtml();
  const signal = html.slice(html.lastIndexOf('<script>'));
  assert.match(signal, /setTimeout\(send,\s*\d+\)/, 'a timer path exists');
  assert.match(signal, /requestAnimationFrame/, 'the accurate post-paint path exists too');
  assert.match(signal, new RegExp(`postMessage\\('${service.READY_MESSAGE}'`), 'posts the agreed message');
  assert.match(signal, /if\(sent\)\{return;\}/, 'the two paths cannot both post');
  assert.ok(html.trimEnd().endsWith('</html>'), 'the signal sits inside the document');
});
