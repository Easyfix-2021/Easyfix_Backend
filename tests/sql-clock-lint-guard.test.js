/*
 * The "SQL clock functions" rule in eslint.config.mjs, proved to fire.
 *
 * `npm run lint` passing says nothing on its own: a selector regex that never
 * matches reports exactly the same clean run as a codebase with no NOW().
 * So these plant the defect through the REAL config and assert it is found,
 * and that the look-alikes the rule must ignore stay clean.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ESLint } = require('eslint');

const eslint = new ESLint({ cwd: path.join(__dirname, '..') });

async function clockHits(code, file = 'services/__planted__.js') {
  const [result] = await eslint.lintText(code, { filePath: path.join(__dirname, '..', file) });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

test('a SQL clock function in runtime code fails lint', async () => {
  assert.equal(await clockHits("pool.query('SELECT * FROM t WHERE a < NOW()');\n"), 1);
  assert.equal(await clockHits('pool.query(`SELECT * FROM t\n  WHERE d >= CURDATE()`);\n'), 1);
  assert.equal(await clockHits('pool.query(`UPDATE t SET x = ? WHERE y > DATE_SUB(now(), INTERVAL 1 DAY)`, [1]);\n'), 1,
    'lower-case too');
});

test('look-alikes stay clean', async () => {
  assert.equal(await clockHits("const t = Date.now();\npool.query('SELECT ? AS t', [new Date()]);\n"), 0);
  assert.equal(await clockHits("// NOW() in a comment\npool.query('SELECT * FROM t WHERE a < ?', [new Date()]);\n"), 0);
  assert.equal(await clockHits("logger.info('took ' + (Date.now() - t0) + 'ms');\n"), 0);
  assert.equal(await clockHits("pool.query('SELECT * FROM t WHERE a < NOW()');\n", 'tests/__planted__.test.js'), 0,
    'the rule is scoped to runtime code, not tests');
});

test('the escape hatch works, one line with a reason', async () => {
  assert.equal(await clockHits(
    "// eslint-disable-next-line no-restricted-syntax -- reads the DB clock on purpose\npool.query('SELECT NOW() AS ts');\n"), 0);
});
