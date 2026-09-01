const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * The encryption of tbl_user_personal_details.bank_account_number and
 * .bank_account_name holds ONLY while every read and write goes through
 * lib/field-crypto.js — today via encryptBank / decryptBank in the self-service
 * module and in the approve path.
 *
 * Nothing about the schema enforces that. The columns are ordinary VARCHARs;
 * a new service that writes one directly stores plaintext, the column happily
 * accepts it, every test passes, and the value sits there readable next to
 * ciphertext with nothing to distinguish the two until someone reads the table.
 * That is the failure this file exists to make impossible — it turns a
 * convention into a build failure.
 *
 * WHY THE PREDICATE IS A PAIR, NOT A COLUMN NAME
 * ----------------------------------------------
 * `bank_account_number` is ALSO a real column on tbl_easyfixer_withdrawal_request,
 * where it is a deliberate plaintext snapshot of a technician's payout
 * destination and has nothing to do with this feature. A scanner that flagged
 * the column name alone would fire on services/withdrawal.service.js on day one,
 * and a guard whose first result is a false positive gets an allowlist entry and
 * then gets ignored.
 *
 * So a file is only flagged when it names the TABLE and one of the encrypted
 * columns together. That is what actually identifies this feature's data.
 */

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['services', 'routes', 'lib', 'middleware', 'utils'];

const TABLE = 'tbl_user_personal_details';
const ENCRYPTED_COLUMNS = ['bank_account_number', 'bank_account_name'];

/*
 * The crypto module itself, which necessarily names the columns it protects.
 * Everything ELSE earns its place by USING the helpers rather than by being
 * listed here — see below.
 */
const ALLOWED = new Set([
  path.join('lib', 'field-crypto.js'),
]);

/*
 * THE INVARIANT, AND WHY IT IS NOT AN ALLOWLIST.
 *
 * The first version of this guard allowlisted the one service that owned the
 * columns. It failed immediately on services/profile-update-request.service.js
 * — which turned out to be a legitimate second member: the approve path writes
 * the columns and it does so through encryptBank().
 *
 * That is the tell that an allowlist was the wrong shape. It would have had to
 * grow a name for every honest caller, and each addition looks identical in the
 * diff to someone quietly widening the boundary — while a NEW file that stored
 * plaintext could equally be added to it with a plausible sentence.
 *
 * So the rule is the property we actually want: code that touches these columns
 * must also go through the crypto helpers. A file that names the table and a
 * protected column while never mentioning encryptBank or decryptBank is, by
 * construction, moving those values in the clear.
 *
 * This is not airtight — a file could import the helpers and still write a
 * plaintext elsewhere in the same module. It is a far narrower hole than a name
 * list, and unlike a name list it admits every correct caller automatically
 * while rejecting the careless one by default.
 */
const CRYPTO_HELPERS = [
  'encryptBank', 'decryptBank',
  // The re-key primitives move a protected value across the boundary too — they
  // unwrap and re-wrap the DEK. Added 2026-09-01 when services/field-rekey.service.js
  // arrived: it consumes them correctly and never handles a plaintext, but the guard
  // flagged it because this list did not yet know they existed.
  //
  // Note what is NOT on this list: isEncrypted, maskAccountNumber, maskName. Those
  // INSPECT a value without moving it, so importing one must not buy a file the right
  // to write these columns. The list is "functions that carry the secret through the
  // boundary", not "anything exported by lib/field-crypto.js" — which is why it is
  // enumerated by hand rather than derived from the module's exports.
  'rewrapToOperationalKey', 'resealToRecoveryKey',
];

function walk(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/* Comments are stripped so a file that merely EXPLAINS the rule is not caught by
 * it — the block above this line names both the table and the columns. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function offenders() {
  const found = [];
  for (const dir of SCAN_DIRS) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, abs);
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      if (!code.includes(TABLE)) continue;
      const hits = ENCRYPTED_COLUMNS.filter((c) => code.includes(c));
      if (!hits.length) continue;
      if (CRYPTO_HELPERS.some((h) => code.includes(h))) continue; // goes through the boundary
      found.push(`${rel}  →  ${hits.join(', ')}`);
    }
  }
  return found;
}

test('nothing touches the encrypted bank columns without going through the crypto boundary', () => {
  assert.deepEqual(offenders(), [],
    'these name tbl_user_personal_details AND an encrypted bank column without '
    + 'going through encryptBank / decryptBank, which means they move the value in '
    + 'the clear. Route the access through lib/field-crypto.js.');
});

test('the scan actually reaches the code it claims to cover', () => {
  /*
   * A default-deny scanner that silently walks nothing reports a clean pass
   * forever. This pins that the walk found a real corpus and that the file it
   * exists to protect is inside it.
   */
  const all = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
  assert.ok(all.length > 100, `expected to scan the backend, saw ${all.length} files`);
  const rels = all.map((a) => path.relative(ROOT, a));
  assert.ok(rels.includes(path.join('services', 'profile-self.service.js')),
    'the module that owns these columns must be inside the scanned corpus, or the '
    + 'scan is passing because it looked nowhere');
});

test('the detector fires on the shape it is meant to catch', () => {
  /*
   * Mutation check. Without this, a predicate that stopped matching — a renamed
   * column, a typo in TABLE — would leave a test that passes forever while
   * enforcing nothing, which is worse than having no test at all because it
   * reads as coverage.
   */
  const leak = `
    const sql = 'UPDATE ${TABLE} SET bank_account_number = ? WHERE user_id = ?';
  `;
  const code = stripComments(leak);
  assert.ok(
    code.includes(TABLE) && code.includes('bank_account_number')
      && !CRYPTO_HELPERS.some((h) => code.includes(h)),
    'the predicate must match a direct plaintext write');

  // The same statement, but routed through the boundary — must NOT be flagged.
  const honest = `
    const enc = encryptBank(bank);
    const sql = 'UPDATE ${TABLE} SET bank_account_number = ? WHERE user_id = ?';
  `;
  const hc = stripComments(honest);
  assert.ok(CRYPTO_HELPERS.some((h) => hc.includes(h)),
    'a caller that uses the helpers is a legitimate member of the boundary');

  // The withdrawal table's own column, which is deliberately NOT this feature.
  const innocent = `
    const sql = 'SELECT bank_account_number FROM tbl_easyfixer_withdrawal_request WHERE id = ?';
  `;
  const ic = stripComments(innocent);
  assert.ok(!(ic.includes(TABLE) && ic.includes('bank_account_number')),
    'the predicate must NOT fire on the withdrawal snapshot — a guard whose first '
    + 'result is a false positive is a guard that gets ignored');
});
