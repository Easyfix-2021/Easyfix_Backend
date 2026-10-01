'use strict';
/*
 * The invoice header total must equal the sum of the lines the invoice prints.
 *
 * WHAT WENT WRONG (found 2026-09-09)
 *
 * routes/admin/finance.js builds every printed line as
 *     line_total: charge * qty + mat
 * but computed the header with
 *     SELECT COALESCE(SUM(js.total_charge * js.quantity), 0)
 * which drops material_charge entirely. A client invoiced for jobs carrying
 * material received a document whose own lines added up to more than the
 * amount it billed, and nothing on the PDF puts the two side by side.
 *
 * It was not a display fault. `POST /invoices/:id/payments` marks an invoice
 * settled with
 *     fullyPaid = (newPaid + newTds) >= Number(inv.total_invoice_amount)
 * against THIS number, so invoices closed while the client still owed the
 * material component of every line.
 *
 * WHY THE OBVIOUS FIX IS WORSE THAN THE BUG
 *
 * The natural patch is to wrap the whole expression:
 *     COALESCE(SUM(js.total_charge * js.quantity + js.material_charge), 0)
 * In MySQL any NULL operand makes the expression NULL, and material_charge is
 * NULL on most rows — so that zeroes the ENTIRE line, not the missing term.
 * On the fixture below it under-bills by 225 where the original bug under-bills
 * by 75. The COALESCE has to sit on each column, and this file exists mostly to
 * stop that patch being applied later by someone reading only the symptom.
 *
 * Runner: `node --test --test-force-exit tests/invoice-header-total.test.js`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FINANCE = fs.readFileSync(path.join(__dirname, '..', 'routes/admin/finance.js'), 'utf8');
// The printed-line builder (loadInvoiceArtifactData) moved here on 2026-09-30 so
// the client portal renders the same PDF; the header SQL stayed in finance.js.
const ARTIFACT = fs.readFileSync(path.join(__dirname, '..', 'services/invoice-artifact.service.js'), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/*
 * MySQL semantics, modelled explicitly rather than with JS operators: a NULL
 * operand poisons the expression, and SUM() skips NULL rows. Using plain JS
 * arithmetic here would quietly coerce NULL to 0 and make the naive fix look
 * correct — the exact confusion the guard is written against.
 */
const N = null;
const mul = (a, b) => (a === N || b === N ? N : a * b);
const add = (a, b) => (a === N || b === N ? N : a + b);
const coalesce = (...xs) => { for (const x of xs) if (x !== N) return x; return N; };
const SUM = (vals) => vals.reduce((s, v) => (v === N ? s : s + v), 0);

/* Deliberately covers all three NULL shapes a live row takes. */
const ROWS = [
  { total_charge: 100, quantity: 3, material_charge: 50 },
  { total_charge: 200, quantity: 1, material_charge: N },
  { total_charge: N, quantity: 2, material_charge: 25 },
];

/** What loadInvoiceArtifactData pushes, and therefore what the PDF/XLSX print. */
const printedLines = ROWS.reduce(
  (s, r) => s + Number(r.total_charge || 0) * Number(r.quantity || 1) + Number(r.material_charge || 0),
  0,
);

test('the shipped header formula equals the lines the invoice prints', () => {
  const header = SUM(ROWS.map((r) => add(
    mul(coalesce(r.total_charge, 0), coalesce(r.quantity, 1)),
    coalesce(r.material_charge, 0),
  )));
  assert.equal(printedLines, 575, 'fixture sanity: the lines total 575');
  assert.equal(header, printedLines, 'the header must not differ from its own line items');
});

test('the ORIGINAL formula under-bills, and by exactly the material total', () => {
  const old = SUM(ROWS.map((r) => mul(r.total_charge, r.quantity)));
  assert.equal(old, 500);
  assert.equal(printedLines - old, 75, 'the shortfall is the material charges, 50 + 25');
  assert.ok(old < printedLines, 'positive control: the bug must under-bill, not over-bill');
});

test('COALESCE around the SUM is WORSE than the bug — 225 short, not 75', () => {
  /*
   * The whole reason this file is longer than the fix. Anyone patching from the
   * symptom ("material is missing, add it") writes this, and it passes review
   * because the arithmetic reads correctly in isolation.
   */
  const naive = SUM(ROWS.map((r) => coalesce(add(mul(r.total_charge, r.quantity), r.material_charge), 0)));
  assert.equal(naive, 350);
  assert.ok(
    printedLines - naive > printedLines - 500,
    'a NULL in any term zeroes the whole line, so this loses more than it recovers',
  );
});

test('the query keeps its COALESCE per column, not around the SUM', () => {
  /*
   * Now asserted against the MODULE that owns the expression. finance.js
   * interpolates it, so pinning the literal here would pin the interpolation
   * rather than the rule.
   */
  const mod = code(fs.readFileSync(path.join(__dirname, '..', 'services/job-line-total.js'), 'utf8'));
  assert.match(
    mod,
    /COALESCE\(\$\{a\}\.total_charge, 0\) \* COALESCE\(\$\{a\}\.quantity, 1\) \+ COALESCE\(\$\{a\}\.material_charge, 0\)/,
    'each column must be defaulted before the arithmetic',
  );
  const sql = code(FINANCE);
  assert.ok(
    !/SUM\(js\.total_charge \* js\.quantity\)/.test(sql),
    'the original material-dropping sum must be gone',
  );
});

test('the printed line and the header now share ONE definition', () => {
  /*
   * This guard fired on its own refactor, which is what it was for.
   *
   * It used to pin the literal `line_total: charge * qty + mat` beside the
   * header's COALESCE — two hand-written formulas 70 lines apart, joined by
   * nothing but intent. Both are now gone: the line build reads `s.line_total`
   * straight from services/job-line-total.js, and the header sums that module's
   * LINE_TOTAL_SQL. So the assertion moves UP a level — not "do the two copies
   * still agree", but "is there still only one".
   *
   * Keeping the old assertion would have meant reintroducing the second copy to
   * satisfy a test written to stop exactly that.
   */
  const sql = code(ARTIFACT);
  assert.match(
    sql,
    /line_total: s\.line_total,/,
    'the printed line must take its total from the shared helper, not recompute it',
  );
  assert.ok(
    !/line_total: charge \* qty \+ mat/.test(sql + code(FINANCE)),
    'a second hand-written copy of the formula must not reappear here',
  );
  assert.match(
    sql,
    /estimateLinesForJobs/,
    'and the lines must come from the shared reader, which also applies the '
    + 'soft-deleted-services policy',
  );
});
